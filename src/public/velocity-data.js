import { calendarParts } from "./format.js";
import { providerLabels } from "./providers.js";
import { normalizeTimestamp } from "./timestamps.js";
// Pure calendar, aggregation and comparison functions shared by the two charts.
// All arithmetic on calendar dates uses UTC *as a calendar*, never as the bucket timezone.
export const metricDefinitions = {
  value: { index: 0, label: "Usage value", unit: "USD", minimum: 0.01 },
  input: { index: 1, label: "Input tokens", unit: "tokens", minimum: 100 },
  uncached: { index: 2, label: "Uncached input", unit: "tokens", minimum: 100 },
  cacheRead: { index: 3, label: "Cache-read input", unit: "tokens", minimum: 100 },
  cacheWrite: { index: 4, label: "Cache-write input", unit: "tokens", minimum: 100 },
  output: { index: 5, label: "Output tokens", unit: "tokens", minimum: 100 },
  reasoning: { index: 6, label: "Reasoning tokens", unit: "tokens", minimum: 100 },
  calls: { index: 7, label: "Model calls", unit: "calls", minimum: 3 },
  tools: { index: 8, label: "Tool calls", unit: "calls", minimum: 5 },
  sessions: { index: 9, label: "Sessions started", unit: "sessions", minimum: 3 },
};
export const agentLabels = {
  "claude-cli": "Claude · CLI", "claude-sdk": "Claude · SDK / orchestrated",
  "claude-desktop": "Claude · desktop local agent", "claude-unknown": "Claude · entrypoint unknown",
  "claude-general-purpose": "Claude · general-purpose", "claude-explore": "Claude · Explore",
  "claude-plan": "Claude · Plan", "claude-subagent": "Claude · other / unknown subagent",
  "codex-cli": "Codex · CLI", "codex-exec": "Codex · exec", "codex-vscode": "Codex · VS Code",
  "codex-desktop": "Codex · desktop", "codex-subagent": "Codex · subagent", "codex-review": "Codex · review", "codex-unknown": "Codex · source unknown",
  cursor: "Cursor", copilot: "Copilot CLI", opencode: "OpenCode", gemini: "Gemini CLI", antigravity: "Antigravity",
};
const providers = providerLabels;
const blank = () => Array(14).fill(0);
const add = (a, b) => { for (let i = 0; i < 14; i += 1) a[i] += b[i] || 0; return a; };
const sum = (a) => a.reduce((total, value) => total + value, 0);

/** Dated usage value per active and calendar day; expects data built with metric "value". */
export function averagePrice(data) {
  const total = data.totals[metricDefinitions.value.index], days = data.daily.length;
  const activeDays = data.daily.filter((day) => day.total > 0).length;
  return { total, days, activeDays, perActiveDay: activeDays ? total / activeDays : null, perCalendarDay: days ? total / days : null };
}

// Evidence is kept alongside observations at every aggregation level. A zero
// observation with eligible but unknown tokens must never look like inactivity.
const evidenceMetrics = { value: 10, reasoning: 11, uncached: 12, cacheRead: 12, cacheWrite: 13 };
const blankEvidence = () => ({ known: 0, eligible: 0, unsupported: 0, complete: true });
function addEvidence(target, source) {
  target.known += source.known; target.eligible += source.eligible; target.unsupported += source.unsupported;
  target.complete = target.known === target.eligible && target.unsupported === 0;
  return target;
}
// Native Cursor composer evidence (no evidence source) has provider-reported, undated value and no
// API pricing or cache split. Every other ledger records the evidence columns of its cells.
const nativeCursor = (session) => session.provider === "cursor" && !session.evidence?.source;
const cacheWriteSources = new Set(["opencode-db", "cursor-sdk", "antigravity-db"]);
const recordsCacheWrites = (session) => session.provider === "claude" || cacheWriteSources.has(session.evidence?.source);
function metricEvidence(session, values, metric) {
  const index = evidenceMetrics[metric];
  if (index === undefined) return blankEvidence();
  const applicable = metric === "cacheWrite" ? recordsCacheWrites(session) : !nativeCursor(session);
  const known = applicable ? values[index] : 0;
  const eligible = applicable ? metric === "value" ? values[1] + values[5] : metric === "reasoning" ? values[5] : values[1] : 0;
  // Cursor's legacy unsplit input can have a numeric uncached value but no
  // applicable split evidence; such a contribution cannot support inference.
  const unsupported = applicable ? 0 : values[metricDefinitions[metric].index];
  return { known, eligible, unsupported, complete: known === eligible && unsupported === 0 };
}

