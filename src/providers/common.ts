import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CostBreakdown, ModelUsage, ProviderEvidence, SessionAnalytics, SessionProvider, TokenUsage } from "../types.ts";
import type { ProviderContext, ProviderSession } from "./adapter.ts";

export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
export const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
export const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export const hasCounters = (value: RecordValue | null, keys: string[]): boolean => value !== null && keys.some((key) => finite(value[key]) !== null);
export const count = (value: unknown): number => Math.min(Number.MAX_SAFE_INTEGER, Math.floor(finite(value) ?? 0));
export const name = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value) ? value : null;
/** Model namespaces are part of identity, never aliases. Reject filesystem/URL/secret shapes. */
export function modelName(value: unknown): string {
  if (typeof value !== "string" || value.length > 192 || /^(?:sk-|gh[pousr]_|AKIA|Bearer|token[:_-])/i.test(value)) return "<unknown>";
  const parts = value.split("/");
  if (parts.length > 3 || parts.some((part, index) => !(index === 0 && part === "@cf") && !name(part))) return "<unknown>";
  if (parts.some((part) => part === "." || part === ".." || /\.(?:jsonl?|sqlite|db|txt|md|py|tsx?|pem|key)$/i.test(part))) return "<unknown>";
  if (parts.length > 1 && /^(?:Users|home|private|tmp|var|etc|usr|opt|mnt|Volumes|Library|C:|D:)$/i.test(parts[0]!)) return "<unknown>";
  return value;
}
export const effortName = (value: unknown): string | null => typeof value === "string" ? (["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"].includes(value) ? value : "unknown") : null;
export const statusName = (value: unknown): string => typeof value === "string" && ["working", "idle", "completed", "failed", "cancelled", "archived", "queued", "running"].includes(value) ? value : "unknown";
/** Preserve valid legacy timestamp spelling for parity; reject arbitrary suffixes. */
export const safeTime = (value: unknown): string | null => typeof value === "string" && timestamp(value) ? value : null;
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12);
export function timestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)?$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.valueOf() >= 946684800000 ? date.toISOString() : null;
}
export function parse(value: unknown): RecordValue | null {
  if (typeof value !== "string") return null;
  try { return record(JSON.parse(value)); } catch { return null; }
}
export function increment(target: Record<string, number>, key: string, amount = 1): void {
  if (!name(key)) return;
  target[key] = (Object.hasOwn(target, key) ? target[key]! : 0) + amount;
}
export const zeroTokens = (): TokenUsage => ({ inputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, nonReasoningOutputTokens: 0 });
export const zeroCost = (): CostBreakdown => ({ inputUsd: 0, cachedInputUsd: 0, cacheWriteUsd: 0, outputUsd: 0, totalUsd: 0, upperEstimateUsd: 0 });
export function sum<T extends object>(target: T, source: T): void {
  for (const key of Object.keys(target) as Array<keyof T>) {
    if (typeof target[key] === "number" && typeof source[key] === "number") (target[key] as number) += source[key] as number;
  }
}

/** Input classes are disjoint; reasoning is a subset of total output. */
export function tokens(input: unknown, cached: unknown, writes: unknown, output: unknown, reasoning: unknown = 0, inclusiveInput = false): TokenUsage {
  const read = count(cached), write = count(writes), out = count(output);
  const uncached = inclusiveInput ? Math.max(0, count(input) - read - write) : count(input);
  const thinking = Math.min(out, count(reasoning));
  return { ...zeroTokens(), inputTokens: uncached + read + write, uncachedInputTokens: uncached, cachedInputTokens: read, cacheWriteInputTokens: write, outputTokens: out, reasoningOutputTokens: thinking, nonReasoningOutputTokens: out - thinking };
}

/** Bounded directory traversal; never follow source-controlled symbolic links. */
export async function* files(root: string, accepts: (file: string) => boolean, depth = 0): AsyncGenerator<string> {
  if (depth > 8) return;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Provider evidence directory could not be read.");
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path, accepts, depth + 1);
    else if (entry.isFile() && accepts(path)) yield path;
  }
}

export async function readJson(path: string): Promise<RecordValue | null> {
  try {
    // Generic file allowance; memory-sensitive adapters impose a smaller source-specific budget.
    if ((await stat(path)).size > 32 * 1024 * 1024) return null;
    return parse(await readFile(path, "utf8"));
  } catch { return null; }
}

/** Null means a malformed/truncated line; raw parse errors never leave the reader. */
export async function* jsonLines(path: string, maxLineLength = 16 * 1024 * 1024): AsyncGenerator<RecordValue | null> {
  const input = createReadStream(path, { encoding: "utf8" });
  let parts: string[] = [], length = 0, oversized = false;
  try {
    for await (const raw of input) {
      const chunk = String(raw);
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf("\n", start), end = newline < 0 ? chunk.length : newline;
        const piece = chunk.slice(start, end);
        if (!oversized) {
          length += piece.length;
          if (length > maxLineLength) { oversized = true; parts = []; }
          else parts.push(piece);
        }
        if (newline < 0) break;
        if (oversized) yield null;
        else { const line = parts.join(""); if (line.trim()) yield parse(line); }
        parts = []; length = 0; oversized = false; start = newline + 1;
      }
    }
    if (oversized) yield null;
    else { const line = parts.join(""); if (line.trim()) yield parse(line); }
  } finally { input.destroy(); }
}

