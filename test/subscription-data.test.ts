import assert from "node:assert/strict";
import test from "node:test";

import type { LimitAccount, LimitObservation } from "../src/limits/types.ts";

const data: typeof import("../src/public/subscription-data.js") = await import(new URL("../src/public/subscription-data.js", import.meta.url).href);
const {
  DAY, HOUR, MONTH_DAYS, WEEK, accountUtilization, attributeSessions, bankedResets, buildMeters, calibrate, economics, formatDuration, hourlyValue, inPlaceResets,
  liveMeter, recommendations, resetHistory, resetUtilization, sessionWindows, subscriptionModel, subscriptionTotals, zonedDayStart,
} = data;

const start = Date.parse("2026-10-05T00:00:00Z") / 1000;
const at = (iso: string) => Date.parse(iso) / 1000;

function reading(provider: "claude" | "codex", meter: string, resetsAt: number, observedAt: number, usedPercent: number, status: LimitObservation["status"] = "allowed", account = ""): LimitObservation {
  return { provider, account, meter, windowMinutes: meter === "five_hour" ? 300 : 10_080, resetsAt, observedAt, usedPercent, status, source: provider === "codex" ? "codex-session" : "claude-sdk-log" };
}

function account(provider: "claude" | "codex", key: string, extra: Partial<LimitAccount> = {}): LimitAccount {
  return {
    key, provider, attribution: key === "" ? "unattributed" : key.includes("-w-") ? "weekly-phase" : "account", label: `${provider} ${key}`,
    profileNames: [], profileKeys: [], plan: null, planSource: null, planEvidence: null, extraUsage: null, codex: null, weeklyAnchor: null, lastSeen: null, ...extra,
  };
}

