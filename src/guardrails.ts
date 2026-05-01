import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import type { FarmConfig, GuardrailFinding, GuardrailResult, Task } from "./types.js";
import { readJson } from "./fs.js";

interface Manifest {
  samples?: Array<{ id?: string; file?: string }>;
}

const runtimeExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py"]);
const ignoredDirs = new Set([
  ".git",
  ".next",
  ".venv",
  ".worktrees",
  "benchmark",
  "coverage",
  "dist",
  "node_modules",
  "test",
  "tests",
  "__tests__",
]);

export function runGuardrails(config: FarmConfig, task: Task): GuardrailResult {
  const repoPath = task.worktreePath ?? config.targetRepoPath;
  const findings: GuardrailFinding[] = [];
  const forbiddenTokens = forbiddenRuntimeTokens(config);

  for (const file of runtimeFiles(repoPath)) {
    const text = readFileSync(file, "utf-8");
    const relativeFile = relative(repoPath, file);

    for (const token of forbiddenTokens) {
      if (token.length < 4) continue;
      if (text.includes(token)) {
        findings.push({
          file: relativeFile,
          reason: "runtime code references evaluation-only corpus/sample/source data",
          match: token,
        });
      }
    }

    const fixedVerseList = text.match(/(?:\[[^\]]*(?:\d{1,3}:\d{1,3})[^\]]*){5,}/);
    if (fixedVerseList) {
      findings.push({
        file: relativeFile,
        reason: "runtime code appears to contain a hardcoded verse list",
        match: fixedVerseList[0].slice(0, 120),
      });
    }
  }

  return { passed: findings.length === 0, findings };
}

function forbiddenRuntimeTokens(config: FarmConfig): string[] {
  const corpora = [
    config.evaluation.devCorpus,
    config.evaluation.holdoutCorpus,
    config.evaluation.fullCorpus,
    "test_corpus_v2",
  ];
  const tokens = new Set(corpora);

  for (const corpus of corpora) {
    const manifestPath = join(config.targetRepoPath, "benchmark", corpus, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson<Manifest>(manifestPath);
    for (const sample of manifest.samples ?? []) {
      addToken(tokens, sample.id);
      addToken(tokens, sample.file);
      for (const part of (sample.file ?? "").split(/[/.]/)) {
        if (part.length >= 8 && /[a-z]/i.test(part)) addToken(tokens, part);
      }
    }
  }

  return [...tokens];
}

function addToken(tokens: Set<string>, value: string | undefined): void {
  const token = value?.trim();
  if (token) tokens.add(token);
}

function runtimeFiles(root: string): string[] {
  const files: string[] = [];
  const runtimeRoots = [
    "src",
    "app",
    "lib",
    "web/frontend/src",
    "web/frontend/app",
    "web/frontend/lib",
  ];
  for (const runtimeRoot of runtimeRoots) {
    const path = join(root, runtimeRoot);
    if (existsSync(path)) walk(path, files);
  }
  return files;
}

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) walk(join(dir, entry.name), files);
      continue;
    }
    if (entry.isFile() && runtimeExtensions.has(extname(entry.name))) {
      files.push(join(dir, entry.name));
    }
  }
}
