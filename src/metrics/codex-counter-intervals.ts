import type { TokenUsage } from "../types.ts";

type Counter = [number, number, number, number];
const counter = (value: TokenUsage): Counter => [value.inputTokens, value.cachedInputTokens, value.outputTokens, value.reasoningOutputTokens];
export const codexIntervalKey = (before: TokenUsage, after: TokenUsage): string =>
  `interval:${counter(before).join(":")}:${counter(after).join(":")}`;

/** Require an exact four-counter chain, never estimate overlap from input alone. */
export function codexIntervalCovered(before: TokenUsage, after: TokenUsage, fingerprints: Iterable<string>): boolean {
  const lower = counter(before), upper = counter(after);
  const edges = new Map<string, Counter[]>();
  for (const fingerprint of fingerprints) {
    const values = fingerprint.split(":").map(Number);
    if (values.length !== 8 || values.some((value) => !Number.isFinite(value))) continue;
    const total = values.slice(0, 4) as Counter, last = values.slice(4) as Counter;
    if (last[0] + last[2] <= 0) continue;
    const start = total.map((value, i) => value - last[i]!) as Counter;
    if (start.some((value, i) => value < lower[i]!) || total.some((value, i) => value > upper[i]!)) continue;
    const key = total.join(":");
    edges.set(key, [...(edges.get(key) ?? []), start]);
  }
  const pending: Counter[] = [upper], seen = new Set<string>(), target = lower.join(":");
  while (pending.length) {
    const current = pending.pop()!, key = current.join(":");
    if (key === target) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(...(edges.get(key) ?? []));
  }
  return false;
}
