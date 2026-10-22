import assert from "node:assert/strict";
import test from "node:test";
import { counterfactualValue } from "../src/public/counterfactual-data.js";
import type { PublicModelRate, SessionAnalytics, VelocityValues } from "../src/types.ts";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

const window = { start: "2026-09-01", end: "2026-09-30" };
const rate: PublicModelRate = { provider: "claude", inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 };
const counts = (): VelocityValues => [99, 1_000_000, 600_000, 300_000, 100_000, 200_000, 50_000, 1, 0, 0, 0, 200_000, 1_000_000, 1_000_000];
function session(values = counts()): SessionAnalytics {
  const s = sample();
  s.costBasis = "api-list-price-equivalent";
  s.velocity = { dimensions: [{ agent: "claude-cli", model: "<unknown>", executionKind: "top-level", effort: "unknown" }],
    buckets: [["2026-09-15", 12, 0, values]], undated: [] };
  return s;
}

test("ordinary counterfactual re-prices disjoint token classes, not original value or reasoning twice", () => {
  const s = session(), before = JSON.stringify(s);
  const actual = counterfactualValue([s], rate, window);
  assert.ok(Math.abs(actual.valueUsd! - 4.89) < 1e-12);
  assert.equal(actual.tokens, 1_200_000);
  assert.equal(actual.repricedTokens, 1_100_000);
  assert.equal(actual.unrepricedTokens, 100_000);
  assert.equal(actual.coverage, 11 / 12);
  assert.deepEqual(actual.excluded, { providerReported: 0, inputSplit: 0, cacheWrite: 100_000, missingRate: 0 });
  assert.equal(JSON.stringify(s), before, "hypothetical pricing must not modify snapshot/export operands");
});

test("zero tariffs are explicit; absent cache rates stay excluded and cached-input wins over cache-read", () => {
  const zero = counterfactualValue([session()], { ...rate, inputPerMillion: 0, cachedInputPerMillion: 0, cacheReadPerMillion: 100, outputPerMillion: 0 }, window);
  assert.equal(zero.valueUsd, 0); assert.equal(zero.repricedTokens, 1_100_000);
  const missing = counterfactualValue([session()], { provider: "claude", inputPerMillion: 3, outputPerMillion: 15 }, window);
  assert.equal(missing.excluded.missingRate, 300_000);
  assert.equal(missing.unrepricedTokens, 400_000);
  assert.equal(missing.valueUsd, 4.8);
  const fallback = counterfactualValue([session()], { ...rate, cachedInputPerMillion: undefined, cacheReadPerMillion: 0.2 }, window);
  assert.ok(Math.abs(fallback.valueUsd! - 4.86) < 1e-12);
});

test("unavailable rates and empty selections never assert a free hypothetical", () => {
  const missing = counterfactualValue([session()], null, window);
  assert.equal(missing.valueUsd, null); assert.equal(missing.coverage, 0);
  assert.equal(missing.unrepricedTokens, 1_200_000);
  for (const sessions of [[], [session(Array(14).fill(0) as VelocityValues)]]) {
    const empty = counterfactualValue(sessions, rate, window);
    assert.equal(empty.valueUsd, null); assert.equal(empty.coverage, null);
  }
  const invalid = counterfactualValue([session()], { ...rate, inputPerMillion: NaN, cachedInputPerMillion: -1, outputPerMillion: Infinity }, window);
  assert.equal(invalid.valueUsd, null); assert.equal(invalid.unrepricedTokens, 1_200_000);
});

test("unknown or inconsistent input splits cannot turn numeric placeholders into rate evidence", () => {
  for (const known of [0, 500_000]) {
    const values = counts(); values[12] = known;
    const actual = counterfactualValue([session(values)], rate, window);
    assert.equal(actual.excluded.inputSplit, 1_000_000);
    assert.equal(actual.repricedTokens, 200_000); assert.equal(actual.valueUsd, 3);
  }
  const inconsistent = counts(); inconsistent[2] += 1;
  assert.equal(counterfactualValue([session(inconsistent)], rate, window).excluded.inputSplit, 1_000_000);
});

