import type { ModelUsage, SessionAnalytics, SessionProvider } from "../types.ts";
import type {
  McpActivityState, McpArguments, McpBudget, McpBudgetPeriod, McpDistribution, McpNamedCount, McpPayload,
  McpProfile, McpRatio, McpSnapshot, McpToolName, McpToolStat, McpTotals, McpValue, McpWindow,
} from "./types.ts";
import { integratedMetrics } from "./integrated.ts";
import { validModelId } from "../public/model-id.js";
import { metricEligible } from "../public/providers.js";
import { mcpServerName, safeName, timestamp } from "./names.ts";

const DAY = 86_400_000;
const PROVIDERS: SessionProvider[] = ["claude", "codex", "cursor", "copilot", "opencode", "gemini", "unsupported"];
const MIN_SESSIONS = 5;
const MAX_MIX = 20;
const validRepository = (id: string): boolean => /^(conductor|discovered)-[a-f0-9]{20}$/.test(id);
const number = (value: number): number => Number.isFinite(value) && value >= 0 ? value : 0;
const sum = <T>(values: T[], get: (item: T) => number): number => values.reduce((total, value) => total + number(get(value)), 0);

export class ScopeError extends Error {
  constructor() { super("Repository scope unavailable. Launch in a repository or select a repositoryId returned by usage_summary with machine scope."); }
}

export function ratio(numerator: number, denominator: number, minimum = 1): McpRatio {
  return {
    value: denominator >= minimum ? numerator / denominator : null,
    numerator, denominator, minimumDenominator: minimum,
    status: denominator === 0 ? "unavailable" : denominator < minimum ? "insufficient-data" : "available",
  };
}

export function windowStart(window: McpWindow, now: number): number | null {
  const today = Math.floor(now / DAY) * DAY;
  if (window === "all") return null;
  if (window === "today") return today;
  if (window === "week") return today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
  return today - (Number.parseInt(window, 10) - 1) * DAY;
}

function start(session: SessionAnalytics): string | null { if (session.transcript.startTimeKnown === false || session.evidence?.timing === "file-mtime") return null; return timestamp(session.createdAt) ?? timestamp(session.firstEventAt); }

function value(sessions: SessionAnalytics[], modelKey?: string): McpValue {
  let api = 0, upper = 0, reported = 0, priced = 0, eligible = 0;
  for (const session of sessions) {
    const models = modelKey === undefined ? session.models : selectedModels(session, modelKey);
    if (session.costBasis === "api-list-price-equivalent") {
      api += modelKey === undefined ? number(session.cost.totalUsd) : sum(models, (m) => m.totalUsd);
      upper += modelKey === undefined ? number(session.cost.upperEstimateUsd) : sum(models, (m) => m.upperEstimateUsd);
      for (const model of models) {
        const tokens = number(model.inputTokens) + number(model.outputTokens);
        eligible += tokens;
        priced += model.pricingCoverage?.pricedTokens ?? (model.priced ? tokens : 0);
      }
    } else if (session.costBasis === "provider-reported") {
      reported += modelKey === undefined ? number(session.cost.totalUsd) : sum(models, (m) => m.totalUsd);
    }
  }
  return { apiEquivalentUsd: api, apiUpperEstimateUsd: upper, providerReportedUsd: reported, pricingCoverage: ratio(priced, eligible), unpricedTokens: eligible - priced };
}

function modelGroup(session: SessionAnalytics, model: ModelUsage): string { return `${session.provider}:${validModelId(model.model) ? model.model : "unknown"}`; }
function selectedModels(session: SessionAnalytics, key: string): ModelUsage[] { return session.models.filter((model) => modelGroup(session, model) === key); }

