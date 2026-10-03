import type { CostBreakdown, ExecutionKind, ModelRate, TokenUsage } from "../types.ts";
import type { CacheHeuristic, CacheMissReason, CacheTotals, ContextTotals, EconomicsBucket, SessionLimitsCache } from "./limits-cache-types.ts";
import { claudeContextWindow } from "./context-windows.ts";
import { publicModel } from "../public-model.ts";
import { reconcileCompactions, type CompactionEvidence } from "./compactions.ts";
import { sampleContextCurve } from "./context-detail.ts";
import { MIN_INPUT_TOKENS, MIN_REQUESTS, nonnegative, oneOf, record, sample, timestamp } from "./limits-utils.ts";

export interface RequestEvidence {
  stream: string;
  contextWindow: number | null;
  requestInputKnown: boolean;
  compactions: number;
  reportedReason: CacheMissReason | null;
  ttlMinutes: number | null;
}
export function claudeRequestEvidence(raw: Record<string, unknown>, stream: string, compactions: number): RequestEvidence {
  const usage = record(record(raw["message"])?.["usage"]), creation = record(usage?.["cache_creation"]);
  return { stream, contextWindow: null, requestInputKnown: nonnegative(usage?.["input_tokens"]) !== null, compactions,
    reportedReason: oneOf(record(record(raw["diagnostics"])?.["cache_miss_reason"])?.["type"],
      ["previous_message_not_found", "messages_changed", "tools_changed", "system_changed", "model_changed"] as const),
    ttlMinutes: (nonnegative(creation?.["ephemeral_1h_input_tokens"]) ?? 0) > 0 ? 60
      : (nonnegative(creation?.["ephemeral_5m_input_tokens"]) ?? 0) > 0 ? 5 : null };
}

export const emptyCache = (): CacheTotals => ({ requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  pricedRequests: 0, pricedInputTokens: 0, actualInputUsd: 0, noCacheInputUsd: 0, netSavingsUsd: 0,
  cacheWriteUsd: 0, recacheWriteUsd: 0, breakRequests: 0, pricedBreakRequests: 0, reportedBreaks: 0, heuristicBreaks: 0, unknownTtlWriteRequests: 0 });
export const emptyContext = (): ContextTotals => ({ requests: 0, eligibleRequests: 0, reportedWindowRequests: 0,
  reviewedWindowRequests: 0, above40: 0, above60: 0, above80: 0, peakFill: null });

interface PreviousRequest { model: string; timestamp: string | null; ttl: number | null; compactions: number; hadCache: boolean }

/** Receives deduplicated requests only. No prompt text or raw record is retained. */
export class CacheContextCollector {
  profileKey: string | null = null;
  private cache = emptyCache();
  private context = emptyContext();
  private buckets = new Map<string, EconomicsBucket>();
  private previous = new Map<string, PreviousRequest>();
  private breaks: SessionLimitsCache["cacheBreaks"] = [];
  private curve: SessionLimitsCache["context"]["curve"] = [];
  private compactions: CompactionEvidence[] = [];

  addCompaction(stream: string, shape: string, identity: string | null, at: unknown, executionKind: ExecutionKind, turns: number, metadata?: unknown): void {
    const fields = record(metadata);
    this.compactions.push({ stream, shape, identity, timestamp: timestamp(at), executionKind, turns,
      trigger: oneOf(fields?.["trigger"], ["auto", "manual"] as const) ?? "unknown",
      preTokens: nonnegative(fields?.["preTokens"]), postTokens: nonnegative(fields?.["postTokens"]) });
  }

