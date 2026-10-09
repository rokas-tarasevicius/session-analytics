import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import {
  activityGrid, heatLegend, clampWindow, dailyCountSeries, dailySpendSeries, daysBetween, deltaDescription, downsample, groupByRepository, heatLevel,
  ledgerMoney, matchesQuery, previousPeriod, pricedPercent, pricedShare, sessionsInRange, shortMoney, sortRepositories, sparklineSummary, summarize, tickScale, windowStartFor,
} from "../src/public/view-model.js";
import { buildVelocity } from "../src/public/velocity-data.js";

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

/** A ledger session: `cells` are [day, model, value, priced tokens (of 120 eligible), calls]; cells may also be session-dated. */
function ledger(overrides: Record<string, unknown>, cells: Array<[string, string, number, number?, number?]>, { sessionDated = false } = {}) {
  const models = [...new Set(cells.map(([, model]) => model))];
  const rows = cells.map(([day, model, value, priced = 120, calls = 1]) => [day, 9, models.indexOf(model), [value, 100, 50, 50, 0, 20, 0, calls, 0, 0, priced, 0, 100, 0]]);
  return session({ sessionKey: `k-${Math.random()}`, velocity: { dimensions: models.map((model) => ({ agent: "claude-cli", model, executionKind: "top-level", effort: "unknown" })), buckets: sessionDated ? [] : rows, undated: [], ...(sessionDated ? { sessionDated: rows } : {}) }, ...overrides });
}

