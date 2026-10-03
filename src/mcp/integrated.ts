import type { MachineAnalytics, SessionAnalytics, WorkflowHistogram } from "../types.ts";
import { MIN_REQUESTS, MIN_INPUT_TOKENS, FRESHNESS_MINUTES } from "../metrics/limits-utils.ts";
import { summarizeOutcomes } from "../metrics/outcomes-summary.js";
import { summarizeWorkflow } from "../public/workflow-data.js";
import { errorDenominator, errorRate, summarizeReliability } from "../public/reliability-data.js";

/** Bounded aggregate evidence from the shared collectors; no transcript or config access. */
export function integratedMetrics(snapshot: MachineAnalytics, sessions: SessionAnalytics[], now: number) {
  const sum = (get: (s: SessionAnalytics) => number) => sessions.reduce((n, s) => n + get(s), 0);
  const reliability = summarizeReliability(sessions);
  const workflow = summarizeWorkflow(sessions, undefined, snapshot.generatedAt);
  const histogram = (h: WorkflowHistogram) => ({ samples: h.samples, p50: h.p50, p95: h.p95, max: h.max });
  const cacheRequests = sum((s) => s.limitsCache?.cache.requests ?? 0);
  const inputTokens = sum((s) => s.limitsCache?.cache.inputTokens ?? 0);
  const cacheReadTokens = sum((s) => s.limitsCache?.cache.cacheReadTokens ?? 0);
  const contextRequests = sum((s) => s.limitsCache?.context.eligibleRequests ?? 0);
  const quota = (snapshot.limitsCache?.profiles ?? []).flatMap((p) => p.windows.map((w) => {
    const age = now - Date.parse(w.latestNumeric?.timestamp ?? ""), expiry = Date.parse(w.headroomExpiresAt ?? "");
    const fresh = Number.isFinite(age) && age >= 0 && age <= FRESHNESS_MINUTES * 60_000 && expiry > now && !w.stale;
    return { profileKey: p.key, provider: p.provider, window: w.key, observations: w.observations,
      observedAt: w.latest.timestamp, headroomPercent: fresh ? w.headroomPercent : null,
      expiresAt: w.headroomExpiresAt, stale: !fresh, observedMinutes: w.observedMinutes, shareAbove90: w.shareAbove90 };
  }));
  let datedValue = 0, undatedValue = 0, pricedTokens = 0, eligibleTokens = 0;
  for (const s of sessions) {
    for (const [, , , v] of s.velocity?.buckets ?? []) { datedValue += v[0]; pricedTokens += v[10]; eligibleTokens += v[1] + v[5]; }
    for (const [, v] of s.velocity?.undated ?? []) undatedValue += v[0];
  }
  return {
    basis: "whole-sessions-selected-by-start" as const,
    pricing: { policy: snapshot.rateCard.pricing?.policy ?? null, stale: snapshot.rateCard.pricing?.stale ?? null,
      sources: (snapshot.rateCard.pricing?.sources ?? []).map((p) => ({ source: p.source, fetchedAt: p.fetchedAt, stale: p.stale, models: p.models })) },
    velocity: { coveredSessions: sessions.filter((s) => s.velocity).length, selectedSessions: sessions.length,
      timeZone: snapshot.velocity?.timeZone ?? null, datedApiEquivalentUsd: datedValue, undatedApiEquivalentUsd: undatedValue, pricedTokens, eligibleTokens },
    reliability: { coveredSessions: reliability.coveredSessions, selectedSessions: sessions.length,
      contentRuleSessions: reliability.contentRuleSessions, truncatedSessions: reliability.truncatedSessions,
      calls: reliability.totals.calls, errorRate: errorRate(reliability.totals), errorDenominator: errorDenominator(reliability.totals),
      latency: { samples: reliability.totals.latency.samples, p50Ms: reliability.totals.latency.p50Ms, p95Ms: reliability.totals.latency.p95Ms },
      verification: { checks: reliability.verification.checks, passed: reliability.verification.passed, failed: reliability.verification.failed,
        eligibleSessions: reliability.verification.eligibleSessions, skippedSessions: reliability.verification.skippedSessions } },
    limitsCache: { minimumRequests: MIN_REQUESTS, minimumInputTokens: MIN_INPUT_TOKENS, coveredSessions: sessions.filter((s) => s.limitsCache).length, selectedSessions: sessions.length,
      requests: cacheRequests, inputTokens, cacheReadTokens, hitRatio: cacheRequests >= MIN_REQUESTS && inputTokens >= MIN_INPUT_TOKENS ? cacheReadTokens / inputTokens : null,
      pricedRequests: sum((s) => s.limitsCache?.cache.pricedRequests ?? 0), netSavingsUsd: sum((s) => s.limitsCache?.cache.pricedRequests ?? 0) ? sum((s) => s.limitsCache?.cache.netSavingsUsd ?? 0) : null,
      flaggedBreakRequests: sum((s) => s.limitsCache?.cache.breakRequests ?? 0), contextRequests,
      above80: sum((s) => s.limitsCache?.context.above80 ?? 0),
      quotaScope: "global-profile-observations" as const, quota: quota.slice(0, 20), omittedQuotaWindows: Math.max(0, quota.length - 20) },
    outcomes: summarizeOutcomes(sessions),
    workflow: { coverage: workflow.coverage, humanTurns: workflow.autonomy.humanTurns, toolRuns: histogram(workflow.autonomy.toolRuns),
      turnWallTime: histogram(workflow.autonomy.turnWallTime), time: workflow.time, interruptions: workflow.interruptions,
      archetypes: workflow.archetypes, abandonment: workflow.abandonment,
      concurrency: { peak: workflow.concurrency.peak, eligibleSessions: workflow.concurrency.eligibleSessions, effectiveParallelism: workflow.concurrency.effectiveParallelism } },
    insightSignals: { coveredSessions: sessions.filter((s) => s.insightSignals).length, selectedSessions: sessions.length,
      knownRequestSizeTokens: sum((s) => s.insightSignals?.requestSizes?.observedTokens ?? 0),
      unknownRequestSizeTokens: sum((s) => s.insightSignals?.requestSizes?.unknownTokens ?? 0),
      cacheGapTransitions: sum((s) => s.insightSignals?.cacheGaps?.timedTransitions ?? 0),
      estimatedCacheGapPremiumUsd: sum((s) => s.insightSignals?.cacheGaps?.estimatedPremiumUsd ?? 0) },
  };
}
