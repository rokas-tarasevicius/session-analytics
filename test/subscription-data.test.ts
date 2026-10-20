import assert from "node:assert/strict";
import test from "node:test";

import type { LimitAccount, LimitObservation } from "../src/limits/types.ts";

const data: typeof import("../src/public/subscription-data.js") = await import(new URL("../src/public/subscription-data.js", import.meta.url).href);
const {
  DAY, HOUR, MONTH_DAYS, WEEK, accountUtilization, attributeSessions, bankedResets, buildMeters, calibrate, compareUrgency, economics, formatDuration, hourlyValue,
  inPlaceResets, limitStatus, liveMeter, meterPace, recommendations, resetHistory, resetUtilization, sessionWindows, subscriptionModel, subscriptionTotals,
  visibleMeters, zonedDayStart,
} = data;

const start = Date.parse("2026-10-05T00:00:00Z") / 1000;
const at = (iso: string) => Date.parse(iso) / 1000;

function reading(provider: "claude" | "codex", meter: string, resetsAt: number, observedAt: number, usedPercent: number, status: LimitObservation["status"] = "allowed", account = ""): LimitObservation {
  return { provider, account, meter, windowMinutes: meter === "five_hour" ? 300 : 10_080, resetsAt, observedAt, usedPercent, status, source: provider === "codex" ? "codex-session" : "claude-sdk-log" };
}

function account(provider: "claude" | "codex", key: string, extra: Partial<LimitAccount> = {}): LimitAccount {
  return {
    key, provider, attribution: key === "" ? "unattributed" : key.includes("-w-") ? "weekly-phase" : "account", label: `${provider} ${key}`,
    profileNames: [], profileKeys: [], plan: null, planSource: null, planEvidence: null, planObservedAt: null, extraUsage: null, codex: null, weeklyAnchor: null, lastSeen: null, ...extra,
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

test("rejection below the calibration floor never divides value by a zero or tiny level", () => {
  for (const used of [0, 0.1, 4.9]) {
    const meter = buildMeters([
      reading("codex", "seven_day", start + WEEK, start + DAY, used, "rejected"),
      reading("codex", "seven_day", start + 2 * WEEK, start + WEEK + DAY, used, "rejected"),
    ], start + 2 * WEEK)[0]!;
    const calibration = calibrate(meter, { between: () => 10 });
    assert.equal(calibration.perPercent, null);
    assert.deepEqual(calibration.points, [], "a refused request does not establish value per percent");
  }
});

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
  // On extra usage the meter stops near 102% while value keeps accruing: only value up to the first full reading counts.
  const plateau = buildMeters([
    reading("claude", "seven_day", resetsAt, start + 2 * DAY, 50), reading("claude", "seven_day", resetsAt, start + 4 * DAY, 102, "overage"),
    ...[5, 6].map((day) => reading("claude", "seven_day", resetsAt, start + day * DAY, 102, "overage")),
  ], start + WEEK)[0]!;
  assert.deepEqual(calibrate(plateau, spend).points.map((point) => [point.at, point.perPercent]), [[start + 4 * DAY, 960 / 102]], "hours on extra usage never inflate value per 1%");
  const fiveHour = buildMeters([
    reading("claude", "five_hour", start + 5 * HOUR, start + HOUR, 40), reading("claude", "five_hour", start + 5 * HOUR, start + 2 * HOUR, 100, "overage"),
    reading("claude", "five_hour", start + 5 * HOUR, start + 4 * HOUR, 100, "overage"),
  ], start + DAY)[0]!;
  assert.deepEqual(calibrate(fiveHour, spend).points.map((point) => point.at), [start + 2 * HOUR], "a 5-hour plateau at exactly 100% on extra usage stops at its first reading");
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

  // With other machines combined, only this machine's sessions join its accounts; the others' value is reported beside them.
  const remote = { ...spending("codex", start - 10 * DAY, now, 3), machine: "agentbox" }, here = sessions.map((session) => ({ ...session, machine: "local" }));
  const combined = subscriptionModel({ limits: { accounts: [claude, team, codex], observations, meters: [], resetCreditHistory: [] }, sessions: [...here, remote], timeZone: "UTC", now, range: { from: start, to: now } });
  const localCodex = combined.accounts[2]!;
  assert.equal(localCodex.value.basis, "provider", "the only Codex account takes this machine's Codex sessions");
  assert.ok(Math.abs(localCodex.economics.extracted! - codexItem!.economics.extracted!) < 1e-6, "another machine's Codex value never joins it");
  assert.equal(combined.totals.priced.accounts, 1);
  assert.ok(Math.abs(combined.elsewhere.codex - 3 * 7 * 24) < 1e-6, "the other machine's value is reported, not dropped");
  assert.deepEqual([combined.elsewhere.claude, combined.totals.unattributed], [0, 0]);
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
  const machines = sessions.map((session, index) => ({ ...session, machine: index % 2 ? "agentbox" : "local" }));
  const combined = attributeSessions(machines, accounts);
  assert.deepEqual([...combined.byAccount].map(([key, list]) => [key, list.map(({ machine }) => machine)]), [
    ["claude-aaaaaaaaaaaaaaaa", ["local"]], ["claude-bbbbbbbbbbbbbbbb", []], ["claude-w-100", []], ["codex-aaaaaaaaaaaaaaaa", ["local"]], ["", []],
  ], "Claude joins by profile key and machine, Codex by machine");
  assert.deepEqual([combined.elsewhere.claude.length, combined.elsewhere.codex.length, combined.unattributed.claude.length], [2, 1, 1], "other machines' sessions are set apart, never guessed");
  const single = attributeSessions(sessions, [accounts[0]!]);
  assert.equal(single.byAccount.get("claude-aaaaaaaaaaaaaaaa")!.length, 2, "the only Claude account takes this machine's sessions without a profile");
});

