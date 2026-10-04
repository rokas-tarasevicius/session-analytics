import type { ExecutionKind, SessionAnalytics, TokenUsage } from "../types.ts";
import type { ProviderContext } from "./adapter.ts";
import { priceUsage } from "../pricing/usage.ts";
import { projectModelId } from "../public/model-id.js";
import { normalizeTimestamp } from "../public/timestamps.js";
import { VelocityAccumulator, usageVelocity, velocityDimension } from "../metrics/velocity.ts";
import { addUsage, emptySession, finite, finish, hasCounters, increment, name, observeTime, record, text, zeroTokens, type RecordValue } from "./common.ts";
import { claudeUsage, replacesClaudeUsage } from "./claude-usage.ts";
import type { HistoryReconciliation, HistoryUsageDay } from "../metrics/history-types.ts";
import { HistoryStatisticsCollector } from "../metrics/history-statistics.ts";

export interface ConductorMessage {
  id: string;
  recordId: string;
  inputKey: string;
  statisticsTokens: number;
  providerId: string | null;
  identityKnown: boolean;
  at: string | null;
  model: string;
  usage: TokenUsage;
  usageObserved: boolean;
  reasoningExposed: boolean;
  cacheRead: boolean;
  cacheWrite: boolean;
  executionKind: Exclude<ExecutionKind, "mixed" | "unknown">;
  tools: Array<{ id: string; name: string }>;
}

export function conductorMessage(data: RecordValue, item: RecordValue): ConductorMessage {
  const message = record(data["message"]), usage = record(message?.["usage"]);
  const requestId = text(message?.["id"]) ?? text(data["requestId"]);
  const recordId = text(data["uuid"]) ?? text(item["sdk_message_id"]) ?? `row:${String(item["id"])}`;
  const normalized = usage ? claudeUsage(usage) : zeroTokens(), model = projectModelId(message?.["model"]);
  // Newer SDK envelopes strip message.id. Their uuid/sdk_message_id identifies a
  // streamed block, NOT a response. Identical input counters within one agent
  // form a conservative group: separate responses can collide, so this is partial.
  const inputKey = JSON.stringify([text(data["parent_tool_use_id"]), text(data["agentId"]),
    data["isSidechain"] === true || data["isSidechain"] === 1, model,
    normalized.uncachedInputTokens, normalized.cachedInputTokens, normalized.cacheWriteInputTokens]);
  const id = requestId ? `response:${requestId}` : `unidentified:${inputKey}`;
  const tools: ConductorMessage["tools"] = [];
  for (const [index, raw] of (Array.isArray(data["tools"]) ? data["tools"] : []).entries()) {
    const tool = record(raw);
    tools.push({ id: text(tool?.["id"]) ?? `${recordId}:tool:${index}`, name: name(tool?.["name"]) ?? "unknown_tool" });
  }
  const statisticsTokens = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].reduce((n, key) => n + (finite(usage?.[key]) ?? 0), 0);
  return { id, recordId, inputKey, statisticsTokens, providerId: text(data["session_id"]), identityKnown: requestId !== null,
    at: normalizeTimestamp(data["timestamp"]) ?? normalizeTimestamp(item["created_at"]),
    model, usage: normalized,
    usageObserved: hasCounters(usage, ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]),
    reasoningExposed: finite(record(usage?.["output_tokens_details"])?.["thinking_tokens"]) !== null,
    cacheRead: finite(usage?.["cache_read_input_tokens"]) !== null, cacheWrite: finite(usage?.["cache_creation_input_tokens"]) !== null,
    executionKind: data["isSidechain"] === true || data["isSidechain"] === 1 || text(data["parent_tool_use_id"]) ? "subagent" : "top-level", tools };
}

