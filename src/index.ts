import { resolve } from "node:path";

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
  buildSplits(config);
  if (state.tasks.every((task) => task.status !== "queued")) {
    await planTasks(config, state, useAi);
  }

  for (let i = 0; i < cycles; i++) {
    const evalTask = state.tasks.find((candidate) => candidate.status === "needs-eval");
    if (evalTask) {
      await evaluateTask(config, state, evalTask);
      judgeTask(config, state, evalTask);
      continue;
    }

    const task = state.tasks.find((candidate) => candidate.status === "queued");
    if (!task) {
      console.log("No queued tasks left.");
      return;
    }

    await startWorkerForTask(config, state, task);
    await evaluateTask(config, state, task);
    judgeTask(config, state, task);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
