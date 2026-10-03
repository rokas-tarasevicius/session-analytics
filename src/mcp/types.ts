import type { ExecutionKind, MachineAnalytics, SessionProvider, SkillEvidence } from "../types.ts";

export interface McpToolOutcome {
  tool: string;
  observedResults: number;
  errors: number;
}

export interface McpRateWindow {
  windowMinutes: number;
  usedPercent: number;
  observedAt: string;
  resetsAt: string;
}

export type McpActivityState = "active" | "settled" | "unknown";
export interface McpPricingDay { day: string; eligibleTokens: number; pricedTokens: number }
export interface McpSourceHealth {
  provider: SessionProvider;
  status: "available" | "incomplete" | "unavailable" | "unknown";
  sourcesRead: number;
  missingSources: number;
  unreadableSources: number;
}

/** Only structured result flags and numeric quota windows; never result text. */
export interface McpSessionEvidence {
  activityState?: McpActivityState;
  pricingByDay?: McpPricingDay[];
  undatedTokens?: number;
  toolOutcomes: McpToolOutcome[];
  rateLimits: McpRateWindow[];
  truncated: boolean;
}

export interface McpContext {
  repositoryId: string | null;
}

export interface McpInventoryProvider {
  provider: SessionProvider;
  skills: string[];
  skillIdentities?: Array<{ name: string; aliases: string[] }>;
  unresolvedSkills?: number;
  mcpServers: string[];
  sourcesRead: number;
  unreadableSources: number;
  truncated: boolean;
}

export interface McpSnapshot {
  analytics: MachineAnalytics;
  inventory: McpInventoryProvider[];
}

export type McpWindow = "today" | "week" | "7d" | "30d" | "90d" | "all";
export type McpGroup = "repository" | "provider" | "model" | "agent";
export type McpToolName = "usage_summary" | "budget_status" | "repo_profile" | "tool_stats" |
  "recent_sessions" | "unused_extensions" | "compare_agents";

export interface McpArguments {
  scope?: "repository" | "machine";
  repositoryId?: string;
  window?: McpWindow;
  groupBy?: McpGroup;
  provider?: SessionProvider;
  limit?: number;
  offset?: number;
}

export interface McpRatio {
  value: number | null;
  numerator: number;
  denominator: number;
  minimumDenominator: number;
  status: "available" | "insufficient-data" | "unavailable";
}

export interface McpValue {
  apiEquivalentUsd: number;
  apiUpperEstimateUsd: number;
  providerReportedUsd: number;
  pricingCoverage: McpRatio;
  unpricedTokens: number;
}

export interface McpTotals {
  coverage?: { tokenSessions: number; turnSessions: number; toolSessions: number; selectedSessions: number };
  basis: "session-start";
  sessions: number;
  analyzedSessions: number;
  workingSnapshots: number;
  inputTokens: number | null;
  outputTokens: number | null;
  userTurns: number | null;
  toolCalls: number | null;
  value: McpValue;
}

export interface McpDistribution {
  median: number | null;
  p90: number | null;
  samples: number;
  selectedSessions: number;
  excludedSessions: number;
  minimumSamples: number;
}

export interface McpNamedCount { name: string; calls: number }

export interface McpProfile {
  sessions: number;
  activityStates: Record<McpActivityState, number>;
  apiEquivalentUsd: McpDistribution;
  providerReportedUsd: McpDistribution;
  userTurns: McpDistribution;
  durationMilliseconds: McpDistribution;
  cacheHitRate: McpRatio;
  compactionsPerSession: McpRatio;
  toolMix: McpNamedCount[];
  skills: McpNamedCount[];
  omittedTools: number;
  omittedSkills: number;
  skillEvidence: Array<{ provider: SessionProvider; evidence: SkillEvidence; sessions: number }>;
}

export interface McpToolStat {
  name: string;
  calls: number;
  observedResults: number;
  errors: number;
  errorRate: McpRatio;
  resultCoverage: McpRatio;
}

export interface McpRecentSession {
  sessionKey: string;
  repositoryId: string;
  provider: SessionProvider;
  executionKind: ExecutionKind;
  startedAt: string | null;
  lastEventAt: string | null;
  durationMilliseconds: number | null;
  models: string[];
  omittedModels: number;
  workingSnapshot: boolean;
  value: McpValue;
}

export interface McpBudgetPeriod {
  since: string;
  until: string;
  apiEquivalentUsd: number;
  pricingCoverage: McpRatio;
  unpricedTokens: number | null;
  undatedTokens: number | null;
  datedSessions: number;
  undatedSessions: number;
  excludedProviderReportedUsd: number;
  elapsedHours: number;
  apiEquivalentUsdPerHour: number | null;
}

export interface McpBudget {
  today: McpBudgetPeriod;
  week: McpBudgetPeriod;
  rateLimits: Array<{
    provider: SessionProvider;
    status: "available" | "unavailable";
    windows: Array<McpRateWindow & { remainingPercent: number }>;
  }>;
}

export interface McpUnusedProvider {
  provider: SessionProvider;
  inventoryCoverage: "partial";
  sourcesRead: number;
  unreadableSources: number;
  truncated: boolean;
  skillEvidence: SkillEvidence;
  skillIdentityCoverage: "available" | "partial" | "unavailable";
  unresolvedSkills: number;
  installedSkills: number;
  configuredMcpServers: number;
  skillsWithoutObservedUse: string[];
  serversWithoutObservedUse: string[];
  omittedSkills: number;
  omittedServers: number;
}

/** All tool payloads have the same provenance envelope; each data variant is allowlisted. */
export interface McpPayload {
  metrics?: ReturnType<typeof import("./integrated.ts").integratedMetrics>;
  schemaVersion: 1;
  tool: McpToolName;
  snapshot: { generatedAt: string; ageSeconds: number; ttlSeconds: number };
  scope: { kind: "repository" | "machine"; repositoryId: string | null };
  sourceHealth: McpSourceHealth[];
  window: { name: McpWindow; since: string | null; until: string; timezone: "UTC"; basis: "session-start" | "activity-day" };
  totals: McpTotals;
  notes: string[];
  data: {
    groupBy: McpGroup;
    groups: Array<{ key: string; totals: McpTotals }>;
    totalGroups: number;
    nextOffset: number | null;
  } | McpBudget | McpProfile | {
    tools: McpToolStat[];
    totalTools: number;
    nextOffset: number | null;
  } | {
    sessions: McpRecentSession[];
    totalSessions: number;
    nextOffset: number | null;
  } | {
    inventoryScope: "launch-context";
    providers: McpUnusedProvider[];
  } | {
    agents: Array<{ provider: SessionProvider; totals: McpTotals; profile: McpProfile }>;
  };
}
