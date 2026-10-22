// Subscription utilization: provider-reported limit meters joined with the activity ledger, one account at a time.
// Pure functions only; shared by the dashboard, the `limits` command and tests.
//
// Vocabulary
// - account: one subscription login (`LimitAccount`). Meters, cycles, value and advice never mix two accounts.
// - meter: one allowance of one account (`five_hour`, `seven_day`), reported as percent used.
// - cycle: one reset window of a meter, identified by its reset instant.
// - segment: part of a cycle. The provider can restart a meter at 0% without moving its reset (an in-place reset);
//   the readings after it are a new segment, and pace, projection and closing level use the latest one.
// - $/%: API-equivalent value of the account's own activity per percent of a meter, calibrated per segment.
// - banked reset: a Codex reset credit you hold; redeeming restarts the windows at 0%.

import { ledgerCells } from "./velocity-data.js";
import { planFor, topRank } from "./subscription-plans.js";
import { integer, zonedHourKey } from "./format.js";
import { localMachine } from "./machines.js";

export const HOUR = 3600;
export const DAY = 86_400;
export const WEEK = 7 * DAY;
export const MONTH_DAYS = 30.4375;
const QUARTER = 900;
/** Readings under this share of a window are too small to calibrate value per percent. */
const calibrationFloor = 5;
/** Value per percent needs this many segments with local activity; fewer is "not enough history". */
export const calibrationMinimum = 2;
/** A segment whose value per percent is under this share of the median moved mostly elsewhere (another machine, the web). */
const outlierShare = 0.25;
/** Reset instants this close are one cycle: providers report a cycle's reset with a little drift. */
const resetDrift = 180;
/** A fall of this many points inside one cycle, confirmed by the next reading, is an in-place reset. */
const resetDrop = 5;
const statusRank = { unknown: 0, idle: 0, allowed: 1, warning: 2, overage: 3, rejected: 4 };

const sessionMeter = "five_hour";
const weeklyMeter = "seven_day";

export const providerNames = { claude: "Claude", codex: "Codex" };

/** Account and profile keys are subscription logins; weekly-phase (`claude-w-…`) and unattributed (`""`) keys are not. */
export const identified = (key) => key !== "" && !key.includes("-w-");

export function meterLabel(meter) {
  const dot = meter.lastIndexOf(".");
  const scope = dot >= 0 ? meter.slice(0, dot) : "";
  const base = meter.slice(dot + 1);
  const known = {
    five_hour: "5-hour window", seven_day: "Weekly · all models", seven_day_opus: "Weekly · Opus", seven_day_sonnet: "Weekly · Sonnet",
    seven_day_overage_included: "Weekly · incl. extra usage", seven_day_routines: "Weekly · routines", seven_day_cowork: "Weekly · Cowork",
  };
  const label = known[base] ?? (base.startsWith("window_") ? `${base.slice(7).replace("m", "")}-minute window` : base.replace(/_/g, " "));
  return scope ? `${scope} · ${label}` : label;
}

/** The base meter a scoped Codex meter (`codex_spark.seven_day`) reports for. */
export const meterBase = (meter) => meter.slice(meter.lastIndexOf(".") + 1);

/** A cap stops work; Claude's `overage` (past the cap on paid extra usage) does not. */
const isCapped = (sample) => sample.status === "rejected" || (sample.used >= 100 && sample.status !== "overage");

/**
 * Meters shown as levels only: what Claude's weekly "including extra usage" meter limits is not documented (on a plan
 * without extra usage it reported 100% while work went on), so it gets no projection, run-out or cap.
 */
const levelsOnlyMeters = new Set(["seven_day_overage_included"]);

/**
 * Group observations into meters per account and into reset cycles. A cycle ends at its reset, or earlier when the next
 * cycle begins first. `infos` (`LimitsSnapshot.meters`) supplies display labels and retired flags. Idle markers
 * never form a cycle.
 */
export function buildMeters(observations, now, infos = []) {
  const labels = new Map((infos ?? []).map((info) => [`${info.provider}|${info.account}|${info.meter}`, info]));
  const meters = new Map();
  for (const observation of observations ?? []) {
    const account = observation.account ?? "";
    const key = `${observation.provider}|${account}|${observation.meter}`;
    let meter = meters.get(key);
    if (!meter) {
      const info = labels.get(key);
      meter = {
        key, provider: observation.provider, account, meter: observation.meter, label: info?.label ?? meterLabel(observation.meter),
        windowMinutes: observation.windowMinutes, retired: info?.retired ?? false, readings: [], planReadings: [],
      };
      meters.set(key, meter);
    }
    meter.windowMinutes ??= observation.windowMinutes;
    if (observation.planType) meter.planReadings.push({ t: observation.observedAt, planType: observation.planType });
    meter.readings.push(observation);
    if (observation.status === "idle") meter.idleAt = Math.max(meter.idleAt ?? 0, observation.observedAt);
  }
  return [...meters.values()].map(({ readings, ...meter }) => ({ ...meter, idleAt: meter.idleAt ?? null, cycles: cyclesOf(readings, meter.windowMinutes ? meter.windowMinutes * 60 : 0, now) }))
    .sort((left, right) => left.provider.localeCompare(right.provider) || left.account.localeCompare(right.account) ||
      meterOrder(left.meter) - meterOrder(right.meter) || left.meter.localeCompare(right.meter));
}

function meterOrder(meter) {
  const base = meterBase(meter);
  return (meter.includes(".") ? 10 : 0) + (base === sessionMeter ? 0 : base === weeklyMeter ? 1 : 2);
}

function cyclesOf(readings, window, now) {
  // Missing evidence is not a tier change. Carry the last observed tier forward, as price periods do;
  // never backfill readings before the first tier was observed. Resolve simultaneous evidence before carrying it.
  const evidence = new Map();
  for (const reading of readings) if (reading.planType) {
    const previous = evidence.get(reading.observedAt);
    evidence.set(reading.observedAt, previous && previous !== reading.planType ? "other" : reading.planType);
  }
  let planType = null;
  const contextual = [...readings].sort((left, right) => left.observedAt - right.observedAt).map((reading) => {
    planType = evidence.get(reading.observedAt) ?? planType;
    return { ...reading, planType };
  });
  const groups = [];
  for (const reading of contextual.filter((reading) => reading.status !== "idle").sort((left, right) => left.resetsAt - right.resetsAt)) {
    const group = groups.at(-1);
    if (group && reading.resetsAt - group.first <= resetDrift) group.readings.push(reading);
    else groups.push({ first: reading.resetsAt, readings: [reading] });
  }
  const ordered = groups.map(({ readings: members }) => {
    const counts = new Map();
    for (const reading of members) counts.set(reading.resetsAt, (counts.get(reading.resetsAt) ?? 0) + 1);
    const [[resetsAt]] = [...counts].sort((left, right) => right[1] - left[1] || right[0] - left[0]);
    const instants = new Map();
    for (const reading of members) {
      const previous = instants.get(reading.observedAt);
      instants.set(reading.observedAt, {
        t: reading.observedAt, used: Math.max(previous?.used ?? 0, reading.usedPercent),
        planType: previous?.planType && reading.planType && previous.planType !== reading.planType
          ? "other" : previous?.planType ?? reading.planType ?? null,
        status: previous && statusRank[previous.status] > statusRank[reading.status] ? previous.status : reading.status,
      });
    }
    const samples = [...instants.values()].filter((sample) => sample.t <= resetsAt).sort((left, right) => left.t - right.t);
    return { resetsAt, samples };
  }).filter((cycle) => cycle.samples.length);
  const ends = [];
  let nextStart = Infinity;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    ends[index] = Math.min(ordered[index].resetsAt, nextStart);
    nextStart = Math.min(nextStart, ordered[index].samples[0].t);
  }
  return ordered.flatMap((cycle, index) => {
    const end = ends[index];
    // A reading of this cycle reported after the next one began is late; it never moves the close.
    const samples = cycle.samples.filter((sample) => sample.t <= end);
    // With clock skew or conflicting contexts every reading can be late; none can prove this cycle's close.
    if (!samples.length) return [];
    const start = window ? Math.min(cycle.resetsAt - window, samples[0].t) : samples[0].t;
    const segments = segmentsOf(samples, start, end);
    const closing = segments.at(-1);
    return [{
      resetsAt: cycle.resetsAt, start, end, samples, segments, last: closing.last, peak: closing.peak,
      cappedAt: segments.find((segment) => segment.cappedAt !== null)?.cappedAt ?? null,
      // A redeemed reset or a provider-wide reset before the scheduled instant; the unused remainder was not forfeited.
      endedEarly: end < cycle.resetsAt - 15 * 60,
      closed: end <= now,
    }];
  });
}

