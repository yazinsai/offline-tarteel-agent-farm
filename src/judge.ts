import { join } from "node:path";

import type { AnalysisCluster, Decision, FarmConfig, FarmState, RunRecord, Task } from "./types.js";
import { normalizeStabilityMetrics } from "./types.js";
import { analyzeReports, type SampleChange, type StabilityDiff } from "./analyze.js";
import { runGuardrails } from "./guardrails.js";
import { addDecision, makeId, now, upsertTask } from "./state.js";

export function judgeTask(config: FarmConfig, state: FarmState, task: Task): Decision {
  const fullRun = latestRun(state.runs, task.id, config.evaluation.fullCorpus);
  const v2Run = latestRun(state.runs, task.id, "test_corpus_v2");

  if (!fullRun?.metrics || !v2Run?.metrics) {
    return decide(state, task, "rejected", "Missing full v3 or v2 gate run.");
  }
  const fullMetrics = normalizeStabilityMetrics(fullRun.metrics);

  const baselineV3 = join(config.targetRepoPath, config.baselineReports.v3);
  const baselineV2 = join(config.targetRepoPath, config.baselineReports.v2);
  const v3Diff = analyzeReports(baselineV3, fullRun.artifactPath);
  const v2Diff = analyzeReports(baselineV2, v2Run.artifactPath);
  task.guardrails = runGuardrails(config, task);
  task.analysis = buildAnalysis(config, fullMetrics.medianPrecision, v3Diff, v2Diff);

  const reasons: string[] = [];
  if (!task.guardrails.passed) {
    reasons.push(
      `guardrails failed: ${task.guardrails.findings
        .slice(0, 3)
        .map((finding) => `${finding.file} ${finding.reason}`)
        .join("; ")}`,
    );
  }
  if (fullMetrics.medianExactSetAcc < config.evaluation.targetSeqAcc) {
    reasons.push(
      `v3 Final ExactSet ${(fullMetrics.medianExactSetAcc * 100).toFixed(1)}% < ` +
        `${(config.evaluation.targetSeqAcc * 100).toFixed(1)}% target`,
    );
  }
  if (fullMetrics.medianPrecision < config.evaluation.minPrecision) {
    reasons.push(
      `v3 precision ${(fullMetrics.medianPrecision * 100).toFixed(1)}% < ` +
        `${(config.evaluation.minPrecision * 100).toFixed(1)}% minimum`,
    );
  }
  if (v2Diff.delta.finalExactSet < -config.evaluation.v2SeqAccRegressionTolerance) {
    reasons.push(`v2 Final ExactSet regressed by ${(v2Diff.delta.finalExactSet * 100).toFixed(1)}pp`);
  }
  if (v3Diff.regressed.length > v3Diff.improved.length / 2 && v3Diff.regressed.length >= 8) {
    reasons.push(`too many v3 regressions: ${v3Diff.regressed.length}`);
  }

  if (reasons.length === 0) {
    return decide(
      state,
      task,
      "accepted",
      `Accepted: v3 Final ExactSet ${(fullMetrics.medianExactSetAcc * 100).toFixed(1)}%, ` +
        `precision ${(fullMetrics.medianPrecision * 100).toFixed(1)}%, ` +
        `v2 Final ExactSet delta ${(v2Diff.delta.finalExactSet * 100).toFixed(1)}pp.`,
    );
  }

  const materiallyBetter = v3Diff.delta.finalExactSet >= 0.03 && v2Diff.delta.finalExactSet >= -0.005;
  if (materiallyBetter) {
    return decide(state, task, "promising", `Promising but not target: ${reasons.join("; ")}`);
  }

  return decide(state, task, "rejected", reasons.join("; "));
}

function buildAnalysis(
  config: FarmConfig,
  precision: number,
  v3Diff: StabilityDiff,
  v2Diff: StabilityDiff,
): Task["analysis"] {
  const precisionPenalty = Math.max(0, config.evaluation.minPrecision - precision);
  const v2RegressionPenalty = Math.max(
    0,
    -v2Diff.delta.finalExactSet - config.evaluation.v2SeqAccRegressionTolerance,
  );
  const broadRegressionPenalty = clusterCount(v3Diff.regressed, 8);
  const score =
    100 * v3Diff.delta.finalExactSet -
    150 * v2RegressionPenalty -
    100 * precisionPenalty -
    2 * broadRegressionPenalty;

  return {
    score,
    v3: {
      precision: v3Diff.delta.precision,
      recall: v3Diff.delta.recall,
      finalExactSet: v3Diff.delta.finalExactSet,
      finalOrderedSeq: v3Diff.delta.finalOrderedSeq,
      rawCommitPrecision: v3Diff.delta.rawCommitPrecision,
      rawCommitRecall: v3Diff.delta.rawCommitRecall,
      rawCommitExactSet: v3Diff.delta.rawCommitExactSet,
      rawCommitOrderedSeq: v3Diff.delta.rawCommitOrderedSeq,
    },
    v2: {
      precision: v2Diff.delta.precision,
      recall: v2Diff.delta.recall,
      finalExactSet: v2Diff.delta.finalExactSet,
      finalOrderedSeq: v2Diff.delta.finalOrderedSeq,
      rawCommitPrecision: v2Diff.delta.rawCommitPrecision,
      rawCommitRecall: v2Diff.delta.rawCommitRecall,
      rawCommitExactSet: v2Diff.delta.rawCommitExactSet,
      rawCommitOrderedSeq: v2Diff.delta.rawCommitOrderedSeq,
    },
    failureClusters: clusters(v3Diff.regressed),
    improvementClusters: clusters(v3Diff.improved),
    regressionClusters: clusters(v3Diff.regressed),
    lesson:
      `score ${score.toFixed(2)}; v3 Final ExactSet ${pct(v3Diff.delta.finalExactSet)}, ` +
      `v2 Final ExactSet ${pct(v2Diff.delta.finalExactSet)}, precision ${pct(v3Diff.delta.precision)}`,
    suspicious: [...v3Diff.suspicious, ...v2Diff.suspicious],
  };
}

function clusters(changes: SampleChange[]): AnalysisCluster[] {
  const counts = new Map<string, number>();
  for (const change of changes) {
    counts.set(change.category, (counts.get(change.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

function clusterCount(changes: SampleChange[], minimumSize: number): number {
  return clusters(changes).filter((cluster) => cluster.count >= minimumSize).length;
}

function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}pp`;
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
