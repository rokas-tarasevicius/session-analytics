import assert from "node:assert/strict";
import test from "node:test";
import { buildVelocity, calendarDays, comparePeriods, comparisonSpan, localDay, velocityIndicators } from "../src/public/velocity-data.js";
import type { Period } from "../src/public/velocity-data.js";
import type { SessionAnalytics, VelocityValues } from "../src/types.ts";

// One synthetic Claude session per call. Each bucket's value is fully priced unless `priced` says otherwise.
function ledger(dailyValues: Array<[string, number]>, { priced = 1 }: { priced?: number } = {}): SessionAnalytics {
  const values = (value: number): VelocityValues => [value, value * 100, value * 50, value * 40, value * 10, value * 20, value * 5, 4, 6, 1, value * 120 * priced, value * 20, value * 100, value * 100];
  return {
    provider: "claude", repositoryId: "repo", repositoryName: "Synthetic repository", sessionKey: "synthetic", createdAt: "2020-01-01T00:00:00Z",
    velocity: { dimensions: [{ agent: "claude-cli", model: "synthetic-model", executionKind: "top-level", effort: "high" }], buckets: dailyValues.map(([day, value]) => [day, 12, 0, values(value)]), undated: [] },
  } as unknown as SessionAnalytics;
}
const every = (start: string, end: string, value: (day: string) => number) => calendarDays(start, end).map((day): [string, number] => [day, value(day)]);
const indicators = (sessions: SessionAnalytics[], today: string, end = today, metric: "value" | "calls" = "value") =>
  velocityIndicators(buildVelocity(sessions, { ...comparisonSpan(end, today), metric }), today);
const period = (value: number, calls = 10, overrides: Partial<Period> = {}): Period => ({
  start: "2026-10-05", end: "2026-10-07", days: 3, coveredDays: 3, covered: true, value, calls,
  evidence: { known: 1, eligible: 1, unsupported: 0, complete: true }, ...overrides,
});

test("the comparison span looks back two whole months from the anchor, across year boundaries", () => {
  assert.deepEqual(comparisonSpan("2026-10-08", "2026-10-08"), { start: "2026-08-01", end: "2026-10-08" });
  assert.deepEqual(comparisonSpan("2026-01-01", "2026-01-01"), { start: "2025-11-01", end: "2026-01-01" });
  assert.deepEqual(comparisonSpan("2026-03-15", "2026-10-08"), { start: "2026-01-01", end: "2026-03-15" }, "Historical windows anchor on their end");
  assert.deepEqual(comparisonSpan("2026-10-02", "2026-10-01"), { start: "2026-08-01", end: "2026-10-02" }, "A UTC end date ahead of local today anchors on today");
});

test("week to date compares Monday through yesterday with the same weekdays one week earlier", () => {
  const session = ledger(every("2026-08-01", "2026-10-08", (day) => day >= "2026-10-05" ? 20 : 10));
  const { week } = indicators([session], "2026-10-08"); // Thursday
  assert.deepEqual([week.current.start, week.current.end, week.previous.start, week.previous.end], ["2026-10-05", "2026-10-07", "2026-09-28", "2026-09-30"]);
  assert.equal(week.current.value, 60); assert.equal(week.previous.value, 30);
  assert.equal(week.status, "change"); assert.equal(week.delta, 1); assert.equal(week.rolledBack, false);
});

test("a selected window shorter than the comparison does not clip it", () => {
  const session = ledger(every("2026-08-01", "2026-10-08", () => 10));
  const windowOnly = velocityIndicators(buildVelocity([session], { start: "2026-10-02", end: "2026-10-08" }), "2026-10-08");
  assert.equal(windowOnly.week.delta, null, "Window-bounded data cannot see the prior week");
  const { week, month } = indicators([session], "2026-10-08");
  assert.equal(week.delta, 0); assert.equal(month.delta, 0);
});

test("on a Monday the week rolls back to last full week versus the week before", () => {
  const session = ledger(every("2026-08-01", "2026-10-05", (day) => day >= "2026-09-28" ? 15 : 10));
  const { week } = indicators([session], "2026-10-05");
  assert.equal(week.rolledBack, true);
  assert.deepEqual([week.current.start, week.current.end, week.previous.start, week.previous.end], ["2026-09-28", "2026-10-04", "2026-09-21", "2026-09-27"]);
  assert.equal(week.current.days, 7); assert.equal(week.delta, 0.5);
});

test("on the 1st the month rolls back to the last full month, clipped to the shorter month", () => {
  const session = ledger(every("2026-07-01", "2026-10-01", () => 10));
  const { month } = indicators([session], "2026-10-01");
  assert.equal(month.rolledBack, true);
  assert.deepEqual([month.current.start, month.current.end, month.previous.start, month.previous.end], ["2026-09-01", "2026-09-30", "2026-08-01", "2026-08-30"]);
  assert.equal(month.delta, 0);
  const january = indicators([ledger(every("2025-10-01", "2026-01-01", () => 10))], "2026-01-01");
  assert.deepEqual([january.month.current.start, january.month.current.end, january.month.previous.start, january.month.previous.end], ["2025-12-01", "2025-12-30", "2025-11-01", "2025-11-30"]);
  assert.deepEqual([january.week.current.start, january.week.current.end, january.week.previous.start], ["2025-12-29", "2025-12-31", "2025-12-22"], "Weeks cross the year boundary");
});