/**
 * Split a cycle where the provider restarted the meter without moving its reset: a fall of at least 5 points that the next
 * reading confirms (a latest reading counts alone only when it halves the level). The reset is placed midway between the
 * readings on either side of it.
 */
function segmentsOf(samples, start, end) {
  const groups = [{ start, before: null, baseline: null, samples: [] }];
  let top = -Infinity;
  samples.forEach((sample, index) => {
    const group = groups.at(-1), next = samples[index + 1], floor = top - resetDrop;
    if (group.samples.length && sample.planType !== group.samples.at(-1).planType) {
      // A tier change is no evidence of a redeemed reset. Pace starts at the first reading of the new context.
      groups.push({ start: sample.t, before: null, baseline: sample, samples: [] });
      top = -Infinity;
    } else if (group.samples.length && sample.used <= floor && (next ? next.used <= floor : sample.used <= top / 2)) {
      const before = group.samples.at(-1);
      groups.push({ start: (before.t + sample.t) / 2, before, baseline: null, samples: [] });
      top = -Infinity;
    }
    groups.at(-1).samples.push(sample);
    top = Math.max(top, sample.used);
  });
  return groups.map((group, index) => {
    const close = groups[index + 1]?.start ?? end;
    return {
      start: group.start, end: close, before: group.before, baseline: group.baseline, samples: group.samples,
      peak: Math.max(...group.samples.map((sample) => sample.used)), last: group.samples.at(-1),
      cappedAt: group.samples.find(isCapped)?.t ?? null, lockouts: lockoutsOf(group.samples, close),
    };
  });
}

/** Lockouts of a segment: from a capped reading to the next reading on extra usage (work went on), else to its end. */
function lockoutsOf(samples, end) {
  const spans = [];
  let from = null;
  for (const sample of samples) {
    if (from === null && isCapped(sample)) from = sample.t;
    else if (from !== null && sample.status === "overage") { spans.push([from, sample.t]); from = null; }
  }
  if (from !== null) spans.push([from, end]);
  return spans;
}

/** Seconds locked out in a cycle, up to `until`. */
const lockedSeconds = (cycle, until = Infinity) => cycle.segments.reduce((total, segment) =>
  total + segment.lockouts.reduce((sum, [from, to]) => sum + Math.max(0, Math.min(to, until) - from), 0), 0);

/** A closing reading taken this long before the reset is a lower bound: later use was not observed. */
const unobservedLimit = (meter) => Math.max(HOUR, (meter?.windowMinutes ?? 0) * 60 * 0.1);

/** Claude resets each weekly limit at a fixed time of the week, so an idle weekly meter still has a known next reset. */
function scheduledReset(meter, now) {
  const last = meter.cycles.at(-1)?.resetsAt;
  if (meter.provider !== "claude" || meter.windowMinutes !== 10_080 || last === undefined) return null;
  return last > now ? last : last + Math.max(1, Math.ceil((now - last) / WEEK)) * WEEK;
}

/**
 * Live state of a meter: where it stands now, how fast it is moving, and where it lands at reset at this pace.
 * `reportedUntil` is the account's latest reading on any meter: a meter the provider stopped reporting while the account's
 * others continue is `unreported`, not still capped (Claude only includes some scoped meters while they matter).
 * Pace runs from the current segment's start through now, so hours without readings (no use) slow it and a run-out is
 * never in the past. `project: false` (readings without an account) and `levelsOnly` meters report levels only. A meter with
 * no open cycle is `confirmedIdle` only when the provider reported the window as not started after the last cycle; else
 * nothing is known since the reset (another machine or the web may have used it).
 */
export function liveMeter(meter, now, reportedUntil = null, { project = true } = {}) {
  const window = (meter.windowMinutes ?? 0) * 60;
  const cycle = meter.cycles.findLast((item) => !item.closed) ?? null;
  const levelsOnly = levelsOnlyMeters.has(meterBase(meter.meter));
  if (levelsOnly) project = false;
  if (!cycle) {
    const nextResetAt = scheduledReset(meter, now), previous = meter.cycles.at(-1) ?? null;
    return {
      meter, cycle: null, segment: null, state: meter.retired ? "retired" : "idle", used: 0, nextResetAt, levelsOnly,
      confirmedIdle: (meter.idleAt ?? null) !== null && meter.idleAt >= (previous?.end ?? -Infinity),
      lastResetAt: nextResetAt !== null && window ? nextResetAt - window : previous?.end ?? null,
    };
  }
  const segment = cycle.segments.at(-1), { last } = segment, { resetsAt } = cycle;
  const used = last.used;
  const unreported = reportedUntil !== null && last.t < reportedUntil - 2 * HOUR;
  const state = unreported ? "unreported" : last.status === "overage" ? "overage" : isCapped(last) ? "capped" : "active";
  const minimum = window > 0 && window <= 6 * HOUR ? 5 * 60 : HOUR;
  const movement = Math.max(0, used - (segment.baseline?.used ?? 0));
  const rate = movement / Math.max(minimum, now - segment.start); // percent per second
  const stale = unreported || now - last.t > Math.max(HOUR, window * 0.1);
  // A burst extrapolated across a week is noise: project once two readings and a tenth of the window are behind us.
  const tooEarly = segment.samples.length < 2 || (window > 0 && now - segment.start < window * 0.1);
  const remaining = Math.max(0, resetsAt - now);
  const projected = project && !tooEarly && !stale ? used + rate * remaining : null;
  const capAt = levelsOnly ? null : state === "capped" ? segment.cappedAt ?? last.t
    : state === "active" && projected !== null && projected > 100 && rate > 0 ? now + Math.max(0, 100 - used) / rate : null;
  const lastRate = movement / Math.max(minimum, last.t - segment.start);
  // The same evidence a projection needs, measured up to the last reading: a burst right after a reset says nothing.
  const evidenced = segment.samples.length >= 2 && last.t - segment.start >= Math.max(HOUR, window * 0.1);
  // Too early to project, but already used up fast: half of it, or 15% (a day's even share of a week) at three times the even pace.
  // Any window: in a 5-hour one, a burst in its first 30 minutes, which on real readings mostly went on to hit the limit.
  const burning = project && !levelsOnly && tooEarly && !stale && state === "active" && window > 0 && segment.samples.length >= 2 && rate > 0
    && (used >= 50 || (used >= 15 && rate * window >= 300));
  const runsOut = burning ? now + (100 - used) / rate : null;
  const burnAt = runsOut !== null && runsOut < resetsAt - 15 * 60 ? runsOut : null;
  return {
    meter, cycle, segment, state, used, rate, remaining, projected, tooEarly, stale, capAt, burnAt, levelsOnly, confirmedIdle: false, lastResetAt: null,
    elapsed: ((segment.baseline?.used ?? 0) + (100 - (segment.baseline?.used ?? 0)) * Math.min(1, Math.max(0, (now - segment.start) / Math.max(1, resetsAt - segment.start)))) / 100,
    capsEarly: state === "active" && capAt !== null && capAt < resetsAt - 15 * 60,
    // No recent reading, but the pace before the last one would have used the allowance up by now.
    mayBeUsedUp: project && state === "active" && stale && evidenced && used + lastRate * (Math.min(now, resetsAt) - last.t) >= 100,
    dailyBudget: remaining > 0 ? Math.max(0, 100 - used) / Math.max(remaining / DAY, 1 / 24) : null,
    observedAt: last.t, nextResetAt: resetsAt,
  };
}

/** The latest reading across one account's meters, Unix seconds. */
export function latestReading(meters) {
  let latest = null;
  for (const meter of meters) for (const cycle of meter.cycles) latest = Math.max(latest ?? 0, cycle.samples.at(-1).t);
  return latest;
}

function firstReading(meters) {
  let first = null;
  for (const meter of meters) for (const cycle of meter.cycles) first = Math.min(first ?? Infinity, cycle.samples[0].t);
  return first;
}

/** Local hour keys of quarter-hour instants by zone, shared by every account's value. */
const sliceKeys = new Map();

/**
 * Hourly API-equivalent value of the given sessions, from the same activity ledger as Summary and Velocity.
 * Cells are local hours in the snapshot's timezone and meters are instants, so value is read in quarter hours mapped
 * through the zone and spread over the real time a local hour spans: two hours at a daylight-saving fall-back, and
 * offsets such as +05:30 line up.
 */
