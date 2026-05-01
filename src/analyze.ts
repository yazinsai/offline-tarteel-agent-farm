import type { StabilityReport, StabilitySample } from "./types.js";
import { readJson } from "./fs.js";

export interface StabilityDiff {
  baseline: string;
  candidate: string;
  delta: {
    precision: number;
    recall: number;
    seqAcc: number;
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

  const baselineSamples = new Map(baseline.samples.map((sample) => [sample.id, sample]));
  const improved: SampleChange[] = [];
  const regressed: SampleChange[] = [];

  for (const sample of candidate.samples) {
    const before = baselineSamples.get(sample.id);
    if (!before) continue;

    const beforeScore = exactScore(before);
    const afterScore = exactScore(sample);
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
      precision: candidate.aggregate.medianPrecision - baseline.aggregate.medianPrecision,
      recall: candidate.aggregate.medianRecall - baseline.aggregate.medianRecall,
      seqAcc: candidate.aggregate.medianSeqAcc - baseline.aggregate.medianSeqAcc,
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
  console.log(`SeqAcc:    ${pct(diff.delta.seqAcc)}`);
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

function exactScore(sample: StabilitySample): number {
  if (typeof sample.exactPassRate === "number") return sample.exactPassRate;
  return sample.runs.filter((run) => run.seqAcc === 1).length / sample.runs.length;
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
  return sample.exactClassification ?? `${Math.round(exactScore(sample) * 100)}%`;
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