export function localDay(timestamp, timeZone = "UTC") {
  // Match the ledger's absolute-timestamp contract before Date can apply the
  // browser's timezone (or turn null into the Unix epoch).
  if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) return null;
  const normalized = normalizeTimestamp(timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!normalized) return null;
  const date = new Date(normalized);
  if (!Number.isFinite(date.valueOf())) return null;
  const parts = calendarParts(date, timeZone);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function sessionStartWindow(sessions, { start, end, timeZone }) {
  let undatedStarts = 0;
  const selected = sessions.filter(({ createdAt }) => {
    const day = localDay(createdAt, timeZone);
    if (day === null) { undatedStarts += 1; return false; }
    return (!start || day >= start) && (!end || day <= end);
  });
  return { sessions: selected, undatedStarts };
}
export function shiftDay(day, amount) {
  const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + amount);
  return Number.isFinite(date.valueOf()) ? date.toISOString().slice(0, 10) : null;
}
export function calendarDays(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? "")) return [];
  const days = [];
  for (let day = start; day && day <= end && days.length < 36_600; day = shiftDay(day, 1)) days.push(day);
  return days;
}
export function periodKey(day, granularity) {
  if (granularity === "month") return day.slice(0, 7);
  if (granularity === "week") return shiftDay(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
  return day;
}
function groupIdentity(session, dimension, group) {
  if (group === "provider") return [session.provider, providers[session.provider] || "Unknown provider"];
  if (group === "repository") return [session.repositoryId, session.repositoryName];
  if (group === "model") return [`${session.provider}:${dimension.model}`, `${dimension.model === "<unknown>" ? "Unattributed model" : dimension.model} · ${providers[session.provider]}`];
  if (group === "execution") return [dimension.executionKind, { "top-level": "Top-level", subagent: "Subagent", unknown: "Unknown execution" }[dimension.executionKind]];
  if (group === "effort") return [dimension.effort, dimension.effort === "unknown" ? "Effort not recorded" : dimension.effort];
  return [dimension.agent, agentLabels[dimension.agent] || "Unknown agent"];
}

/** Evidence sources whose parsers wrote no activity ledger before session-dated value existed. Their
 * sessions from such older snapshots are disclosed (all time) rather than treated as needing a refresh. */
export const ledgerlessSources = new Set(["conductor-result", "cursor-sdk", "cursor-transcript", "copilot-events", "opencode-db", "gemini-chat", "antigravity-db"]);

/** Activity-dated cells, then session-dated cells (`[day, hour, dimension, values, sessionDated]`).
 * Session-dated cells carry value whose own request/run time the source does not record; they are
 * placed on the session's last evidenced activity time and count in every dated total. */
export function ledgerCells(velocity) {
  if (!velocity) return [];
  return [...velocity.buckets.map((cell) => [...cell, false]), ...(velocity.sessionDated ?? []).map((cell) => [...cell, true])];
}

/** Sum occupied hourly cells; never use session creation as the activity date. Every series also carries `sums`, the
 * group's in-window total of all 14 counters, and `sessions`, the sessions contributing a cell to it (the "Other"
 * remainder adds its members' counts). */
export function buildVelocity(sessions, { start, end, group = "provider", metric = "value", granularity = "day", mode = "lines", limit = 6, rollingHistory = null } = {}) {
  const index = metricDefinitions[metric].index;
  const dates = calendarDays(start, end);
  const dailyMap = new Map(dates.map((day) => [day, { day, values: blank(), total: 0, evidence: blankEvidence() }]));
  const keys = granularity === "hour" ? Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")) : [...new Set(dates.map((day) => periodKey(day, granularity)))];
  const keyIndexes = new Map(keys.map((key, i) => [key, i]));
  const groups = new Map();
  const totals = blank(), undated = blank(), sessionDated = blank();
  const evidence = blankEvidence();
  const coverage = { priceTokens: 0, cacheReadInput: 0, cacheWriteInput: 0, reasoningOutput: 0 };
  let earliest = null, missingSessions = 0, contributingSessions = 0, sessionDatedSessions = 0;
  const unledgered = { sessions: 0, value: 0 };
  // The last session that added to each series, so `series.sessions` counts each contributing session once.
  const lastSession = new Map();
  for (const session of sessions) {
    if (!session.velocity) {
      if (ledgerlessSources.has(session.evidence?.source)) { unledgered.sessions += 1; unledgered.value += session.cost?.totalUsd || 0; } else missingSessions += 1;
      continue;
    }
    let contributes = false, inferred = false;
    for (const [, values] of session.velocity.undated) add(undated, values);
    // Iterate the two cell lists in place: this loop runs over every occupied cell of the history.
    for (const [cells, isSessionDated] of [[session.velocity.buckets, false], [session.velocity.sessionDated ?? [], true]]) for (const [day, hour, dimensionId, values] of cells) {
      if (earliest === null || day < earliest) earliest = day;
      const daily = dailyMap.get(day);
      if (!daily) continue;
      const dimension = session.velocity.dimensions[dimensionId];
      if (!dimension) continue;
      contributes = true;
      // Count a session only when it session-dates some of the selected metric.
      if (isSessionDated) { inferred ||= values[index] !== 0; add(sessionDated, values); }
      add(totals, values); add(daily.values, values); daily.total += values[index];
      const observedEvidence = metricEvidence(session, values, metric);
      addEvidence(evidence, observedEvidence); addEvidence(daily.evidence, observedEvidence);
      if (!nativeCursor(session)) {
        coverage.priceTokens += values[1] + values[5];
        coverage.cacheReadInput += values[1];
        coverage.reasoningOutput += values[5];
      }
      if (recordsCacheWrites(session)) coverage.cacheWriteInput += values[1];
      const [id, label] = groupIdentity(session, dimension, group);
      let series = groups.get(id);
      if (!series) { series = { id, label, total: 0, values: keys.map(() => 0), calls: 0, evidence: blankEvidence(), sums: blank(), sessions: 0 }; groups.set(id, series); }
      series.calls += values[7]; addEvidence(series.evidence, observedEvidence); add(series.sums, values);
      if (lastSession.get(series) !== session) { lastSession.set(series, session); series.sessions += 1; }
      const key = granularity === "hour" ? String(hour).padStart(2, "0") : periodKey(day, granularity);
      const position = keyIndexes.get(key);
      if (position !== undefined) { series.values[position] += values[index]; series.total += values[index]; }
    }
    if (contributes) contributingSessions += 1;
    if (inferred) sessionDatedSessions += 1;
  }
  // Retain zero-valued groups in the accounting view: they can carry missing
  // evidence. Only the chart omits empty series.
  const allSeries = [...groups.values()].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  let series = allSeries.filter(({ total }) => total > 0);
  if (series.length > limit) {
    const remainder = series.slice(limit);
    const other = { id: "other", label: `Other (${remainder.length})`, total: sum(remainder.map((item) => item.total)), values: keys.map((_, i) => sum(remainder.map((item) => item.values[i]))), calls: sum(remainder.map((item) => item.calls)), evidence: remainder.reduce((total, item) => addEvidence(total, item.evidence), blankEvidence()), sums: remainder.reduce((total, item) => add(total, item.sums), blank()), sessions: sum(remainder.map((item) => item.sessions)) };
    series = [...series.slice(0, limit), other];
  }
  const daily = [...dailyMap.values()];
  // Comparison history already includes the preceding dates and the same evidence guards.
  const historyRolling = rollingHistory && new Map(rollingHistory.daily.map(({ day }, i) => [day, rollingHistory.rolling[i]]));
  const rolling = historyRolling ? daily.map(({ day }) => historyRolling.get(day) ?? null)
    : daily.map((_, i) => i < 6 || daily[i - 6].day < earliest || missingSessions || !daily.slice(i - 6, i + 1).every((item) => item.evidence.complete) ? null : sum(daily.slice(i - 6, i + 1).map((item) => item.total)) / 7);
  if (mode === "cumulative" && granularity !== "hour") series = series.map((item) => { let running = 0; return { ...item, values: item.values.map((value) => running += value) }; });
  return { start, end, group, metric, granularity, mode, keys, series, allSeries, daily, rolling, totals, undated, sessionDated, sessionDatedSessions, coverage, evidence, earliest, missingSessions, unledgered, contributingSessions };
}

/** Percentages need enough observed activity as well as a nonzero denominator. */
export function guardedDelta(current, previous, metric, previousCalls = 0) {
  const definition = metricDefinitions[metric];
  if (previous < definition.minimum || (definition.index < 7 && previousCalls < 3)) return null;
  return (current - previous) / previous;
}
export function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction, lower = Math.floor(position), weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[Math.ceil(position)] * weight;
}

