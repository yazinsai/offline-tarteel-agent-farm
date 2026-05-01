import type { StabilityReport, StabilitySample } from "./types.js";
import { finalExactSetScore, stabilityMetricsFromReport } from "./types.js";
import { readJson } from "./fs.js";

export interface StabilityDiff {
  baseline: string;
  candidate: string;
  delta: {
    precision: number;
    recall: number;
    finalExactSet: number;
    finalOrderedSeq: number;
    rawCommitPrecision?: number;
    rawCommitRecall?: number;
    rawCommitExactSet?: number;
    rawCommitOrderedSeq?: number;
    exactStablePass: number;
    exactStableFail: number;
    exactFlaky: number;
  };
  improved: SampleChange[];
  regressed: SampleChange[];
  suspicious: string[];
}

export interface SampleChange {
  id: string;
  category: string;
  before: string;
  after: string;
  expected: string[];
}

export function analyzeReports(baselinePath: string, candidatePath: string): StabilityDiff {
  const baseline = readJson<StabilityReport>(baselinePath);
  const candidate = readJson<StabilityReport>(candidatePath);
  const baselineMetrics = stabilityMetricsFromReport(baseline);
  const candidateMetrics = stabilityMetricsFromReport(candidate);

  const baselineSamples = new Map(baseline.samples.map((sample) => [sample.id, sample]));
  const improved: SampleChange[] = [];
  const regressed: SampleChange[] = [];

  for (const sample of candidate.samples) {
    const before = baselineSamples.get(sample.id);
    if (!before) continue;

    const beforeScore = finalExactSetScore(before);
    const afterScore = finalExactSetScore(sample);
    if (afterScore > beforeScore) improved.push(toChange(before, sample));
    if (afterScore < beforeScore) regressed.push(toChange(before, sample));
  }

  const suspicious = [
    ...clusterWarnings("regression", regressed),
    ...clusterWarnings("improvement", improved),
  ];

  return {
    baseline: baselinePath,
    candidate: candidatePath,
    delta: {
      precision: candidateMetrics.medianPrecision - baselineMetrics.medianPrecision,
      recall: candidateMetrics.medianRecall - baselineMetrics.medianRecall,
      finalExactSet: candidateMetrics.medianExactSetAcc - baselineMetrics.medianExactSetAcc,
      finalOrderedSeq: candidateMetrics.medianOrderedSeqAcc - baselineMetrics.medianOrderedSeqAcc,
      rawCommitPrecision: optionalDelta(
        candidateMetrics.rawCommits?.medianPrecision,
        baselineMetrics.rawCommits?.medianPrecision,
      ),
      rawCommitRecall: optionalDelta(
        candidateMetrics.rawCommits?.medianRecall,
        baselineMetrics.rawCommits?.medianRecall,
      ),
      rawCommitExactSet: optionalDelta(
        candidateMetrics.rawCommits?.medianExactSetAcc,
        baselineMetrics.rawCommits?.medianExactSetAcc,
      ),
      rawCommitOrderedSeq: optionalDelta(
        candidateMetrics.rawCommits?.medianOrderedSeqAcc,
        baselineMetrics.rawCommits?.medianOrderedSeqAcc,
      ),
      exactStablePass: (candidate.aggregate.exactStablePass ?? 0) - (baseline.aggregate.exactStablePass ?? 0),
      exactStableFail: (candidate.aggregate.exactStableFail ?? 0) - (baseline.aggregate.exactStableFail ?? 0),
      exactFlaky: (candidate.aggregate.exactFlaky ?? 0) - (baseline.aggregate.exactFlaky ?? 0),
    },
    improved,
    regressed,
    suspicious,
  };
}

export function printDiff(diff: StabilityDiff): void {
  console.log(`Baseline:  ${diff.baseline}`);
  console.log(`Candidate: ${diff.candidate}`);
  console.log("");
  console.log(`Precision: ${pct(diff.delta.precision)}`);
  console.log(`Recall:    ${pct(diff.delta.recall)}`);
  console.log(`Final ExactSet:  ${pct(diff.delta.finalExactSet)}`);
  console.log(`Final OrderedSeq: ${pct(diff.delta.finalOrderedSeq)}`);
  if (diff.delta.rawCommitPrecision !== undefined) {
    console.log(`Raw Precision:   ${pct(diff.delta.rawCommitPrecision)}`);
  }
  if (diff.delta.rawCommitRecall !== undefined) {
    console.log(`Raw Recall:      ${pct(diff.delta.rawCommitRecall)}`);
  }
  if (diff.delta.rawCommitExactSet !== undefined) {
    console.log(`Raw ExactSet:    ${pct(diff.delta.rawCommitExactSet)}`);
  }
  if (diff.delta.rawCommitOrderedSeq !== undefined) {
    console.log(`Raw OrderedSeq:  ${pct(diff.delta.rawCommitOrderedSeq)}`);
  }
  console.log(`Exact stable-pass: ${signed(diff.delta.exactStablePass)}`);
  console.log(`Exact stable-fail: ${signed(diff.delta.exactStableFail)}`);
  console.log(`Exact flaky:       ${signed(diff.delta.exactFlaky)}`);
  console.log("");
  console.log(`Improved samples: ${diff.improved.length}`);
  console.log(`Regressed samples: ${diff.regressed.length}`);

  if (diff.suspicious.length > 0) {
    console.log("\nWarnings:");
    for (const warning of diff.suspicious) console.log(`- ${warning}`);
  }

  if (diff.regressed.length > 0) {
    console.log("\nRegressions:");
    for (const change of diff.regressed.slice(0, 25)) {
      console.log(`- ${change.id} ${change.before} -> ${change.after} expected [${change.expected.join(", ")}]`);
    }
  }
}

function toChange(before: StabilitySample, after: StabilitySample): SampleChange {
  return {
    id: after.id,
    category: after.category,
    before: sampleLabel(before),
    after: sampleLabel(after),
    expected: after.expectedVerses,
  };
}

function sampleLabel(sample: StabilitySample): string {
  return sample.exactClassification ?? `${Math.round(finalExactSetScore(sample) * 100)}%`;
}

function clusterWarnings(kind: string, changes: SampleChange[]): string[] {
  const byCategory = new Map<string, number>();
  for (const change of changes) {
    byCategory.set(change.category, (byCategory.get(change.category) ?? 0) + 1);
  }

  return [...byCategory.entries()]
    .filter(([, count]) => count >= 8)
    .map(([category, count]) => `${kind} cluster: ${count} ${category} samples changed`);
}

function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}pp`;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}

function optionalDelta(candidate: number | undefined, baseline: number | undefined): number | undefined {
  if (candidate === undefined || baseline === undefined) return undefined;
  return candidate - baseline;
}
