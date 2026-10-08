// @ts-check
/** @typedef {import("../types.ts").SessionAnalytics} SessionAnalytics */
/** @typedef {import("../types.ts").MachineAnalytics} MachineAnalytics */
/** @typedef {import("../types.ts").ModelUsage} ModelUsage */
/** @typedef {{repositoryId?: string | null, start?: string | null, end?: string | null, providers?: string[] | null, repositoryIds?: string[] | null}} SessionFilters */
/** @typedef {{schemaVersion: number, repositoryId: string, repositoryName: string, provider: string}} CsvBase */
// Pure interchange helpers shared by the browser and Node; no transcript access.
import { coverageWarnings, filteredWarning, scanWarnings } from "./evidence.js";
import { timestampMilliseconds } from "./timestamps.js";
/** @type {Array<keyof import("../types.ts").TokenUsage>} */
const tokenFields = ["inputTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteInputTokens", "cacheWrite5mInputTokens", "cacheWrite1hInputTokens", "outputTokens", "reasoningOutputTokens", "nonReasoningOutputTokens"];
/** @type {Array<keyof import("../types.ts").CostBreakdown>} */
const costFields = ["cachedInputUsd", "cacheWriteUsd", "inputUsd", "outputUsd", "totalUsd", "upperEstimateUsd"];
/** @template {string} K @param {K[]} keys @returns {Record<K, number>} */
const zeroFields = (keys) => /** @type {Record<K, number>} */ (Object.fromEntries(keys.map((key) => [key, 0])));

