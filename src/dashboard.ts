import type { FarmConfig, FarmState, RunRecord, Task, TaskStatus } from "./types.js";
import { normalizeStabilityMetrics } from "./types.js";
import { loadState } from "./state.js";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  bgGreen: "\x1b[42m\x1b[30m",
  bgYellow: "\x1b[43m\x1b[30m",
  bgRed: "\x1b[41m\x1b[37m",
  bgBlue: "\x1b[44m\x1b[37m",
  bgMagenta: "\x1b[45m\x1b[37m",
  bgGray: "\x1b[100m\x1b[37m",
};

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let frameLines: string[] | undefined;

const statusOrder: TaskStatus[] = [
  "running",
  "evaluating",
  "needs-eval",
  "queued",
  "promising",
  "accepted",
  "rejected",
  "self-rejected",
  "cancelled",
  "failed",
];

export async function runDashboard(
  config: FarmConfig,
  options: { intervalSeconds: number },
): Promise<void> {
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  process.on("SIGINT", () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l\n");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l\n");
    process.exit(0);
  });

  let frame = 0;
  for (;;) {
    renderDashboard(config, loadState(config.statePath), frame++);
    await sleep(options.intervalSeconds * 1000);
  }
}

function renderDashboard(config: FarmConfig, state: FarmState, frame: number): void {
  const width = process.stdout.columns || 120;
  const latestRuns = latestMetricRuns(state);
  const lastRunByTask = new Map(latestRuns.map((run) => [run.taskId, run]));
  const now = new Date();
  const spinner = spinnerFrames[frame % spinnerFrames.length];

  frameLines = [];
  printHero(config, state, now, spinner, width);
  blank();

  const counts = countByStatus(state.tasks);
  panel(
    "Task Board",
    [
      statusOrder
        .map((status) => `${statusBadge(status)} ${ansi.bold}${counts.get(status) ?? 0}${ansi.reset}`)
        .join("  "),
    ],
    width,
  );
  blank();

  const active = state.tasks.filter((task) =>
    ["running", "evaluating", "needs-eval", "queued"].includes(task.status),
  );
  panel(
    "Active / Pending",
    active.length === 0
      ? [dim("No active or pending tasks.")]
      : active.slice(0, 12).map((task) => formatTask(task, lastRunByTask.get(task.id), width)),
    width,
  );
  blank();

  const runningMessages = formatRunningMessages(state, width);
  if (runningMessages.length > 0) {
    panel("Running Task Messages", runningMessages, width);
    blank();
  }

  const activeEvals = state.tasks.filter((task) => task.status === "evaluating" && task.evalProgress);
  if (activeEvals.length > 0) {
    panel(
      "Evaluation Progress",
      activeEvals.flatMap((task) => formatEvalProgress(task, width)),
      width,
    );
    blank();
  }

  panel(
    "Latest Metrics",
    latestRuns.length === 0
      ? [dim("No completed metric runs yet.")]
      : latestRuns.slice(0, 8).map((run) => formatMetricRun(state, run, width)),
    width,
  );
  blank();

  const failures = state.tasks
    .filter((task) => ["failed", "rejected"].includes(task.status))
    .slice(-8)
    .reverse();
  panel(
    "Recent Failures / Rejections",
    failures.length === 0
      ? [dim("No failed/rejected tasks yet.")]
      : failures.map((task) => formatFailure(task, width)),
    width,
  );
  blank();

  panel(
    "Recent Decisions",
    state.decisions.length === 0
      ? [dim("No judge decisions recorded yet.")]
      : state.decisions
          .slice(-6)
          .reverse()
          .map(
            (decision) =>
              `${chip(decision.verdict, colorForVerdict(decision.verdict))} ${ansi.gray}${shortId(decision.taskId)}${ansi.reset} ${truncate(decision.reason, width - 34)}`,
          ),
    width,
  );

  const frameOutput = `${frameLines.join("\n")}\n`;
  frameLines = undefined;
  process.stdout.write(`\x1b[H${frameOutput}\x1b[J`);
}

function printHero(
  config: FarmConfig,
  state: FarmState,
  now: Date,
  spinner: string,
  width: number,
): void {
  const activeCount = state.tasks.filter((task) => ["running", "evaluating"].includes(task.status)).length;
  const title = `${ansi.bold}${ansi.cyan}${spinner} OFFLINE TARTEEL AGENT FARM${ansi.reset}`;
  const subtitle =
    `${ansi.gray}${now.toISOString()}  target=${config.targetRepoPath}  ` +
    `fallback=${config.model} worker=${config.models?.worker ?? config.model}${ansi.reset}`;
  const pulse = activeCount > 0 ? `${ansi.green}LIVE${ansi.reset}` : `${ansi.gray}IDLE${ansi.reset}`;

  writeLine("╔" + "═".repeat(Math.max(0, width - 2)) + "╗");
  writeLine(`║ ${truncate(`${title} ${pulse}`, width - 4)}${" ".repeat(Math.max(0, width - visibleLength(`${title} ${pulse}`) - 3))}║`);
  writeLine(`║ ${truncate(subtitle, width - 4)}${" ".repeat(Math.max(0, width - visibleLength(subtitle) - 3))}║`);
  writeLine("╚" + "═".repeat(Math.max(0, width - 2)) + "╝");
}

