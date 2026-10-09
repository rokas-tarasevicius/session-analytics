// Pure view-model helpers for the dashboard: aggregation, window math, deltas,
// sparkline downsampling, sorting, and palette matching. No DOM access, so the
// same module is exercised by test/dashboard-helpers.test.ts under node:test.

import { normalizeTimestamp } from "./timestamps.js";
import { providerIds, providerLabels, metricEligible, metricCoverage } from "./providers.js";
import { buildVelocity, calendarDays, ledgerCells, localDay } from "./velocity-data.js";
export const providerOrder = providerIds;
export { providerLabels };

const compact = new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" });

export function shortMoney(value) {
  const amount = value || 0;
  if (amount === 0) return "$0";
  if (Math.round(amount) >= 1000) return `$${compact.format(Math.max(1000, amount))}`;
  return `$${amount.toFixed(Math.round(amount * 100) >= 1000 ? 0 : 2)}`;
}

export function percent(value) {
  return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

export function summarize(sessions) {
  const totals = { inputTokens: 0, outputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
  let pricedTokens = 0, observedTokens = 0;
  const summary = { coverage: Object.fromEntries(["tokens", "tools", "compactions", "cost", "apiCost", "reportedCost"].map((metric) => [metric, metricCoverage(sessions, metric)])), analyzedSessions: 0, apiEquivalentSpendUsd: 0, cacheReadRatio: null, compactions: 0, estimatedSpendUsd: 0, estimatedUpperSpendUsd: 0, missingTranscripts: 0, mixedSessions: 0, outputTokens: 0, pricedTokenCoverage: null, providerReportedSpendUsd: 0, sessions: sessions.length, subagentSessions: 0, unknownExecutionSessions: 0, subagentSpendUsd: 0, toolCalls: 0, topLevelSessions: 0, topLevelSpendUsd: 0, totalInputTokens: 0, unpricedSessions: 0 };
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
    // Mixed sessions count in both counters above; these let a breakdown add up to `sessions`.
    summary.mixedSessions += session.executionKind === "mixed" ? 1 : 0;
    summary.unknownExecutionSessions += session.executionKind !== "mixed" && session.executionKind !== "top-level" && session.executionKind !== "subagent" ? 1 : 0;
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

export function namedTotals(sessions, field) {
  const totals = new Map();
  for (const session of sessions.filter((s) => field !== "tools" || metricEligible(s, field))) for (const [name, value] of Object.entries(session[field])) totals.set(name, (totals.get(name) || 0) + value);
  return [...totals].map(([name, value]) => ({ name, value })).sort((left, right) => right.value - left.value);
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

const blankCounters = () => Array(14).fill(0);
const addCounters = (target, source) => { for (let index = 0; index < 14; index += 1) target[index] += source[index] || 0; return target; };
const blankEvidence = () => ({ known: 0, eligible: 0, unsupported: 0, complete: true });
export function mergeEvidence(target, source) {
  target.known += source.known; target.eligible += source.eligible; target.unsupported += source.unsupported;
  target.complete = target.known === target.eligible && target.unsupported === 0;
  return target;
}

/**
 * Priced share of eligible tokens, rounded **down** to 0.1%: 1 only when every eligible token is priced, so a nearly
 * complete ledger never reads "100.0%". Null when no token is eligible (N/A, not 0%).
 */
export function pricedShare(evidence) {
  if (!evidence || !(evidence.eligible > 0)) return null;
  if (evidence.known >= evidence.eligible) return 1;
  return Math.min(999, Math.max(0, Math.floor((1000 * evidence.known) / evidence.eligible))) / 1000;
}

export function pricedPercent(evidence) {
  const share = pricedShare(evidence);
  return share === null ? "N/A" : `${(share * 100).toFixed(1)}%`;
}

/**
 * Cache-write upper-estimate premium per `${provider}:${model}` over the window's ledger cells. The upper estimate is
 * recorded per whole session, so each in-window cell's value is scaled by its session's own upper/ordinary ratio: a
 * session whose dated value lies inside the window keeps its exact upper estimate, and one straddling the window
 * boundary contributes in proportion to its dated value. Cells are those buildVelocity sums (`ledgerCells`, in-window
 * days, a known dimension).
 */
function upperPremiums(apiSessions, start, end) {
  const days = new Set(calendarDays(start, end)), premiums = new Map();
  if (!days.size) return premiums;
  for (const session of apiSessions) {
    const { cost, velocity } = session;
    if (!velocity || !cost || !(cost.totalUsd > 0) || !(cost.upperEstimateUsd > cost.totalUsd)) continue;
    const ratio = cost.upperEstimateUsd / cost.totalUsd - 1;
    for (const [day, , dimensionId, values] of ledgerCells(velocity)) {
      const dimension = velocity.dimensions[dimensionId];
      if (!dimension || !values[0] || !days.has(day)) continue;
      const key = `${session.provider}:${dimension.model}`;
      premiums.set(key, (premiums.get(key) ?? 0) + values[0] * ratio);
    }
  }
  return premiums;
}

/**
 * One window of the activity ledger for the money views (Costs, Pricing, model mix). Every figure is a buildVelocity
 * total over the same sessions and calendar dates as the Summary KPI and Velocity, so they agree. Sessions whose value
 * is provider-reported form one partition and every other session the API-equivalent one, so `api + reported` is the
 * window total. Undated value, older-snapshot sessions without a ledger and sessions needing a refresh are reported
 * (all time for the scope) and never added to the window.
 */
export function ledgerMoney(sessions, { start, end }) {
  const reportedSessions = [], apiSessions = [];
  for (const session of sessions) (session.costBasis === "provider-reported" ? reportedSessions : apiSessions).push(session);
  const options = { start, end, group: "model", metric: "value", limit: Infinity };
  const parts = [["api", buildVelocity(apiSessions, options)], ["reported", buildVelocity(reportedSessions, options)]];
  const models = new Map();
  for (const [basis, data] of parts) for (const series of data.allSeries) {
    const split = series.id.indexOf(":");
    const row = models.get(series.id) ?? { id: series.id, provider: series.id.slice(0, split), model: series.id.slice(split + 1), label: series.label,
      value: 0, api: 0, reported: 0, upper: 0, share: 0, sessions: 0, calls: 0, sums: blankCounters(), evidence: blankEvidence() };
    row.value += series.total; row[basis] += series.total; row.sessions += series.sessions; row.calls += series.calls;
    addCounters(row.sums, series.sums); mergeEvidence(row.evidence, series.evidence);
    models.set(series.id, row);
  }
  const [api, reported] = parts.map(([, data]) => data);
  const total = api.totals[0] + reported.totals[0];
  // `upper` is the API-equivalent value with the cache-write upper estimate; provider-reported value has none.
  const premiums = upperPremiums(apiSessions, start, end);
  let upperPremium = 0;
  for (const row of models.values()) { const premium = premiums.get(row.id) ?? 0; row.upper = row.api + premium; upperPremium += premium; }
  const providers = new Map();
  for (const row of models.values()) {
    const group = providers.get(row.provider) ?? { provider: row.provider, total: 0, api: 0, reported: 0, upper: 0, unattributed: 0, evidence: blankEvidence(), models: [] };
    group.total += row.value; group.api += row.api; group.reported += row.reported; group.upper += row.upper; mergeEvidence(group.evidence, row.evidence);
    if (row.model === "<unknown>") group.unattributed += row.value; else group.models.push(row);
    providers.set(row.provider, group);
  }
  const rank = (provider) => { const index = providerIds.indexOf(provider); return index < 0 ? providerIds.length : index; };
  const visible = (row) => row.value > 0 || row.evidence.eligible > 0;
  // Rows include the `<unknown>` model (value without model evidence); provider rows keep it apart as `unattributed`.
  const rows = [...models.values()].filter(visible);
  for (const row of rows) row.share = total > 0 ? row.value / total : 0;
  rows.sort((left, right) => right.value - left.value || rank(left.provider) - rank(right.provider) || left.model.localeCompare(right.model));
  const providerRows = [...providers.values()].filter((group) => group.total > 0 || group.evidence.eligible > 0).map((group) => ({
    ...group, models: group.models.filter(visible).sort((left, right) => right.value - left.value || left.model.localeCompare(right.model)),
  })).sort((left, right) => right.total - left.total || rank(left.provider) - rank(right.provider));
  return {
    start, end, total, api: api.totals[0], reported: reported.totals[0], upper: api.totals[0] + upperPremium,
    evidence: mergeEvidence(mergeEvidence(blankEvidence(), api.evidence), reported.evidence),
    providers: providerRows, models: rows,
    undated: api.undated[0] + reported.undated[0],
    unledgered: { sessions: api.unledgered.sessions + reported.unledgered.sessions, value: api.unledgered.value + reported.unledgered.value },
    missingSessions: api.missingSessions + reported.missingSessions,
    sessionDated: api.sessionDated[0] + reported.sessionDated[0], sessionDatedSessions: api.sessionDatedSessions + reported.sessionDatedSessions,
    contributingSessions: api.contributingSessions + reported.contributingSessions,
  };
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

/** The calendar day a session started in `timeZone`, or null for unknown, file-mtime or invalid starts. */
export function sessionStartDay(session, timeZone = "UTC") {
  if (session.transcript?.startTimeKnown === false || session.evidence?.timing === "file-mtime") return null;
  return localDay(normalizeTimestamp(session.createdAt), timeZone);
}

/** Sessions started on `startDay` through `endDay` (inclusive) in the snapshot timezone, the dates Velocity uses. */
export function sessionsInRange(sessions, startDay, endDay, timeZone = "UTC") {
  if (!startDay && !endDay) return sessions.slice();
  return sessions.filter((session) => {
    const day = sessionStartDay(session, timeZone);
    return day !== null && (!startDay || day >= startDay) && (!endDay || day <= endDay);
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

export function dailyCountSeries(sessions, days, accessor, timeZone = "UTC") {
  const index = new Map(days.map((day, position) => [day, position]));
  const values = days.map(() => 0);
  for (const session of sessions) {
    const position = index.get(sessionStartDay(session, timeZone));
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

/** Known provider starts by local weekday (Monday first) and hour; file times never count. */
export function activityGrid(sessions, timeZone = "UTC") {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const clock = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", hourCycle: "h23" });
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let counted = 0;
  for (const session of sessions) {
    if (session.transcript?.startTimeKnown === false || session.evidence?.timing === "file-mtime") continue;
    const start = normalizeTimestamp(session.createdAt);
    if (start === null) continue;
    const parts = clock.formatToParts(new Date(start));
    const day = weekdays.indexOf(parts.find(({ type }) => type === "weekday")?.value);
    const hour = Number(parts.find(({ type }) => type === "hour")?.value);
    if (day >= 0 && hour >= 0 && hour < 24) { grid[day][hour]++; counted++; }
  }
  return { grid, counted, maximum: Math.max(0, ...grid.flat()) };
}

/** Only colour levels reached by integer counts appear, with their inclusive count ranges. */
export function heatLegend(maximum) {
  const entries = [{ level: 0, min: 0, max: 0 }];
  for (let value = 1; value <= maximum; value++) {
    const level = heatLevel(value, maximum), last = entries.at(-1);
    if (last.level === level) last.max = value;
    else entries.push({ level, min: value, max: value });
  }
  return entries;
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

// The fleet table's value and priced columns read the activity ledger (`item.usage`), like the Summary KPI.
export const tableAccessors = {
  cache: (item) => item.summary.cacheReadRatio ?? -1,
  coverage: (item) => pricedShare(item.usage?.evidence) ?? -1,
  input: (item) => item.summary.totalInputTokens,
  name: (item) => item.repository.name.toLowerCase(),
  output: (item) => item.summary.outputTokens,
  sessions: (item) => item.summary.sessions,
  tools: (item) => item.summary.toolCalls,
  value: (item) => item.usage?.available === false ? -1 : item.usage?.value ?? 0,
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