test("a profile claimed by two accounts leaves its sessions unattributed regardless of account order", () => {
  const a = "claude-aaaaaaaaaaaaaaaa", b = "claude-bbbbbbbbbbbbbbbb";
  const owners = [
    account("claude", a, { profileKeys: ["profile-shared", "profile-a"], machines: [{ key: "agentbox", profileKeys: ["profile-shared", "profile-a"] }] }),
    account("claude", b, { profileKeys: ["profile-shared"], machines: [{ key: "agentbox", profileKeys: ["profile-shared"] }] }),
  ];
  for (const accounts of [owners, [...owners].reverse()]) {
    for (const machine of ["local", "agentbox"]) {
      const ambiguous = { provider: "claude", machine, historyProfile: { profileKey: "profile-shared" } };
      const certain = { provider: "claude", machine, historyProfile: { profileKey: "profile-a" } };
      const result = attributeSessions([ambiguous, certain], accounts, { read: machine === "local" ? null : new Set([machine]) });
      assert.deepEqual(result.unattributed.claude, [ambiguous]);
      assert.deepEqual(result.byAccount.get(a), [certain]);
      assert.deepEqual(result.byAccount.get(b), []);
    }
  }
  const joined = attributeSessions([
    { provider: "claude", historyProfile: { profileKey: "profile-shared" } },
    { provider: "claude", historyProfile: { profileKey: "profile-a" } },
  ], [owners[0]!]);
  assert.equal(joined.byAccount.get(a)!.length, 2, "two profiles on the same account still join one account");
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

test("active session counts follow real local hours across both daylight-saving transitions", () => {
  const owner = account("claude", "claude-aaaaaaaaaaaaaaaa");
  const cases: Array<[string, number, string, string, number]> = [
    ["2026-10-25", 1, "2026-10-25T00:00:00Z", "2026-10-25T01:00:00Z", 5],
    ["2026-10-25", 1, "2026-10-25T01:00:00Z", "2026-10-25T02:00:00Z", 5],
    ["2026-10-25", 2, "2026-10-25T02:00:00Z", "2026-10-25T03:00:00Z", 10],
    ["2026-03-29", 3, "2026-03-29T02:00:00Z", "2026-03-29T03:00:00Z", 10],
  ];
  for (const [day, hour, fromIso, toIso, dollars] of cases) {
    const from = at(fromIso), to = at(toIso);
    const sessions = [{ provider: "claude", velocity: { version: 1, dimensions: [], buckets: [[day, hour, 0, [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]], undated: [] } }];
    const item = utilization(owner, [reading("claude", "seven_day", from + WEEK, from - DAY, 10, "allowed", owner.key)], to, sessions, {
      timeZone: "Europe/London", range: { from, to }, basis: "profiles",
    });
    assert.equal(item.economics.extracted, dollars, fromIso);
    assert.equal(item.value.sessions, 1, fromIso);
    const outside = utilization(owner, [reading("claude", "seven_day", from + WEEK, from - DAY, 10, "allowed", owner.key)], to + DAY, sessions, {
      timeZone: "Europe/London", range: { from: to, to: to + HOUR }, basis: "profiles",
    });
    if (hour !== 1 || fromIso.includes("01:00:00Z")) assert.equal(outside.value.sessions, 0, "non-overlapping activity stays outside the range");
  }
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

test("a used-up weekly allowance names what keeps each provider working; extra usage says work continues at API rates", () => {
  const now = start + 4 * DAY;
  const used = (owner: LimitAccount, level: number, status: LimitObservation["status"]) => utilization(owner, [
    reading(owner.provider, "seven_day", start + WEEK, start + HOUR, 5, "allowed", owner.key), reading(owner.provider, "seven_day", start + WEEK, now - HOUR, level, status, owner.key),
  ], now);
  const detail = (item: ReturnType<typeof used>) => recommendations([item], { now }).find((advice) => advice.tone === "act")!.detail;
  const team = account("claude", "claude-aaaaaaaaaaaaaaaa", { extraUsage: { observedAt: now, extraUsage: "in-use", disabledReason: null } });
  assert.equal(detail(used(team, 104, "overage")), "Work continues at API rates until the reset, so move work that can wait until after it.");
  const max = account("claude", "claude-bbbbbbbbbbbbbbbb", { plan: "max-20x", extraUsage: { observedAt: now, extraUsage: "disabled", disabledReason: "org_level_disabled" } });
  assert.match(detail(used(max, 100, "rejected")), /^Until the reset, only extra usage keeps this account working\. Extra usage is turned off for this account \(claude\.ai settings\)/,
    "a personal plan is never told its organization turned extra usage off");
  const seat = account("claude", "claude-cccccccccccccccc", { plan: "team", extraUsage: { observedAt: now, extraUsage: "disabled", disabledReason: "org_level_disabled" } });
  assert.match(detail(used(seat, 100, "rejected")), /Extra usage is off for this organization/);
  assert.match(detail(used(account("codex", "codex-aaaaaaaaaaaaaaaa"), 100, "rejected")), /^Until the reset, only a banked or paid reset, or credits, keep this account working\./);
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

test("limits now: a cap ranks first, then the sooner run-out, then the fuller meter; unidentified readings last", () => {
  const now = start + 4 * DAY, resetsAt = start + WEEK;
  const weekly = (key: string, levels: number[], status: LimitObservation["status"] = "allowed") =>
    levels.map((level, index) => reading("claude", "seven_day", resetsAt, start + (index + 1) * DAY, level, index === levels.length - 1 ? status : "allowed", key));
  const item = (key: string, observations: LimitObservation[], extra: Partial<LimitAccount> = {}) =>
    utilization(account("claude", key, extra), observations, now);
  const capped = item("claude-aaaaaaaaaaaaaaaa", weekly("claude-aaaaaaaaaaaaaaaa", [40, 80, 95, 100], "rejected"));
  const soon = item("claude-bbbbbbbbbbbbbbbb", weekly("claude-bbbbbbbbbbbbbbbb", [30, 50, 70, 85]));
  const later = item("claude-cccccccccccccccc", weekly("claude-cccccccccccccccc", [25, 40, 55, 65]));
  const calm = item("claude-dddddddddddddddd", weekly("claude-dddddddddddddddd", [5, 10, 15, 20]));
  const phase = item("claude-w-100", weekly("claude-w-100", [10, 20, 30, 90]), { attribution: "weekly-phase" });
  const statuses = [phase, calm, later, soon, capped].map((entry) => ({ key: entry.key, status: limitStatus(entry, now) }));
  assert.deepEqual(statuses.map(({ status }) => status.kind), ["levels-only", "on-track", "runs-out", "runs-out", "capped"]);
  assert.equal(statuses.find(({ key }) => key === capped.key)!.status.until, resetsAt);
  assert.ok(statuses.find(({ key }) => key === soon.key)!.status.early! > 0);
  assert.deepEqual(statuses.sort((left, right) => compareUrgency(left.status, right.status)).map(({ key }) => key), [capped.key, soon.key, later.key, calm.key, phase.key]);
  const overage = item("claude-eeeeeeeeeeeeeeee", weekly("claude-eeeeeeeeeeeeeeee", [60, 90, 104], "overage"));
  assert.deepEqual([limitStatus(overage, now).kind, limitStatus(overage, now).used], ["overage", 100]);
  const stale = item("claude-ffffffffffffffff", weekly("claude-ffffffffffffffff", [20, 30]));
  assert.deepEqual([limitStatus(stale, now).kind, limitStatus(stale, now).since], ["stale", start + 2 * DAY]);
  const lockout = item("claude-1111111111111111", [...weekly("claude-1111111111111111", [5, 10, 15, 20]),
    reading("claude", "five_hour", now + 2 * HOUR, now - 2 * HOUR, 60, "allowed", "claude-1111111111111111"),
    reading("claude", "five_hour", now + 2 * HOUR, now - HOUR, 100, "rejected", "claude-1111111111111111")]);
  assert.deepEqual([limitStatus(lockout, now).kind, limitStatus(lockout, now).meter, limitStatus(lockout, now).until], ["capped", "session", now + 2 * HOUR], "a 5-hour lockout outranks an on-track week");
});

test("visible meters: weekly and 5-hour apart, scoped limits grouped, retired and never-used meters hidden", () => {
  const now = start + 3 * DAY, key = "codex-aaaaaaaaaaaaaaaa", resetsAt = start + WEEK;
  const observations = [
    reading("codex", "seven_day", resetsAt, start + DAY, 20, "allowed", key), reading("codex", "seven_day", resetsAt, now - HOUR, 40, "allowed", key),
    reading("codex", "codex_spark.seven_day", resetsAt, now - HOUR, 12, "allowed", key),
    reading("codex", "base_model_inference.seven_day", resetsAt, now - HOUR, 0, "allowed", key),
    reading("codex", "five_hour", start - 20 * DAY + 5 * HOUR, start - 20 * DAY, 30, "allowed", key),
  ];
  const meters = buildMeters(observations, now, [
    { provider: "codex", account: key, meter: "five_hour", label: "5-hour window", windowMinutes: 300, lastObservedAt: start - 20 * DAY, retired: true },
    { provider: "codex", account: key, meter: "codex_spark.seven_day", label: "GPT-5.3-Codex-Spark · Weekly", windowMinutes: 10_080, lastObservedAt: now - HOUR, retired: false },
  ]);
  const item = accountUtilization({ account: account("codex", key), meters, now, range: { from: now - 30 * DAY, to: now } });
  const { weekly, session, extra } = visibleMeters(item);
  assert.equal(weekly?.meter.meter, "seven_day");
  assert.equal(session, null, "a retired 5-hour meter is hidden");
  assert.deepEqual(extra.map((live) => live.meter.label), ["GPT-5.3-Codex-Spark · Weekly"], "a scoped meter that never moved off 0% is hidden");
});

test("pace counts the level given back by an in-place reset in the whole week, and the current segment on its own", () => {
  const resetsAt = start + WEEK, now = start + 3 * DAY, key = "claude-aaaaaaaaaaaaaaaa";
  const meters = buildMeters([
    reading("claude", "seven_day", resetsAt, start + DAY, 30, "allowed", key), reading("claude", "seven_day", resetsAt, start + 2 * DAY, 60, "allowed", key),
    reading("claude", "seven_day", resetsAt, start + 2 * DAY + HOUR, 1, "allowed", key), reading("claude", "seven_day", resetsAt, now, 40, "allowed", key),
  ], now);
  const live = liveMeter(meters[0]!, now);
  const pace = meterPace(live, now)!;
  assert.equal(live.cycle!.segments.length, 2);
  assert.ok(Math.abs(pace.cycle - 100 / 72) < 1e-9, "60% before the reset plus 40% after, over 72 hours");
  assert.ok(pace.segment > pace.cycle, "the current segment is faster than the week's average");
  assert.ok(Math.abs(pace.budget! - 60 / 96) < 1e-9, "60% left over the 96 hours to the reset");
  assert.equal(meterPace(null, now), null);
});

test("a burst right after a reset is never 'may already be used up', however long the meter then stays quiet", () => {
  const resetsAt = start + WEEK;
  const burst = [5, 10, 15].map((level, index) => reading("claude", "seven_day", resetsAt, start + (index + 1) * HOUR, level));
  for (const hours of [21, 40, 100, 160]) {
    const now = start + hours * HOUR;
    const live = liveMeter(buildMeters(burst, now)[0]!, now);
    assert.deepEqual([live.stale, live.projected, live.mayBeUsedUp], [true, null, false], `${hours}h`);
    const owner = account("claude", "claude-aaaaaaaaaaaaaaaa");
    const item = utilization(owner, burst.map((row) => ({ ...row, account: owner.key })), now);
    assert.equal(limitStatus(item, now).kind, "stale");
    assert.ok(!recommendations([item], { now }).some((entry) => /may already be used up/.test(entry.title)));
  }
});

test("a month of full use is the plans you pay for against their price; employer seats and free plans are beside it", () => {
  const max = account("claude", "claude-aaaaaaaaaaaaaaaa", { plan: "max-20x", profileKeys: ["profile-a"] });
  const team = account("claude", "claude-bbbbbbbbbbbbbbbb", { plan: "team", profileKeys: ["profile-b"] });
  const codex = account("codex", "codex-aaaaaaaaaaaaaaaa", { plan: "pro" });
  const now = start + 2 * WEEK + DAY;
  const observations = [max, team, codex].flatMap((owner) => [1, 2, 3].flatMap((week) => [
    reading(owner.provider, "seven_day", start + week * WEEK, start + (week - 1) * WEEK + HOUR, 1, "allowed", owner.key),
    reading(owner.provider, "seven_day", start + week * WEEK, Math.min(now - HOUR, start + week * WEEK - HOUR / 2), 50, "allowed", owner.key),
  ]));
  const sessions = [spending("claude", start, now, 10, "profile-a"), spending("claude", start, now, 30, "profile-b"), spending("codex", start, now, 5)];
  const model = subscriptionModel({ limits: { accounts: [max, team, codex], observations, meters: [], resetCreditHistory: [] }, sessions, timeZone: "UTC", now, range: { from: start, to: now } });
  const [maxItem, teamItem, codexItem] = model.accounts;
  const { totals } = model;
  const priced = maxItem!.economics.monthlyPotential! + codexItem!.economics.monthlyPotential!;
  assert.ok(Math.abs(totals.monthlyPotential! - priced) < 1e-6, "the headline is the plans you pay for");
  assert.equal(totals.monthlyPrice, 400);
  assert.ok(Math.abs(totals.potentialMultiple! - priced / 400) < 1e-9, "the multiple divides the same accounts' potential by their price");
  assert.ok(Math.abs(totals.otherMonthlyPotential! - teamItem!.economics.monthlyPotential!) < 1e-6, "the employer seat is reported beside");

  const free = economics({ provider: "codex", planId: "free", perPercent: 10, extracted: 50, days: 7 });
  assert.deepEqual([free.price, free.multiple], [0, null]);
  const freeTotals = subscriptionTotals(model.accounts.map((item) => item === codexItem ? { ...item, economics: { ...item.economics, ...free, days: item.economics.days } } : item));
  assert.equal(freeTotals.priced.accounts, 1, "a free plan is not a plan you pay for");
  assert.equal(freeTotals.monthlyPrice, 200);
});

test("value before the first reading is reported, not counted; accounts without readings in the dates leave the totals", () => {
  const owner = account("codex", "codex-aaaaaaaaaaaaaaaa", { plan: "pro" });
  const now = start + 10 * DAY, first = start + 5 * DAY;
  const observations = [reading("codex", "seven_day", first + WEEK, first, 5, "allowed", owner.key), reading("codex", "seven_day", first + WEEK, now - HOUR, 40, "allowed", owner.key)];
  const sessions = [spending("codex", start, start + 2 * DAY, 2), spending("codex", start + 6 * DAY, now, 2)];
  const model = (range: { from: number; to: number }, list: unknown[] = sessions) =>
    subscriptionModel({ limits: { accounts: [owner], observations, meters: [], resetCreditHistory: [] }, sessions: list as never, timeZone: "UTC", now, range });
  const current = model({ from: start, to: now });
  const item = current.accounts[0]!;
  assert.ok(Math.abs(item.value.before - 2 * 48) < 1e-6, "two days at $2 an hour before the first reading");
  assert.ok(Math.abs(current.totals.beforeReadings - 96) < 1e-6);
  assert.equal(item.value.sessions, 1, "only the session active since the first reading is counted");

  const past = model({ from: start, to: start + 4 * DAY });
  assert.deepEqual([past.accounts[0]!.period.days, past.totals.priced.accounts, past.totals.extracted], [0, 0, 0], "no days in the dates: no price and no value");
  assert.ok(Math.abs(past.totals.beforeReadings - 96) < 1e-6);

  // An account no session matched has unknown value, never $0 that drags the value multiple down.
  const unmatched = model({ from: start, to: now }, []);
  assert.deepEqual([unmatched.accounts[0]!.value.basis, unmatched.accounts[0]!.economics.extracted, unmatched.totals.priced.accounts], ["none", null, 0]);
  const claude = account("claude", "claude-aaaaaaaaaaaaaaaa", { plan: "pro", profileKeys: ["profile-a"] });
  const lone = subscriptionModel({ limits: { accounts: [claude], observations: observations.map((row) => ({ ...row, provider: "claude" as const, account: claude.key })), meters: [], resetCreditHistory: [] }, sessions: [], timeZone: "UTC", now, range: { from: start, to: now } });
  assert.deepEqual([lone.accounts[0]!.value.basis, lone.accounts[0]!.economics.extracted], ["none", null]);
});

test("a meter with no reading since its reset is unknown, not unused, unless the provider said the window has not started", () => {
  const later = start + 2 * WEEK + DAY;
  const claude = liveMeter(buildMeters([reading("claude", "seven_day", start + WEEK, start + DAY, 60)], later)[0]!, later);
  assert.deepEqual([claude.state, claude.confirmedIdle, claude.lastResetAt, claude.nextResetAt], ["idle", false, start + 2 * WEEK, start + 3 * WEEK]);
  const codex = liveMeter(buildMeters([reading("codex", "seven_day", start + WEEK, start + DAY, 60), reading("codex", "seven_day", later + WEEK, later - 60, 0, "idle")], later)[0]!, later);
  assert.equal(codex.confirmedIdle, true);
  const owner = account("claude", "claude-aaaaaaaaaaaaaaaa");
  const item = utilization(owner, [reading("claude", "seven_day", start + WEEK, start + DAY, 60, "allowed", owner.key)], later);
  assert.deepEqual([limitStatus(item, later).kind, limitStatus(item, later).confirmed], ["idle", false]);
});

test("a lockout ends when work resumes on extra usage", () => {
  const windowEnd = start + 5 * HOUR;
  const meter = buildMeters([
    reading("claude", "five_hour", windowEnd, start + HOUR, 60), reading("claude", "five_hour", windowEnd, start + 2 * HOUR, 100, "rejected"),
    reading("claude", "five_hour", windowEnd, start + 3 * HOUR, 104, "overage"),
  ], start + DAY)[0]!;
  const windows = sessionWindows(meter, start + DAY);
  assert.deepEqual([windows.capped, windows.lockedSeconds, windows.windows[0]!.lockouts], [1, HOUR, [[start + 2 * HOUR, start + 3 * HOUR]]]);
  const weekly = buildMeters([
    reading("claude", "seven_day", start + WEEK, start + 2 * DAY, 100, "rejected"), reading("claude", "seven_day", start + WEEK, start + 3 * DAY, 110, "overage"),
  ], start + WEEK + HOUR)[0]!;
  assert.equal(resetHistory(weekly)[0]!.lockedSeconds, DAY);
});

test("the weekly meter including extra usage is a level only: no projection, run-out or cap", () => {
  const resetsAt = start + WEEK, now = start + 3 * DAY;
  const rising = buildMeters([reading("claude", "seven_day_overage_included", resetsAt, start + DAY, 40), reading("claude", "seven_day_overage_included", resetsAt, now - HOUR, 99)], now)[0]!;
  const live = liveMeter(rising, now);
  assert.deepEqual([live.levelsOnly, live.projected, live.capAt, live.capsEarly, live.mayBeUsedUp], [true, null, null, false, false]);
  const full = liveMeter(buildMeters([reading("claude", "seven_day_overage_included", resetsAt, now - HOUR, 100, "rejected")], now)[0]!, now);
  assert.equal(full.capAt, null);
});

test("each suggestion names its rule, and history that is not kept says why", () => {
  const sources = [{ source: "claude-sdk-log" as const, status: "ok" as const, read: 1, latest: start }];
  const notes = (options: Partial<Parameters<typeof recommendations>[1]>) => recommendations([], { now: start, sources, ...options }).filter((entry) => entry.kind === "history");
  assert.deepEqual(notes({}), []);
  assert.match(notes({ persisted: false })[0]!.detail, /--no-index.*a few days/);
  assert.match(notes({ persisted: false, ledger: "unreadable" })[0]!.detail, /another version/);
  assert.doesNotMatch(notes({ persisted: false, ledger: "unreadable" })[0]!.detail, /--no-index/);
  assert.match(notes({ persisted: false, ledger: "unwritable" })[0]!.title, /could not be saved/);
});

test("a week used up fast before a projection has evidence warns with the pace so far, never a projection", () => {
  const resetsAt = start + WEEK, key = "codex-aaaaaaaaaaaaaaaa", owner = account("codex", key, { plan: "pro" });
  const week = (hours: number, levels: number[]) => {
    const now = start + hours * HOUR;
    return { now, item: utilization(owner, levels.map((level, index) => reading("codex", "seven_day", resetsAt, start + (index + 1) / levels.length * hours * HOUR, level, "allowed", key)), now) };
  };
  // Codex's real first day: 66% of a week in 12.5 hours, before a tenth of the week has passed.
  const fast = week(12.5, [20, 45, 66]), live = fast.item.weekly!;
  assert.deepEqual([live.tooEarly, live.projected, live.capAt, live.capsEarly], [true, null, null, false], "the projection stays gated");
  assert.ok(Math.abs(live.burnAt! - (fast.now + 34 / 66 * 12.5 * HOUR)) < 1, "the run-out at the pace so far");
  assert.deepEqual(limitStatus(fast.item, fast.now), { kind: "early-burn", tone: "warn", rank: 3, used: 66, at: live.burnAt, until: null, since: start, early: null, meter: "weekly" });
  const advice = recommendations([fast.item], { now: fast.now, formatTime: (seconds) => String(Math.round(seconds)) });
  assert.deepEqual([advice[0]!.kind, advice[0]!.tone], ["early-burn", "act"]);
  assert.match(advice[0]!.title, new RegExp(`: 66% used in 12h; at this pace it runs out ${Math.round(live.burnAt!)}$`));
  assert.match(advice[0]!.detail, /too early in the week to project, so this is the pace so far, not a forecast/);
  // Half used, it ranks with confident run-outs by how early it runs out, as in Limits now: before one that runs out later.
  const max = account("claude", "claude-aaaaaaaaaaaaaaaa", { plan: "max-20x" }), maxReset = fast.now + 2 * DAY;
  const later = utilization(max, [reading("claude", "seven_day", maxReset, maxReset - WEEK + DAY, 20, "allowed", max.key), reading("claude", "seven_day", maxReset, fast.now - HOUR, 85, "allowed", max.key)], fast.now);
  assert.ok(later.weekly!.capsEarly && later.weekly!.capAt! > live.burnAt!);
  assert.ok(compareUrgency(limitStatus(fast.item, fast.now), limitStatus(later, fast.now)) < 0);
  assert.deepEqual(recommendations([later, fast.item], { now: fast.now }).map((entry) => entry.kind).filter((kind) => kind === "early-burn" || kind === "runs-out"), ["early-burn", "runs-out"]);
  // Under half used but at more than three times the even pace: watch, ranked after a confident run-out.
  const rising = week(6, [10, 30]);
  assert.deepEqual([limitStatus(rising.item, rising.now).kind, limitStatus(rising.item, rising.now).rank], ["early-burn", 4]);
  assert.equal(recommendations([rising.item], { now: rising.now }).find((entry) => entry.kind === "early-burn")!.tone, "watch");
  // A small burst, a pace under three times even, and a single reading stay too early to tell.
  for (const [hours, levels] of [[3, [5, 10]], [16, [10, 22]], [12, [60]]] as const) {
    const quiet = week(hours, [...levels]);
    assert.deepEqual([quiet.item.weekly!.burnAt, limitStatus(quiet.item, quiet.now).kind], [null, "too-early"], `${levels.join(", ")}% in ${hours}h`);
    assert.ok(recommendations([quiet.item], { now: quiet.now }).every((entry) => entry.kind !== "early-burn"));
  }
  // An account burning through its week is never offered as the one with room.
  const other = account("codex", "codex-bbbbbbbbbbbbbbbb", { plan: "pro" });
  const capped = utilization(other, [reading("codex", "seven_day", start + DAY, start + 2 * HOUR, 40, "allowed", other.key), reading("codex", "seven_day", start + DAY, fast.now - HOUR, 100, "rejected", other.key)], fast.now);
  assert.doesNotMatch(recommendations([fast.item, capped], { now: fast.now }).find((entry) => entry.kind === "weekly-used-up")!.detail, /Point background agents/);
});

test("a 5-hour window used up fast in its first minutes warns in Limits now after every weekly status, and not in Next", () => {
  const now = start + 3 * DAY, key = "claude-aaaaaaaaaaaaaaaa", owner = account("claude", key, { plan: "max-20x" }), resetsAt = now + 5 * HOUR - 8 * 60;
  const item = utilization(owner, [
    reading("claude", "seven_day", start + WEEK, start + DAY, 10, "allowed", key), reading("claude", "seven_day", start + WEEK, now - HOUR, 20, "allowed", key),
    reading("claude", "five_hour", resetsAt, now - 4 * 60, 8, "allowed", key), reading("claude", "five_hour", resetsAt, now, 15, "allowed", key),
  ], now);
  const session = item.session!;
  assert.deepEqual([session.tooEarly, session.projected, session.capsEarly, item.weekly!.burnAt], [true, null, false, null]);
  assert.ok(Math.abs(session.burnAt! - (now + 85 / 15 * 8 * 60)) < 1, "15% in 8 minutes runs out 45 minutes from now");
  assert.deepEqual(limitStatus(item, now), { kind: "early-burn", tone: "warn", rank: 5, used: 20, at: session.burnAt, until: null, since: now - 8 * 60, early: null, meter: "session" });
  assert.ok(recommendations([item], { now }).every((entry) => entry.kind !== "early-burn"));
});

test("a 5-hour lockout going on now says where to work while the week has room; the week's lockouts are only watched", () => {
  const now = start + 3 * DAY, locked = account("claude", "claude-aaaaaaaaaaaaaaaa", { plan: "max-20x", profileNames: ["default"] });
  const personal = account("claude", "claude-bbbbbbbbbbbbbbbb", { plan: "max-20x", profileNames: ["personal"] });
  const week = (key: string, level: number) => [reading("claude", "seven_day", start + WEEK, start + DAY, level / 2, "allowed", key), reading("claude", "seven_day", start + WEEK, now - HOUR, level, "allowed", key)];
  const observations = [...week(locked.key, 30), reading("claude", "five_hour", now + 2 * HOUR, now - 2 * HOUR, 60, "allowed", locked.key), reading("claude", "five_hour", now + 2 * HOUR, now - HOUR, 100, "rejected", locked.key)];
  const advice = (at: number, others = true) => recommendations([utilization(locked, observations, at), ...(others ? [utilization(personal, week(personal.key, 20), at)] : [])], { now: at, formatTime: (seconds) => String(seconds) });
  const current = advice(now);
  assert.deepEqual(current.filter((entry) => entry.kind === "locked-out" || entry.kind === "lockouts").map((entry) => [entry.kind, entry.tone]), [["locked-out", "act"], ["lockouts", "watch"]]);
  assert.equal(current[0]!.title, `claude ${locked.key} is locked out by its 5-hour limit until ${now + 2 * HOUR}; switch to the personal profile`);
  assert.ok(advice(now, false).every((entry) => entry.kind !== "locked-out"), "nowhere to switch to");
  assert.ok(advice(now + 3 * HOUR).every((entry) => entry.kind !== "locked-out"), "the window has reset");
});

test("past 5-hour lockouts are watched, never acted on, ordered by time locked out; extra usage makes the weekly limit the tighter one", () => {
  const now = start + 4 * DAY, team = account("claude", "claude-aaaaaaaaaaaaaaaa", { plan: "team" }), max = account("claude", "claude-bbbbbbbbbbbbbbbb", { plan: "max-20x" });
  // Each window is capped `hours` before its reset, so it is locked out that long.
  const lockouts = (key: string, hours: number[]) => hours.flatMap((locked, index) => {
    const resets = start + (index + 1) * DAY;
    return [reading("claude", "five_hour", resets, resets - 4 * HOUR, 40, "allowed", key), reading("claude", "five_hour", resets, resets - locked * HOUR, 100, "rejected", key)];
  });
  const teamItem = utilization(team, [
    reading("claude", "seven_day", start + WEEK, start + DAY, 60, "allowed", team.key), reading("claude", "seven_day", start + WEEK, now - HOUR, 102, "overage", team.key), ...lockouts(team.key, [1]),
  ], now);
  const maxItem = utilization(max, [
    reading("claude", "seven_day", start + WEEK, start + DAY, 5, "allowed", max.key), reading("claude", "seven_day", start + WEEK, now - HOUR, 20, "allowed", max.key), ...lockouts(max.key, [3, 2.4, 2]),
  ], now);
  const entries = recommendations([teamItem, maxItem], { now }).filter((entry) => entry.kind === "lockouts");
  assert.deepEqual(entries.map((entry) => [entry.account, entry.tone]), [[max.key, "watch"], [team.key, "watch"]]);
  assert.match(entries[0]!.title, /3 times in 7 days \(7h 24m locked out\)$/);
  assert.match(entries[1]!.detail, /^The weekly allowance is the tighter limit this week/, "an account on extra usage is weekly-bound");
});
