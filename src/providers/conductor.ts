import type { DatabaseSync } from "node:sqlite";
import type { ConductorResultMetrics, ConductorTerminalReason, SessionAnalytics, SessionDatabaseRow, SessionProvider, TokenUsage } from "../types.ts";
import type { ProviderContext } from "./adapter.ts";
import { count, emptySession, finite, finish, hash, hasCounters, modelName, parse, record, reportedModel, sum, text, timestamp, tokens, zeroTokens } from "./common.ts";

const reasons = new Set<ConductorTerminalReason>(["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries", "completed", "cancelled", "interrupted"]);
const providers = new Set<SessionProvider>(["claude", "codex", "cursor"]);

/** Only terminal SDK result envelopes are evidence. Ordinary stored messages never become a fallback. */
export function conductorFallback(database: DatabaseSync | null, canonicalIdentities = new Set<string>()): (row: SessionDatabaseRow, context: ProviderContext) => SessionAnalytics | null {
  if (!database) return () => null;
  const columns = new Set((database.prepare("PRAGMA table_info(session_messages)").all() as Array<{ name: string }>).map((r) => r.name));
  if (!["session_id", "id", "content"].every((key) => columns.has(key))) return () => null;
  const statement = database.prepare(`SELECT id, content, ${columns.has("full_message") ? "full_message" : "NULL AS full_message"} FROM session_messages WHERE session_id = ? ORDER BY ${columns.has("created_at") ? "created_at, " : ""}id`);
  const claimedResults = new Set<string>();
  return (row, context) => {
    if (!providers.has(row.agent_type as SessionProvider)) return null;
    const providerIds = new Set<string>();
    const results = new Map<string, {
      cost: number | null; usage: TokenUsage; usageObserved: boolean; models: ReturnType<typeof reportedModel>[];
      turns: number | null; duration: number | null; apiDuration: number | null;
      denials: number | null; error: boolean; reason: ConductorTerminalReason;
    }>();
    for (const item of statement.iterate(row.conductor_session_id)) {
      for (const raw of [item["content"], item["full_message"]]) {
        const result = parse(raw);
        if (result?.["type"] !== "result") continue;
        const providerId = text(result["session_id"]);
        if (providerId && row.provider_session_id && providerId !== row.provider_session_id) continue;
        if (providerId && canonicalIdentities.has(`${row.agent_type}:${providerId}`)) continue;
        const cost = finite(result["total_cost_usd"]);
        const usage = record(result["usage"]);
        const modelUsage = record(result["modelUsage"]);
        if (cost === null && !usage && !modelUsage) continue;
        const id = text(result["uuid"]) ?? String(item["id"]);
        if (claimedResults.has(`${row.agent_type}:${id}`)) continue;
        if (providerId) providerIds.add(`${row.agent_type}:${providerId}`);
        const models: ReturnType<typeof reportedModel>[] = [];
        const total = zeroTokens();
        let modelUsageObserved = false;
        for (const [rawModel, rawUsage] of Object.entries(modelUsage ?? {})) {
          const u = record(rawUsage);
          if (!u) continue;
          modelUsageObserved ||= hasCounters(u, ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]);
          const modelTokens = tokens(u["inputTokens"], u["cacheReadInputTokens"], u["cacheCreationInputTokens"], u["outputTokens"]);
          sum(total, modelTokens);
          const allocation = reportedModel(modelName(rawModel), modelTokens, finite(u["costUSD"]) ?? 0);
          allocation.priced = finite(u["costUSD"]) !== null;
          models.push(allocation);
        }
        // modelUsage is the aggregate; usage can be only the final response. Never add both.
        if (!modelUsageObserved && usage) {
          sum(total, tokens(usage["input_tokens"], usage["cache_read_input_tokens"] ?? usage["cached_input_tokens"], usage["cache_creation_input_tokens"], usage["output_tokens"], record(usage["output_tokens_details"])?.["thinking_tokens"], row.agent_type === "codex"));
        }
        const reason = text(result["terminal_reason"]) ?? text(result["subtype"]);
        results.set(id, {
          cost, usage: total, models, usageObserved: modelUsageObserved || hasCounters(usage, ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]),
          turns: finite(result["num_turns"]), duration: finite(result["duration_ms"]), apiDuration: finite(result["duration_api_ms"]),
          denials: Array.isArray(result["permission_denials"]) ? result["permission_denials"].length : null,
          error: result["is_error"] === true,
          reason: reasons.has(reason as ConductorTerminalReason) ? reason as ConductorTerminalReason : "unknown",
        });
      }
    }
    if (!results.size) return null;
    const createdAt = timestamp(row.created_at), updatedAt = timestamp(row.updated_at);
    if (!createdAt || !updatedAt) return null;
    for (const id of providerIds) canonicalIdentities.add(id);
    for (const id of results.keys()) claimedResults.add(`${row.agent_type}:${id}`);
    const session = emptySession({ id: row.conductor_session_id, path: "", cwd: row.workspace_path, createdAt, updatedAt }, row.agent_type as SessionProvider, context, {
      source: "conductor-result", fidelity: "summary", tokens: [...results.values()].some((r) => r.usageObserved) ? "reported" : "unavailable", tools: "unavailable", turns: "unavailable", timing: "provider", usageUnit: "run",
    });
    session.sessionKey = hash(row.conductor_session_id);
    session.transcript.files = 0;
    session.status = ["working", "idle", "completed", "failed", "cancelled", "archived"].includes(row.status) ? row.status : "unknown";
    session.transcript.snapshotWhileWorking = session.status === "working";
    const metrics: ConductorResultMetrics = { resultRecords: results.size, reportedTurns: null, durationMilliseconds: null, apiDurationMilliseconds: null, permissionDenials: null, errorResults: 0, terminalReasons: {} };
    const models = new Map<string, ReturnType<typeof reportedModel>>();
    let costRecords = 0;
    for (const result of results.values()) {
      sum(session.tokens, result.usage);
      if (result.cost !== null) { session.cost.totalUsd += result.cost; costRecords++; }
      for (const source of result.models) {
        const target = models.get(source.model) ?? reportedModel(source.model, zeroTokens(), 0);
        sum(target, source); target.priced = target.priced && source.priced; models.set(source.model, target);
      }
      if (result.turns !== null) metrics.reportedTurns = (metrics.reportedTurns ?? 0) + count(result.turns);
      if (result.duration !== null) metrics.durationMilliseconds = (metrics.durationMilliseconds ?? 0) + result.duration;
      if (result.apiDuration !== null) metrics.apiDurationMilliseconds = (metrics.apiDurationMilliseconds ?? 0) + result.apiDuration;
      if (result.denials !== null) metrics.permissionDenials = (metrics.permissionDenials ?? 0) + result.denials;
      metrics.errorResults += Number(result.error);
      metrics.terminalReasons[result.reason] = (metrics.terminalReasons[result.reason] ?? 0) + 1;
    }
    session.models = [...models.values()];
    // Top-level reported USD is authoritative; a model allocation cannot add a second cost.
    if (costRecords) session.costBasis = "provider-reported";
    else {
      session.cost.totalUsd = session.models.reduce((value, model) => value + model.totalUsd, 0);
      if (session.models.some((model) => model.priced)) session.costBasis = "provider-reported";
    }
    session.cost.upperEstimateUsd = session.cost.totalUsd;
    session.costComplete = costRecords === results.size;
    session.conductor = metrics;
    session.transcript.warnings.push("Recovered from Conductor SDK result summaries because no canonical provider evidence was available. Tools, human turns, request counts, and daily cost attribution are unavailable.");
    session.transcript.warnings.push("Result records report SDK-run totals, not a billing invoice or evidence of task success. Retained results may cover only part of the session.");
    const modelCost = session.models.reduce((total, model) => total + model.totalUsd, 0);
    if (session.models.length && Math.abs(modelCost - session.cost.totalUsd) > 0.000001) session.transcript.warnings.push("Reported model allocations differ from the reported total; the SDK result total remains authoritative.");
    const finalized = finish(session);
    finalized.pricedTokenCoverage = null;
    finalized.costComplete = costRecords === results.size;
    return finalized;
  };
}
