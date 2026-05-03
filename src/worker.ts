import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FarmConfig, FarmState, Task, TaskMessage, WorkerResult } from "./types.js";
import { createWorktree } from "./repo.js";
import { readJson } from "./fs.js";
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
  const startedAt = now();
  task.status = "running";
  task.updatedAt = startedAt;
  task.activeStartedAt = startedAt;
  task.workerHeartbeatAt = startedAt;
  task.lastCommand = undefined;
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
    model: { id: modelFor(config, "worker") },
    local: { cwd: worktreePath },
  } as never);

  const prompt = fullWorkerPrompt(config, task, worktreePath);
  const run = await agent.send(prompt);
  const logPath = join(process.cwd(), "runs", `${task.id}.log`);
  mkdirSync(join(process.cwd(), "runs"), { recursive: true });

  let log = "";
  let lastHeartbeatMs = 0;
  let lastMessageSaveMs = 0;
  for await (const event of run.stream()) {
    const line = typeof event === "string" ? event : JSON.stringify(event);
    log += `${line}\n`;
    process.stdout.write(`${line}\n`);
    const recordedMessage = recordWorkerEvent(task, event);
    const heartbeatMs = Date.now();
    const shouldSaveMessage =
      recordedMessage &&
      (recordedMessage.kind !== "assistant" || heartbeatMs - lastMessageSaveMs > 2_000);
    if (shouldSaveMessage) {
      lastMessageSaveMs = heartbeatMs;
      task.updatedAt = now();
      upsertTask(state, task);
      saveState(config.statePath, state);
    }
    if (heartbeatMs - lastHeartbeatMs > 60_000) {
      lastHeartbeatMs = heartbeatMs;
      task.workerHeartbeatAt = now();
      task.updatedAt = task.workerHeartbeatAt;
      upsertTask(state, task);
      saveState(config.statePath, state);
    }
  }
  writeFileSync(logPath, log);

  const workerResult = readWorkerResult(worktreePath, task.id);
  if (workerResult) {
    task.workerResult = workerResult;
  }

  if (workerResult?.shouldReject) {
    task.status = "self-rejected";
    task.notes = workerResult.rejectionReason ?? "Worker self-rejected after dev evaluation.";
  } else {
    task.status = "needs-eval";
  }
  task.updatedAt = now();
  task.lastCommand = undefined;
  upsertTask(state, task);
  saveState(config.statePath, state);
}

function recordWorkerEvent(task: Task, event: unknown): Omit<TaskMessage, "at"> | undefined {
  const message = messageFromWorkerEvent(event);
  if (!message) return undefined;
  if (message.command) task.lastCommand = message.command;
  const taskMessage = { kind: message.kind, text: message.text };
  const timestamp = now();
  const recent = task.recentMessages ?? [];
  const last = recent.at(-1);
  if (taskMessage.kind === "assistant" && last?.kind === "assistant") {
    last.at = timestamp;
    last.text = compactMessage(`${last.text}${taskMessage.text}`);
  } else {
    recent.push({ at: timestamp, ...taskMessage });
  }
  task.recentMessages = recent.slice(-8);
  return taskMessage;
}

function messageFromWorkerEvent(event: unknown): (Omit<TaskMessage, "at"> & { command?: string }) | undefined {
  if (!event || typeof event !== "object") return undefined;
  const payload = event as {
    type?: string;
    status?: string;
    text?: string;
    name?: string;
    args?: unknown;
    result?: unknown;
    message?: { content?: Array<{ type?: string; text?: string }> };
  };

  if (payload.type === "assistant") {
    const text = payload.message?.content
      ?.flatMap((block) => block.type === "text" && block.text ? [block.text] : [])
      .join("");
    if (!text?.trim()) return undefined;
    return { kind: "assistant", text: compactMessage(text) };
  }

  if (payload.type === "tool_call") {
    const command = toolCommand(payload.args);
    const suffix = payload.status === "completed" ? toolResultSummary(payload.result) : command;
    return {
      kind: "tool",
      text: compactMessage(`${payload.name ?? "tool"} ${payload.status ?? "event"}${suffix ? `: ${suffix}` : ""}`),
      command,
    };
  }

  if (payload.type === "status" && payload.status) {
    return { kind: "status", text: payload.status };
  }

  if (payload.type === "task" && payload.text) {
    return { kind: "status", text: compactMessage(payload.text) };
  }

  return undefined;
}

function toolCommand(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const command = "command" in args && typeof args.command === "string" ? args.command : undefined;
  const path = "path" in args && typeof args.path === "string" ? args.path : undefined;
  return command ?? path;
}

function toolResultSummary(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const value = "value" in result ? result.value : undefined;
  if (!value || typeof value !== "object") return undefined;
  const exitCode = "exitCode" in value && typeof value.exitCode === "number" ? `exit ${value.exitCode}` : undefined;
  const totalLines = "totalLines" in value && typeof value.totalLines === "number" ? `${value.totalLines} lines` : undefined;
  return exitCode ?? totalLines;
}

function compactMessage(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 260);
}

async function startCloudWorker(config: FarmConfig, state: FarmState, task: Task): Promise<void> {
  if (!config.targetRepoUrl) {
    throw new Error("Cloud mode requires targetRepoUrl in config.json");
  }

  const { Agent } = await import("@cursor/sdk");
  const agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: modelFor(config, "worker") },
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

function modelFor(config: FarmConfig, role: "planner" | "worker" | "judge"): string {
  return config.models?.[role] ?? config.model;
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

function readWorkerResult(worktreePath: string, taskId: string): WorkerResult | undefined {
  const resultPath = join(worktreePath, ".agent-farm", "result.json");
  if (!existsSync(resultPath)) {
    console.warn(`Worker did not write ${resultPath}`);
    return undefined;
  }

  const parsed = readJson<Partial<WorkerResult>>(resultPath);
  if (parsed.taskId !== taskId) {
    throw new Error(`Worker result taskId mismatch: expected ${taskId}, got ${parsed.taskId ?? "missing"}`);
  }
  if (
    typeof parsed.hypothesis !== "string" ||
    typeof parsed.mechanism !== "string" ||
    !Array.isArray(parsed.changedFiles) ||
    !Array.isArray(parsed.commandsRun) ||
    typeof parsed.expectedFailureModeAddressed !== "string" ||
    typeof parsed.shouldReject !== "boolean"
  ) {
    throw new Error(`Invalid worker result schema at ${resultPath}`);
  }

  return {
    taskId: parsed.taskId,
    hypothesis: parsed.hypothesis,
    mechanism: parsed.mechanism,
    featureFlag: parsed.featureFlag,
    changedFiles: parsed.changedFiles,
    commandsRun: parsed.commandsRun,
    devArtifact: parsed.devArtifact,
    devMetrics: parsed.devMetrics,
    expectedFailureModeAddressed: parsed.expectedFailureModeAddressed,
    shouldReject: parsed.shouldReject,
    rejectionReason: parsed.rejectionReason,
  };
}
