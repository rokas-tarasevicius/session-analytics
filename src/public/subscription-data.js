// Subscription utilization: provider-reported limit meters joined with the activity ledger.
// Pure functions only; shared by the dashboard, the `limits` command and tests.
//
// Vocabulary
// - meter: one provider allowance (`claude five_hour`, `codex seven_day`), reported as percent used.
// - cycle: one reset window of a meter, identified by its reset instant.
// - $/%: API-equivalent value of local activity per percent of a meter, calibrated per cycle from your own history.
// - banked reset: a Codex reset credit you hold; redeeming restarts the windows at 0%.

import { ledgerCells } from "./velocity-data.js";
import { planFor } from "./subscription-plans.js";
import { integer, zonedHourKey } from "./format.js";

export const HOUR = 3600;
export const DAY = 86_400;
export const MONTH_DAYS = 30.4375;
/** Readings under this share of a window are too small to calibrate value per percent. */
const calibrationFloor = 5;

const sessionMeter = "five_hour";
const weeklyMeter = "seven_day";

export const providerNames = { claude: "Claude", codex: "Codex" };

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

/** Group observations into meters and reset cycles. A cycle ends at its reset, or earlier when the next cycle begins first. */
export function buildMeters(observations, now) {
  const meters = new Map();
  for (const observation of observations ?? []) {
    const key = `${observation.provider}|${observation.meter}`;
    let meter = meters.get(key);
    if (!meter) {
      meter = { key, provider: observation.provider, meter: observation.meter, label: meterLabel(observation.meter), windowMinutes: observation.windowMinutes, cycles: new Map() };
      meters.set(key, meter);
    }
    meter.windowMinutes ??= observation.windowMinutes;
    let cycle = meter.cycles.get(observation.resetsAt);
    if (!cycle) { cycle = { resetsAt: observation.resetsAt, samples: [] }; meter.cycles.set(observation.resetsAt, cycle); }
    cycle.samples.push({ t: observation.observedAt, used: observation.usedPercent, status: observation.status });
  }
  return [...meters.values()].map((meter) => {
    const seconds = meter.windowMinutes ? meter.windowMinutes * 60 : null;
    const ordered = [...meter.cycles.values()].sort((left, right) => left.resetsAt - right.resetsAt);
    const cycles = ordered.map((cycle, index) => {
      const samples = cycle.samples.sort((left, right) => left.t - right.t);
      const next = ordered[index + 1];
      const nextStart = next ? Math.min(...next.samples.map((sample) => sample.t)) : Infinity;
      const end = Math.min(cycle.resetsAt, nextStart);
      const start = seconds ? Math.min(cycle.resetsAt - seconds, samples[0].t) : samples[0].t;
      const peak = Math.max(...samples.map((sample) => sample.used));
      const capped = samples.find((sample) => sample.used >= 100 || sample.status === "rejected") ?? null;
      return {
        resetsAt: cycle.resetsAt, start, end, samples, peak, last: samples[samples.length - 1],
        cappedAt: capped ? capped.t : null,
        // A redeemed reset or a provider-wide reset before the scheduled instant; the unused remainder was not forfeited.
        endedEarly: end < cycle.resetsAt - 15 * 60,
        closed: end <= now,
      };
    });
    return { ...meter, cycles, primary: meterBase(meter.meter) === weeklyMeter && !meter.meter.includes(".") };
  }).sort((left, right) => left.provider.localeCompare(right.provider) || meterOrder(left.meter) - meterOrder(right.meter) || left.meter.localeCompare(right.meter));
}

function meterOrder(meter) {
  const base = meterBase(meter);
  return (meter.includes(".") ? 10 : 0) + (base === sessionMeter ? 0 : base === weeklyMeter ? 1 : 2);
}

export const findMeter = (meters, provider, meter) => meters.find((item) => item.provider === provider && item.meter === meter) ?? null;

