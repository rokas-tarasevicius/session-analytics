import type { ModelRate, PriceChange } from "../types.ts";
export type { PriceChange } from "../types.ts";
import { priceFields } from "./validation.ts";
import type { SourceSnapshot } from "./sources.ts";

function rateValues(rate: ModelRate): number[] {
  return [
    ...priceFields.map((key) => rate[key] ?? -1), rate.cacheWriteMultiplier ?? -1,
    rate.longContext?.inputMultiplier ?? -1, rate.longContext?.outputMultiplier ?? -1,
    rate.longContext?.thresholdInputTokens ?? -1,
    ...(rate.contextTiers ?? []).flatMap((tier) => [tier.aboveInputTokens, tier.inputPerMillion, tier.outputPerMillion,
      tier.cacheReadPerMillion ?? -1, tier.cacheWrite5mPerMillion ?? -1, tier.cacheWrite1hPerMillion ?? -1]),
  ];
}

export function diffSource(previous: SourceSnapshot | undefined, next: SourceSnapshot): PriceChange[] {
  if (!previous) return [];
  const changes: PriceChange[] = [];
  for (const model of [...new Set([...Object.keys(previous.models), ...Object.keys(next.models)])].sort()) {
    const before = previous.models[model] ?? null, after = next.models[model] ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const oldValues = before ? rateValues(before) : [], newValues = after ? rateValues(after) : [];
    const boundariesChanged = before && after && (before.longContext?.thresholdInputTokens !== after.longContext?.thresholdInputTokens ||
      JSON.stringify(before.contextTiers?.map(({ aboveInputTokens }) => aboveInputTokens)) !==
      JSON.stringify(after.contextTiers?.map(({ aboveInputTokens }) => aboveInputTokens)));
    const large = !after || Boolean(boundariesChanged) || (Boolean(before) && (oldValues.length !== newValues.length ||
      newValues.some((value, i) => {
        const old = oldValues[i] ?? -1;
        return value !== old && (value < 0 || old <= 0 || Math.abs(value - old) / old > 0.5);
      })));
    changes.push({ source: next.source, model, change: !before ? "added" : !after ? "removed" : "changed", large, before, after });
  }
  return changes;
}