/** A session whose activity ledger spends `perHour` dollars in each UTC hour of [from, to). */
function spending(provider: string, from: number, to: number, perHour: number, profileKey?: string) {
  const buckets: Array<[string, number, number, number[]]> = [];
  for (let hour = from; hour < to; hour += HOUR) {
    const date = new Date(hour * 1000);
    buckets.push([date.toISOString().slice(0, 10), date.getUTCHours(), 0, [perHour, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
  }
  return { provider, velocity: { version: 1, dimensions: [], buckets, undated: [] }, ...(profileKey ? { historyProfile: { profileKey, days: [] } } : {}) };
}

const utilization = (owner: LimitAccount, observations: LimitObservation[], now: number, sessions: unknown[] = [], extra: Partial<Parameters<typeof accountUtilization>[0]> = {}) =>
  accountUtilization({ account: owner, meters: buildMeters(observations, now), sessions, timeZone: "UTC", now, range: { from: now - 30 * DAY, to: now }, ...extra });

test("cycles end at the next cycle's first reading; an early provider reset is not counted as waste", () => {
  const firstReset = start + WEEK, secondReset = start + DAY + WEEK;
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
  assert.deepEqual([history[0]!.peak, history[0]!.expired, history[0]!.expiredUsd, history[0]!.restored], [14, null, null, 14]);
});

test("readings of two accounts interleave without forming false early resets, and advice routes work to the account with room", () => {
  const max = "claude-aaaaaaaaaaaaaaaa", team = "claude-bbbbbbbbbbbbbbbb";
  // Max resets Mondays 10:00 UTC, the Team seat Fridays 03:00 UTC; readings alternate between them.
  const maxPrevious = at("2026-10-12T10:00:00Z"), maxCurrent = at("2026-10-19T10:00:00Z");
  const teamPrevious = at("2026-10-09T03:00:00Z"), teamCurrent = at("2026-10-16T03:00:00Z");
  const now = at("2026-10-14T12:00:00Z");
  const observations = [
    reading("claude", "seven_day", maxPrevious, at("2026-10-06T20:00:00Z"), 20, "allowed", max),
    reading("claude", "seven_day", teamPrevious, at("2026-10-08T12:00:00Z"), 70, "allowed", team),
    reading("claude", "seven_day", teamPrevious, at("2026-10-09T02:00:00Z"), 90, "allowed", team),
    reading("claude", "seven_day", teamCurrent, at("2026-10-09T05:00:00Z"), 5, "allowed", team),
    reading("claude", "seven_day", maxPrevious, at("2026-10-11T20:00:00Z"), 80, "allowed", max),
    reading("claude", "seven_day", maxPrevious, at("2026-10-12T09:00:00Z"), 85, "allowed", max),
    reading("claude", "seven_day", maxCurrent, at("2026-10-12T11:00:00Z"), 2, "allowed", max),
    reading("claude", "seven_day", teamCurrent, at("2026-10-12T12:00:00Z"), 50, "allowed", team),
    reading("claude", "seven_day", maxCurrent, at("2026-10-13T12:00:00Z"), 10, "allowed", max),
    reading("claude", "seven_day", teamCurrent, at("2026-10-14T11:00:00Z"), 87, "allowed", team),
    reading("claude", "seven_day", maxCurrent, at("2026-10-14T11:30:00Z"), 16, "allowed", max),
  ];
  const meters = buildMeters(observations, now);
  assert.deepEqual(meters.map((meter) => meter.account), [max, team]);
  assert.deepEqual(meters.flatMap((meter) => meter.cycles).filter((cycle) => cycle.endedEarly), [], "no account's cycle is cut by the other's readings");
  assert.deepEqual(meters.map((meter) => meter.cycles.find((cycle) => !cycle.closed)?.resetsAt), [maxCurrent, teamCurrent]);

  const accounts = [
    account("claude", max, { label: "Claude Max 20x · fluxary", plan: "max-20x", profileNames: ["fluxary"], profileKeys: ["profile-max"] }),
    account("claude", team, { label: "Claude Team · stage", plan: "team", profileNames: ["stage"], profileKeys: ["profile-team"] }),
  ];
  const sessions = [spending("claude", at("2026-10-05T10:00:00Z"), now, 50, "profile-max"), spending("claude", at("2026-10-02T03:00:00Z"), now, 5, "profile-team")];
  const model = subscriptionModel({ limits: { accounts, observations, meters: [], resetCreditHistory: [] }, sessions, timeZone: "UTC", now, range: { from: now - 30 * DAY, to: now } });
  const [maxItem, teamItem] = model.accounts;
  assert.equal(teamItem!.weekly!.used, 87);
  assert.equal(teamItem!.weekly!.capsEarly, true, "the Team seat runs out before Friday");
  assert.equal(maxItem!.weekly!.capsEarly, false);
  assert.equal(maxItem!.value.basis, "profiles");
  assert.notEqual(maxItem!.calibration.perPercent, teamItem!.calibration.perPercent, "each account calibrates on its own sessions");

  const advice = recommendations(model.accounts, { now });
  assert.equal(advice[0]!.tone, "act");
  assert.equal(advice[0]!.account, team);
  assert.match(advice[0]!.title, /^Claude Team seat runs out before its .* reset; Claude Max 20x is at 16%/);
  assert.match(advice[0]!.detail, /Point background agents and long-running work at the fluxary profile/);
  const expiring = advice.find((item) => /will expire unused/.test(item.title))!;
  assert.ok(expiring.impactUsd! > 1000, "a large dollar value…");
  assert.ok(advice.indexOf(expiring) > advice.findLastIndex((item) => item.tone === "act"), "…never outranks an act item");
});

test("an in-place reset starts a new segment: pace, projection and calibration use it, and the restored level is never waste", () => {
  const owner = account("claude", "claude-aaaaaaaaaaaaaaaa");
  const cycleStart = start, resetsAt = start + WEEK, drop = cycleStart + 2 * DAY + 15 * HOUR;
  const observations = [
    reading("claude", "seven_day", resetsAt, cycleStart + DAY, 30, "allowed", owner.key),
    reading("claude", "seven_day", resetsAt, cycleStart + 2 * DAY, 85, "allowed", owner.key),
    reading("claude", "seven_day", resetsAt, drop, 90, "allowed", owner.key),
    reading("claude", "seven_day", resetsAt, drop + HOUR, 2, "allowed", owner.key),
    reading("claude", "seven_day", resetsAt, drop + 5 * HOUR, 6, "allowed", owner.key),
    reading("claude", "seven_day", resetsAt, cycleStart + 4 * DAY - HOUR, 35, "allowed", owner.key),
  ];
  const now = cycleStart + 4 * DAY;
  const [meter] = buildMeters(observations, now);
  const cycle = meter!.cycles[0]!;
  assert.equal(meter!.cycles.length, 1);
  assert.deepEqual(cycle.segments.map((segment) => [segment.start, segment.peak]), [[cycleStart, 90], [drop + HOUR / 2, 35]]);
  const live = liveMeter(meter!, now);
  assert.equal(live.used, 35);
  // 35% in the 32.5 hours since the reset runs out before the reset; averaged from the cycle start it would close near 53%.
  assert.ok(Math.abs(live.rate! - 35 / (now - drop - HOUR / 2)) < 1e-12);
  assert.equal(live.capsEarly, true);
  assert.ok(live.capAt! > now && live.capAt! < resetsAt);
  assert.deepEqual(inPlaceResets(meter!, cycle, 10).map((reset) => [reset.at, reset.restored, reset.restoredUsd]), [[drop + HOUR / 2, 90, 900]], "the live cycle's reset is listed too");

  const value = hourlyValue([spending("claude", cycleStart, now, 10)], "UTC");
  const calibration = calibrate(meter!, value);
  assert.deepEqual(calibration.points.map((point) => [point.start, point.used]), [[cycleStart, 90], [drop + HOUR / 2, 35]]);

  const closed = buildMeters([...observations, reading("claude", "seven_day", resetsAt, resetsAt - HOUR / 2, 80, "allowed", owner.key)], resetsAt + HOUR)[0]!;
  const [history] = resetHistory(closed, 10);
  assert.deepEqual([history!.peak, history!.expired, history!.lowerBound], [80, 20, false], "the close is the latest segment's");
  assert.deepEqual(history!.inPlace.map((reset) => [reset.restored, reset.restoredUsd, reset.cause]), [[90, 900, "provider"]]);

  const blip = buildMeters([
    reading("claude", "seven_day", resetsAt, cycleStart + DAY, 30), reading("claude", "seven_day", resetsAt, cycleStart + DAY + HOUR, 22),
    reading("claude", "seven_day", resetsAt, cycleStart + DAY + 2 * HOUR, 31),
  ], now)[0]!;
  assert.equal(blip.cycles[0]!.segments.length, 1, "a low reading the next one contradicts is not a reset");
});

test("live pace runs through now and projects only with evidence", () => {
  const resetsAt = start + WEEK;
  // 40% two days into a seven-day window: 20%/day projects 140% and runs out at day 5.
  const meters = buildMeters([reading("claude", "seven_day", resetsAt, start + HOUR, 1), reading("claude", "seven_day", resetsAt, start + 2 * DAY, 40)], start + 2 * DAY);
  const live = liveMeter(meters[0]!, start + 2 * DAY);
  assert.equal(live.state, "active");
  assert.ok(Math.abs(live.projected! - 140) < 1e-9);
  assert.ok(Math.abs(live.capAt! - (start + 5 * DAY)) < 1);
  assert.equal(live.capsEarly, true);
  assert.ok(Math.abs(live.dailyBudget! - 12) < 1e-9);

  // A burst at the start of a week is not extrapolated, however high: no 10% shortcut.
  for (const [minutes, used] of [[40, 9], [40, 11], [170, 28]] as const) {
    const now = start + minutes * 60;
    const early = buildMeters([reading("codex", "seven_day", resetsAt, start + 300, 1), reading("codex", "seven_day", resetsAt, now, used)], now)[0]!;
    const state = liveMeter(early, now);
    assert.deepEqual([state.projected, state.capAt, state.capsEarly, state.tooEarly], [null, null, false, true], `${used}% at ${minutes} minutes`);
    const owner = account("codex", "codex-aaaaaaaaaaaaaaaa");
    const item = utilization(owner, [reading("codex", "seven_day", resetsAt, start + 300, 1, "allowed", owner.key), reading("codex", "seven_day", resetsAt, now, used, "allowed", owner.key)], now);
    assert.equal(recommendations([item], { now }).filter((entry) => entry.tone === "act").length, 0);
  }
  // A 5-hour window projects once a tenth of it (30 minutes) has passed.
  const windowEnd = start + 5 * HOUR, now = start + 45 * 60;
  const session = buildMeters([reading("claude", "five_hour", windowEnd, start + 600, 5), reading("claude", "five_hour", windowEnd, start + 40 * 60, 20)], now)[0]!;
  const sessionState = liveMeter(session, now);
  assert.equal(sessionState.tooEarly, false);
  assert.ok(Math.abs(sessionState.capAt! - (now + 3 * HOUR)) < 1);
});

test("a stale meter gets no projection and never a run-out in the past", () => {
  const resetsAt = start + WEEK;
  const observations = [reading("codex", "seven_day", resetsAt, start + HOUR, 5), reading("codex", "seven_day", resetsAt, start + 20 * HOUR, 55)];
  const fresh = liveMeter(buildMeters(observations, start + 21 * HOUR)[0]!, start + 21 * HOUR);
  assert.equal(fresh.stale, false);
  assert.ok(fresh.capAt! > start + 21 * HOUR, "the run-out is measured from now");
  for (const hours of [40, 60, 80]) {
    const now = start + hours * HOUR;
    const live = liveMeter(buildMeters(observations, now)[0]!, now);
    assert.deepEqual([live.stale, live.projected, live.capAt, live.capsEarly], [true, null, null, false], `${hours}h`);
    assert.equal(live.mayBeUsedUp, true, "the pace before the last reading would have used it up");
    const owner = account("codex", "codex-aaaaaaaaaaaaaaaa");
    const item = utilization(owner, observations.map((row) => ({ ...row, account: owner.key })), now);
    const advice = recommendations([item], { now, formatTime: (seconds) => String(seconds) });
    assert.equal(advice[0]!.title, "Codex weekly allowance may already be used up".replace("Codex", owner.label));
    assert.ok(advice.every((entry) => !/-\d/.test(entry.title + entry.detail) && !/runs out/.test(entry.title)));
  }
  assert.equal(formatDuration(-3000), "0m");
});

test("lower-bound cycles are unknown closes: left out of unused allowance, resets used and plan fit", () => {
  const owner = account("codex", "codex-aaaaaaaaaaaaaaaa", { plan: "pro" });
  const resets = [start + WEEK, start + 2 * WEEK, start + 3 * WEEK], peaks = [20, 30, 25];
  const now = start + 3 * WEEK + DAY;
  const closes = (gap: number) => resets.map((resetsAt, index) => reading("codex", "seven_day", resetsAt, resetsAt - gap, peaks[index]!, "allowed", owner.key));

  const unobserved = utilization(owner, closes(3 * DAY), now);
  assert.deepEqual(unobserved.history.map((cycle) => [cycle.lowerBound, cycle.expired]), [[true, null], [true, null], [true, null]]);
  assert.equal(unobserved.utilization, null);
  assert.equal(resetUtilization(unobserved.history, null), null);
  const advice = recommendations([unobserved], { now });
  assert.ok(!advice.some((item) => /unused|averaged/.test(item.title)), JSON.stringify(advice.map((item) => item.title)));
  assert.ok(advice.some((item) => item.tone === "setup" && /closing level of 3 weekly resets was not observed/.test(item.title)));

  const observed = utilization(owner, closes(HOUR / 2), now);
  assert.equal(observed.utilization!.mean, 25);
  const titles = recommendations([observed], { now }).map((item) => item.title);
  assert.ok(titles.some((title) => /left an average of 75% unused/.test(title)));
  assert.ok(titles.some((title) => /weekly resets averaged 25%/.test(title)));
});

test("value per percent is calibrated per account from the activity ledger inside each cycle", () => {
  const meters = buildMeters([
    reading("claude", "seven_day", start + WEEK, start + 2 * DAY, 20),
    reading("claude", "seven_day", start + 2 * WEEK, start + WEEK + 2 * DAY, 40),
  ], start + WEEK + 3 * DAY);
  // $10 an hour: $480 for 20% and $480 for 40% → $24 and $12 per percent, median $18.
  const value = hourlyValue([spending("claude", start, start + 2 * WEEK, 10)], "UTC");
  assert.equal(value.between(start + HOUR / 2, start + HOUR), 5, "partial hours count in proportion");
  const calibration = calibrate(meters[0]!, value);
  assert.deepEqual([calibration.cycles, calibration.perPercent, calibration.low, calibration.high], [2, 18, 12, 24]);
  const money = economics({ provider: "claude", planId: "max-20x", perPercent: calibration.perPercent, extracted: 900, days: 7 });
  assert.equal(money.weeklyCapacity, 1800);
  assert.equal(money.utilization, 0.5);
  assert.ok(Math.abs(money.multiple! - 900 / (200 * 7 / MONTH_DAYS)) < 1e-9);
  assert.equal(economics({ provider: "claude", planId: "unknown", perPercent: null, extracted: 5, days: 7 }).multiple, null);
  assert.equal(calibrate(buildMeters([reading("claude", "seven_day", start + WEEK, start + 2 * DAY, 20)], start + 3 * DAY)[0]!, value).perPercent, null, "one cycle is not enough history");
});

test("calibration drops cycles whose local value explains almost none of the meter, and stops at the cap", () => {
  const cycles = [start + WEEK, start + 2 * WEEK, start + 3 * WEEK];
  const observations = cycles.map((resetsAt) => reading("codex", "seven_day", resetsAt, resetsAt - HOUR, 50));
  const value = hourlyValue([spending("codex", start, start + 2 * WEEK, 5), spending("codex", start + 2 * WEEK, start + 3 * WEEK, 0.01)], "UTC");
  const calibration = calibrate(buildMeters(observations, start + 4 * WEEK)[0]!, value);
  assert.deepEqual([calibration.cycles, calibration.excluded], [2, 1], "another machine moved the third week's meter");
  assert.ok(Math.abs(calibration.perPercent! - 167 * 5 / 50) < 1e-9);
  const lone = calibrate(buildMeters([observations[0]!, observations[2]!], start + 4 * WEEK)[0]!, value);
  assert.deepEqual([lone.perPercent, lone.cycles, lone.excluded], [null, 1, 1], "not enough history once the outlier is gone");

  const resetsAt = start + WEEK;
  const capped = buildMeters([
    reading("codex", "seven_day", resetsAt, start + 2 * DAY, 50),
    reading("codex", "seven_day", resetsAt, start + 4 * DAY, 100, "rejected"),
    reading("codex", "seven_day", resetsAt, start + 6 * DAY, 100, "rejected"),
  ], start + WEEK)[0]!;
  const spend = hourlyValue([spending("codex", start, start + WEEK, 10)], "UTC");
  assert.deepEqual(calibrate(capped, spend).points.map((point) => [point.at, point.perPercent]), [[start + 4 * DAY, 9.6]], "credits spent after the cap did not move the meter");
  const overage = buildMeters([
    reading("claude", "seven_day", resetsAt, start + 4 * DAY, 100, "rejected"), reading("claude", "seven_day", resetsAt, start + 6 * DAY, 130, "overage"),
  ], start + WEEK)[0]!;
  assert.deepEqual(calibrate(overage, spend).points.map((point) => point.at), [start + 6 * DAY], "a meter that keeps counting past 100% keeps its last reading");
});

test("hero ratios compare like with like and prorate only the time since the first reading", () => {
  const claude = account("claude", "claude-aaaaaaaaaaaaaaaa", { profileKeys: ["profile-a"] });
  const codex = account("codex", "codex-aaaaaaaaaaaaaaaa", { plan: "pro" });
  const team = account("claude", "claude-bbbbbbbbbbbbbbbb", { plan: "team", profileKeys: ["profile-b"] });
  const now = start + 7 * DAY, first = start + HOUR;
  const observations = [
    ...[claude, team, codex].map((owner) => reading(owner.provider, "seven_day", start + WEEK + DAY, first, 5, "allowed", owner.key)),
    ...[claude, team, codex].map((owner) => reading(owner.provider, "seven_day", start + WEEK + DAY, now - HOUR, 60, "allowed", owner.key)),
  ];
  const sessions = [spending("claude", start - 10 * DAY, now, 20, "profile-a"), spending("claude", start, now, 7, "profile-b"), spending("codex", start - 10 * DAY, now, 5)];
  const model = subscriptionModel({ limits: { accounts: [claude, team, codex], observations, meters: [], resetCreditHistory: [] }, sessions, timeZone: "UTC", now, range: { from: start - 30 * DAY, to: now + 10 * HOUR } });
  const [claudeItem, teamItem, codexItem] = model.accounts;
  assert.deepEqual([codexItem!.period.from, codexItem!.period.to], [first, now], "no days before the meters and no rest of today");
  assert.ok(Math.abs(codexItem!.economics.extracted! - 5 * (now - first) / HOUR) < 1e-6);
  assert.equal(codexItem!.value.basis, "provider");
  const { totals } = model;
  assert.equal(totals.priced.accounts, 1);
  assert.ok(Math.abs(totals.priced.multiple! - codexItem!.economics.multiple!) < 1e-12, "only the priced account's value is divided by its price");
  assert.ok(totals.priced.multiple! < totals.extracted / totals.priced.price);
  assert.ok(Math.abs(totals.unpriced.extracted - claudeItem!.economics.extracted!) < 1e-9);
  assert.ok(Math.abs(totals.organization.extracted - teamItem!.economics.extracted!) < 1e-9);
  assert.equal(subscriptionTotals(model.accounts.map((item) => item === codexItem ? { ...item, excluded: true } : item)).priced.multiple, null, "an excluded account leaves no price behind");

  // With other machines combined, Codex sessions cannot be matched to the local account: its value is unknown, and so is its multiple.
  const combined = subscriptionModel({ limits: { accounts: [claude, team, codex], observations, meters: [], resetCreditHistory: [] }, sessions, timeZone: "UTC", now, range: { from: start, to: now }, local: () => false });
  const remoteCodex = combined.accounts[2]!;
  assert.deepEqual([remoteCodex.value.basis, remoteCodex.economics.extracted, remoteCodex.economics.multiple, remoteCodex.calibration.perPercent], ["none", null, null, null]);
  assert.deepEqual([combined.totals.priced.accounts, combined.totals.priced.multiple], [0, null]);
  assert.ok(Math.abs(combined.totals.unattributed - 5 * 7 * 24) < 1e-6, "the unmatched value is reported, not dropped");
  assert.equal(combined.accounts[0]!.value.basis, "profiles", "Claude sessions still join through this machine's profiles");
});

test("Team and Enterprise seats are paid by the organization: API value without a personal multiple", () => {
  for (const planId of ["team", "team-premium", "enterprise"]) {
    const money = economics({ provider: "claude", planId, perPercent: 10, extracted: 500, days: 7 });
    assert.deepEqual([money.payer, money.price, money.multiple, money.weeklyCapacity], ["organization", null, null, 1000], planId);
  }
  const paidByYou = economics({ provider: "claude", planId: "team-premium", payer: "individual", perPercent: 10, extracted: 500, days: 7 });
  assert.ok(Math.abs(paidByYou.price! - 125 * 7 / MONTH_DAYS) < 1e-9, "a seat you pay for yourself is priced");
  // Three observed weeks at 20% would suggest a lower tier on a personal plan, but an employer's seat is not yours to change.
  const owner = account("claude", "claude-bbbbbbbbbbbbbbbb", { plan: "team" });
  const closes = [1, 2, 3].map((week) => reading("claude", "seven_day", start + week * WEEK, start + week * WEEK - HOUR / 2, 20, "allowed", owner.key));
  const now = start + 3 * WEEK + DAY;
  const titles = (plan: string) => recommendations([utilization({ ...owner, plan: plan as LimitAccount["plan"] }, closes, now)], { now }).map((entry) => entry.title);
  assert.ok(titles("max-20x").some((title) => /averaged 20%/.test(title)));
  assert.ok(!titles("team").some((title) => /averaged/.test(title)));
});

test("sessions join accounts by profile key; other machines' sessions never calibrate a local account", () => {
  const accounts = [
    account("claude", "claude-aaaaaaaaaaaaaaaa", { profileKeys: ["profile-a"] }), account("claude", "claude-bbbbbbbbbbbbbbbb", { profileKeys: ["profile-b"] }),
    account("claude", "claude-w-100"), account("codex", "codex-aaaaaaaaaaaaaaaa", { profileKeys: ["profile-codex"] }), account("codex", ""),
  ];
  const sessions = [
    { provider: "claude", historyProfile: { profileKey: "profile-a" } }, { provider: "claude", historyProfile: { profileKey: "profile-b" } },
    { provider: "claude" }, { provider: "claude", historyProfile: { profileKey: "profile-remote" } }, { provider: "codex" }, { provider: "codex" }, { provider: "cursor" },
  ];
  const local = attributeSessions(sessions, accounts);
  assert.deepEqual([...local.byAccount].map(([key, list]) => [key, list.length]), [
    ["claude-aaaaaaaaaaaaaaaa", 1], ["claude-bbbbbbbbbbbbbbbb", 1], ["claude-w-100", 0], ["codex-aaaaaaaaaaaaaaaa", 2], ["", 0],
  ]);
  assert.deepEqual([local.unattributed.claude.length, local.unattributed.codex.length], [2, 0], "two Claude accounts: a session without a profile is not guessed");
  const combined = attributeSessions(sessions, accounts, { local: () => false });
  assert.deepEqual([combined.byAccount.get("codex-aaaaaaaaaaaaaaaa")!.length, combined.unattributed.codex.length], [0, 2], "with other machines combined, Codex sessions cannot be told apart");
  const single = attributeSessions(sessions, [accounts[0]!]);
  assert.equal(single.byAccount.get("claude-aaaaaaaaaaaaaaaa")!.length, 2, "the only Claude account takes this machine's sessions without a profile");
});

test("hourly value follows the zone: the daylight-saving fall-back hour is counted once and half-hour offsets line up", () => {
  const cell = (day: string, hour: number, value: number) => ({ provider: "claude", velocity: { version: 1, dimensions: [], buckets: [[day, hour, 0, [value, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]], undated: [] } });
  const london = hourlyValue([cell("2026-10-25", 1, 10)], "Europe/London");
  // 01:00 local happens twice on 25 October: 00:00-01:00 UTC (BST) and 01:00-02:00 UTC (GMT).
  assert.ok(Math.abs(london.between(at("2026-10-24T12:00:00Z"), at("2026-10-25T12:00:00Z")) - 10) < 1e-9);
  assert.ok(Math.abs(london.between(at("2026-10-25T00:00:00Z"), at("2026-10-25T01:00:00Z")) - 5) < 1e-9);
  const kolkata = hourlyValue([cell("2026-10-14", 5, 10)], "Asia/Kolkata");
  assert.ok(Math.abs(kolkata.between(at("2026-10-13T23:30:00Z"), at("2026-10-14T00:30:00Z")) - 10) < 1e-9);
  assert.ok(Math.abs(kolkata.between(at("2026-10-14T00:00:00Z"), at("2026-10-14T00:30:00Z")) - 5) < 1e-9);
  assert.equal(zonedDayStart("2026-10-14", "Europe/London"), at("2026-10-13T23:00:00Z"));
  assert.equal(zonedDayStart("2026-10-26", "Europe/London"), at("2026-10-26T00:00:00Z"));
  assert.equal(zonedDayStart("2026-10-14", "Asia/Kolkata"), at("2026-10-13T18:30:00Z"));
});

test("readings without an account show levels only: no pace, value or advice", () => {
  const owner = account("claude", "claude-w-100");
  const now = start + 2 * DAY;
  const item = utilization(owner, [reading("claude", "seven_day", start + WEEK, start + HOUR, 5, "allowed", owner.key), reading("claude", "seven_day", start + WEEK, now, 90, "allowed", owner.key)], now, [spending("claude", start, now, 10)]);
  assert.deepEqual([item.identified, item.weekly!.used, item.weekly!.projected, item.calibration.perPercent, item.economics.extracted], [false, 90, null, null, null]);
  assert.deepEqual(recommendations([item], { now, sources: [{ source: "claude-sdk-log", status: "ok", read: 1, latest: now }] }), []);
});

test("5-hour windows count lockouts from the first capped reading to the reset; overage is not a lockout", () => {
  const now = start + 2 * DAY;
  const first = start + DAY + 5 * HOUR;
  const meters = buildMeters([
    reading("claude", "five_hour", first, first - 4 * HOUR, 30),
    reading("claude", "five_hour", first, first - 2 * HOUR, 100, "rejected"),
    reading("claude", "five_hour", first + 10 * HOUR, first + 6 * HOUR, 50),
    reading("claude", "five_hour", first + 20 * HOUR, first + 16 * HOUR, 104, "overage"),
  ], now);
  const windows = sessionWindows(meters[0]!, now);
  assert.equal(windows.windows.length, 3);
  assert.equal(windows.capped, 1);
  assert.equal(windows.lockedSeconds, 2 * HOUR);
  assert.equal(liveMeter(meters[0]!, first + 16 * HOUR).state, "overage");
});

test("recommendations flag a capacity-bound week and expiring allowance with its value", () => {
  const now = start + 2 * DAY;
  const claude = account("claude", "claude-aaaaaaaaaaaaaaaa"), codex = account("codex", "codex-aaaaaaaaaaaaaaaa");
  const fast = (owner: LimitAccount, used: number) => utilization(owner, [reading(owner.provider, "seven_day", start + WEEK, start + HOUR, 5, "allowed", owner.key), reading(owner.provider, "seven_day", start + WEEK, now, used, "allowed", owner.key)], now);
  const advice = recommendations([fast(claude, 80), fast(codex, 90)], { now });
  assert.match(advice[0]!.title, /capacity-bound/);
  assert.equal(advice.filter((item) => item.tone === "act").length, 3);

  const slow = utilization(codex, [
    reading("codex", "seven_day", start, start - 2 * DAY, 30, "allowed", codex.key),
    reading("codex", "seven_day", start + WEEK, start + HOUR, 1, "allowed", codex.key), reading("codex", "seven_day", start + WEEK, now, 10, "allowed", codex.key),
  ], now, [spending("codex", start - WEEK, now, 5)], { planId: "pro" });
  const expiring = recommendations([slow], { now, sources: [{ source: "claude-sdk-log", status: "empty", read: 0, latest: null }] });
  assert.equal(expiring[0]!.tone, "watch");
  assert.match(expiring[0]!.title, /will expire unused \(≈ \$/);
  assert.ok(expiring[0]!.impactUsd! > 0);
  assert.equal(expiring.some((item) => item.tone === "setup"), true, "missing Claude meters ask for setup");
});

test("banked resets: redeem near the cap with days left, hold while on course to cap, warn before expiry", () => {
  const resetsAt = start + WEEK;
  const credit = (expiresAt: number | null) => ({ observedAt: start, credits: null, ordinaryUsageAllowed: true, resetCredits: { available: 1, credits: [{ status: "available" as const, scope: "all" as const, grantedAt: start - DAY, expiresAt }] } });
  const spend = [spending("codex", start - WEEK, start + 4 * DAY, 10)];
  const item = (used: number, now: number, expiresAt: number | null) => {
    const owner = account("codex", "codex-aaaaaaaaaaaaaaaa", { label: "ChatGPT Pro 200 · default", plan: "pro", codex: credit(expiresAt) });
    return utilization(owner, [
      reading("codex", "seven_day", start, start - HOUR, 60, "allowed", owner.key),
      reading("codex", "seven_day", resetsAt, start + HOUR, 1, "allowed", owner.key), reading("codex", "seven_day", resetsAt, now, used, "allowed", owner.key),
    ], now, spend);
  };
  const nearCap = item(95, start + 2 * DAY, start + 20 * DAY);
  assert.equal(nearCap.resets.available, 1);
  assert.equal(nearCap.resets.nowValue(nearCap.resets.credits[0]!), 95 * nearCap.calibration.perPercent!);
  const redeem = recommendations([nearCap], { now: start + 2 * DAY });
  assert.match(redeem[0]!.title, /^Redeem a banked ChatGPT Pro 200 reset now: it restores 95% of the week/);

  const heading = item(50, start + 2 * DAY, start + 20 * DAY);
  assert.ok(recommendations([heading], { now: start + 2 * DAY }).some((entry) => /^Hold your banked ChatGPT Pro 200 reset until the weekly meter nears 100%/.test(entry.title)));

  const expiring = item(20, start + 3 * DAY, start + 3 * DAY + 10 * HOUR);
  const warning = recommendations([expiring], { now: start + 3 * DAY }).find((entry) => /expires/.test(entry.title));
  assert.equal(warning?.tone, "act");
  assert.equal(bankedResets({ provider: "codex", summary: credit(start), now: start + DAY }).available, 0, "expired credits are not counted");
});

test("an early reset is attributed to a redeemed credit when the account's banked count drops across it", () => {
  const firstReset = start + WEEK, secondReset = start + DAY + WEEK, key = "codex-aaaaaaaaaaaaaaaa";
  const meters = buildMeters([
    reading("codex", "seven_day", firstReset, start + 20 * HOUR, 97, "allowed", key),
    reading("codex", "seven_day", secondReset, start + DAY + 60, 0, "allowed", key),
  ], start + 2 * DAY);
  const history = resetHistory(meters[0]!, 5, [["codex", key, start + 10 * HOUR, 2], ["codex", key, start + DAY + 300, 1]]);
  assert.deepEqual([history[0]!.cause, history[0]!.restored, history[0]!.restoredUsd], ["credit", 97, 485]);
  assert.equal(resetHistory(meters[0]!, 5, [["codex", "codex-bbbbbbbbbbbbbbbb", start + 10 * HOUR, 2], ["codex", "codex-bbbbbbbbbbbbbbbb", start + DAY + 300, 1]])[0]!.cause, "unknown", "another account's credits do not count");
});

test("a meter the provider stopped reporting is unreported rather than still capped; idle Claude weekly meters keep their schedule", () => {
  const resetsAt = start + WEEK;
  const meters = buildMeters([
    reading("claude", "seven_day_overage_included", resetsAt, start + DAY, 100, "rejected"),
    reading("claude", "seven_day", resetsAt, start + 2 * DAY, 60),
  ], start + 2 * DAY);
  const overage = meters.find((meter) => meter.meter === "seven_day_overage_included")!;
  assert.equal(liveMeter(overage, start + 2 * DAY).state, "capped");
  assert.equal(liveMeter(overage, start + 2 * DAY, start + 2 * DAY).state, "unreported");
  const later = start + 2 * WEEK + DAY;
  const idle = liveMeter(buildMeters([reading("claude", "seven_day", resetsAt, start + DAY, 60)], later)[0]!, later);
  assert.deepEqual([idle.state, idle.nextResetAt], ["idle", resetsAt + 2 * WEEK]);
  const codex = liveMeter(buildMeters([reading("codex", "seven_day", resetsAt, start + DAY, 60), reading("codex", "seven_day", later + WEEK, later - 60, 0, "idle")], later)[0]!, later);
  assert.deepEqual([codex.state, codex.nextResetAt, codex.meter.cycles.length], ["idle", null, 1], "an idle marker never forms a cycle");
});