export function hourlyValue(sessions, timeZone = "UTC") {
  const cells = new Map();
  for (const session of sessions ?? []) {
    for (const [day, hour, , values] of ledgerCells(session.velocity)) {
      const key = `${day}|${hour}`;
      cells.set(key, (cells.get(key) ?? 0) + (values[0] || 0));
    }
  }
  let keys = sliceKeys.get(timeZone);
  if (!keys) { keys = new Map(); sliceKeys.set(timeZone, keys); }
  const spans = new Map();
  const localKey = (slice) => {
    let key = keys.get(slice);
    if (key === undefined) { key = zonedHourKey(slice, timeZone); keys.set(slice, key); }
    return key;
  };
  const span = (key, slice) => {
    let seconds = spans.get(key);
    if (seconds === undefined) {
      seconds = 0;
      for (let t = slice - 2 * HOUR; t < slice + 2 * HOUR; t += QUARTER) if (localKey(t) === key) seconds += QUARTER;
      spans.set(key, seconds);
    }
    return seconds;
  };
  /** Value between two instants; partial hours count in proportion, assuming even activity within the hour. */
  function between(from, to) {
    if (!(to > from) || !cells.size) return 0;
    let total = 0;
    for (let slice = Math.floor(from / QUARTER) * QUARTER; slice < to; slice += QUARTER) {
      const key = localKey(slice), value = cells.get(key);
      if (!value) continue;
      total += value * (Math.min(to, slice + QUARTER) - Math.max(from, slice)) / span(key, slice);
    }
    return total;
  }
  return { between, empty: cells.size === 0 };
}

/** Sessions with activity between two instants, from the local hours of their activity ledger. */
function activeSessions(sessions, from, to, timeZone) {
  if (!(to > from)) return 0;
  let keys = sliceKeys.get(timeZone);
  if (!keys) { keys = new Map(); sliceKeys.set(timeZone, keys); }
  const activeHours = new Set();
  // Calendar hour numbers cannot be added to midnight: an hour may repeat or be skipped when clocks change.
  for (let slice = Math.floor(from / QUARTER) * QUARTER; slice < to; slice += QUARTER) {
    let key = keys.get(slice);
    if (key === undefined) { key = zonedHourKey(slice, timeZone); keys.set(slice, key); }
    activeHours.add(key);
  }
  return sessions.filter((session) => ledgerCells(session.velocity).some(([day, hour]) => activeHours.has(`${day}|${hour}`))).length;
}

/** Unix seconds when the local calendar day `day` (`YYYY-MM-DD`) begins in `timeZone`. */
export function zonedDayStart(day, timeZone = "UTC") {
  const midnight = Date.parse(`${day}T00:00:00Z`) / 1000;
  for (let t = midnight - 15 * HOUR; t <= midnight + 15 * HOUR; t += QUARTER) if (zonedHourKey(t, timeZone).startsWith(`${day}|`)) return t;
  return midnight;
}

/**
 * The machines whose limits are in a limits snapshot, by key: every machine that answered or has last good limits, when
 * limits were read from several machines; null when they are this machine's alone.
 */
export const limitMachines = (limits) => limits?.machines ? new Set(limits.machines.filter((machine) => machine.state !== "failed" && machine.readAt).map(({ key }) => key)) : null;

/** The machines whose sessions a snapshot holds, by key: each one read now or from its last good snapshot; null before it arrives. */
export const sessionMachines = (snapshot) => snapshot
  ? new Set(snapshot.machines?.length ? snapshot.machines.filter((machine) => machine.state !== "failed" && machine.readAt).map(({ key }) => key) : [localMachine]) : null;

/**
 * The machines whose value counts: limits in (`limitMachines`) and sessions in (`sessions`, as `sessionMachines`; null while
 * unknown). A machine whose limits are in but whose sessions are not still moves the meters; its value is not counted.
 */
export function valuedMachines(limits, sessions) {
  const read = limitMachines(limits);
  return read && sessions ? new Set([...read].filter((key) => sessions.has(key))) : read;
}

/**
 * Which account each Claude or Codex session's value belongs to. Only sessions from machines whose limits were read can be
 * matched to the meters they moved: `read` is that set of machine keys (`limitMachines`), or null when limits are this
 * machine's alone; sessions from any other machine are `elsewhere`. A session's machine is its `machine`, else this one.
 * A Claude session joins the account logged into its profile on its machine (`historyProfile.profileKey` among the account's
 * profile keys there); one without a profile key (every Codex session today, Claude sessions without a native transcript)
 * joins the only account of its provider on its machine. Without `read`, the accounts are this machine's and their
 * `profileKeys` this machine's; those logged in here (with profile keys or names) are its accounts, unless none of a
 * provider is, since the ledger also keeps the history of accounts read on other machines. Everything else is
 * unattributed. Neither unattributed nor elsewhere sessions calibrate a meter.
 */