  addRequest(model: string, usage: TokenUsage, rate: ModelRate | undefined, cost: CostBreakdown | null,
    at: string | null, executionKind: ExecutionKind, evidence: RequestEvidence, provider: "claude" | "codex"): void {
    model = publicModel(model);
    const when = timestamp(at), day = when?.slice(0, 10) ?? null;
    const identity = JSON.stringify([day, model, executionKind]);
    let bucket = this.buckets.get(identity);
    if (!bucket) {
      bucket = { day, model, executionKind, observedTokens: 0, pricedTokens: 0, apiEquivalentUsd: 0, cache: emptyCache(), context: emptyContext() };
      this.buckets.set(identity, bucket);
    }
    const totalTokens = usage.inputTokens + usage.outputTokens;
    bucket.observedTokens += totalTokens;
    if (rate && cost) { bucket.pricedTokens += totalTokens; bucket.apiEquivalentUsd += cost.totalUsd; }
    const previous = this.previous.get(evidence.stream);
    const heuristics: CacheHeuristic[] = [];
    if (provider === "claude" && previous && usage.cacheWriteInputTokens > 0) {
      if (previous.model !== model) heuristics.push("model-switch");
      if (previous.compactions < evidence.compactions) heuristics.push("compaction");
      if (when && previous.timestamp && previous.hadCache && previous.ttl !== null &&
        Date.parse(when) - Date.parse(previous.timestamp) > previous.ttl * 60_000) heuristics.push("idle-ttl");
    }
    const isBreak = evidence.reportedReason !== null || heuristics.length > 0;
    if (isBreak) this.breaks.push({ timestamp: when, model, executionKind, reportedReason: evidence.reportedReason,
      heuristics, writeTokens: usage.cacheWriteInputTokens, writeUsd: evidence.requestInputKnown ? cost?.cacheWriteUsd ?? null : null });
    if (evidence.requestInputKnown) this.previous.set(evidence.stream, { model, timestamp: when,
      ttl: usage.cacheWriteInputTokens > 0 ? evidence.ttlMinutes : previous?.model === model ? previous.ttl : null,
      compactions: evidence.compactions, hadCache: usage.cachedInputTokens + usage.cacheWriteInputTokens > 0 });

    const reportedWindow = evidence.contextWindow !== null && evidence.contextWindow > 0 ? evidence.contextWindow : null;
    const window = reportedWindow ?? (provider === "claude" ? claudeContextWindow(model) : null);
    const fill = evidence.requestInputKnown && window ? usage.inputTokens / window : null;
    for (const target of [this.cache, bucket.cache]) {
      target.requests++;
      target.inputTokens += usage.inputTokens;
      target.cacheReadTokens += usage.cachedInputTokens;
      target.cacheWriteTokens += usage.cacheWriteInputTokens;
      if (usage.cacheWriteInputTokens > 0 && evidence.ttlMinutes === null) target.unknownTtlWriteRequests++;
      if (isBreak) target.breakRequests++;
      if (evidence.reportedReason) target.reportedBreaks++;
      if (heuristics.length) target.heuristicBreaks++;
      if (rate && cost && evidence.requestInputKnown) {
        target.pricedRequests++;
        target.pricedInputTokens += usage.inputTokens;
        const multiplier = rate.longContext && usage.inputTokens > rate.longContext.thresholdInputTokens ? rate.longContext.inputMultiplier : 1;
        const counterfactual = usage.inputTokens * rate.inputPerMillion * multiplier / 1_000_000;
        const actual = cost.inputUsd + cost.cachedInputUsd + cost.cacheWriteUsd;
        target.actualInputUsd += actual;
        target.noCacheInputUsd += counterfactual;
        target.netSavingsUsd += counterfactual - actual;
        target.cacheWriteUsd += cost.cacheWriteUsd;
        if (isBreak) { target.recacheWriteUsd += cost.cacheWriteUsd; target.pricedBreakRequests++; }
      }
    }
    for (const target of [this.context, bucket.context]) {
      target.requests++;
      if (fill !== null) {
        target.eligibleRequests++;
        if (reportedWindow) target.reportedWindowRequests++; else target.reviewedWindowRequests++;
        target.peakFill = Math.max(target.peakFill ?? 0, fill);
        if (fill > 0.4) target.above40++;
        if (fill > 0.6) target.above60++;
        if (fill > 0.8) target.above80++;
      }
    }
    if (fill !== null) this.curve.push({ request: this.context.requests, timestamp: when, executionKind, inputTokens: usage.inputTokens, windowTokens: window!, fill });
  }

  finalize(): SessionLimitsCache {
    const { boundaries: compactions, exact } = reconcileCompactions(this.compactions);
    const curve = sampleContextCurve(this.curve, 240);
    const eligible = this.context.eligibleRequests;
    return { profileKey: this.profileKey,
      cache: { ...this.cache, hitRatio: this.cache.requests >= MIN_REQUESTS && this.cache.inputTokens >= MIN_INPUT_TOKENS ? this.cache.cacheReadTokens / this.cache.inputTokens : null,
        pricingCoverage: this.cache.inputTokens > 0 ? this.cache.pricedInputTokens / this.cache.inputTokens : null },
      context: { ...this.context, shareAbove40: eligible >= MIN_REQUESTS ? this.context.above40 / eligible : null,
        shareAbove60: eligible >= MIN_REQUESTS ? this.context.above60 / eligible : null,
        shareAbove80: eligible >= MIN_REQUESTS ? this.context.above80 / eligible : null, curveSampled: this.curve.length > 240, curve },
      buckets: [...this.buckets.values()].sort((a,b) => (a.day ?? "").localeCompare(b.day ?? "") || a.model.localeCompare(b.model) || a.executionKind.localeCompare(b.executionKind)),
      cacheBreaks: sample(this.breaks, 240), cacheBreaksSampled: this.breaks.length > 240,
      compactions: sample(compactions, 240), compactionCount: compactions.length, compactionCountExact: exact, compactionsSampled: compactions.length > 240 };
  }
}