function formatTask(task: Task, run: RunRecord | undefined, width: number): string {
  const age = relativeTime(task.updatedAt);
  const metrics = run?.metrics ? normalizeStabilityMetrics(run.metrics) : undefined;
  const metric = run && metrics
    ? ` ${ansi.gray}|${ansi.reset} ${shortCorpus(run.corpus)} Final ExactSet ${metricColor(metrics.medianExactSetAcc)}${pct(metrics.medianExactSetAcc)}${ansi.reset}`
    : "";
  return (
    `${ansi.gray}${shortId(task.id)}${ansi.reset} ${statusBadge(task.status)} ` +
    `${ansi.bold}${pad(task.track, 18)}${ansi.reset} ${ansi.gray}${pad(age, 7)}${ansi.reset} ` +
    truncate(`${task.hypothesis}${metric}`, width - 54)
  );
}

function formatRunningMessages(state: FarmState, width: number): string[] {
  const running = state.tasks.filter((task) => task.status === "running");
  return running.flatMap((task) => {
    const messages = (task.recentMessages ?? []).slice(-2);
    const heartbeat = task.workerHeartbeatAt ? ` heartbeat ${relativeTime(task.workerHeartbeatAt)}` : "";
    const header =
      `${ansi.gray}${shortId(task.id)}${ansi.reset} ${statusBadge(task.status)} ` +
      `${ansi.bold}${pad(task.track, 18)}${ansi.reset}${ansi.gray}${heartbeat}${ansi.reset}`;
    if (messages.length === 0) return [truncate(`${header} ${dim("No messages yet.")}`, width - 6)];
    return [
      truncate(header, width - 6),
      ...messages.map((message) =>
        truncate(
          `  ${ansi.gray}${relativeTime(message.at)}${ansi.reset} ${messageKindBadge(message.kind)} ${message.text}`,
          width - 6,
        ),
      ),
    ];
  });
}

function formatEvalProgress(task: Task, width: number): string[] {
  const progress = task.evalProgress;
  if (!progress) return [];
  const done = progress.completedShards;
  const failed = progress.failedShards;
  const running = progress.shards.filter((shard) => shard.status === "running").length;
  const launching = progress.shards.filter((shard) => shard.status === "launching").length;
  const pending = progress.shards.filter((shard) => shard.status === "pending").length;
  const header =
    `${ansi.gray}${shortId(task.id)}${ansi.reset} ${ansi.bold}${pad(task.track, 18)}${ansi.reset} ` +
    `${shortCorpus(progress.corpus)} r${progress.repeats} ${progress.backend} ` +
    `${progressBar(done, progress.shardCount)} ${done}/${progress.shardCount} done ` +
    `${ansi.green}${running} running${ansi.reset} ${ansi.yellow}${launching} launching${ansi.reset} ` +
    `${ansi.gray}${pending} pending${ansi.reset}` +
    (failed ? ` ${ansi.red}${failed} failed${ansi.reset}` : "");

  const shardRows = progress.shards.slice(0, 12).map((shard) => {
    const statusColor =
      shard.status === "completed"
        ? ansi.green
        : shard.status === "failed"
          ? ansi.red
          : shard.status === "running"
            ? ansi.cyan
            : shard.status === "launching"
              ? ansi.yellow
              : ansi.gray;
    const url = shard.modalAppUrl ? ` ${ansi.gray}${shard.modalAppUrl.replace("https://modal.com/apps/yazin87/main/", "")}${ansi.reset}` : "";
    return truncate(
      `  shard ${String(shard.index + 1).padStart(2, "0")} ${statusColor}${pad(shard.status, 9)}${ansi.reset} ` +
        `${pad(`${shard.sampleCount} samples`, 10)} ${shard.summary ?? ""}${url}`,
      width - 6,
    );
  });

  return [truncate(header, width - 6), ...shardRows];
}

function formatMetricRun(state: FarmState, run: RunRecord, width: number): string {
  const task = state.tasks.find((candidate) => candidate.id === run.taskId);
  const m = normalizeStabilityMetrics(run.metrics!);
  const left =
    `${ansi.gray}${shortId(run.taskId)}${ansi.reset} ${ansi.bold}${pad(task?.track ?? "unknown", 18)}${ansi.reset} ` +
    `${ansi.gray}${pad(shortCorpus(run.corpus), 18)} r${run.repeats}${ansi.reset}`;
  const metrics =
    ` P ${metricBar(m.medianPrecision)} ${pct(m.medianPrecision)} ` +
    `R ${metricBar(m.medianRecall)} ${pct(m.medianRecall)} ` +
    `Final ExactSet ${metricBar(m.medianExactSetAcc)} ${metricColor(m.medianExactSetAcc)}${pct(m.medianExactSetAcc)}${ansi.reset}` +
    (m.rawCommits
      ? ` ${ansi.gray}Raw P ${pct(m.rawCommits.medianPrecision)} R ${pct(m.rawCommits.medianRecall)} ExactSet ${pct(m.rawCommits.medianExactSetAcc)} OrderedSeq ${pct(m.rawCommits.medianOrderedSeqAcc)}${ansi.reset}`
      : "");
  return truncate(`${left} ${metrics}`, width - 4);
}

