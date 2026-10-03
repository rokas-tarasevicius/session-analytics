import type { ModelRate, SessionAnalytics } from "../types.ts";

/** Shared by rules and the P3 entry point; absence of liveness evidence is not inactivity. */
export function eligibleEvidence(s: SessionAnalytics): boolean {
  return s.transcript.status === "ok" && !s.transcript.snapshotWhileWorking &&
    s.transcript.completeness !== "partial" && s.transcript.liveness !== "active";
}

export function completedEvidence(s: SessionAnalytics): boolean {
  return eligibleEvidence(s) && s.transcript.completeness === "complete" && s.transcript.liveness === "inactive";
}

export const pricedEvidence = (s: SessionAnalytics): boolean => s.costBasis === "api-list-price-equivalent" && s.costComplete && s.pricedTokenCoverage === 1 && s.metrics.modelCalls > 0;

export function completeRequestSizes(s: SessionAnalytics): boolean {
  const sizes = s.insightSignals?.requestSizes;
  return Boolean(sizes && sizes.unknownTokens === 0 && sizes.observedTokens === s.tokens.inputTokens + s.tokens.outputTokens);
}

export function targetPriceEligible(s: SessionAnalytics, rate: ModelRate): boolean {
  return pricedEvidence(s) && (!rate.longContext || (completeRequestSizes(s) && s.metrics.maxInputTokensPerCall <= rate.longContext.thresholdInputTokens));
}
