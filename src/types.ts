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
  metrics?: StabilityMetrics;
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
  aggregate: StabilityMetrics & {
    totalSamples: number;
    stablePass?: number;
    stableFail?: number;
    flaky?: number;
    exactStablePass?: number;
    exactStableFail?: number;
    exactFlaky?: number;
    perRunCorrect?: number[];
    perRunExactCorrect?: number[];
    perRunPrecision: number[];
    perRunRecall: number[];
    perRunSeqAcc: number[];
  };
}

export interface StabilityMetrics {
  medianPrecision: number;
  medianRecall: number;
  medianSeqAcc: number;
}

export interface StabilitySample {
  id: string;
  category: string;
  expectedVerses: string[];
  runs: Array<{
    passed: boolean;
    exactPassed?: boolean;
    discoveredVerses: string[];
    precision: number;
    recall: number;
    seqAcc: number;
  }>;
  classification?: "stable-pass" | "stable-fail" | "flaky";
  exactClassification?: "exact-stable-pass" | "exact-stable-fail" | "exact-flaky";
  passRate: number;
  exactPassRate?: number;
  medianPrecision: number;
  medianRecall: number;
}
