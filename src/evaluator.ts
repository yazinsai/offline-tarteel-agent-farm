import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { FarmConfig, FarmState, RunRecord, StabilityReport, Task } from "./types.js";
import { readJson } from "./fs.js";
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

  const dev = runStability(
    config,
    state,
    task,
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

  runStability(
    config,
    state,
    task,
    frontendPath,
    artifactDir,
    "test_corpus_v2",
    config.evaluation.repeatsGate,
  );

  runStability(
    config,
    state,
    task,
    frontendPath,
    artifactDir,
    config.evaluation.holdoutCorpus,
    config.evaluation.repeatsGate,
  );

  runStability(
    config,
    state,
    task,
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
  frontendPath: string,
  artifactDir: string,
  corpus: string,
  repeats: number,
): RunRecord {
  const artifactPath = join(artifactDir, `${corpus}-r${repeats}.json`);
  const command = [
    `timeout --foreground ${stabilityTimeoutSeconds(corpus, repeats)}`,
    "npx tsx test/stability-report.ts",
    "--focus=exact",
    `--repeats=${repeats}`,
    `--corpus=${corpus}`,
    `--json=${relative(frontendPath, artifactPath)}`,
  ].join(" ");

  return runChecked(command, frontendPath, task, state, corpus, repeats, artifactPath, config);
}

function stabilityTimeoutSeconds(corpus: string, repeats: number): number {
  if (corpus.includes("_dev")) return 30 * 60;
  if (corpus.includes("_holdout")) return Math.max(90 * 60, repeats * 30 * 60);
  if (corpus === "test_corpus_v2") return Math.max(45 * 60, repeats * 15 * 60);
  return Math.max(6 * 60 * 60, repeats * 60 * 60);
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
