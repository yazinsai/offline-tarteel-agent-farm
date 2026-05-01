export type AgentMode = "local" | "cloud";

export interface FarmConfig {
  targetRepoPath: string;
  targetRepoUrl?: string;
  baseBranch: string;
  models?: {
    planner?: string;
    worker?: string;
    judge?: string;
  };
  model: string;
  mode: AgentMode;
  maxConcurrentWorkers: number;
  statePath: string;
  baselineReports: {
    v2: string;
    v3: string;
  };
  evaluation: {
    targetSeqAcc: number;
    minPrecision: number;
    v2SeqAccRegressionTolerance: number;
    remoteBackend?: "local" | "modal";
    parallelShards?: number;
    cpuLimitPercent?: number;
    modal?: {
      cpu?: number;
      memoryMb?: number;
      image?: string;
      maxAttempts?: number;
    };
    devCorpus: string;
    devSampleLimit?: number;
    holdoutCorpus: string;
    fullCorpus: string;
    repeatsDev: number;
    repeatsGate: number;
    repeatsFinal: number;
  };
}

export type TaskStatus =
  | "queued"
  | "running"
  | "needs-eval"
  | "evaluating"
  | "promising"
  | "accepted"
  | "rejected"
  | "failed";

export interface Task {
  id: string;
  status: TaskStatus;
  track: string;
  hypothesis: string;
  prompt: string;
  branch: string;
  worktreePath?: string;
  cursorRunId?: string;
  cursorAgentId?: string;
  evalProgress?: EvalProgress;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

export interface EvalProgress {
  corpus: string;
  repeats: number;
  backend: "local" | "modal";
  shardCount: number;
  startedAt: string;
  updatedAt: string;
  completedShards: number;
  failedShards: number;
  shards: EvalShardProgress[];
}

export interface EvalShardProgress {
  index: number;
  sampleCount: number;
  status: "pending" | "launching" | "running" | "completed" | "failed";
  startedAt?: string;
  finishedAt?: string;
  modalAppUrl?: string;
  attempt?: number;
  summary?: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  corpus: string;
  repeats: number;
  command: string;
  artifactPath: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  metrics?: StabilityMetrics | LegacyStabilityAggregate;
}

export interface Decision {
  id: string;
  taskId: string;
  verdict: "accepted" | "rejected" | "promising";
  reason: string;
  createdAt: string;
}

export interface FarmState {
  tasks: Task[];
  runs: RunRecord[];
  decisions: Decision[];
}

export interface StabilityReport {
  corpus: string;
  repeats: number;
  samples: StabilitySample[];
  aggregate: LegacyStabilityAggregate & NewStabilityAggregate & {
    totalSamples: number;
    stablePass?: number;
    stableFail?: number;
    flaky?: number;
    exactStablePass?: number;
    exactStableFail?: number;
    exactFlaky?: number;
    perRunCorrect?: number[];
    perRunExactCorrect?: number[];
    perRunPrecision?: number[];
    perRunRecall?: number[];
    perRunSeqAcc?: number[];
  };
}

export interface LegacyStabilityAggregate {
  medianPrecision?: number;
  medianRecall?: number;
  medianSeqAcc?: number;
}

export interface NewStabilityAggregate {
  rawCommits?: StabilityMetricGroup;
  finalSequence?: StabilityMetricGroup;
  product?: ProductStabilityMetrics;
}

export interface StabilityMetricGroup {
  medianPrecision: number;
  medianRecall: number;
  medianExactSetAcc: number;
  medianOrderedSeqAcc: number;
  perRunPrecision?: number[];
  perRunRecall?: number[];
  perRunExactSetAcc?: number[];
  perRunOrderedSeqAcc?: number[];
}

export interface ProductStabilityMetrics {
  medianFalseVisibleJumps: number;
  medianTimeToFirstCorrectCandidate: number | null;
}

export interface StabilityMetrics {
  medianPrecision: number;
  medianRecall: number;
  medianExactSetAcc: number;
  medianOrderedSeqAcc: number;
  rawCommits?: StabilityMetricGroup;
  finalSequence: StabilityMetricGroup;
  product?: ProductStabilityMetrics;
}

export interface StabilitySample {
  id: string;
  category: string;
  expectedVerses: string[];
  runs: Array<{
    passed: boolean;
    exactPassed?: boolean;
    discoveredVerses?: string[];
    precision?: number;
    recall?: number;
    seqAcc?: number;
    rawCommitVerses?: string[];
    finalSequenceVerses?: string[];
    rawCommitMetrics?: RunMetricGroup;
    finalSequenceMetrics?: RunMetricGroup;
    productMetrics?: ProductRunMetrics;
  }>;
  classification?: "stable-pass" | "stable-fail" | "flaky";
  exactClassification?: "exact-stable-pass" | "exact-stable-fail" | "exact-flaky";
  passRate: number;
  exactPassRate?: number;
  medianPrecision: number;
  medianRecall: number;
}

export interface RunMetricGroup {
  precision: number;
  recall: number;
  exactSetAcc: number;
  orderedSeqAcc: number;
}

export interface ProductRunMetrics {
  falseVisibleJumps: number;
  timeToFirstCorrectCandidate: number | null;
}

export function stabilityMetricsFromReport(report: StabilityReport): StabilityMetrics {
  return normalizeStabilityMetrics(report.aggregate);
}

export function normalizeStabilityMetrics(metrics: StabilityMetrics | LegacyStabilityAggregate & NewStabilityAggregate): StabilityMetrics {
  if ("medianExactSetAcc" in metrics && typeof metrics.medianExactSetAcc === "number") {
    const finalSequence = metrics.finalSequence ?? {
      medianPrecision: metrics.medianPrecision,
      medianRecall: metrics.medianRecall,
      medianExactSetAcc: metrics.medianExactSetAcc,
      medianOrderedSeqAcc: metrics.medianOrderedSeqAcc,
    };
    return {
      medianPrecision: metrics.medianPrecision,
      medianRecall: metrics.medianRecall,
      medianExactSetAcc: metrics.medianExactSetAcc,
      medianOrderedSeqAcc: metrics.medianOrderedSeqAcc,
      finalSequence,
      rawCommits: metrics.rawCommits,
      product: metrics.product,
    };
  }

  const finalSequence = metrics.finalSequence ?? legacyMetricGroup(metrics);
  return {
    medianPrecision: finalSequence.medianPrecision,
    medianRecall: finalSequence.medianRecall,
    medianExactSetAcc: finalSequence.medianExactSetAcc,
    medianOrderedSeqAcc: finalSequence.medianOrderedSeqAcc,
    finalSequence,
    rawCommits: metrics.rawCommits,
    product: metrics.product,
  };
}

export function finalExactSetScore(sample: StabilitySample): number {
  if (sample.runs.some((run) => run.finalSequenceMetrics)) {
    return mean(sample.runs.map((run) => run.finalSequenceMetrics?.exactSetAcc ?? 0));
  }
  if (typeof sample.exactPassRate === "number") return sample.exactPassRate;
  if (sample.runs.length === 0) return 0;
  return mean(sample.runs.map((run) => run.seqAcc ?? 0));
}

export function finalSequenceVerses(run: StabilitySample["runs"][number]): string[] {
  return run.finalSequenceVerses ?? run.discoveredVerses ?? [];
}

function legacyMetricGroup(aggregate: LegacyStabilityAggregate): StabilityMetricGroup {
  const medianPrecision = aggregate.medianPrecision ?? 0;
  const medianRecall = aggregate.medianRecall ?? 0;
  const medianSeqAcc = aggregate.medianSeqAcc ?? 0;
  return {
    medianPrecision,
    medianRecall,
    medianExactSetAcc: medianSeqAcc,
    medianOrderedSeqAcc: medianSeqAcc,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
