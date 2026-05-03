import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

import type { FarmConfig, FarmState, RunRecord, StabilityMetrics, Task, TaskStatus } from "./types.js";
import { normalizeStabilityMetrics } from "./types.js";
import { loadState } from "./state.js";

type Tab = "active" | "queue" | "history";

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "active", label: "Active" },
  { id: "queue", label: "Queue" },
  { id: "history", label: "History" },
];

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const activeStatuses = new Set<TaskStatus>(["running", "evaluating", "needs-eval"]);
const queueStatuses = new Set<TaskStatus>(["queued"]);
const historyStatuses = new Set<TaskStatus>([
  "accepted",
  "promising",
  "rejected",
  "self-rejected",
  "cancelled",
  "failed",
]);

export async function runDashboard(
  config: FarmConfig,
  options: { intervalSeconds: number },
): Promise<void> {
  const instance = render(<DashboardApp config={config} intervalSeconds={options.intervalSeconds} />);
  await instance.waitUntilExit();
}

function DashboardApp({
  config,
  intervalSeconds,
}: {
  config: FarmConfig;
  intervalSeconds: number;
}): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState(() => loadState(config.statePath));
  const [tab, setTab] = useState<Tab>("active");
  const [selected, setSelected] = useState(0);
  const [detailTaskId, setDetailTaskId] = useState<string | undefined>();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setState(loadState(config.statePath));
      setFrame((value) => value + 1);
    }, Math.max(1, intervalSeconds) * 1000);
    return () => clearInterval(timer);
  }, [config.statePath, intervalSeconds]);

  const runsByTask = useMemo(() => groupRunsByTask(state.runs), [state.runs]);
  const rows = useMemo(() => tasksForTab(state, tab), [state, tab]);
  const detailTask = detailTaskId ? state.tasks.find((task) => task.id === detailTaskId) : undefined;
  const inputEnabled = Boolean(process.stdin.isTTY);

  useEffect(() => {
    setSelected((value) => clamp(value, 0, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (detailTask) {
      if (key.escape || input === "b") setDetailTaskId(undefined);
      return;
    }
    if (key.tab || input === "l") {
      setTab(nextTab(tab, 1));
      setSelected(0);
      return;
    }
    if (input === "h") {
      setTab(nextTab(tab, -1));
      setSelected(0);
      return;
    }
    if (key.upArrow || input === "k") setSelected((value) => clamp(value - 1, 0, Math.max(0, rows.length - 1)));
    if (key.downArrow || input === "j") setSelected((value) => clamp(value + 1, 0, Math.max(0, rows.length - 1)));
    if (key.return && rows[selected]) setDetailTaskId(rows[selected].id);
  }, { isActive: inputEnabled });

  const counts = countByStatus(state.tasks);
  const spinner = spinnerFrames[frame % spinnerFrames.length];
  const selectedTask = rows[selected];

  if (detailTask) {
    return (
      <Frame config={config} state={state} spinner={spinner}>
        <TaskDetail task={detailTask} runs={runsByTask.get(detailTask.id) ?? []} />
        <Hint>Esc/b back  ·  q quit</Hint>
      </Frame>
    );
  }

  return (
    <Frame config={config} state={state} spinner={spinner}>
      <Box gap={1}>
        {tabs.map((entry) => (
          <Text key={entry.id} color={entry.id === tab ? "cyan" : "gray"} bold={entry.id === tab}>
            {entry.id === tab ? "●" : "○"} {entry.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <StatusStrip counts={counts} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {rows.length === 0 ? (
          <Text color="gray">Nothing in this view.</Text>
        ) : (
          rows.slice(0, 18).map((task, index) => (
            <TaskRow
              key={task.id}
              selected={index === selected}
              task={task}
              runs={runsByTask.get(task.id) ?? []}
              now={Date.now()}
            />
          ))
        )}
      </Box>
      {selectedTask ? (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="cyan" bold>
            Preview
          </Text>
          <Text>{singleLineReport(selectedTask, runsByTask.get(selectedTask.id) ?? [])}</Text>
        </Box>
      ) : null}
      <Hint>↑/↓ or j/k select  ·  Tab/l next tab  ·  h previous tab  ·  Enter drill down  ·  q quit</Hint>
    </Frame>
  );
}

function Frame({
  config,
  state,
  spinner,
  children,
}: {
  config: FarmConfig;
  state: FarmState;
  spinner: string;
  children: React.ReactNode;
}): React.ReactElement {
  const activeCount = state.tasks.filter((task) => task.status === "running" || task.status === "evaluating").length;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor={activeCount > 0 ? "green" : "gray"} paddingX={1}>
        <Text color="cyan" bold>
          {spinner} Offline Tarteel Agent Farm
        </Text>
        <Text color={activeCount > 0 ? "green" : "gray"}>  {activeCount > 0 ? "LIVE" : "IDLE"}</Text>
        <Text color="gray">  worker={config.models?.worker ?? config.model}  state={config.statePath}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}

function StatusStrip({ counts }: { counts: Map<TaskStatus, number> }): React.ReactElement {
  const statuses: Array<[TaskStatus, string]> = [
    ["running", "run"],
    ["evaluating", "eval"],
    ["needs-eval", "ready"],
    ["queued", "queue"],
    ["promising", "maybe"],
    ["accepted", "accept"],
    ["rejected", "reject"],
    ["self-rejected", "self"],
    ["cancelled", "cancel"],
    ["failed", "fail"],
  ];
  return (
    <Box flexWrap="wrap">
      {statuses.map(([status, label]) => (
        <Box key={status} marginRight={2}>
          <Text color={statusColor(status)}>
            {label} {counts.get(status) ?? 0}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function TaskRow({
  task,
  runs,
  selected,
  now,
}: {
  task: Task;
  runs: RunRecord[];
  selected: boolean;
  now: number;
}): React.ReactElement {
  const latestRun = latestFinishedRun(runs);
  const latestMetrics = latestRun?.metrics ? normalizeStabilityMetrics(latestRun.metrics) : undefined;
  const command = latestCommand(task, latestRun);
  return (
    <Box>
      <Text color={selected ? "black" : statusColor(task.status)} backgroundColor={selected ? "cyan" : undefined}>
        {selected ? ">" : " "} {shortId(task.id)} {pad(task.status, 13)}
      </Text>
      <Text> {pad(task.track, 28)} </Text>
      <Text color="gray">{pad(runtimeLabel(task, now), 7)}</Text>
      <Text> {metricSummary(latestMetrics)} </Text>
      <Text color="gray">{truncate(command || task.hypothesis, 76)}</Text>
    </Box>
  );
}

function TaskDetail({ task, runs }: { task: Task; runs: RunRecord[] }): React.ReactElement {
  const sortedRuns = [...runs].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={statusColor(task.status)} bold>
          {task.status}
        </Text>
        <Text> {task.track} </Text>
        <Text color="gray">{task.id}</Text>
      </Box>
      <Text color="gray">runtime {runtimeLabel(task, Date.now())} · updated {relativeTime(task.updatedAt)}</Text>
      <Text>{task.hypothesis}</Text>
      {task.notes ? <Text color={task.status === "failed" ? "red" : "yellow"}>{truncate(task.notes, 180)}</Text> : null}
      {task.lastCommand ? <Text color="cyan">now: {task.lastCommand}</Text> : null}
      {task.workerResult ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Worker Result</Text>
          <Text>mechanism: {task.workerResult.mechanism}</Text>
          <Text>changed: {task.workerResult.changedFiles.slice(0, 6).join(", ") || "none"}</Text>
          <Text>commands: {task.workerResult.commandsRun.slice(-3).join("  ·  ") || "none"}</Text>
          {task.workerResult.devMetrics ? (
            <Text>
              dev P {pct(task.workerResult.devMetrics.precision)} R {pct(task.workerResult.devMetrics.recall)} Exact{" "}
              {pct(task.workerResult.devMetrics.finalExactSet)}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {task.evalProgress ? <EvalProgress progress={task.evalProgress} /> : null}
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>Corpus Runs</Text>
        {sortedRuns.length === 0 ? (
          <Text color="gray">No runs recorded yet.</Text>
        ) : (
          sortedRuns.map((run) => <RunRow key={run.id} run={run} />)
        )}
      </Box>
      {task.recentMessages?.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Recent Worker Messages</Text>
          {task.recentMessages.slice(-8).map((message) => (
            <Text key={`${message.at}-${message.text}`} color={message.kind === "tool" ? "yellow" : "gray"}>
              {relativeTime(message.at)} {message.kind}: {truncate(message.text, 150)}
            </Text>
          ))}
        </Box>
      ) : null}
      {task.analysis ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Analysis</Text>
          <Text>
            score {task.analysis.score.toFixed(2)} · v3 Exact {signedPct(task.analysis.v3.finalExactSet)} · v2 Exact{" "}
            {signedPct(task.analysis.v2.finalExactSet)}
          </Text>
          <Text color="gray">improved: {clusterSummary(task.analysis.improvementClusters)}</Text>
          <Text color="gray">regressed: {clusterSummary(task.analysis.regressionClusters)}</Text>
        </Box>
      ) : null}
      {task.guardrails && !task.guardrails.passed ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="red" bold>Guardrails</Text>
          {task.guardrails.findings.slice(0, 4).map((finding) => (
            <Text key={`${finding.file}-${finding.match}`} color="red">
              {finding.file}: {finding.reason}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function EvalProgress({ progress }: { progress: NonNullable<Task["evalProgress"]> }): React.ReactElement {
  const running = progress.shards.filter((shard) => shard.status === "running").length;
  const launching = progress.shards.filter((shard) => shard.status === "launching").length;
  const pending = progress.shards.filter((shard) => shard.status === "pending").length;
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="cyan" bold>Evaluation</Text>
      <Text>
        {shortCorpus(progress.corpus)} r{progress.repeats} {progress.backend} {bar(progress.completedShards, progress.shardCount)}{" "}
        {progress.completedShards}/{progress.shardCount} done · {running} running · {launching} launching · {pending} pending
        {progress.failedShards ? ` · ${progress.failedShards} failed` : ""}
      </Text>
      {progress.shards.slice(0, 12).map((shard) => (
        <Text key={shard.index} color={shardColor(shard.status)}>
          shard {String(shard.index + 1).padStart(2, "0")} {pad(shard.status, 9)} {pad(`${shard.sampleCount} samples`, 10)}{" "}
          {truncate(shard.summary ?? shard.modalAppUrl ?? "", 120)}
        </Text>
      ))}
    </Box>
  );
}

function RunRow({ run }: { run: RunRecord }): React.ReactElement {
  const metrics = run.metrics ? normalizeStabilityMetrics(run.metrics) : undefined;
  return (
    <Text color={run.exitCode === 0 ? "white" : "red"}>
      {shortCorpus(run.corpus)} r{run.repeats} {run.exitCode === 0 ? "ok" : `exit ${run.exitCode ?? "?"}`}{" "}
      {duration(run.startedAt, run.finishedAt)} {metricSummary(metrics)}{" "}
      <Text color="gray">{truncate(run.command, 110)}</Text>
    </Text>
  );
}

function Hint({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color="gray">{children}</Text>
    </Box>
  );
}

function tasksForTab(state: FarmState, tab: Tab): Task[] {
  const matcher = tab === "active" ? activeStatuses : tab === "queue" ? queueStatuses : historyStatuses;
  return state.tasks
    .filter((task) => matcher.has(task.status))
    .sort((a, b) => {
      if (tab === "queue") return a.createdAt.localeCompare(b.createdAt);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

function singleLineReport(task: Task, runs: RunRecord[]): string {
  const latestRun = latestFinishedRun(runs);
  const metrics = latestRun?.metrics ? normalizeStabilityMetrics(latestRun.metrics) : undefined;
  const reason = task.notes ?? task.workerResult?.rejectionReason ?? task.workerResult?.expectedFailureModeAddressed;
  return [
    task.status,
    runtimeLabel(task, Date.now()),
    latestRun ? `${shortCorpus(latestRun.corpus)} ${metricSummary(metrics)}` : undefined,
    latestCommand(task, latestRun),
    reason,
  ]
    .filter(Boolean)
    .map((value) => truncate(String(value), 90))
    .join(" · ");
}

function groupRunsByTask(runs: RunRecord[]): Map<string, RunRecord[]> {
  const grouped = new Map<string, RunRecord[]>();
  for (const run of runs) {
    grouped.set(run.taskId, [...(grouped.get(run.taskId) ?? []), run]);
  }
  return grouped;
}

function latestFinishedRun(runs: RunRecord[]): RunRecord | undefined {
  return [...runs].sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))[0];
}

function latestCommand(task: Task, run: RunRecord | undefined): string | undefined {
  const toolMessage = task.recentMessages?.filter((message) => message.kind === "tool").at(-1)?.text;
  return task.lastCommand ?? toolMessage ?? run?.command ?? task.workerResult?.commandsRun.at(-1);
}

function runtimeLabel(task: Task, nowMs: number): string {
  const start = task.status === "evaluating" ? task.evalProgress?.startedAt ?? task.activeStartedAt : task.activeStartedAt;
  if (activeStatuses.has(task.status) && start) return duration(start, new Date(nowMs).toISOString());
  return relativeTime(task.updatedAt);
}

function metricSummary(metrics: StabilityMetrics | undefined): string {
  if (!metrics) return "P -- R -- Exact --";
  return `P ${pct(metrics.medianPrecision)} R ${pct(metrics.medianRecall)} Exact ${pct(metrics.medianExactSetAcc)}`;
}

function countByStatus(tasks: Task[]): Map<TaskStatus, number> {
  const counts = new Map<TaskStatus, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return counts;
}

function nextTab(current: Tab, direction: 1 | -1): Tab {
  const index = tabs.findIndex((entry) => entry.id === current);
  return tabs[(index + direction + tabs.length) % tabs.length]!.id;
}

function statusColor(status: TaskStatus): string {
  if (status === "running" || status === "evaluating") return "blue";
  if (status === "needs-eval") return "magenta";
  if (status === "queued" || status === "cancelled") return "gray";
  if (status === "accepted" || status === "promising") return "green";
  if (status === "rejected" || status === "self-rejected") return "yellow";
  return "red";
}

function shardColor(status: NonNullable<Task["evalProgress"]>["shards"][number]["status"]): string {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "running") return "cyan";
  if (status === "launching") return "yellow";
  return "gray";
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}pp`;
}

function bar(done: number, total: number): string {
  const cells = 12;
  const filled = total > 0 ? Math.max(0, Math.min(cells, Math.round((done / total) * cells))) : 0;
  return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
}

function duration(startIso: string, endIso: string | undefined): string {
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const start = new Date(startIso).getTime();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function relativeTime(iso: string): string {
  return `${duration(iso, new Date().toISOString())} ago`;
}

function clusterSummary(clusters: Array<{ category: string; count: number }>): string {
  return clusters.slice(0, 5).map((cluster) => `${cluster.category}:${cluster.count}`).join(", ") || "none";
}

function shortCorpus(corpus: string): string {
  return corpus.replace("test_corpus_", "").replaceAll("_", "-");
}

function shortId(id: string): string {
  return id.replace(/^task-/, "").replace(/^run-/, "").slice(-5);
}

function pad(value: string, length: number): string {
  return value.length >= length ? value.slice(0, length) : value.padEnd(length, " ");
}

function truncate(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
