import type { TokenUsage } from "../types.ts";
import type { ConductorMessage } from "./conductor-messages.ts";
import { replacesClaudeUsage } from "./claude-usage.ts";
import { sum, zeroTokens } from "./common.ts";

export interface ConductorQueryReceipt { id: string; usage: TokenUsage | null }
export interface ConductorOutputSupplement {
  model: string;
  usage: TokenUsage;
  day: string | null;
  /** An hour is known only when every contributing request shares it. */
  at: string | null;
}

/** Result.usage is query-local main-loop usage. modelUsage and total_cost_usd
 * are cumulative and deliberately never enter this calculation (VC-001).
 * Exact physical input agreement proves the retained query's scope; neither a
 * new init nor a falling cumulative counter proves an independent interval. */
export function conductorOutputSupplements(messages: ConductorMessage[], receipts: ConductorQueryReceipt[]): ConductorOutputSupplement[] {
  const queries = new Map<string, ConductorMessage[]>();
  const identityQueries = new Map<string, Set<string>>();
  for (const message of messages) {
    if (!message.queryId || message.executionKind !== "top-level") continue;
    const group = queries.get(message.queryId) ?? [];
    group.push(message); queries.set(message.queryId, group);
    for (const identity of [message.recordId, ...(message.identityKnown ? [message.id] : [])]) {
      const ids = identityQueries.get(identity) ?? new Set<string>();
      ids.add(message.queryId); identityQueries.set(identity, ids);
    }
  }
  const supplements: ConductorOutputSupplement[] = [];
  const seen = new Set<string>();
  for (const receipt of receipts) {
    if (seen.has(receipt.id)) continue;
    seen.add(receipt.id);
    const source = queries.get(receipt.id), target = receipt.usage;
    if (!source?.length || !target || !target.inputTokens) continue;
    // Replayed identified responses cannot establish a second query interval.
    if (source.some(m => !m.usageObserved || identityQueries.get(m.recordId)!.size > 1 || (m.identityKnown && identityQueries.get(m.id)!.size > 1))) continue;
    const records = new Map<string, ConductorMessage>();
    for (const m of source) if (replacesClaudeUsage(records.get(m.recordId), m)) records.set(m.recordId, m);
    const aliases = new Map(source.filter(m => m.identityKnown).map(m => [m.recordId, m.id]));
    const requests = new Map<string, ConductorMessage>();
    for (const m of records.values()) {
      const id = aliases.get(m.recordId) ?? m.id;
      if (replacesClaudeUsage(requests.get(id), m)) requests.set(id, { ...m, id, identityKnown: m.identityKnown || aliases.has(m.recordId) });
    }
    // A partially stripped representation could alias an identified request.
    // Reject that ambiguity instead of manufacturing an exact input match.
    const knownInputs = new Set([...requests.values()].filter(m => m.identityKnown).map(m => m.inputKey));
    if ([...requests.values()].some(m => !m.identityKnown && knownInputs.has(m.inputKey))) continue;
    const models = new Set([...requests.values()].map(m => m.model));
    if (models.size !== 1 || models.has("<unknown>")) continue;
    const observed = zeroTokens();
    for (const m of requests.values()) sum(observed, m.usage);
    if (!["uncachedInputTokens", "cachedInputTokens", "cacheWriteInputTokens"].every(k => observed[k as keyof TokenUsage] === target[k as keyof TokenUsage])) continue;
    const output = target.outputTokens - observed.outputTokens;
    if (output <= 0) continue;
    const dates = [...requests.values()].map(m => m.at);
    const days = new Set(dates.map(at => at?.slice(0, 10) ?? null));
    const hours = new Set(dates.map(at => at?.slice(0, 13) ?? null));
    // Receipt totals expose no reasoning split. They add no request count and
    // no input/cache tokens. Cross-day/hour allocations remain unavailable.
    supplements.push({ model: [...models][0]!, usage: { ...zeroTokens(), outputTokens: output },
      day: days.size === 1 ? [...days][0]! : null,
      at: hours.size === 1 && !hours.has(null) ? dates.find(at => at !== null)! : null });
  }
  return supplements;
}
