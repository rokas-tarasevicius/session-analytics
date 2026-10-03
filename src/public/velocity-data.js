// Pure calendar, aggregation and comparison functions shared by the two charts.
// All arithmetic on calendar dates uses UTC *as a calendar*, never as the bucket timezone.
export const metricDefinitions = {
  value: { index: 0, label: "Priced usage value", unit: "USD", minimum: 0.01 },
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
  cursor: "Cursor",
};
const providers = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
const blank = () => Array(14).fill(0);
const add = (a, b) => { for (let i = 0; i < 14; i += 1) a[i] += b[i] || 0; return a; };
const sum = (a) => a.reduce((total, value) => total + value, 0);

// Evidence is kept alongside observations at every aggregation level. A zero
// observation with eligible but unknown tokens must never look like inactivity.
const evidenceMetrics = { value: 10, reasoning: 11, uncached: 12, cacheRead: 12, cacheWrite: 13 };
const blankEvidence = () => ({ known: 0, eligible: 0, unsupported: 0, complete: true });
function addEvidence(target, source) {
  target.known += source.known; target.eligible += source.eligible; target.unsupported += source.unsupported;
  target.complete = target.known === target.eligible && target.unsupported === 0;
  return target;
}
function metricEvidence(provider, values, metric) {
  const index = evidenceMetrics[metric];
  if (index === undefined) return blankEvidence();
  const applicable = metric === "cacheWrite" ? provider === "claude" : provider !== "cursor";
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
  const date = new Date(timestamp);
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

/** Sum occupied hourly cells; never use session creation as the activity date. */
export function buildVelocity(sessions, { start, end, group = "agent", metric = "value", granularity = "day", mode = "lines", limit = 7 } = {}) {
  const index = metricDefinitions[metric].index;
  const dates = calendarDays(start, end);
  const dailyMap = new Map(dates.map((day) => [day, { day, values: blank(), total: 0, evidence: blankEvidence() }]));
  const keys = granularity === "hour" ? Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")) : [...new Set(dates.map((day) => periodKey(day, granularity)))];
  const keyIndexes = new Map(keys.map((key, i) => [key, i]));
  const groups = new Map();
  const totals = blank(), undated = blank();
  const evidence = blankEvidence();
  const coverage = { priceTokens: 0, cacheReadInput: 0, cacheWriteInput: 0, reasoningOutput: 0 };
  let earliest = null, missingSessions = 0, contributingSessions = 0;
  for (const session of sessions) {
    if (!session.velocity) { missingSessions += 1; continue; }
    let contributes = false;
    for (const [, values] of session.velocity.undated) add(undated, values);
    for (const [day, hour, dimensionId, values] of session.velocity.buckets) {
      if (earliest === null || day < earliest) earliest = day;
      const daily = dailyMap.get(day);
      if (!daily) continue;
      const dimension = session.velocity.dimensions[dimensionId];
      if (!dimension) continue;
      contributes = true;
      add(totals, values); add(daily.values, values); daily.total += values[index];
      const observedEvidence = metricEvidence(session.provider, values, metric);
      addEvidence(evidence, observedEvidence); addEvidence(daily.evidence, observedEvidence);
      if (session.provider !== "cursor") {
        coverage.priceTokens += values[1] + values[5];
        coverage.cacheReadInput += values[1];
        coverage.reasoningOutput += values[5];
      }
      if (session.provider === "claude") coverage.cacheWriteInput += values[1];
      const [id, label] = groupIdentity(session, dimension, group);
      let series = groups.get(id);
      if (!series) { series = { id, label, total: 0, values: keys.map(() => 0), calls: 0, evidence: blankEvidence() }; groups.set(id, series); }
      series.calls += values[7]; addEvidence(series.evidence, observedEvidence);
      const key = granularity === "hour" ? String(hour).padStart(2, "0") : periodKey(day, granularity);
      const position = keyIndexes.get(key);
      if (position !== undefined) { series.values[position] += values[index]; series.total += values[index]; }
    }
    if (contributes) contributingSessions += 1;
  }
  // Retain zero-valued groups in the accounting view: they can carry missing
  // evidence. Only the chart omits empty series.
  const allSeries = [...groups.values()].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  let series = allSeries.filter(({ total }) => total > 0);
  if ((group === "repository" || group === "model") && series.length > limit) {
    const remainder = series.slice(limit);
    const other = { id: "other", label: `Other (${remainder.length})`, total: sum(remainder.map((item) => item.total)), values: keys.map((_, i) => sum(remainder.map((item) => item.values[i]))), calls: sum(remainder.map((item) => item.calls)), evidence: remainder.reduce((total, item) => addEvidence(total, item.evidence), blankEvidence()) };
    series = [...series.slice(0, limit), other];
  }
  const daily = [...dailyMap.values()];
  const rolling = daily.map((_, i) => i < 6 || daily[i - 6].day < earliest || missingSessions || !daily.slice(i - 6, i + 1).every((item) => item.evidence.complete) ? null : sum(daily.slice(i - 6, i + 1).map((item) => item.total)) / 7);
  if (mode === "cumulative" && granularity !== "hour") series = series.map((item) => { let running = 0; return { ...item, values: item.values.map((value) => running += value) }; });
  return { start, end, group, metric, granularity, mode, keys, series, allSeries, daily, rolling, totals, undated, coverage, evidence, earliest, missingSessions, contributingSessions };
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
  const compare = (current, previous) => ({ current, previous, delta: supported(current) && supported(previous) ? guardedDelta(current.value, previous.value, data.metric, previous.calls) : null });
  const weekStart = periodKey(end, "week");
  const week = compare(range(weekStart, completeThrough), range(shiftDay(weekStart, -7), shiftDay(completeThrough, -7)));
  const monthStart = `${end.slice(0, 7)}-01`;
  const previousMonthEnd = shiftDay(monthStart, -1);
  const previousMonthStart = `${previousMonthEnd.slice(0, 7)}-01`;
  const completeMonthDays = calendarDays(monthStart, completeThrough).length;
  const pairedDays = Math.min(completeMonthDays, Number(previousMonthEnd.slice(-2)));
  const month = compare(range(monthStart, shiftDay(monthStart, pairedDays - 1)), range(previousMonthStart, shiftDay(previousMonthStart, pairedDays - 1)));
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
  if (supported(elapsed) && supported(observedPeriod) && supported(sample) && history.length >= 7 && active >= 3 && guardedDelta(sum(history), sum(history), data.metric, sample.calls) !== null) {
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