/** Minimum share of eligible tokens with known metric evidence on each side of a period comparison. */
export const comparisonEvidenceFloor = 0.9;
const evidenceShare = (evidence) => evidence.eligible > 0 ? evidence.known / evidence.eligible : 1;

/**
 * The ledger dates the calendar indicators need. They are anchored on the selected end date but
 * look back through observed history, not just the selected window: a "last 7 days" window must
 * still compare this week with last week. Two whole months before the anchor month cover the
 * month-over-month fallback on the 1st, both prior weeks and the 14-day burn baseline.
 */
export function comparisonSpan(end, today) {
  const anchor = today && today < end ? today : end;
  const start = new Date(`${anchor.slice(0, 7)}-01T12:00:00Z`); start.setUTCMonth(start.getUTCMonth() - 2);
  return { start: start.toISOString().slice(0, 10), end };
}

/**
 * Classifies one like-for-like period comparison. `status` is `change` (a guarded percentage),
 * `new` (observed zero before, activity now), `idle` (observed zero on both sides) or
 * `unavailable` with a specific `reason`. A delta is never Infinity, NaN or an invented 0%.
 */
export function comparePeriods(current, previous, metric, { missingSessions = 0 } = {}) {
  const result = { current, previous, delta: null, status: "unavailable", reason: null, partial: false };
  const definition = metricDefinitions[metric];
  if (missingSessions) return { ...result, reason: "Refresh: some sessions have no activity ledger" };
  // The prior period always precedes the current one, so it is the side that can predate history.
  if (!previous.covered || !current.covered) return { ...result, reason: previous.coveredDays ? "Prior period is only partly observed" : "No observed history for the prior period" };
  if (current.evidence.unsupported || previous.evidence.unsupported) return { ...result, reason: "Metric not recorded by some providers" };
  const weak = [["current", current.evidence], ["prior", previous.evidence]].find(([, evidence]) => evidenceShare(evidence) < comparisonEvidenceFloor);
  if (weak) {
    const share = Math.floor(100 * evidenceShare(weak[1]));
    return { ...result, reason: `${share}% ${metric === "value" ? "of tokens priced" : "metric evidence"} in the ${weak[0]} period; ${Math.round(comparisonEvidenceFloor * 100)}% needed` };
  }
  const partial = !current.evidence.complete || !previous.evidence.complete;
  if (previous.value === 0) return { ...result, partial, status: current.value === 0 ? "idle" : "new" };
  const delta = guardedDelta(current.value, previous.value, metric, previous.calls);
  if (delta === null) return { ...result, partial, reason: definition.index < 7 ? `Prior period below the minimum baseline (${definition.minimum} ${definition.unit}, 3 model calls)` : `Prior period below the minimum baseline (${definition.minimum} ${definition.unit})` };
  return { ...result, partial, delta, status: "change" };
}