export function totals(sessions: SessionAnalytics[], modelKey?: string): McpTotals {
  const model = modelKey !== undefined;
  const hasModelTokens = !model || sessions.every((s) => s.provider !== "cursor" || s.evidence?.source === "cursor-sdk");
  const tokenSessions = sessions.filter((s) => metricEligible(s, "tokens"));
  const turnSessions = sessions.filter((s) => metricEligible(s, "turns"));
  const toolSessions = sessions.filter((s) => metricEligible(s, "tools"));
  return {
    coverage: { tokenSessions: tokenSessions.length, turnSessions: model ? 0 : turnSessions.length, toolSessions: model ? 0 : toolSessions.length, selectedSessions: sessions.length },
    basis: "session-start",
    sessions: sessions.length,
    analyzedSessions: sessions.filter((s) => s.transcript.status === "ok").length,
    workingSnapshots: sessions.filter((s) => s.transcript.snapshotWhileWorking).length,
    inputTokens: !hasModelTokens || !tokenSessions.length ? null : sum(tokenSessions, (s) => model ? sum(selectedModels(s, modelKey), (m) => m.inputTokens) : s.tokens.inputTokens),
    outputTokens: !hasModelTokens || !tokenSessions.length ? null : sum(tokenSessions, (s) => model ? sum(selectedModels(s, modelKey), (m) => m.outputTokens) : s.tokens.outputTokens),
    userTurns: model || !turnSessions.length ? null : sum(turnSessions, (s) => s.metrics.userTurns),
    toolCalls: model || !toolSessions.length ? null : sum(toolSessions, (s) => s.metrics.toolCalls),
    value: value(sessions, modelKey),
  };
}

function distribution(values: number[], selectedSessions: number): McpDistribution {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length < MIN_SESSIONS ? null : sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p90: sorted.length < MIN_SESSIONS ? null : sorted[Math.ceil(sorted.length * 0.9) - 1]!,
    samples: sorted.length, selectedSessions, excludedSessions: selectedSessions - sorted.length, minimumSamples: MIN_SESSIONS,
  };
}

