import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { analyzeReports, printDiff } from "./analyze.js";
import { hasFlag, loadConfig, valueAfter } from "./config.js";
import { runDashboard } from "./dashboard.js";
import { evaluateTask } from "./evaluator.js";
import { judgeTask } from "./judge.js";
import { planTasks } from "./planner.js";
import { saveState, findTaskOrThrow, loadState } from "./state.js";
import { buildSplits } from "./splits.js";
import { startNextWorker, startWorkerForTask } from "./worker.js";

async function main(): Promise<void> {
  const [, , command = "status", ...args] = process.argv;
  const config = loadConfig(args);
  const state = loadState(config.statePath);

  try {
    switch (command) {
      case "build-splits":
        buildSplits(config);
        break;

      case "plan":
        await planTasks(config, state, hasFlag(args, "--ai"));
        break;

      case "work": {
        const taskId = valueAfter(args, "--task");
        if (taskId) {
          await startWorkerForTask(config, state, findTaskOrThrow(state, taskId));
        } else {
          await startNextWorker(config, state);
        }
        break;
      }

      case "eval": {
        const taskId = valueAfter(args, "--task") ?? args[0];
        if (!taskId) throw new Error("Usage: npm run eval -- --task <task-id>");
        await evaluateTask(config, state, findTaskOrThrow(state, taskId));
        break;
      }

      case "judge": {
        const taskId = valueAfter(args, "--task") ?? args[0];
        if (!taskId) throw new Error("Usage: npm run judge -- --task <task-id>");
        judgeTask(config, state, findTaskOrThrow(state, taskId));
        break;
      }

      case "analyze": {
        const baseline = valueAfter(args, "--baseline") ?? args[0];
        const candidate = valueAfter(args, "--candidate") ?? args[1];
        if (!baseline || !candidate) {
          throw new Error("Usage: npm run analyze -- --baseline <json> --candidate <json>");
        }
        printDiff(analyzeReports(resolve(process.cwd(), baseline), resolve(process.cwd(), candidate)));
        break;
      }

      case "loop":
        await runLoop(config, state, args);
        break;

      case "daemon":
        await runDaemon(config, state, args);
        break;

      case "status":
        printStatus(state);
        break;

      case "prune-queue": {
        const keep = Number(valueAfter(args, "--keep") ?? args[0] ?? "2");
        pruneQueue(state, keep);
        break;
      }

      case "dashboard":
        await runDashboard(config, {
          intervalSeconds: Number(valueAfter(args, "--interval-seconds") ?? "5"),
        });
        break;

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    saveState(config.statePath, state);
  }
}

async function runDaemon(
  config: ReturnType<typeof loadConfig>,
  state: ReturnType<typeof loadState>,
  args: string[],
): Promise<void> {
  const useAi = hasFlag(args, "--ai");
  const sleepSeconds = Number(valueAfter(args, "--sleep-seconds") ?? "60");
  recoverInterruptedEvaluations(state);
  recoverInfrastructureFailures(state);
  recoverStaleWorkers(config, state, { force: true, reason: "daemon startup" });
  saveState(config.statePath, state);

  console.log(`Starting daemon loop. sleep=${sleepSeconds}s aiPlanning=${useAi}`);
  for (;;) {
    try {
      await runLoop(config, state, ["--cycles", "1", ...(useAi ? ["--ai"] : [])]);
      saveState(config.statePath, state);
    } catch (error) {
      console.error("Daemon cycle failed:");
      console.error(error);
      saveState(config.statePath, state);
    }

    await sleep(sleepSeconds * 1000);
  }
}

async function runLoop(
  config: ReturnType<typeof loadConfig>,
  state: ReturnType<typeof loadState>,
  args: string[],
): Promise<void> {
  const useAi = hasFlag(args, "--ai");
  const cycles = Number(valueAfter(args, "--cycles") ?? "1");

  recoverInterruptedEvaluations(state);
  recoverInfrastructureFailures(state);
  recoverStaleWorkers(config, state);
  buildSplits(config);
  if (queuedTasks(state).length < minQueuedTasks(config)) {
    await planTasks(config, state, useAi);
  }

  for (let i = 0; i < cycles; i++) {
    const evalTask = state.tasks.find((candidate) => candidate.status === "needs-eval");
    if (evalTask) {
      await evaluateTask(config, state, evalTask);
      judgeTask(config, state, evalTask);
      continue;
    }

    const availableWorkerSlots = Math.max(
      0,
      maxConcurrentWorkers(config) - state.tasks.filter((candidate) => candidate.status === "running").length,
    );
    const tasks = queuedTasks(state).slice(0, availableWorkerSlots);
    if (tasks.length === 0) {
      console.log("No queued tasks left.");
      return;
    }

    await runWorkerBatch(config, state, tasks);
  }
}

async function runWorkerBatch(
  config: ReturnType<typeof loadConfig>,
  state: ReturnType<typeof loadState>,
  tasks: ReturnType<typeof queuedTasks>,
): Promise<void> {
  console.log(`Starting ${tasks.length} worker${tasks.length === 1 ? "" : "s"}.`);
  const results = await Promise.allSettled(
    tasks.map((task) => startWorkerForTask(config, state, task)),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    console.warn(`${failures.length} worker${failures.length === 1 ? "" : "s"} failed in batch.`);
  }
}

function printStatus(state: ReturnType<typeof loadState>): void {
  const counts = new Map<string, number>();
  for (const task of state.tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }

  console.log("Tasks:");
  for (const [status, count] of [...counts.entries()].sort()) {
    console.log(`- ${status}: ${count}`);
  }

  const latest = state.tasks.slice(-10);
  if (latest.length > 0) {
    console.log("\nLatest:");
    for (const task of latest) {
      console.log(`- ${task.id} [${task.status}] ${task.track}: ${task.hypothesis}`);
    }
  }
}

function recoverInterruptedEvaluations(state: ReturnType<typeof loadState>): void {
  const timestamp = new Date().toISOString();
  for (const task of state.tasks) {
    if (task.status !== "evaluating") continue;
    task.status = "needs-eval";
    task.updatedAt = timestamp;
    task.notes = `${task.notes ? `${task.notes}\n` : ""}Recovered interrupted evaluation at ${timestamp}.`;
  }
}

function recoverStaleWorkers(
  config: ReturnType<typeof loadConfig>,
  state: ReturnType<typeof loadState>,
  options: { force?: boolean; reason?: string } = {},
): void {
  const timestamp = new Date().toISOString();
  const cutoffMs = Date.now() - staleWorkerMinutes(config) * 60_000;
  const reason = options.reason ?? "stale worker";
  for (const task of state.tasks) {
    if (task.status !== "running") continue;
    const heartbeat = Date.parse(task.workerHeartbeatAt ?? task.updatedAt);
    if (!options.force && Number.isFinite(heartbeat) && heartbeat >= cutoffMs) continue;

    const resultPath = task.worktreePath ? join(task.worktreePath, ".agent-farm", "result.json") : undefined;
    if (resultPath && existsSync(resultPath)) {
      task.status = "needs-eval";
      task.notes = `${task.notes ? `${task.notes}\n` : ""}Recovered ${reason} with result artifact at ${timestamp}.`;
    } else {
      task.status = "queued";
      task.notes = `${task.notes ? `${task.notes}\n` : ""}Recovered ${reason} without result artifact at ${timestamp}.`;
    }
    task.updatedAt = timestamp;
    task.workerHeartbeatAt = undefined;
  }
}

function pruneQueue(state: ReturnType<typeof loadState>, keep: number): void {
  const queued = queuedTasks(state);
  const keepCount = Math.max(0, Math.floor(keep));
  const timestamp = new Date().toISOString();
  for (const task of queued.slice(keepCount)) {
    task.status = "cancelled";
    task.updatedAt = timestamp;
    task.notes = `${task.notes ? `${task.notes}\n` : ""}Cancelled by queue prune at ${timestamp}.`;
  }
  console.log(`Cancelled ${Math.max(0, queued.length - keepCount)} queued task(s), kept ${Math.min(queued.length, keepCount)}.`);
}

function queuedTasks(state: ReturnType<typeof loadState>) {
  return state.tasks.filter((candidate) => candidate.status === "queued");
}

function maxConcurrentWorkers(config: ReturnType<typeof loadConfig>): number {
  return Math.max(1, Math.floor(config.maxConcurrentWorkers || 1));
}

function minQueuedTasks(config: ReturnType<typeof loadConfig>): number {
  return Math.max(0, Math.floor(config.minQueuedTasks ?? 1));
}

function staleWorkerMinutes(config: ReturnType<typeof loadConfig>): number {
  return Math.max(15, Math.floor(config.staleWorkerMinutes ?? 180));
}

function recoverInfrastructureFailures(state: ReturnType<typeof loadState>): void {
  const timestamp = new Date().toISOString();
  for (const task of state.tasks) {
    if (task.status !== "failed") continue;
    const notes = task.notes ?? "";
    if (!isRetryableInfrastructureFailure(notes)) continue;
    task.status = "queued";
    task.updatedAt = timestamp;
    task.notes = `${notes}\nRecovered retryable infrastructure failure at ${timestamp}.`;
  }
}

function isRetryableInfrastructureFailure(notes: string): boolean {
  return (
    notes.includes("smudge filter lfs failed") ||
    notes.includes("Could not resolve hostname github-verify") ||
    notes.includes("external filter 'git-lfs filter-process' failed") ||
    notes.includes("a branch named 'agent/") ||
    notes.includes("'git-lfs' was not found")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