/**
 * Live state of a meter: where it stands now, how fast it is moving, and where it lands at reset at this pace.
 * `reportedUntil` is the provider's latest reading on any meter: a meter the provider stopped reporting while others
 * continue is `unreported`, not still capped (Claude only includes some scoped meters while they matter).
 */
export function liveMeter(meter, now, reportedUntil = null) {
  const window = (meter.windowMinutes ?? 0) * 60;
  const cycle = meter.cycles.findLast((item) => !item.closed) ?? null;
  const previous = meter.cycles.findLast((item) => item.closed) ?? null;
  if (!cycle) return { meter, cycle: null, previous, state: "idle", used: 0 };
  const { last, start, resetsAt } = cycle;
  const used = last.used;
  const elapsed = window > 0 ? Math.min(1, Math.max(0, (now - start) / window)) : null;
  const active = Math.max(window > 0 && window <= 6 * HOUR ? 5 * 60 : HOUR, last.t - start);
  const rate = used / active; // percent per second, averaged over the cycle so far
  const recent = recentRate(cycle.samples, last.t, window > 6 * HOUR ? DAY : HOUR);
  const remaining = Math.max(0, resetsAt - now);
  // Extrapolating minutes of data across a week is noise: project once 5% of the window has passed or 10% is used.
  const confident = used >= 10 || elapsed === null || elapsed >= 0.05;
  const projected = confident ? used + rate * Math.max(0, resetsAt - last.t) : null;
  const unreported = reportedUntil !== null && last.t < reportedUntil - 2 * HOUR;
  const capped = !unreported && (used >= 100 || last.status === "rejected");
  const capAt = capped ? cycle.cappedAt ?? last.t : rate > 0 && projected !== null && projected > 100 ? last.t + (100 - used) / rate : null;
  const staleAfter = window > 6 * HOUR ? 12 * HOUR : HOUR;
  return {
    meter, cycle, previous, state: unreported ? "unreported" : capped ? "capped" : "active", used, elapsed, rate, recentRate: recent, remaining, projected,
    capAt, capsEarly: capAt !== null && capAt < resetsAt - 15 * 60,
    paceDelta: elapsed === null ? null : used - elapsed * 100,
    dailyBudget: remaining > 0 ? Math.max(0, 100 - used) / Math.max(remaining / DAY, 1 / 24) : null,
    stale: unreported || now - last.t > staleAfter, observedAt: last.t,
  };
}

/** The latest reading across a provider's meters, Unix seconds. */
export function latestReading(meters) {
  let latest = null;
  for (const meter of meters) for (const cycle of meter.cycles) latest = Math.max(latest ?? 0, cycle.last.t);
  return latest;
}

/** Percent per second over the trailing span, or null when the samples do not cover a third of it. */
function recentRate(samples, at, span) {
  const inside = samples.filter((sample) => sample.t >= at - span);
  if (inside.length < 2) return null;
  const first = inside[0], last = inside[inside.length - 1];
  return last.t - first.t >= span / 3 ? Math.max(0, last.used - first.used) / (last.t - first.t) : null;
}

/**
 * Hourly API-equivalent value for one provider, from the same activity ledger as Summary and Velocity.
 * Cells are local hours in the snapshot's timezone; meters are absolute instants, so each hour is mapped through the timezone.
 */