function counts(sessions: SessionAnalytics[], kind: "tools" | "skills"): McpNamedCount[] {
  const map = new Map<string, number>();
  for (const session of sessions) for (const [raw, calls] of Object.entries(session[kind])) {
    const name = safeName(raw);
    if (name && Number.isFinite(calls) && calls > 0) map.set(name, (map.get(name) ?? 0) + calls);
  }
  return [...map].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

function duration(session: SessionAnalytics): number | null {
  return timestamp(session.firstEventAt) && timestamp(session.lastEventAt) && session.metrics.durationMilliseconds > 0
    ? number(session.metrics.durationMilliseconds) : null;
}

export function profile(sessions: SessionAnalytics[]): McpProfile {
  const activity = (s: SessionAnalytics): McpActivityState => s.transcript.snapshotWhileWorking ? "active"
    : s.transcript.status === "ok" ? s.mcpEvidence?.activityState ?? "unknown" : "unknown";
  const stable = sessions.filter((s) => activity(s) === "settled");
  const api = stable.filter((s) => s.costBasis === "api-list-price-equivalent" && s.costComplete && s.models.some((m) => m.inputTokens + m.outputTokens > 0));
  const reported = stable.filter((s) => s.costBasis === "provider-reported");
  const cache = sessions.filter((s) => metricEligible(s, "tokens") && !s.evidence && (s.provider === "claude" || s.provider === "codex"));
  const compactions = sessions.filter((s) => metricEligible(s, "compactions"));
  const tools = counts(sessions, "tools"), skills = counts(sessions, "skills");
  return {
    sessions: sessions.length,
    activityStates: { active: sessions.filter((s) => activity(s) === "active").length,
      settled: stable.length, unknown: sessions.filter((s) => activity(s) === "unknown").length },
    apiEquivalentUsd: distribution(api.map((s) => s.cost.totalUsd), sessions.length),
    providerReportedUsd: distribution(reported.map((s) => s.cost.totalUsd), sessions.length),
    userTurns: distribution(stable.filter((s) => metricEligible(s, "turns") && s.metrics.userTurns > 0).map((s) => s.metrics.userTurns), sessions.length),
    durationMilliseconds: distribution(stable.map(duration).filter((v): v is number => v !== null), sessions.length),
    cacheHitRate: ratio(sum(cache, (s) => s.tokens.cachedInputTokens), sum(cache, (s) => s.tokens.inputTokens), 1000),
    compactionsPerSession: ratio(sum(compactions, (s) => s.metrics.compactions), compactions.length, MIN_SESSIONS),
    toolMix: tools.slice(0, MAX_MIX), skills: skills.slice(0, MAX_MIX),
    omittedTools: Math.max(0, tools.length - MAX_MIX), omittedSkills: Math.max(0, skills.length - MAX_MIX),
    skillEvidence: PROVIDERS.map((provider) => ({ provider, evidence: provider === "claude" ? "explicit" : provider === "codex" ? "inferred" : "unavailable", sessions: sessions.filter((s) => s.provider === provider).length })),
  };
}

function toolStats(sessions: SessionAnalytics[]): McpToolStat[] {
  const map = new Map(counts(sessions, "tools").map(({ name, calls }) => [name, { name, calls, observedResults: 0, errors: 0 }]));
  for (const session of sessions) for (const item of session.mcpEvidence?.toolOutcomes ?? []) {
    const name = safeName(item.tool);
    if (!name) continue;
    const row = map.get(name) ?? { name, calls: 0, observedResults: 0, errors: 0 };
    row.observedResults += number(item.observedResults); row.errors += number(item.errors); map.set(name, row);
  }
  return [...map.values()].map((row) => ({
    ...row,
    errorRate: ratio(row.errors, row.observedResults, 20),
    resultCoverage: row.observedResults > row.calls
      ? { ...ratio(row.observedResults, row.calls), value: null, status: "unavailable" as const }
      : ratio(row.observedResults, row.calls),
  })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

function budgetPeriod(sessions: SessionAnalytics[], since: number, now: number): McpBudgetPeriod {
  const firstDay = new Date(since).toISOString().slice(0, 10), lastDay = new Date(now).toISOString().slice(0, 10);
  let api = 0, datedSessions = 0, undatedSessions = 0, priced = 0, eligible = 0, undated = 0, complete = true;
  for (const session of sessions) {
    const entries = Object.entries(session.spendByDay).filter(([day, usd]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= firstDay && day <= lastDay && usd >= 0);
    const ledger = session.costBasis === "api-list-price-equivalent" ? session.mcpEvidence?.pricingByDay : undefined;
    const days = ledger?.filter((item) => item.day >= firstDay && item.day <= lastDay) ?? [];
    if (session.costBasis === "api-list-price-equivalent") {
      api += sum(entries, ([, usd]) => usd);
      if (entries.length || days.length) datedSessions += 1;
      if (!ledger || session.mcpEvidence?.undatedTokens === undefined) complete = false;
      eligible += sum(days, (item) => item.eligibleTokens); priced += sum(days, (item) => item.pricedTokens);
      undated += number(session.mcpEvidence?.undatedTokens ?? 0);
    }
    if (!Object.keys(session.spendByDay).length && !ledger?.length) undatedSessions += 1;
  }
  const elapsedHours = (now - since) / 3_600_000;
  return {
    since: new Date(since).toISOString(), until: new Date(now).toISOString(), apiEquivalentUsd: api,
    pricingCoverage: complete ? ratio(priced, eligible) : { ...ratio(priced, eligible), value: null, status: "unavailable" },
    unpricedTokens: complete ? eligible - priced : null, undatedTokens: complete ? undated : null,
    datedSessions, undatedSessions,
    excludedProviderReportedUsd: sum(sessions.filter((s) => s.costBasis === "provider-reported"), (s) => s.cost.totalUsd),
    elapsedHours, apiEquivalentUsdPerHour: elapsedHours >= 1 && datedSessions >= 3 ? api / elapsedHours : null,
  };
}

function budget(sessions: SessionAnalytics[], now: number): McpBudget {
  return {
    today: budgetPeriod(sessions, windowStart("today", now)!, now),
    week: budgetPeriod(sessions, windowStart("week", now)!, now),
    rateLimits: PROVIDERS.map((provider) => {
      const windows = new Map<number, { windowMinutes: number; usedPercent: number; remainingPercent: number; observedAt: string; resetsAt: string }>();
      for (const session of sessions.filter((s) => s.provider === provider)) for (const sample of session.mcpEvidence?.rateLimits ?? []) {
        const observedAt = timestamp(sample.observedAt), resetsAt = timestamp(sample.resetsAt);
        if (!observedAt || !resetsAt || now < Date.parse(observedAt) || now - Date.parse(observedAt) > 15 * 60_000 || Date.parse(resetsAt) <= now) continue;
        const previous = windows.get(sample.windowMinutes);
        if (!previous || sample.usedPercent > previous.usedPercent || (sample.usedPercent === previous.usedPercent && observedAt > previous.observedAt)) {
          windows.set(sample.windowMinutes, { windowMinutes: sample.windowMinutes, usedPercent: sample.usedPercent, remainingPercent: 100 - sample.usedPercent, observedAt, resetsAt });
        }
      }
      return { provider, status: windows.size ? "available" : "unavailable", windows: [...windows.values()].sort((a, b) => a.windowMinutes - b.windowMinutes) };
    }),
  };
}

export function buildPayload(
  snapshot: McpSnapshot, tool: McpToolName, args: McpArguments, now: number, ttlSeconds: number,
): McpPayload {
  const defaultId = snapshot.analytics.mcpContext?.repositoryId ?? null;
  const id = args.repositoryId ?? (args.scope === "machine" ? null : defaultId);
  if (id && (!validRepository(id) || (id !== defaultId && !snapshot.analytics.repositories.some((r) => r.repository.id === id)))) throw new ScopeError();
  if ((args.scope === "repository" || tool === "repo_profile" || tool === "compare_agents") && !id) throw new ScopeError();
  const scoped = snapshot.analytics.sessions.filter((s) => PROVIDERS.includes(s.provider) && validRepository(s.repositoryId) && (!id || s.repositoryId === id) && (!args.provider || s.provider === args.provider));
  const window = tool === "budget_status" ? "week" : args.window ?? "30d";
  const since = windowStart(window, now);
  const sessions = scoped.filter((s) => {
    const time = start(s);
    return since === null ? !time || Date.parse(time) <= now : time !== null && Date.parse(time) >= since && Date.parse(time) <= now;
  });
  const limit = args.limit ?? 10, offset = args.offset ?? 0;
  const notes = ["API-equivalent value is not an invoice. Activity counters do not prove success, quality, or value delivered."];
  const sourceHealth = PROVIDERS.filter((provider) => !args.provider || provider === args.provider).map((provider) => {
    const source = snapshot.analytics.mcpSourceHealth?.find((item) => item.provider === provider);
    return { provider, status: source?.status ?? "unknown" as const, sourcesRead: number(source?.sourcesRead ?? 0),
      missingSources: number(source?.missingSources ?? 0), unreadableSources: number(source?.unreadableSources ?? 0) };
  });
  if (sourceHealth.some((source) => source.status !== "available") || snapshot.analytics.warnings.length || snapshot.analytics.repositories.some((repo) => repo.warnings.length)) {
    notes.push("Some evidence sources are incomplete or have coverage notes; empty results do not establish no usage. Source health describes discovery independently of the selected sessions.");
  }
  if (sessions.some((s) => s.mcpEvidence?.truncated)) notes.push("Structured outcome evidence was capped; coverage is incomplete.");
  if (sessions.some((s) => s.transcript.warnings.length)) notes.push("Some sessions have parser coverage notes; observed history may be incomplete.");
  let data: McpPayload["data"];
  if (tool === "usage_summary") {
    const groupBy = args.groupBy ?? "provider";
    const groups = new Map<string, SessionAnalytics[]>();
    for (const session of sessions) {
      const keys = groupBy === "repository" ? [session.repositoryId] : groupBy === "provider" ? [session.provider] : groupBy === "agent"
        ? [session.executionKind] : [...new Set(session.models.map((model) => modelGroup(session, model)))];
      for (const key of keys) { const group = groups.get(key) ?? []; group.push(session); groups.set(key, group); }
    }
    const rows = [...groups].map(([key, group]) => ({ key, totals: totals(group, groupBy === "model" ? key : undefined) }))
      .sort((a, b) => (b.totals.value.apiEquivalentUsd + b.totals.value.providerReportedUsd) - (a.totals.value.apiEquivalentUsd + a.totals.value.providerReportedUsd) || a.key.localeCompare(b.key));
    data = { groupBy, groups: rows.slice(offset, offset + limit), totalGroups: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null };
    if (groupBy === "model") notes.push("Model session counts overlap. Turns and tools are unattributed; Cursor model tokens are unavailable. Sessions without models appear only in totals.");
    if (groupBy === "agent") notes.push("Agent means execution kind: top-level, subagent, mixed, or unknown; mixed Claude sessions include their subagents.");
  } else if (tool === "budget_status") {
    data = budget(scoped, now);
    notes.push("Budget periods use dated API value across all scoped sessions, including sessions started earlier. Undated provider-reported value is excluded; no budget or invoice is inferred.",
      "Each period's pricing coverage qualifies both its value and burn rate; common totals instead describe the session-start cohort. Undated tokens are excluded and cannot be assigned to a period.",
      "Burn rate uses elapsed UTC wall hours, requires at least one hour and three dated sessions, and is not a forecast.",
      "Headroom is a recorded provider-account observation, not a live or repository-specific quota. The most conservative sample within 15 minutes is used across profiles; expired and stale windows are unavailable.");
  } else if (tool === "repo_profile" || tool === "compare_agents") {
    data = tool === "repo_profile" ? profile(sessions) : { agents: PROVIDERS.map((provider) => {
      const selected = sessions.filter((s) => s.provider === provider);
      return { provider, totals: totals(selected), profile: profile(selected) };
    }) };
    notes.push("Typical values require five eligible sessions with settled provider lifecycle evidence. Active and unknown sessions, incomplete prices and missing durations are excluded. Settled describes the recorded turn, not success or a guarantee it cannot resume; duration includes idle time and task mix is uncontrolled.",
      "Cache ratios exclude Cursor and require 1,000 input tokens; compaction rates exclude Cursor and require five sessions. No ranking or causal comparison is implied.");
  } else if (tool === "tool_stats") {
    const rows = toolStats(sessions);
    data = { tools: rows.slice(offset, offset + limit), totalTools: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null };
    notes.push("Error rates require 20 structured results. Missing flags are not successes. Result coverage is unavailable when structured completions cannot reconcile with call counters; code-mode outer results do not describe inner tools.");
  } else if (tool === "recent_sessions") {
    const rows = [...sessions].filter((s) => /^[a-f0-9]{12}$/.test(s.sessionKey)).sort((a, b) =>
      (Date.parse(timestamp(b.lastEventAt) ?? start(b) ?? "") || 0) - (Date.parse(timestamp(a.lastEventAt) ?? start(a) ?? "") || 0) || a.sessionKey.localeCompare(b.sessionKey));
    data = {
      sessions: rows.slice(offset, offset + limit).map((session) => {
        const models = [...new Set(session.models.map((m) => validModelId(m.model) ? m.model : null).filter((v): v is string => v !== null))];
        return { sessionKey: session.sessionKey, repositoryId: session.repositoryId, provider: session.provider, executionKind: session.executionKind,
          startedAt: start(session), lastEventAt: timestamp(session.lastEventAt), durationMilliseconds: duration(session),
          models: models.slice(0, 10), omittedModels: Math.max(0, models.length - 10), workingSnapshot: session.transcript.snapshotWhileWorking, value: value([session]) };
      }), totalSessions: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null,
    };
    notes.push("Duration is session wall span, including idle time; compare within the same repository and task kind.");
  } else {
    data = { inventoryScope: "launch-context", providers: snapshot.inventory.filter((entry) => !args.provider || entry.provider === args.provider).map((entry) => {
      const selected = sessions.filter((s) => s.provider === entry.provider);
      const invoked = new Set(counts(selected, "skills").map((item) => item.name));
      const used = new Set([...counts(selected, "tools").map((item) => item.name), ...selected.flatMap((s) => (s.mcpEvidence?.toolOutcomes ?? []).map((item) => item.tool))].map((tool) => mcpServerName(tool, entry.mcpServers)).filter((v): v is string => v !== null));
      const observed = new Set(entry.skillIdentities?.filter((item) => item.aliases.some((alias) => invoked.has(alias))).map((item) => item.name));
      const skills = entry.skills.filter((name) => safeName(name) && !invoked.has(name) && !observed.has(name));
      const servers = entry.mcpServers.filter((name) => safeName(name) && !used.has(name));
      return { provider: entry.provider, inventoryCoverage: "partial", sourcesRead: entry.sourcesRead, unreadableSources: entry.unreadableSources, truncated: entry.truncated,
        skillEvidence: entry.provider === "claude" ? "explicit" : entry.provider === "codex" ? "inferred" : "unavailable",
        skillIdentityCoverage: !entry.skillIdentities || (!entry.skillIdentities.length && entry.unresolvedSkills) ? "unavailable"
          : entry.unresolvedSkills || entry.truncated ? "partial" : "available",
        unresolvedSkills: entry.unresolvedSkills ?? entry.skills.length,
        installedSkills: entry.skills.length, configuredMcpServers: entry.mcpServers.length,
        skillsWithoutObservedUse: entry.provider === "cursor" || !entry.skillIdentities ? [] : skills.slice(0, limit), serversWithoutObservedUse: servers.slice(0, limit),
        omittedSkills: entry.provider === "cursor" || !entry.skillIdentities ? 0 : Math.max(0, skills.length - limit), omittedServers: Math.max(0, servers.length - limit) };
    }) };
    notes.push("Inventory covers conventional local configuration in the launch context, not every plugin or managed source. Names without observed use are not proof of disuse; do not remove extensions automatically.",
      "Claude skill evidence is explicit, Codex is an inferred lower bound, and Cursor skill usage is unavailable. A selected repository changes usage scope, not the installed inventory.");
  }
  return {
    metrics: integratedMetrics(snapshot.analytics, sessions, now),
    schemaVersion: 1, tool,
    snapshot: { generatedAt: timestamp(snapshot.analytics.generatedAt) ?? new Date(now).toISOString(), ageSeconds: Math.max(0, Math.floor((now - Date.parse(snapshot.analytics.generatedAt)) / 1000)) || 0, ttlSeconds },
    scope: { kind: id ? "repository" : "machine", repositoryId: id },
    sourceHealth,
    window: { name: window, since: since === null ? null : new Date(since).toISOString(), until: new Date(now).toISOString(), timezone: "UTC", basis: tool === "budget_status" ? "activity-day" : "session-start" },
    totals: totals(sessions), notes, data,
  };
}

export function summarize(payload: McpPayload): string {
  const scope = payload.scope.kind === "repository" ? "Repository" : "Machine";
  const total = payload.totals;
  if (payload.tool === "budget_status" && "today" in payload.data) {
    return `${scope}: $${payload.data.today.apiEquivalentUsd.toFixed(2)} today; $${payload.data.week.apiEquivalentUsd.toFixed(2)} this UTC week, API-equivalent (not an invoice). Headroom is recorded evidence only.`;
  }
  return `${scope}, ${payload.window.name}: ${total.sessions} sessions; $${total.value.apiEquivalentUsd.toFixed(2)} API-equivalent (not an invoice), $${total.value.providerReportedUsd.toFixed(2)} provider-reported. Check coverage and sample guards in the JSON.`;
}
