import { conductorRecords } from "./conductor-records.ts";
import { applyConductorReceiptFloor, conductorMessage, recoverConductorMessages, type ConductorMessage } from "./conductor-messages.ts";
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import type { ConductorResultMetrics, ConductorTerminalReason, ModelUsage, SessionAnalytics, SessionDatabaseRow, SessionProvider, TokenUsage } from "../types.ts";
import type { ProviderContext } from "./adapter.ts";
import { count, emptySession, finite, finish, hash, hasCounters, modelName, parse, record, reportedModel, statusName, sum, text, timestamp, tokens, zeroTokens } from "./common.ts";

const reasons = new Set<ConductorTerminalReason>(["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries", "completed", "cancelled", "interrupted"]);
interface Receipt {
  id: string; providerId: string | null; at: string; epoch: string | null; version: "old" | "restored" | null;
  cost: number | null; marginalCost: number | null; usage: TokenUsage; usageObserved: boolean; localUsage: TokenUsage | null; models: ModelUsage[];
  turns: number | null; duration: number | null; apiDuration: number | null; denials: number | null;
  error: boolean; reason: ConductorTerminalReason;
}
interface Group { provider: SessionProvider; rows: Map<string, SessionDatabaseRow>; receipts: Map<string, Receipt>; messages: Buffer[] }
function versionScope(value: unknown): Receipt["version"] {
  const match = typeof value === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(value) : null;
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major !== 2 || minor !== 1) return null; // Other versions need primary-source verification.
  return patch! < 277 ? "old" : "restored";
}
function localTokens(usage: Record<string, unknown> | null): TokenUsage | null {
  if (!hasCounters(usage, ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])) return null;
  const value = tokens(usage?.["input_tokens"], usage?.["cache_read_input_tokens"], usage?.["cache_creation_input_tokens"], usage?.["output_tokens"]);
  const cache = record(usage?.["cache_creation"]);
  value.cacheWrite1hInputTokens = Math.min(value.cacheWriteInputTokens, count(cache?.["ephemeral_1h_input_tokens"]));
  value.cacheWrite5mInputTokens = Math.min(value.cacheWriteInputTokens - value.cacheWrite1hInputTokens, count(cache?.["ephemeral_5m_input_tokens"]));
  return value;
}
function project(result: Record<string, unknown>, id: string, at: string, epoch: string | null, version: Receipt["version"]): Receipt | null {
  const cost = finite(result["total_cost_usd"]), usage = record(result["usage"]), modelUsage = record(result["modelUsage"]);
  if (cost === null && !usage && !modelUsage) return null;
  const models: ModelUsage[] = [], total = zeroTokens(); let observed = false;
  for (const [rawModel, rawUsage] of Object.entries(modelUsage ?? {})) {
    const u = record(rawUsage); if (!u) continue;
    observed ||= hasCounters(u, ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]);
    const modelTokens = tokens(u["inputTokens"], u["cacheReadInputTokens"], u["cacheCreationInputTokens"], u["outputTokens"]);
    sum(total, modelTokens);
    const canonicalModel = rawModel.replace(/^(claude-[a-z0-9.-]+)\[1m\]$/, "$1");
    const model = reportedModel(modelName(canonicalModel), modelTokens, finite(u["costUSD"]) ?? 0);
    model.priced = finite(u["costUSD"]) !== null; models.push(model);
  }
  const reason = text(result["terminal_reason"]) ?? text(result["subtype"]);
  return { id, providerId: text(result["session_id"]), at, epoch, version, cost, marginalCost: finite(record(result["conductor_sdk_metadata"])?.["marginalCostUsd"]), usage: total, usageObserved: observed, models,
    localUsage: localTokens(usage),
    turns: finite(result["num_turns"]), duration: finite(result["duration_ms"]), apiDuration: finite(result["duration_api_ms"]),
    denials: finite(result["permission_denials_count"]), error: result["is_error"] === true || result["is_error"] === 1,
    reason: reasons.has(reason as ConductorTerminalReason) ? reason as ConductorTerminalReason : "unknown" };
}
const zeroCrash = (r: Receipt): boolean => r.reason === "error_during_execution" && !r.cost && r.usage.inputTokens + r.usage.outputTokens === 0;
function dominates(a: Receipt, b: Receipt): boolean {
  if (b.cost !== null && (a.cost === null || a.cost < b.cost)) return false;
  if (b.usageObserved && !a.usageObserved) return false;
  return (Object.keys(b.usage) as Array<keyof TokenUsage>).every((key) => a.usage[key] >= b.usage[key]);
}
/** A result UUID is a receipt, not an accounting interval. Never infer resets from decreases. */
function selectSnapshots(receipts: Receipt[]): { snapshots: Receipt[]; complete: boolean } {
  const valid = receipts.filter((r) => !zeroCrash(r));
  if (!valid.length) return { snapshots: [], complete: false };
  // SDK init is emitted on each query, so it cannot identify disjoint processes.
  let complete = valid.length === receipts.length && receipts.length === 1;
  const snapshots: Receipt[] = [];
  const ordered = valid.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const last = ordered.at(-1)!;
  if (ordered.every((r) => dominates(last, r))) snapshots.push(last);
  else {
    // Conflicting/reset/unknown-version histories: retain one observed lower bound, never add overlap.
    complete = false;
    snapshots.push([...ordered].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.usage.inputTokens - a.usage.inputTokens || b.at.localeCompare(a.at))[0]!);
  }
  return { snapshots, complete };
}