export function attributeSessions(sessions, accounts, { read = null } = {}) {
  const byProfile = new Map(), byAccount = new Map(), only = new Map();
  const here = (account) => identified(account.key) && Boolean(account.profileKeys?.length || account.profileNames?.length);
  const loggedIn = new Set((accounts ?? []).filter(here).map(({ provider }) => provider));
  for (const account of accounts ?? []) {
    byAccount.set(account.key, []);
    if (!identified(account.key)) continue;
    const places = read ? account.machines ?? [] : here(account) || !loggedIn.has(account.provider) ? [{ key: localMachine, profileKeys: account.profileKeys ?? [] }] : [];
    for (const { key: machine, profileKeys } of places) {
      const place = `${account.provider}|${machine}`;
      only.set(place, only.has(place) ? null : account.key);
      for (const profile of profileKeys) {
        const key = `${place}|${profile}`;
        // A profile may retain history from two logins; without account periods its sessions cannot choose either one.
        byProfile.set(key, byProfile.has(key) && byProfile.get(key) !== account.key ? null : account.key);
      }
    }
  }
  const counted = read ?? new Set([localMachine]);
  const unattributed = { claude: [], codex: [] }, elsewhere = { claude: [], codex: [] };
  for (const session of sessions ?? []) {
    if (!(session.provider in unattributed)) continue;
    const machine = session.machine ?? localMachine;
    if (!counted.has(machine)) { elsewhere[session.provider].push(session); continue; }
    const place = `${session.provider}|${machine}`, profile = session.historyProfile?.profileKey;
    const key = profile ? byProfile.get(`${place}|${profile}`) : only.get(place);
    (key ? byAccount.get(key) : unattributed[session.provider]).push(session);
  }
  return { byAccount, unattributed, elsewhere };
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * The reading a segment calibrates on: the first one at or past 100% (a cap, or the start of extra usage), else the last.
 * Value after the first full reading may not move the meter (a refused request, or extra usage the meter stops counting
 * at about 102%), so it never counts.
 */
function calibrationSample({ samples }) {
  const capped = samples.find((sample) => sample.used >= 100 || sample.status === "rejected");
  // A refusal can report 0% (or a tiny rounded level); it still marks the cap, but cannot calibrate value per percent.
  return capped ? capped.used >= calibrationFloor ? capped : null : samples.findLast((sample) => sample.used >= calibrationFloor) ?? null;
}

/**
 * Value per percent of a meter. Each segment contributes its calibration reading divided into the account's value from
 * the segment start to that reading. Segments whose value explains almost none of the movement are dropped as outliers,
 * and the median of the rest needs `calibrationMinimum` segments.
 */
export function calibrate(meter, value, planType = undefined) {
  if (planType === "other" || planType === null) return emptyCalibration();
  const candidates = [];
  for (const cycle of meter?.cycles ?? []) {
    // A cycle spanning tiers has no reliable zero baseline for either allowance.
    const plans = new Set(cycle.samples.map((sample) => sample.planType ?? null));
    if (plans.size > 1 || (planType !== undefined && !plans.has(planType))) continue;
    for (const segment of cycle.segments) {
      const sample = calibrationSample(segment);
      if (!sample) continue;
      const spent = value.between(segment.start, sample.t);
      if (spent > 0) candidates.push({ resetsAt: cycle.resetsAt, start: segment.start, at: sample.t, used: sample.used, spent, perPercent: spent / sample.used });
    }
  }
  const typical = median(candidates.map((point) => point.perPercent));
  const points = candidates.filter((point) => point.perPercent >= typical * outlierShare);
  const values = points.map((point) => point.perPercent);
  return {
    perPercent: points.length >= calibrationMinimum ? median(values) : null, cycles: points.length, excluded: candidates.length - points.length, points,
    low: values.length ? Math.min(...values) : null, high: values.length ? Math.max(...values) : null,
  };
}

const emptyCalibration = () => ({ perPercent: null, cycles: 0, excluded: 0, points: [], low: null, high: null });

/**
 * Closed cycles of a meter: how much of each reset was used before it rolled over. A closing reading long before the
 * reset is a lower bound (`expired` null), and an early or in-place reset restores the level before it only when that
 * level was observed close to it. `creditHistory` rows are [provider, account, observedAt, available]; a drop in the
 * account's banked count across an early reset attributes it to a redeemed credit.
 */
export function resetHistory(meter, perPercent = null, creditHistory = []) {
  return (meter?.cycles ?? []).filter((cycle) => cycle.closed).map((cycle) => {
    const rate = typeof perPercent === "function" ? perPercent(cycle) : perPercent;
    const { redeemed, worth, limit } = resetContext(meter, rate, creditHistory);
    const closing = cycle.segments.at(-1);
    const lowerBound = closing.peak < 100 && cycle.end - closing.last.t > limit;
    const restored = cycle.endedEarly && !lowerBound ? Math.min(100, closing.last.used) : null;
    const expired = cycle.endedEarly || lowerBound ? null : Math.max(0, 100 - Math.min(100, closing.peak));
    return {
      resetsAt: cycle.resetsAt, start: cycle.start, end: cycle.end, peak: Math.min(100, closing.peak), lowerBound, endedEarly: cycle.endedEarly,
      cause: cycle.endedEarly ? (redeemed(closing.last.t, cycle.end) ? "credit" : "unknown") : null,
      restored, restoredUsd: worth(restored), inPlace: inPlaceResets(meter, cycle, rate, creditHistory),
      capped: cycle.cappedAt !== null, lockedSeconds: lockedSeconds(cycle),
      expired, expiredUsd: worth(expired),
    };
  });
}

function resetContext(meter, perPercent, creditHistory) {
  const counts = (creditHistory ?? []).filter((row) => row[0] === meter?.provider && row[1] === meter?.account);
  return {
    redeemed: (from, to) => counts.some((row, index) => index > 0 && row[3] < counts[index - 1][3] && counts[index - 1][2] <= to + 600 && row[2] >= from - 600),
    worth: (percent) => percent !== null && perPercent !== null ? percent * perPercent : null,
    limit: unobservedLimit(meter),
  };
}

/** In-place resets inside a cycle, live or closed. Each restores the level before the fall, never counted as waste. */
export function inPlaceResets(meter, cycle, perPercent = null, creditHistory = []) {
  const { redeemed, worth, limit } = resetContext(meter, perPercent, creditHistory);
  return cycle.segments.slice(1).filter((segment) => segment.before).map((segment) => {
    const level = segment.before.used >= 100 || segment.samples[0].t - segment.before.t <= limit ? Math.min(100, segment.before.used) : null;
    return { at: segment.start, restored: level, restoredUsd: worth(level), cause: redeemed(segment.before.t, segment.samples[0].t) ? "credit" : "provider" };
  });
}

/** A closed cycle whose closing level is known: it neither ended early nor stopped reporting long before its reset. */
export const exactClose = (cycle) => !cycle.endedEarly && !cycle.lowerBound;

/** Session-window cycles that overlap the trailing span, with lockouts and the idle gaps between windows. */
export function sessionWindows(meter, now, span = 7 * DAY) {
  const from = now - span;
  const windows = (meter?.cycles ?? []).filter((cycle) => cycle.end > from).map((cycle) => ({
    start: cycle.start, end: cycle.end, resetsAt: cycle.resetsAt, active: !cycle.closed,
    peak: Math.min(100, Math.max(...cycle.segments.map((segment) => segment.peak))),
    cappedAt: cycle.cappedAt, lockedSeconds: lockedSeconds(cycle, now),
    lockouts: cycle.segments.flatMap((segment) => segment.lockouts).map(([start, end]) => [start, Math.min(end, now)]).filter(([start, end]) => end > start),
  }));
  const closed = windows.filter((window) => !window.active);
  return {
    windows, from, to: now,
    capped: windows.filter((window) => window.cappedAt !== null).length,
    lockedSeconds: windows.reduce((total, window) => total + window.lockedSeconds, 0),
    averagePeak: closed.length ? closed.reduce((total, window) => total + window.peak, 0) / closed.length : null,
  };
}

export const redeemWhere = {
  codex: "Redeem it from Codex's usage settings in the Codex app or on chatgpt.com.",
};

/**
 * Banked resets of one Codex account as the provider reports them. A reset restarts its windows at 0%, so it is worth
 * what has been used when it is redeemed: at most a full window. `summary` is the account's `codex` summary.
 */
export function bankedResets({ provider, summary = null, weekly = null, session = null, perPercent = null, sessionPerPercent = null, now }) {
  const credits = [];
  const reported = provider === "codex" ? summary?.resetCredits ?? null : null;
  if (reported) {
    const listed = (reported.credits ?? []).filter((credit) => credit.status === "available");
    for (const credit of listed) credits.push({ scope: credit.scope === "unknown" ? "all" : credit.scope, expiresAt: credit.expiresAt, grantedAt: credit.grantedAt, source: "provider" });
    for (let index = listed.length; index < reported.available; index += 1) credits.push({ scope: "all", expiresAt: null, grantedAt: null, source: "provider" });
  }
  const usable = credits.filter((credit) => credit.expiresAt === null || credit.expiresAt > now)
    .sort((left, right) => (left.expiresAt ?? Infinity) - (right.expiresAt ?? Infinity));
  const covers = (credit, base) => credit.scope === "all" || credit.scope === base;
  const fullValue = (credit) => covers(credit, "seven_day") ? (perPercent !== null ? 100 * perPercent : null) : sessionPerPercent !== null ? 100 * sessionPerPercent : null;
  const nowValue = (credit) => covers(credit, "seven_day")
    ? (weekly?.cycle && perPercent !== null ? Math.min(100, weekly.used) * perPercent : null)
    : (session?.cycle && sessionPerPercent !== null ? Math.min(100, session.used) * sessionPerPercent : null);
  const values = usable.map(fullValue);
  return {
    provider, credits: usable, available: usable.length, known: reported !== null,
    observedAt: reported ? summary.observedAt : null,
    nextExpiry: usable.find((credit) => credit.expiresAt !== null)?.expiresAt ?? null,
    upToUsd: values.every((value) => value !== null) ? values.reduce((total, value) => total + value, 0) : null,
    fullValue, nowValue,
  };
}

/**
 * Plan price, capacity and extraction over `days`, at API-equivalent list prices. Only an individually paid plan has a
 * personal price; organization-paid seats (Team, Enterprise, Business) get API value without a price multiple. `payer`
 * overrides the plan's default. `extracted` is null when the account's value cannot be measured.
 */
export function economics({ provider, planId, payer = null, perPercent, extracted, days }) {
  const plan = planFor(provider, planId);
  const paidBy = plan ? payer ?? plan.payer : null;
  const monthlyPrice = paidBy === "individual" ? plan.monthlyUsd : null;
  const weeklyCapacity = perPercent !== null && perPercent !== undefined ? perPercent * 100 : null;
  const price = monthlyPrice !== null ? monthlyPrice * days / MONTH_DAYS : null;
  const potential = weeklyCapacity !== null ? weeklyCapacity * days / 7 : null;
  return {
    plan, payer: paidBy, monthlyPrice, weeklyCapacity, monthlyPotential: weeklyCapacity !== null ? weeklyCapacity * MONTH_DAYS / 7 : null,
    days, price, potential, extracted,
    multiple: price !== null && price > 0 && extracted !== null ? extracted / price : null,
    utilization: potential && extracted !== null ? extracted / potential : null,
  };
}

/**
 * The meters worth showing for an account: weekly and 5-hour apart from the rest (model-specific and other scoped limits).
 * Retired meters and scoped meters that never moved off 0% are left out; a 5-hour meter with no open window stays while
 * the provider still reports it, so a returning limit shows again.
 */
export function visibleMeters(item) {
  const shown = (live) => live && live.state !== "retired" && !live.meter.retired;
  return {
    weekly: shown(item.weekly) ? item.weekly : null,
    session: shown(item.session) ? item.session : null,
    extra: item.live.filter((live) => live !== item.weekly && live !== item.session && shown(live) && !unusedExtraMeter(live.meter)),
  };
}

/** A model-specific or other extra limit that never moved off 0%: the view and `limits` leave it out. */
export const unusedExtraMeter = (meter) => meter.meter !== weeklyMeter && meter.meter !== sessionMeter
  && !meter.cycles.some((cycle) => cycle.samples.some((sample) => sample.used > 0));

/**
 * One status per account and its urgency (lower `rank` first): a cap, extra usage, then the soonest run-out, including a
 * week used up fast before a projection has evidence (`early-burn`, `since` its start), then a 5-hour run-out, projected or
 * used up fast; on-track accounts by how full they are; stale, idle and unidentified accounts last. `used` is the weekly
 * level, capped at 100.
 */
export function limitStatus(item, now) {
  const open = (live) => live?.cycle && live.state !== "retired" ? live : null;
  const weekly = open(item.weekly), session = open(item.session);
  const used = weekly ? Math.min(100, weekly.used) : 0;
  const status = (kind, tone, rank, extra = {}) => ({ kind, tone, rank, used, at: null, until: null, since: null, early: null, meter: "weekly", ...extra });
  if (!item.identified) return status("levels-only", "muted", 9);
  if (weekly?.state === "capped") return status("capped", "danger", 0, { until: weekly.cycle.resetsAt });
  if (session?.state === "capped" && session.cycle.resetsAt > now) return status("capped", "danger", 1, { until: session.cycle.resetsAt, meter: "session" });
  if (weekly?.state === "overage") return status("overage", "warn", 2, { until: weekly.cycle.resetsAt });
  if (weekly?.capsEarly) return status("runs-out", "warn", 3, { at: weekly.capAt, early: weekly.cycle.resetsAt - weekly.capAt });
  if (weekly?.burnAt) return status("early-burn", "warn", weekly.used >= 50 ? 3 : 4, { at: weekly.burnAt, since: weekly.segment.start });
  if (weekly?.mayBeUsedUp) return status("may-be-used-up", "warn", 4, { since: weekly.observedAt });
  if (session?.capsEarly && !session.stale) return status("runs-out", "warn", 5, { at: session.capAt, early: session.cycle.resetsAt - session.capAt, meter: "session" });
  if (session?.burnAt) return status("early-burn", "warn", 5, { at: session.burnAt, since: session.segment.start, meter: "session" });
  if (weekly && (weekly.stale || weekly.state === "unreported")) return status("stale", "muted", 7, { since: weekly.observedAt });
  if (weekly) return status(weekly.tooEarly ? "too-early" : "on-track", weekly.tooEarly ? "muted" : "ok", 6);
  return status("idle", "muted", 8, { until: item.weekly?.nextResetAt ?? null, confirmed: item.weekly?.confirmedIdle ?? false });
}

/** Most urgent first: by rank, then the sooner run-out, then the fuller weekly meter. */
export const compareUrgency = (left, right) => left.rank - right.rank || (left.at ?? Infinity) - (right.at ?? Infinity) || right.used - left.used;

/**
 * Pace of a live meter in percent per hour: the current segment's, the whole cycle's (levels restored by in-place resets
 * count as used), and the most that lasts until the reset.
 */
export function meterPace(live, now) {
  if (!live?.cycle) return null;
  const { cycle } = live;
  const spent = cycle.segments.slice(1).filter((segment) => segment.before).reduce((total, segment) => total + Math.min(100, segment.before.used), 0) + Math.min(100, live.used);
  return {
    segment: (live.rate ?? 0) * HOUR,
    cycle: spent / Math.max(1, (Math.min(now, cycle.resetsAt) - cycle.start) / HOUR),
    budget: live.remaining > 0 ? Math.max(0, 100 - live.used) / Math.max(1, live.remaining / HOUR) : null,
  };
}

/** Meter-only utilization: the mean closing level of recent exactly observed weekly resets, with the live projection once it has evidence. */
export function resetUtilization(history, live, limit = 6) {
  const closed = history.filter(exactClose).slice(-limit).map((cycle) => cycle.peak);
  const projected = live?.cycle && live.projected !== null && live.elapsed >= 0.15 ? Math.min(100, live.projected) : null;
  const values = projected !== null ? [...closed, projected] : closed;
  return values.length ? { mean: values.reduce((total, value) => total + value, 0) / values.length, closed: closed.length, includesProjection: projected !== null } : null;
}

const duration = (seconds) => {
  const minutes = Math.round(Math.max(0, seconds) / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 48) return rest && hours < 10 ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24), leftover = hours % 24;
  return leftover ? `${days}d ${leftover}h` : `${days}d`;
};
export { duration as formatDuration };

