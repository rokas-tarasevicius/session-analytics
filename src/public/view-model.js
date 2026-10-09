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
  for (const session of sessions.filter((s) => field !== "tools" || metricEligible(s, field))) for (const [name, value] of Object.entries(session[field])) totals.set(name, (totals.get(name) || 0) + value);
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
  if (summaries) warnings.push(`${summaries}/${sessions.length} sessions use summary evidence: their value is dated by run or session time, not per request. See evidence coverage below.`);
  if (unpriced) warnings.push(`${unpriced} sessions have incomplete token pricing.`);
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

/** Whole-session provider value, with model evidence kept separate from unattributed value. */
export function costByModel(sessions) {
  const models = mergeModels(sessions).map((model) => ({
    provider: model.provider, model: model.model, value: model.totalUsd, share: 0,
    sessions: model.selected, calls: model.calls, inputTokens: model.inputTokens, outputTokens: model.outputTokens,
    components: { input: model.inputUsd, cached: model.cachedInputUsd, write: model.cacheWriteUsd, output: model.outputUsd },
    priced: model.priced, eligible: model.eligible.value, selected: model.selected,
    evidence: { calls: model.eligible.calls, tokens: model.eligible.input },
  })).sort((left, right) => right.value - left.value || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model));
  const providers = providerOrder.map((provider) => {
    const selected = sessions.filter((session) => session.provider === provider), cost = costTotals(selected);
    const providerModels = models.filter((model) => model.provider === provider), total = cost.total + cost.reported;
    return { provider, total, api: cost.total, reported: cost.reported,
      unattributed: Math.max(0, total - providerModels.reduce((sum, model) => sum + model.value, 0)),
      coverage: metricCoverage(selected, "cost"), models: providerModels };
  }).filter(({ total, models }) => total > 0 || models.length);
  const total = providers.reduce((sum, provider) => sum + provider.total, 0);
  for (const model of models) model.share = total > 0 ? model.value / total : 0;
  return { total, providers, models };
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
    if (session.transcript?.startTimeKnown === false || session.evidence?.timing === "file-mtime") continue;
    const at = timestampMilliseconds(session.createdAt);
    if (!Number.isFinite(at)) continue;
    const position = index.get(new Date(at).toISOString().slice(0, 10));
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
  const { start: clampedStart, end: clampedEnd } = resolveCustomWindow({ start, end, min, max });
  return { start: clampedStart, end: clampedEnd };
}

/** A calendar day `YYYY-MM-DD` that exists, or null. */
export function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/**
 * Resolves a custom date range edit. An empty or invalid bound keeps its previous value (clearing one date never
 * wipes the other), a reversed range swaps, and both bounds are clamped to the observed history. `adjusted` lists
 * what changed so the interface can say so.
 */
export function resolveCustomWindow({ start, end, previousStart = null, previousEnd = null, min, max }) {
  const adjusted = [];
  let from = validDay(start), to = validDay(end);
  if (!from) {
    from = validDay(previousStart) ?? min;
    if (start) adjusted.push("invalid-start");
  }
  if (!to) {
    to = validDay(previousEnd) ?? max;
    if (end) adjusted.push("invalid-end");
  }
  if (from > to) { [from, to] = [to, from]; adjusted.push("swapped"); }
  const clamp = (day) => (day < min ? min : day > max ? max : day);
  if (clamp(from) !== from || clamp(to) !== to) adjusted.push("clamped");
  from = clamp(from); to = clamp(to);
  return { adjusted, end: to, start: from };
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

// Match tiers, best first. A label match outranks the same tier in keywords or the group name.
const matchTiers = { exact: 5, prefix: 4, wordStart: 3, substring: 2, subsequence: 1, none: 0 };

function isSubsequence(term, text) {
  let position = 0;
  for (const character of term) {
    position = text.indexOf(character, position);
    if (position < 0) return false;
    position += 1;
  }
  return true;
}

function termTier(term, text) {
  if (!text) return matchTiers.none;
  if (text === term) return matchTiers.exact;
  if (text.startsWith(term)) return matchTiers.prefix;
  if (text.split(/[^a-z0-9]+/).some((word) => word.startsWith(term))) return matchTiers.wordStart;
  if (text.includes(term)) return matchTiers.substring;
  return isSubsequence(term, text) ? matchTiers.subsequence : matchTiers.none;
}

/**
 * Scores a palette item for a query: 0 when any term is missing, otherwise higher for exact, then prefix,
 * word-start, substring and finally subsequence matches, with label matches ahead of keyword matches.
 * `tier` is the weakest term's match tier.
 */
export function paletteScore(item, query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 1, tier: matchTiers.exact };
  const label = String(item.label || "").toLowerCase();
  const other = `${item.keywords || ""} ${item.group || ""}`.toLowerCase();
  const whole = query.trim().toLowerCase();
  let score = 0, tier = matchTiers.exact;
  for (const term of terms) {
    const inLabel = termTier(term, label), inOther = termTier(term, other);
    const best = Math.max(inLabel, inOther);
    if (best === matchTiers.none) return { score: 0, tier: matchTiers.none };
    tier = Math.min(tier, best);
    score += best * 2 + (inLabel >= inOther ? 1 : 0);
  }
  if (label === whole) score += 100;
  return { score, tier };
}

