import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { FarmConfig, StabilityReport } from "./types.js";
import { ensureSymlink, readJson, writeJson } from "./fs.js";

interface Manifest {
  samples: ManifestSample[];
}

interface ManifestSample {
  id: string;
  file: string;
  category: string;
  source: string;
  expected_verses: Array<{ surah: number; ayah: number }>;
}

export function buildSplits(config: FarmConfig): void {
  const sourceCorpus = join(config.targetRepoPath, "benchmark/test_corpus_v3");
  const manifest = readJson<Manifest>(join(sourceCorpus, "manifest.json"));
  const baselinePath = join(config.targetRepoPath, config.baselineReports.v3);
  const baseline = existsSync(baselinePath)
    ? readJson<StabilityReport>(baselinePath)
    : null;

  const devIds = chooseDevIds(manifest.samples, baseline);
  const dev = manifest.samples.filter((sample) => devIds.has(sample.id));
  const holdout = manifest.samples.filter((sample) => !devIds.has(sample.id));

  writeCorpus(config, config.evaluation.devCorpus, sourceCorpus, dev);
  writeCorpus(config, config.evaluation.holdoutCorpus, sourceCorpus, holdout);

  console.log(`Wrote ${config.evaluation.devCorpus}: ${dev.length} samples`);
  console.log(`Wrote ${config.evaluation.holdoutCorpus}: ${holdout.length} samples`);
}

function chooseDevIds(samples: ManifestSample[], baseline: StabilityReport | null): Set<string> {
  const dev = new Set<string>();
  const byId = new Map(samples.map((sample) => [sample.id, sample]));

  if (baseline) {
    const exactFails = baseline.samples
      .filter((sample) => sample.exactClassification === "exact-stable-fail")
      .sort(byStableSortKey);
    const exactFlaky = baseline.samples
      .filter((sample) => sample.exactClassification === "exact-flaky")
      .sort(byStableSortKey);

    for (const sample of exactFails.slice(0, 28)) dev.add(sample.id);
    for (const sample of exactFlaky.slice(0, 24)) dev.add(sample.id);
  }

  addStratum(dev, samples, (sample) => sample.category === "long", 12);
  addStratum(dev, samples, (sample) => sample.category === "multi", 12);
  addStratum(dev, samples, (sample) => sample.source.toLowerCase().includes("tlog"), 16);
  addStratum(dev, samples, (sample) => byId.has(sample.id), 72);

  return dev;
}

function addStratum(
  dev: Set<string>,
  samples: ManifestSample[],
  predicate: (sample: ManifestSample) => boolean,
  maxTotal: number,
): void {
  for (const sample of samples.filter(predicate).sort(byManifestSortKey)) {
    if (dev.size >= maxTotal) return;
    dev.add(sample.id);
  }
}

function writeCorpus(
  config: FarmConfig,
  corpusName: string,
  sourceCorpus: string,
  samples: ManifestSample[],
): void {
  const outDir = join(config.targetRepoPath, "benchmark", corpusName);
  mkdirSync(outDir, { recursive: true });
  writeJson(join(outDir, "manifest.json"), { samples });

  for (const sample of samples) {
    ensureSymlink(join(sourceCorpus, sample.file), join(outDir, sample.file));
  }
}

function byStableSortKey(a: { id: string }, b: { id: string }): number {
  return scoreId(a.id) - scoreId(b.id);
}

function byManifestSortKey(a: ManifestSample, b: ManifestSample): number {
  return scoreId(a.id) - scoreId(b.id);
}

function scoreId(id: string): number {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
