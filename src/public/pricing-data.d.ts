import type { PublicModelRate, RateProvenance, RepositoryAnalytics, SessionAnalytics } from "../types.ts";
import type { ProviderKey } from "./chart-colors.js";

export interface PricingCardUsage {
  valueUsd: number; upperEstimateUsd: number; tokens: number; pricedTokens: number; calls: number; sessions: number;
  inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; coverage: number | null;
}
export interface PricingModelCard {
  model: string; used: boolean; priced: boolean; provider: ProviderKey; rate: PublicModelRate | null; source: string | null;
  current: RateProvenance | null; provenance: RateProvenance[]; usage: PricingCardUsage | null;
}
export function pricingModelCards(rateCard: RepositoryAnalytics["rateCard"], sessions: SessionAnalytics[]): {
  used: PricingModelCard[]; unused: PricingModelCard[]; tokens: number; pricedTokens: number; maxValue: number; maxTokens: number;
};
export function rateRows(rate: PublicModelRate | null): Array<[string, number]>;
export function contextRows(rate: PublicModelRate | null): Array<[string, number, number]>;
