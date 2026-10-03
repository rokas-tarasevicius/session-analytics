// Pure view-model helpers for the dashboard: aggregation, window math, deltas,
// sparkline downsampling, sorting, and palette matching. No DOM access, so the
// same module is exercised by test/dashboard-helpers.test.ts under node:test.

import { timestampMilliseconds, utcDayBounds } from "./timestamps.js";
import { providerIds, providerLabels, metricEligible, metricCoverage } from "./providers.js";
export const providerOrder = providerIds;
export { providerLabels };

const tokenFields = ["cacheWrite1hInputTokens", "cacheWrite5mInputTokens", "cacheWriteInputTokens", "cachedInputTokens", "inputTokens", "nonReasoningOutputTokens", "outputTokens", "reasoningOutputTokens", "uncachedInputTokens"];
const costFields = ["cacheWriteUsd", "cachedInputUsd", "inputUsd", "outputUsd", "totalUsd", "upperEstimateUsd"];
const compact = new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" });

export function shortMoney(value) {
  const amount = value || 0;
  if (amount >= 1000) return `$${compact.format(amount)}`;
  if (amount >= 100) return `$${amount.toFixed(0)}`;
  return `$${amount.toFixed(amount >= 10 ? 1 : 2).replace(/\.0$/, "")}`;
}

