import { conductorRecords, conductorSignature } from "./conductor-records.ts";
import { IndexParityError } from "../store/parity.ts";
import { applyConductorReceiptFloor, conductorMessage, recoverConductorMessages, type ConductorMessage } from "./conductor-messages.ts";
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { ConductorResultMetrics, ConductorTerminalReason, ModelUsage, SessionAnalytics, SessionDatabaseRow, SessionProvider, SessionVelocity, TokenUsage } from "../types.ts";
import { VelocityAccumulator, addSessionDated, usageVelocity, velocityDimension, zeroVelocity } from "../metrics/velocity.ts";
import type { ProviderContext } from "./adapter.ts";
import { count, emptySession, finite, finish, hash, hasCounters, modelName, parse, record, reportedModel, statusName, sum, text, timestamp, tokens, zeroTokens } from "./common.ts";

const reasons = new Set<ConductorTerminalReason>(["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries", "completed", "cancelled", "interrupted"]);
export interface Receipt {
  id: string; providerId: string | null; at: string; epoch: string | null; version: "old" | "restored" | null;
  cost: number | null; marginalCost: number | null; usage: TokenUsage; usageObserved: boolean; localUsage: TokenUsage | null; models: ModelUsage[];
  turns: number | null; duration: number | null; apiDuration: number | null; denials: number | null;
  error: boolean; reason: ConductorTerminalReason;
}
interface Group { provider: SessionProvider; identity: string | null; rows: Map<string, SessionDatabaseRow>; receipts: Map<string, Receipt>; messages: Buffer[] }
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
function selectSnapshots(receipts: Receipt[], order: (id: string) => string): { snapshots: Receipt[]; complete: boolean } {
  const valid = receipts.filter((r) => !zeroCrash(r));
  if (!valid.length) return { snapshots: [], complete: false };
  // SDK init is emitted on each query, so it cannot identify disjoint processes.
  let complete = valid.length === receipts.length && receipts.length === 1;
  const snapshots: Receipt[] = [];
  const ordered = valid.sort((a, b) => a.at.localeCompare(b.at) || (a.id === b.id ? 0 : order(a.id).localeCompare(order(b.id))));
  const last = ordered.at(-1)!;
  if (ordered.every((r) => dominates(last, r))) snapshots.push(last);
  else {
    // Conflicting/reset/unknown-version histories: retain one observed lower bound, never add overlap.
    complete = false;
    snapshots.push([...ordered].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.usage.inputTokens - a.usage.inputTokens || b.at.localeCompare(a.at))[0]!);
  }
  return { snapshots, complete };
}

/** One Conductor session's projected records. With a private index, every identifier is a keyed hash. */
export interface ConductorRowRecords { receipts: Receipt[]; messages: ConductorMessage[]; resets: Array<[string, string]> }
/** The private index replays unchanged Conductor sessions' projections instead of re-extracting them. */
export interface ConductorRecordCache {
  key(value: string): string;
  records(conductorSessionId: string, signature: () => unknown, read: () => ConductorRowRecords): ConductorRowRecords;
}

function readConductorRow(statement: StatementSync, row: SessionDatabaseRow): ConductorRowRecords {
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
  return { receipts, messages, resets };
}

/** Identifiers are only compared for equality, so a keyed hash preserves every relation. */
function privateRecords(records: ConductorRowRecords, key: (value: string) => string): ConductorRowRecords {
  const known = new Map<string, string>();
  const k = (value: string): string => { let hashed = known.get(value); if (hashed === undefined) { hashed = key(value); known.set(value, hashed); } return hashed; };
  const nullable = (value: string | null): string | null => value === null ? null : k(value);
  return {
    receipts: records.receipts.map((receipt) => ({ ...receipt, id: k(receipt.id), providerId: nullable(receipt.providerId), epoch: nullable(receipt.epoch) })),
    messages: records.messages.map((message) => ({ ...message, ...(message.queryId === undefined ? {} : { queryId: k(message.queryId) }),
      id: k(message.id), recordId: k(message.recordId), inputKey: k(message.inputKey), providerId: nullable(message.providerId),
      tools: message.tools.map((tool) => ({ id: k(tool.id), name: tool.name })) })),
    resets: records.resets.map(([before, after]) => [k(before), k(after)]),
  };
}