/** Palette matching: every term must at least be an ordered subsequence of the item text. */
export function matchesQuery(item, query) {
  return paletteScore(item, query).score > 0;
}

/**
 * Filters and orders palette items for a query. Subsequence-only matches are dropped when any item matches every
 * term as a substring or better. Items stay clustered by group; groups are ordered by their best item, and items
 * within a group by score, with the original order breaking ties.
 */
export function rankPaletteItems(items, query) {
  if (!String(query || "").trim()) return items.slice();
  const scored = items.map((item, index) => ({ index, item, ...paletteScore(item, query) })).filter(({ score }) => score > 0);
  const strong = scored.some(({ tier }) => tier > matchTiers.subsequence);
  const kept = strong ? scored.filter(({ tier }) => tier > matchTiers.subsequence) : scored;
  const groupBest = new Map(), groupFirst = new Map();
  for (const entry of kept) {
    groupBest.set(entry.item.group, Math.max(groupBest.get(entry.item.group) ?? 0, entry.score));
    if (!groupFirst.has(entry.item.group)) groupFirst.set(entry.item.group, entry.index);
  }
  return kept.sort((left, right) => {
    const leftGroup = left.item.group, rightGroup = right.item.group;
    if (leftGroup !== rightGroup) return groupBest.get(rightGroup) - groupBest.get(leftGroup) || groupFirst.get(leftGroup) - groupFirst.get(rightGroup);
    return right.score - left.score || left.index - right.index;
  }).map(({ item }) => item);
}

// Typing into these must never trigger single-key shortcuts. Checkboxes, radios, buttons and ranges do not take text.
const textInputTypes = new Set(["", "date", "datetime-local", "email", "month", "number", "password", "search", "tel", "text", "time", "url", "week"]);

/** True when a key press on `target` is text entry (text-like inputs, textareas, selects, editable content). */
export function isTextEntryTarget(target) {
  if (!target || typeof target !== "object") return false;
  if (target.isContentEditable === true) return true;
  const tag = String(target.tagName || "").toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  return textInputTypes.has(String(target.type ?? "").toLowerCase());
}

/** Providers that appear in the sessions, in the fixed provider order. */
export function presentProviders(sessions) {
  const seen = new Set();
  for (const session of sessions) seen.add(session.provider);
  return providerOrder.filter((provider) => seen.has(provider));
}

/** The provider a `p` then digit chord toggles: the nth visible chip, or null. */
export function providerShortcutTarget(key, providers) {
  if (!/^[1-9]$/.test(String(key))) return null;
  return providers[Number(key) - 1] ?? null;
}

/** Runs one `task` at a time: calls made while it is pending share its promise instead of starting another. */
export function singleFlight(task) {
  let pending = null;
  return (...args) => {
    if (!pending) pending = (async () => task(...args))().finally(() => { pending = null; });
    return pending;
  };
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
  return id.slice(-8);
}
