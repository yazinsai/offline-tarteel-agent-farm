import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { FarmConfig, FarmState, RunRecord, StabilityReport, StabilitySample, Task } from "./types.js";
import { ensureSymlink, readJson, writeJson } from "./fs.js";
import { runCommand } from "./repo.js";
import { addRun, makeId, now, saveState, upsertTask } from "./state.js";

export async function evaluateTask(config: FarmConfig, state: FarmState, task: Task): Promise<void> {
  const repoPath = task.worktreePath ?? config.targetRepoPath;
  const frontendPath = join(repoPath, "web/frontend");
  const artifactDir = join(frontendPath, "test", "agent-farm", task.id);
  mkdirSync(artifactDir, { recursive: true });
  ensureEvaluationAssets(config, repoPath);

  task.status = "evaluating";
  task.updatedAt = now();
  upsertTask(state, task);
  saveState(config.statePath, state);

  runChecked(
    "[ -d node_modules ] || npm install",
    frontendPath,
    task,
    state,
    "frontend-deps",
    0,
    "",
    config,
  );

  runChecked("npx vitest run --testTimeout=60000", frontendPath, task, state, "unit", 0, "", config);

  const dev = await runStability(
    config,
    state,
    task,
    repoPath,
    frontendPath,
    artifactDir,
    config.evaluation.devCorpus,
    config.evaluation.repeatsDev,
  );

  if ((dev.metrics?.medianSeqAcc ?? 0) < 0.45) {
    task.status = "rejected";
    task.notes = "Rejected after dev corpus: SeqAcc below 45%.";
    task.updatedAt = now();
    upsertTask(state, task);
    saveState(config.statePath, state);
    return;
  }

  await runStability(
    config,
    state,
    task,
    repoPath,
    frontendPath,
    artifactDir,
    "test_corpus_v2",
    config.evaluation.repeatsGate,
  );

  await runStability(
    config,
    state,
    task,
    repoPath,
    frontendPath,
    artifactDir,
    config.evaluation.holdoutCorpus,
    config.evaluation.repeatsGate,
  );

  await runStability(
    config,
    state,
    task,
    repoPath,
    frontendPath,
    artifactDir,
    config.evaluation.fullCorpus,
    config.evaluation.repeatsFinal,
  );

  task.status = "promising";
  task.updatedAt = now();
  upsertTask(state, task);
  saveState(config.statePath, state);
}

function ensureEvaluationAssets(config: FarmConfig, repoPath: string): void {
  const benchmarkDir = join(repoPath, "benchmark");
  mkdirSync(benchmarkDir, { recursive: true });

  for (const corpus of [config.evaluation.devCorpus, config.evaluation.holdoutCorpus]) {
    const source = join(config.targetRepoPath, "benchmark", corpus);
    const target = join(benchmarkDir, corpus);
    if (!existsSync(target) && existsSync(source)) {
      runCommand(`ln -s "${source}" "${target}"`, repoPath);
    }
  }

  const sourceModel = join(config.targetRepoPath, "web/frontend/public/fastconformer_phoneme_q8.onnx");
  const targetModel = join(repoPath, "web/frontend/public/fastconformer_phoneme_q8.onnx");
  if (existsSync(sourceModel) && shouldReplaceModel(targetModel)) {
    copyFileSync(sourceModel, targetModel);
  }
}

function shouldReplaceModel(path: string): boolean {
  if (!existsSync(path)) return true;
  return statSync(path).size < 1024 * 1024;
}

function runStability(
  config: FarmConfig,
  state: FarmState,
  task: Task,
  repoPath: string,
  frontendPath: string,
  artifactDir: string,
  corpus: string,
  repeats: number,
): Promise<RunRecord> | RunRecord {
  const artifactPath = join(artifactDir, `${corpus}-r${repeats}.json`);
  const manifestPath = join(repoPath, "benchmark", corpus, "manifest.json");
  const manifest = readJson<Manifest>(manifestPath);
  const shardCount = Math.min(evaluationParallelShards(config), manifest.samples.length);

  if (shardCount > 1) {
    return runParallelStability(
      config,
      state,
      task,
      repoPath,
      frontendPath,
      artifactDir,
      corpus,
      repeats,
      artifactPath,
      manifest.samples,
      shardCount,
    );
  }

  const command = stabilityCommand(config, corpus, repeats, corpus, relative(frontendPath, artifactPath));

  return runChecked(command, frontendPath, task, state, corpus, repeats, artifactPath, config);
}

interface Manifest {
  samples: ManifestSample[];
}

