import assert from "node:assert/strict";
import test from "node:test";

import {
  clampWindow, dailyCountSeries, dailySpendSeries, daysBetween, deltaDescription, downsample, groupByRepository, heatLevel,
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
