import assert from "node:assert/strict";
import test from "node:test";
import { addUsage, emptySession, zeroTokens } from "../../src/providers/common.ts";
import { priceUsage } from "../../src/pricing/usage.ts";
import type { ProviderContext } from "../../src/providers/adapter.ts";
import type { ModelRate } from "../../src/types.ts";

test("PRICING-SUMMARY-TIERS: aggregate upper estimate includes feed context tiers", () => {
  const rate: ModelRate = { provider: "claude", inputPerMillion: 2, cacheReadPerMillion: 0.2,
    cacheWrite5mPerMillion: 2.5, cacheWrite1hPerMillion: 4, outputPerMillion: 10,
    contextTiers: [{ aboveInputTokens: 200000, inputPerMillion: 4, cacheReadPerMillion: 0.4,
      cacheWrite5mPerMillion: 5, cacheWrite1hPerMillion: 8, outputPerMillion: 15 }], source: "https://example.com/pricing" };
  const context: ProviderContext = { repository: { id: "synthetic", name: "synthetic" },
    rateCard: { currency: "USD", effectiveDate: "2026-01-01", models: { "claude-test": rate } },
    price: (r, u, input) => priceUsage(r, u, input).cost };
  const session = emptySession({ id: "synthetic", path: "", cwd: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, "cursor", context,
    { source: "cursor-sdk", fidelity: "summary", tokens: "reported", tools: "unavailable", timing: "provider", turns: "unavailable", usageUnit: "run" });
  addUsage(session, context, "claude-test", { ...zeroTokens(), inputTokens: 300000,
    uncachedInputTokens: 300000, outputTokens: 10000, nonReasoningOutputTokens: 10000 }, null, "summary");
  assert.equal(session.cost.totalUsd, 0.7);
  assert.ok(Math.abs(session.cost.upperEstimateUsd - 1.35) < 1e-12);
  assert.equal(session.metrics.maxInputTokensPerCall, 0);
});

test("PRICING-SUMMARY-TIERS: crossing input/output tier prices still bound a valid request partition", () => {
  const rate: ModelRate = { provider: "claude", inputPerMillion: 2, outputPerMillion: 1,
    contextTiers: [{ aboveInputTokens: 200000, inputPerMillion: 4, outputPerMillion: 5 },
      { aboveInputTokens: 500000, inputPerMillion: 3, outputPerMillion: 20 }], source: "https://example.com/pricing" };
  const context: ProviderContext = { repository: { id: "synthetic", name: "synthetic" },
    rateCard: { currency: "USD", effectiveDate: "2026-01-01", models: { "claude-test": rate } },
    price: (r, u, input) => priceUsage(r, u, input).cost };
  const session = emptySession({ id: "synthetic", path: "", cwd: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, "cursor", context,
    { source: "cursor-sdk", fidelity: "summary", tokens: "reported", tools: "unavailable", timing: "provider", turns: "unavailable", usageUnit: "run" });
  const requests = [
    { ...zeroTokens(), inputTokens: 500000, uncachedInputTokens: 500000 },
    { ...zeroTokens(), inputTokens: 500000, uncachedInputTokens: 500000 },
    { ...zeroTokens(), inputTokens: 500001, uncachedInputTokens: 500001, outputTokens: 100000, nonReasoningOutputTokens: 100000 },
  ];
  const actual = requests.reduce((sum, usage) => sum + priceUsage(rate, usage, usage.inputTokens).cost.totalUsd, 0);
  addUsage(session, context, "claude-test", { ...zeroTokens(), inputTokens: 1500001,
    uncachedInputTokens: 1500001, outputTokens: 100000, nonReasoningOutputTokens: 100000 }, null, "summary");
  assert.ok(Math.abs(actual - 7.500003) < 1e-12);
  assert.ok(session.cost.upperEstimateUsd >= actual);
});

test("PRICING-SUMMARY-TIERS: crossing 5m/1h tier prices bound mixed-TTL requests", () => {
  const rate: ModelRate = { provider: "claude", inputPerMillion: 0, cacheReadPerMillion: 0,
    cacheWrite5mPerMillion: 1, cacheWrite1hPerMillion: 1, outputPerMillion: 0,
    contextTiers: [{ aboveInputTokens: 200000, inputPerMillion: 0, outputPerMillion: 0,
      cacheWrite5mPerMillion: 10, cacheWrite1hPerMillion: 1 },
      { aboveInputTokens: 500000, inputPerMillion: 0, outputPerMillion: 0,
        cacheWrite5mPerMillion: 1, cacheWrite1hPerMillion: 10 }], source: "https://example.com/pricing" };
  const context: ProviderContext = { repository: { id: "synthetic", name: "synthetic" },
    rateCard: { currency: "USD", effectiveDate: "2026-01-01", models: { "claude-test": rate } },
    price: (r, u, input) => priceUsage(r, u, input).cost };
  const session = emptySession({ id: "synthetic", path: "", cwd: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, "cursor", context,
    { source: "cursor-sdk", fidelity: "summary", tokens: "reported", tools: "unavailable", timing: "provider", turns: "unavailable", usageUnit: "run" });
  const requests = [
    { ...zeroTokens(), inputTokens: 500000, cacheWriteInputTokens: 500000, cacheWrite5mInputTokens: 500000 },
    { ...zeroTokens(), inputTokens: 500001, cacheWriteInputTokens: 500001, cacheWrite1hInputTokens: 500001 },
  ];
  const actual = requests.reduce((sum, usage) => sum + priceUsage(rate, usage, usage.inputTokens).cost.totalUsd, 0);
  addUsage(session, context, "claude-test", { ...zeroTokens(), inputTokens: 1000001,
    cacheWriteInputTokens: 1000001, cacheWrite5mInputTokens: 500000, cacheWrite1hInputTokens: 500001 }, null, "summary");
  assert.ok(Math.abs(actual - 10.00001) < 1e-12);
  assert.ok(session.cost.upperEstimateUsd >= actual);
});

test("PRICING-SUMMARY-TIERS: partially known TTL leaves an upper bound for remaining writes", () => {
  const rate: ModelRate = { provider: "claude", inputPerMillion: 2, outputPerMillion: 10,
    cacheWrite5mPerMillion: 2.5, cacheWrite1hPerMillion: 4, source: "https://example.com/pricing" };
  const context: ProviderContext = { repository: { id: "synthetic", name: "synthetic" },
    rateCard: { currency: "USD", effectiveDate: "2026-01-01", models: { "claude-test": rate } },
    price: (r, u, input) => priceUsage(r, u, input).cost };
  const session = emptySession({ id: "synthetic", path: "", cwd: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, "cursor", context,
    { source: "cursor-sdk", fidelity: "summary", tokens: "reported", tools: "unavailable", timing: "provider", turns: "unavailable", usageUnit: "run" });
  addUsage(session, context, "claude-test", { ...zeroTokens(), inputTokens: 100,
    cacheWriteInputTokens: 100, cacheWrite5mInputTokens: 40 }, null, "request");
  assert.ok(Math.abs(session.cost.totalUsd - 100 * 2.5 / 1e6) < 1e-12);
  assert.ok(Math.abs(session.cost.upperEstimateUsd - (40 * 2.5 + 60 * 4) / 1e6) < 1e-12);
});