interface ManifestSample {
  id: string;
  file: string;
}

async function runParallelStability(
  config: FarmConfig,
  state: FarmState,
  task: Task,
  repoPath: string,
  frontendPath: string,
  artifactDir: string,
  corpus: string,
  repeats: number,
  artifactPath: string,
  samples: ManifestSample[],
  shardCount: number,
): Promise<RunRecord> {
  const startedAt = now();
  const sourceCorpusDir = join(repoPath, "benchmark", corpus);
  const shardRoot = join(repoPath, "benchmark", `.agent-farm-${task.id}-${corpus}-r${repeats}`);
  rmSync(shardRoot, { recursive: true, force: true });
  mkdirSync(shardRoot, { recursive: true });

  const commands = Array.from({ length: shardCount }, (_, index) => {
    const shardCorpus = `${relative(join(repoPath, "benchmark"), shardRoot)}/shard-${index}`;
    const shardDir = join(repoPath, "benchmark", shardCorpus);
    const shardSamples = samples.filter((_, sampleIndex) => sampleIndex % shardCount === index);
    writeJson(join(shardDir, "manifest.json"), { samples: shardSamples });

    for (const sample of shardSamples) {
      ensureSymlink(join(sourceCorpusDir, sample.file), join(shardDir, sample.file));
    }

    const shardArtifact = join(artifactDir, `${corpus}-r${repeats}-shard-${index}.json`);
    return {
      artifactPath: shardArtifact,
      command: stabilityCommand(
        config,
        corpus,
        repeats,
        shardCorpus,
        relative(frontendPath, shardArtifact),
      ),
    };
  });

  console.log(`\n[${task.id}] ${corpus} x${repeats}: ${samples.length} samples across ${shardCount} shards`);
  const results = await Promise.all(commands.map(({ command }) => runCommandStreaming(command, frontendPath)));
  const exitCode = results.find((result) => result.exitCode !== 0)?.exitCode ?? 0;
  const run: RunRecord = {
    id: makeId("run"),
    taskId: task.id,
    corpus,
    repeats,
    command: `parallel ${shardCount} shards: ${commands.map((entry) => entry.command).join(" ; ")}`,
    artifactPath,
    startedAt,
    finishedAt: now(),
    exitCode,
  };

  if (exitCode === 0) {
    const reports = commands.map(({ artifactPath: shardArtifactPath }) =>
      readJson<StabilityReport>(shardArtifactPath),
    );
    const merged = mergeStabilityReports(corpus, repeats, reports);
    writeJson(artifactPath, merged);
    run.metrics = {
      medianPrecision: merged.aggregate.medianPrecision,
      medianRecall: merged.aggregate.medianRecall,
      medianSeqAcc: merged.aggregate.medianSeqAcc,
    };
  }

  addRun(state, run);
  saveState(config.statePath, state);

  if (exitCode !== 0) {
    task.status = "failed";
    task.notes = `Command failed: ${run.command}`;
    task.updatedAt = now();
    upsertTask(state, task);
    saveState(config.statePath, state);
    const failed = results.find((result) => result.exitCode !== 0);
    throw new Error(failed?.stderr || failed?.stdout || `Parallel stability failed with exit ${exitCode}`);
  }

  console.log(
    `[${corpus}] P ${(run.metrics!.medianPrecision * 100).toFixed(1)}% ` +
      `R ${(run.metrics!.medianRecall * 100).toFixed(1)}% ` +
      `Seq ${(run.metrics!.medianSeqAcc * 100).toFixed(1)}%`,
  );

  return run;
}

function stabilityTimeoutSeconds(corpus: string, repeats: number): number {
  if (corpus.includes("_dev")) return 30 * 60;
  if (corpus.includes("_holdout")) return Math.max(90 * 60, repeats * 30 * 60);
  if (corpus === "test_corpus_v2") return Math.max(45 * 60, repeats * 15 * 60);
  return Math.max(6 * 60 * 60, repeats * 60 * 60);
}

function stabilityCommand(
  config: FarmConfig,
  timeoutCorpus: string,
  repeats: number,
  corpusArg: string,
  artifactArg: string,
): string {
  const cpuLimitPercent = evaluationCpuLimitPercent(config);
  return [
    `timeout -k 30s ${stabilityTimeoutSeconds(timeoutCorpus, repeats)}`,
    ...(cpuLimitPercent ? [`cpulimit -l ${cpuLimitPercent} --`] : []),
    "npx tsx test/stability-report.ts",
    "--focus=exact",
    `--repeats=${repeats}`,
    `--corpus=${corpusArg}`,
    `--json=${artifactArg}`,
  ].join(" ");
}

