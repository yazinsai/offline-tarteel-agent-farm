import { join } from "node:path";

import type { Decision, FarmConfig, FarmState, RunRecord, Task } from "./types.js";
import { analyzeReports } from "./analyze.js";
import { addDecision, makeId, now, upsertTask } from "./state.js";

export function judgeTask(config: FarmConfig, state: FarmState, task: Task): Decision {
  const fullRun = latestRun(state.runs, task.id, config.evaluation.fullCorpus);
  const v2Run = latestRun(state.runs, task.id, "test_corpus_v2");

  if (!fullRun?.metrics || !v2Run?.metrics) {
    return decide(state, task, "rejected", "Missing full v3 or v2 gate run.");
  }

  const baselineV3 = join(config.targetRepoPath, config.baselineReports.v3);
  const baselineV2 = join(config.targetRepoPath, config.baselineReports.v2);
  const v3Diff = analyzeReports(baselineV3, fullRun.artifactPath);
  const v2Diff = analyzeReports(baselineV2, v2Run.artifactPath);

  const reasons: string[] = [];
  if (fullRun.metrics.medianSeqAcc < config.evaluation.targetSeqAcc) {
    reasons.push(
      `v3 SeqAcc ${(fullRun.metrics.medianSeqAcc * 100).toFixed(1)}% < ` +
        `${(config.evaluation.targetSeqAcc * 100).toFixed(1)}% target`,
    );
  }
  if (fullRun.metrics.medianPrecision < config.evaluation.minPrecision) {
    reasons.push(
      `v3 precision ${(fullRun.metrics.medianPrecision * 100).toFixed(1)}% < ` +
        `${(config.evaluation.minPrecision * 100).toFixed(1)}% minimum`,
    );
  }
  if (v2Diff.delta.seqAcc < -config.evaluation.v2SeqAccRegressionTolerance) {
    reasons.push(`v2 SeqAcc regressed by ${(v2Diff.delta.seqAcc * 100).toFixed(1)}pp`);
  }
  if (v3Diff.regressed.length > v3Diff.improved.length / 2 && v3Diff.regressed.length >= 8) {
    reasons.push(`too many v3 regressions: ${v3Diff.regressed.length}`);
  }

  if (reasons.length === 0) {
    return decide(
      state,
      task,
      "accepted",
      `Accepted: v3 SeqAcc ${(fullRun.metrics.medianSeqAcc * 100).toFixed(1)}%, ` +
        `precision ${(fullRun.metrics.medianPrecision * 100).toFixed(1)}%, ` +
        `v2 SeqAcc delta ${(v2Diff.delta.seqAcc * 100).toFixed(1)}pp.`,
    );
  }

  const materiallyBetter = v3Diff.delta.seqAcc >= 0.03 && v2Diff.delta.seqAcc >= -0.005;
  if (materiallyBetter) {
    return decide(state, task, "promising", `Promising but not target: ${reasons.join("; ")}`);
  }

  return decide(state, task, "rejected", reasons.join("; "));
}

function latestRun(runs: RunRecord[], taskId: string, corpus: string): RunRecord | undefined {
  return runs
    .filter((run) => run.taskId === taskId && run.corpus === corpus && run.exitCode === 0)
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""))
    .at(-1);
}

function decide(
  state: FarmState,
  task: Task,
  verdict: Decision["verdict"],
  reason: string,
): Decision {
  task.status = verdict;
  task.notes = reason;
  task.updatedAt = now();
  upsertTask(state, task);

  const decision: Decision = {
    id: makeId("decision"),
    taskId: task.id,
    verdict,
    reason,
    createdAt: now(),
  };
  addDecision(state, decision);
  console.log(`${verdict.toUpperCase()}: ${reason}`);
  return decision;
}