export function emptySession(identity: ProviderSession, provider: SessionProvider, context: ProviderContext, evidence: ProviderEvidence): SessionAnalytics {
  return {
    cost: zeroCost(), costBasis: "unavailable", costByExecution: { subagentUsd: 0, topLevelUsd: 0, unknownUsd: 0 },
    costComplete: false, createdAt: identity.createdAt, updatedAt: identity.updatedAt, effort: null, executionKind: "unknown",
    firstEventAt: null, lastEventAt: null,
    metrics: { assistantMessages: 0, compactions: 0, contextUtilizationPeak: null, delegatedAgents: 0, durationMilliseconds: 0, eventSpanMilliseconds: 0, maxContextWindow: 0, maxInputTokensPerCall: 0, modelCalls: 0, queueOperations: 0, summaries: 0, taskCompletions: 0, taskStarts: 0, toolCalls: 0, transportToolCalls: 0, userTurns: 0 },
    models: [], pricedTokenCoverage: null, provider, repositoryId: context.repository.id, repositoryName: context.repository.name,
    sessionKey: hash(`${provider}:${identity.id}`), skillEvidence: "unavailable", skills: {}, spendByDay: {}, status: "unknown",
    tokens: zeroTokens(), tools: {}, transportTools: {}, transcript: { files: 1, snapshotWhileWorking: false, status: "ok", warnings: [] }, evidence,
  };
}

export function observeTime(session: SessionAnalytics, value: unknown): void {
  const at = timestamp(value);
  if (!at) return;
  if (!session.firstEventAt || at < session.firstEventAt) session.firstEventAt = at;
  if (!session.lastEventAt || at > session.lastEventAt) session.lastEventAt = at;
}

export function addUsage(session: SessionAnalytics, context: ProviderContext, model: string, usage: TokenUsage, at: string | null, scope: "request" | "summary", calls = 1): void {
  sum(session.tokens, usage);
  if (!usage.inputTokens && !usage.outputTokens) return;
  const rate = Object.hasOwn(context.rateCard.models, model) ? context.rateCard.models[model] : undefined;
  let aggregate = session.models.find((item) => item.model === model);
  if (!aggregate) {
    aggregate = { ...zeroTokens(), ...zeroCost(), model, calls: 0, priced: Boolean(rate) };
    session.models.push(aggregate);
  }
  sum(aggregate as TokenUsage, usage);
  aggregate.calls += calls;
  session.metrics.modelCalls += calls;
  if (scope === "request") session.metrics.maxInputTokensPerCall = Math.max(session.metrics.maxInputTokensPerCall, usage.inputTokens);
  if (!rate) return;
  const cost = context.price(rate, usage, scope === "request" ? usage.inputTokens : 0);
  if (scope === "summary" && rate.longContext) {
    // Request sizes are absent: ordinary rates are a lower estimate, all-premium rates a ceiling.
    cost.upperEstimateUsd = Math.max(cost.upperEstimateUsd, context.price(rate, usage, rate.longContext.thresholdInputTokens + 1).upperEstimateUsd);
    session.transcript.warnings.push("Aggregate usage has no per-request context sizes; the upper estimate applies the long-context premium to all usage.");
  }
  if (usage.cacheWriteInputTokens > 0 && usage.cacheWrite5mInputTokens + usage.cacheWrite1hInputTokens === 0) {
    const longInput = scope === "summary" && rate.longContext ? rate.longContext.thresholdInputTokens + 1 : usage.inputTokens;
    const oneHour = { ...usage, cacheWrite1hInputTokens: usage.cacheWriteInputTokens };
    cost.upperEstimateUsd = Math.max(cost.upperEstimateUsd, context.price(rate, oneHour, longInput).upperEstimateUsd);
    session.transcript.warnings.push("Cache-write TTL is unavailable; the ordinary estimate uses the default write rate and the upper estimate allows the configured one-hour write rate.");
  }
  sum(aggregate as CostBreakdown, cost); sum(session.cost, cost);
  session.costBasis = "api-list-price-equivalent";
  if (scope === "request" && at) increment(session.spendByDay, at.slice(0, 10), cost.totalUsd);
}

export function finish(session: SessionAnalytics): SessionAnalytics {
  session.metrics.toolCalls = Object.values(session.tools).reduce((a, b) => a + b, 0);
  session.transportTools = { ...session.tools };
  session.metrics.transportToolCalls = session.metrics.toolCalls;
  if (session.firstEventAt && session.lastEventAt) session.metrics.eventSpanMilliseconds = Math.max(0, Date.parse(session.lastEventAt) - Date.parse(session.firstEventAt));
  if (session.evidence?.timing !== "file-mtime") session.metrics.durationMilliseconds = Math.max(0, Date.parse(session.updatedAt) - Date.parse(session.createdAt));
  if (session.costBasis !== "provider-reported") {
    const total = session.tokens.inputTokens + session.tokens.outputTokens;
    const priced = session.models.filter((m) => m.priced).reduce((a, m) => a + m.inputTokens + m.outputTokens, 0);
    session.pricedTokenCoverage = total ? priced / total : null;
    session.costComplete = total > 0 && priced === total;
  }
  const kind = session.executionKind === "top-level" ? "topLevelUsd" : session.executionKind === "subagent" ? "subagentUsd" : "unknownUsd";
  session.costByExecution[kind] = session.cost.totalUsd;
  session.models.sort((a, b) => b.totalUsd - a.totalUsd || a.model.localeCompare(b.model));
  session.transcript.warnings = [...new Set(session.transcript.warnings)];
  return session;
}

export function reportedModel(model: string, usage: TokenUsage, value: number): ModelUsage {
  return { ...usage, ...zeroCost(), model, calls: 0, priced: true, totalUsd: value, upperEstimateUsd: value };
}