function readingPlanPeriods(meters, from, to) {
  const instants = new Map();
  for (const meter of meters) for (const row of meter.planReadings ?? []) {
    const previous = instants.get(row.t);
    instants.set(row.t, previous && previous !== row.planType ? "other" : row.planType);
  }
  const changes = [];
  for (const [at, planType] of [...instants].sort((a, b) => a[0] - b[0])) {
    if (at > to) continue;
    if (changes.at(-1)?.planType !== planType) changes.push({ at, planType });
  }
  if (!changes.length) return [{ from, to, planType: null }];
  const periods = [];
  let start = from, planType = null;
  for (const change of changes) {
    if (change.at <= from) { planType = change.planType; continue; }
    periods.push({ from: start, to: change.at, planType });
    start = change.at; planType = change.planType;
  }
  periods.push({ from: start, to, planType });
  return periods;
}

/**
 * Everything the Subscription view and `limits` report show for one account. `sessions` are the account's own sessions
 * (`attributeSessions`); `range` is the selected period in Unix seconds, clamped here to the account's first reading and to
 * now, so price and capacity are never prorated over days before the meters or the rest of today. `value.before` is the
 * account's value in the range before its first reading, which is therefore not counted; `value.sessions` counts the
 * sessions active in the counted period.
 */
export function accountUtilization({ account, meters, sessions = [], timeZone = "UTC", now, range, planId = account.plan, planOverride = false, payer = null, creditHistory = [], basis = "none" }) {
  const own = meters.filter((meter) => meter.provider === account.provider && meter.account === account.key);
  const real = identified(account.key);
  const weekly_ = own.find((meter) => meter.meter === weeklyMeter) ?? null;
  const session_ = own.find((meter) => meter.meter === sessionMeter) ?? null;
  const value = hourlyValue(real ? sessions : [], timeZone);
  const tagged = account.provider === "codex" && own.some((meter) => meter.planReadings?.length);
  const currentType = tagged ? readingPlanPeriods(own, 0, now)?.at(-1)?.planType ?? null : undefined;
  const byPlan = new Map();
  const forPlan = (type) => {
    if (!byPlan.has(type)) byPlan.set(type, real && weekly_ ? calibrate(weekly_, value, type) : emptyCalibration());
    return byPlan.get(type);
  };
  const calibration = forPlan(currentType);
  const sessionCalibration = real && session_ ? calibrate(session_, value, currentType) : null;
  const reportedUntil = latestReading(own);
  const live = own.map((meter) => liveMeter(meter, now, reportedUntil, { project: real }));
  const weekly = weekly_ ? live[own.indexOf(weekly_)] : null, session = session_ ? live[own.indexOf(session_)] : null;
  const cycleRate = (cycle) => {
    const types = new Set(cycle.samples.map((sample) => sample.planType ?? null));
    return types.size === 1 ? forPlan(tagged ? cycle.samples[0].planType ?? null : undefined).perPercent : null;
  };
  const history = weekly_ ? resetHistory(weekly_, cycleRate, creditHistory) : [];
  const first = firstReading(own);
  const from = Math.max(range.from, first ?? range.to), to = Math.max(from, Math.min(range.to, now));
  const days = (to - from) / DAY;
  const measured = real && basis !== "none";
  const periods = tagged ? readingPlanPeriods(own, from, to) : null;
  const periodEconomics = (period) => economics({
    provider: account.provider, planId: planOverride ? planId : period.planType, payer,
    perPercent: forPlan(period.planType).perPercent,
    extracted: measured ? value.between(period.from, period.to) : null, days: (period.to - period.from) / DAY,
  });
  const money = economics({ provider: account.provider, planId, payer, perPercent: calibration.perPercent, extracted: measured ? value.between(from, to) : null, days });
  const economicPeriods = periods?.map(periodEconomics) ?? [money];
  if (periods) {
    money.price = economicPeriods.every((period) => period.price !== null) ? economicPeriods.reduce((sum, period) => sum + period.price, 0) : null;
    money.potential = economicPeriods.every((period) => period.potential !== null) ? economicPeriods.reduce((sum, period) => sum + period.potential, 0) : null;
    money.multiple = economicPeriods.every((period) => period.price > 0) && money.extracted !== null ? money.extracted / money.price : null;
    money.utilization = money.potential > 0 && money.extracted !== null ? money.extracted / money.potential : null;
  }
  return {
    account, key: account.key, provider: account.provider, label: account.label, identified: real, planId,
    meters: own, weeklyMeter: weekly_, sessionMeter: session_, weekly, session, live, history,
    restarts: weekly?.cycle ? inPlaceResets(weekly_, weekly.cycle, calibration.perPercent, creditHistory) : [],
    windows: session_ ? sessionWindows(session_, now) : null,
    calibration, sessionCalibration,
    resets: bankedResets({ provider: account.provider, summary: account.codex, weekly, session, perPercent: calibration.perPercent, sessionPerPercent: sessionCalibration?.perPercent ?? null, now }),
    economics: money, ...(periods ? { economicPeriods } : {}),
    period: { from, to, days, firstReading: first },
    value: {
      basis: real ? basis : "none", sessions: measured ? activeSessions(sessions, from, to, timeZone) : 0,
      before: measured ? value.between(range.from, Math.min(from, range.to, now)) : 0,
    },
    utilization: resetUtilization(history, weekly),
  };
}

