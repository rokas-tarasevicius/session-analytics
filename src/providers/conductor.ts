import type { DatabaseSync } from "node:sqlite";
import type { ConductorResultMetrics, ConductorTerminalReason, ModelUsage, SessionAnalytics, SessionDatabaseRow, SessionProvider, TokenUsage } from "../types.ts";
import type { ProviderContext } from "./adapter.ts";
import { emptySession, finite, finish, hash, hasCounters, modelName, parse, record, reportedModel, statusName, sum, text, timestamp, tokens, zeroTokens } from "./common.ts";

const reasons = new Set<ConductorTerminalReason>(["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries", "completed", "cancelled", "interrupted"]);
interface Receipt {
  id: string; providerId: string | null; at: string; epoch: string | null; version: "old" | "restored" | null;
  cost: number | null; usage: TokenUsage; usageObserved: boolean; localUsage: TokenUsage | null; models: ModelUsage[];
  turns: number | null; duration: number | null; apiDuration: number | null; denials: number | null;
  error: boolean; reason: ConductorTerminalReason;
}
interface Group { provider: SessionProvider; rows: Map<string, SessionDatabaseRow>; receipts: Map<string, Receipt> }
function versionScope(value: unknown): Receipt["version"] {
  const match = typeof value === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(value) : null;
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major !== 2 || minor !== 1) return null; // Other versions need primary-source verification.
  return patch! < 277 ? "old" : "restored";
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
    const model = reportedModel(modelName(rawModel), modelTokens, finite(u["costUSD"]) ?? 0);
    model.priced = finite(u["costUSD"]) !== null; models.push(model);
  }
  const reason = text(result["terminal_reason"]) ?? text(result["subtype"]);
  return { id, providerId: text(result["session_id"]), at, epoch, version, cost, usage: total, usageObserved: observed, models,
    localUsage: hasCounters(usage, ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) ? tokens(usage?.["input_tokens"], usage?.["cache_read_input_tokens"], usage?.["cache_creation_input_tokens"], usage?.["output_tokens"]) : null,
    turns: finite(result["num_turns"]), duration: finite(result["duration_ms"]), apiDuration: finite(result["duration_api_ms"]),
    denials: Array.isArray(result["permission_denials"]) ? result["permission_denials"].length : null, error: result["is_error"] === true,
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
  const oldEpochs = valid.every((r) => r.epoch && r.version === "old");
  const buckets = new Map<string, Receipt[]>();
  for (const r of valid) { const key = oldEpochs ? r.epoch! : "session"; buckets.set(key, [...(buckets.get(key) ?? []), r]); }
  let complete = valid.length === receipts.length && (receipts.length === 1 || oldEpochs || valid.every((r) => r.epoch && r.version === "restored"));
  const snapshots: Receipt[] = [];
  for (const bucket of buckets.values()) {
    const ordered = bucket.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const last = ordered.at(-1)!;
    if (ordered.every((r) => dominates(last, r))) snapshots.push(last);
    else {
      // Conflicting/reset/unknown-version histories: retain one observed lower bound, never add overlap.
      complete = false;
      snapshots.push([...ordered].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.usage.inputTokens - a.usage.inputTokens || b.at.localeCompare(a.at))[0]!);
    }
  }
  return { snapshots, complete };
}

