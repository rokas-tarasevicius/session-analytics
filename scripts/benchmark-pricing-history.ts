// Content-free pricing benchmark: 61/118 synthetic models, daily retained observations.
// Run with node --expose-gc --max-old-space-size=256 scripts/benchmark-pricing-history.ts.
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { catalogFromSnapshots, loadReviewed, resolveRate } from "../src/pricing/catalog.ts";
import { sha256, SOURCE_URLS, type SourceSnapshot } from "../src/pricing/sources.ts";
import { readSnapshots, saveSnapshot } from "../src/pricing/store.ts";
import type { ModelRate, PricingSource } from "../src/types.ts";

const reviewed = await loadReviewed();
const lookups = 20_000;
for (const count of [2, 104, 730]) {
  const directory = await mkdtemp(join(tmpdir(), "pricing-history-benchmark-"));
  try {
    for (let index = 0; index < count; index += 1) {
      const source: PricingSource = index % 2 ? "litellm" : "models.dev";
      const models: Record<string, ModelRate> = Object.create(null);
      for (let model = 0; model < (source === "models.dev" ? 61 : 118); model += 1) {
        models[`gpt-history-${model}`] = { provider: "codex", inputPerMillion: 2, outputPerMillion: 10,
          cacheReadPerMillion: 0.2, cacheWriteObservable: false, cacheWriteMultiplier: 1.25,
          contextTiers: [{ aboveInputTokens: 272000, inputPerMillion: 4, outputPerMillion: 15, cacheReadPerMillion: 0.4 }],
          source: SOURCE_URLS[source] };
      }
      const snapshot: SourceSnapshot = { version: 1, source, sourceUrl: SOURCE_URLS[source], models, rejectedModels: 0,
        fetchedAt: new Date(Date.UTC(2024, 0, 1 + Math.floor(index / 2))).toISOString(), payloadSha256: sha256(`public-observation-${index}`) };
      await saveSnapshot(directory, snapshot);
    }
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    const start = performance.now();
    const loaded = await readSnapshots(directory);
    const catalog = catalogFromSnapshots(reviewed, loaded.snapshots, { pricingPolicy: "api-first" }, new Date("2027-01-01"));
    const loadMs = performance.now() - start;
    globalThis.gc?.();
    const heap = process.memoryUsage().heapUsed;
    let checksum = 0;
    const timing = (historical: boolean): number => {
      const start = performance.now();
      for (let index = 0; index < lookups; index += 1) {
        const timestamp = historical ? "2020-01-01" : ["2020-01-01", "2024-06-15", "2027-01-01"][index % 3]!;
        checksum += resolveRate(catalog, index % 2 ? "openai/gpt-history-0" : "gpt-history-0", timestamp)!.rate.inputPerMillion;
      }
      return Math.round(performance.now() - start);
    };
    const preFirstMs = timing(true), mixedMs = timing(false);
    const sizes = await Promise.all((await readdir(directory)).map(async (name) => (await stat(join(directory, name))).size));
    console.log(JSON.stringify({ snapshots: count, modelsPerSource: [61, 118], lookupsPerCase: lookups,
      loadMs: Math.round(loadMs), preFirstMs, mixedMs, retainedHeapBytes: heap, addedHeapBytes: heap - before,
      uniqueRateTables: new Set(loaded.snapshots.map((snapshot) => snapshot.source === "reviewed" ? snapshot.card.models : snapshot.models)).size,
      diskBytes: sizes.reduce((sum, size) => sum + size, 0), checksum }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