/** A receipt total is cumulative over the retained session, so it has no request or turn dates. It is
 * one session-dated observation at the selected receipt's time (the last evidenced point), split by model
 * only when the reported allocations reconcile exactly with the session total. A receipt floor keeps the
 * same rule: its recovered tokens, calls and tools are session-dated with the value they belong to. */
function receiptVelocity(session: SessionAnalytics, at: string | null): SessionVelocity {
  const dimension = (model: string) => velocityDimension("claude", { claudeEntrypoint: "sdk" }, session.executionKind, model, null);
  const reported = session.costBasis === "provider-reported";
  const allocated = zeroTokens(); let allocatedUsd = 0;
  for (const model of session.models) { sum(allocated, model); allocatedUsd += model.totalUsd; }
  const reconciles = session.models.length > 0 && Math.abs(allocatedUsd - session.cost.totalUsd) <= 1e-6 &&
    (Object.keys(allocated) as Array<keyof TokenUsage>).every((key) => allocated[key] === session.tokens[key]);
  const parts: Array<[string, TokenUsage, number, number]> = reconciles && session.models.reduce((n, model) => n + model.calls, 0) === session.metrics.modelCalls
    ? session.models.map((model) => [model.model, model, model.totalUsd, model.calls])
    : [["<unknown>", session.tokens, session.cost.totalUsd, session.metrics.modelCalls]];
  let velocity = new VelocityAccumulator().finish(session.createdAt, dimension("<unknown>"));
  const sessionAt = at || session.updatedAt;
  for (const [model, usage, value, calls] of parts) {
    if (value <= 0 && calls === 0 && usage.inputTokens + usage.outputTokens === 0) continue;
    // Reported receipt value covers its reported tokens; no reasoning split is recorded.
    const values = usageVelocity(usage, value, reported ? usage.inputTokens + usage.outputTokens : 0, { reasoning: false, cacheRead: true, cacheWrite: true }, calls);
    velocity = addSessionDated(velocity, sessionAt, dimension(model), values);
  }
  if (session.metrics.toolCalls) {
    const values = zeroVelocity(); values[8] = session.metrics.toolCalls;
    velocity = addSessionDated(velocity, sessionAt, dimension("<unknown>"), values);
  }
  return velocity;
}