/** Collect all eligible rows before grouping. Canonical identities are read-only native precedence. */
export function conductorFallback(database: DatabaseSync | null, rows: SessionDatabaseRow[], canonicalIdentities: ReadonlySet<string>, pricing: Pick<ProviderContext, "rateCard" | "price">): SessionAnalytics[] {
  if (!database) return [];
  const columns = new Set((database.prepare("PRAGMA table_info(session_messages)").all() as Array<{ name: string }>).map((r) => r.name));
  if (!["session_id", "id", "content"].every((key) => columns.has(key))) return [];
  const statement = database.prepare(`SELECT id, content, ${columns.has("full_message") ? "full_message" : "NULL AS full_message"}, ${columns.has("created_at") ? "created_at" : "NULL AS created_at"} FROM session_messages WHERE session_id = ? ORDER BY ${columns.has("created_at") ? "created_at, " : ""}id`);
  const groups = new Map<string, Group>();
  for (const row of rows) {
    // The verified SDK result accounting contract is Claude's; other SDK envelopes are not interchangeable.
    if (row.agent_type !== "claude") continue;
    const receipts: Receipt[] = [], resets: Array<[string, string]> = [], seenInit = new Set<string>();
    let epoch: string | null = null, version: Receipt["version"] = null;
    for (const item of statement.iterate(row.conductor_session_id)) for (const raw of [item["content"], item["full_message"]]) {
      const data = parse(raw); if (!data) continue;
      const id = text(data["uuid"]) ?? `message:${String(item["id"])}`;
      if (data["type"] === "system" && data["subtype"] === "init" && !seenInit.has(id)) {
        seenInit.add(id); epoch = id; version = versionScope(data["claude_code_version"]); continue;
      }
      if (data["type"] === "conversation_reset") {
        const before = text(data["session_id"]), after = text(data["new_conversation_id"]);
        if (before && after) resets.push([before, after]);
        continue;
      }
      if (data["type"] !== "result") continue;
      const receipt = project(data, id, timestamp(item["created_at"]) ?? timestamp(row.created_at) ?? "", epoch, version);
      if (receipt) receipts.push(receipt);
    }
    const accepted = new Set(row.provider_session_id ? [row.provider_session_id] : []);
    // Explicit reset links can connect receipts before/after the currently registered identity.
    for (let i = 0; i < resets.length; i++) for (const [a, b] of resets) if (accepted.has(a) || accepted.has(b)) { accepted.add(a); accepted.add(b); }
    for (const receipt of receipts) {
      if (receipt.providerId && row.provider_session_id && !accepted.has(receipt.providerId)) continue;
      const identity = receipt.providerId ?? row.provider_session_id;
      const key = `claude:${identity ?? `row:${row.conductor_session_id}`}`;
      if (canonicalIdentities.has(key)) continue;
      const group = groups.get(key) ?? { provider: "claude", rows: new Map(), receipts: new Map() };
      group.rows.set(row.conductor_session_id, row);
      const previous = group.receipts.get(receipt.id);
      // A copied receipt keeps its original chronological position.
      if (!previous || receipt.at < previous.at) group.receipts.set(receipt.id, receipt);
      groups.set(key, group);
    }
  }
  const sessions: SessionAnalytics[] = [];
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = [...group.rows.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.conductor_session_id.localeCompare(b.conductor_session_id));
    const row = rows.at(-1)!, createdAt = rows.map((r) => timestamp(r.created_at)).filter((v): v is string => !!v).sort()[0], updatedAt = rows.map((r) => timestamp(r.updated_at)).filter((v): v is string => !!v).sort().at(-1);
    if (!createdAt || !updatedAt) continue;
    const conflict = new Set(rows.map((r) => r.repository_id)).size > 1;
    const repository = conflict ? { id: `discovered-${hash(key)}`, name: "Conductor · unassigned" } : { id: row.repository_id, name: row.repository_name };
    const receipts = [...group.receipts.values()], { snapshots, complete } = selectSnapshots(receipts);
    const session = emptySession({ id: key, path: "", cwd: null, createdAt, updatedAt }, group.provider, { repository, ...pricing }, {
      source: "conductor-result", fidelity: "summary", tokens: "unavailable", tools: "unavailable", turns: "unavailable", timing: "provider", usageUnit: "session", accounting: complete ? "complete" : "partial",
    });
    session.sessionKey = hash(key); session.transcript.files = 0; session.status = statusName(row.status); session.transcript.snapshotWhileWorking = session.status === "working";
    const only = receipts.length === 1 ? receipts[0]! : null;
    const metrics: ConductorResultMetrics = { resultRecords: receipts.length, reportedTurns: only?.turns ?? null, durationMilliseconds: only?.duration ?? null, apiDurationMilliseconds: only?.apiDuration ?? null, permissionDenials: only?.denials ?? null, errorResults: 0, terminalReasons: {}, turnLocalTokens: null };
    for (const receipt of receipts) {
      if (receipt.localUsage) { metrics.turnLocalTokens ??= zeroTokens(); sum(metrics.turnLocalTokens, receipt.localUsage); }
      metrics.errorResults += Number(receipt.error); metrics.terminalReasons[receipt.reason] = (metrics.terminalReasons[receipt.reason] ?? 0) + 1;
    }
    const models = new Map<string, ModelUsage>(); let costSnapshots = 0;
    for (const result of snapshots) {
      if (result.usageObserved) { sum(session.tokens, result.usage); session.evidence!.tokens = "reported"; }
      // A single receipt's turn-local usage is useful when no cumulative tokens exist.
      else if (only?.localUsage) { sum(session.tokens, only.localUsage); session.evidence!.tokens = "reported"; }
      const cost = result.cost ?? (result.models.some((m) => m.priced) ? result.models.reduce((n, m) => n + m.totalUsd, 0) : null);
      if (cost !== null) { session.cost.totalUsd += cost; costSnapshots++; }
      for (const source of result.models) {
        const target = models.get(source.model) ?? reportedModel(source.model, zeroTokens(), 0);
        sum(target, source); target.priced &&= source.priced; models.set(source.model, target);
      }
    }
    session.models = [...models.values()]; if (costSnapshots) session.costBasis = "provider-reported";
    session.cost.upperEstimateUsd = session.cost.totalUsd; session.conductor = metrics;
    session.transcript.warnings.push("Recovered from Conductor result receipts. Tools, human turns, model request counts, and daily cost attribution are unavailable. Reported value is not an invoice.");
    if (!complete) session.transcript.warnings.push("Accounting is partial: retained receipts do not prove disjoint process epochs or complete resumed history. Ambiguous cumulative snapshots are not added; zeroed crash results cannot erase earlier evidence.");
    if (receipts.length > 1) session.transcript.warnings.push("Turn-local usage is separate from cumulative model usage. SDK turns, durations, and denial totals are unavailable across multiple receipts because their scopes are not established.");
    if (conflict) session.transcript.warnings.push("Conductor rows disagree on repository attribution; the recovered identity is grouped as unassigned.");
    if (session.models.length && Math.abs(session.models.reduce((n, m) => n + m.totalUsd, 0) - session.cost.totalUsd) > 0.000001) session.transcript.warnings.push("Reported model allocations differ from the reported total; the SDK result total remains authoritative.");
    const finalized = finish(session); finalized.pricedTokenCoverage = null; finalized.costComplete = complete && snapshots.length > 0 && costSnapshots === snapshots.length;
    sessions.push(finalized);
  }
  return sessions;
}
