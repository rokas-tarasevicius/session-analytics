import type { RateCard, SessionProvider } from "../types.ts";

export const ruleIds = ["session-outlier", "cache-waste", "model-pricing", "compaction-heavy", "subagent-share", "long-context", "unused-skills", "unused-mcp", "idle-cache", "time-pattern"] as const;
export type InsightRule = typeof ruleIds[number];

export interface Insight {
  id: string;
  rule: InsightRule;
  title: string;
  scope: { kind: "machine" | "repo" | "session"; repositoryId: string | null; sessionKey: string | null; provider: SessionProvider | null };
  evidence: Array<{ label: string; value: number; unit: "USD" | "tokens" | "count" | "ratio" | "multiple" | "hour"; denominator: number | null; denominatorLabel: string | null }>;
  estimatedImpact: { value: number | null; unit: "USD" | "tokens"; basis: "scenario-difference" | "associated-usage" | "unavailable"; label: string };
  confidence: "low" | "medium" | "high";
  guardrail: string;
  suggestedAction: string;
  names: string[];
  coverage: { eligibleSessions: number; totalSessions: number };
  session?: { startedAt: string | null; models: string[] };
  pricing?: { strategy: "next-tier-down" | "configured-target"; transitions: Array<{ sourceModel: string; targetModel: string }> };
}

export type NextTierModels = Partial<Record<"claude" | "codex", Record<string, string | null>>>;

export interface InsightGroup {
  id: string;
  ruleDecisionId: string;
  rule: InsightRule;
  scopeKind: Insight["scope"]["kind"];
  title: string;
  itemIds: string[];
  affected: { repositories: number; sessions: number };
  coverage: { eligibleSessions: number; totalSessions: number; totalRepositories: number };
  estimatedImpact: Insight["estimatedImpact"];
  impactCoverage: { quantifiedItems: number; totalItems: number };
  confidence: Insight["confidence"];
  guardrails: string[];
  suggestedAction: string;
}

export interface InsightThresholds {
  minRepoSessions: number;
  minModelCalls: number;
  minInputTokens: number;
  outlierMultiplier: number;
  minOutlierUsd: number;
  minDifferenceUsd: number;
  cacheReadShare: number;
  cacheWriteShare: number;
  compactionsPer100Calls: number;
  minCompactions: number;
  subagentShare: number;
  subagentDelta: number;
  longContextInputTokens: number;
  longContextShare: number;
  extensionMinSessions: number;
  extensionMinToolCalls: number;
  idleGapMinEvents: number;
  timeMinSessions: number;
  timeBucketShare: number;
  utcOffsetMinutes: number;
}

export interface ExtensionInventory {
  provider: "claude" | "codex";
  skills: string[];
  mcpServers: string[];
}

export interface InsightContext {
  thresholds: InsightThresholds;
  disabledRules: InsightRule[];
  comparisonModels: Partial<Record<"claude" | "codex", string>>;
  nextTierModels: NextTierModels;
  inventory: ExtensionInventory[];
  rateCard: RateCard;
  warnings: string[];
}

export interface InsightsReport {
  schemaVersion: 2;
  generatedAt: string;
  rateCardEffectiveDate: string;
  thresholds: InsightThresholds;
  groups: InsightGroup[];
  items: Insight[];
  coverage: Array<{ rule: InsightRule; eligibleSessions: number; totalSessions: number; findings: number; groups: number; status: "disabled" | "unavailable" | "insufficient" | "no-findings" | "findings" }>;
  warnings: string[];
  evidenceCoverage: Array<{ reason: "partial-transcript" | "active-session" | "unknown-liveness" | "unknown-completeness" | "unknown-request-size"; sessions: number; totalSessions: number }>;
}

/** P0 only. Claude requests deduplicated before measurement, within each evidence file. */
export interface CacheGapSignals {
  observableCalls: number;
  timedTransitions: number;
  fiveMinuteExpiries: number;
  oneHourExpiries: number;
  rewriteTokens: number;
  pricedRewriteTokens: number;
  estimatedPremiumUsd: number;
}