/** @param {object[]} rows @param {string[]} columns */
export function csv(rows, columns) {
  /** @param {unknown} value */
  const cell = (value) => {
    if (value === null || value === undefined) return "";
    let text = String(value);
    // Quoting alone does not prevent spreadsheet formula execution.
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return `${[columns.map(cell).join(","), ...rows.map((row) => columns.map((column) => cell(/** @type {Record<string, unknown>} */ (row)[column])).join(","))].join("\r\n")}\r\n`;
}

/** @param {MachineAnalytics} snapshot @returns {Record<string, string>} */
export function csvTables(snapshot) {
  const sessions = snapshot.sessions.map((s) => ({
    schemaVersion: 1, sessionKey: s.sessionKey, repositoryId: s.repositoryId, repositoryName: s.repositoryName,
    provider: s.provider, createdAt: s.createdAt, updatedAt: s.updatedAt, firstEventAt: s.firstEventAt, lastEventAt: s.lastEventAt,
    costBasis: s.costBasis, costComplete: s.costComplete, pricedTokenCoverage: s.pricedTokenCoverage,
    executionKind: s.executionKind, transcriptStatus: s.transcript.status,
    ...Object.fromEntries(tokenFields.map((key) => [key, s.tokens[key]])),
    ...Object.fromEntries(costFields.map((key) => [key, s.cost[key]])),
    toolCalls: s.metrics.toolCalls, modelCalls: s.metrics.modelCalls, userTurns: s.metrics.userTurns,
    compactions: s.metrics.compactions, durationMilliseconds: s.metrics.durationMilliseconds,
  }));
  /** @type {Map<string, CsvBase & {day: string, contributingSessions: number, apiEquivalentSpendUsd: number, providerReportedSpendUsd: number}>} */
  const days = new Map();
  /** @type {Map<string, CsvBase & ModelUsage & {costBasis: string, contributingSessions: number}>} */
  const models = new Map();
  /** @type {Map<string, CsvBase & {tool: string, contributingSessions: number, calls: number}>} */
  const tools = new Map();
  for (const s of snapshot.sessions) {
    const base = { schemaVersion: 1, repositoryId: s.repositoryId, repositoryName: s.repositoryName, provider: s.provider };
    for (const [day, amount] of Object.entries(s.spendByDay)) {
      const key = JSON.stringify([s.repositoryId, s.provider, day]);
      const row = days.get(key) || { ...base, day, contributingSessions: 0, apiEquivalentSpendUsd: 0, providerReportedSpendUsd: 0 };
      row.contributingSessions++;
      if (s.costBasis === "api-list-price-equivalent") row.apiEquivalentSpendUsd += amount;
      if (s.costBasis === "provider-reported") row.providerReportedSpendUsd += amount;
      days.set(key, row);
    }
    for (const m of s.models) {
      const key = JSON.stringify([s.repositoryId, s.provider, s.costBasis, m.model]);
      const row = models.get(key) || { ...base, costBasis: s.costBasis, model: m.model, contributingSessions: 0, calls: 0, priced: true, ...zeroFields([...tokenFields, ...costFields]) };
      row.contributingSessions++; row.calls += m.calls; row.priced = row.priced && m.priced;
      for (const key of [...tokenFields, ...costFields]) row[key] += m[key];
      models.set(key, row);
    }
    for (const [tool, calls] of Object.entries(s.tools)) {
      const key = JSON.stringify([s.repositoryId, s.provider, tool]);
      const row = tools.get(key) || { ...base, tool, contributingSessions: 0, calls: 0 };
      row.contributingSessions++; row.calls += calls; tools.set(key, row);
    }
  }
  /** @template T @param {Map<string, T>} map @returns {T[]} */
  const sorted = (map) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
  const base = ["schemaVersion", "repositoryId", "repositoryName", "provider"];
  return {
    "sessions.csv": csv(sessions, ["schemaVersion", "sessionKey", "repositoryId", "repositoryName", "provider", "createdAt", "updatedAt", "firstEventAt", "lastEventAt", "costBasis", "costComplete", "pricedTokenCoverage", "executionKind", "transcriptStatus", ...tokenFields, ...costFields, "toolCalls", "modelCalls", "userTurns", "compactions", "durationMilliseconds"]),
    "daily.csv": csv(sorted(days), [...base, "day", "contributingSessions", "apiEquivalentSpendUsd", "providerReportedSpendUsd"]),
    "models.csv": csv(sorted(models), [...base, "costBasis", "model", "contributingSessions", "calls", "priced", ...tokenFields, ...costFields]),
    "tools.csv": csv(sorted(tools), [...base, "tool", "contributingSessions", "calls"]),
  };
}

/** @param {SessionAnalytics[]} sessions @returns {Omit<import("../types.ts").RepositoryRollup, "repository">} */
export function aggregateSessions(sessions) {
  /** @type {import("../types.ts").RepositoryAnalytics["summary"]} */
  const summary = {
    analyzedSessions: 0, apiEquivalentSpendUsd: 0, cacheReadRatio: null, compactions: 0,
    estimatedSpendUsd: 0, estimatedUpperSpendUsd: 0, missingTranscripts: 0, outputTokens: 0,
    pricedTokenCoverage: null, providerReportedSpendUsd: 0, sessions: sessions.length, subagentSessions: 0,
    subagentSpendUsd: 0, topLevelSessions: 0, topLevelSpendUsd: 0, toolCalls: 0, totalInputTokens: 0, unpricedSessions: 0,
  };
  let priced = 0, priceable = 0, cached = 0, cacheDenominator = 0;
  /** @type {Map<string, ModelUsage>} */
  const models = new Map();
  /** @type {Map<string, number>} */
  const days = new Map();
  /** @type {Map<string, number>} */
  const tools = new Map();
  for (const s of sessions) {
    summary.analyzedSessions += s.transcript.status === "ok" ? 1 : 0;
    summary.missingTranscripts += s.transcript.status === "missing" ? 1 : 0;
    summary.apiEquivalentSpendUsd += s.costBasis === "api-list-price-equivalent" ? s.cost.totalUsd : 0;
    summary.providerReportedSpendUsd += s.costBasis === "provider-reported" ? s.cost.totalUsd : 0;
    summary.estimatedSpendUsd += s.cost.totalUsd; summary.estimatedUpperSpendUsd += s.cost.upperEstimateUsd;
    summary.compactions += s.metrics.compactions; summary.toolCalls += s.metrics.toolCalls;
    summary.outputTokens += s.tokens.outputTokens; summary.totalInputTokens += s.tokens.inputTokens;
    summary.unpricedSessions += s.pricedTokenCoverage !== null && s.pricedTokenCoverage < 1 && s.tokens.inputTokens + s.tokens.outputTokens > 0 ? 1 : 0;
    summary.subagentSessions += ["mixed", "subagent"].includes(s.executionKind) ? 1 : 0;
    summary.topLevelSessions += ["mixed", "top-level"].includes(s.executionKind) ? 1 : 0;
    summary.subagentSpendUsd += s.costByExecution.subagentUsd; summary.topLevelSpendUsd += s.costByExecution.topLevelUsd;
    cached += s.tokens.cachedInputTokens;
    cacheDenominator += s.tokens.uncachedInputTokens + s.tokens.cachedInputTokens + s.tokens.cacheWriteInputTokens;
    if (s.pricedTokenCoverage !== null) { const count = s.tokens.inputTokens + s.tokens.outputTokens; priceable += count; priced += count * s.pricedTokenCoverage; }
    for (const [name, amount] of Object.entries(s.spendByDay)) days.set(name, (days.get(name) || 0) + amount);
    for (const [name, amount] of Object.entries(s.tools)) tools.set(name, (tools.get(name) || 0) + amount);
    for (const source of s.models) {
      const row = models.get(source.model) || { model: source.model, calls: 0, priced: true, ...zeroFields([...tokenFields, ...costFields]) };
      for (const key of [...tokenFields, ...costFields]) row[key] += source[key];
      row.calls += source.calls;
      row.priced = row.priced && source.priced;
      if (source.pricing) {
        row.pricing ??= [];
        for (const provenance of source.pricing) if (!row.pricing.some((p) => JSON.stringify(p) === JSON.stringify(provenance))) row.pricing.push(provenance);
      }
      if (source.pricingCoverage) {
        row.pricingCoverage ??= { pricedTokens: 0, eligibleTokens: 0 };
        row.pricingCoverage.pricedTokens += source.pricingCoverage.pricedTokens;
        row.pricingCoverage.eligibleTokens += source.pricingCoverage.eligibleTokens;
      }
      models.set(source.model, row);
    }
  }
  summary.cacheReadRatio = cacheDenominator ? cached / cacheDenominator : null;
  summary.pricedTokenCoverage = priceable ? priced / priceable : null;
  /** @param {Map<string, number>} map */
  const named = (map) => [...map].map(([name, value]) => ({ name, value }));
  return { summary, spendByDay: named(days).sort((a, b) => a.name.localeCompare(b.name)), spendByModel: [...models.values()].sort((a, b) => b.totalUsd - a.totalUsd), topTools: named(tools).sort((a, b) => b.value - a.value), warnings: coverageWarnings(sessions) };
}

/** Whole sessions selected by numeric start instant; end is EXCLUSIVE.
 * @param {SessionAnalytics[]} sessions @param {SessionFilters} filters */
export function selectSessions(sessions, { repositoryId = null, start = null, end = null, providers = null, repositoryIds = null } = {}) {
  const first = start === null ? -Infinity : timestampMilliseconds(start);
  const last = end === null ? Infinity : timestampMilliseconds(end);
  if (Number.isNaN(first) || Number.isNaN(last)) throw new Error("Invalid selection timestamp.");
  return sessions.filter((s) => {
    const time = timestampMilliseconds(s.createdAt);
    return (!(start || end) || s.transcript?.startTimeKnown !== false && s.evidence?.timing !== "file-mtime") && (!repositoryId || s.repositoryId === repositoryId) && time >= first && time < last && (!providers || providers.includes(s.provider)) && (!repositoryIds || repositoryIds.includes(s.repositoryId));
  });
}

/** @param {MachineAnalytics} snapshot @param {SessionFilters} filters @returns {MachineAnalytics} */
export function filterSnapshot(snapshot, filters = {}) {
  const { repositoryId = null, repositoryIds = null } = filters;
  const sessions = selectSessions(snapshot.sessions, filters);
  /** @type {Map<string, SessionAnalytics[]>} */
  const byRepository = new Map();
  for (const s of sessions) {
    const rows = byRepository.get(s.repositoryId) || [];
    rows.push(s); byRepository.set(s.repositoryId, rows);
  }
  const repositories = snapshot.repositories.filter((r) => (!repositoryId || r.repository.id === repositoryId) && (!repositoryIds || repositoryIds.includes(r.repository.id))).map((r) => {
    const rollup = aggregateSessions(byRepository.get(r.repository.id) || []);
    return { repository: { id: r.repository.id, name: r.repository.name }, ...rollup, warnings: [...new Set([...scanWarnings(r.warnings || []), ...rollup.warnings])] };
  });
  const combined = aggregateSessions(sessions);
  const discovery = scanWarnings([...snapshot.warnings, ...snapshot.repositories.flatMap((r) => r.warnings)]);
  const extras = {
    ...(snapshot.historyCoverage && !Object.values(filters).some((value) => value !== null && value !== undefined) ? { historyCoverage: snapshot.historyCoverage } : {}),
    ...(snapshot.mcpSourceHealth ? { mcpSourceHealth: snapshot.mcpSourceHealth } : {}),
    ...(snapshot.mcpContext ? { mcpContext: snapshot.mcpContext } : {}),
    ...(snapshot.velocity ? { velocity: snapshot.velocity } : {}),
  };
  return { ...extras, schemaVersion: 1, generatedAt: snapshot.generatedAt, rateCard: snapshot.rateCard, repositories, sessions, ...combined, summary: { ...combined.summary, repositories: repositories.length, repositoriesWithSessions: repositories.filter((r) => r.summary.sessions > 0).length, workingSnapshots: sessions.filter((s) => s.transcript.snapshotWhileWorking && !s.transcript.sourceDeleted && !s.transcript.warnings.includes("Source availability could not be checked; showing the last indexed facts.")).length }, warnings: [...new Set([...discovery, ...combined.warnings, filteredWarning])] };
}