/**
 * Totals across accounts that compare like with like. The value multiple and the month of full use use only accounts with
 * a personal price, so an unpriced, free or employer-paid account never inflates them; the rest is reported beside
 * (`otherMonthlyPotential`, `organization`, `unpriced`). Accounts excluded from value totals, accounts whose value cannot
 * be measured, accounts with no reading in the selected dates and readings without an account are left out;
 * `beforeReadings` is the measured accounts' value before their first readings, which no total counts.
 */
export function subscriptionTotals(items, unattributed = { claude: 0, codex: 0 }) {
  const measured = items.filter((item) => item.identified && !item.excluded && item.economics.extracted !== null);
  const included = measured.filter((item) => item.period.days > 0);
  const sum = (list, pick) => list.reduce((total, item) => total + (pick(item) ?? 0), 0);
  const calibrated = included.filter((item) => item.economics.potential !== null);
  const currentCalibrated = included.filter((item) => item.economics.monthlyPotential !== null);
  const pricedPotential = currentCalibrated.filter((item) => item.economics.monthlyPrice > 0);
  const otherPotential = currentCalibrated.filter((item) => !pricedPotential.includes(item));
  const organization = included.filter((item) => (item.economicPeriods ?? [item.economics]).some((period) => period.payer === "organization"));
  const unpriced = included.filter((item) => (item.economicPeriods ?? [item.economics]).some((period) => period.payer !== "organization" && !(period.price > 0)));
  const allPeriods = included.flatMap((item) => item.economicPeriods ?? [item.economics]);
  const paidPeriods = allPeriods.filter((period) => period.price > 0 && period.extracted !== null);
  const price = paidPeriods.reduce((total, period) => total + period.price, 0), pricedValue = paidPeriods.reduce((total, period) => total + period.extracted, 0);
  const paidAccounts = included.filter((item) => (item.economicPeriods ?? [item.economics]).some((period) => paidPeriods.includes(period))).length;
  const periodValue = (test) => allPeriods.filter(test).reduce((total, period) => total + (period.extracted ?? 0), 0);
  const potential = sum(calibrated, (item) => item.economics.potential);
  const monthlyPrice = sum(pricedPotential, (item) => item.economics.monthlyPrice);
  const reset = included.filter((item) => item.utilization);
  return {
    extracted: sum(included, (item) => item.economics.extracted),
    unattributed: (unattributed.claude ?? 0) + (unattributed.codex ?? 0),
    beforeReadings: sum(measured, (item) => item.value.before),
    priced: { accounts: paidAccounts, extracted: pricedValue, price, multiple: price > 0 ? pricedValue / price : null },
    organization: { accounts: organization.length, extracted: periodValue((period) => period.payer === "organization") },
    unpriced: { accounts: unpriced.length, extracted: periodValue((period) => period.payer !== "organization" && !(period.price > 0)) },
    monthlyPotential: pricedPotential.length ? sum(pricedPotential, (item) => item.economics.monthlyPotential) : null, monthlyPrice,
    potentialMultiple: monthlyPrice > 0 ? sum(pricedPotential, (item) => item.economics.monthlyPotential) / monthlyPrice : null,
    otherMonthlyPotential: otherPotential.length ? sum(otherPotential, (item) => item.economics.monthlyPotential) : null,
    capacityUsed: potential > 0 ? sum(calibrated, (item) => item.economics.extracted) / potential : null, potential: calibrated.length ? potential : null,
    resetsUsed: reset.length ? sum(reset, (item) => item.utilization.mean) / reset.length : null,
    banked: sum(included, (item) => item.resets.upToUsd),
  };
}

/**
 * The Subscription view's model: one entry per account, totals, the value nobody's account could claim and the value of
 * machines whose limits were not read. `plans` and `payers` hold per-account overrides by account key (`"none"` excludes
 * an account from value totals but keeps its meters).
 */
export function subscriptionModel({ limits, sessions, timeZone = "UTC", now, range, plans = {}, payers = {} }) {
  const accounts = limits?.accounts ?? [], read = limitMachines(limits);
  const meters = buildMeters(limits?.observations ?? [], now, limits?.meters ?? []);
  const { byAccount, unattributed, elsewhere } = attributeSessions(sessions, accounts, { read });
  const items = accounts.map((account) => {
    const own = byAccount.get(account.key) ?? [], override = plans[account.key];
    const keyed = (read ? account.machines ?? [] : [account]).some(({ profileKeys }) => profileKeys?.length);
    // Whether this account's value can be measured at all: an account with no attributable sessions has unknown value, not zero.
    const basis = !identified(account.key) || !own.length ? "none"
      : own.some((session) => session.historyProfile) || (account.provider === "claude" && keyed) ? "profiles" : "provider";
    return {
      ...accountUtilization({
        account, meters, sessions: own, timeZone, now, range, planId: override === "none" ? null : override || account.plan,
        planOverride: Boolean(override && override !== "none"), payer: payers[account.key] ?? null, creditHistory: limits?.resetCreditHistory ?? [], basis,
      }),
      excluded: override === "none",
    };
  });
  const until = Math.min(range.to, now), between = (list) => hourlyValue(list, timeZone).between(range.from, until);
  const unclaimed = { claude: between(unattributed.claude), codex: between(unattributed.codex) };
  return { meters, accounts: items, totals: subscriptionTotals(items, unclaimed), unattributed: unclaimed, elsewhere: { claude: between(elsewhere.claude), codex: between(elsewhere.codex) } };
}

/** Percent rates keep one decimal below 10 so a small daily budget never reads as 0%. */
const rate = (value) => `${value < 10 ? (Math.round(value * 10) / 10).toString() : Math.round(value).toString()}%`;

