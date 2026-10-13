import assert from "node:assert/strict";
import test from "node:test";

import type { LimitObservation } from "../src/limits/types.ts";

const data: typeof import("../src/public/subscription-data.js") = await import(new URL("../src/public/subscription-data.js", import.meta.url).href);
const { DAY, HOUR, buildMeters, calibrate, economics, hourlyValue, liveMeter, providerUtilization, recommendations, resetHistory, sessionWindows } = data;

const start = Date.parse("2026-10-05T00:00:00Z") / 1000;
const week = 7 * DAY;

function reading(provider: "claude" | "codex", meter: string, resetsAt: number, observedAt: number, usedPercent: number, status: LimitObservation["status"] = "allowed"): LimitObservation {
  return { provider, meter, windowMinutes: meter === "five_hour" ? 300 : 10_080, resetsAt, observedAt, usedPercent, status, source: provider === "codex" ? "codex-session" : "claude-sdk-log" };
}

/** A session whose activity ledger spends `perHour` dollars in each UTC hour of [from, to). */
function spending(provider: string, from: number, to: number, perHour: number) {
  const buckets: Array<[string, number, number, number[]]> = [];
  for (let hour = from; hour < to; hour += HOUR) {
    const date = new Date(hour * 1000);
    buckets.push([date.toISOString().slice(0, 10), date.getUTCHours(), 0, [perHour, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
  }
  return { provider, velocity: { version: 1, dimensions: [], buckets, undated: [] } };
}

test("cycles end at the next cycle's first reading; an early provider reset is not counted as waste", () => {
  const firstReset = start + week, secondReset = start + DAY + week;
  const meters = buildMeters([
    reading("codex", "seven_day", firstReset, start + HOUR, 5),
    reading("codex", "seven_day", firstReset, start + 20 * HOUR, 14),
    reading("codex", "seven_day", secondReset, start + DAY + 60, 0),
  ], start + 2 * DAY);
  const cycles = meters[0]!.cycles;
  assert.equal(cycles[0]!.end, start + DAY + 60);
  assert.equal(cycles[0]!.endedEarly, true);
  assert.equal(cycles[0]!.closed, true);
  assert.equal(cycles[1]!.closed, false);
  const history = resetHistory(meters[0]!, 5);
  assert.deepEqual([history[0]!.peak, history[0]!.expired, history[0]!.expiredUsd], [14, null, null]);
});

test("live pace projects the reset level and the moment the cap is reached", () => {
  const resetsAt = start + week;
  // 40% used two days into a seven-day window: 20%/day projects 140% and runs out at day 5.
  const meters = buildMeters([reading("claude", "seven_day", resetsAt, start + HOUR, 1), reading("claude", "seven_day", resetsAt, start + 2 * DAY, 40)], start + 2 * DAY);
  const live = liveMeter(meters[0]!, start + 2 * DAY);
  assert.equal(live.state, "active");
  assert.ok(Math.abs(live.projected! - 140) < 1e-9);
  assert.ok(Math.abs(live.capAt! - (start + 5 * DAY)) < 1);
  assert.equal(live.capsEarly, true);
  assert.ok(Math.abs(live.paceDelta! - (40 - 200 / 7)) < 1e-9);
  assert.ok(Math.abs(live.dailyBudget! - 12) < 1e-9);
});

test("a meter the provider stopped reporting is unreported rather than still capped", () => {
  const resetsAt = start + week;
  const meters = buildMeters([
    reading("claude", "seven_day_overage_included", resetsAt, start + DAY, 100, "rejected"),
    reading("claude", "seven_day", resetsAt, start + 2 * DAY, 60),
  ], start + 2 * DAY);
  const overage = meters.find((meter) => meter.meter === "seven_day_overage_included")!;
  assert.equal(liveMeter(overage, start + 2 * DAY).state, "capped");
  assert.equal(liveMeter(overage, start + 2 * DAY, start + 2 * DAY).state, "unreported");
});

test("value per percent is calibrated from the activity ledger inside each cycle", () => {
  const resetsAt = start + week;
  const meters = buildMeters([reading("claude", "seven_day", resetsAt, start + 2 * DAY, 20)], start + 3 * DAY);
  // $10 an hour for the first 48 hours = $480 for 20% → $24 per percent, $2,400 a week.
  const value = hourlyValue([spending("claude", start, start + 4 * DAY, 10), spending("codex", start, start + 2 * DAY, 99)], "claude", "UTC");
  assert.equal(value.between(start + HOUR / 2, start + HOUR), 5, "partial hours count in proportion");
  const calibration = calibrate(meters[0]!, value);
  assert.equal(calibration.cycles, 1);
  assert.equal(calibration.perPercent, 24);
  const money = economics({ provider: "claude", planId: "max-20x", perPercent: calibration.perPercent, extracted: 1200, days: 7 });
  assert.equal(money.weeklyCapacity, 2400);
  assert.equal(money.utilization, 0.5);
  assert.equal(money.leftOnTable, 1200);
  assert.ok(Math.abs(money.multiple! - 1200 / (200 * 7 / 30.4375)) < 1e-9);
  assert.equal(economics({ provider: "claude", planId: "unknown", perPercent: null, extracted: 5, days: 7 }).multiple, null);
});

test("closed cycles report expired allowance; a reading long before the reset is a lower bound", () => {
  const meters = buildMeters([
    reading("claude", "seven_day", start + week, start + week - HOUR / 2, 70),
    reading("claude", "seven_day", start + 2 * week, start + week + 2 * DAY, 30),
  ], start + 3 * week);
  const history = resetHistory(meters[0]!, 10);
  assert.deepEqual(history.map((cycle) => [cycle.peak, cycle.expired, cycle.expiredUsd, cycle.lowerBound]), [[70, 30, 300, false], [30, 70, 700, true]]);
});

test("5-hour windows count lockouts from the first capped reading to the reset", () => {
  const now = start + 2 * DAY;
  const first = start + DAY + 5 * HOUR;
  const meters = buildMeters([
    reading("claude", "five_hour", first, first - 4 * HOUR, 30),
    reading("claude", "five_hour", first, first - 2 * HOUR, 100, "rejected"),
    reading("claude", "five_hour", first + 10 * HOUR, first + 6 * HOUR, 50),
  ], now);
  const windows = sessionWindows(meters[0]!, now);
  assert.equal(windows.windows.length, 2);
  assert.equal(windows.capped, 1);
  assert.equal(windows.lockedSeconds, 2 * HOUR);
});

test("recommendations flag a capacity-bound week and expiring allowance with its value", () => {
  const now = start + 2 * DAY;
  const fast = buildMeters([
    reading("claude", "seven_day", start + week, start + HOUR, 5), reading("claude", "seven_day", start + week, now, 80),
    reading("codex", "seven_day", start + week, start + HOUR, 5), reading("codex", "seven_day", start + week, now, 90),
  ], now);
  const items = (["claude", "codex"] as const).map((provider) => providerUtilization({ provider, meters: fast, sessions: [], timeZone: "UTC", now, planId: null, extracted: 0, days: 7 }));
  const advice = recommendations(items, { now });
  assert.match(advice[0]!.title, /capacity-bound/);
  assert.equal(advice.filter((item) => item.tone === "act").length, 3);

  const slow = buildMeters([reading("codex", "seven_day", start + week, start + HOUR, 1), reading("codex", "seven_day", start + week, now, 10)], now);
  const codex = providerUtilization({ provider: "codex", meters: slow, sessions: [spending("codex", start, now, 5)], timeZone: "UTC", now, planId: "pro", extracted: 240, days: 7 });
  const expiring = recommendations([codex], { now, sources: [{ source: "claude-sdk-log", status: "empty", read: 0, latest: null }] });
  assert.equal(expiring[0]!.tone, "watch");
  assert.match(expiring[0]!.title, /will expire unused \(≈ \$/);
  assert.ok(expiring[0]!.impactUsd! > 0);
  assert.equal(expiring.some((item) => item.tone === "setup"), true, "missing Claude meters ask for setup");
});

test("banked resets: redeem near the cap with days left, hold while on course to cap, warn before expiry", () => {
  const { bankedResets: banked } = data;
  const resetsAt = start + week;
  const credit = (expiresAt: number | null) => ({ observedAt: start, credits: null, ordinaryUsageAllowed: true, resetCredits: { available: 1, credits: [{ status: "available" as const, scope: "all" as const, grantedAt: start - DAY, expiresAt }] } });
  const spend = [spending("codex", start, start + 4 * DAY, 10)];
  const utilization = (used: number, at: number, expiresAt: number | null) => {
    const meters = buildMeters([reading("codex", "seven_day", resetsAt, start + HOUR, 1), reading("codex", "seven_day", resetsAt, at, used)], at);
    return providerUtilization({ provider: "codex", meters, sessions: spend, timeZone: "UTC", now: at, planId: "pro", extracted: 0, days: 7, account: credit(expiresAt) });
  };
  const nearCap = utilization(95, start + 2 * DAY, start + 20 * DAY);
  assert.equal(nearCap.resets.available, 1);
  assert.equal(nearCap.resets.nowValue(nearCap.resets.credits[0]!), 95 * nearCap.calibration.perPercent!);
  const redeem = recommendations([nearCap], { now: start + 2 * DAY });
  assert.match(redeem[0]!.title, /^Redeem a banked Codex reset now: it restores 95% of the week/);

  const heading = utilization(50, start + 2 * DAY, start + 20 * DAY);
  assert.ok(recommendations([heading], { now: start + 2 * DAY }).some((item) => /^Hold your banked Codex reset until the weekly meter nears 100%/.test(item.title)));

  const expiring = utilization(20, start + 3 * DAY, start + 3 * DAY + 10 * HOUR);
  const warning = recommendations([expiring], { now: start + 3 * DAY }).find((item) => /expires/.test(item.title));
  assert.equal(warning?.tone, "act");
  assert.equal(banked({ provider: "codex", account: credit(start), now: start + DAY }).available, 0, "expired credits are not counted");
  assert.equal(banked({ provider: "claude", account: { observedAt: start, extraUsage: "disabled", disabledReason: null }, now: start }).known, false, "Claude offers are not tracked");
});

test("an early reset is attributed to a redeemed credit when the banked count drops across it", () => {
  const firstReset = start + week, secondReset = start + DAY + week;
  const meters = buildMeters([
    reading("codex", "seven_day", firstReset, start + 20 * HOUR, 97),
    reading("codex", "seven_day", secondReset, start + DAY + 60, 0),
  ], start + 2 * DAY);
  const history = resetHistory(meters[0]!, 5, [["codex", start + 10 * HOUR, 2], ["codex", start + DAY + 300, 1]]);
  assert.deepEqual([history[0]!.cause, history[0]!.restored, history[0]!.restoredUsd], ["credit", 97, 485]);
  assert.equal(resetHistory(meters[0]!, 5, [])[0]!.cause, "unknown");
});