test("month to date pairs the same day numbers and clips both sides after a short February", () => {
  const leap = indicators([ledger(every("2024-01-01", "2024-03-31", () => 10))], "2024-03-31").month;
  assert.equal(leap.current.days, 29); assert.equal(leap.previous.days, 29); assert.equal(leap.previous.end, "2024-02-29");
  const common = indicators([ledger(every("2025-01-01", "2025-03-31", () => 10))], "2025-03-31").month;
  assert.equal(common.current.end, "2025-03-28"); assert.equal(common.previous.end, "2025-02-28");
  const early = indicators([ledger(every("2026-08-01", "2026-10-08", () => 10))], "2026-10-08").month;
  assert.deepEqual([early.current.start, early.current.end, early.previous.start, early.previous.end], ["2026-10-01", "2026-10-07", "2026-09-01", "2026-09-07"]);
});

test("today follows the snapshot timezone, so the same instant can be Monday or Sunday", () => {
  const session = ledger(every("2026-08-01", "2026-10-05", () => 10));
  const instant = "2026-10-04T23:30:00Z";
  const london = localDay(instant, "Europe/London"), angeles = localDay(instant, "America/Los_Angeles");
  assert.equal(london, "2026-10-05"); assert.equal(angeles, "2026-10-04");
  const monday = indicators([session], london!).week;
  assert.equal(monday.rolledBack, true); assert.equal(monday.current.end, "2026-10-04");
  const sunday = indicators([session], angeles!).week;
  assert.equal(sunday.rolledBack, false);
  assert.deepEqual([sunday.current.start, sunday.current.end], ["2026-09-28", "2026-10-03"]);
});

test("empty and zero prior periods never produce Infinity, NaN or an invented 0%", () => {
  const fresh = indicators([ledger(every("2026-10-05", "2026-10-08", () => 10))], "2026-10-08");
  assert.equal(fresh.week.status, "unavailable"); assert.equal(fresh.week.delta, null);
  assert.equal(fresh.week.reason, "No observed history for the prior period");
  const quietPrior = indicators([ledger([["2026-09-01", 5], ...every("2026-10-05", "2026-10-08", () => 10)])], "2026-10-08");
  assert.equal(quietPrior.week.status, "new"); assert.equal(quietPrior.week.delta, null); assert.equal(quietPrior.week.previous.value, 0);
  const idle = indicators([ledger([["2026-09-01", 5], ["2026-10-08", 5]])], "2026-10-08");
  assert.equal(idle.week.status, "idle"); assert.equal(idle.week.delta, null);
  const stopped = indicators([ledger(every("2026-08-01", "2026-10-01", () => 10))], "2026-10-08");
  assert.equal(stopped.week.status, "change"); assert.equal(stopped.week.delta, -1, "Observed inactivity is a measured decline");
  for (const result of [fresh, quietPrior, idle, stopped]) for (const item of [result.week, result.month]) {
    assert.ok(item.delta === null || Number.isFinite(item.delta));
  }
  assert.match(comparePeriods(period(5), period(0.004), "value").reason!, /minimum baseline/);
  assert.match(comparePeriods(period(5), period(1, 2), "value").reason!, /3 model calls/);
});

test("comparisons accept small pricing gaps with a partial flag and refuse large ones", () => {
  const nearly = indicators([ledger(every("2026-08-01", "2026-10-08", () => 10), { priced: 0.95 })], "2026-10-08").week;
  assert.equal(nearly.status, "change"); assert.equal(nearly.partial, true); assert.equal(nearly.delta, 0);
  const half = indicators([ledger(every("2026-08-01", "2026-10-08", () => 10), { priced: 0.5 })], "2026-10-08").week;
  assert.equal(half.status, "unavailable"); assert.equal(half.reason, "50% of tokens priced in the current period; 90% needed");
  const unsupported = comparePeriods(period(5), period(5, 10, { evidence: { known: 0, eligible: 0, unsupported: 3, complete: false } }), "uncached");
  assert.equal(unsupported.status, "unavailable");
});

test("sources without an activity ledger are disclosed; only stale snapshots block comparisons", () => {
  const dated = ledger(every("2026-08-01", "2026-10-08", () => 10));
  const opencode = { provider: "opencode", repositoryId: "repo", createdAt: "2026-10-06T10:00:00Z", cost: { totalUsd: 4 }, evidence: { source: "opencode-db" } } as unknown as SessionAnalytics;
  const data = buildVelocity([dated, opencode], { ...comparisonSpan("2026-10-08", "2026-10-08") });
  assert.equal(data.missingSessions, 0); assert.deepEqual(data.unledgered, { sessions: 1, value: 4 });
  assert.equal(velocityIndicators(data, "2026-10-08").week.status, "change");
  const stale = { provider: "claude", repositoryId: "repo", createdAt: "2026-10-06T10:00:00Z", cost: { totalUsd: 4 } } as unknown as SessionAnalytics;
  const blocked = indicators([dated, stale], "2026-10-08").week;
  assert.equal(blocked.status, "unavailable"); assert.match(blocked.reason!, /Refresh/);
});

test("calendar comparisons on count metrics use the same periods", () => {
  const session = ledger(every("2026-08-01", "2026-10-08", (day) => day >= "2026-10-05" ? 2 : 1));
  const { week } = indicators([session], "2026-10-08", "2026-10-08", "calls");
  assert.equal(week.current.value, 12); assert.equal(week.previous.value, 12, "Each bucket records four calls");
  assert.equal(week.delta, 0);
});