const usd = (value) => value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${Math.round(value)}`;

/** Why limit history is not being kept, by `LimitsSnapshot.ledger`; the `limits` command says the same. */
export const historyNotes = {
  off: { title: "Limit history is not being kept", detail: "With --no-index, only readings still in provider logs are shown. Claude event logs rotate within a few days, so reset history needs the private ledger." },
  unreadable: { title: "Limit history is not being kept", detail: "The limits ledger was written by another version of session-analytics, or this user may not replace it, so it was left untouched. Only readings still in provider logs are shown until that is resolved." },
  unwritable: { title: "Limit history could not be saved this time", detail: "The private ledger could not be written; the next harvest reads the same records again." },
};

/** Urgency decides the order; dollars only break ties within a tier. */
const tiers = { act: 0, watch: 1, setup: 2, good: 3 };

/**
 * Who turned Claude extra usage off. Anthropic reports a personal plan's switch as the organization's too
 * (`org_level_disabled`), so only an employer-paid seat is told it is the organization's.
 */
export const extraUsageOff = (item) => item.economics?.payer === "organization"
  ? `Extra usage is off${item.account.extraUsage?.disabledReason === "org_level_disabled" ? " for this organization" : ""}`
  : "Extra usage is turned off for this account (claude.ai settings)";

/** What happens after a cap on this account: Codex credits, Claude extra usage, and paid resets. */
function afterCap(item) {
  if (item.provider === "codex") {
    const credits = item.account.codex?.credits;
    const balance = credits?.hasCredits && credits.balance ? ` Codex continues on your ${integer(Math.round(credits.balance))} credits after the included allowance runs out.` : "";
    return `${balance} A paid instant reset (chatgpt.com/codex/purchase/reset) also restarts both windows; it is worth it only if the blocked days are worth more than its price.`;
  }
  const extra = item.account.extraUsage;
  if (extra?.extraUsage === "disabled") return ` ${extraUsageOff(item)}, so a cap means waiting for the reset.`;
  if (extra?.extraUsage === "enabled" || extra?.extraUsage === "in-use") return " Extra usage is on for this account: past the cap you pay API rates.";
  return "";
}

/**
 * Ranked, data-backed suggestions per account. Each carries a tone (`act`, `watch`, `setup`, `good`), the provider and
 * account it concerns (or null), and, where calibration allows, the API-equivalent value at stake. Items sort by tone,
 * then urgency, then value.
 */
export function recommendations(items, { now, sources = [], persisted = true, ledger = persisted ? "ok" : "off", codexAccount = "ok", formatTime = (seconds) => new Date(seconds * 1000).toISOString() }) {
  const advice = [];
  const accounts = items.filter((item) => item.identified);
  // `kind` names the rule: with the provider and account it identifies a suggestion across refreshes.
  const push = (item, kind, entry) => advice.push({ kind, provider: item?.provider ?? null, account: item?.key ?? null, impactUsd: null, ...entry });
  // "Claude Max 20x" or "Claude Team seat"; the full label when two accounts would share the plan name.
  const shortName = (item) => {
    const plan = planFor(item.provider, item.planId);
    return plan && accounts.filter((other) => other.provider === item.provider && other.planId === item.planId).length === 1
      ? plan.label.replace(/ \(seat type unknown\)$/, " seat") : item.label;
  };
  // Another login of the same provider is a profile to switch to; another provider is named by its plan.
  const target = (other, item) => {
    const names = other.account.profileNames ?? [];
    if (other.provider !== item.provider || !names.length) return shortName(other);
    const named = names.find((name) => name !== "default");
    return named ? `the ${named} profile` : "the default profile";
  };
  const headroom = (item) => 100 - Math.min(100, item.weekly.projected ?? item.weekly.used);
  const roomy = (item) => item.weekly?.cycle && !item.weekly.stale && item.weekly.state === "active" && !item.weekly.capsEarly && !item.weekly.burnAt && headroom(item) >= 15;
  // Where work can go when this account runs out: another account with room, the same provider first.
  const alternative = (item) => accounts.filter((other) => other !== item && roomy(other))
    .sort((left, right) => (left.provider === item.provider ? 0 : 1) - (right.provider === item.provider ? 0 : 1) || headroom(right) - headroom(left))[0] ?? null;
  const elsewhere = (other) => other ? `${shortName(other)} is at ${Math.round(other.weekly.used)}%${other.weekly.projected !== null ? ` and on pace for ${Math.round(Math.min(100, other.weekly.projected))}% at its reset` : ""}` : "";

  for (const item of accounts) {
    const name = shortName(item), weekly = item.weekly, k = item.calibration.perPercent;
    if (weekly?.cycle) {
      const other = alternative(item);
      if (weekly.state === "capped" || weekly.state === "overage") {
        const overage = weekly.state === "overage";
        push(item, "weekly-used-up", {
          tone: "act", score: 1100,
          title: overage ? `${name} is past its weekly allowance and on paid extra usage until ${formatTime(weekly.cycle.resetsAt)}` : `${name} weekly allowance is used up until ${formatTime(weekly.cycle.resetsAt)}`,
          detail: other ? `${elsewhere(other)}. Point background agents at ${target(other, item)} until the reset.${afterCap(item)}`
            : overage ? "Work continues at API rates until the reset, so move work that can wait until after it."
            : `Until the reset, only ${item.provider === "codex" ? "a banked or paid reset, or credits," : "extra usage"} keep${item.provider === "codex" ? "" : "s"} this account working.${afterCap(item)}`,
        });
      } else if (weekly.capsEarly) {
        const early = weekly.cycle.resetsAt - weekly.capAt;
        push(item, "runs-out", {
          tone: "act", score: 1000 + early / HOUR,
          title: other ? `${name} runs out before its ${formatTime(weekly.cycle.resetsAt)} reset; ${elsewhere(other)}`
            : `${name} weekly allowance runs out in ${duration(weekly.capAt - now)}, ${duration(early)} before it resets`,
          detail: `At this pace it runs out ${formatTime(weekly.capAt)}. You are using about ${rate(weekly.rate * DAY)} a day; the allowance supports ${rate(weekly.dailyBudget)} a day until ${formatTime(weekly.cycle.resetsAt)}. ` +
            (other ? `Point background agents and long-running work at ${target(other, item)}, and keep this account for interactive work. ` : "Keep the remaining allowance for interactive work, and run subagents and bulk jobs on cheaper models.") + afterCap(item),
        });
      } else if (weekly.burnAt) {
        // Too early for a projection: the pace so far, not a forecast, and no stronger than the level behind it. Acted on, it
        // ranks with confident run-outs by how early it runs out, below a used-up week.
        const act = weekly.used >= 50;
        push(item, "early-burn", {
          tone: act ? "act" : "watch", score: act ? Math.min(1099, 1000 + (weekly.cycle.resetsAt - weekly.burnAt) / HOUR) : 950,
          title: `${name}: ${Math.round(weekly.used)}% used in ${duration(now - weekly.segment.start)}; at this pace it runs out ${formatTime(weekly.burnAt)}`,
          detail: `You are using about ${rate(weekly.rate * DAY)} a day; the allowance supports ${rate(weekly.dailyBudget)} a day until ${formatTime(weekly.cycle.resetsAt)}. It is too early in the week to project, so this is the pace so far, not a forecast. ` +
            (other ? `Point background agents and long-running work at ${target(other, item)}. ` : "Keep the remaining allowance for interactive work, and run subagents and bulk jobs on cheaper models.") + afterCap(item),
        });
      } else if (weekly.mayBeUsedUp) {
        push(item, "may-be-used-up", {
          tone: "watch", score: 700,
          title: `${name} weekly allowance may already be used up`,
          detail: `The last reading, ${Math.round(weekly.used)}% at ${formatTime(weekly.observedAt)}, is ${duration(now - weekly.observedAt)} old, and the pace before it reaches 100% by now. The next reading from this account will tell; usage on other machines also moves this meter.`,
        });
      } else if (weekly.projected !== null && weekly.projected < 85 && weekly.remaining > 12 * HOUR) {
        const expiring = 100 - weekly.projected;
        push(item, "expiring-week", {
          tone: "watch", score: 500,
          title: `About ${expiring.toFixed(0)}% of this week's ${name} allowance will expire unused${k ? ` (≈ ${usd(expiring * k)} of API value)` : ""}`,
          detail: `At your current pace the meter closes near ${weekly.projected.toFixed(0)}% at ${formatTime(weekly.cycle.resetsAt)}. Using all of it takes about ${rate(weekly.dailyBudget)} a day. Queue overnight agent work on this account before the reset, such as test backfills, refactors, dependency upgrades and review passes.`,
          impactUsd: k ? expiring * k : null,
        });
      }
    }
    const exact = item.history.filter(exactClose);
    if (exact.length >= 2) {
      const unused = exact.reduce((total, cycle) => total + cycle.expired, 0) / exact.length;
      if (unused >= 15) push(item, "unused-resets", {
        tone: "watch", score: 400,
        title: `${name}'s last ${exact.length} observed weekly resets left an average of ${unused.toFixed(0)}% unused`,
        detail: `${k ? `That is about ${usd(unused * k)} of API-equivalent value a week (${usd(unused * k * MONTH_DAYS / 7)} a month). ` : ""}A steady daily target of about ${(100 / 7).toFixed(0)}% keeps each week fully used without running out early.`,
        impactUsd: k ? unused * k * MONTH_DAYS / 7 : null,
      });
      else if (exact.every((cycle) => cycle.peak >= 90)) push(item, "full-resets", {
        tone: "good", score: 50,
        title: `You use ${name}'s weekly resets almost fully`,
        detail: `Each of the last ${exact.length} observed weekly resets closed at 90% or more.`,
      });
    }
    const unobserved = item.history.filter((cycle) => cycle.lowerBound).length;
    if (unobserved >= 2 && exact.length < 2) push(item, "unobserved-closes", {
      tone: "setup", score: 160,
      title: `${name}: the closing level of ${unobserved} weekly resets was not observed`,
      detail: "Their last readings came long before the reset, so how much was left unused is unknown; they are left out of the averages and plan advice. A scheduled `session-analytics limits --quiet` every 20 minutes records each close this machine can see, including the Codex account read.",
    });
    if (item.windows && item.windows.capped > 0) {
      // Past 100% on extra usage, the weekly limit is the tighter one.
      const weeklyBinding = weekly?.capsEarly || weekly?.state === "capped" || weekly?.state === "overage";
      const other = alternative(item), session = item.session;
      // Locked out now, like a used-up week, when another account has room: switch. The week's lockouts are only watched.
      if (session?.state === "capped" && session.cycle.resetsAt > now && !weeklyBinding && other) push(item, "locked-out", {
        tone: "act", score: 1100,
        title: `${name} is locked out by its 5-hour limit until ${formatTime(session.cycle.resetsAt)}; switch to ${target(other, item)}`,
        detail: `This account's weekly allowance still has room, but no work runs on it until the 5-hour window resets. ${elsewhere(other)}.`,
      });
      push(item, "lockouts", {
        tone: "watch", score: 600 + Math.min(99, item.windows.lockedSeconds / HOUR),
        title: `Hit the ${name} 5-hour limit ${item.windows.capped} time${item.windows.capped === 1 ? "" : "s"} in 7 days (${duration(item.windows.lockedSeconds)} locked out)`,
        detail: weeklyBinding
          ? "The weekly allowance is the tighter limit this week, so these lockouts mostly pace you. Spread heavy work across more windows rather than pushing through one."
          : `A 5-hour window starts with your first message. Send a short message 2 to 3 hours before heavy work so a reset lands mid-session, and split large jobs across two windows.${other ? ` During a lockout, switch to ${target(other, item)}.` : ""}`,
      });
    }
    const plan = item.economics.plan;
    // Plan fit is personal: an employer's seat is not yours to change, and unobserved closes say nothing about fit.
    if (plan && item.economics.payer === "individual" && exact.length >= 3) {
      const recent = exact.slice(-4);
      const mean = recent.reduce((total, cycle) => total + cycle.peak, 0) / recent.length;
      const cappedWeeks = recent.filter((cycle) => cycle.capped).length;
      if (cappedWeeks >= 2 && plan.rank < topRank(item.provider)) push(item, "plan-up", {
        tone: "watch", score: 300,
        title: `${name} capped out in ${cappedWeeks} of the last ${recent.length} observed weeks`,
        detail: "If those lockouts cost you working time, the next tier up may be worth it. Compare the price difference with the value you produce in the blocked hours.",
      });
      if (mean < 30 && plan.rank >= 2) push(item, "plan-down", {
        tone: "watch", score: 350,
        title: `${name} weekly resets averaged ${mean.toFixed(0)}% over the last ${recent.length} observed weeks`,
        detail: "A lower tier would cover this level of use. Either move more work onto this subscription or downgrade to save the difference.",
      });
    }
    // Banked resets: when to redeem, when to hold, and what expires.
    const banked = item.resets;
    if (banked?.available) {
      const weeklyCredit = banked.credits.find((credit) => credit.scope !== "five_hour");
      const sessionCredit = banked.credits.find((credit) => credit.scope === "five_hour");
      const where = redeemWhere[item.provider] ?? "";
      const left = `${name} has ${banked.available} banked${banked.nextExpiry ? `; the next expires ${formatTime(banked.nextExpiry)}` : ""}.`;
      let timed = false;
      if (weeklyCredit && weekly?.cycle && !weekly.stale && (weekly.state === "capped" || weekly.used >= 90) && weekly.remaining > DAY) {
        timed = true;
        const restore = banked.nowValue(weeklyCredit);
        push(item, "redeem-now", {
          tone: "act", score: 1300,
          title: `Redeem a banked ${name} reset now: it restores ${Math.round(Math.min(100, weekly.used))}% of the week${restore !== null ? ` (≈ ${usd(restore)})` : ""}`,
          detail: `The weekly meter is at ${Math.round(weekly.used)}% with ${duration(weekly.remaining)} until the scheduled reset, so this is when a reset is worth the most: it restarts the week at 0%. ${left} ${where}`,
          impactUsd: restore,
        });
      } else if (weeklyCredit && weekly?.capsEarly) {
        timed = true;
        push(item, "hold-reset", {
          tone: "watch", score: 720,
          title: `Hold your banked ${name} reset until the weekly meter nears 100% (about ${formatTime(weekly.capAt)})`,
          detail: `A reset is worth what has been used when you redeem it: ${Math.round(weekly.used)}% now${k ? ` (≈ ${usd(weekly.used * k)})` : ""}, a full week near 100%${k ? ` (≈ ${usd(100 * k)})` : ""}. ${left} ${where}`,
          impactUsd: k ? (100 - weekly.used) * k : null,
        });
      }
      if (sessionCredit && item.session?.state === "capped" && item.session.cycle && item.session.cycle.resetsAt - now > HOUR && !(weekly?.capsEarly || weekly?.state === "capped")) {
        push(item, "redeem-session", {
          tone: "act", score: 1150,
          title: `A banked 5-hour reset would end this ${name} lockout ${duration(item.session.cycle.resetsAt - now)} early`,
          detail: `The weekly allowance still has room, so the 5-hour window is what is blocking you. ${left} ${where}`,
        });
      }
      const credit = banked.credits.find((entry) => entry.expiresAt !== null); // The soonest expiry is the one to act on.
      if (credit) {
        const remaining = credit.expiresAt - now, restore = banked.nowValue(credit);
        if (remaining <= 3 * DAY) push(item, "credit-expiring", {
          tone: "act", score: 1250 - remaining / HOUR,
          title: `A banked ${name} reset expires ${formatTime(credit.expiresAt)}, in ${duration(remaining)}`,
          detail: `Unused, it is worth nothing. Redeem it before then at the highest meter reading you reach${restore !== null ? `; right now it would restore ≈ ${usd(restore)}` : ""}. ${where}`,
          impactUsd: restore,
        });
        else if (!timed && credit.scope !== "five_hour" && weekly?.cycle && weekly.projected !== null && weekly.projected < 90 && credit.expiresAt < weekly.cycle.resetsAt + WEEK) push(item, "credit-unneeded", {
          tone: "watch", score: 650,
          title: `Your banked ${name} reset expires ${formatTime(credit.expiresAt)}, and at this pace you will not need it first`,
          detail: `Plan a heavy run on this account before then (a large refactor, test backfill or review sweep), let the weekly meter climb close to 100%, then redeem it to restore a full week${k ? ` (≈ ${usd(100 * k)})` : ""}. ${where}`,
          impactUsd: k ? 100 * k : null,
        });
      }
    }
    // Early resets that restored little: worth knowing if they were redeemed credits.
    const early = item.history.filter((cycle) => cycle.endedEarly && cycle.restored !== null && cycle.restored < 60 && cycle.end >= now - 30 * DAY);
    if (early.length) {
      const last = early.at(-1);
      push(item, "early-reset", {
        tone: "watch", score: 450,
        title: `${name} ${last.cause === "credit" ? "banked reset was redeemed" : "reset early"} at ${Math.round(last.restored)}% used${k ? `, restoring only ≈ ${usd(last.restored * k)}` : ""}`,
        detail: `A reset restarts the window at 0%, so it is worth what had been used when it happened. ${k ? `Taken near 100% it restores a full week, about ${usd(100 * k)}. ` : ""}If this was a reset credit you redeemed, save credits for when the meter is close to 100% with days left before the scheduled reset. Provider-wide resets are not in your control.`,
        impactUsd: k ? (100 - last.restored) * k : null,
      });
    }
  }
  // Capacity-bound only when every account with a fresh weekly reading is past the evidence threshold and running out.
  const fresh = accounts.filter((item) => item.weekly?.cycle && !item.weekly.stale);
  const exhausting = fresh.filter((item) => item.weekly.capsEarly || item.weekly.state === "capped" || item.weekly.state === "overage");
  if (fresh.length >= 2 && exhausting.length === fresh.length) {
    const lost = exhausting.map((item) => item.weekly.cycle.resetsAt - Math.max(now, item.weekly.capAt ?? now));
    const banked = exhausting.reduce((total, item) => total + (item.resets?.available ?? 0), 0);
    push(null, "capacity-bound", {
      tone: "act", score: 1200,
      title: "Every subscription runs out before its reset: you are capacity-bound, not under-using",
      detail: `At this pace you would have no allowance for ${duration(Math.min(...lost))} to ${duration(Math.max(...lost))} before the resets. You already extract more than the limits refill. Ration by priority: keep allowance for interactive work, batch background agents into the days after each reset, and use cheaper models for subagents.${banked ? ` Spend your ${banked} banked reset${banked === 1 ? "" : "s"} at the caps, not before.` : ""} Extra usage, credits, paid resets or another seat only pay off if the blocked hours are worth more than their price.`,
    });
  }
  const claudeSources = sources.filter((source) => source.source.startsWith("claude"));
  if (!items.some((item) => item.provider === "claude" && item.meters.length) && claudeSources.every((source) => source.status !== "ok")) push(null, "record-claude", {
    provider: "claude", tone: "setup", score: 200,
    title: "Record Claude limit meters",
    detail: "No Claude meter readings were found. Add `session-analytics limits statusline` as your Claude Code status line, or run Claude through a host that logs Agent SDK events, such as T3 Code.",
  });
  if (codexAccount === "unavailable" && accounts.some((item) => item.provider === "codex" && !item.resets.known)) push(null, "codex-account", {
    provider: "codex", tone: "setup", score: 180, title: "Banked Codex resets could not be read",
    detail: "The local Codex app-server did not answer, so banked resets and their expiry are unknown. Check that `codex` is installed and logged in; the next refresh retries.",
  });
  if (ledger !== "ok" && historyNotes[ledger]) push(null, "history", { tone: "setup", score: 150, ...historyNotes[ledger] });
  return advice.sort((left, right) => tiers[left.tone] - tiers[right.tone] || right.score - left.score || (right.impactUsd ?? 0) - (left.impactUsd ?? 0));
}
