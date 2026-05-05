import type { Decision, FarmConfig, FarmState, PromotionRecord, RunRecord, Task } from "./types.js";
import { normalizeStabilityMetrics } from "./types.js";
import { addPromotion, makeId, now, upsertTask } from "./state.js";
import { assertCleanWorktree, createWorktree, currentHead, refHead, runCommand } from "./repo.js";

export function promotionBaseBranch(config: FarmConfig): string {
  return config.promotion?.baseBranch ?? "agent-farm/base";
}

export function activeBaseRef(config: FarmConfig, state: FarmState): string {
  return state.baseline?.branch ?? config.baseBranch;
}

export function activeBaseHead(config: FarmConfig, state: FarmState): string | undefined {
  return state.baseline?.head ?? refHead(config.targetRepoPath, config.baseBranch);
}

export function promotionEnabled(config: FarmConfig): boolean {
  return config.promotion?.autoPromote !== false;
}

export function minV3PromotionDelta(config: FarmConfig): number {
  return config.promotion?.minV3Delta ?? 0.03;
}

export function v3Delta(task: Task): number | undefined {
  return task.analysis?.v3.finalExactSet;
}

export function isV3Promising(config: FarmConfig, task: Task): boolean {
  return (v3Delta(task) ?? -Infinity) >= minV3PromotionDelta(config);
}

export function isPromotionCandidate(config: FarmConfig, task: Task): boolean {
  return task.status === "promising" && task.guardrails?.passed === true && isV3Promising(config, task);
}

export function needsCleanupPromotion(config: FarmConfig, task: Task): boolean {
  return (
    (task.status === "promising" || task.status === "rejected") &&
    task.guardrails?.passed === false &&
    isV3Promising(config, task)
  );
}

export function wasPromotionHandled(state: FarmState, taskId: string): boolean {
  if (state.baseline?.sourceTaskIds.includes(taskId)) return true;
  return (state.promotions ?? []).some((promotion) => promotion.taskId === taskId);
}

export function promotionCleanupSpec(task: Task): { track: string; hypothesis: string } {
  return {
    track: `cleanup-${task.track}`.slice(0, 80),
    hypothesis:
      `Port the V3 lift from ${task.id} (${task.track}) onto the current farm base, but make it guardrail-clean. ` +
      `Keep the mechanism's core behavior, remove any eval-only corpus/sample/source references or label leakage, ` +
      `and optimize exclusively for test_corpus_v3 Final ExactSet. Original hypothesis: ${task.hypothesis}`,
  };
}

export function maybePromoteTask(
  config: FarmConfig,
  state: FarmState,
  task: Task,
  decision?: Decision,
): PromotionRecord | undefined {
  if (!isPromotionCandidate(config, task)) return undefined;
  if (wasPromotionHandled(state, task.id)) return undefined;
  if (decision && decision.verdict !== "promising" && decision.verdict !== "accepted") return undefined;
  return promoteTask(config, state, task);
}

export function promoteTask(config: FarmConfig, state: FarmState, task: Task): PromotionRecord {
  if (task.guardrails?.passed !== true) {
    throw new Error(`Refusing to promote ${task.id}: guardrails did not pass.`);
  }
  if (!isV3Promising(config, task)) {
    throw new Error(
      `Refusing to promote ${task.id}: V3 lift ${v3Delta(task) ?? "n/a"} is below ` +
        `${minV3PromotionDelta(config)}.`,
    );
  }

  const expectedBaseHead = activeBaseHead(config, state);
  if (task.baseHead && expectedBaseHead && task.baseHead !== expectedBaseHead) {
    throw new Error(
      `Refusing to promote ${task.id}: task was built on ${task.baseHead}, active base is ${expectedBaseHead}. ` +
        `Queue a cleanup/port task on the current base instead.`,
    );
  }

  const baseBranch = promotionBaseBranch(config);
  const baseWorktree = createWorktree(config.targetRepoPath, baseBranch, activeBaseRef(config, state));
  assertCleanWorktree(baseWorktree);

  const headBefore = currentHead(baseWorktree);
  const startedAt = now();
  const merge = runCommand(`git merge --no-ff --no-edit "${task.branch}"`, baseWorktree);
  if (merge.exitCode !== 0) {
    const record: PromotionRecord = {
      id: makeId("promotion"),
      taskId: task.id,
      sourceBranch: task.branch,
      baseBranch,
      headBefore,
      status: "failed",
      reason: merge.stderr || merge.stdout || "git merge failed",
      createdAt: startedAt,
    };
    addPromotion(state, record);
    return record;
  }

  const headAfter = currentHead(baseWorktree);
  const fullRun = latestRun(state.runs, task.id, config.evaluation.fullCorpus);
  const fullMetrics = fullRun?.metrics ? normalizeStabilityMetrics(fullRun.metrics) : undefined;
  const sourceTaskIds = new Set(state.baseline?.sourceTaskIds ?? []);
  sourceTaskIds.add(task.id);
  state.baseline = {
    branch: baseBranch,
    head: headAfter,
    v3ArtifactPath: fullRun?.artifactPath,
    v3FinalExactSet: fullMetrics?.medianExactSetAcc,
    sourceTaskIds: [...sourceTaskIds],
    updatedAt: now(),
  };

  const record: PromotionRecord = {
    id: makeId("promotion"),
    taskId: task.id,
    sourceBranch: task.branch,
    baseBranch,
    headBefore,
    headAfter,
    status: "promoted",
    reason:
      `Promoted V3 lift ${(v3Delta(task)! * 100).toFixed(2)}pp from ${task.track}` +
      ` (${headBefore} -> ${headAfter}).`,
    createdAt: startedAt,
  };
  addPromotion(state, record);
  task.notes = `${task.notes ? `${task.notes}\n` : ""}${record.reason}`;
  task.updatedAt = now();
  upsertTask(state, task);
  return record;
}

function latestRun(runs: RunRecord[], taskId: string, corpus: string): RunRecord | undefined {
  return runs
    .filter((run) => run.taskId === taskId && run.corpus === corpus && run.exitCode === 0)
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""))
    .at(-1);
}
