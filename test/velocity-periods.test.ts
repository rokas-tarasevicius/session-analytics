import assert from "node:assert/strict";
import test from "node:test";
import { buildVelocity, calendarDays, comparePeriods, comparisonSpan, localDay, periodFromVelocity, topMovers, velocityIndicators } from "../src/public/velocity-data.js";
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

test("a prior period that starts before observed history is reported as partly observed", () => {
  const { week } = indicators([ledger(every("2026-09-29", "2026-10-08", () => 10))], "2026-10-08");
  assert.equal(week.status, "unavailable"); assert.equal(week.reason, "Prior period is only partly observed");
  assert.equal(week.previous.coveredDays, 2, "Sep 28 predates the first observed date");
  const { month } = indicators([ledger(every("2026-09-03", "2026-10-08", () => 10))], "2026-10-08");
  assert.equal(month.reason, "Prior period is only partly observed"); assert.equal(month.previous.coveredDays, 5);
  const none = indicators([ledger(every("2026-10-01", "2026-10-08", () => 10))], "2026-10-08").week;
  assert.equal(none.reason, "No observed history for the prior period");
});

test("a past window keeps its end date, compares through it and has no month-end projection", () => {
  const session = ledger(every("2026-07-01", "2026-10-08", () => 10));
  const monday = indicators([session], "2026-10-08", "2026-10-05");
  assert.equal(monday.completeThrough, "2026-10-05");
  assert.equal(monday.week.rolledBack, false);
  assert.deepEqual([monday.week.current.start, monday.week.current.end, monday.week.previous.start, monday.week.previous.end], ["2026-10-05", "2026-10-05", "2026-09-28", "2026-09-28"]);
  assert.equal(monday.week.delta, 0);
  const monthEnd = indicators([session], "2026-10-08", "2026-09-30");
  assert.equal(monthEnd.month.current.days, 30); assert.equal(monthEnd.month.previous.end, "2026-08-30");
  assert.equal(monthEnd.projection, null, "A finished month has nothing left to project");
});

test("sessions without an activity ledger do not disable rolling averages or top movers", () => {
  const dated = ledger(every("2026-08-01", "2026-09-15", () => 10));
  const gemini = { provider: "gemini", repositoryId: "repo", createdAt: "2026-09-10T10:00:00Z", cost: { totalUsd: 2 }, evidence: { source: "gemini-chat" } } as unknown as SessionAnalytics;
  const data = buildVelocity([dated, gemini], { start: "2026-09-01", end: "2026-09-14" });
  assert.equal(data.rolling.at(-1), 10);
  assert.equal(topMovers([dated, gemini], { start: "2026-09-01", end: "2026-09-14" }, "2026-09-15").available, true);
  const stale = { provider: "claude", repositoryId: "repo", createdAt: "2026-09-10T10:00:00Z", cost: { totalUsd: 2 }, evidence: { source: "conductor-messages" } } as unknown as SessionAnalytics;
  const blocked = buildVelocity([dated, stale], { start: "2026-09-01", end: "2026-09-14" });
  assert.equal(blocked.missingSessions, 1, "Conductor message recovery writes a ledger, so its absence means a stale snapshot");
  assert.equal(blocked.rolling.at(-1), null);
});

test("a whole window becomes one comparison period, covered only inside observed history", () => {
  const session = ledger(every("2026-09-05", "2026-09-14", () => 10));
  const current = periodFromVelocity(buildVelocity([session], { start: "2026-09-08", end: "2026-09-14" }));
  const prior = periodFromVelocity(buildVelocity([session], { start: "2026-09-01", end: "2026-09-07" }));
  assert.deepEqual([current.days, current.coveredDays, current.covered, current.value, current.calls], [7, 7, true, 70, 28]);
  assert.deepEqual([prior.coveredDays, prior.covered, prior.value], [3, false, 30]);
  assert.equal(comparePeriods(current, prior, "value").reason, "Prior period is only partly observed");
});

