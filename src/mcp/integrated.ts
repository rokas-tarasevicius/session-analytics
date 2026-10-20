import type { MachineAnalytics, SessionAnalytics } from "../types.ts";

/** Bounded aggregate pricing and velocity evidence; no transcript or config access. */
export function integratedMetrics(snapshot: MachineAnalytics, sessions: SessionAnalytics[]) {
  let datedValue = 0, undatedValue = 0, pricedTokens = 0, eligibleTokens = 0;
  for (const s of sessions) {
    if (s.costBasis !== "api-list-price-equivalent") continue;
    for (const [, , , v] of [...s.velocity?.buckets ?? [], ...s.velocity?.sessionDated ?? []]) {
      datedValue += v[0]; pricedTokens += v[10]; eligibleTokens += v[1] + v[5];
    }
    for (const [, v] of s.velocity?.undated ?? []) {
      undatedValue += v[0]; pricedTokens += v[10]; eligibleTokens += v[1] + v[5];
    }
  }
  return {
    basis: "whole-sessions-selected-by-start" as const,
    pricing: { policy: snapshot.rateCard.pricing?.policy ?? null, stale: snapshot.rateCard.pricing?.stale ?? null,
      sources: (snapshot.rateCard.pricing?.sources ?? []).map((p) => ({ source: p.source, fetchedAt: p.fetchedAt, stale: p.stale, models: p.models })) },
    velocity: { coveredSessions: sessions.filter((s) => s.velocity).length, selectedSessions: sessions.length,
      timeZone: snapshot.velocity?.timeZone ?? null, datedApiEquivalentUsd: datedValue, undatedApiEquivalentUsd: undatedValue, pricedTokens, eligibleTokens },
  };
}