export function percent(value) {
  return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

export function summarize(sessions) {
  const totals = { inputTokens: 0, outputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
  let pricedTokens = 0, observedTokens = 0;
  const summary = { coverage: Object.fromEntries(["tokens", "tools", "compactions", "cost", "apiCost", "reportedCost"].map((metric) => [metric, metricCoverage(sessions, metric)])), analyzedSessions: 0, apiEquivalentSpendUsd: 0, cacheReadRatio: null, compactions: 0, estimatedSpendUsd: 0, estimatedUpperSpendUsd: 0, missingTranscripts: 0, outputTokens: 0, pricedTokenCoverage: null, providerReportedSpendUsd: 0, sessions: sessions.length, subagentSessions: 0, subagentSpendUsd: 0, toolCalls: 0, topLevelSessions: 0, topLevelSpendUsd: 0, totalInputTokens: 0, unpricedSessions: 0 };
  for (const session of sessions) {
    summary.analyzedSessions += session.transcript.status === "ok" ? 1 : 0;
    summary.missingTranscripts += session.transcript.status === "missing" ? 1 : 0;
    if (metricEligible(session, "compactions")) summary.compactions += session.metrics.compactions;
    if (metricEligible(session, "tools")) summary.toolCalls += session.metrics.toolCalls;
    if (metricEligible(session, "cost")) { summary.estimatedSpendUsd += session.cost.totalUsd; summary.estimatedUpperSpendUsd += session.cost.upperEstimateUsd; }
    summary.apiEquivalentSpendUsd += metricEligible(session, "apiCost") ? session.cost.totalUsd : 0;
    summary.providerReportedSpendUsd += metricEligible(session, "reportedCost") ? session.cost.totalUsd : 0;
    summary.subagentSessions += session.executionKind === "subagent" || session.executionKind === "mixed" ? 1 : 0;
    summary.topLevelSessions += session.executionKind === "top-level" || session.executionKind === "mixed" ? 1 : 0;
    summary.subagentSpendUsd += session.costByExecution?.subagentUsd || 0;
    summary.topLevelSpendUsd += session.costByExecution?.topLevelUsd || 0;
    if (metricEligible(session, "tokens")) { summary.totalInputTokens += session.tokens.inputTokens; summary.outputTokens += session.tokens.outputTokens; }
    summary.unpricedSessions += !session.costComplete && session.pricedTokenCoverage !== null ? 1 : 0;
    if (metricEligible(session, "tokens")) for (const key of Object.keys(totals)) totals[key] += session.tokens[key] || 0;
    const count = session.tokens.inputTokens + session.tokens.outputTokens;
    if (session.pricedTokenCoverage !== null && metricEligible(session, "tokens")) {
      observedTokens += count; pricedTokens += count * session.pricedTokenCoverage;
    }
  }
  const cacheDenominator = totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheWriteInputTokens;
  summary.cacheReadRatio = cacheDenominator ? totals.cachedInputTokens / cacheDenominator : null;
  summary.pricedTokenCoverage = observedTokens ? pricedTokens / observedTokens : null;
  return summary;
}

export function mergeModels(sessions) {
  const models = new Map();
  for (const session of sessions) for (const source of session.models) {
    const key = `${session.provider}:${source.model}`;
    const target = models.get(key) || { model: source.model, provider: session.provider, calls: 0, priced: true, selected: 0, eligible: { calls: 0, input: 0, output: 0, value: 0 } };
    target.selected++;
    for (const [metric, eligibility] of Object.entries({ calls: "calls", input: "tokens", output: "tokens", value: "cost" })) if (metricEligible(session, eligibility)) target.eligible[metric]++;
    for (const key of [...tokenFields, ...costFields, "calls"]) {
      const metric = key === "calls" ? "calls" : tokenFields.includes(key) ? "tokens" : "cost";
      if (metricEligible(session, metric)) target[key] = (target[key] || 0) + (source[key] || 0);
      else target[key] ||= 0;
    }
    target.priced = target.priced && source.priced; models.set(key, target);
  }
  return [...models.values()].sort((left, right) => right.totalUsd - left.totalUsd);
}

export function namedTotals(sessions, field) {
  const totals = new Map();
  for (const session of sessions.filter((s) => !["tools", "skills"].includes(field) || metricEligible(s, field))) for (const [name, value] of Object.entries(session[field])) totals.set(name, (totals.get(name) || 0) + value);
  return [...totals].map(([name, value]) => ({ name, value })).sort((left, right) => right.value - left.value);
}

export function spendDays(sessions) {
  return namedTotals(sessions, "spendByDay").sort((left, right) => left.name.localeCompare(right.name));
}

export function coverageWarnings(sessions) {
  const missing = sessions.filter(({ transcript }) => transcript.status === "missing");
  const legacy = missing.filter(({ transcript }) => transcript.warnings.includes("Conductor has no provider session ID.")).length;
  const unmatched = missing.length - legacy, unpriced = sessions.filter(({ costComplete, pricedTokenCoverage }) => !costComplete && pricedTokenCoverage !== null).length;
  const warnings = [];
  const retained = sessions.filter((s) => s.transcript.sourceDeleted).length;
  if (retained) warnings.push(`${retained} sessions include source-deleted history; facts and prices are from their last successful ingest.`);
  if (sessions.some((s) => s.transcript.warnings.includes("Source availability could not be checked; showing the last indexed facts."))) warnings.push("Source availability could not be checked; showing the last indexed facts.");
  const partial = sessions.filter((s) => s.evidence?.accounting === "partial").length;
  if (partial) warnings.push(`${partial}/${sessions.length} sessions have partial accounting; retained totals do not prove complete history.`);
  if (legacy) warnings.push(`${legacy} legacy session${legacy === 1 ? "" : "s"} cannot be correlated because Conductor recorded no provider session ID.`);
  if (unmatched) warnings.push(`${unmatched} session${unmatched === 1 ? "" : "s"} have a provider ID but no validated local transcript.`);
  const activityOnly = sessions.filter((s) => s.evidence?.tokens === "unavailable").length;
  const summaries = sessions.filter((s) => s.evidence?.fidelity === "summary").length;
  if (activityOnly) warnings.push(`${activityOnly}/${sessions.length} sessions have no token evidence; their usage value is unavailable, not zero.`);
  if (summaries) warnings.push(`${summaries}/${sessions.length} sessions use summary evidence with no per-request daily cost attribution. See evidence coverage below.`);
  if (unpriced) warnings.push(`${unpriced} session${unpriced === 1 ? "" : "s"} include models without a rate card.`);
  return warnings;
}

export function costTotals(sessions) {
  const result = { cached: 0, input: 0, output: 0, reported: 0, total: 0, upper: 0, write: 0 };
  for (const session of sessions) {
    if (!metricEligible(session, "cost")) continue;
    if (session.costBasis === "provider-reported") result.reported += session.cost.totalUsd;
    if (session.costBasis !== "api-list-price-equivalent") continue;
    result.cached += session.cost.cachedInputUsd; result.input += session.cost.inputUsd;
    result.output += session.cost.outputUsd; result.write += session.cost.cacheWriteUsd;
    result.total += session.cost.totalUsd; result.upper += session.cost.upperEstimateUsd;
  }
  return result;
}

export function evidenceLabel(sessions) {
  const evidence = new Set(sessions.map(({ skillEvidence }) => skillEvidence));
  if (evidence.has("explicit") && evidence.has("inferred")) return "Explicit + lower bound";
  if (evidence.has("explicit")) return "Explicit";
  if (evidence.has("inferred")) return "Lower bound";
  return "N/A";
}

/** Groups sessions by repository ID once per snapshot so views never rescan the full list per repository. */
export function groupByRepository(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const list = groups.get(session.repositoryId);
    if (list) list.push(session); else groups.set(session.repositoryId, [session]);
  }
  return groups;
}

export function sessionsInRange(sessions, startDay, endDay) {
  if (!startDay && !endDay) return sessions.slice();
  const bounds = utcDayBounds(startDay || null, endDay || null);
  const start = bounds.start ? timestampMilliseconds(bounds.start) : -Infinity;
  const end = bounds.end ? timestampMilliseconds(bounds.end) : Infinity;
  return sessions.filter((session) => {
    const at = timestampMilliseconds(session.createdAt);
    return session.transcript?.startTimeKnown !== false && session.evidence?.timing !== "file-mtime" && Number.isFinite(at) && at >= start && at < end;
  });
}

const isoDay = (date) => date.toISOString().slice(0, 10);

export function daysBetween(startDay, endDay, cap = 3660) {
  const days = [];
  if (!startDay || !endDay || startDay > endDay) return days;
  const first = new Date(`${startDay}T00:00:00Z`), last = new Date(`${endDay}T00:00:00Z`);
  if (Number.isNaN(first.valueOf()) || Number.isNaN(last.valueOf())) return days;
  for (let day = first, count = 0; day <= last && count < cap; day = new Date(day.valueOf() + 86_400_000), count += 1) days.push(isoDay(day));
  return days;
}

export function dailySpendSeries(sessions, days) {
  const index = new Map(days.map((day, position) => [day, position]));
  const values = days.map(() => 0);
  for (const session of sessions) for (const [day, value] of Object.entries(session.spendByDay)) {
    const position = index.get(day);
    if (position !== undefined) values[position] += value;
  }
  return values;
}

export function dailyCountSeries(sessions, days, accessor) {
  const index = new Map(days.map((day, position) => [day, position]));
  const values = days.map(() => 0);
  for (const session of sessions) {
    const position = index.get(session.createdAt.slice(0, 10));
    if (position !== undefined) values[position] += accessor(session);
  }
  return values;
}

/** The start day for a preset window ending on `maxDay`, never earlier than `minDay`. */
export function windowStartFor(preset, minDay, maxDay) {
  if (preset === "all" || !/^\d+$/.test(String(preset))) return minDay;
  const start = new Date(`${maxDay}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - Number(preset) + 1);
  const day = isoDay(start);
  return day < minDay ? minDay : day;
}

/** Clamps a custom range to the observed range and keeps start <= end. */
export function clampWindow({ start, end, min, max }) {
  const clamp = (value, fallback) => {
    const day = value || fallback;
    return day < min ? min : day > max ? max : day;
  };
  let clampedStart = clamp(start, min), clampedEnd = clamp(end, max);
  if (clampedStart > clampedEnd) clampedEnd = clampedStart;
  return { start: clampedStart, end: clampedEnd };
}

/** The equal-length period before [start, end], only when it lies wholly inside the observed history. */
export function previousPeriod({ start, end, min }) {
  const length = daysBetween(start, end).length;
  if (!length || !min) return null;
  const endDate = new Date(`${start}T00:00:00Z`); endDate.setUTCDate(endDate.getUTCDate() - 1);
  const startDate = new Date(endDate); startDate.setUTCDate(startDate.getUTCDate() - length + 1);
  const startDay = isoDay(startDate), endDay = isoDay(endDate);
  if (startDay < min) return null;
  return { endDay, length, startDay };
}

export function deltaDescription(current, previous, length) {
  if (previous === null || previous === undefined) return null;
  if (previous === 0 && current === 0) return null;
  const label = `vs previous ${length}d`;
  if (previous === 0) return { direction: "up", label: `No activity in the previous ${length} days`, text: `new · ${label}` };
  const change = (current - previous) / previous;
  const direction = Math.abs(change) < 0.0005 ? "flat" : change > 0 ? "up" : "down";
  const magnitude = `${Math.abs(change * 100).toFixed(1)}%`;
  return {
    direction,
    label: `${direction === "up" ? "Up" : direction === "down" ? "Down" : "Unchanged"} ${magnitude} versus the previous ${length} days`,
    text: `${direction === "up" ? "▲" : direction === "down" ? "▼" : "▬"} ${magnitude} ${label}`,
  };
}

/** Sums a daily series into at most `maxPoints` buckets; `indexFor` maps a source index to its bucket. */
export function downsample(values, maxPoints) {
  if (values.length <= maxPoints) return { indexFor: (index) => index, values };
  const scale = maxPoints / values.length;
  const buckets = Array.from({ length: maxPoints }, () => 0);
  for (let index = 0; index < values.length; index += 1) buckets[Math.min(maxPoints - 1, Math.floor(index * scale))] += values[index];
  return { indexFor: (index) => index < 0 ? -1 : Math.min(maxPoints - 1, Math.floor(index * scale)), values: buckets };
}

export function sparklineSummary(label, values, days, format) {
  if (!values.length) return `${label}: no days in the window`;
  let peak = 0;
  for (let index = 1; index < values.length; index += 1) if (values[index] > values[peak]) peak = index;
  const total = values.reduce((sum, value) => sum + value, 0);
  const peakDay = days[peak] ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(`${days[peak]}T00:00:00`)) : "";
  return `${label}: ${values.length} day${values.length === 1 ? "" : "s"}, total ${format(total)}, peak ${format(values[peak])}${peakDay ? ` on ${peakDay}` : ""}, latest ${format(values.at(-1))}`;
}

export function heatLevel(value, maximum) {
  return value === 0 ? 0 : Math.max(1, Math.ceil((Math.log1p(value) / Math.log1p(Math.max(1, maximum))) * 7));
}

export function tickScale(maximum) {
  const roughTick = Math.max(0.001, maximum) / 4;
  const tickMagnitude = 10 ** Math.floor(Math.log10(roughTick));
  const tick = Math.ceil(roughTick / tickMagnitude) * tickMagnitude;
  return { axisMaximum: tick * 4, tick };
}

/** Palette matching: every term must be a substring or an ordered subsequence of the item text. */
export function matchesQuery(item, query) {
  if (!query) return true;
  const haystack = `${item.label} ${item.keywords || ""} ${item.group}`.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => {
    if (haystack.includes(term)) return true;
    let position = 0;
    for (const character of term) {
      position = haystack.indexOf(character, position);
      if (position < 0) return false;
      position += 1;
    }
    return true;
  });
}

export const tableAccessors = {
  cache: (item) => item.summary.cacheReadRatio ?? -1,
  coverage: (item) => item.summary.pricedTokenCoverage ?? -1,
  input: (item) => item.summary.totalInputTokens,
  name: (item) => item.repository.name.toLowerCase(),
  output: (item) => item.summary.outputTokens,
  sessions: (item) => item.summary.sessions,
  tools: (item) => item.summary.toolCalls,
  value: (item) => item.summary.estimatedSpendUsd,
};

export function sortRepositories(repositories, key, direction) {
  const accessor = tableAccessors[key] || tableAccessors.value;
  const sign = direction === "ascending" ? 1 : -1;
  return [...repositories].sort((a, b) => {
    const left = accessor(a), right = accessor(b);
    const order = typeof left === "string" ? left.localeCompare(right) : left - right;
    return order !== 0 ? order * sign : a.repository.name.localeCompare(b.repository.name);
  });
}

export function repositoryKey(id) {
  return id.startsWith("discovered-") ? id.slice(-8) : id.slice(0, 8);
}