export function hourlyValue(sessions, provider, timeZone = "UTC") {
  const cells = new Map();
  for (const session of sessions ?? []) {
    if (session.provider !== provider) continue;
    for (const [day, hour, , values] of ledgerCells(session.velocity)) {
      const key = `${day}|${hour}`;
      cells.set(key, (cells.get(key) ?? 0) + (values[0] || 0));
    }
  }
  const keys = new Map();
  const localKey = (epochHour) => {
    let key = keys.get(epochHour);
    if (key === undefined) { key = zonedHourKey(epochHour, timeZone); keys.set(epochHour, key); }
    return key;
  };
  /** Value between two instants; partial hours count in proportion, assuming even activity within the hour. */
  function between(from, to) {
    if (!(to > from)) return 0;
    let total = 0;
    for (let hour = Math.floor(from / HOUR) * HOUR; hour < to; hour += HOUR) {
      const value = cells.get(localKey(hour));
      if (!value) continue;
      const overlap = Math.min(to, hour + HOUR) - Math.max(from, hour);
      total += value * overlap / HOUR;
    }
    return total;
  }
  return { between, empty: cells.size === 0 };
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Value per percent of a meter. Each cycle contributes its latest reading of at least 5%, divided into the local value
 * spent from the window start to that reading. The median across cycles resists one odd week.
 */
export function calibrate(meter, value) {
  const points = [];
  for (const cycle of meter?.cycles ?? []) {
    const sample = cycle.samples.findLast((item) => item.used >= calibrationFloor && item.t <= cycle.end);
    if (!sample) continue;
    const spent = value.between(cycle.start, sample.t);
    if (spent > 0) points.push({ resetsAt: cycle.resetsAt, used: sample.used, spent, perPercent: spent / sample.used });
  }
  const perPercent = median(points.map((point) => point.perPercent));
  return {
    perPercent, cycles: points.length, points,
    low: points.length ? Math.min(...points.map((point) => point.perPercent)) : null,
    high: points.length ? Math.max(...points.map((point) => point.perPercent)) : null,
  };
}

/**
 * Closed cycles of a meter: how much of each reset was used before it rolled over. `creditHistory` rows are
 * [provider, observedAt, available]; a drop in the banked count across an early reset attributes it to a redeemed credit.
 */
export function resetHistory(meter, perPercent = null, creditHistory = []) {
  const counts = (creditHistory ?? []).filter((row) => row[0] === meter?.provider);
  return (meter?.cycles ?? []).filter((cycle) => cycle.closed).map((cycle) => {
    // A closing reading taken long before the reset is a lower bound: usage after it was not observed.
    const window = (meter.windowMinutes ?? 0) * 60;
    const unobserved = cycle.end - cycle.last.t;
    const lowerBound = cycle.peak < 100 && unobserved > Math.max(HOUR, window * 0.1);
    const expired = cycle.endedEarly ? null : Math.max(0, 100 - cycle.peak);
    // An early reset gives back what had been used: the window restarts at 0%.
    const restored = cycle.endedEarly ? Math.min(100, cycle.last.used) : null;
    const redeemed = cycle.endedEarly && counts.some((row, index) => index > 0 && row[2] < counts[index - 1][2] && counts[index - 1][1] <= cycle.end + 600 && row[1] >= cycle.end - 600);
    return {
      resetsAt: cycle.resetsAt, start: cycle.start, end: cycle.end, peak: Math.min(100, cycle.peak), lowerBound, endedEarly: cycle.endedEarly,
      cause: cycle.endedEarly ? (redeemed ? "credit" : "unknown") : null,
      restored, restoredUsd: restored !== null && perPercent !== null ? restored * perPercent : null,
      capped: cycle.cappedAt !== null, lockedSeconds: cycle.cappedAt !== null ? Math.max(0, cycle.end - cycle.cappedAt) : 0,
      expired, expiredUsd: expired !== null && perPercent !== null ? expired * perPercent : null,
    };
  });
}

/** Session-window cycles that overlap the trailing span, with lockouts and the idle gaps between windows. */
export function sessionWindows(meter, now, span = 7 * DAY) {
  const from = now - span;
  const windows = (meter?.cycles ?? []).filter((cycle) => cycle.end > from).map((cycle) => ({
    start: cycle.start, end: cycle.end, resetsAt: cycle.resetsAt, peak: Math.min(100, cycle.peak), active: !cycle.closed,
    cappedAt: cycle.cappedAt, lockedSeconds: cycle.cappedAt !== null ? Math.max(0, Math.min(cycle.end, now) - cycle.cappedAt) : 0,
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
 * Banked resets as the provider reports them (Codex reset credits). A reset restarts its windows at 0%, so it is worth
 * what has been used when it is redeemed: at most a full window.
 */
export function bankedResets({ provider, account = null, weekly = null, session = null, perPercent = null, sessionPerPercent = null, now }) {
  const credits = [];
  const reported = provider === "codex" ? account?.resetCredits ?? null : null;
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
    observedAt: reported ? account.observedAt : null,
    nextExpiry: usable.find((credit) => credit.expiresAt !== null)?.expiresAt ?? null,
    upToUsd: values.every((value) => value !== null) ? values.reduce((total, value) => total + value, 0) : null,
    fullValue, nowValue,
  };
}

/** Plan price, capacity and extraction over a span of `days`, all at API-equivalent list prices. */
export function economics({ provider, planId, perPercent, extracted, days }) {
  const plan = planFor(provider, planId);
  const monthlyPrice = plan?.monthlyUsd ?? null;
  const weeklyCapacity = perPercent !== null && perPercent !== undefined ? perPercent * 100 : null;
  const price = monthlyPrice !== null ? monthlyPrice * days / MONTH_DAYS : null;
  const potential = weeklyCapacity !== null ? weeklyCapacity * days / 7 : null;
  return {
    plan, monthlyPrice, weeklyCapacity, monthlyPotential: weeklyCapacity !== null ? weeklyCapacity * MONTH_DAYS / 7 : null,
    days, price, potential, extracted,
    multiple: price ? extracted / price : null,
    potentialMultiple: price && potential !== null ? potential / price : null,
    utilization: potential ? extracted / potential : null,
    leftOnTable: potential !== null ? Math.max(0, potential - extracted) : null,
  };
}

/** Meter-only utilization: the mean closing level of recent weekly resets, with the live cycle's projection when it adds evidence. */
export function resetUtilization(history, live, limit = 6) {
  const closed = history.filter((cycle) => !cycle.endedEarly).slice(-limit).map((cycle) => cycle.peak);
  const projected = live && live.cycle && live.projected !== null && live.elapsed !== null && live.elapsed >= 0.15 ? Math.min(100, live.projected) : null;
  const values = projected !== null ? [...closed, projected] : closed;
  return values.length ? { mean: values.reduce((total, value) => total + value, 0) / values.length, closed: closed.length, includesProjection: projected !== null } : null;
}

const duration = (seconds) => {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 48) return rest && hours < 10 ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24), leftover = hours % 24;
  return leftover ? `${days}d ${leftover}h` : `${days}d`;
};
export { duration as formatDuration };

/** Percent rates keep one decimal below 10 so a small daily budget never reads as 0%. */
const rate = (value) => `${value < 10 ? (Math.round(value * 10) / 10).toString() : Math.round(value).toString()}%`;

const usd = (value) => value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${Math.round(value)}`;

/** What happens after a cap on this account: Codex credits, Claude extra usage, and paid resets. */
function afterCap(item) {
  if (item.provider === "codex") {
    const credits = item.account?.credits;
    const balance = credits?.hasCredits && credits.balance ? ` Codex continues on your ${integer(Math.round(credits.balance))} credits after the included allowance runs out.` : "";
    return `${balance} A paid instant reset (chatgpt.com/codex/purchase/reset) also restarts both windows; it is worth it only if the blocked days are worth more than its price.`;
  }
  const extra = item.account?.extraUsage;
  if (extra === "disabled") return ` Extra usage is off${item.account.disabledReason === "org_level_disabled" ? " for your organization" : ""}, so a cap means waiting for the reset.`;
  if (extra === "enabled" || extra === "in-use") return " Extra usage is on: past the cap you pay API rates.";
  return "";
}

/**
 * Ranked, data-backed suggestions. Each carries a tone (`act`, `watch`, `good`, `setup`), a provider or null,
 * and, where calibration allows, the API-equivalent value at stake.
 */
export function recommendations(providers, { now, sources = [], persisted = true, codexAccount = "ok", formatTime = (seconds) => new Date(seconds * 1000).toISOString() }) {
  const items = [];
  const byName = Object.fromEntries(providers.map((item) => [item.provider, item]));
  for (const item of providers) {
    const name = providerNames[item.provider];
    const weekly = item.weekly, k = item.calibration?.perPercent ?? null;
    if (weekly?.cycle && !weekly.stale) {
      const other = providers.find((candidate) => candidate !== item && candidate.weekly?.cycle && !candidate.weekly.stale);
      const headroom = other ? Math.max(0, 100 - Math.min(100, other.weekly.projected ?? other.weekly.used)) : 0;
      if (weekly.capsEarly && weekly.state !== "capped") {
        const early = weekly.cycle.resetsAt - weekly.capAt;
        items.push({
          tone: "act", provider: item.provider, score: 1000 + early / HOUR,
          title: `${name} weekly allowance runs out in ${duration(weekly.capAt - now)}, ${duration(early)} before it resets`,
          detail: `You are using about ${rate(weekly.rate * DAY)} a day; the allowance supports ${rate(weekly.dailyBudget)} a day until ${formatTime(weekly.cycle.resetsAt)}. ` +
            (other && headroom >= 15 ? `${providerNames[other.provider]} ${other.weekly.projected === null ? `has ${headroom.toFixed(0)}% of its week left` : `is on pace to leave ${headroom.toFixed(0)}% unused`}, so route long-running and background work there. ` : "") +
            "Keep the remaining allowance for interactive work, and run subagents and bulk jobs on cheaper models." + afterCap(item),
          impactUsd: null,
        });
      } else if (weekly.state === "capped") {
        items.push({
          tone: "act", provider: item.provider, score: 1100,
          title: `${name} weekly allowance is used up until ${formatTime(weekly.cycle.resetsAt)}`,
          detail: (other && headroom >= 10 ? `${providerNames[other.provider]} still has about ${headroom.toFixed(0)}% of its week. Move work there until the reset.` : "Until the reset, only a banked or paid reset, extra usage, or credits keep this provider working.") + afterCap(item),
          impactUsd: null,
        });
      } else if (weekly.projected !== null && weekly.projected < 85 && weekly.remaining > 12 * HOUR) {
        const expiring = 100 - weekly.projected;
        items.push({
          tone: "watch", provider: item.provider, score: 500 + (k ? expiring * k : expiring),
          title: `About ${expiring.toFixed(0)}% of this week's ${name} allowance will expire unused${k ? ` (≈ ${usd(expiring * k)} of API value)` : ""}`,
          detail: `At your current pace the meter closes near ${weekly.projected.toFixed(0)}% at ${formatTime(weekly.cycle.resetsAt)}. Using all of it takes about ${rate(weekly.dailyBudget)} a day. Queue overnight agent work before the reset, such as test backfills, refactors, dependency upgrades and review passes.`,
          impactUsd: k ? expiring * k : null,
        });
      }
    }
    const history = item.history.filter((cycle) => !cycle.endedEarly);
    if (history.length >= 2) {
      const unused = history.reduce((total, cycle) => total + (cycle.expired ?? 0), 0) / history.length;
      if (unused >= 15) items.push({
        tone: "watch", provider: item.provider, score: 400 + (k ? unused * k : unused),
        title: `Your last ${history.length} ${name} weekly resets left an average of ${unused.toFixed(0)}% unused`,
        detail: `${k ? `That is about ${usd(unused * k)} of API-equivalent value a week (${usd(unused * k * MONTH_DAYS / 7)} a month). ` : ""}A steady daily target of about ${(100 / 7).toFixed(0)}% keeps each week fully used without running out early.`,
        impactUsd: k ? unused * k * MONTH_DAYS / 7 : null,
      });
      else if (history.every((cycle) => cycle.peak >= 90)) items.push({
        tone: "good", provider: item.provider, score: 50,
        title: `You use ${name}'s weekly resets almost fully`,
        detail: `Each of the last ${history.length} weekly resets closed at 90% or more.`, impactUsd: null,
      });
    }
    if (item.windows && item.windows.capped > 0) {
      const weeklyBinding = weekly?.capsEarly || weekly?.state === "capped";
      items.push({
        tone: weeklyBinding ? "watch" : "act", provider: item.provider, score: 600 + item.windows.lockedSeconds / 60,
        title: `Hit the ${name} 5-hour limit ${item.windows.capped} time${item.windows.capped === 1 ? "" : "s"} in 7 days (${duration(item.windows.lockedSeconds)} locked out)`,
        detail: weeklyBinding
          ? "The weekly allowance is the tighter limit this week, so these lockouts mostly pace you. Spread heavy work across more windows rather than pushing through one."
          : "A 5-hour window starts with your first message. Send a short message 2 to 3 hours before heavy work so a reset lands mid-session, split large jobs across two windows, and switch to the other subscription during lockouts.",
        impactUsd: null,
      });
    }
    const plan = item.economics?.plan;
    if (plan && history.length >= 3) {
      const mean = history.slice(-4).reduce((total, cycle) => total + cycle.peak, 0) / Math.min(4, history.length);
      const cappedWeeks = history.slice(-4).filter((cycle) => cycle.capped).length;
      if (cappedWeeks >= 2 && plan.rank < 3) items.push({
        tone: "watch", provider: item.provider, score: 300,
        title: `${name} capped out in ${cappedWeeks} of the last ${Math.min(4, history.length)} weeks on ${plan.label}`,
        detail: "If those lockouts cost you working time, the next tier up may be worth it. Compare the price difference with the value you produce in the blocked hours.", impactUsd: null,
      });
      if (mean < 30 && plan.rank >= 2) items.push({
        tone: "watch", provider: item.provider, score: 350,
        title: `${name} weekly resets averaged ${mean.toFixed(0)}% on ${plan.label}`,
        detail: "A lower tier would cover this level of use. Either move more work onto this subscription or downgrade to save the difference.", impactUsd: null,
      });
    }
  }
  // Banked resets: when to redeem, when to hold, and what expires.
  for (const item of providers) {
    const banked = item.resets;
    if (!banked?.available) continue;
    const name = providerNames[item.provider], weekly = item.weekly, k = item.calibration?.perPercent ?? null;
    const weeklyCredit = banked.credits.find((credit) => credit.scope !== "five_hour");
    const sessionCredit = banked.credits.find((credit) => credit.scope === "five_hour");
    const where = redeemWhere[item.provider] ?? "";
    const left = `You have ${banked.available} banked${banked.nextExpiry ? `; the next expires ${formatTime(banked.nextExpiry)}` : ""}.`;
    let timed = false;
    if (weeklyCredit && weekly?.cycle && !weekly.stale && (weekly.state === "capped" || weekly.used >= 90) && weekly.remaining > DAY) {
      timed = true;
      const restore = banked.nowValue(weeklyCredit);
      items.push({
        tone: "act", provider: item.provider, score: 1300,
        title: `Redeem a banked ${name} reset now: it restores ${Math.round(Math.min(100, weekly.used))}% of the week${restore !== null ? ` (≈ ${usd(restore)})` : ""}`,
        detail: `The weekly meter is at ${Math.round(weekly.used)}% with ${duration(weekly.remaining)} until the scheduled reset, so this is when a reset is worth the most: it restarts the week at 0%. ${left} ${where}`,
        impactUsd: restore,
      });
    } else if (weeklyCredit && weekly?.capsEarly && weekly.capAt) {
      timed = true;
      items.push({
        tone: "watch", provider: item.provider, score: 720,
        title: `Hold your banked ${name} reset until the weekly meter nears 100% (about ${formatTime(weekly.capAt)})`,
        detail: `A reset is worth what has been used when you redeem it: ${Math.round(weekly.used)}% now${k ? ` (≈ ${usd(weekly.used * k)})` : ""}, a full week near 100%${k ? ` (≈ ${usd(100 * k)})` : ""}. ${left} ${where}`,
        impactUsd: k ? (100 - weekly.used) * k : null,
      });
    }
    if (sessionCredit && item.session?.state === "capped" && item.session.cycle && item.session.cycle.resetsAt - now > HOUR && !(weekly?.capsEarly || weekly?.state === "capped")) {
      items.push({
        tone: "act", provider: item.provider, score: 1150,
        title: `A banked 5-hour reset would end this ${name} lockout ${duration(item.session.cycle.resetsAt - now)} early`,
        detail: `The weekly allowance still has room, so the 5-hour window is what is blocking you. ${left} ${where}`, impactUsd: null,
      });
    }
    for (const credit of banked.credits) {
      if (credit.expiresAt === null) continue;
      const remaining = credit.expiresAt - now;
      const restore = banked.nowValue(credit);
      if (remaining <= 3 * DAY) {
        items.push({
          tone: "act", provider: item.provider, score: 1250 - remaining / HOUR,
          title: `A banked ${name} reset expires ${formatTime(credit.expiresAt)}, in ${duration(remaining)}`,
          detail: `Unused, it is worth nothing. Redeem it before then at the highest meter reading you reach${restore !== null ? `; right now it would restore ≈ ${usd(restore)}` : ""}. ${where}`,
          impactUsd: restore,
        });
      } else if (!timed && credit.scope !== "five_hour" && weekly?.cycle && weekly.projected !== null && weekly.projected < 90 && credit.expiresAt < weekly.cycle.resetsAt + 7 * DAY) {
        items.push({
          tone: "watch", provider: item.provider, score: 650,
          title: `Your banked ${name} reset expires ${formatTime(credit.expiresAt)}, and at this pace you will not need it first`,
          detail: `Plan a heavy run before then (a large refactor, test backfill or review sweep), let the weekly meter climb close to 100%, then redeem it to restore a full week${k ? ` (≈ ${usd(100 * k)})` : ""}. ${where}`,
          impactUsd: k ? 100 * k : null,
        });
      }
      break; // The soonest expiry is the one to act on.
    }
  }
  // Early resets that restored little: worth knowing if they were redeemed credits.
  for (const item of providers) {
    const k = item.calibration?.perPercent ?? null;
    const early = item.history.filter((cycle) => cycle.endedEarly && cycle.restored !== null && cycle.restored < 60 && cycle.end >= now - 30 * DAY);
    if (!early.length) continue;
    const last = early[early.length - 1];
    items.push({
      tone: "watch", provider: item.provider, score: 450,
      title: `${providerNames[item.provider]} ${last.cause === "credit" ? "banked reset was redeemed" : "reset early"} at ${Math.round(last.restored)}% used${k ? `, restoring only ≈ ${usd(last.restored * k)}` : ""}`,
      detail: `A reset restarts the window at 0%, so it is worth what had been used when it happened. ${k ? `Taken near 100% it restores a full week, about ${usd(100 * k)}. ` : ""}If this was a reset credit you redeemed, save credits for when the meter is close to 100% with days left before the scheduled reset. Provider-wide resets are not in your control.`,
      impactUsd: k ? (100 - last.restored) * k : null,
    });
  }
  const exhausting = providers.filter((item) => item.weekly?.cycle && !item.weekly.stale && (item.weekly.capsEarly || item.weekly.state === "capped"));
  if (exhausting.length >= 2) {
    const lost = exhausting.map((item) => item.weekly.cycle.resetsAt - (item.weekly.capAt ?? now));
    const banked = exhausting.reduce((total, item) => total + (item.resets?.available ?? 0), 0);
    items.push({
      tone: "act", provider: null, score: 1200,
      title: "Every subscription runs out before its reset: you are capacity-bound, not under-using",
      detail: `At this pace you would have no allowance for ${duration(Math.min(...lost))} to ${duration(Math.max(...lost))} before the resets. You already extract more than the limits refill. Ration by priority: keep allowance for interactive work, batch background agents into the days after each reset, and use cheaper models for subagents.${banked ? ` Spend your ${banked} banked reset${banked === 1 ? "" : "s"} at the caps, not before.` : ""} Extra usage, credits, paid resets or another seat only pay off if the blocked hours are worth more than their price.`,
      impactUsd: null,
    });
  }
  const claudeSource = sources.filter((source) => source.source.startsWith("claude"));
  if (!byName.claude?.meters?.length && claudeSource.every((source) => source.status !== "ok")) items.push({
    tone: "setup", provider: "claude", score: 200,
    title: "Record Claude limit meters",
    detail: "No Claude meter readings were found. Add `session-analytics limits statusline` as your Claude Code status line, or run Claude through a host that logs Agent SDK events, such as T3 Code.",
    impactUsd: null,
  });
  if (codexAccount === "unavailable" && byName.codex && !byName.codex.resets?.known) items.push({
    tone: "setup", provider: "codex", score: 180, title: "Banked Codex resets could not be read",
    detail: "The local Codex app-server did not answer, so banked resets and their expiry are unknown. Check that `codex` is installed and logged in; the next refresh retries.",
    impactUsd: null,
  });
  if (!persisted) items.push({
    tone: "setup", provider: null, score: 150, title: "Limit history is not being kept",
    detail: "With --no-index, only readings still in provider logs are shown. Claude event logs rotate within about a day, so reset history needs the private ledger.", impactUsd: null,
  });
  return items.sort((left, right) => right.score - left.score);
}

