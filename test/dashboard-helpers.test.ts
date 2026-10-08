import assert from "node:assert/strict";
import test from "node:test";

import {
  clampWindow, costByModel, dailyCountSeries, dailySpendSeries, daysBetween, deltaDescription, downsample, groupByRepository, heatLevel,
  matchesQuery, previousPeriod, shortMoney, sortRepositories, sparklineSummary, summarize, tickScale, windowStartFor,
} from "../src/public/view-model.js";

function session(overrides: Record<string, unknown> = {}) {
  return {
    cost: { cacheWriteUsd: 0, cachedInputUsd: 0, inputUsd: 1, outputUsd: 1, totalUsd: 2, upperEstimateUsd: 2.5 },
    costBasis: "api-list-price-equivalent",
    costComplete: true,
    createdAt: "2026-09-20T10:00:00.000Z",
    executionKind: "top-level",
    metrics: { compactions: 1, durationMilliseconds: 60_000, toolCalls: 4 },
    models: [],
    pricedTokenCoverage: 1,
    provider: "claude",
    repositoryId: "repo-a",
    spendByDay: { "2026-09-20": 2 },
    tokens: { cacheWriteInputTokens: 0, cachedInputTokens: 50, inputTokens: 100, outputTokens: 10, uncachedInputTokens: 50 },
    transcript: { status: "ok", warnings: [] },
    ...overrides,
  };
}

test("costByModel aggregates provider bases, shares, model details and unattributed value", () => {
  const model = { model: "claude-opus-5", totalUsd: 2, inputUsd: 1, cachedInputUsd: 0.25, cacheWriteUsd: 0.25, outputUsd: 0.5, calls: 3, inputTokens: 100, outputTokens: 20, priced: true };
  const result = costByModel([
    session({ models: [model] }), session({ models: [model] }),
    session({ costBasis: "provider-reported", cost: { totalUsd: 6 } }),
    session({ provider: "codex", cost: { totalUsd: 10 }, models: [{ ...model, model: "gpt-5", totalUsd: 8 }] }),
    session({ provider: "cursor", costBasis: "provider-reported", cost: { totalUsd: 5 } }),
  ]);
  assert.equal(result.total, 25);
  assert.deepEqual(result.providers.map(({ provider, total, api, reported, unattributed }) => ({ provider, total, api, reported, unattributed })), [
    { provider: "codex", total: 10, api: 10, reported: 0, unattributed: 2 },
    { provider: "claude", total: 10, api: 4, reported: 6, unattributed: 6 },
    { provider: "cursor", total: 5, api: 0, reported: 5, unattributed: 5 },
  ]);
  for (const provider of result.providers) assert.equal(provider.total, provider.api + provider.reported);
  assert.equal(result.providers.reduce((sum, provider) => sum + provider.unattributed, 0) + result.models.reduce((sum, model) => sum + model.value, 0), result.total);
  assert.deepEqual(result.models.map(({ provider, share }) => [provider, share]), [["codex", 8 / 25], ["claude", 4 / 25]]);
  assert.deepEqual(result.models[1], { provider: "claude", model: "claude-opus-5", value: 4, share: 4 / 25, sessions: 2, calls: 6, inputTokens: 200, outputTokens: 40, components: { input: 2, cached: 0.5, write: 0.5, output: 1 }, priced: true, eligible: 2, selected: 2, evidence: { calls: 2, tokens: 2 } });
  assert.deepEqual(result.providers[1]!.coverage, { eligible: 3, selected: 3 });
});

test("costByModel excludes ineligible cost and token evidence while retaining selected and unpriced models", () => {
  const model = { model: "claude-opus-5", totalUsd: 2, inputUsd: 1, outputUsd: 1, calls: 3, inputTokens: 100, outputTokens: 20, priced: true };
  const result = costByModel([
    session({ models: [model] }),
    session({ models: [model], transcript: { status: "invalid" } }),
    session({ models: [{ ...model, priced: false }], costBasis: "unavailable" }),
    session({ provider: "codex", models: [], costBasis: "unavailable" }),
  ]);
  assert.equal(result.total, 2); assert.equal(result.providers.length, 1);
  const row = result.models[0]!;
  assert.equal(row.value, 2); assert.equal(row.share, 1); assert.equal(row.eligible, 1);
  assert.equal(row.selected, 3); assert.equal(row.sessions, 3); assert.equal(row.priced, false);
  assert.equal(row.calls, 6); assert.equal(row.inputTokens, 200); assert.equal(row.outputTokens, 40);
  assert.deepEqual(row.components, { input: 1, cached: 0, write: 0, output: 1 });
  assert.deepEqual(result.providers[0]!.coverage, { eligible: 1, selected: 3 });
});

