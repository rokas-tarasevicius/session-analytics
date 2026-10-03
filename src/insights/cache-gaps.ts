import { rateForContext, resolveRate, type PricingCatalog } from "../pricing/catalog.ts";
import type { RateCard, TokenUsage } from "../types.ts";
import type { CacheGapSignals } from "./types.ts";

interface Request {
  stream: string;
  timestamp: string | null;
  model: string;
  usage: TokenUsage;
  explicitTtl: boolean;
}

export function cacheGapSignals(requests: Iterable<Request>, card: RateCard | PricingCatalog): CacheGapSignals {
  const result: CacheGapSignals = { observableCalls: 0, timedTransitions: 0, fiveMinuteExpiries: 0, oneHourExpiries: 0, rewriteTokens: 0, pricedRewriteTokens: 0, estimatedPremiumUsd: 0 };
  const streams = new Map<string, Request[]>();
  for (const request of requests) {
    const list = streams.get(request.stream) ?? [];
    list.push(request); streams.set(request.stream, list);
    if (request.explicitTtl && request.timestamp && Number.isFinite(Date.parse(request.timestamp))) result.observableCalls++;
  }
  for (const list of streams.values()) {
    // Preserve file order: missing timestamps and model switches break continuity.
    for (let index = 1; index < list.length; index++) {
      const previous = list[index - 1]!, current = list[index]!;
      if (!previous.timestamp || !current.timestamp || !current.explicitTtl || previous.model !== current.model) continue;
      const gap = Date.parse(current.timestamp) - Date.parse(previous.timestamp);
      if (!Number.isFinite(gap) || gap < 0) continue;
      result.timedTransitions++;
      const five = gap > 300_000 ? current.usage.cacheWrite5mInputTokens : 0;
      const hour = gap > 3_600_000 ? current.usage.cacheWrite1hInputTokens : 0;
      if (five > 0) result.fiveMinuteExpiries++;
      if (hour > 0) result.oneHourExpiries++;
      result.rewriteTokens += five + hour;
      const baseRate = "history" in card ? resolveRate(card, current.model, current.timestamp)?.rate : card.models[current.model];
      const rate = baseRate ? rateForContext(baseRate, current.usage.inputTokens) : undefined;
      if (!rate || five + hour === 0) continue;
      const read = rate.cacheReadPerMillion ?? rate.cachedInputPerMillion ?? rate.inputPerMillion;
      const fiveRate = rate.cacheWrite5mPerMillion ?? rate.inputPerMillion * (rate.cacheWriteMultiplier ?? 1);
      const hourRate = rate.cacheWrite1hPerMillion ?? fiveRate;
      const multiplier = rate.longContext && current.usage.inputTokens > rate.longContext.thresholdInputTokens ? rate.longContext.inputMultiplier : 1;
      result.pricedRewriteTokens += five + hour;
      result.estimatedPremiumUsd += (five * Math.max(0, fiveRate - read) + hour * Math.max(0, hourRate - read)) * multiplier / 1_000_000;
    }
  }
  return result;
}
