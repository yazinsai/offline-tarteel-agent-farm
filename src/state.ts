import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Decision, FarmState, RunRecord, Task } from "./types.js";

export function now(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${stamp}-${rand}`;
}

export function loadState(statePath: string): FarmState {
  const path = resolve(process.cwd(), statePath);
  if (!existsSync(path)) {
    return { tasks: [], runs: [], decisions: [] };
  }
  return JSON.parse(readFileSync(path, "utf-8")) as FarmState;
}

export function saveState(statePath: string, state: FarmState): void {
  const path = resolve(process.cwd(), statePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function upsertTask(state: FarmState, task: Task): void {
  const index = state.tasks.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) {
    state.tasks.push(task);
  } else {
    state.tasks[index] = task;
  }
}

/** Overlay `memory` onto a fresh `disk` read so one-shot writers (enqueue) are not lost on save. */
export function mergeFarmState(disk: FarmState, memory: FarmState): FarmState {
  const taskById = new Map(disk.tasks.map((task) => [task.id, task]));
  for (const task of memory.tasks) taskById.set(task.id, task);
  const runById = new Map(disk.runs.map((run) => [run.id, run]));
  for (const run of memory.runs) runById.set(run.id, run);
  const decisionById = new Map(disk.decisions.map((decision) => [decision.id, decision]));
  for (const decision of memory.decisions) decisionById.set(decision.id, decision);
  return {
    tasks: [...taskById.values()],
    runs: [...runById.values()],
    decisions: [...decisionById.values()],
  };
}

export function addRun(state: FarmState, run: RunRecord): void {
  state.runs.push(run);
}

export function addDecision(state: FarmState, decision: Decision): void {
  state.decisions.push(decision);
}

export function findTaskOrThrow(state: FarmState, taskId: string): Task {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`No task found for id ${taskId}`);
  return task;
}
