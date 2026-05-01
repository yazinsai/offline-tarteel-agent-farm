import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FarmConfig, FarmState, Task } from "./types.js";
import { createWorktree } from "./repo.js";
import { now, saveState, upsertTask } from "./state.js";

export async function startNextWorker(config: FarmConfig, state: FarmState): Promise<void> {
  const task = state.tasks.find((candidate) => candidate.status === "queued");
  if (!task) {
    console.log("No queued task.");
    return;
  }

  await startWorkerForTask(config, state, task);
}

export async function startWorkerForTask(
  config: FarmConfig,
  state: FarmState,
  task: Task,
): Promise<void> {
  task.status = "running";
  task.updatedAt = now();
  upsertTask(state, task);
  saveState(config.statePath, state);

  try {
    if (config.mode === "cloud") {
      await startCloudWorker(config, state, task);
    } else {
      await startLocalWorker(config, state, task);
    }
  } catch (error) {
    task.status = "failed";
    task.notes = error instanceof Error ? error.message : String(error);
    task.updatedAt = now();
    upsertTask(state, task);
    saveState(config.statePath, state);
    throw error;
  }
}

async function startLocalWorker(config: FarmConfig, state: FarmState, task: Task): Promise<void> {
  const worktreePath = createWorktree(config.targetRepoPath, task.branch, config.baseBranch);
  task.worktreePath = worktreePath;
  task.updatedAt = now();
  upsertTask(state, task);
  saveState(config.statePath, state);

  const { Agent } = await import("@cursor/sdk");
  const agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: config.model },
    local: { cwd: worktreePath },
  } as never);

  const prompt = fullWorkerPrompt(config, task, worktreePath);
  const run = await agent.send(prompt);
  const logPath = join(process.cwd(), "runs", `${task.id}.log`);
  mkdirSync(join(process.cwd(), "runs"), { recursive: true });

  let log = "";
  for await (const event of run.stream()) {
    const line = typeof event === "string" ? event : JSON.stringify(event);
    log += `${line}\n`;
    process.stdout.write(`${line}\n`);
  }
  writeFileSync(logPath, log);

  task.status = "needs-eval";
  task.updatedAt = now();
  upsertTask(state, task);
  saveState(config.statePath, state);
}

async function startCloudWorker(config: FarmConfig, state: FarmState, task: Task): Promise<void> {
  if (!config.targetRepoUrl) {
    throw new Error("Cloud mode requires targetRepoUrl in config.json");
  }

  const { Agent } = await import("@cursor/sdk");
  const agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: config.model },
    cloud: {
      repos: [{ url: config.targetRepoUrl, startingRef: config.baseBranch }],
      autoCreatePR: false,
    },
  } as never);

  const run = await agent.send(fullWorkerPrompt(config, task, "cloud repo checkout"));
  task.cursorRunId = run.id;
  task.cursorAgentId = run.agentId;
  task.updatedAt = now();
  upsertTask(state, task);
  saveState(config.statePath, state);

  console.log(`Started cloud worker for ${task.id}`);
  console.log(`runId=${run.id}`);
  console.log(`agentId=${run.agentId}`);
}

function fullWorkerPrompt(config: FarmConfig, task: Task, cwd: string): string {
  return `${task.prompt}

Task id: ${task.id}
Branch: ${task.branch}
Working directory: ${cwd}

Evaluation ladder expected by the orchestrator:
- Fast dev: ${config.evaluation.devCorpus}, ${config.evaluation.repeatsDev} repeat.
- Gate: ${config.evaluation.holdoutCorpus} and test_corpus_v2, ${config.evaluation.repeatsGate} repeats.
- Final claim: ${config.evaluation.fullCorpus}, ${config.evaluation.repeatsFinal} repeats.

When done, leave the branch/worktree ready for the orchestrator's eval command. Do not merge to main.`;
}
