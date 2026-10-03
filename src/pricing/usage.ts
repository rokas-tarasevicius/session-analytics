import type { CostBreakdown, ModelRate, PricingAssumption, TokenUsage } from "../types.ts";
import { rateForContext } from "./catalog.ts";
import { upperEstimateAssumption } from "./validation.ts";

/** Keep estimates in value totals, but count only token classes with explicit rates as priced evidence. */
export function priceUsage(original: ModelRate, usage: TokenUsage, inputForRequest: number): {
  cost: CostBreakdown; pricedTokens: number; assumptions: PricingAssumption[];
} {
  const rate = rateForContext(original, inputForRequest);
  const tier = original.contextTiers?.findLast(({ aboveInputTokens }) => inputForRequest > aboveInputTokens);
  const inputMultiplier = rate.longContext && inputForRequest > rate.longContext.thresholdInputTokens ? rate.longContext.inputMultiplier : 1;
  const outputMultiplier = rate.longContext && inputForRequest > rate.longContext.thresholdInputTokens ? rate.longContext.outputMultiplier : 1;
  const cachedRate = rate.cachedInputPerMillion ?? rate.cacheReadPerMillion ?? rate.inputPerMillion;
  const fiveMinuteWriteRate = rate.cacheWrite5mPerMillion ?? rate.inputPerMillion * (rate.cacheWriteMultiplier ?? 1);
  const oneHourWriteRate = rate.cacheWrite1hPerMillion ?? fiveMinuteWriteRate;
  const unsplitTokens = Math.max(0,
    usage.cacheWriteInputTokens - usage.cacheWrite5mInputTokens - usage.cacheWrite1hInputTokens);
  const fiveMinuteTokens = usage.cacheWrite5mInputTokens + unsplitTokens;
  const inputUsd = usage.uncachedInputTokens * rate.inputPerMillion * inputMultiplier / 1e6;
  const cachedInputUsd = usage.cachedInputTokens * cachedRate * inputMultiplier / 1e6;
  const cacheWriteUsd = (fiveMinuteTokens * fiveMinuteWriteRate + usage.cacheWrite1hInputTokens * oneHourWriteRate) * inputMultiplier / 1e6;
  const outputUsd = usage.outputTokens * rate.outputPerMillion * outputMultiplier / 1e6;
  const totalUsd = inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd;
  const adjustment = rate.cacheWriteObservable === false && rate.cacheWriteMultiplier
    ? usage.uncachedInputTokens * rate.inputPerMillion * (rate.cacheWriteMultiplier - 1) * inputMultiplier / 1e6 : 0;
  let pricedTokens = usage.inputTokens + usage.outputTokens;
  const assumptions: PricingAssumption[] = [];
  const estimate = (tokens: number, code: PricingAssumption) => {
    if (tokens > 0) { pricedTokens -= tokens; assumptions.push(code); }
  };
  if (rate.cachedInputPerMillion === undefined && rate.cacheReadPerMillion === undefined) {
    estimate(usage.cachedInputTokens, "cache-read-at-input");
  } else if (tier && tier.cacheReadPerMillion === undefined) {
    estimate(usage.cachedInputTokens, "context-cache-read-at-base");
  }
  if (rate.cacheWrite5mPerMillion === undefined) {
    estimate(fiveMinuteTokens, (rate.cacheWriteMultiplier ?? 1) === 1 ? "cache-write-5m-at-input" : "cache-write-5m-multiplier");
  } else if (tier && tier.cacheWrite5mPerMillion === undefined) {
    estimate(fiveMinuteTokens, "context-cache-write-5m-at-base");
  }
  if (unsplitTokens > 0) {
    assumptions.push("cache-write-ttl-5m");
    // Each token leaves coverage once, even when both its rate and TTL were substituted.
    if (rate.cacheWrite5mPerMillion !== undefined && (!tier || tier.cacheWrite5mPerMillion !== undefined)) pricedTokens -= unsplitTokens;
  }
  if (rate.cacheWrite1hPerMillion === undefined) {
    estimate(usage.cacheWrite1hInputTokens, "cache-write-1h-at-5m");
  } else if (rate.assumptions?.includes("anthropic-cache-1h-2x")) {
    estimate(usage.cacheWrite1hInputTokens, "anthropic-cache-1h-2x");
  } else if (tier && tier.cacheWrite1hPerMillion === undefined) {
    estimate(usage.cacheWrite1hInputTokens, "context-cache-write-1h-at-base");
  }
  const upper = upperEstimateAssumption(rate);
  if (adjustment > 0 && upper) assumptions.push(upper);
  return { cost: { cacheWriteUsd, cachedInputUsd, inputUsd, outputUsd, totalUsd, upperEstimateUsd: totalUsd + adjustment },
    pricedTokens, assumptions };
}