/** A whole buildVelocity window as one comparison period, covered only inside observed history. */
export function periodFromVelocity(data) {
  const index = metricDefinitions[data.metric].index;
  const coveredDays = data.daily.filter(({ day }) => data.earliest !== null && day >= data.earliest).length;
  return { start: data.start, end: data.end, days: data.daily.length, coveredDays, covered: data.daily.length > 0 && coveredDays === data.daily.length, value: data.totals[index], calls: data.totals[7], evidence: { ...data.evidence } };
}

/**
 * Week and month comparisons over completed dates (today is partial and excluded).
 * The current period is the week/month containing the last completed date, so on a Monday or
 * on the 1st it is the period that just finished (`rolledBack`), compared with the one before.
 * Week: Monday through the last completed date vs the same weekdays one week earlier.
 * Month: the first N completed dates vs the first N dates of the prior month, both clipped to
 * the shorter month.
 */
function periodComparisons(range, end, completeThrough, metric, options = {}) {
  const weekStart = periodKey(completeThrough, "week");
  const week = {
    ...comparePeriods(range(weekStart, completeThrough), range(shiftDay(weekStart, -7), shiftDay(completeThrough, -7)), metric, options),
    rolledBack: weekStart !== periodKey(end, "week"),
  };
  const monthStart = `${completeThrough.slice(0, 7)}-01`;
  const previousMonthEnd = shiftDay(monthStart, -1);
  const previousMonthStart = `${previousMonthEnd.slice(0, 7)}-01`;
  const pairedDays = Math.min(calendarDays(monthStart, completeThrough).length, Number(previousMonthEnd.slice(-2)));
  const month = {
    ...comparePeriods(range(monthStart, shiftDay(monthStart, pairedDays - 1)), range(previousMonthStart, shiftDay(previousMonthStart, pairedDays - 1)), metric, options),
    rolledBack: monthStart !== `${end.slice(0, 7)}-01`,
  };
  return { week, month };
}