test("activity dates include session-dated cells and disclose undated/legacy evidence separately", () => {
  const s = session();
  s.velocity!.buckets.push(["2026-08-31", 23, 0, counts()], ["2026-10-01", 0, 0, counts()]);
  s.velocity!.sessionDated = [["2026-09-30", 23, 0, counts()]];
  s.velocity!.undated.push([0, counts()]);
  const legacy = sample();
  const actual = counterfactualValue([s, legacy], rate, window);
  assert.equal(actual.tokens, 2_400_000); assert.equal(actual.repricedTokens, 2_200_000);
  assert.equal(actual.undatedTokens, 1_200_000); assert.equal(actual.unledgeredSessions, 1);
  assert.equal(counterfactualValue([s], rate, { start: "2026-09-30", end: "2026-09-30" }).tokens, 1_200_000);
});

test("provider-reported tokens stay in the excluded denominator; ordinary rates ignore request tiers", () => {
  const reported = session(); reported.costBasis = "provider-reported";
  const actual = counterfactualValue([session(), reported], { ...rate,
    longContext: { thresholdInputTokens: 1, inputMultiplier: 100, outputMultiplier: 100 },
    contextTiers: [{ aboveInputTokens: 1, inputPerMillion: 999, outputPerMillion: 999 }],
    cacheWrite5mPerMillion: 3.75, cacheWrite1hPerMillion: 6 }, window);
  assert.ok(Math.abs(actual.valueUsd! - 4.89) < 1e-12);
  assert.equal(actual.excluded.providerReported, 1_200_000);
  assert.equal(actual.unrepricedTokens, 1_300_000);
  assert.equal(actual.tokens, 2_400_000);
});

test("Costs model selection updates hypothetical value while preserving totals and snapshot", async () => {
  const s = session(), before = JSON.stringify(s);
  const { document, run, context } = await harness([s]);
  context.rates = [{ model: "model-a", rate }, { model: "model-b", rate: { ...rate, inputPerMillion: 6 } }];
  run("snapshot.rateCard = { models: rates }; renderCosts(activeView())");
  const total = document.querySelector("#cost-total")!.textContent;
  const result = document.querySelector(".counterfactual-result")!;
  assert.match(result.textContent, /\$4.89/);
  assert.match(result.textContent, /100,000 of 1,200,000 tokens not re-priced/);
  assert.match(result.textContent, /8.4% not re-priced/);
  const select = document.querySelector("#counterfactual-model")!;
  assert.equal(select.getAttribute("aria-label"), "Hypothetical rate-card model");
  select.value = "model-b"; select.listeners.get("change")!();
  assert.match(result.textContent, /\$6.69/);
  assert.equal(document.querySelector("#counterfactual-model"), select, "changing a target preserves keyboard focus on the control");
  assert.equal(document.querySelector("#cost-total")!.textContent, total);
  run("renderCosts(activeView())");
  assert.equal(document.querySelector("#counterfactual-model")!.value, "model-b");
  assert.equal(JSON.stringify(s), before);
});

test("Costs supports no rate card, an empty window and replacing a missing target", async () => {
  const { document, run, context } = await harness([]);
  run("renderCosts(activeView())");
  assert.match(document.querySelector("#counterfactual-pricing")!.textContent, /No model rates/);
  context.rates = [{ model: "model-a", rate }];
  run("snapshot.rateCard = { models: rates }; counterfactualModel = 'missing'; renderCosts(activeView())");
  assert.equal(document.querySelector("#counterfactual-model")!.value, "model-a");
  assert.match(document.querySelector(".counterfactual-result")!.textContent, /No dated tokens/);
  assert.doesNotMatch(document.querySelector(".counterfactual-result")!.textContent, /\$0\.00/);
});