test("card text covers every comparison status and uses shared date ranges to agree across views", async () => {
  const { comparisonLabels, comparisonValue, span } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
  assert.equal(comparisonValue({ status: "change", delta: 1.13 }), "▲ 113.0%");
  assert.equal(comparisonValue({ status: "change", delta: -0.125 }), "▼ 12.5%");
  assert.equal(comparisonValue({ status: "change", delta: 0.0001 }), "▬ 0.0%");
  assert.equal(comparisonValue({ status: "new", delta: null }), "new");
  assert.equal(comparisonValue({ status: "idle", delta: null }), "No activity");
  assert.equal(comparisonValue({ status: "unavailable", delta: null }), null);
  assert.equal(span({ start: "2026-10-05", end: "2026-10-07" }), "5 Oct – 7 Oct 2026");
  assert.equal(span({ start: "2026-09-28", end: "2026-10-04" }), "28 Sept – 4 Oct 2026");
  assert.equal(span({ start: "2026-10-05", end: "2026-10-05" }), "5 Oct 2026");
  const session = ledger(every("2026-07-01", "2026-10-08", () => 10));
  assert.deepEqual(comparisonLabels(indicators([session], "2026-10-08"), "2026-10-08"), { week: "Week to date (Mon–Wed) vs same days last week", month: "Month to date vs prior" });
  assert.deepEqual(comparisonLabels(indicators([session], "2026-10-05"), "2026-10-05"), { week: "Last week vs week before", month: "Month to date vs prior" });
  assert.deepEqual(comparisonLabels(indicators([session], "2026-10-01"), "2026-10-01"), { week: "Week to date (Mon–Wed) vs same days last week", month: "Last month vs month before" });
  assert.deepEqual(comparisonLabels(indicators([session], "2026-10-08", "2026-10-05"), "2026-10-08"), { week: "Week through 5 Oct 2026 (Mon) vs same days prior week", month: "Month through 5 Oct 2026 vs prior" });
  // A Sunday names the whole week; the label never reads like a rolling "last 7 days" comparison.
  assert.match(comparisonLabels(indicators([session], "2026-10-08", "2026-10-04"), "2026-10-08").week, /^Week through 4 Oct 2026 \(Mon–Sun\) vs same days prior week$/);
});


test("burn and projection explanations name the failed guard with its figures", () => {
  const full = ledger(every("2026-08-01", "2026-10-20", () => 10));
  const partial = indicators([ledger(every("2026-08-01", "2026-10-20", () => 10), { priced: 0.973 })], "2026-10-20");
  assert.equal(partial.projection, null);
  assert.match(partial.projectionReason!, /Pricing coverage completed month: 97\.3%; 100% needed/);
  assert.match(partial.burn.reason!, /Pricing coverage 14-day baseline: 97\.3%; 100% needed/);
  assert.doesNotMatch(partial.projectionReason!, /at least 7|at least 3/);
  const todayOnly = ledger([["2026-10-20", 10]], { priced: 0 });
  assert.match(indicators([full, todayOnly], "2026-10-20").projectionReason!, /Pricing coverage this month/);
  assert.match(indicators([full, todayOnly], "2026-10-20").burn.reason!, /Pricing coverage today/);
  assert.match(indicators([ledger(every("2026-10-01", "2026-10-05", () => 10))], "2026-10-05").projectionReason!, /4 completed sample days; at least 7 needed/);
  const inactive = ledger([["2026-09-01", 10], ["2026-10-10", 10], ["2026-10-19", 10]]);
  assert.match(indicators([inactive], "2026-10-20").projectionReason!, /2 active sample days; at least 3 needed/);
  assert.match(indicators([inactive], "2026-10-20").burn.reason!, /2 active days; at least 3 needed/);
  const tiny = ledger(every("2026-08-01", "2026-10-20", () => 0.00001));
  assert.match(indicators([tiny], "2026-10-20").projectionReason!, /Baseline is .* USD; at least 0\.01 USD needed/);
  assert.match(indicators([tiny], "2026-10-20").burn.reason!, /Baseline is .* USD; at least 0\.01 USD needed/);
  const clipped = velocityIndicators(buildVelocity([full], { start: "2026-10-10", end: "2026-10-20" }), "2026-10-20");
  assert.match(clipped.projectionReason!, /10\/19 calendar days observed/);
  assert.match(clipped.burn.reason!, /10\/14 calendar days observed/);
  assert.match(indicators([full], "2026-10-20", "2026-09-30").projectionReason!, /0 days left to project/);
  assert.match(indicators([full], "2026-10-20", "2026-10-19").burn.reason!, /Today .* outside the window/);
  assert.equal(indicators([full], "2026-10-20").projectionReason, null);
  assert.equal(indicators([full], "2026-10-20").burn.reason, null);
});
