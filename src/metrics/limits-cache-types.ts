import type { ExecutionKind, SessionProvider } from "../types.ts";

export type LimitProvider = "claude" | "codex";
export type LimitSource = "codex-transcript" | "claude-quota" | "claude-cache" | "claude-desktop";
export type LimitHitKind = "http-429" | "usage-limit-exceeded" | "quota-rejected";
export type CacheMissReason = "previous_message_not_found" | "messages_changed" | "tools_changed" | "system_changed" | "model_changed";
export type CacheHeuristic = "idle-ttl" | "model-switch" | "compaction";

export interface LimitSample {
  timestamp: string;
  usedPercent: number | null;
  resetsAt: string | null;
  status: "allowed" | "allowed_warning" | "rejected" | null;
  source: LimitSource;
  usingOverage: boolean | null;
}

export interface LimitWindow {
  key: string;
  label: string;
  windowMinutes: number | null;
  observations: number;
  duplicatesDiscarded: number;
  historyLimited: boolean;
  timelineSampled: boolean;
  timeline: LimitSample[];
  latest: LimitSample;
  stale: boolean;
  headroomPercent: number | null;
  timeToLimitMinutes: number | null;
  observedMinutes: number;
  above90Minutes: number;
  shareAbove90: number | null;
}

export interface LimitProfile {
  key: string;
  provider: LimitProvider;
  ordinal: number;
  label: string;
  scope: "profile" | "desktop-account";
  planType: "free" | "go" | "plus" | "pro" | "team" | "business" | "enterprise" | "edu" | "unknown" | null;
  planObservedAt: string | null;
  credits: { observedAt: string; hasCredits: boolean | null; unlimited: boolean | null; balance: number | null } | null;
  windows: LimitWindow[];
  limitHits: Array<{ timestamp: string; kind: LimitHitKind }>;
  limitHitCount: number;
  sessionsWithLimitErrors: number;
}

export interface CacheTotals {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  pricedRequests: number;
  pricedInputTokens: number;
  actualInputUsd: number;
  noCacheInputUsd: number;
  netSavingsUsd: number;
  cacheWriteUsd: number;
  recacheWriteUsd: number;
  breakRequests: number;
  pricedBreakRequests: number;
  reportedBreaks: number;
  heuristicBreaks: number;
  unknownTtlWriteRequests: number;
}

export interface ContextTotals {
  requests: number;
  eligibleRequests: number;
  reportedWindowRequests: number;
  reviewedWindowRequests: number;
  above40: number;
  above60: number;
  above80: number;
  peakFill: number | null;
}

export interface EconomicsBucket {
  day: string | null;
  model: string;
  executionKind: ExecutionKind;
  observedTokens: number;
  pricedTokens: number;
  apiEquivalentUsd: number;
  cache: CacheTotals;
  context: ContextTotals;
}

export interface SessionLimitsCache {
  profileKey: string | null;
  cache: CacheTotals & { hitRatio: number | null; pricingCoverage: number | null };
  context: ContextTotals & {
    shareAbove40: number | null;
    shareAbove60: number | null;
    shareAbove80: number | null;
    curveSampled: boolean;
    curve: Array<{ request: number; timestamp: string | null; executionKind: ExecutionKind; inputTokens: number; windowTokens: number; fill: number }>;
  };
  buckets: EconomicsBucket[];
  cacheBreaks: Array<{
    timestamp: string | null;
    model: string;
    executionKind: ExecutionKind;
    reportedReason: CacheMissReason | null;
    heuristics: CacheHeuristic[];
    writeTokens: number;
    writeUsd: number | null;
  }>;
  cacheBreaksSampled: boolean;
  compactions: Array<{
    timestamp: string | null;
    executionKind: ExecutionKind;
    trigger: "auto" | "manual" | "unknown";
    preTokens: number | null;
    postTokens: number | null;
    turnsSincePrevious: number | null;
  }>;
  compactionCount: number;
  compactionsSampled: boolean;
}

export interface SubscriptionMonth {
  profileKey: string;
  month: string;
  apiEquivalentUsd: number;
  monthlyPriceUsd: number | null;
  leverage: number | null;
  pricedTokens: number;
  observedTokens: number;
  pricingCoverage: number | null;
  activeDays: number;
  partialMonth: boolean;
  scope: "all-repositories" | "selected-repository";
}

export interface LimitsCacheAnalytics {
  profiles: LimitProfile[];
  subscriptions: SubscriptionMonth[];
  warnings: string[];
  policy: {
    freshnessMinutes: number;
    maximumObservationGapMinutes: number;
    minimumObservedMinutes: number;
    minimumRequests: number;
    minimumInputTokens: number;
    contextTableReviewedAt: string;
  };
}

/** Internal only: values here never cross the public projection. */
export interface ProfileConfig {
  provider: SessionProvider;
  profile?: number;
  profileKey?: string;
  label?: string;
  monthlyPriceUsd?: number;
}
