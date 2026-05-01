import { mkdirSync } from "node:fs";
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
    "npx tsx test/stability-report.ts",
    "--focus=exact",
    `--repeats=${repeats}`,
    `--corpus=${corpus}`,
    `--json=${relative(frontendPath, artifactPath)}`,
  ].join(" ");

  return runChecked(command, frontendPath, task, state, corpus, repeats, artifactPath, config);
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