test("ledgerMoney splits the window's ledger by cost basis, provider and model, and every part adds up to buildVelocity's total", () => {
  const window = { start: "2026-09-20", end: "2026-09-21" };
  const sessions = [
    ledger({}, [["2026-09-20", "claude-opus-5", 2], ["2026-09-21", "claude-opus-5", 2], ["2026-09-21", "<unknown>", 1]]),
    // Started before the window: only the value it used inside the window counts.
    ledger({ createdAt: "2026-09-10T10:00:00.000Z" }, [["2026-09-19", "claude-opus-5", 100], ["2026-09-20", "claude-opus-5", 3]]),
    ledger({ costBasis: "provider-reported" }, [["2026-09-21", "claude-opus-5", 6]], { sessionDated: true }),
    ledger({ provider: "codex" }, [["2026-09-20", "gpt-5", 8]]),
    // Cursor's database value has no request time: undated, all time, never in a window.
    session({ provider: "cursor", costBasis: "provider-reported", velocity: { dimensions: [{ agent: "cursor", model: "<unknown>", executionKind: "top-level", effort: "unknown" }], buckets: [], undated: [[0, [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]] } }),
  ];
  const result = ledgerMoney(sessions, window);
  assert.equal(result.total, buildVelocity(sessions as unknown as Parameters<typeof buildVelocity>[0], window).totals[0]);
  assert.equal(result.total, 22); assert.equal(result.api, 16); assert.equal(result.reported, 6);
  assert.equal(result.undated, 5); assert.equal(result.sessionDated, 6); assert.equal(result.sessionDatedSessions, 1);
  assert.deepEqual(result.providers.map(({ provider, total, api, reported, unattributed }) => ({ provider, total, api, reported, unattributed })), [
    { provider: "claude", total: 14, api: 8, reported: 6, unattributed: 1 },
    { provider: "codex", total: 8, api: 8, reported: 0, unattributed: 0 },
  ]);
  for (const provider of result.providers) assert.equal(provider.total, provider.api + provider.reported);
  assert.equal(result.models.reduce((sum, model) => sum + model.value, 0), result.total);
  assert.deepEqual(result.models.map(({ id, value, share, sessions: count }) => [id, value, share, count]), [
    ["claude:claude-opus-5", 13, 13 / 22, 3], ["codex:gpt-5", 8, 8 / 22, 1], ["claude:<unknown>", 1, 1 / 22, 1],
  ]);
  const opus = result.models[0]!;
  assert.equal(opus.api, 7); assert.equal(opus.reported, 6); assert.equal(opus.calls, 4);
  assert.deepEqual([opus.sums[1], opus.sums[5]], [400, 80]);
  assert.deepEqual(ledgerMoney([], window), { ...ledgerMoney([], window) });
  assert.equal(ledgerMoney([], window).total, 0); assert.deepEqual(ledgerMoney([], window).providers, []);
});

test("ledgerMoney keeps unpriced evidence visible and scales the cache-write upper estimate to the window", () => {
  const window = { start: "2026-09-20", end: "2026-09-20" };
  // $10 ordinary and $12 upper for the whole session; $6 of its value is in the window, so $1.20 of premium is.
  const codex = ledger({ provider: "codex", cost: { totalUsd: 10, upperEstimateUsd: 12 } }, [["2026-09-20", "gpt-5", 6], ["2026-09-21", "gpt-5", 4]]);
  const gemini = ledger({ provider: "gemini", costBasis: "unavailable" }, [["2026-09-20", "gemini-pro", 0, 0]]);
  const result = ledgerMoney([codex, gemini], window);
  assert.equal(result.total, 6); assert.ok(Math.abs(result.upper - 7.2) < 1e-12);
  assert.ok(Math.abs(result.models.find(({ id }) => id === "codex:gpt-5")!.upper - 7.2) < 1e-12);
  const unpriced = result.models.find(({ id }) => id === "gemini:gemini-pro")!;
  assert.equal(unpriced.value, 0); assert.deepEqual([unpriced.evidence.known, unpriced.evidence.eligible], [0, 120]);
  assert.equal(result.providers.find(({ provider }) => provider === "gemini")!.total, 0);
  assert.equal(pricedShare(result.evidence), 0.5); assert.equal(pricedPercent(result.evidence), "50.0%");
});

test("priced shares round down, so only complete evidence reads 100.0%", () => {
  assert.equal(pricedPercent({ known: 999_999, eligible: 1_000_000, unsupported: 0, complete: false }), "99.9%");
  assert.equal(pricedPercent({ known: 1_000_000, eligible: 1_000_000, unsupported: 0, complete: true }), "100.0%");
  assert.equal(pricedPercent({ known: 29, eligible: 100, unsupported: 0, complete: false }), "29.0%");
  assert.equal(pricedPercent({ known: 0, eligible: 0, unsupported: 0, complete: true }), "N/A");
  assert.equal(pricedShare(null), null);
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

test("session-start selection and start-day series use the snapshot timezone, the ledger's calendar", () => {
  // 23:30 UTC on Sep 20 is 00:30 on Sep 21 in London (BST).
  const late = session({ createdAt: "2026-09-20T23:30:00.000Z" }), unknown = session({ transcript: { status: "ok", warnings: [], startTimeKnown: false } });
  assert.deepEqual(sessionsInRange([late, unknown], "2026-09-21", "2026-09-21", "Europe/London"), [late]);
  assert.deepEqual(sessionsInRange([late, unknown], "2026-09-21", "2026-09-21"), [], "UTC remains the default");
  assert.deepEqual(sessionsInRange([late, unknown], null, null, "Europe/London"), [late, unknown], "an unbounded window keeps unknown starts");
  assert.deepEqual(dailyCountSeries([late], ["2026-09-20", "2026-09-21"], () => 1, "Europe/London"), [0, 1]);
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
  assert.equal(shortMoney(0), "$0");
  assert.equal(shortMoney(7.5), "$7.50");
  assert.equal(shortMoney(76.2), "$76");
  assert.equal(shortMoney(999.6), "$1K");
  assert.equal(shortMoney(9.994), "$9.99");
  assert.equal(shortMoney(9.996), "$10");
  assert.equal(shortMoney(1900), "$1.9K");
  assert.equal(shortMoney(12345), "$12.3K");
  assert.equal(shortMoney(36), "$36");
  assert.equal(shortMoney(12.34), "$12");
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
  // The value column sorts by the window's ledger value (`usage`), the figure it shows; whole-session value plays no part.
  const evidence = { known: 0, eligible: 0, unsupported: 0, complete: true };
  const rows = [
    { repository: { id: "1", name: "beta" }, summary: { ...summarize([session()]), estimatedSpendUsd: 50 }, usage: { value: 5, evidence } },
    { repository: { id: "2", name: "alpha" }, summary: { ...summarize([session()]), estimatedSpendUsd: 1 }, usage: { value: 9, evidence } },
    { repository: { id: "3", name: "gamma" }, summary: { ...summarize([session()]), estimatedSpendUsd: 5 }, usage: { value: 5, evidence } },
  ];
  assert.deepEqual(sortRepositories(rows, "value", "descending").map((row) => row.repository.name), ["alpha", "beta", "gamma"]);
  assert.deepEqual(sortRepositories(rows, "value", "ascending").map((row) => row.repository.name), ["beta", "gamma", "alpha"]);
  assert.deepEqual(sortRepositories(rows, "name", "ascending").map((row) => row.repository.name), ["alpha", "beta", "gamma"]);
});


test("chart sizing falls back in hidden views and redraws only meaningful width changes with the latest data", async () => {
  const source = await readFile(new URL("../src/public/ui.js", import.meta.url), "utf8");
  const callbacks: Array<() => void> = [], frames: Array<() => void> = [], observed: unknown[] = [];
  const observer = class {
    constructor(callback: () => void) { callbacks.push(callback); }
    observe(container: unknown) { observed.push(container); }
  };
  const helpers = runInNewContext(source.replaceAll("export ", "") + "\n({ chartWidth, redrawOnResize })", {
    ResizeObserver: observer, requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  assert.equal(helpers.chartWidth({}, 900), 900);
  assert.equal(helpers.chartWidth(null, 1040), 1040);
  assert.equal(helpers.chartWidth({ clientWidth: 0 }, 1040), 1040);
  assert.equal(helpers.chartWidth({ clientWidth: 240 }, 900), 280);
  assert.equal(helpers.chartWidth({ clientWidth: 391.8 }, 900), 391);
  assert.equal(helpers.chartWidth({ clientWidth: 240 }, 900, 200), 240);
  const container = { clientWidth: 400 };
  let oldDraws = 0, latestDraws = 0;
  helpers.redrawOnResize(container, () => oldDraws++);
  callbacks[0]!(); assert.equal(frames.length, 0, "initial notification does not redraw");
  container.clientWidth = 416; callbacks[0]!(); assert.equal(frames.length, 0);
  container.clientWidth = 432; callbacks[0]!();
  container.clientWidth = 464; callbacks[0]!();
  assert.equal(frames.length, 1, "multiple notifications coalesce into one frame");
  frames.shift()!(); assert.equal(oldDraws, 1);
  helpers.redrawOnResize(container, () => latestDraws++);
  assert.equal(observed.length, 1, "registration updates the callback without adding observers");
  container.clientWidth = 496; callbacks[0]!(); frames.shift()!();
  assert.equal(oldDraws, 1); assert.equal(latestDraws, 1);
  container.clientWidth = 0; callbacks[0]!(); assert.equal(frames.length, 0, "hidden views do not redraw");
  container.clientWidth = 600; callbacks[0]!();
  helpers.redrawOnResize(container, () => latestDraws++);
  frames.shift()!(); assert.equal(latestDraws, 1, "an intervening data render cancels a redundant queued redraw");
  const fallback = runInNewContext(source.replaceAll("export ", "") + "\n({ redrawOnResize })", {});
  assert.doesNotThrow(() => fallback.redrawOnResize({}, () => assert.fail("no observer in test DOM")));
  const immediate = runInNewContext(source.replaceAll("export ", "") + "\n({ redrawOnResize })", { ResizeObserver: observer });
  const second = { clientWidth: 300 };
  immediate.redrawOnResize(second, () => latestDraws++);
  second.clientWidth = 332; callbacks[1]!(); assert.equal(latestDraws, 2, "works without requestAnimationFrame");

  // A redraw replaces the focused chart; focus moves to the new chart's focus stop instead of falling to the page.
  const page = { activeElement: null as unknown };
  const focusing = runInNewContext(source.replaceAll("export ", "") + "\n({ redrawOnResize })", { ResizeObserver: observer, document: page });
  const oldChart = {}, focusCalls: unknown[] = [];
  const newChart = { focus: (options: unknown) => focusCalls.push(options) };
  let current: unknown = oldChart;
  const chart = { clientWidth: 400, contains: (node: unknown) => node === current, querySelector: (selector: string) => selector === '[tabindex="0"]' ? current : null };
  focusing.redrawOnResize(chart, () => { current = newChart; });
  page.activeElement = oldChart; chart.clientWidth = 440; callbacks[2]!();
  assert.equal(JSON.stringify(focusCalls), JSON.stringify([{ preventScroll: true }]));
  page.activeElement = null; chart.clientWidth = 480; callbacks[2]!();
  assert.equal(focusCalls.length, 1, "focus elsewhere on the page is left alone");
});

test("heatLegend covers every count with only populated colour levels", () => {
  assert.deepEqual(heatLegend(0), [{ level: 0, min: 0, max: 0 }]);
  assert.deepEqual(heatLegend(1), [{ level: 0, min: 0, max: 0 }, { level: 7, min: 1, max: 1 }]);
  assert.deepEqual(heatLegend(3), [{ level: 0, min: 0, max: 0 }, { level: 4, min: 1, max: 1 }, { level: 6, min: 2, max: 2 }, { level: 7, min: 3, max: 3 }]);
  const entries = heatLegend(42), counts: number[] = [];
  for (const entry of entries) for (let value = entry.min; value <= entry.max; value++) {
    counts.push(value); assert.equal(entry.level, heatLevel(value, 42));
  }
  assert.deepEqual(counts, Array.from({ length: 43 }, (_, i) => i));
  assert.deepEqual(entries.map(row => row.level), [...new Set(entries.map(row => row.level))].sort((a, b) => a - b));
});

test("activityGrid excludes unknown, file and invalid starts and buckets in the snapshot timezone", () => {
  const late = { createdAt: "2026-09-20T23:30:00Z" };
  const sessions = [late, { ...late, transcript: { startTimeKnown: false } }, { ...late, evidence: { timing: "file-mtime" } }, { createdAt: "invalid" }, { createdAt: null }];
  const utc = activityGrid(sessions, "UTC"), local = activityGrid(sessions, "Europe/London");
  assert.equal(utc.grid[6]![23], 1); assert.equal(local.grid[0]![0], 1);
  for (const result of [utc, local]) {
    assert.equal(result.counted, 1); assert.equal(result.maximum, 1);
    assert.equal(result.grid.length, 7); assert.ok(result.grid.every(row => row.length === 24));
    assert.equal(result.grid.flat().reduce((sum, count) => sum + count, 0), result.counted);
  }
  assert.equal(activityGrid([]).maximum, 0);
});