function evaluationParallelShards(config: FarmConfig): number {
  return positiveIntegerFromEnv("EVAL_PARALLEL_SHARDS") ?? positiveInteger(config.evaluation.parallelShards) ?? 1;
}

function evaluationCpuLimitPercent(config: FarmConfig): number | undefined {
  return positiveIntegerFromEnv("EVAL_CPU_LIMIT_PERCENT") ?? positiveInteger(config.evaluation.cpuLimitPercent);
}

function positiveIntegerFromEnv(name: string): number | undefined {
  return positiveInteger(process.env[name]);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function runChecked(
  command: string,
  cwd: string,
  task: Task,
  state: FarmState,
  corpus: string,
  repeats: number,
  artifactPath: string,
  config?: FarmConfig,
): RunRecord {
  console.log(`\n[${task.id}] ${command}`);
  const startedAt = now();
  const result = runCommand(command, cwd);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  const run: RunRecord = {
    id: makeId("run"),
    taskId: task.id,
    corpus,
    repeats,
    command,
    artifactPath,
    startedAt,
    finishedAt: now(),
    exitCode: result.exitCode,
  };

  if (artifactPath && result.exitCode === 0) {
    const report = readJson<StabilityReport>(artifactPath);
    run.metrics = {
      medianPrecision: report.aggregate.medianPrecision,
      medianRecall: report.aggregate.medianRecall,
      medianSeqAcc: report.aggregate.medianSeqAcc,
    };
  }

  addRun(state, run);
  if (config) saveState(config.statePath, state);

  if (result.exitCode !== 0) {
    task.status = "failed";
    task.notes = `Command failed: ${command}`;
    task.updatedAt = now();
    upsertTask(state, task);
    if (config) saveState(config.statePath, state);
    throw new Error(result.stderr || result.stdout);
  }

  if (config && run.metrics) {
    console.log(
      `[${corpus}] P ${(run.metrics.medianPrecision * 100).toFixed(1)}% ` +
        `R ${(run.metrics.medianRecall * 100).toFixed(1)}% ` +
        `Seq ${(run.metrics.medianSeqAcc * 100).toFixed(1)}%`,
    );
  }

  return run;
}

interface StreamingCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCommandStreaming(command: string, cwd: string): Promise<StreamingCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env: process.env,
      shell: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (error) => {
      stderr += `${error.stack ?? error.message}\n`;
      resolve({ exitCode: 1, stdout, stderr });
    });
  });
}

function mergeStabilityReports(corpus: string, repeats: number, reports: StabilityReport[]): StabilityReport {
  const samples = reports.flatMap((report) => report.samples);
  const perRunCorrect: number[] = [];
  const perRunExactCorrect: number[] = [];
  const perRunPrecision: number[] = [];
  const perRunRecall: number[] = [];
  const perRunSeqAcc: number[] = [];

  for (let runIndex = 0; runIndex < repeats; runIndex++) {
    const runSamples = samples.map((sample) => sample.runs[runIndex]).filter(Boolean);
    perRunCorrect.push(runSamples.filter((run) => run.passed).length);
    perRunExactCorrect.push(runSamples.filter((run) => run.exactPassed).length);
    perRunPrecision.push(mean(runSamples.map((run) => run.precision)));
    perRunRecall.push(mean(runSamples.map((run) => run.recall)));
    perRunSeqAcc.push(mean(runSamples.map((run) => run.seqAcc)));
  }

  return {
    corpus,
    repeats,
    samples,
    aggregate: {
      totalSamples: samples.length,
      stablePass: countSamples(samples, "classification", "stable-pass"),
      stableFail: countSamples(samples, "classification", "stable-fail"),
      flaky: countSamples(samples, "classification", "flaky"),
      exactStablePass: countSamples(samples, "exactClassification", "exact-stable-pass"),
      exactStableFail: countSamples(samples, "exactClassification", "exact-stable-fail"),
      exactFlaky: countSamples(samples, "exactClassification", "exact-flaky"),
      medianPrecision: median(perRunPrecision),
      medianRecall: median(perRunRecall),
      medianSeqAcc: median(perRunSeqAcc),
      perRunCorrect,
      perRunExactCorrect,
      perRunPrecision,
      perRunRecall,
      perRunSeqAcc,
    },
  };
}

function countSamples(
  samples: StabilitySample[],
  key: "classification" | "exactClassification",
  value: string,
): number {
  return samples.filter((sample) => sample[key] === value).length;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}
