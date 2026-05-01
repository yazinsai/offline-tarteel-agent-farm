import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { EvalShardProgress, FarmConfig, FarmState, RunRecord, StabilityReport, StabilitySample, Task } from "./types.js";
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

  if (shardCount > 1 || evaluationRemoteBackend(config) === "modal") {
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
      index,
      sampleCount: shardSamples.length,
      shardCorpus,
      shardDir,
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
  startEvalProgress(config, state, task, corpus, repeats, evaluationRemoteBackend(config), commands);
  const modalBundlePath =
    evaluationRemoteBackend(config) === "modal"
      ? join(artifactDir, `${corpus}-r${repeats}.modal.tgz`)
      : undefined;

  if (modalBundlePath) {
    console.log(`[${task.id}] creating Modal bundle once for ${corpus}`);
    createModalBundle(repoPath, modalBundlePath);
  }

  const results = await (evaluationRemoteBackend(config) === "modal"
    ? Promise.all(
        commands.map(({ artifactPath: shardArtifactPath, command, index, sampleCount, shardCorpus }) =>
          runModalShard(
              config,
              task,
              state,
              repoPath,
              modalBundlePath!,
              corpus,
              repeats,
              index,
              sampleCount,
              shardCorpus,
              command,
              shardArtifactPath,
            ),
        ),
      )
    : Promise.all(
        commands.map(({ command, index }) =>
          runCommandStreaming(command, frontendPath, {
            onStart: () => updateShardProgress(config, state, task, index, { status: "running", startedAt: now() }),
          }),
        ),
      ));
  if (modalBundlePath) rmSync(modalBundlePath, { force: true });
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

  finishEvalProgress(config, state, task);
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
  const envLimit = positiveIntegerFromEnv("EVAL_CPU_LIMIT_PERCENT");
  if (envLimit) return envLimit;
  if (evaluationRemoteBackend(config) === "modal") return undefined;
  return positiveInteger(config.evaluation.cpuLimitPercent);
}

function evaluationRemoteBackend(config: FarmConfig): "local" | "modal" {
  const remote = process.env.EVAL_REMOTE ?? config.evaluation.remoteBackend ?? "local";
  if (remote !== "local" && remote !== "modal") {
    throw new Error(`Unsupported EVAL_REMOTE/evaluation.remoteBackend: ${remote}`);
  }
  return remote;
}

function modalCpu(config: FarmConfig): number {
  return positiveIntegerFromEnv("EVAL_MODAL_CPU") ?? positiveInteger(config.evaluation.modal?.cpu) ?? 4;
}

function modalMemoryMb(config: FarmConfig): number {
  return positiveIntegerFromEnv("EVAL_MODAL_MEMORY_MB") ?? positiveInteger(config.evaluation.modal?.memoryMb) ?? 8192;
}

