export interface HistoryUsageDay {
  day: string;
  model: string;
  tokens: number;
  valueUsd: number;
}
/** Native Claude request evidence for machine history coverage: the transcript's profile
 * and its deduplicated request tokens per UTC day and model. */
export interface HistoryProfileEvidence {
  profileKey: string;
  days: Array<{ day: string; model: string; tokens: number }>;
}
export interface HistoryStatistics {
  basis: "claude-stream-snapshots-v5";
  days: Array<{ day: string; model: string; tokens: number }>;
}
/** Recovered requests have dates but no trustworthy Claude profile identity. */
export interface SessionHistory {
  days: HistoryUsageDay[];
  undatedTokens: number;
  undatedValueUsd: number;
}
export interface HistoryReconciliation {
  outputTokensRecovered?: number;
  receiptFloorApplied?: boolean;
  messageValueUsd: number;
  reportedUsd: number | null;
  differenceUsd: number | null;
  relativeDifference: number | null;
  status: "agrees" | "differs" | "partial" | "unavailable";
  receiptScope: "complete" | "partial" | "unavailable";
  messages: number;
  messagesWithoutUsage: number;
  messagesWithoutIdentity: number;
}

export interface HistoryModelCoverage {
  model: string;
  statisticsDays: number;
  providerTokens: number;
  sessionTokens: number;
  sessionStatisticsTokens: number;
  gapTokens: number;
  possibleOverlapTokens: number;
  unattributedTokens: number;
  pricedUnattributedTokens: number;
  unattributedEstimateUsd: number;
  tokenMixSource: "lifetime-model" | "unavailable";
}
export interface HistoryProfileMonth {
  month: string;
  models: HistoryModelCoverage[];
}
export interface HistoryProfile {
  profileKey: string;
  ordinal: number;
  status: "available" | "missing" | "unsupported" | "unreadable";
  dailyTokensVersion: number | null;
  statisticsThrough: string | null;
  firstStatisticsDay: string | null;
  firstTranscriptDay: string | null;
  lifetimeTokens: number;
  sessionsWithoutStatisticsCounters: number;
  months: HistoryProfileMonth[];
}
export interface HistoryMonth {
  month: string;
  sessionsWithDatedValue: number;
  statisticsCells: number;
  sessionEvidenceUsd: number;
  unattributedEstimateUsd: number;
  unattributedTokens: number;
  pricedUnattributedTokens: number;
  possibleOverlapTokens: number;
  recoveredMessageUsd: number;
}
export interface HistoryCoverage {
  recoveryCalibration?: RecoveryCalibration;
  version: 1;
  scope: "machine";
  profiles: HistoryProfile[];
  months: HistoryMonth[];
  undatedSessionValueUsd: number;
  unassignedProfileTokens: number;
}

export interface RecoveryCalibration {
  version: 1;
  basis: "paired-surviving-native";
  pairedSessions: number;
  comparedSessions: number;
  excludedSessions: number;
  receiptFloorSessions: number;
  aboveNativeSessions: number;
  minimumNativeValueUsd: number;
  nativeValueUsd: number;
  recoveredValueUsd: number;
  aggregateValueRatio: number | null;
  medianValueRatio: number | null;
  p10ValueRatio: number | null;
  p90ValueRatio: number | null;
}
