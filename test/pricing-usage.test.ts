import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSource } from "../src/pricing/sources.ts";
import { priceUsage } from "../src/pricing/usage.ts";
import { validateRate } from "../src/pricing/validation.ts";
import type { ModelRate, TokenUsage } from "../src/types.ts";

const usage = (values: Partial<TokenUsage> = {}): TokenUsage => ({ inputTokens: 0, uncachedInputTokens: 0,
  cachedInputTokens: 0, cacheWriteInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0,
  outputTokens: 0, reasoningOutputTokens: 0, nonReasoningOutputTokens: 0, ...values });
const base: ModelRate = { provider: "claude", inputPerMillion: 3, outputPerMillion: 15, source: "https://example.com/prices" };

test("both feeds label only cache classes actually imputed for each request", () => {
  const sources = [normalizeSource("models.dev", { anthropic: { models: { "claude-fixture": { cost: { input: 3, output: 15 } } } } }),
    normalizeSource("litellm", { "claude-fixture": { litellm_provider: "anthropic", input_cost_per_token: 3e-6, output_cost_per_token: 15e-6 } })];
  for (const source of sources) {
    const rate = source.models["claude-fixture"]!;
    const ordinary = priceUsage(rate, usage({ inputTokens: 1e6, uncachedInputTokens: 1e6 }), 1e6);
    assert.equal(ordinary.pricedTokens, 1e6); assert.equal(ordinary.cost.totalUsd, 3); assert.deepEqual(ordinary.assumptions, []);
    const read = priceUsage(rate, usage({ inputTokens: 1e6, cachedInputTokens: 1e6 }), 1e6);
    assert.equal(read.pricedTokens, 0); assert.equal(read.cost.cachedInputUsd, 3);
    assert.deepEqual(read.assumptions, ["cache-read-at-input"]);
    const five = priceUsage(rate, usage({ inputTokens: 1e6, cacheWriteInputTokens: 1e6, cacheWrite5mInputTokens: 1e6 }), 1e6);
    assert.equal(five.pricedTokens, 0); assert.equal(five.cost.cacheWriteUsd, 3);
    assert.deepEqual(five.assumptions, ["cache-write-5m-at-input"]);
    const hour = priceUsage(rate, usage({ inputTokens: 1e6, cacheWriteInputTokens: 1e6, cacheWrite1hInputTokens: 1e6 }), 1e6);
    assert.equal(hour.pricedTokens, 0); assert.equal(hour.cost.cacheWriteUsd, 3);
    assert.deepEqual(hour.assumptions, ["cache-write-1h-at-5m"]);
    const zero = priceUsage({ ...rate, cacheReadPerMillion: 0, cacheWrite5mPerMillion: 0, cacheWrite1hPerMillion: 0 },
      usage({ inputTokens: 3e6, cachedInputTokens: 1e6, cacheWriteInputTokens: 2e6, cacheWrite5mInputTokens: 1e6, cacheWrite1hInputTokens: 1e6 }), 3e6);
    assert.equal(zero.cost.totalUsd, 0); assert.equal(zero.pricedTokens, 3e6); assert.deepEqual(zero.assumptions, []);
  }
});

test("explicit context cache tiers replace base assumptions; missing tiers retain visible estimates", () => {
  const normalized = normalizeSource("models.dev", { anthropic: { models: { "claude-fixture": { cost: {
    input: 3, output: 15, cache_read: 0.3, cache_write: 3.75,
    tiers: [{ tier: { type: "context", size: 200000 }, input: 6, output: 22.5, cache_read: 0.6, cache_write: 7.5, cache_write_1h: 12 }],
  } } } } }).models["claude-fixture"]!;
  const hour = usage({ inputTokens: 10, cacheWriteInputTokens: 10, cacheWrite1hInputTokens: 10 });
  const short = priceUsage(normalized, hour, 200000);
  assert.deepEqual(short.assumptions, ["anthropic-cache-1h-2x"]); assert.equal(short.pricedTokens, 0);
  const long = priceUsage(normalized, hour, 200001);
  assert.equal(long.cost.cacheWriteUsd, 120 / 1e6); assert.equal(long.pricedTokens, 10); assert.deepEqual(long.assumptions, []);
  const missing: ModelRate = { ...base, cacheReadPerMillion: 0.3, cacheWrite5mPerMillion: 3.75, cacheWrite1hPerMillion: 6,
    contextTiers: [{ aboveInputTokens: 200000, inputPerMillion: 6, outputPerMillion: 22.5 }] };
  const result = priceUsage(missing, usage({ inputTokens: 30, cachedInputTokens: 10, cacheWriteInputTokens: 20,
    cacheWrite5mInputTokens: 10, cacheWrite1hInputTokens: 10 }), 200001);
  assert.equal(result.pricedTokens, 0);
  assert.deepEqual(result.assumptions, ["context-cache-read-at-base", "context-cache-write-5m-at-base", "context-cache-write-1h-at-base"]);
});

test("upper-estimate assumptions describe the actual rule and do not penalize explicit base coverage", () => {
  for (const multiplier of [1, 1.25, 2]) {
    const rate = validateRate({ ...base, provider: "codex", cacheWriteObservable: false, cacheWriteMultiplier: multiplier });
    const result = priceUsage(rate, usage({ inputTokens: 1e6, uncachedInputTokens: 1e6 }), 1e6);
    assert.equal(result.cost.totalUsd, 3); assert.equal(result.cost.upperEstimateUsd, 3 * multiplier);
    assert.equal(result.pricedTokens, 1e6);
    assert.deepEqual(result.assumptions, multiplier === 1 ? [] : [multiplier === 1.25 ? "codex-cache-write-upper-1.25x" : "cache-write-upper-multiplier"]);
    const unused = priceUsage(rate, usage({ outputTokens: 100 }), 0);
    assert.deepEqual(unused.assumptions, []);
  }
});

test("unsplit cache writes label the assumed TTL and never subtract coverage twice", () => {
  const writes = usage({ inputTokens: 100, cacheWriteInputTokens: 100 });
  const knownRate = priceUsage({ ...base, cacheWrite5mPerMillion: 3.75 }, writes, 100);
  assert.equal(knownRate.pricedTokens, 0); assert.equal(knownRate.cost.cacheWriteUsd, 375 / 1e6);
  assert.deepEqual(knownRate.assumptions, ["cache-write-ttl-5m"]);
  const missingRate = priceUsage(base, writes, 100);
  assert.equal(missingRate.pricedTokens, 0);
  assert.deepEqual(missingRate.assumptions, ["cache-write-5m-at-input", "cache-write-ttl-5m"]);
  const projected = validateRate({ ...base, assumptions: ["PRIVATE_ASSUMPTION"], contextTiers: [
    { aboveInputTokens: 100, inputPerMillion: 6, outputPerMillion: 20, assumptions: ["PRIVATE_TIER_ASSUMPTION", "anthropic-cache-1h-2x"] },
  ] });
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_/);
  assert.deepEqual(projected.contextTiers![0]!.assumptions, ["anthropic-cache-1h-2x"]);
});