function modalImage(config: FarmConfig): string {
  return process.env.EVAL_MODAL_IMAGE ?? config.evaluation.modal?.image ?? "node:22-bookworm";
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

interface StreamingCommandOptions {
  redactArtifact?: boolean;
  onStart?: () => void;
  onStdoutLine?: (line: string) => void;
}

function runCommandStreaming(
  command: string,
  cwd: string,
  options: StreamingCommandOptions = {},
): Promise<StreamingCommandResult> {
  return new Promise((resolve) => {
    options.onStart?.();
    const child = spawn(command, {
      cwd,
      env: process.env,
      shell: true,
    });
    let stdout = "";
    let stderr = "";
    let redactArtifact = false;
    let lineBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      const combined = lineBuffer + text;
      const lines = combined.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) options.onStdoutLine?.(line);
      const redacted = options.redactArtifact ? redactArtifactBlock(text, redactArtifact) : { text, redacting: false };
      redactArtifact = redacted.redacting;
      process.stdout.write(redacted.text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("close", (code) => {
      if (lineBuffer) options.onStdoutLine?.(lineBuffer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (error) => {
      stderr += `${error.stack ?? error.message}\n`;
      resolve({ exitCode: 1, stdout, stderr });
    });
  });
}

function redactArtifactBlock(text: string, redacting: boolean): { text: string; redacting: boolean } {
  const begin = "__AGENT_FARM_ARTIFACT_BEGIN__";
  const end = "__AGENT_FARM_ARTIFACT_END__";
  let output = "";
  let cursor = 0;
  let state = redacting;

  while (cursor < text.length) {
    if (state) {
      const endIndex = text.indexOf(end, cursor);
      if (endIndex === -1) {
        return { text: output, redacting: true };
      }
      output += `${ansiSafeArtifactNotice()}\n`;
      cursor = endIndex + end.length;
      state = false;
      continue;
    }

    const beginIndex = text.indexOf(begin, cursor);
    if (beginIndex === -1) {
      output += text.slice(cursor);
      break;
    }

    output += text.slice(cursor, beginIndex);
    output += `${begin}\n[artifact base64 redacted]\n`;
    cursor = beginIndex + begin.length;
    state = true;
  }

  return { text: output, redacting: state };
}

function ansiSafeArtifactNotice(): string {
  return "__AGENT_FARM_ARTIFACT_END__";
}

async function runModalShard(
  config: FarmConfig,
  task: Task,
  state: FarmState,
  repoPath: string,
  bundlePath: string,
  corpus: string,
  repeats: number,
  shardIndex: number,
  sampleCount: number,
  shardCorpus: string,
  stabilityRunCommand: string,
  shardArtifactPath: string,
): Promise<StreamingCommandResult> {
  const remoteArtifact = relative(join(repoPath, "web/frontend"), shardArtifactPath);
  const modalScriptPath = resolve(process.cwd(), "scripts/modal_eval_shard.py");
  const modalCommand = [
    "modal run",
    shellQuote(modalScriptPath),
    `--bundle ${shellQuote(bundlePath)}`,
    `--run-command ${shellQuote(stabilityRunCommand)}`,
    `--artifact ${shellQuote(remoteArtifact)}`,
    `--cpu ${modalCpu(config)}`,
    `--memory-mb ${modalMemoryMb(config)}`,
    `--image ${shellQuote(modalImage(config))}`,
    `--timeout-seconds ${stabilityTimeoutSeconds(corpus, repeats) + 15 * 60}`,
  ].join(" ");

  console.log(`\n[${task.id}] modal shard ${shardIndex + 1}/${task.evalProgress?.shardCount ?? "?"} (${sampleCount} samples): ${shardCorpus}`);
  const result = await runCommandStreaming(modalCommand, repoPath, {
    redactArtifact: true,
    onStart: () =>
      updateShardProgress(config, state, task, shardIndex, {
        status: "launching",
        startedAt: now(),
        summary: `${sampleCount} samples`,
      }),
    onStdoutLine: (line) => {
      const url = line.match(/https:\/\/modal\.com\/\S+/)?.[0];
      if (url) {
        updateShardProgress(config, state, task, shardIndex, {
          status: "running",
          modalAppUrl: url,
          summary: `${sampleCount} samples on Modal`,
        });
      }
      const summary = line.match(/^Stable-pass: .+$/)?.[0] ?? line.match(/^Median SeqAcc:\s+.+$/)?.[0];
      if (summary) {
        updateShardProgress(config, state, task, shardIndex, {
          status: "running",
          summary,
        });
      }
    },
  });
  if (result.exitCode !== 0) {
    updateShardProgress(config, state, task, shardIndex, { status: "failed", finishedAt: now() });
    return result;
  }

  const artifactJson = extractModalArtifact(result.stdout);
  if (!artifactJson) {
    return {
      ...result,
      exitCode: 1,
      stderr: `${result.stderr}\nModal shard finished but did not return an artifact.`,
    };
  }

  writeJson(shardArtifactPath, JSON.parse(artifactJson));
  updateShardProgress(config, state, task, shardIndex, {
    status: "completed",
    finishedAt: now(),
    summary: `wrote ${relative(repoPath, shardArtifactPath)}`,
  });
  return result;
}

function startEvalProgress(
  config: FarmConfig,
  state: FarmState,
  task: Task,
  corpus: string,
  repeats: number,
  backend: "local" | "modal",
  shards: Array<{ index: number; sampleCount: number }>,
): void {
  const timestamp = now();
  task.evalProgress = {
    corpus,
    repeats,
    backend,
    shardCount: shards.length,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedShards: 0,
    failedShards: 0,
    shards: shards.map(({ index, sampleCount }) => ({ index, sampleCount, status: "pending" })),
  };
  task.updatedAt = timestamp;
  upsertTask(state, task);
  saveState(config.statePath, state);
}

function updateShardProgress(
  config: FarmConfig,
  state: FarmState,
  task: Task,
  index: number,
  patch: Partial<EvalShardProgress>,
): void {
  if (!task.evalProgress) return;
  const shard = task.evalProgress.shards.find((candidate) => candidate.index === index);
  if (!shard) return;
  Object.assign(shard, patch);
  const timestamp = now();
  task.evalProgress.updatedAt = timestamp;
  task.evalProgress.completedShards = task.evalProgress.shards.filter((candidate) => candidate.status === "completed").length;
  task.evalProgress.failedShards = task.evalProgress.shards.filter((candidate) => candidate.status === "failed").length;
  task.updatedAt = timestamp;
  upsertTask(state, task);
  saveState(config.statePath, state);
}

function finishEvalProgress(config: FarmConfig, state: FarmState, task: Task): void {
  if (!task.evalProgress) return;
  task.evalProgress.updatedAt = now();
  task.updatedAt = task.evalProgress.updatedAt;
  upsertTask(state, task);
  saveState(config.statePath, state);
}

function createModalBundle(repoPath: string, bundlePath: string): void {
  rmSync(bundlePath, { force: true });
  mkdirSync(dirname(bundlePath), { recursive: true });
  const result = runCommand(
    [
      "tar -chzf",
      shellQuote(bundlePath),
      "--exclude='./.git'",
      "--exclude='./.worktrees'",
      "--exclude='./node_modules'",
      "--exclude='./web/frontend/node_modules'",
      "--exclude='./web/frontend/test/agent-farm'",
      ".",
    ].join(" "),
    repoPath,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

function extractModalArtifact(stdout: string): string | undefined {
  const match = stdout.match(/__AGENT_FARM_ARTIFACT_BEGIN__\s*([A-Za-z0-9+/=\s]+?)\s*__AGENT_FARM_ARTIFACT_END__/);
  if (!match?.[1]) return undefined;
  return Buffer.from(match[1].replace(/\s/g, ""), "base64").toString("utf-8");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