/** Collect all eligible rows before grouping. Canonical identities are read-only native precedence. */
export function conductorFallback(database: DatabaseSync | null, rows: SessionDatabaseRow[], canonicalIdentities: ReadonlySet<string>, pricing: Pick<ProviderContext, "rateCard" | "resolveRate" | "price">, onPaired?: (session: SessionAnalytics) => void): SessionAnalytics[] {
  if (!database) return [];
  const statement = conductorRecords(database);
  if (!statement) return [];
  const groups = new Map<string, Group>();
  for (const row of rows) {
    // The verified SDK result accounting contract is Claude's; other SDK envelopes are not interchangeable.
    if (row.agent_type !== "claude") continue;
    const receipts: Receipt[] = [], messages: ConductorMessage[] = [], resets: Array<[string, string]> = [], seenInit = new Set<string>();
    let epoch: string | null = null, version: Receipt["version"] = null, queryStart = 0;
    const queryReceipts = new Set<string>();
    for (const item of statement.iterate(row.conductor_session_id)) {
      const data = parse(item["data"]); if (!data) continue;
      const id = text(data["uuid"]) ?? `message:${String(item["id"])}`;
      if (data["type"] === "system" && data["subtype"] === "init" && !seenInit.has(id)) {
        seenInit.add(id); epoch = id; version = versionScope(data["claude_code_version"]); continue;
      }
      if (data["type"] === "conversation_reset") {
        const before = text(data["session_id"]), after = text(data["new_conversation_id"]);
        if (before && after) resets.push([before, after]);
        continue;
      }
      if (data["type"] === "assistant") {
        // A bare object with usage counters is not a verified SDK envelope.
        if (text(data["session_id"]) || text(record(data["message"])?.["id"]) || text(data["uuid"]) || text(item["sdk_message_id"])) messages.push(conductorMessage(data, item));
        continue;
      }
      if (data["type"] !== "result") continue;
      const receipt = project(data, id, timestamp(item["created_at"]) ?? timestamp(row.created_at) ?? "", epoch, version);
      if (receipt) {
        receipts.push(receipt);
        if (!queryReceipts.has(id)) {
          for (let i = queryStart; i < messages.length; i++) messages[i]!.queryId = id;
          queryStart = messages.length; queryReceipts.add(id);
        }
      }
    }
    const accepted = new Set(row.provider_session_id ? [row.provider_session_id] : []);
    // Explicit reset links can connect receipts before/after the currently registered identity.
    for (let i = 0; i < resets.length; i++) for (const [a, b] of resets) if (accepted.has(a) || accepted.has(b)) { accepted.add(a); accepted.add(b); }
    const messageGroups = new Map<string, ConductorMessage[]>();
    for (const receipt of [...receipts, ...messages]) {
      if (receipt.providerId && row.provider_session_id && !accepted.has(receipt.providerId)) continue;
      const identity = receipt.providerId ?? row.provider_session_id;
      const key = `claude:${identity ?? `row:${row.conductor_session_id}`}`;
      if (canonicalIdentities.has(key) && !onPaired) continue;
      const group: Group = groups.get(key) ?? { provider: "claude", rows: new Map(), receipts: new Map(), messages: [] };
      group.rows.set(row.conductor_session_id, row);
      if ("usageObserved" in receipt && "identityKnown" in receipt) {
        const chunk = messageGroups.get(key) ?? [];
        chunk.push(receipt); messageGroups.set(key, chunk); groups.set(key, group); continue;
      }
      const previous = group.receipts.get(receipt.id);
      // A copied receipt keeps its original chronological position.
      if (!previous || receipt.at < previous.at) group.receipts.set(receipt.id, receipt);
      groups.set(key, group);
    }
    // Only allowlisted projections are compressed, in memory. Keeping every
    // group's expanded messages alongside the native snapshot exhausts the
    // worker heap before the first recovered group can be emitted.
    for (const [key, chunk] of messageGroups) groups.get(key)!.messages.push(deflateRawSync(JSON.stringify(chunk), { level: 1 }));
  }
  const sessions: SessionAnalytics[] = [];
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const group = groups.get(key)!;
    groups.delete(key);
    const rows = [...group.rows.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.conductor_session_id.localeCompare(b.conductor_session_id));
    const row = rows.at(-1)!, createdAt = rows.map((r) => timestamp(r.created_at)).filter((v): v is string => !!v).sort()[0], updatedAt = rows.map((r) => timestamp(r.updated_at)).filter((v): v is string => !!v).sort().at(-1);
    if (!createdAt || !updatedAt) continue;
    const conflict = new Set(rows.map((r) => r.repository_id)).size > 1;
    const repository = conflict ? { id: `discovered-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`, name: "Conductor · unassigned" } : { id: row.repository_id, name: row.repository_name };
    const receipts = [...group.receipts.values()], { snapshots, complete } = selectSnapshots(receipts);
    const session = emptySession({ id: key, path: "", cwd: null, createdAt, updatedAt }, group.provider, { repository, ...pricing }, {
      source: "conductor-result", fidelity: "summary", tokens: "unavailable", tools: "unavailable", turns: "unavailable", timing: "provider", usageUnit: "session", accounting: complete ? "complete" : "partial",
    });
    const registeredOwners = rows.filter((r) => r.provider_session_id && key === `claude:${r.provider_session_id}`);
    session.sessionKey = registeredOwners.length === 1 ? hash(registeredOwners[0]!.conductor_session_id) : hash(key);
    session.transcript.files = 0; session.status = statusName(row.status); session.transcript.snapshotWhileWorking = session.status === "working";
    const only = receipts.length === 1 ? receipts[0]! : null;
    const metrics: ConductorResultMetrics = { resultRecords: receipts.length, reportedTurns: only?.turns ?? null, durationMilliseconds: only?.duration ?? null, apiDurationMilliseconds: only?.apiDuration ?? null, permissionDenials: only?.denials ?? null, errorResults: 0, terminalReasons: {}, turnLocalTokens: null };
    for (const receipt of receipts) {
      if (receipt.localUsage) { metrics.turnLocalTokens ??= zeroTokens(); sum(metrics.turnLocalTokens, receipt.localUsage); }
      metrics.errorResults += Number(receipt.error); metrics.terminalReasons[receipt.reason] = (metrics.terminalReasons[receipt.reason] ?? 0) + 1;
    }
    const models = new Map<string, ModelUsage>(); let costSnapshots = 0, allocationsComplete = true;
    for (const result of snapshots) {
      if (result.usageObserved) { sum(session.tokens, result.usage); session.evidence!.tokens = "reported"; }
      // A single receipt's turn-local usage is useful when no cumulative tokens exist.
      else if (only?.localUsage) { sum(session.tokens, only.localUsage); session.evidence!.tokens = "reported"; }
      const cost = result.cost ?? (result.models.some((m) => m.priced) ? result.models.reduce((n, m) => n + m.totalUsd, 0) : null);
      if (cost !== null) { session.cost.totalUsd += cost; costSnapshots++; }
      if (result.cost === null && result.models.some((model) => !model.priced)) allocationsComplete = false;
      for (const source of result.models) {
        const target = models.get(source.model) ?? reportedModel(source.model, zeroTokens(), 0);
        sum(target, source); target.priced &&= source.priced; models.set(source.model, target);
      }
    }
    // Marginal metadata is usable only with explicit process-scoped SDK evidence.
    // Restored SDK versions retain lifetime totals while Conductor can reset its
    // marginal tracker: trusting that field there repeats previously counted cost.
    const marginalReceipts = receipts.filter((r) => r.version === "old" && r.marginalCost !== null && r.marginalCost >= 0);
    const marginalComplete = marginalReceipts.length > 0 && receipts.every((r) => !zeroCrash(r) && (r.cost === 0 || (r.version === "old" && r.marginalCost !== null && r.marginalCost >= 0)));
    const marginalTotal = marginalReceipts.reduce((n, r) => n + r.marginalCost!, 0);
    if (marginalReceipts.length) {
      session.cost.totalUsd = marginalComplete ? marginalTotal : Math.max(session.cost.totalUsd, marginalTotal);
      costSnapshots = Math.max(costSnapshots, 1);
    }
    if (receipts.length > 1 && !snapshots.some((result) => result.usageObserved) && metrics.turnLocalTokens && metrics.turnLocalTokens.inputTokens + metrics.turnLocalTokens.outputTokens > 0) {
      sum(session.tokens, metrics.turnLocalTokens);
      session.evidence!.tokens = "reported";
      session.evidence!.accounting = "partial";
      session.transcript.warnings.push("Token totals retain the observed main-loop lower bound from deduplicated turn receipts; sub-agent usage is unavailable.");
    }
    // Retain the unallocated balance as unknown; metadata-only names prove no allocation.
    const allocatedTokens = zeroTokens(); let allocatedUsd = 0;
    for (const model of models.values()) { sum(allocatedTokens, model); allocatedUsd += model.totalUsd; }
    const residualTokens = zeroTokens();
    const fields = Object.keys(residualTokens) as Array<keyof TokenUsage>;
    if (fields.every((field) => allocatedTokens[field] <= session.tokens[field])) {
      for (const field of fields) residualTokens[field] = session.tokens[field] - allocatedTokens[field];
    }
    const residualUsd = Math.max(0, session.cost.totalUsd - allocatedUsd);
    if (residualUsd > 0.000001 || residualTokens.inputTokens || residualTokens.outputTokens) {
      const unallocated = models.get("<unknown>") ?? reportedModel("<unknown>", zeroTokens(), 0);
      const residual = reportedModel("<unknown>", residualTokens, residualUsd); residual.calls = 0;
      sum(unallocated, residual); models.set("<unknown>", unallocated);
      session.transcript.warnings.push("Some reported tokens or value have no model allocation; they remain in the unknown model bucket.");
    }
    session.models = [...models.values()]; if (costSnapshots) session.costBasis = "provider-reported";
    session.cost.upperEstimateUsd = session.cost.totalUsd; session.conductor = metrics;
    session.transcript.warnings.push("Recovered from Conductor result receipts. Tools, human turns, model request counts, and daily cost attribution are unavailable. Reported value is not an invoice.");
    if (!complete) session.transcript.warnings.push("Accounting is partial: retained receipts do not prove disjoint process epochs or complete resumed history. Ambiguous cumulative snapshots are not added; zeroed crash results cannot erase earlier evidence.");
    if (receipts.length > 1) session.transcript.warnings.push("Turn-local usage is separate from cumulative model usage. SDK turns, durations, and denial totals are unavailable across multiple receipts because their scopes are not established.");
    if (conflict) session.transcript.warnings.push("Conductor rows disagree on repository attribution; the recovered identity is grouped as unassigned.");
    if (session.models.some((model) => model.priced) && Math.abs(session.models.reduce((n, m) => n + m.totalUsd, 0) - session.cost.totalUsd) > 0.000001) session.transcript.warnings.push("Reported model allocations differ from the reported total; the SDK result total remains authoritative.");
    if (!allocationsComplete && !marginalComplete) {
      session.evidence!.accounting = "partial";
      session.transcript.warnings.push("Reported model allocations are incomplete; recovered value is an observed lower bound.");
    }
    const finalized = finish(session); finalized.pricedTokenCoverage = null; finalized.costComplete = session.evidence!.accounting === "complete" && (marginalComplete || (complete && allocationsComplete && snapshots.length > 0 && costSnapshots === snapshots.length));
    const messages = group.messages.flatMap((chunk) => JSON.parse(inflateRawSync(chunk).toString("utf8")) as ConductorMessage[]);
    const recovered = recoverConductorMessages(finalized, messages, pricing, receipts.map(r => ({ id: r.id, usage: r.localUsage })));
    const selected = recovered ? applyConductorReceiptFloor(finalized, recovered) : receipts.length ? finalized : null;
    if (selected) {
      if (canonicalIdentities.has(key)) onPaired?.(selected);
      else sessions.push(selected);
    }
  }
  return sessions;
}

/** Explicit result identities constrain legacy timestamp matching without exposing content. */
export function conductorLegacyProviderIds(database: DatabaseSync | null, rows: SessionDatabaseRow[]): Map<string, Set<string>> {
  const identities = new Map<string, Set<string>>();
  if (!database || !rows.length) return identities;
  const statement = conductorRecords(database);
  if (!statement) return identities;
  for (const row of rows) for (const item of statement.iterate(row.conductor_session_id)) {
    const data = parse(item["data"]), identity = text(data?.["session_id"]);
    if (data?.["type"] !== "result" || !identity) continue;
    const values = identities.get(row.conductor_session_id) ?? new Set<string>();
    values.add(identity); identities.set(row.conductor_session_id, values);
  }
  return identities;
}