export function velocityIndicators(data, today) {
  const end = data.end < today ? data.end : today;
  const completeThrough = end === today ? shiftDay(today, -1) : end;
  const days = new Map(data.daily.map((item) => [item.day, item]));
  const observedStart = data.earliest && data.earliest > data.start ? data.earliest : data.start;
  const range = (start, finish) => {
    const dates = calendarDays(start, finish);
    const rows = dates.map((day) => days.get(day));
    const covered = dates.length > 0 && start >= observedStart && finish <= data.end && rows.every(Boolean);
    return { start, end: finish, days: dates.length, coveredDays: dates.filter((day) => day >= observedStart && days.has(day)).length, covered, value: sum(rows.map((row) => row?.total || 0)), calls: sum(rows.map((row) => row?.values[7] || 0)), evidence: rows.reduce((total, row) => row ? addEvidence(total, row.evidence) : total, blankEvidence()) };
  };
  const supported = (period) => period.covered && period.evidence.complete && !data.missingSessions;
  const { week, month } = periodComparisons(range, end, completeThrough, data.metric, { missingSessions: data.missingSessions });
  const monthStart = `${end.slice(0, 7)}-01`;
  const trailing = range(shiftDay(end, -14), shiftDay(end, -1));
  const baseline = calendarDays(trailing.start, trailing.end).map((day) => days.get(day)?.total || 0);
  const median = supported(trailing) ? quantile(baseline, 0.5) : null;
  const todayPeriod = range(today, today);
  const todayValue = end === today ? days.get(today)?.total ?? null : null;
  const burn = { today: todayValue, median, days: trailing.coveredDays, activeDays: baseline.filter((v) => v > 0).length, ratio: null, todayEvidence: todayPeriod.evidence, baselineEvidence: trailing.evidence };
  if (todayValue !== null && supported(todayPeriod) && median !== null && burn.activeDays >= 3 && guardedDelta(median, median, data.metric, trailing.calls) !== null) burn.ratio = todayValue / median;
  const nextMonth = new Date(`${monthStart}T12:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEnd = shiftDay(nextMonth.toISOString().slice(0, 10), -1);
  const historyStart = shiftDay(completeThrough, -13);
  const sampleStart = historyStart < observedStart ? observedStart : historyStart;
  const history = calendarDays(sampleStart, completeThrough).map((day) => days.get(day)?.total || 0);
  const sample = range(sampleStart, completeThrough);
  const elapsed = range(monthStart, completeThrough);
  const observedPeriod = range(monthStart, end);
  const observed = observedPeriod.value;
  const projectionEvidence = { sample: sample.evidence, observed: observedPeriod.evidence };
  const remaining = calendarDays(shiftDay(completeThrough, 1), monthEnd).length;
  const active = history.filter((v) => v > 0).length;
  let projection = null;
  if (remaining > 0 && supported(elapsed) && supported(observedPeriod) && supported(sample) && history.length >= 7 && active >= 3 && guardedDelta(sum(history), sum(history), data.metric, sample.calls) !== null) {
    const project = (fraction) => {
      const rate = quantile(history, fraction);
      // A busy partial day must not consume the allowance for future full days.
      const partialDayAdjustment = end === today ? Math.max(0, (days.get(today)?.total || 0) - rate) : 0;
      return elapsed.value + rate * remaining + partialDayAdjustment;
    };
    projection = { value: project(0.5), low: project(0.1), high: project(0.9), observed, sampleDays: history.length, activeDays: active, remainingDays: remaining, monthEnd };
  }
  return { week, month, burn, projection, projectionEvidence, completeThrough, end, trailing };
}

export function topMovers(sessions, options, today) {
  options = { ...options, metric: options.metric ?? "value" };
  const end = options.end < today ? options.end : shiftDay(today, -1);
  const start = shiftDay(end, -6), previousStart = shiftDay(start, -7), previousEnd = shiftDay(start, -1);
  const result = { start, end, previousStart, previousEnd, available: false, excludedGroups: 0, rows: [] };
  if (previousStart < options.start || !sessions.length) return result;
  for (const group of ["repository", "model", "agent"]) {
    const current = buildVelocity(sessions, { ...options, group, start, end });
    if (!current.earliest || current.earliest > previousStart || current.missingSessions) return result;
    const previous = buildVelocity(sessions, { ...options, group, start: previousStart, end: previousEnd });
    const prior = new Map(previous.allSeries.map((item) => [item.id, item]));
    const latest = new Map(current.allSeries.map((item) => [item.id, item]));
    const rows = [];
    for (const id of new Set([...latest.keys(), ...prior.keys()])) {
      const item = latest.get(id), before = prior.get(id);
      const currentEvidence = item?.evidence ?? blankEvidence(), previousEvidence = before?.evidence ?? blankEvidence();
      if (!currentEvidence.complete || !previousEvidence.complete) { result.excludedGroups += 1; continue; }
      const value = item?.total || 0, previousValue = before?.total || 0;
      if (value > previousValue) rows.push({ group, label: item.label, current: value, previous: previousValue, increase: value - previousValue, delta: guardedDelta(value, previousValue, options.metric, before?.calls || 0), currentEvidence, previousEvidence });
    }
    rows.sort((a, b) => b.increase - a.increase || a.label.localeCompare(b.label));
    result.rows.push(...rows.slice(0, 3));
  }
  result.available = true;
  return result;
}
