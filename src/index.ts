import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import { analyzeReports, printDiff } from "./analyze.js";
import { hasFlag, isFarmPaused, loadConfig, resolvePauseFilePath, valueAfter } from "./config.js";
import { runDashboard } from "./dashboard.js";
import { evaluateTask } from "./evaluator.js";
import { judgeTask } from "./judge.js";
import { enqueueHypothesis, planTasks } from "./planner.js";
import {
  activeBaseRef,
  isPromotionCandidate,
  maybePromoteTask,
  needsCleanupPromotion,
  promotionCleanupSpec,
  promotionEnabled,
  promoteTask,
  v3Delta,
  wasPromotionHandled,
} from "./promotion.js";
import { now, saveStateMerged, findTaskOrThrow, loadState } from "./state.js";
import { buildSplits } from "./splits.js";
import { startNextWorker, startWorkerForTask } from "./worker.js";

async function main(): Promise<void> {
  const [, , command = "status", ...args] = process.argv;
  const config = loadConfig(args);
  const state = loadState(config.statePath);

  try {
    switch (command) {
      case "build-splits":
        buildSplits(config);
        break;

      case "plan":
        await planTasks(config, state, hasFlag(args, "--ai"));
        break;

      case "enqueue": {
        const track = valueAfter(args, "--track");
        const hypothesis = valueAfter(args, "--hypothesis");
        if (!track || !hypothesis) {
          throw new Error(
            'Usage: npm run enqueue -- --config <file> --track <slug> --hypothesis "..." [--force]',
          );
        }
        const task = enqueueHypothesis(config, state, { track, hypothesis }, { force: hasFlag(args, "--force") });
        console.log(`Queued ${task.id}: ${task.track}`);
        break;
      }

      case "pause": {
        const path = resolvePauseFilePath(config);
        writeFileSync(path, `${now()}\n`);
        console.log(`Paused (created ${path}). New workers and planning are skipped until resume.`);
        break;
      }

      case "resume": {
        const path = resolvePauseFilePath(config);
        if (existsSync(path)) unlinkSync(path);
        console.log(`Resumed (removed ${path} if it existed).`);
        break;
      }

      case "work": {
        const taskId = valueAfter(args, "--task");
        if (taskId) {
          await startWorkerForTask(config, state, findTaskOrThrow(state, taskId));
        } else {
          await startNextWorker(config, state);
        }
        break;
      }

      case "eval": {
        const taskId = valueAfter(args, "--task") ?? args[0];
        if (!taskId) throw new Error("Usage: npm run eval -- --task <task-id>");
        await evaluateTask(config, state, findTaskOrThrow(state, taskId));
        break;
      }

      case "judge": {
        const taskId = valueAfter(args, "--task") ?? args[0];
        if (!taskId) throw new Error("Usage: npm run judge -- --task <task-id>");
        judgeTask(config, state, findTaskOrThrow(state, taskId));
        break;
      }

      case "promote": {
        const taskId = valueAfter(args, "--task") ?? args[0];
        if (!taskId) throw new Error("Usage: npm run promote -- --task <task-id>");
        const record = promoteTask(config, state, findTaskOrThrow(state, taskId));
        console.log(`${record.status}: ${record.reason}`);
        break;
      }

      case "analyze": {
        const baseline = valueAfter(args, "--baseline") ?? args[0];
        const candidate = valueAfter(args, "--candidate") ?? args[1];
        if (!baseline || !candidate) {
          throw new Error("Usage: npm run analyze -- --baseline <json> --candidate <json>");
        }
        printDiff(analyzeReports(resolve(process.cwd(), baseline), resolve(process.cwd(), candidate)));
        break;
      }

      case "loop":
        await runLoop(config, state, args);
        break;

      case "daemon":
        await runDaemon(config, state, args);
        break;

      case "status":
        printStatus(state, config);
        break;

      case "prune-queue": {
        const keep = Number(valueAfter(args, "--keep") ?? args[0] ?? "2");
        pruneQueue(state, keep);
        break;
      }

      case "dashboard":
        await runDashboard(config, {
          intervalSeconds: Number(valueAfter(args, "--interval-seconds") ?? "5"),
        });
        break;

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    saveStateMerged(config.statePath, state);
  }
}

async function runDaemon(
  config: ReturnType<typeof loadConfig>,
  state: ReturnType<typeof loadState>,
  args: string[],
): Promise<void> {
  const useAi = hasFlag(args, "--ai");
  const sleepSeconds = Number(valueAfter(args, "--sleep-seconds") ?? "60");
  let daemonState = state;
  recoverInterruptedEvaluations(daemonState);
  recoverInfrastructureFailures(daemonState);
  recoverStaleWorkers(config, daemonState, { force: true, reason: "daemon startup" });
  saveStateMerged(config.statePath, daemonState);

  console.log(`Starting daemon loop. sleep=${sleepSeconds}s aiPlanning=${useAi}`);
  for (;;) {
    try {
      // Reload so `dokku run enqueue` / other one-shots that mutate state.json are not undone
      // when the next saveState runs (previously in-memory state was stale forever).
      daemonState = loadState(config.statePath);
      await runLoop(config, daemonState, ["--cycles", "1", ...(useAi ? ["--ai"] : [])]);
      saveStateMerged(config.statePath, daemonState);
    } catch (error) {
      console.error("Daemon cycle failed:");
      console.error(error);
      saveStateMerged(config.statePath, daemonState);
    }

    await sleep(sleepSeconds * 1000);
  }
}

async function runLoop(
  config: ReturnType<typeof loadConfig>,
  state: ReturnType<typeof loadState>,
  args: string[],
): Promise<void> {
  const useAi = hasFlag(args, "--ai");
  const cycles = Number(valueAfter(args, "--cycles") ?? "1");

  recoverInterruptedEvaluations(state);
  recoverInfrastructureFailures(state);
  recoverStaleWorkers(config, state);
  buildSplits(config);
  const pausedHere = isFarmPaused(config);
  if (pausedHere) {
    console.log("Farm is paused: planning and new workers are skipped (eval/judge for needs-eval still runs).");
  }

  for (let i = 0; i < cycles; i++) {
    const evalTask = state.tasks.find((candidate) => candidate.status === "needs-eval");
    if (evalTask) {
      await evaluateTask(config, state, evalTask);
      const decision = judgeTask(config, state, evalTask);
      if (!isFarmPaused(config) && promotionEnabled(config)) {
        const promotion = maybePromoteTask(config, state, evalTask, decision);
        if (promotion) console.log(`${promotion.status}: ${promotion.reason}`);
      }
      continue;
    }

    if (isFarmPaused(config)) {
      console.log("Farm paused: not starting workers. Clear PAUSED file or AGENT_FARM_PAUSED to continue.");
      return;
    }

    if (promotionEnabled(config) && processPromotionCandidates(config, state)) {
      continue;
    }

    const availableWorkerSlots = Math.max(
      0,
      maxConcurrentWorkers(config) - state.tasks.filter((candidate) => candidate.status === "running").length,
    );
    const tasks = queuedTasks(state).slice(0, availableWorkerSlots);
    if (tasks.length === 0) {
      console.log("No queued tasks left.");
      break;
    }

    await runWorkerBatch(config, state, tasks);
  }

  if (!pausedHere && queuedTasks(state).length < minQueuedTasks(config)) {
    await planTasks(config, state, useAi);
  }
}

async function runWorkerBatch(
  config: ReturnType<typeof loadConfig>,
  state: ReturnType<typeof loadState>,
  tasks: ReturnType<typeof queuedTasks>,
): Promise<void> {
  console.log(`Starting ${tasks.length} worker${tasks.length === 1 ? "" : "s"}.`);
  const results = await Promise.allSettled(
    tasks.map((task) => startWorkerForTask(config, state, task)),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    console.warn(`${failures.length} worker${failures.length === 1 ? "" : "s"} failed in batch.`);
  }
}

function printStatus(state: ReturnType<typeof loadState>, config?: ReturnType<typeof loadConfig>): void {
  if (config && isFarmPaused(config)) {
    console.log(`Farm: PAUSED (${resolvePauseFilePath(config)} or AGENT_FARM_PAUSED)\n`);
  }
  if (config) {
    const base = state.baseline;
    console.log(
      `Base: ${
        base
          ? `${base.branch}@${base.head} (${base.sourceTaskIds.length} promoted${
              base.v3FinalExactSet !== undefined ? `, v3 ${(base.v3FinalExactSet * 100).toFixed(1)}%` : ""
            })`
          : activeBaseRef(config, state)
      }`,
    );
  }
  const counts = new Map<string, number>();
  for (const task of state.tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }

  console.log("Tasks:");
  for (const [status, count] of [...counts.entries()].sort()) {
    console.log(`- ${status}: ${count}`);
  }

  const latest = state.tasks.slice(-10);
  if (latest.length > 0) {
    console.log("\nLatest:");
    for (const task of latest) {
      console.log(`- ${task.id} [${task.status}] ${task.track}: ${task.hypothesis}`);
    }
  }
}

function processPromotionCandidates(
  config: ReturnType<typeof loadConfig>,
  state: ReturnType<typeof loadState>,
): boolean {
  const cleanCandidate = state.tasks
    .filter((task) => isPromotionCandidate(config, task) && !wasPromotionHandled(state, task.id))
    .sort((a, b) => (v3Delta(b) ?? -Infinity) - (v3Delta(a) ?? -Infinity))[0];

  if (cleanCandidate) {
    const promotion = promoteTask(config, state, cleanCandidate);
    console.log(`${promotion.status}: ${promotion.reason}`);
    return true;
  }

  const cleanupCandidate = state.tasks
    .filter((task) => needsCleanupPromotion(config, task) && !wasPromotionHandled(state, task.id))
    .sort((a, b) => (v3Delta(b) ?? -Infinity) - (v3Delta(a) ?? -Infinity))[0];

  if (!cleanupCandidate) return false;

  const spec = promotionCleanupSpec(cleanupCandidate);
  const task = enqueueHypothesis(config, state, spec);
  state.promotions = [
    ...(state.promotions ?? []),
    {
      id: `promotion-${task.id}`,
      taskId: cleanupCandidate.id,
      sourceBranch: cleanupCandidate.branch,
      baseBranch: activeBaseRef(config, state),
      headBefore: cleanupCandidate.baseHead ?? "",
      status: "cleanup-queued",
      reason:
        `Queued ${task.id} to clean V3 lift ${(v3Delta(cleanupCandidate)! * 100).toFixed(2)}pp ` +
        `from ${cleanupCandidate.track}.`,
      createdAt: now(),
    },
  ];
  console.log(`Queued ${task.id}: ${task.track}`);
  return true;
}

function recoverInterruptedEvaluations(state: ReturnType<typeof loadState>): void {
  const timestamp = new Date().toISOString();
  for (const task of state.tasks) {
    if (task.status !== "evaluating") continue;
    task.status = "needs-eval";
    task.updatedAt = timestamp;
    task.notes = `${task.notes ? `${task.notes}\n` : ""}Recovered interrupted evaluation at ${timestamp}.`;
  }
}

function recoverStaleWorkers(
  config: ReturnType<typeof loadConfig>,
  state: ReturnType<typeof loadState>,
  options: { force?: boolean; reason?: string } = {},
): void {
  const timestamp = new Date().toISOString();
  const cutoffMs = Date.now() - staleWorkerMinutes(config) * 60_000;
  const reason = options.reason ?? "stale worker";
  for (const task of state.tasks) {
    if (task.status !== "running") continue;
    const heartbeat = Date.parse(task.workerHeartbeatAt ?? task.updatedAt);
    if (!options.force && Number.isFinite(heartbeat) && heartbeat >= cutoffMs) continue;

    const resultPath = task.worktreePath ? join(task.worktreePath, ".agent-farm", "result.json") : undefined;
    if (resultPath && existsSync(resultPath)) {
      task.status = "needs-eval";
      task.notes = `${task.notes ? `${task.notes}\n` : ""}Recovered ${reason} with result artifact at ${timestamp}.`;
    } else {
      task.status = "queued";
      task.notes = `${task.notes ? `${task.notes}\n` : ""}Recovered ${reason} without result artifact at ${timestamp}.`;
    }
    task.updatedAt = timestamp;
    task.workerHeartbeatAt = undefined;
  }
}

function pruneQueue(state: ReturnType<typeof loadState>, keep: number): void {
  const queued = queuedTasks(state);
  const keepCount = Math.max(0, Math.floor(keep));
  const timestamp = new Date().toISOString();
  for (const task of queued.slice(keepCount)) {
    task.status = "cancelled";
    task.updatedAt = timestamp;
    task.notes = `${task.notes ? `${task.notes}\n` : ""}Cancelled by queue prune at ${timestamp}.`;
  }
  console.log(`Cancelled ${Math.max(0, queued.length - keepCount)} queued task(s), kept ${Math.min(queued.length, keepCount)}.`);
}

function queuedTasks(state: ReturnType<typeof loadState>) {
  return state.tasks.filter((candidate) => candidate.status === "queued");
}

function maxConcurrentWorkers(config: ReturnType<typeof loadConfig>): number {
  return Math.max(1, Math.floor(config.maxConcurrentWorkers || 1));
}

function minQueuedTasks(config: ReturnType<typeof loadConfig>): number {
  return Math.max(0, Math.floor(config.minQueuedTasks ?? 1));
}

function staleWorkerMinutes(config: ReturnType<typeof loadConfig>): number {
  return Math.max(15, Math.floor(config.staleWorkerMinutes ?? 180));
}

function recoverInfrastructureFailures(state: ReturnType<typeof loadState>): void {
  const timestamp = new Date().toISOString();
  for (const task of state.tasks) {
    if (task.status !== "failed") continue;
    const notes = task.notes ?? "";
    if (!isRetryableInfrastructureFailure(notes)) continue;
    task.status = "queued";
    task.updatedAt = timestamp;
    task.notes = `${notes}\nRecovered retryable infrastructure failure at ${timestamp}.`;
  }
}

function isRetryableInfrastructureFailure(notes: string): boolean {
  return (
    notes.includes("smudge filter lfs failed") ||
    notes.includes("Could not resolve hostname github-verify") ||
    notes.includes("external filter 'git-lfs filter-process' failed") ||
    notes.includes("a branch named 'agent/") ||
    notes.includes("'git-lfs' was not found")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