/**
 * Everything the Subscription view and `limits` report show for one provider.
 * `extracted` is the provider's API-equivalent value over `days`, taken from the shared ledger by the caller.
 * `account` is the provider's account summary (Codex credits and reset credits, Claude extra usage).
 */
export function providerUtilization({ provider, meters, sessions, timeZone, now, planId, extracted, days, account = null, creditHistory = [] }) {
  const own = meters.filter((meter) => meter.provider === provider);
  const weeklyMeter_ = findMeter(own, provider, weeklyMeter) ?? own.find((meter) => meterBase(meter.meter) === weeklyMeter) ?? null;
  const sessionMeter_ = findMeter(own, provider, sessionMeter);
  const value = hourlyValue(sessions, provider, timeZone);
  const calibration = weeklyMeter_ ? calibrate(weeklyMeter_, value) : { perPercent: null, cycles: 0, points: [], low: null, high: null };
  const sessionCalibration = sessionMeter_ ? calibrate(sessionMeter_, value) : null;
  const reportedUntil = latestReading(own);
  const weekly = weeklyMeter_ ? liveMeter(weeklyMeter_, now, reportedUntil) : null;
  const session = sessionMeter_ ? liveMeter(sessionMeter_, now, reportedUntil) : null;
  const history = weeklyMeter_ ? resetHistory(weeklyMeter_, calibration.perPercent, creditHistory) : [];
  return {
    provider, planId, meters: own, weeklyMeter: weeklyMeter_, sessionMeter: sessionMeter_,
    weekly, session, live: own.map((meter) => liveMeter(meter, now, reportedUntil)), history,
    windows: sessionMeter_ ? sessionWindows(sessionMeter_, now) : null,
    calibration, sessionCalibration, account,
    resets: bankedResets({ provider, account, weekly, session, perPercent: calibration.perPercent, sessionPerPercent: sessionCalibration?.perPercent ?? null, now }),
    economics: economics({ provider, planId, perPercent: calibration.perPercent, extracted, days }),
    utilization: resetUtilization(history, weekly),
  };
}
