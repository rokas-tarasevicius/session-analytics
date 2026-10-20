import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { catalogFromSnapshots, loadReviewed, resolveRate } from "../src/pricing/catalog.ts";
import { normalizeSource } from "../src/pricing/sources.ts";
import { readSnapshots, saveSnapshot } from "../src/pricing/store.ts";
import { priceUsage } from "../src/pricing/usage.ts";
import type { TokenUsage } from "../src/types.ts";

const usage: TokenUsage = { inputTokens: 100000, uncachedInputTokens: 25000, cachedInputTokens: 25000,
  cacheWriteInputTokens: 50000, cacheWrite5mInputTokens: 25000, cacheWrite1hInputTokens: 25000,
  outputTokens: 10000, reasoningOutputTokens: 0, nonReasoningOutputTokens: 10000 };

test("bundled Haiku 5.5 tier survives reviewed storage and prices every token class above 100K", async () => {
  const reviewed = await loadReviewed();
  assert.equal(reviewed.card.effectiveDate, "2026-10-20");
  const directory = await mkdtemp(join(tmpdir(), "latest-reviewed-"));
  try {
    await saveSnapshot(directory, reviewed);
    const stored = await readSnapshots(directory);
    assert.deepEqual(stored.warnings, []);
    const catalog = catalogFromSnapshots(reviewed, stored.snapshots, { offline: true });
    const selected = resolveRate(catalog, "claude-haiku-5-5")!;
    assert.equal(selected?.provenance.kind, "fallback");
    assert.equal(reviewed.card.reviewedOverrides?.includes("claude-haiku-5-5"), false);
    assert.deepEqual(selected.rate, { provider: "claude", inputPerMillion: 0.1, outputPerMillion: 0.5,
      cacheReadPerMillion: 0.01, cacheWrite5mPerMillion: 0.125, cacheWrite1hPerMillion: 0.2,
      contextTiers: [{ aboveInputTokens: 100000, inputPerMillion: 0.5, outputPerMillion: 2.5,
        cacheReadPerMillion: 0.05, cacheWrite5mPerMillion: 0.625, cacheWrite1hPerMillion: 1 }],
      source: "https://platform.claude.com/docs/en/about-claude/pricing" });
    for (const card of [reviewed, ...stored.snapshots.filter((snapshot) => snapshot.source === "reviewed")]) {
      const rate = resolveRate(catalogFromSnapshots(card, [], { pricingPolicy: "reviewed-only" }), "claude-haiku-5-5")!.rate;
      assert.equal(priceUsage(rate, usage, 100000).cost.totalUsd, 0.015875);
      const long = priceUsage(rate, usage, 100001);
      assert.equal(long.cost.totalUsd, 0.079375);
      assert.equal(long.pricedTokens, 110000);
      assert.deepEqual(long.assumptions, []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const [model, input, cached, output] of [["gpt-6-luna", 0.1, 0.01, 0.5], ["gpt-5.6-luna", 0.2, 0.02, 1.2]] as const) {
  test(`bundled ${model} retains paid-write and full-request long-context rules`, async () => {
    const reviewed = await loadReviewed();
    assert.equal(reviewed.card.reviewedOverrides?.includes(model), false);
    const selected = resolveRate(catalogFromSnapshots(reviewed, [], { offline: true }), model)!;
    assert.equal(selected?.provenance.kind, "fallback");
    assert.deepEqual(selected.rate, { provider: "codex", inputPerMillion: input, cachedInputPerMillion: cached,
      outputPerMillion: output, cacheWriteMultiplier: 1.25, cacheWriteObservable: false,
      longContext: { inputMultiplier: 2, outputMultiplier: 1.5, thresholdInputTokens: 272000 },
      source: `https://developers.openai.com/api/docs/models/${model}`, assumptions: ["codex-cache-write-upper-1.25x"] });
    const tokens = { ...usage, inputTokens: 100000, uncachedInputTokens: 75000, cacheWriteInputTokens: 0,
      cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0 };
    const base = priceUsage(selected.rate, tokens, 272000), long = priceUsage(selected.rate, tokens, 272001);
    assert.equal(long.cost.inputUsd, base.cost.inputUsd * 2);
    assert.equal(long.cost.cachedInputUsd, base.cost.cachedInputUsd * 2);
    assert.ok(Math.abs(long.cost.outputUsd - base.cost.outputUsd * 1.5) < 1e-12);
    assert.ok(long.cost.upperEstimateUsd > long.cost.totalUsd);
    for (const id of [model, `openai/${model.replace(/(\d)\.(?=\d)/g, "$1-")}-20261020`]) {
      const normalized = normalizeSource("models.dev", { openai: { models: {
        [id]: { cost: { input, output, cache_read: cached } },
      } } }).models[id]!;
      assert.equal(normalized.cacheWriteMultiplier, 1.25);
    }
  });
}