/** The receipt session is a comparison baseline, never added to message usage. */
export function recoverConductorMessages(base: SessionAnalytics, messages: ConductorMessage[], pricing: Pick<ProviderContext, "rateCard" | "resolveRate" | "price">): SessionAnalytics | null {
  if (!messages.some((message) => message.usageObserved)) return null;
  const usage = new Map<string, ConductorMessage>(), tools = new Map<string, { name: string; message: ConductorMessage }>();
  // Prefer a retained response ID in either representation of the same record.
  const identities = new Map(messages.filter((m) => m.identityKnown).map((m) => [m.recordId, m.id]));
  const records = new Map<string, ConductorMessage>();
  for (const message of [...messages].sort((a, b) => (a.at ?? "\uffff").localeCompare(b.at ?? "\uffff"))) {
    const previous = records.get(message.recordId);
    if (replacesClaudeUsage(previous, message)) records.set(message.recordId, message);
    for (const tool of message.tools) if (!tools.has(tool.id)) tools.set(tool.id, { name: tool.name, message });
  }
  const merge = (id: string, message: ConductorMessage) => {
    const previous = usage.get(id);
    if (replacesClaudeUsage(previous, message)) usage.set(id, { ...message, id,
      at: previous && previous.usage.inputTokens + previous.usage.outputTokens > 0 ? previous.at ?? message.at : message.at });
  };
  for (const message of records.values()) {
    const identity = identities.get(message.recordId);
    merge(identity ?? message.id, identity ? { ...message, identityKnown: true } : message);
  }
  // Partially stripped copies must not add usage already represented by an ID.
  // If several known requests have the same inputs, retain all known requests
  // and merge ambiguous usage into the largest one. Never invent another call.
  const knownInputs = new Map<string, ConductorMessage>();
  for (const message of usage.values()) if (message.identityKnown) {
    const previous = knownInputs.get(message.inputKey);
    if (!previous || message.usage.outputTokens > previous.usage.outputTokens) knownInputs.set(message.inputKey, message);
  }
  for (const message of [...usage.values()]) if (!message.identityKnown) {
    const known = knownInputs.get(message.inputKey);
    if (!known) continue;
    usage.delete(message.id); merge(known.id, message);
    usage.get(known.id)!.identityKnown = false;
  }
  const context = { ...pricing, repository: { id: base.repositoryId, name: base.repositoryName } };
  const session = emptySession({ id: "", path: "", cwd: null, createdAt: base.createdAt, updatedAt: base.updatedAt }, "claude", context, {
    source: "conductor-messages", fidelity: "message", tokens: "reported", tools: "observed", turns: "unavailable", timing: "provider", usageUnit: "request", accounting: "partial",
  });
  session.sessionKey = base.sessionKey; session.status = base.status; session.transcript.files = 0;
  session.transcript.snapshotWhileWorking = base.transcript.snapshotWhileWorking;
  session.transcript.startTimeKnown = true;
  session.agentIdentity = { claudeEntrypoint: "sdk" };
  for (const message of messages) observeTime(session, message.at);
  const velocity = new VelocityAccumulator(), days = new Map<string, HistoryUsageDay>();
  session.history = { days: [], undatedTokens: 0, undatedValueUsd: 0 };
  const statistics = new HistoryStatisticsCollector();
  for (const message of records.values()) {
    statistics.add(message.at, message.model, { input_tokens: message.statisticsTokens });
  }
  session.historyStatistics = statistics.finish();
  const execution = new Set<ExecutionKind>();
  const executionCost = { topLevelUsd: 0, subagentUsd: 0, unknownUsd: 0 };
  let missingUsage = 0, missingIdentity = 0;
  for (const message of [...usage.values()].sort((a, b) => (a.at ?? "\uffff").localeCompare(b.at ?? "\uffff"))) {
    observeTime(session, message.at); execution.add(message.executionKind);
    missingUsage += Number(!message.usageObserved); missingIdentity += Number(!message.identityKnown);
    const total = message.usage.inputTokens + message.usage.outputTokens;
    if (!total) continue;
    const before = session.cost.totalUsd;
    addUsage(session, context, message.model, message.usage, message.at, "request");
    const value = session.cost.totalUsd - before;
    executionCost[message.executionKind === "subagent" ? "subagentUsd" : "topLevelUsd"] += value;
    const rate = context.resolveRate ? context.resolveRate(message.model, message.at)?.rate : Object.hasOwn(context.rateCard.models, message.model) ? context.rateCard.models[message.model] : undefined;
    const priced = rate ? priceUsage(rate, message.usage, message.usage.inputTokens).pricedTokens : 0;
    const values = usageVelocity(message.usage, value, 0, { reasoning: message.reasoningExposed, cacheRead: message.cacheRead, cacheWrite: message.cacheWrite });
    values[10] = priced;
    velocity.add(message.at, velocityDimension("claude", session.agentIdentity, message.executionKind, message.model, null), values);
    if (message.at) {
      const day = message.at.slice(0, 10), key = `${day}:${message.model}`;
      const bucket = days.get(key) ?? { day, model: message.model, tokens: 0, valueUsd: 0 };
      bucket.tokens += total; bucket.valueUsd += value; days.set(key, bucket);
    } else { session.history.undatedTokens += total; session.history.undatedValueUsd += value; }
  }
  for (const { name, message } of tools.values()) {
    increment(session.tools, name);
    increment(session.transportTools, name);
    velocity.tool(message.at, velocityDimension("claude", session.agentIdentity, message.executionKind, message.model, null));
  }
  session.history.days = [...days.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
  session.metrics.assistantMessages = usage.size;
  session.executionKind = execution.size > 1 ? "mixed" : [...execution][0] ?? "unknown";
  finish(session);
  const reported = base.costBasis === "provider-reported" ? base.cost.totalUsd : null;
  const delta = reported === null ? null : session.cost.totalUsd - reported;
  const receiptScope = reported === null ? "unavailable" : base.evidence?.accounting === "complete" ? "complete" : "partial";
  const reconciliation: HistoryReconciliation = {
    messageValueUsd: session.cost.totalUsd, reportedUsd: reported, differenceUsd: delta,
    relativeDifference: reported && delta !== null ? delta / reported : null,
    status: reported === null ? "unavailable" : receiptScope === "partial" || missingUsage || missingIdentity || session.pricedTokenCoverage !== 1 ? "partial" :
      Math.abs(delta!) <= Math.max(0.01, reported * 0.01) ? "agrees" : "differs",
    receiptScope, messages: usage.size, messagesWithoutUsage: missingUsage, messagesWithoutIdentity: missingIdentity,
  };
  session.conductor = { ...base.conductor!, reconciliation };
  session.transcript.warnings.push("Recovered from Conductor assistant usage. API-equivalent value is not an invoice; retained messages may not cover the full session. Human turns are unavailable.");
  if (missingIdentity) session.transcript.warnings.push("Some recovered assistant records lack response IDs. Matching input counters within each agent are grouped conservatively; indistinguishable requests may be omitted. Message counts, accounting, and receipt agreement are partial.");
  if (base.repositoryName === "Conductor · unassigned") session.transcript.warnings.push("Conductor rows disagree on repository attribution; the recovered identity is grouped as unassigned.");
  session.velocity = velocity.finish(session.createdAt, velocityDimension("claude", session.agentIdentity, "top-level", "<unknown>", null));
  session.costByExecution = executionCost;
  session.costComplete = false; // Agreement of values does not prove complete retained history.
  return session;
}