test("costByModel sorts by descending value, provider and model, including zero-value evidence", () => {
  const result = costByModel([
    session({ provider: "codex", models: [{ model: "z-model", totalUsd: 2 }] }),
    session({ models: [{ model: "b-model", totalUsd: 2 }, { model: "a-model", totalUsd: 2 }, { model: "high-model", totalUsd: 3 }] }),
    session({ provider: "gemini", costBasis: "unavailable", models: [{ model: "unpriced-model", totalUsd: 100, priced: false }] }),
  ]);
  assert.deepEqual(result.models.map(({ provider, model }) => `${provider}:${model}`), ["claude:high-model", "claude:a-model", "claude:b-model", "codex:z-model", "gemini:unpriced-model"]);
  assert.deepEqual(result.providers.find(({ provider }) => provider === "claude")!.models.map(({ model }) => model), ["high-model", "a-model", "b-model"]);
  assert.equal(result.providers.find(({ provider }) => provider === "gemini")!.total, 0);
  assert.deepEqual(costByModel([]), { total: 0, providers: [], models: [] });
  const zero = costByModel([session({ costBasis: "unavailable", models: [{ model: "unpriced-model", totalUsd: 100 }] })]);
  assert.equal(zero.total, 0); assert.equal(zero.models[0]!.share, 0);
});

test("clampWindow keeps a stale custom range inside the refreshed snapshot and ordered", () => {
  // Review scenario: history now starts on September 15 after the user picked August 10 through September 8.
  assert.deepEqual(clampWindow({ end: "2026-09-08", max: "2026-10-02", min: "2026-09-15", start: "2026-08-10" }), { end: "2026-09-15", start: "2026-09-15" });
  assert.deepEqual(clampWindow({ end: "2026-12-01", max: "2026-10-02", min: "2026-08-05", start: "2026-07-01" }), { end: "2026-10-02", start: "2026-08-05" });
  assert.deepEqual(clampWindow({ end: "", max: "2026-10-02", min: "2026-08-05", start: "" }), { end: "2026-10-02", start: "2026-08-05" });
  assert.deepEqual(clampWindow({ end: "2026-09-10", max: "2026-10-02", min: "2026-08-05", start: "2026-09-01" }), { end: "2026-09-10", start: "2026-09-01" });
});

test("previousPeriod only exists when the whole preceding interval is observed", () => {
  assert.equal(previousPeriod({ end: "2026-09-08", min: "2026-08-05", start: "2026-08-10" }), null);
  assert.equal(previousPeriod({ end: "2026-10-02", min: "2026-08-05", start: "2026-09-03" }), null);
  assert.deepEqual(previousPeriod({ end: "2026-10-02", min: "2026-08-04", start: "2026-09-03" }), { endDay: "2026-09-02", length: 30, startDay: "2026-08-04" });
  assert.deepEqual(previousPeriod({ end: "2026-10-02", min: "2026-09-25", start: "2026-10-02" }), { endDay: "2026-10-01", length: 1, startDay: "2026-10-01" });
  assert.equal(previousPeriod({ end: "2026-10-02", min: "", start: "2026-10-01" }), null);
});

test("deltaDescription reports direction, hides empty comparisons, and labels the period", () => {
  assert.equal(deltaDescription(0, 0, 30), null);
  assert.equal(deltaDescription(5, null, 30), null);
  assert.deepEqual(deltaDescription(5, 0, 7), { direction: "up", label: "No activity in the previous 7 days", text: "new · vs previous 7d" });
  assert.equal(deltaDescription(120, 100, 30)?.text, "▲ 20.0% vs previous 30d");
  assert.equal(deltaDescription(80, 100, 30)?.direction, "down");
  assert.equal(deltaDescription(100, 100, 30)?.direction, "flat");
});