function formatFailure(task: Task, width: number): string {
  return (
    `${ansi.gray}${shortId(task.id)}${ansi.reset} ${statusBadge(task.status)} ` +
    `${ansi.bold}${pad(task.track, 18)}${ansi.reset} ` +
    truncate(task.notes ?? task.hypothesis, width - 42)
  );
}

function latestMetricRuns(state: FarmState): RunRecord[] {
  return state.runs
    .filter((run) => run.metrics)
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
}

function countByStatus(tasks: Task[]): Map<TaskStatus, number> {
  const counts = new Map<TaskStatus, number>();
  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  return counts;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "?";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function metricBar(value: number): string {
  const cells = 8;
  const filled = Math.max(0, Math.min(cells, Math.round(value * cells)));
  const color = metricColor(value);
  return `${color}${"█".repeat(filled)}${ansi.gray}${"░".repeat(cells - filled)}${ansi.reset}`;
}

function progressBar(done: number, total: number): string {
  const cells = 12;
  const filled = total > 0 ? Math.max(0, Math.min(cells, Math.round((done / total) * cells))) : 0;
  return `${ansi.green}${"█".repeat(filled)}${ansi.gray}${"░".repeat(cells - filled)}${ansi.reset}`;
}

function metricColor(value: number): string {
  if (value >= 0.9) return ansi.green;
  if (value >= 0.7) return ansi.yellow;
  return ansi.red;
}

function shortId(id: string): string {
  return id.replace(/^task-/, "").replace(/^run-/, "").slice(-5);
}

function pad(value: string, length: number): string {
  return value.length >= length ? value.slice(0, length) : value.padEnd(length, " ");
}

function truncate(value: string, maxLength: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= maxLength) return value;
  let visible = 0;
  let output = "";
  for (let index = 0; index < value.length && visible < maxLength - 1; index++) {
    if (value[index] === "\x1b") {
      const match = value.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        output += match[0];
        index += match[0].length - 1;
        continue;
      }
    }
    output += value[index];
    visible++;
  }
  return `${output}…${ansi.reset}`;
}

function panel(title: string, rows: string[], width: number): void {
  const inner = Math.max(40, width - 4);
  const cleanTitle = ` ${title} `;
  writeLine(`${ansi.gray}╭─${ansi.reset}${ansi.bold}${ansi.cyan}${cleanTitle}${ansi.reset}${ansi.gray}${"─".repeat(Math.max(0, inner - cleanTitle.length))}╮${ansi.reset}`);
  for (const row of rows) {
    const content = truncate(row, inner - 1);
    writeLine(`${ansi.gray}│${ansi.reset} ${content}${" ".repeat(Math.max(0, inner - visibleLength(content)))}${ansi.gray}│${ansi.reset}`);
  }
  writeLine(`${ansi.gray}╰${"─".repeat(inner + 1)}╯${ansi.reset}`);
}

function statusBadge(status: TaskStatus): string {
  const color =
    status === "running" || status === "evaluating"
      ? ansi.bgBlue
      : status === "needs-eval"
        ? ansi.bgMagenta
        : status === "queued"
          ? ansi.bgGray
          : status === "accepted" || status === "promising"
            ? ansi.bgGreen
            : status === "rejected"
              ? ansi.bgYellow
              : ansi.bgRed;
  return chip(status, color);
}

function messageKindBadge(kind: "assistant" | "tool" | "status"): string {
  if (kind === "assistant") return `${ansi.cyan}assistant${ansi.reset}`;
  if (kind === "tool") return `${ansi.yellow}tool${ansi.reset}`;
  return `${ansi.gray}status${ansi.reset}`;
}

function chip(text: string, color: string): string {
  return `${color} ${text} ${ansi.reset}`;
}

function colorForVerdict(verdict: string): string {
  if (verdict === "accepted" || verdict === "promising") return ansi.bgGreen;
  if (verdict === "rejected") return ansi.bgYellow;
  return ansi.bgGray;
}

function shortCorpus(corpus: string): string {
  return corpus.replace("test_corpus_", "").replace("_", "-");
}

function dim(value: string): string {
  return `${ansi.dim}${value}${ansi.reset}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function blank(): void {
  writeLine("");
}

function writeLine(line: string): void {
  if (frameLines) {
    frameLines.push(line);
    return;
  }
  process.stdout.write(`${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
