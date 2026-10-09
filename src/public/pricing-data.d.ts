import type { PublicModelRate, RateProvenance, RepositoryAnalytics, SessionAnalytics } from "../types.ts";
import type { ProviderKey } from "./chart-colors.js";

export interface PricingCardUsage {
  valueUsd: number; upperEstimateUsd: number; tokens: number; pricedTokens: number; calls: number; sessions: number;
  inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; coverage: number | null;
}
export interface PricingModelCard {
  /** `${provider}:${model}`: cards are per session provider and model. */
  id: string;
  /** `provider` is the session provider whose usage the card shows; `vendor` publishes the rate. */
  model: string; used: boolean; priced: boolean; provider: ProviderKey; vendor: ProviderKey; rate: PublicModelRate | null; source: string | null;
  current: RateProvenance | null; provenance: RateProvenance[]; usage: PricingCardUsage | null;
}
export function pricingModelCards(rateCard: RepositoryAnalytics["rateCard"], sessions: SessionAnalytics[], window?: { start?: string; end?: string }): {
  used: PricingModelCard[]; unused: PricingModelCard[]; tokens: number; pricedTokens: number; coverage: number | null;
  total: number; api: number; reported: number; maxValue: number; maxTokens: number;
};
export function rateRows(rate: PublicModelRate | null): Array<[string, number]>;
export function contextRows(rate: PublicModelRate | null): Array<[string, number, number]>;