test("downsample preserves totals and maps source days onto drawn buckets", () => {
  const values = Array.from({ length: 731 }, (_, index) => index % 7);
  const { indexFor, values: buckets } = downsample(values, 44);
  assert.equal(buckets.length, 44);
  assert.equal(buckets.reduce((sum, value) => sum + value, 0), values.reduce((sum, value) => sum + value, 0));
  assert.equal(indexFor(0), 0);
  assert.equal(indexFor(730), 43);
  assert.equal(indexFor(-1), -1);
  const small = downsample([1, 2, 3], 44);
  assert.deepEqual(small.values, [1, 2, 3]);
  assert.equal(small.indexFor(2), 2);
});

test("window math: days, preset starts, ticks, heat levels, and money labels", () => {
  assert.deepEqual(daysBetween("2026-09-30", "2026-10-02"), ["2026-09-30", "2026-10-01", "2026-10-02"]);
  assert.deepEqual(daysBetween("2026-10-02", "2026-09-30"), []);
  assert.equal(windowStartFor("7", "2026-08-05", "2026-10-02"), "2026-09-26");
  assert.equal(windowStartFor("90", "2026-08-05", "2026-10-02"), "2026-08-05");
  assert.equal(windowStartFor("all", "2026-08-05", "2026-10-02"), "2026-08-05");
  assert.deepEqual(tickScale(36), { axisMaximum: 36, tick: 9 });
  const floor = tickScale(0);
  assert.ok(Math.abs(floor.tick - 0.0003) < 1e-12 && Math.abs(floor.axisMaximum - 0.0012) < 1e-12, "an empty window still gets a positive, finite axis");
  assert.equal(heatLevel(0, 10), 0);
  assert.equal(heatLevel(10, 10), 7);
  assert.equal(heatLevel(1, 10), 3);
  assert.equal(shortMoney(36), "$36");
  assert.equal(shortMoney(12.34), "$12.3");
  assert.equal(shortMoney(917.26), "$917");
  assert.equal(shortMoney(1234), "$1.2K");
  assert.equal(shortMoney(0.5), "$0.50");
});

test("daily series and summaries aggregate sessions by day and repository", () => {
  const sessions = [session(), session({ createdAt: "2026-09-21T08:00:00.000Z", repositoryId: "repo-b", spendByDay: { "2026-09-21": 3, "2026-09-22": 1 } })];
  const days = daysBetween("2026-09-20", "2026-09-22");
  assert.deepEqual(dailySpendSeries(sessions, days), [2, 3, 1]);
  assert.deepEqual(dailyCountSeries(sessions, days, ({ metrics }) => metrics.toolCalls), [4, 4, 0]);
  assert.deepEqual([...groupByRepository(sessions).keys()], ["repo-a", "repo-b"]);
  const summary = summarize(sessions);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.estimatedSpendUsd, 4);
  assert.equal(summary.cacheReadRatio, 0.5);
  assert.equal(sparklineSummary("Daily value", [2, 3, 1], days, (value) => `$${value}`), "Daily value: 3 days, total $6, peak $3 on 21 Sept, latest $1");
  assert.equal(sparklineSummary("Daily value", [], [], String), "Daily value: no days in the window");
});

test("palette matching accepts substrings and ordered subsequences, never unrelated terms", () => {
  const item = { group: "Views", keywords: "view costs", label: "Go to Costs" };
  assert.equal(matchesQuery(item, ""), true);
  assert.equal(matchesQuery(item, "cost"), true);
  assert.equal(matchesQuery(item, "gtc"), true);
  assert.equal(matchesQuery(item, "go costs"), true);
  assert.equal(matchesQuery(item, "zebra"), false);
});

test("sortRepositories orders by any column in both directions with a stable name tiebreak", () => {
  const rows = [
    { repository: { id: "1", name: "beta" }, summary: { ...summarize([session()]), estimatedSpendUsd: 5 } },
    { repository: { id: "2", name: "alpha" }, summary: { ...summarize([session()]), estimatedSpendUsd: 9 } },
    { repository: { id: "3", name: "gamma" }, summary: { ...summarize([session()]), estimatedSpendUsd: 5 } },
  ];
  assert.deepEqual(sortRepositories(rows, "value", "descending").map((row) => row.repository.name), ["alpha", "beta", "gamma"]);
  assert.deepEqual(sortRepositories(rows, "value", "ascending").map((row) => row.repository.name), ["beta", "gamma", "alpha"]);
  assert.deepEqual(sortRepositories(rows, "name", "ascending").map((row) => row.repository.name), ["alpha", "beta", "gamma"]);
});
