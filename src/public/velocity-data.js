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
  cursor: "Cursor", copilot: "Copilot CLI", opencode: "OpenCode", gemini: "Gemini CLI",
};
/** Agent charts show the five largest agents and fold the rest into "Other (N)". */
export const agentSeriesLimit = 5;
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
/** Eligible tokens without metric evidence, by model id, merged over days or periods (null when there are none). */
function mergeGaps(...sources) {
  let merged = null;
  for (const gaps of sources) if (gaps) for (const [model, tokens] of gaps) { merged ??= new Map(); merged.set(model, (merged.get(model) ?? 0) + tokens); }
  return merged;
}
const gapPhrases = { value: "with unpriced tokens", reasoning: "without reasoning detail", uncached: "without cache-read detail", cacheRead: "without cache-read detail", cacheWrite: "without cache-write detail" };
/**
 * Names the models behind incomplete metric evidence, largest gap first: "1 model unpriced: gpt-5.3-codex-spark",
 * "3 models unpriced: a, b +1 more". Null when no model is missing evidence.
 * @param {Map<string, number> | null | undefined} gaps @param {string} metric
 */
export function evidenceCause(gaps, metric) {
  if (!gaps || !gaps.size) return null;
  const names = [...gaps].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model === "<unknown>" ? "unattributed model" : model);
  return `${names.length} model${names.length === 1 ? "" : "s"} ${gapPhrases[metric] ?? "without metric evidence"}: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2} more` : ""}`;
}
// Native Cursor composer evidence (no evidence source) has provider-reported, undated value and no
// API pricing or cache split. Every other ledger records the evidence columns of its cells.
const nativeCursor = (session) => session.provider === "cursor" && !session.evidence?.source;
const cacheWriteSources = new Set(["opencode-db", "cursor-sdk"]);
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

const dayFormatters = new Map();
export function localDay(timestamp, timeZone = "UTC") {
  // Match the ledger's absolute-timestamp contract before Date can apply the
  // browser's timezone (or turn null into the Unix epoch).
  if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) return null;
  const normalized = normalizeTimestamp(timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!normalized) return null;
  const date = new Date(normalized);
  if (!Number.isFinite(date.valueOf())) return null;
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
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
export const ledgerlessSources = new Set(["conductor-result", "cursor-sdk", "cursor-transcript", "copilot-events", "opencode-db", "gemini-chat"]);

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
export function buildVelocity(sessions, { start, end, group = "agent", metric = "value", granularity = "day", mode = "lines", limit = 7 } = {}) {
  const index = metricDefinitions[metric].index;
  const dates = calendarDays(start, end);
  const dailyMap = new Map(dates.map((day) => [day, { day, values: blank(), total: 0, evidence: blankEvidence(), gaps: null }]));
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
      // Which models lack evidence, so a partial comparison can name its cause.
      if (observedEvidence.known < observedEvidence.eligible) {
        daily.gaps ??= new Map();
        daily.gaps.set(dimension.model, (daily.gaps.get(dimension.model) ?? 0) + observedEvidence.eligible - observedEvidence.known);
      }
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
  // Agents fold to the five largest; repositories and models to `limit`. A single remaining series is shown itself.
  const cap = group === "agent" ? Math.min(limit, agentSeriesLimit) : limit;
  if ((group === "repository" || group === "model" || group === "agent") && series.length > cap + 1) {
    const remainder = series.slice(cap);
    const other = { id: "other", label: `Other (${remainder.length})`, total: sum(remainder.map((item) => item.total)), values: keys.map((_, i) => sum(remainder.map((item) => item.values[i]))), calls: sum(remainder.map((item) => item.calls)), evidence: remainder.reduce((total, item) => addEvidence(total, item.evidence), blankEvidence()), sums: remainder.reduce((total, item) => add(total, item.sums), blank()), sessions: sum(remainder.map((item) => item.sessions)) };
    series = [...series.slice(0, cap), other];
  }
  const daily = [...dailyMap.values()];
  // The 7-day average of the plotted total over observed dates. Days with incomplete metric evidence count with
  // their observed value and mark the point partial; below the evidence floor (or with an unrecorded metric) the
  // average is withheld rather than shown as a decline.
  const rollingPartial = daily.map(() => false);
  const rolling = daily.map((_, i) => {
    if (i < 6 || earliest === null || daily[i - 6].day < earliest || missingSessions) return null;
    const days = daily.slice(i - 6, i + 1);
    const windowEvidence = days.reduce((total, item) => addEvidence(total, item.evidence), blankEvidence());
    if (windowEvidence.unsupported || evidenceShare(windowEvidence) < comparisonEvidenceFloor) return null;
    rollingPartial[i] = !windowEvidence.complete;
    return sum(days.map((item) => item.total)) / 7;
  });
  if (mode === "cumulative" && granularity !== "hour") series = series.map((item) => { let running = 0; return { ...item, values: item.values.map((value) => running += value) }; });
  return { start, end, group, metric, granularity, mode, keys, series, allSeries, daily, rolling, rollingPartial, totals, undated, sessionDated, sessionDatedSessions, coverage, evidence, earliest, missingSessions, unledgered, contributingSessions };
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

/**
 * Minimum share of eligible tokens with known metric evidence (priced tokens for value) for comparisons, burn,
 * projection, movers and the rolling average. Between the floor and 100% the figure uses observed values, is marked
 * partial and names the models missing evidence; below it the figure is unavailable with that cause.
 */
export const comparisonEvidenceFloor = 0.75;
const evidenceShare = (evidence) => evidence.eligible > 0 ? evidence.known / evidence.eligible : 1;
const evidenceNoun = (metric) => metric === "value" ? "of tokens priced" : "metric evidence";
const floorText = () => `${Math.round(comparisonEvidenceFloor * 100)}% needed`;
/** "Prior period below the minimum baseline ($0.01 USD, 3 model calls)"-style minimums for a metric. */
const minimumText = (metric) => {
  const definition = metricDefinitions[metric];
  return definition.index < 7 ? `${definition.minimum} ${definition.unit}, 3 model calls` : `${definition.minimum} ${definition.unit}`;
};

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
 * The first evidence problem among labelled periods: an unrecorded metric, or a share below the floor (named with
 * the models missing evidence). Null when every period is usable.
 * @param {Array<[string, { evidence: { known: number, eligible: number, unsupported: number }, gaps?: Map<string, number> | null }]>} periods
 */
function evidenceProblem(periods, metric) {
  if (periods.some(([, period]) => period.evidence.unsupported)) return "Metric not recorded by some providers";
  const weak = periods.find(([, period]) => evidenceShare(period.evidence) < comparisonEvidenceFloor);
  if (!weak) return null;
  const cause = evidenceCause(weak[1].gaps, metric);
  return `${cause ? `${cause} · ` : ""}${Math.floor(100 * evidenceShare(weak[1].evidence))}% ${evidenceNoun(metric)} in ${weak[0]}; ${floorText()}`;
}
/** Whether usable periods are still partial, and the models that make them so. */
function partialEvidence(periods, metric) {
  const partial = periods.some((period) => !period.evidence.complete);
  return { partial, cause: partial ? evidenceCause(mergeGaps(...periods.map((period) => period.gaps)), metric) : null };
}

/**
 * Classifies one like-for-like period comparison. `status` is `change` (a guarded percentage),
 * `new` (observed zero before, activity now), `idle` (observed zero on both sides) or
 * `unavailable` with a specific `reason`. A delta is never Infinity, NaN or an invented 0%.
 * `partial` marks observed values with incomplete metric evidence; `cause` names the models.
 */
export function comparePeriods(current, previous, metric, { missingSessions = 0 } = {}) {
  const result = { current, previous, delta: null, status: "unavailable", reason: null, partial: false, cause: null };
  if (missingSessions) return { ...result, reason: "Refresh: some sessions have no activity ledger" };
  // The prior period always precedes the current one, so it is the side that can predate history.
  if (!previous.covered || !current.covered) return { ...result, reason: previous.coveredDays ? "Prior period is only partly observed" : "No observed history for the prior period" };
  const problem = evidenceProblem([["the current period", current], ["the prior period", previous]], metric);
  if (problem) return { ...result, reason: problem };
  const { partial, cause } = partialEvidence([current, previous], metric);
  if (previous.value === 0) return { ...result, partial, cause, status: current.value === 0 ? "idle" : "new" };
  const delta = guardedDelta(current.value, previous.value, metric, previous.calls);
  if (delta === null) return { ...result, partial, cause, reason: `Prior period below the minimum baseline (${minimumText(metric)})` };
  return { ...result, partial, cause, delta, status: "change" };
}

/** A whole buildVelocity window as one comparison period, covered only inside observed history. */
export function periodFromVelocity(data) {
  const index = metricDefinitions[data.metric].index;
  const coveredDays = data.daily.filter(({ day }) => data.earliest !== null && day >= data.earliest).length;
  return { start: data.start, end: data.end, days: data.daily.length, coveredDays, covered: data.daily.length > 0 && coveredDays === data.daily.length, value: data.totals[index], calls: data.totals[7], evidence: { ...data.evidence }, gaps: mergeGaps(...data.daily.map((day) => day.gaps)) };
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
  const metric = data.metric;
  const end = data.end < today ? data.end : today;
  const completeThrough = end === today ? shiftDay(today, -1) : end;
  const days = new Map(data.daily.map((item) => [item.day, item]));
  const observedStart = data.earliest && data.earliest > data.start ? data.earliest : data.start;
  const range = (start, finish) => {
    const dates = calendarDays(start, finish);
    const rows = dates.map((day) => days.get(day));
    const covered = dates.length > 0 && start >= observedStart && finish <= data.end && rows.every(Boolean);
    return { start, end: finish, days: dates.length, coveredDays: dates.filter((day) => day >= observedStart && days.has(day)).length, covered, value: sum(rows.map((row) => row?.total || 0)), calls: sum(rows.map((row) => row?.values[7] || 0)), evidence: rows.reduce((total, row) => row ? addEvidence(total, row.evidence) : total, blankEvidence()), gaps: mergeGaps(...rows.map((row) => row?.gaps)) };
  };
  const refresh = "Refresh: some sessions have no activity ledger";
  const { week, month } = periodComparisons(range, end, completeThrough, metric, { missingSessions: data.missingSessions });
  const monthStart = `${end.slice(0, 7)}-01`;

  // Today / 14-day median: the ratio needs today in the window, a fully observed baseline with enough evidence,
  // three active baseline days and a median above the metric minimum. Each failure names itself.
  const trailing = range(shiftDay(end, -14), shiftDay(end, -1));
  const baseline = calendarDays(trailing.start, trailing.end).map((day) => days.get(day)?.total || 0);
  const todayPeriod = range(today, today);
  const todayValue = end === today ? days.get(today)?.total ?? null : null;
  const activeDays = baseline.filter((v) => v > 0).length;
  const baselineProblem = data.missingSessions ? refresh : !trailing.covered ? `${trailing.coveredDays} of 14 baseline days observed; all 14 needed` : evidenceProblem([["the 14-day baseline", trailing]], metric);
  const median = baselineProblem ? null : quantile(baseline, 0.5);
  const burn = { today: todayValue, median, days: trailing.coveredDays, activeDays, ratio: null, partial: false, cause: null, reason: null, todayEvidence: todayPeriod.evidence, baselineEvidence: trailing.evidence };
  burn.reason = todayValue === null ? "Only for a window that includes today"
    : baselineProblem ?? evidenceProblem([["today", todayPeriod]], metric)
    ?? (activeDays < 3 ? `${activeDays} active day${activeDays === 1 ? "" : "s"} in the 14-day baseline; 3 needed`
      : guardedDelta(median, median, metric, trailing.calls) === null ? `14-day median below the minimum baseline (${minimumText(metric)})` : null);
  if (!burn.reason) Object.assign(burn, { ratio: todayValue / median }, partialEvidence([trailing, todayPeriod], metric));

  // End-of-month scenario: completed month-to-date plus the remaining days at the trailing daily quantiles.
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
  const projectionReason = remaining <= 0 ? "No days left to project in this month"
    : data.missingSessions ? refresh
    : elapsed.days === 0 ? "No completed day this month yet"
    : !elapsed.covered || !observedPeriod.covered ? "Observed history starts after the 1st of this month"
    : !sample.covered || history.length < 7 ? `${history.length} completed day${history.length === 1 ? "" : "s"} of observed history; 7 needed`
    : evidenceProblem([["this month", observedPeriod], ["the sampled days", sample]], metric)
    ?? (active < 3 ? `${active} active day${active === 1 ? "" : "s"} in the last ${history.length}; 3 needed`
      : guardedDelta(sum(history), sum(history), metric, sample.calls) === null ? `Sampled days below the minimum baseline (${minimumText(metric)})` : null);
  let projection = null;
  if (!projectionReason) {
    const project = (fraction) => {
      const rate = quantile(history, fraction);
      // A busy partial day must not consume the allowance for future full days.
      const partialDayAdjustment = end === today ? Math.max(0, (days.get(today)?.total || 0) - rate) : 0;
      return elapsed.value + rate * remaining + partialDayAdjustment;
    };
    projection = { value: project(0.5), low: project(0.1), high: project(0.9), observed, sampleDays: history.length, activeDays: active, remainingDays: remaining, monthEnd, ...partialEvidence([observedPeriod, sample], metric) };
  }
  return { week, month, burn, projection, projectionReason, projectionEvidence, completeThrough, end, trailing };
}

/** The smallest prior value a mover's percentage is shown for: $1 of usage value, otherwise the metric minimum. */
export function moverBaseline(metric) { return metric === "value" ? 1 : metricDefinitions[metric].minimum; }

/**
 * The largest changes, up and down, between the last 7 completed days and the 7 before, for repositories, models
 * and agents: three per dimension by absolute change, then ordered by absolute change. A percentage needs a prior
 * value of at least `moverBaseline` (and 3 prior model calls for value and tokens); `base` says why it is absent.
 */
export function topMovers(sessions, options, today) {
  options = { ...options, metric: options.metric ?? "value" };
  const metric = options.metric;
  const end = options.end < today ? options.end : shiftDay(today, -1);
  const start = shiftDay(end, -6), previousStart = shiftDay(start, -7), previousEnd = shiftDay(start, -1);
  const result = { start, end, previousStart, previousEnd, available: false, excludedGroups: 0, rows: [] };
  if (previousStart < options.start || !sessions.length) return result;
  for (const group of ["repository", "model", "agent"]) {
    const current = buildVelocity(sessions, { ...options, group, start, end, limit: Infinity });
    if (!current.earliest || current.earliest > previousStart || current.missingSessions) return { ...result, rows: [] };
    const previous = buildVelocity(sessions, { ...options, group, start: previousStart, end: previousEnd, limit: Infinity });
    const prior = new Map(previous.allSeries.map((item) => [item.id, item]));
    const latest = new Map(current.allSeries.map((item) => [item.id, item]));
    const rows = [];
    for (const id of new Set([...latest.keys(), ...prior.keys()])) {
      const item = latest.get(id), before = prior.get(id);
      const currentEvidence = item?.evidence ?? blankEvidence(), previousEvidence = before?.evidence ?? blankEvidence();
      if (evidenceProblem([["current", { evidence: currentEvidence }], ["prior", { evidence: previousEvidence }]], metric)) { result.excludedGroups += 1; continue; }
      const value = item?.total || 0, previousValue = before?.total || 0, change = value - previousValue;
      if (change === 0) continue;
      const small = previousValue > 0 && previousValue < moverBaseline(metric);
      const delta = previousValue === 0 || small ? null : guardedDelta(value, previousValue, metric, before?.calls || 0);
      const base = previousValue === 0 ? "new" : delta === null ? "small" : null;
      rows.push({ group, label: (item ?? before).label, current: value, previous: previousValue, change, delta, base, partial: !currentEvidence.complete || !previousEvidence.complete, currentEvidence, previousEvidence });
    }
    rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.label.localeCompare(b.label));
    result.rows.push(...rows.slice(0, 3));
  }
  result.rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.label.localeCompare(b.label));
  result.available = true;
  return result;
}
