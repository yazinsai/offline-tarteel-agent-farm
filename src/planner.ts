import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FarmConfig, FarmState, Task } from "./types.js";
import { makeId, now, upsertTask } from "./state.js";

const seedHypotheses = [
  {
    track: "beam-trie",
    hypothesis:
      "Use existing beamMatches from stability-report/worker inference as first-class tracker evidence, so commits are based on verse-level acoustic candidates rather than greedy phoneme text only.",
  },
  {
    track: "bounded-correction",
    hypothesis:
      "Add a bounded correction window for the last one or two emitted verses when later audio strongly contradicts the emission under monotonic verse constraints.",
  },
  {
    track: "commit-confidence",
    hypothesis:
      "Replace score-threshold-only commit decisions with an acoustic stability invariant: a candidate verse span must remain stable across adjacent chunks before emission.",
  },
  {
    track: "failure-mining",
    hypothesis:
      "Generate exact-stable-fail clusters and build a targeted diagnostic that explains whether failures are ASR, matcher, or emission-policy failures.",
  },
  {
    track: "streaming-training",
    hypothesis:
      "Prototype a training-side experiment with random prefix/window CTC loss instead of full-utterance-only loss, changing exactly one data/training variable.",
  },
];

export async function planTasks(config: FarmConfig, state: FarmState, useAi: boolean): Promise<void> {
  const specs = useAi ? await askPlanner(config, state) : seedHypotheses;
  const seen = new Set(
    state.tasks.map((task) => normalizeHypothesis(task.track, task.hypothesis)),
  );

  for (const spec of specs) {
    const key = normalizeHypothesis(spec.track, spec.hypothesis);
    if (seen.has(key)) {
      console.log(`Skipped duplicate hypothesis: ${spec.track}`);
      continue;
    }
    seen.add(key);

    const id = makeId("task");
    const branch = `agent/${spec.track}/${id}`;
    const task: Task = {
      id,
      status: "queued",
      track: spec.track,
      hypothesis: spec.hypothesis,
      prompt: buildWorkerPrompt(spec.track, spec.hypothesis),
      branch,
      createdAt: now(),
      updatedAt: now(),
    };
    upsertTask(state, task);
    console.log(`Queued ${task.id}: ${task.track}`);
  }
}

async function askPlanner(
  config: FarmConfig,
  state: FarmState,
): Promise<Array<{ track: string; hypothesis: string }>> {
  const { Agent } = await import("@cursor/sdk");
  const promptTemplate = readFileSync(join(process.cwd(), "prompts/planner.md"), "utf-8");
  const prompt = promptTemplate
    .replaceAll("{{TARGET_REPO_PATH}}", config.targetRepoPath)
    .replaceAll("{{TARGET_SEQACC}}", String(config.evaluation.targetSeqAcc))
    .replaceAll("{{ATTEMPT_HISTORY}}", summarizeHistory(state));

  const agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: modelFor(config, "planner") },
    local: { cwd: config.targetRepoPath },
  } as never);

  const run = await agent.send(prompt);
  let text = "";
  for await (const event of run.stream()) {
    text += typeof event === "string" ? event : JSON.stringify(event);
  }

  const parsed = parseJsonArray(text);
  return parsed.length > 0 ? parsed : nextUnseenSeed(state);
}

function modelFor(config: FarmConfig, role: "planner" | "worker" | "judge"): string {
  return config.models?.[role] ?? config.model;
}

function buildWorkerPrompt(track: string, hypothesis: string): string {
  const template = readFileSync(join(process.cwd(), "prompts/worker.md"), "utf-8");
  return template
    .replaceAll("{{TRACK}}", track)
    .replaceAll("{{HYPOTHESIS}}", hypothesis);
}

function nextUnseenSeed(state: FarmState): Array<{ track: string; hypothesis: string }> {
  const seen = new Set(
    state.tasks.map((task) => normalizeHypothesis(task.track, task.hypothesis)),
  );
  return seedHypotheses.filter(
    (spec) => !seen.has(normalizeHypothesis(spec.track, spec.hypothesis)),
  );
}

function summarizeHistory(state: FarmState): string {
  if (state.tasks.length === 0) {
    return "No previous attempts yet.";
  }

  const decisions = new Map(state.decisions.map((decision) => [decision.taskId, decision]));
  const lines = state.tasks.slice(-30).map((task) => {
    const decision = decisions.get(task.id);
    const runs = state.runs
      .filter((run) => run.taskId === task.id && run.metrics)
      .map((run) =>
        `${run.corpus}: P ${(run.metrics!.medianPrecision * 100).toFixed(1)} ` +
        `R ${(run.metrics!.medianRecall * 100).toFixed(1)} ` +
        `Seq ${(run.metrics!.medianSeqAcc * 100).toFixed(1)}`,
      )
      .join("; ");

    return [
      `- ${task.id} [${decision?.verdict ?? task.status}] ${task.track}`,
      `  hypothesis: ${task.hypothesis}`,
      runs ? `  metrics: ${runs}` : "  metrics: none",
      decision ? `  lesson: ${decision.reason}` : task.notes ? `  note: ${task.notes}` : "",
    ].filter(Boolean).join("\n");
  });

  return lines.join("\n");
}

function normalizeHypothesis(track: string, hypothesis: string): string {
  return `${track}:${hypothesis}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseJsonArray(text: string): Array<{ track: string; hypothesis: string }> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1) return [];

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (
        item &&
        typeof item === "object" &&
        "track" in item &&
        "hypothesis" in item &&
        typeof item.track === "string" &&
        typeof item.hypothesis === "string"
      ) {
        return [{ track: item.track, hypothesis: item.hypothesis }];
      }
      return [];
    });
  } catch {
    return [];
  }
}
