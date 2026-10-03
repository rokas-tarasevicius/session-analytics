import type { ContextPriceTier, ModelRate, PricingAssumption, RateCard } from "../types.ts";
import { validModelId } from "./aliases.ts";

export const MAX_PRICE = 10_000; // USD per million text tokens; reject unit/schema accidents.
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_MODELS = 10_000;
export const priceFields = ["inputPerMillion", "outputPerMillion", "cachedInputPerMillion",
  "cacheReadPerMillion", "cacheWrite5mPerMillion", "cacheWrite1hPerMillion"] as const;

export function upperEstimateAssumption(rate: ModelRate): PricingAssumption | undefined {
  if (rate.cacheWriteObservable !== false || (rate.cacheWriteMultiplier ?? 1) <= 1) return undefined;
  return rate.provider === "codex" && rate.cacheWriteMultiplier === 1.25
    ? "codex-cache-write-upper-1.25x" : "cache-write-upper-multiplier";
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function price(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_PRICE) {
    throw new Error("Invalid model price.");
  }
  return value;
}

function positive(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error("Invalid pricing boundary.");
  }
  return value;
}

export function isoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function sourceUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 500) throw new Error("Invalid pricing source.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid pricing source.");
  }
  return url.href;
}

/** Build a new object: unknown feed/cache fields must never enter a public projection. */
export function validateRate(raw: unknown, trustedSource?: string): ModelRate {
  const input = record(raw);
  if (!input || (input.provider !== "claude" && input.provider !== "codex")) throw new Error("Invalid rate card.");
  const rate: ModelRate = {
    provider: input.provider,
    inputPerMillion: price(input.inputPerMillion),
    outputPerMillion: price(input.outputPerMillion),
    source: trustedSource ?? sourceUrl(input.source),
  };
  for (const field of priceFields) if (input[field] !== undefined) rate[field] = price(input[field]);
  if (input.cacheWriteObservable !== undefined) {
    if (typeof input.cacheWriteObservable !== "boolean") throw new Error("Invalid cache policy.");
    rate.cacheWriteObservable = input.cacheWriteObservable;
  }
  if (input.cacheWriteMultiplier !== undefined) {
    const multiplier = positive(input.cacheWriteMultiplier, 100);
    if (multiplier < 1) throw new Error("Invalid cache premium.");
    rate.cacheWriteMultiplier = multiplier;
  }
  if (input.longContext !== undefined) {
    const tier = record(input.longContext);
    if (!tier) throw new Error("Invalid context tier.");
    rate.longContext = {
      inputMultiplier: positive(tier.inputMultiplier, 100),
      outputMultiplier: positive(tier.outputMultiplier, 100),
      thresholdInputTokens: positive(tier.thresholdInputTokens, 100_000_000),
    };
    if (!Number.isInteger(rate.longContext.thresholdInputTokens)) throw new Error("Invalid context boundary.");
    price(rate.inputPerMillion * rate.longContext.inputMultiplier);
    price(rate.outputPerMillion * rate.longContext.outputMultiplier);
  }
  if (input.contextTiers !== undefined) {
    if (!Array.isArray(input.contextTiers) || input.contextTiers.length > 20) throw new Error("Invalid context tiers.");
    rate.contextTiers = input.contextTiers.map((rawTier): ContextPriceTier => {
      const tier = record(rawTier);
      if (!tier) throw new Error("Invalid context tier.");
      const result: ContextPriceTier = {
        aboveInputTokens: positive(tier.aboveInputTokens, 100_000_000),
        inputPerMillion: price(tier.inputPerMillion),
        outputPerMillion: price(tier.outputPerMillion),
      };
      if (!Number.isInteger(result.aboveInputTokens)) throw new Error("Invalid context boundary.");
      for (const key of ["cacheReadPerMillion", "cacheWrite5mPerMillion", "cacheWrite1hPerMillion"] as const) {
        if (tier[key] !== undefined) result[key] = price(tier[key]);
      }
      if (Array.isArray(tier.assumptions) && tier.assumptions.includes("anthropic-cache-1h-2x")) {
        result.assumptions = ["anthropic-cache-1h-2x"];
      }
      return result;
    }).sort((a, b) => a.aboveInputTokens - b.aboveInputTokens);
    if (new Set(rate.contextTiers.map((tier) => tier.aboveInputTokens)).size !== rate.contextTiers.length) {
      throw new Error("Duplicate context boundary.");
    }
  }
  if (Array.isArray(input.assumptions)) {
    rate.assumptions = [...new Set(input.assumptions.filter((value) =>
      value === "anthropic-cache-1h-2x"))];
  }
  const upper = upperEstimateAssumption(rate);
  if (upper) rate.assumptions = [...(rate.assumptions ?? []), upper];
  return rate;
}

export function validateCard(raw: unknown): RateCard {
  const card = record(raw), models = record(card?.models);
  if (!card || card.currency !== "USD" || !isoDate(card.effectiveDate) || !models ||
      Object.keys(models).length > MAX_MODELS) throw new Error("The session analytics rate card is invalid.");
  const output: RateCard = { currency: "USD", effectiveDate: card.effectiveDate, models: Object.create(null) };
  for (const [model, rate] of Object.entries(models)) {
    if (!validModelId(model)) throw new Error("The session analytics rate card is invalid.");
    output.models[model] = validateRate(rate);
  }
  if (card.reviewedOverrides !== undefined) {
    if (!Array.isArray(card.reviewedOverrides) || card.reviewedOverrides.some((model) =>
      typeof model !== "string" || !Object.hasOwn(output.models, model))) throw new Error("Invalid reviewed overrides.");
    output.reviewedOverrides = [...new Set(card.reviewedOverrides)] as string[];
  }
  return output;
}
