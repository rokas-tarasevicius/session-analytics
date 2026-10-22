import type { PublicModelRate, SessionAnalytics, SessionProvider } from "../types.ts";

export interface CounterfactualValue {
  valueUsd: number | null;
  tokens: number;
  repricedTokens: number;
  unrepricedTokens: number;
  coverage: number | null;
  excluded: { providerReported: number; inputSplit: number; cacheWrite: number; missingRate: number };
  undatedTokens: number;
  unledgeredSessions: number;
  vendors: Array<{ vendor: SessionProvider | null; tokens: number; valueUsd: number; crossVendor: boolean | null }>;
}
export function counterfactualValue(sessions: SessionAnalytics[], rate: PublicModelRate | null | undefined,
  window: { start: string; end: string }, sourceModels?: Array<{ model: string; rate?: PublicModelRate }>): CounterfactualValue;
