import type { PublicModelRate, SessionAnalytics } from "../types.ts";

export interface CounterfactualValue {
  valueUsd: number | null;
  tokens: number;
  repricedTokens: number;
  unrepricedTokens: number;
  coverage: number | null;
  excluded: { providerReported: number; inputSplit: number; cacheWrite: number; missingRate: number };
  undatedTokens: number;
  unledgeredSessions: number;
}
export function counterfactualValue(sessions: SessionAnalytics[], rate: PublicModelRate | null | undefined,
  window: { start: string; end: string }): CounterfactualValue;
