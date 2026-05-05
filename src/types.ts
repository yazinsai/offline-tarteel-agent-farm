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
  maxConcurrentEvaluations?: number;
  minQueuedTasks?: number;
  staleWorkerMinutes?: number;
  statePath: string;
  /** If set, this file’s presence pauses the farm; if unset, uses <dirname(statePath)>/PAUSED */
  pauseFilePath?: string;
  promotion?: {
    /** Branch future workers build from after V3-promising tasks are promoted. */
    baseBranch?: string;
    /** Minimum V3 Final ExactSet lift required before promotion/cleanup. Defaults to 3pp. */
    minV3Delta?: number;
    /** Set false to disable automatic promotion/cleanup while the daemon is running. */
    autoPromote?: boolean;
  };
  baselineReports: {
    v2: string;
    v3: string;
  };
  evaluation: {
    targetSeqAcc: number;
    minPrecision: number;
    v2SeqAccRegressionTolerance: number;
    /** Optional legacy gate. Defaults false because this farm optimizes V3 only. */
    includeV2Gate?: boolean;
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
  | "self-rejected"
  | "cancelled"
  | "failed";

export interface Task {
  id: string;
  status: TaskStatus;
  track: string;
  hypothesis: string;
  prompt: string;
  branch: string;
  baseBranch?: string;
  baseHead?: string;
  worktreePath?: string;
  cursorRunId?: string;
  cursorAgentId?: string;
  workerHeartbeatAt?: string;
  activeStartedAt?: string;
  lastCommand?: string;
  recentMessages?: TaskMessage[];
  evalProgress?: EvalProgress;
  workerResult?: WorkerResult;
  analysis?: TaskAnalysis;
  guardrails?: GuardrailResult;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

export interface TaskMessage {
  at: string;
  kind: "assistant" | "tool" | "status";
  text: string;
}

export interface WorkerResult {
  taskId: string;
  hypothesis: string;
  mechanism: string;
  featureFlag?: string;
  changedFiles: string[];
  commandsRun: string[];
  devArtifact?: string;
  devMetrics?: {
    precision: number;
    recall: number;
    finalExactSet: number;
    finalOrderedSeq: number;
  };
  expectedFailureModeAddressed: string;
  shouldReject: boolean;
  rejectionReason?: string;
}

export interface TaskAnalysis {
  score: number;
  v3: AnalysisMetricDelta;
  v2: AnalysisMetricDelta;
  failureClusters: AnalysisCluster[];
  improvementClusters: AnalysisCluster[];
  regressionClusters: AnalysisCluster[];
  lesson: string;
  suspicious: string[];
}

export interface AnalysisMetricDelta {
  precision: number;
  recall: number;
  finalExactSet: number;
  finalOrderedSeq: number;
  rawCommitPrecision?: number;
  rawCommitRecall?: number;
  rawCommitExactSet?: number;
  rawCommitOrderedSeq?: number;
}

export interface AnalysisCluster {
  category: string;
  count: number;
}

export interface GuardrailResult {
  passed: boolean;
  findings: GuardrailFinding[];
}

export interface GuardrailFinding {
  file: string;
  reason: string;
  match: string;
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

export interface FarmBaseline {
  branch: string;
  head: string;
  v3ArtifactPath?: string;
  v3FinalExactSet?: number;
  sourceTaskIds: string[];
  updatedAt: string;
}

export interface PromotionRecord {
  id: string;
  taskId: string;
  sourceBranch: string;
  baseBranch: string;
  headBefore: string;
  headAfter?: string;
  status: "promoted" | "failed" | "cleanup-queued";
  reason: string;
  createdAt: string;
}

export interface FarmState {
  tasks: Task[];
  runs: RunRecord[];
  decisions: Decision[];
  baseline?: FarmBaseline;
  promotions?: PromotionRecord[];
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
