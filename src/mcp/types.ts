import type { ExecutionKind, MachineAnalytics, SessionProvider } from "../types.ts";

export type McpActivityState = "active" | "settled" | "unknown";
export interface McpPricingDay { day: string; eligibleTokens: number; pricedTokens: number }
export interface McpSourceHealth {
  provider: SessionProvider;
  status: "available" | "incomplete" | "unavailable" | "unknown";
  sourcesRead: number;
  missingSources: number;
  unreadableSources: number;
}

/** Lifecycle state and the daily pricing ledger; never transcript text. */
export interface McpSessionEvidence {
  activityState?: McpActivityState;
  pricingByDay?: McpPricingDay[];
  undatedTokens?: number;
}

export interface McpContext {
  repositoryId: string | null;
}

export interface McpSnapshot {
  analytics: MachineAnalytics;
}

export type McpWindow = "today" | "week" | "7d" | "30d" | "90d" | "all";
export type McpGroup = "repository" | "provider" | "model" | "agent";
export type McpToolName = "usage_summary" | "budget_status" | "repo_profile" | "tool_stats" |
  "recent_sessions" | "compare_agents";

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
  omittedTools: number;
}

export interface McpToolStat {
  name: string;
  calls: number;
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
    agents: Array<{ provider: SessionProvider; totals: McpTotals; profile: McpProfile }>;
  };
}