/** Collect all eligible rows before grouping. Canonical identities are read-only native precedence. */
export function conductorFallback(database: DatabaseSync | null, rows: SessionDatabaseRow[], canonicalIdentities: ReadonlySet<string>, pricing: Pick<ProviderContext, "rateCard" | "resolveRate" | "price">, onPaired?: (session: SessionAnalytics) => void, cache?: ConductorRecordCache | null): SessionAnalytics[] {
  if (!database) return [];
  const statement = conductorRecords(database);
  if (!statement) return [];
  const signature = cache ? conductorSignature(database) : null;
  const key = cache ? (value: string) => cache.key(value) : (value: string) => value;
  // Raw identities order groups and break receipt-time ties. Keyed values resolve
  // only to raw ones already present in memory; nothing raw is read from the index.
  const raw = new Map<string, string>();
  const learn = (value: string | null | undefined): void => { if (cache && value != null) raw.set(key(value), value); };
  const resolve = (value: string): string | undefined => cache ? raw.get(value) : value;
  const live = (row: SessionDatabaseRow): ConductorRowRecords => {
    const records = readConductorRow(statement, row);
    if (!cache) return records;
    for (const receipt of records.receipts) { learn(receipt.id); learn(receipt.providerId); }
    for (const message of records.messages) learn(message.providerId);
    for (const [before, after] of records.resets) { learn(before); learn(after); }
    return privateRecords(records, key);
  };
  let canonicalKeys = canonicalIdentities;
  if (cache) {
    for (const row of rows) learn(row.provider_session_id);
    for (const identity of canonicalIdentities) if (identity.startsWith("claude:")) learn(identity.slice(7));
    canonicalKeys = new Set([...canonicalIdentities].map((identity) => identity.startsWith("claude:") ? `claude:${key(identity.slice(7))}` : identity));
  }
  const groups = new Map<string, Group>();
  for (const row of rows) {
    // The verified SDK result accounting contract is Claude's; other SDK envelopes are not interchangeable.
    if (row.agent_type !== "claude") continue;
    const { receipts, messages, resets } = cache && signature
      ? cache.records(row.conductor_session_id, () => [signature(row.conductor_session_id), row.created_at], () => live(row))
      : live(row);
    const own = row.provider_session_id == null ? null : key(row.provider_session_id);
    const accepted = new Set(row.provider_session_id ? [own!] : []);
    // Explicit reset links can connect receipts before/after the currently registered identity.
    for (let i = 0; i < resets.length; i++) for (const [a, b] of resets) if (accepted.has(a) || accepted.has(b)) { accepted.add(a); accepted.add(b); }
    const messageGroups = new Map<string, ConductorMessage[]>();
    for (const receipt of [...receipts, ...messages]) {
      if (receipt.providerId && row.provider_session_id && !accepted.has(receipt.providerId)) continue;
      const identity = receipt.providerId ?? own;
      const key = `claude:${identity ?? `row:${row.conductor_session_id}`}`;
      if (canonicalKeys.has(key) && !onPaired) continue;
      const group: Group = groups.get(key) ?? { provider: "claude", identity, rows: new Map(), receipts: new Map(), messages: [] };
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
  // A cached identity this scan has not seen raw, or a receipt-time tie, needs raw
  // values only the source holds. Re-reading those sessions restores them exactly.
  const unresolved = (group: Group): boolean => {
    if (group.identity !== null && resolve(group.identity) === undefined) return true;
    const times = new Map<string, string>();
    for (const receipt of group.receipts.values()) {
      const tied = times.get(receipt.at);
      if (tied !== undefined && (resolve(tied) === undefined || resolve(receipt.id) === undefined)) return true;
      times.set(receipt.at, receipt.id);
    }
    return false;
  };
  if (cache) {
    const reread = new Set([...groups.values()].filter(unresolved).flatMap((group) => [...group.rows.keys()]));
    for (const row of rows) if (reread.has(row.conductor_session_id)) live(row);
    if (reread.size && [...groups.values()].some(unresolved)) throw new IndexParityError();
  }
  const order = (id: string): string => resolve(id)!;
  const keys = [...groups].map(([internal, group]) => [group.identity === null ? internal : `claude:${resolve(group.identity)!}`, internal] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const sessions: SessionAnalytics[] = [];
  for (const [key, internal] of keys) {
    const group = groups.get(internal)!;
    groups.delete(internal);
    const rows = [...group.rows.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.conductor_session_id.localeCompare(b.conductor_session_id));
    const row = rows.at(-1)!, createdAt = rows.map((r) => timestamp(r.created_at)).filter((v): v is string => !!v).sort()[0], updatedAt = rows.map((r) => timestamp(r.updated_at)).filter((v): v is string => !!v).sort().at(-1);
    if (!createdAt || !updatedAt) continue;
    const conflict = new Set(rows.map((r) => r.repository_id)).size > 1;
    const repository = conflict ? { id: `discovered-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`, name: "Conductor · unassigned" } : { id: row.repository_id, name: row.repository_name };
    const receipts = [...group.receipts.values()], { snapshots, complete } = selectSnapshots(receipts, order);
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
    session.transcript.warnings.push("Recovered from Conductor result receipts. Tools, human turns, model request counts, and per-request cost dates are unavailable; reported value is session-dated. Reported value is not an invoice.");
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
    // Message recovery writes its own request-dated ledger; receipt evidence is session-dated.
    if (selected?.evidence?.source === "conductor-result") selected.velocity = receiptVelocity(selected, snapshots.at(-1)?.at || null);
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
