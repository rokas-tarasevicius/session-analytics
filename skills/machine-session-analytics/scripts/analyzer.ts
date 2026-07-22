import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type {
  AnalyzeOptions,
  CostBreakdown,
  ModelRate,
  ModelUsage,
  MachineAnalytics,
  NamedMetric,
  RateCard,
  RepositoryAnalytics,
  SessionAnalytics,
  SessionDatabaseRow,
  SessionMetrics,
  SessionProvider,
  TokenUsage,
} from "./types.ts";

const toolRoot = new URL(".", import.meta.url);
const defaultRateCardPath = new URL("../references/rate-cards.json", toolRoot);
const zeroTokens = (): TokenUsage => ({
  cacheWrite1hInputTokens: 0,
  cacheWrite5mInputTokens: 0,
  cacheWriteInputTokens: 0,
  cachedInputTokens: 0,
  inputTokens: 0,
  nonReasoningOutputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  uncachedInputTokens: 0,
});
const zeroCost = (): CostBreakdown => ({
  cacheWriteUsd: 0,
  cachedInputUsd: 0,
  inputUsd: 0,
  outputUsd: 0,
  totalUsd: 0,
  upperEstimateUsd: 0,
});
const tokenKeys: Array<keyof TokenUsage> = [
  "inputTokens",
  "uncachedInputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "cacheWrite5mInputTokens",
  "cacheWrite1hInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "nonReasoningOutputTokens",
];
const costKeys: Array<keyof CostBreakdown> = [
  "cachedInputUsd",
  "cacheWriteUsd",
  "inputUsd",
  "outputUsd",
  "totalUsd",
  "upperEstimateUsd",
];

type JsonRecord = Record<string, unknown>;

export interface RepositoryRow {
  default_branch: string;
  id: string;
  name: string;
  remote_url: string | null;
  root_path: string;
}

interface TokenEvent {
  executionKind: SessionAnalytics["executionKind"];
  fingerprint: string | null;
  last: TokenUsage | null;
  model: string;
  timestamp: string | null;
  total: TokenUsage;
  inputForRequest: number;
}

interface CodexCounterOwner {
  activityDeltaMilliseconds: number;
  modelFallback: string | null;
  path: string;
  timestamp: string;
}

interface TranscriptCandidate {
  cwd: string;
  id: string;
  path: string;
  provider: "claude" | "codex";
  timestamp: string | null;
}

interface MutableSession {
  assistantMessages: number;
  compactions: number;
  delegatedAgents: Set<string>;
  effort: string | null;
  executionKind: SessionAnalytics["executionKind"];
  executionKindsSeen: Set<SessionAnalytics["executionKind"]>;
  costByExecution: SessionAnalytics["costByExecution"];
  firstEventAt: string | null;
  lastEventAt: string | null;
  maxContextWindow: number;
  maxInputTokensPerCall: number;
  models: Map<string, ModelUsage>;
  queueOperations: number;
  spendByDay: Record<string, number>;
  summaries: number;
  taskCompletions: number;
  taskStarts: number;
  tools: Record<string, number>;
  transportTools: Record<string, number>;
  userTurns: number;
  warnings: string[];
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonNegativeNumberValue(value: unknown): number {
  return Math.max(0, numberValue(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function increment(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

function sumTokens(target: TokenUsage, source: TokenUsage): void {
  for (const key of tokenKeys) {
    target[key] += source[key];
  }
}

function sumCost(target: CostBreakdown, source: CostBreakdown): void {
  for (const key of costKeys) {
    target[key] += source[key];
  }
}

function tokenCount(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

function isoDay(timestamp: string | null, fallback: string): string {
  const date = new Date(timestamp ?? fallback);
  return Number.isNaN(date.valueOf()) ? fallback.slice(0, 10) : date.toISOString().slice(0, 10);
}

function trackTimestamp(session: MutableSession, timestamp: string | null): void {
  if (!timestamp) return;
  if (!session.firstEventAt || timestamp < session.firstEventAt) session.firstEventAt = timestamp;
  if (!session.lastEventAt || timestamp > session.lastEventAt) session.lastEventAt = timestamp;
}

function normalizeRemote(value: string): string {
  return value
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function durationMilliseconds(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  const startValue = new Date(start).valueOf();
  const endValue = new Date(end).valueOf();
  return Number.isFinite(startValue) && Number.isFinite(endValue)
    ? Math.max(0, endValue - startValue)
    : 0;
}

async function loadRateCard(path: string | URL = defaultRateCardPath): Promise<RateCard> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RateCard>;
  const models = asRecord(parsed.models);
  if (
    parsed.currency !== "USD" ||
    !parsed.effectiveDate ||
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed.effectiveDate) ||
    Number.isNaN(new Date(`${parsed.effectiveDate}T00:00:00Z`).valueOf()) ||
    !models
  ) {
    throw new Error("The session analytics rate card is invalid.");
  }
  for (const [model, rawRate] of Object.entries(models)) {
    const rate = rawRate as ModelRate;
    if (
      !["claude", "codex"].includes(rate.provider) ||
      !Number.isFinite(rate.inputPerMillion) || rate.inputPerMillion < 0 ||
      !Number.isFinite(rate.outputPerMillion) || rate.outputPerMillion < 0 ||
      [
        rate.cachedInputPerMillion,
        rate.cacheReadPerMillion,
        rate.cacheWrite5mPerMillion,
        rate.cacheWrite1hPerMillion,
        rate.cacheWriteMultiplier,
      ].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0)) ||
      (rate.longContext !== undefined &&
        (!Number.isFinite(rate.longContext.inputMultiplier) ||
          rate.longContext.inputMultiplier <= 0 ||
          !Number.isFinite(rate.longContext.outputMultiplier) ||
          rate.longContext.outputMultiplier <= 0 ||
          !Number.isFinite(rate.longContext.thresholdInputTokens) ||
          rate.longContext.thresholdInputTokens < 0)) ||
      !rate.source
    ) {
      throw new Error(`The rate card entry for ${model} is invalid.`);
    }
  }
  return parsed as RateCard;
}

function calculateCost(
  rate: ModelRate,
  usage: TokenUsage,
  inputForRequest: number,
): CostBreakdown {
  const inputMultiplier =
    rate.longContext && inputForRequest > rate.longContext.thresholdInputTokens
      ? rate.longContext.inputMultiplier
      : 1;
  const outputMultiplier =
    rate.longContext && inputForRequest > rate.longContext.thresholdInputTokens
      ? rate.longContext.outputMultiplier
      : 1;
  const inputUsd =
    (usage.uncachedInputTokens * rate.inputPerMillion * inputMultiplier) / 1_000_000;
  const cachedRate =
    rate.cachedInputPerMillion ?? rate.cacheReadPerMillion ?? rate.inputPerMillion;
  const cachedInputUsd =
    (usage.cachedInputTokens * cachedRate * inputMultiplier) / 1_000_000;
  const fiveMinuteWriteRate =
    rate.cacheWrite5mPerMillion ??
    rate.inputPerMillion * (rate.cacheWriteMultiplier ?? 1);
  const oneHourWriteRate = rate.cacheWrite1hPerMillion ?? fiveMinuteWriteRate;
  const unsplitCacheWrites = Math.max(
    0,
    usage.cacheWriteInputTokens -
      usage.cacheWrite5mInputTokens -
      usage.cacheWrite1hInputTokens,
  );
  const cacheWriteUsd =
    ((usage.cacheWrite5mInputTokens + unsplitCacheWrites) *
      fiveMinuteWriteRate *
      inputMultiplier +
      usage.cacheWrite1hInputTokens * oneHourWriteRate * inputMultiplier) /
    1_000_000;
  const outputUsd =
    (usage.outputTokens * rate.outputPerMillion * outputMultiplier) / 1_000_000;
  const totalUsd = inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd;
  const unobservableWriteAdjustment =
    rate.cacheWriteObservable === false && rate.cacheWriteMultiplier
      ? (usage.uncachedInputTokens *
          rate.inputPerMillion *
          (rate.cacheWriteMultiplier - 1) *
          inputMultiplier) /
        1_000_000
      : 0;
  return {
    cacheWriteUsd,
    cachedInputUsd,
    inputUsd,
    outputUsd,
    totalUsd,
    upperEstimateUsd: totalUsd + unobservableWriteAdjustment,
  };
}

function addModelUsage(
  session: MutableSession,
  rateCard: RateCard,
  model: string,
  usage: TokenUsage,
  inputForRequest: number,
  timestamp: string | null,
  fallbackTimestamp: string,
  executionKind: SessionAnalytics["executionKind"] = session.executionKind,
): void {
  let aggregate = session.models.get(model);
  if (!aggregate) {
    aggregate = {
      ...zeroTokens(),
      ...zeroCost(),
      calls: 0,
      model,
      priced: Boolean(rateCard.models[model]),
    };
    session.models.set(model, aggregate);
  }
  aggregate.calls += 1;
  sumTokens(aggregate, usage);
  const rate = rateCard.models[model];
  if (!rate) {
    aggregate.priced = false;
    return;
  }
  const cost = calculateCost(rate, usage, inputForRequest);
  sumCost(aggregate, cost);
  if (executionKind === "subagent") session.costByExecution.subagentUsd += cost.totalUsd;
  else if (executionKind === "top-level") session.costByExecution.topLevelUsd += cost.totalUsd;
  else session.costByExecution.unknownUsd += cost.totalUsd;
  increment(session.spendByDay, isoDay(timestamp, fallbackTimestamp), cost.totalUsd);
}

function createMutableSession(): MutableSession {
  return {
    assistantMessages: 0,
    compactions: 0,
    delegatedAgents: new Set<string>(),
    effort: null,
    executionKind: "unknown",
    executionKindsSeen: new Set<SessionAnalytics["executionKind"]>(),
    costByExecution: { subagentUsd: 0, topLevelUsd: 0, unknownUsd: 0 },
    firstEventAt: null,
    lastEventAt: null,
    maxContextWindow: 0,
    maxInputTokensPerCall: 0,
    models: new Map<string, ModelUsage>(),
    queueOperations: 0,
    spendByDay: {},
    summaries: 0,
    taskCompletions: 0,
    taskStarts: 0,
    tools: {},
    transportTools: {},
    userTurns: 0,
    warnings: [],
  };
}

async function visitJsonLines(
  path: string,
  visitor: (record: JsonRecord, line: number) => void,
): Promise<void> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      const record = asRecord(JSON.parse(line));
      if (record) visitor(record, lineNumber);
    } catch {
      // The caller reports a single bounded warning instead of returning transcript content.
      visitor({ __parse_error: true }, lineNumber);
    }
  }
}

async function transcriptIdentity(
  path: string,
  provider: SessionProvider,
): Promise<{ cwd: string | null; id: string | null; timestamp: string | null }> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input });
  let claudeCwd: string | null = null;
  let claudeId: string | null = null;
  let claudeTimestamp: string | null = null;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record: JsonRecord | null = null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record) continue;
    if (provider === "codex" && record["type"] === "session_meta") {
      const payload = asRecord(record["payload"]);
      return { cwd: stringValue(payload?.["cwd"]), id: stringValue(payload?.["id"]), timestamp: stringValue(record["timestamp"]) };
    }
    if (provider === "claude") {
      claudeId ??= stringValue(record["sessionId"]);
      claudeCwd ??= stringValue(record["cwd"]);
      claudeTimestamp ??= stringValue(record["timestamp"]);
      if (claudeId && claudeCwd) {
        return { cwd: claudeCwd, id: claudeId, timestamp: claudeTimestamp };
      }
    }
  }
  return provider === "claude"
    ? { cwd: claudeCwd, id: claudeId, timestamp: claudeTimestamp }
    : { cwd: null, id: null, timestamp: null };
}

async function selectTranscript(
  candidates: string[],
  provider: SessionProvider,
  providerSessionId: string,
  workspacePath: string,
): Promise<{ path: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  let idOnlyMatch: string | null = null;
  for (const candidate of candidates) {
    const identity = await transcriptIdentity(candidate, provider);
    if (identity.id === providerSessionId && identity.cwd === workspacePath) {
      return { path: candidate, warnings };
    }
    if (identity.id === providerSessionId) idOnlyMatch = candidate;
  }
  if (idOnlyMatch) {
    warnings.push("Transcript ID matched, but its recorded working directory did not.");
    return { path: null, warnings };
  }
  if (candidates.length > 0) {
    warnings.push("Transcript filename matched, but provider metadata validation failed.");
  }
  return { path: null, warnings };
}

function codexUsage(raw: JsonRecord | null): TokenUsage {
  const inputTokens = nonNegativeNumberValue(raw?.["input_tokens"]);
  const cachedInputTokens = nonNegativeNumberValue(raw?.["cached_input_tokens"]);
  const outputTokens = nonNegativeNumberValue(raw?.["output_tokens"]);
  const reasoningOutputTokens = nonNegativeNumberValue(raw?.["reasoning_output_tokens"]);
  return {
    ...zeroTokens(),
    cachedInputTokens,
    inputTokens,
    nonReasoningOutputTokens: Math.max(0, outputTokens - reasoningOutputTokens),
    outputTokens,
    reasoningOutputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
  };
}

function codexCounterFingerprint(
  total: JsonRecord | null,
  last: JsonRecord | null,
): string | null {
  if (!total || !last) return null;
  return [
    nonNegativeNumberValue(total["input_tokens"]),
    nonNegativeNumberValue(total["cached_input_tokens"]),
    nonNegativeNumberValue(total["output_tokens"]),
    nonNegativeNumberValue(total["reasoning_output_tokens"]),
    nonNegativeNumberValue(last["input_tokens"]),
    nonNegativeNumberValue(last["cached_input_tokens"]),
    nonNegativeNumberValue(last["output_tokens"]),
    nonNegativeNumberValue(last["reasoning_output_tokens"]),
  ].join(":");
}

function tokenDelta(current: TokenUsage, previous: TokenUsage): TokenUsage {
  const delta = zeroTokens();
  for (const key of tokenKeys) {
    delta[key] = current[key] - previous[key];
  }
  return delta;
}

function monotonic(current: TokenUsage, previous: TokenUsage): boolean {
  return (
    current.inputTokens >= previous.inputTokens &&
    current.cachedInputTokens >= previous.cachedInputTokens &&
    current.outputTokens >= previous.outputTokens &&
    current.reasoningOutputTokens >= previous.reasoningOutputTokens
  );
}

function nestedToolNames(input: unknown): string[] {
  if (typeof input !== "string") return [];
  const names: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const marker = input.indexOf("tools.", cursor);
    if (marker < 0) break;
    let end = marker + 6;
    const first = input.charCodeAt(end);
    const isLetter = (code: number): boolean =>
      (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isName = (code: number): boolean =>
      isLetter(code) || (code >= 48 && code <= 57) || code === 95;
    if (!isLetter(first)) { cursor = end; continue; }
    end += 1;
    while (end < input.length && isName(input.charCodeAt(end))) end += 1;
    const name = input.slice(marker + 6, end);
    while (end < input.length) {
      const code = input.charCodeAt(end);
      if (code !== 9 && code !== 10 && code !== 13 && code !== 32) break;
      end += 1;
    }
    if (input[end] === "(") names.push(name);
    cursor = Math.max(end + 1, marker + 6);
  }
  return names;
}

function codexCounterOwnerPrecedes(
  candidate: CodexCounterOwner,
  current: CodexCounterOwner | undefined,
): boolean {
  if (!current) return true;
  if (candidate.activityDeltaMilliseconds !== current.activityDeltaMilliseconds) {
    return candidate.activityDeltaMilliseconds < current.activityDeltaMilliseconds;
  }
  if (candidate.timestamp !== current.timestamp) return candidate.timestamp < current.timestamp;
  return candidate.path < current.path;
}

async function buildCodexCounterLedger(paths: string[]): Promise<Map<string, CodexCounterOwner>> {
  const owners = new Map<string, CodexCounterOwner>();
  const modelsByPath = new Map<string, Set<string>>();
  for (const path of paths) {
    let lastLocalActivityTimestamp: string | null = null;
    const models = new Set<string>();
    modelsByPath.set(path, models);
    await visitJsonLines(path, (record) => {
      const payload = asRecord(record["payload"]);
      const timestamp = stringValue(record["timestamp"]);
      if (record["type"] === "turn_context") {
        const model = stringValue(payload?.["model"]);
        if (model) models.add(model);
      }
      const tokenEvent = record["type"] === "event_msg" && payload?.["type"] === "token_count";
      if (!tokenEvent) {
        if (record["type"] !== "session_meta" && record["type"] !== "turn_context" && timestamp) {
          lastLocalActivityTimestamp = timestamp;
        }
        return;
      }
      const info = asRecord(payload["info"]);
      const fingerprint = codexCounterFingerprint(
        asRecord(info?.["total_token_usage"]),
        asRecord(info?.["last_token_usage"]),
      );
      if (!fingerprint || !timestamp) return;
      const eventTime = Date.parse(timestamp);
      const activityTime = Date.parse(lastLocalActivityTimestamp ?? "");
      const candidate: CodexCounterOwner = {
        activityDeltaMilliseconds:
          Number.isFinite(eventTime) && Number.isFinite(activityTime) && eventTime >= activityTime
            ? eventTime - activityTime
            : Number.POSITIVE_INFINITY,
        modelFallback: null,
        path,
        timestamp,
      };
      if (codexCounterOwnerPrecedes(candidate, owners.get(fingerprint))) {
        owners.set(fingerprint, candidate);
      }
    });
  }
  for (const owner of owners.values()) {
    const models = modelsByPath.get(owner.path);
    owner.modelFallback = models?.size === 1 ? [...models][0] ?? null : null;
  }
  return owners;
}

async function analyzeCodex(
  row: SessionDatabaseRow,
  path: string,
  rateCard: RateCard,
  inheritedWarnings: string[],
  counterLedger: Map<string, CodexCounterOwner> | null = null,
  claimedCounters: Set<string> = new Set<string>(),
): Promise<SessionAnalytics> {
  const state = createMutableSession();
  state.warnings.push(...inheritedWarnings);
  const tokenEvents: TokenEvent[] = [];
  const seenCalls = new Set<string>();
  let currentModel = row.database_model ?? "<unknown>";
  let parseErrors = 0;

  await visitJsonLines(path, (record, line) => {
    if (record["__parse_error"] === true) {
      parseErrors += 1;
      return;
    }
    const timestamp = stringValue(record["timestamp"]);
    trackTimestamp(state, timestamp);
    const type = stringValue(record["type"]);
    const payload = asRecord(record["payload"]);
    const payloadType = stringValue(payload?.["type"]);

    if (type === "session_meta") {
      state.executionKind = asRecord(payload?.["source"])?.["subagent"]
        ? "subagent"
        : "top-level";
      state.executionKindsSeen.add(state.executionKind);
      return;
    }

    if (type === "turn_context") {
      currentModel = stringValue(payload?.["model"]) ?? currentModel;
      state.effort = stringValue(payload?.["effort"]) ?? state.effort;
      return;
    }
    if (type === "event_msg") {
      if (payloadType === "user_message") state.userTurns += 1;
      if (payloadType === "agent_message") state.assistantMessages += 1;
      if (payloadType === "task_started") state.taskStarts += 1;
      if (payloadType === "task_complete") state.taskCompletions += 1;
      if (payloadType === "context_compacted") state.compactions += 1;
      if (payloadType === "token_count") {
        const info = asRecord(payload?.["info"]);
        const total = asRecord(info?.["total_token_usage"]);
        if (total) {
          const last = asRecord(info?.["last_token_usage"]);
          const inputForRequest = nonNegativeNumberValue(last?.["input_tokens"]);
          state.maxInputTokensPerCall = Math.max(state.maxInputTokensPerCall, inputForRequest);
          state.maxContextWindow = Math.max(
            state.maxContextWindow,
            nonNegativeNumberValue(info?.["model_context_window"]),
          );
          tokenEvents.push({
            executionKind: state.executionKind,
            fingerprint: codexCounterFingerprint(total, last),
            inputForRequest,
            last: last ? codexUsage(last) : null,
            model: currentModel,
            timestamp,
            total: codexUsage(total),
          });
        }
      }
      return;
    }
    if (
      type === "response_item" &&
      (payloadType === "function_call" || payloadType === "custom_tool_call")
    ) {
      const callKey =
        stringValue(payload?.["call_id"]) ?? stringValue(payload?.["id"]) ?? `${line}`;
      if (seenCalls.has(callKey)) return;
      seenCalls.add(callKey);
      const transportName = stringValue(payload?.["name"]) ?? payloadType;
      increment(state.transportTools, transportName);
      const nested = payloadType === "custom_tool_call" ? nestedToolNames(payload?.["input"]) : [];
      if (nested.length === 0) {
        increment(state.tools, transportName);
      } else {
        for (const name of nested) increment(state.tools, name);
      }
    }
  });

  if (parseErrors > 0) state.warnings.push(`${parseErrors} malformed JSONL records were skipped.`);
  const finalTokens = zeroTokens();
  let previous = zeroTokens();
  let counterResets = 0;
  let sharedSnapshots = 0;
  let missingLastUsage = 0;
  for (const event of tokenEvents) {
    const reset = !monotonic(event.total, previous);
    if (reset) counterResets += 1;
    const fallbackDelta = reset ? event.total : tokenDelta(event.total, previous);
    previous = event.total;
    let observed = fallbackDelta;
    const owner = event.fingerprint ? counterLedger?.get(event.fingerprint) : undefined;
    if (event.last && tokenCount(event.last) > 0 && event.fingerprint) {
      if (
        (owner && (owner.path !== path || owner.timestamp !== event.timestamp)) ||
        claimedCounters.has(event.fingerprint)
      ) {
        sharedSnapshots += 1;
        continue;
      }
      claimedCounters.add(event.fingerprint);
      observed = event.last;
    } else {
      missingLastUsage += 1;
    }
    sumTokens(finalTokens, observed);
    if (tokenCount(observed) > 0) {
      const model = event.model === "<unknown>"
        ? owner?.modelFallback ?? event.model
        : event.model;
      addModelUsage(
        state,
        rateCard,
        model,
        observed,
        event.inputForRequest,
        event.timestamp,
        row.updated_at,
        event.executionKind,
      );
    }
  }
  if (counterResets > 0) {
    state.warnings.push(
      `${counterResets} cumulative token counter reset${counterResets === 1 ? " was" : "s were"} treated as a new observed segment.`,
    );
  }
  if (tokenEvents.length === 0) state.warnings.push("No cumulative Codex token counter was found.");
  if (sharedSnapshots > 0) {
    state.warnings.push(
      `${sharedSnapshots} repeated process-wide token snapshot${sharedSnapshots === 1 ? " was" : "s were"} excluded from this session.`,
    );
  }
  if (missingLastUsage > 0) {
    state.warnings.push(
      `${missingLastUsage} token event${missingLastUsage === 1 ? " lacks" : "s lack"} per-request usage and used a cumulative-counter fallback.`,
    );
  }
  state.warnings.push(
    "Codex does not expose cache-write tokens separately; the upper estimate treats all uncached input as cache writes.",
  );
  return finalizeSession(row, state, finalTokens, 1);
}

function claudeUsage(raw: JsonRecord): TokenUsage {
  const input = nonNegativeNumberValue(raw["input_tokens"]);
  const cacheRead = nonNegativeNumberValue(raw["cache_read_input_tokens"]);
  const cacheWrite = nonNegativeNumberValue(raw["cache_creation_input_tokens"]);
  const output = nonNegativeNumberValue(raw["output_tokens"]);
  const cacheCreation = asRecord(raw["cache_creation"]);
  let cacheWrite5m = nonNegativeNumberValue(cacheCreation?.["ephemeral_5m_input_tokens"]);
  const cacheWrite1h = nonNegativeNumberValue(cacheCreation?.["ephemeral_1h_input_tokens"]);
  if (cacheWrite > 0 && cacheWrite5m + cacheWrite1h === 0) cacheWrite5m = cacheWrite;
  return {
    cacheWrite1hInputTokens: cacheWrite1h,
    cacheWrite5mInputTokens: cacheWrite5m,
    cacheWriteInputTokens: cacheWrite,
    cachedInputTokens: cacheRead,
    inputTokens: input + cacheRead + cacheWrite,
    nonReasoningOutputTokens: output,
    outputTokens: output,
    reasoningOutputTokens: 0,
    uncachedInputTokens: input,
  };
}

function contentBlocks(message: JsonRecord | null): unknown[] {
  const content = message?.["content"];
  return Array.isArray(content) ? content : [];
}

async function claudeEvidencePaths(mainPath: string): Promise<string[]> {
  const subagentRoot = mainPath.slice(0, -".jsonl".length) + "/subagents";
  const paths = [mainPath];
  try {
    for await (const path of walkJsonl(subagentRoot)) paths.push(path);
  } catch (error) {
    const code = asRecord(error)?.["code"];
    if (code !== "ENOENT") throw error;
  }
  return paths;
}

async function analyzeClaude(
  row: SessionDatabaseRow,
  mainPath: string,
  rateCard: RateCard,
  inheritedWarnings: string[],
): Promise<SessionAnalytics> {
  const state = createMutableSession();
  state.effort = null;
  state.executionKind = "top-level";
  state.executionKindsSeen.add("top-level");
  state.warnings.push(...inheritedWarnings);
  state.warnings.push(
    "Claude usage does not expose reasoning output separately; it remains included in output.",
  );
  const paths = await claudeEvidencePaths(mainPath);
  const seenAssistantMessages = new Set<string>();
  const seenHumanMessages = new Set<string>();
  const seenToolCalls = new Set<string>();
  let parseErrors = 0;
  const totals = zeroTokens();

  for (const path of paths) {
    const executionKind = path === mainPath ? "top-level" : "subagent";
    state.executionKindsSeen.add(executionKind);
    await visitJsonLines(path, (record, line) => {
      if (record["__parse_error"] === true) {
        parseErrors += 1;
        return;
      }
      const timestamp = stringValue(record["timestamp"]);
      trackTimestamp(state, timestamp);
      const type = stringValue(record["type"]) ?? "";
      const subtype = stringValue(record["subtype"]) ?? "";
      const agentId = stringValue(record["agentId"]);
      if (agentId) state.delegatedAgents.add(agentId);
      if (type === "queue-operation") state.queueOperations += 1;
      if (type.includes("compact") || subtype.includes("compact")) state.compactions += 1;
      if (type.includes("summary") || subtype.includes("summary")) state.summaries += 1;

      const message = asRecord(record["message"]);
      if (type === "assistant" && message) {
        const messageId =
          stringValue(message["id"]) ?? stringValue(record["uuid"]) ?? `${path}:${line}`;
        if (!seenAssistantMessages.has(messageId)) {
          seenAssistantMessages.add(messageId);
          state.assistantMessages += 1;
          const usageRecord = asRecord(message["usage"]);
          if (usageRecord) {
            const usage = claudeUsage(usageRecord);
            if (tokenCount(usage) > 0) {
              const model = stringValue(message["model"]) ?? row.database_model ?? "<unknown>";
              sumTokens(totals, usage);
              addModelUsage(
                state,
                rateCard,
                model,
                usage,
                usage.inputTokens,
                timestamp,
                row.updated_at,
                executionKind,
              );
            }
          }
        }
        for (const rawBlock of contentBlocks(message)) {
          const block = asRecord(rawBlock);
          if (block?.["type"] !== "tool_use") continue;
          const toolId = stringValue(block["id"]) ?? `${path}:${line}`;
          if (seenToolCalls.has(toolId)) continue;
          seenToolCalls.add(toolId);
          const name = stringValue(block["name"]) ?? "tool_use";
          increment(state.tools, name);
          increment(state.transportTools, name);
        }
      }
      if (type === "user" && message) {
        const messageId = stringValue(record["uuid"]) ?? `${path}:${line}`;
        if (seenHumanMessages.has(messageId)) return;
        const content = message["content"];
        const humanContent =
          (typeof content === "string" && content.length > 0) ||
          contentBlocks(message).some((rawBlock) => asRecord(rawBlock)?.["type"] === "text");
        if (humanContent) {
          seenHumanMessages.add(messageId);
          state.userTurns += 1;
        }
      }
    });
  }
  if (parseErrors > 0) state.warnings.push(`${parseErrors} malformed JSONL records were skipped.`);
  return finalizeSession(row, state, totals, paths.length);
}

function finalizeSession(
  row: SessionDatabaseRow,
  state: MutableSession,
  tokens: TokenUsage,
  files: number,
): SessionAnalytics {
  const models = [...state.models.values()].sort((left, right) => right.totalUsd - left.totalUsd);
  const cost = zeroCost();
  let pricedTokens = 0;
  let priceEligibleTokens = 0;
  for (const model of models) {
    sumCost(cost, model);
    priceEligibleTokens += tokenCount(model);
    if (model.priced) pricedTokens += tokenCount(model);
  }
  const pricedTokenCoverage = priceEligibleTokens === 0 ? null : pricedTokens / priceEligibleTokens;
  const eventSpanMilliseconds = durationMilliseconds(state.firstEventAt, state.lastEventAt);
  const sessionDuration = durationMilliseconds(row.created_at, state.lastEventAt ?? row.updated_at);
  const toolCalls = Object.values(state.tools).reduce((sum, value) => sum + value, 0);
  const transportToolCalls = Object.values(state.transportTools).reduce(
    (sum, value) => sum + value,
    0,
  );
  const contextUtilizationPeak =
    state.maxContextWindow > 0 ? state.maxInputTokensPerCall / state.maxContextWindow : null;
  const executionKind =
    state.executionKindsSeen.size > 1
      ? "mixed"
      : ([...state.executionKindsSeen][0] ?? state.executionKind);
  for (const model of models) {
    if (model.model === "<unknown>") state.warnings.push("Provider history did not record a stable model ID; those tokens are excluded from API-equivalent spend coverage.");
    else if (!model.priced) state.warnings.push(`No rate card is configured for ${model.model}.`);
  }
  const metrics: SessionMetrics = {
    assistantMessages: state.assistantMessages,
    compactions: state.compactions,
    contextUtilizationPeak,
    delegatedAgents: state.delegatedAgents.size,
    durationMilliseconds: sessionDuration,
    eventSpanMilliseconds,
    maxContextWindow: state.maxContextWindow,
    maxInputTokensPerCall: state.maxInputTokensPerCall,
    modelCalls: models.reduce((sum, model) => sum + model.calls, 0),
    queueOperations: state.queueOperations,
    summaries: state.summaries,
    taskCompletions: state.taskCompletions,
    taskStarts: state.taskStarts,
    toolCalls,
    transportToolCalls,
    userTurns: state.userTurns,
  };
  return {
    cost,
    costBasis:
      row.agent_type === "cursor"
        ? cost.totalUsd > 0
          ? "provider-reported"
          : "unavailable"
        : "api-list-price-equivalent",
    costByExecution: { ...state.costByExecution },
    costComplete: pricedTokenCoverage === null || pricedTokenCoverage === 1,
    createdAt: row.created_at,
    effort: state.effort,
    executionKind,
    firstEventAt: state.firstEventAt,
    lastEventAt: state.lastEventAt,
    metrics,
    models,
    pricedTokenCoverage,
    provider: row.agent_type as SessionProvider,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    sessionKey: createHash("sha256").update(row.conductor_session_id).digest("hex").slice(0, 12),
    spendByDay: state.spendByDay,
    status: row.status,
    tokens,
    tools: state.tools,
    transcript: {
      files,
      snapshotWhileWorking: row.status === "working",
      status: "ok",
      warnings: [...new Set(state.warnings)],
    },
    transportTools: state.transportTools,
    updatedAt: row.updated_at,
  };
}

function unavailableSession(
  row: SessionDatabaseRow,
  status: "invalid" | "missing" | "unsupported",
  warnings: string[],
): SessionAnalytics {
  const state = createMutableSession();
  state.warnings.push(...warnings);
  const session = finalizeSession(row, state, zeroTokens(), 0);
  session.transcript.status = status;
  return session;
}

async function* walkJsonl(root: string): AsyncGenerator<string> {
  const directory = await opendir(root);
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonl(path);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield path;
    }
  }
}

async function* walkProviderTranscripts(
  root: string,
  provider: "claude" | "codex",
): AsyncGenerator<string> {
  const directory = await opendir(root);
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkProviderTranscripts(path, provider);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".jsonl") ||
        (provider === "claude" && /^local_[0-9a-f-]+\.json$/i.test(entry.name)))
    ) {
      yield path;
    }
  }
}

async function indexProviderTranscripts(
  root: string,
  ids: Set<string> | null,
  provider: "claude" | "codex",
): Promise<{ paths: Map<string, string[]>; warning: string | null }> {
  const index = new Map<string, string[]>();
  try {
    for await (const path of walkProviderTranscripts(root, provider)) {
      if (provider === "claude" && path.includes("/subagents/")) continue;
      if (provider === "claude" && basename(path) === "audit.jsonl") continue;
      const match = basename(path).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.(?:jsonl|json)$/i);
      const id = match?.[1];
      if (!id || (ids && !ids.has(id))) continue;
      const paths = index.get(id) ?? [];
      paths.push(path);
      index.set(id, paths);
    }
  } catch (error) {
    const code = asRecord(error)?.["code"];
    return {
      paths: index,
      warning:
        code === "ENOENT"
          ? "A provider transcript root is missing."
          : "A provider transcript root could not be read.",
    };
  }
  return { paths: index, warning: null };
}

function mergeTranscriptIndexes(
  indexes: Array<{ paths: Map<string, string[]>; warning: string | null }>,
): { paths: Map<string, string[]>; warning: string | null } {
  const paths = new Map<string, string[]>();
  for (const index of indexes) {
    for (const [id, candidates] of index.paths) {
      paths.set(id, [...new Set([...(paths.get(id) ?? []), ...candidates])]);
    }
  }
  const warnings = [...new Set(indexes.map(({ warning }) => warning).filter(Boolean))];
  return { paths, warning: warnings.length > 0 ? warnings.join(" ") : null };
}

async function transcriptCandidates(
  index: Map<string, string[]>,
  provider: "claude" | "codex",
): Promise<TranscriptCandidate[]> {
  const entries = [...index.entries()];
  // A session_meta record can contain several megabytes of prompt context.
  // Keep identity parsing deliberately narrow so concurrent JSON decoding does
  // not multiply that transient allocation during a machine-wide scan.
  const candidates = await mapConcurrent(entries, 2, async ([filenameId, paths]) => {
    for (const path of paths) {
      const identity = await transcriptIdentity(path, provider);
      if (identity.id === filenameId && identity.cwd) {
        return { cwd: identity.cwd, id: filenameId, path, provider, timestamp: identity.timestamp };
      }
    }
    return null;
  });
  return candidates.filter((candidate): candidate is TranscriptCandidate => candidate !== null);
}

async function gitRootForPath(rawPath: string): Promise<string | null> {
  let current = resolve(rawPath);
  const filesystemRoot = parse(current).root;
  while (true) {
    try {
      if (!(await stat(current)).isDirectory()) current = dirname(current);
      break;
    } catch {
      if (current === filesystemRoot) return null;
      current = dirname(current);
    }
  }
  const root = parse(current).root;
  while (true) {
    const marker = join(current, ".git");
    try {
      const markerStat = await stat(marker);
      if (markerStat.isDirectory()) return current;
      if (markerStat.isFile()) {
        const content = await readFile(marker, "utf8");
        const match = content.match(/^gitdir:\s*(.+)\s*$/m);
        const gitDirectory = match?.[1] ? resolve(current, match[1]) : null;
        const worktreeMarker = `${join(".git", "worktrees")}/`;
        const markerIndex = gitDirectory?.indexOf(worktreeMarker) ?? -1;
        if (gitDirectory && markerIndex >= 0) return gitDirectory.slice(0, markerIndex - 1);
        return current;
      }
    } catch {
      // Continue toward the filesystem root.
    }
    if (current === root) return null;
    current = dirname(current);
  }
}

function pathInside(path: string, root: string): boolean {
  const resolvedPath = resolve(path), resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

async function repositoryForPath(
  cwd: string,
  repositories: RepositoryRow[],
  workspaceRepositories: Map<string, RepositoryRow>,
  discovered: Map<string, RepositoryRow>,
): Promise<RepositoryRow> {
  const resolvedCwd = resolve(cwd);
  const workspaceMatch = workspaceRepositories.get(resolvedCwd);
  if (workspaceMatch) return workspaceMatch;
  const direct = repositories
    .filter(({ root_path }) => root_path && pathInside(resolvedCwd, root_path))
    .sort((left, right) => resolve(right.root_path).length - resolve(left.root_path).length)[0];
  if (direct) return direct;
  const workspaceParts = resolvedCwd.match(/\/conductor\/workspaces\/([^/]+)\//);
  const named = workspaceParts?.[1]
    ? repositories.find(({ name }) => name === workspaceParts[1])
    : null;
  if (named) return named;
  const gitRoot = await gitRootForPath(resolvedCwd);
  if (gitRoot) {
    const registered = repositories.find(({ root_path }) => resolve(root_path) === resolve(gitRoot));
    if (registered) return registered;
  }
  const ephemeralLocalPath =
    !gitRoot &&
    resolvedCwd.startsWith("/private/var/folders/") &&
    resolvedCwd.includes("/T/");
  const groupingRoot = ephemeralLocalPath
    ? "/private/var/folders/session-analytics-ephemeral"
    : gitRoot ?? resolvedCwd;
  const existing = discovered.get(groupingRoot);
  if (existing) return existing;
  const localKey = createHash("sha256").update(groupingRoot).digest("hex").slice(0, 4);
  const name = ephemeralLocalPath
    ? "Ephemeral automation sessions"
    : gitRoot
      ? basename(groupingRoot)
      : `${basename(groupingRoot) || "Local directory"} · ${localKey} (local directory)`;
  const repository: RepositoryRow = {
    default_branch: "",
    id: `discovered-${createHash("sha256").update(groupingRoot).digest("hex").slice(0, 20)}`,
    name,
    remote_url: null,
    root_path: groupingRoot,
  };
  discovered.set(groupingRoot, repository);
  return repository;
}

function syntheticSessionRow(
  provider: SessionProvider,
  id: string,
  cwd: string,
  timestamp: string,
  repository: RepositoryRow,
  status = "idle",
): SessionDatabaseRow {
  return {
    agent_type: provider,
    branch: null,
    conductor_session_id: `${provider}:${id}`,
    created_at: timestamp,
    database_model: null,
    default_branch: repository.default_branch,
    is_hidden: 0,
    provider_session_id: id,
    repository_id: repository.id,
    repository_name: repository.name,
    repository_remote: repository.remote_url ?? "",
    root_path: repository.root_path,
    status,
    title: "",
    updated_at: timestamp,
    workspace_name: null,
    workspace_path: cwd,
  };
}

async function analyzeTranscriptCandidate(
  candidate: TranscriptCandidate,
  repository: RepositoryRow,
  rateCard: RateCard,
  warnings: string[] = ["Discovered directly from the machine-wide provider transcript store."],
  codexCounterLedger: Map<string, CodexCounterOwner> | null = null,
  claimedCodexCounters: Set<string> = new Set<string>(),
): Promise<SessionAnalytics> {
  const timestamp = candidate.timestamp ?? new Date((await stat(candidate.path)).mtimeMs).toISOString();
  const row = syntheticSessionRow(candidate.provider, candidate.id, candidate.cwd, timestamp, repository);
  return candidate.provider === "codex"
    ? await analyzeCodex(row, candidate.path, rateCard, warnings, codexCounterLedger, claimedCodexCounters)
    : await analyzeClaude(row, candidate.path, rateCard, warnings);
}

function cursorPaths(data: JsonRecord): string[] {
  const paths = new Set<string>();
  const addPath = (value: string): void => {
    if (value.startsWith("file://")) {
      try { paths.add(decodeURIComponent(new URL(value).pathname)); } catch { /* Ignore invalid local URIs. */ }
    } else if (value.startsWith("/")) {
      paths.add(value);
    }
  };
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") { addPath(value); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    const record = asRecord(value);
    if (!record) return;
    for (const [key, item] of Object.entries(record)) {
      addPath(key);
      visit(item, depth + 1);
    }
  };
  for (const field of [
    "context",
    "conversation",
    "newlyCreatedFiles",
    "newlyCreatedFolders",
    "originalFileStates",
    "originalModelLines",
  ]) {
    visit(data[field]);
  }
  return [...paths];
}

function millisecondTimestamp(value: unknown): string | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < Date.parse("2000-01-01T00:00:00Z")
  ) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function cursorToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) names.push(item);
    const record = asRecord(item);
    const name = stringValue(record?.["name"]) ?? stringValue(record?.["type"]) ?? stringValue(record?.["capability"]);
    if (name) names.push(name);
  }
  return names;
}

function cursorModernTool(bubble: JsonRecord): { id: string; name: string } | null {
  const former = asRecord(bubble["toolFormerData"]);
  const id = stringValue(former?.["toolCallId"]);
  const name = stringValue(former?.["name"]);
  return id && name ? { id, name } : null;
}

function addCursorReportedCost(
  state: MutableSession,
  data: JsonRecord,
): number {
  const usageData = asRecord(data["usageData"]);
  let total = 0;
  for (const [model, rawUsage] of Object.entries(usageData ?? {})) {
    const usage = asRecord(rawUsage);
    const value = Math.max(0, numberValue(usage?.["costInCents"]) / 100);
    if (value === 0) continue;
    const aggregate: ModelUsage = {
      ...zeroTokens(),
      ...zeroCost(),
      calls: 0,
      model,
      priced: true,
      totalUsd: value,
      upperEstimateUsd: value,
    };
    state.models.set(model, aggregate);
    if (state.executionKind === "subagent") state.costByExecution.subagentUsd += value;
    else if (state.executionKind === "top-level") state.costByExecution.topLevelUsd += value;
    else state.costByExecution.unknownUsd += value;
    total += value;
  }
  return total;
}

function analyzeCursorComposer(
  data: JsonRecord,
  repository: RepositoryRow,
  cwd: string,
  executionKind: SessionAnalytics["executionKind"],
  conversationOverride?: unknown[],
): SessionAnalytics | null {
  const id = stringValue(data["composerId"]);
  const createdAt = millisecondTimestamp(data["createdAt"]);
  const conversation = conversationOverride ?? (Array.isArray(data["conversation"]) ? data["conversation"] : []);
  if (!id || !createdAt) return null;
  const updatedAt = millisecondTimestamp(data["lastUpdatedAt"]) ?? createdAt;
  const row = syntheticSessionRow("cursor", id, cwd, createdAt, repository, stringValue(data["status"]) ?? "idle");
  row.updated_at = updatedAt;
  const state = createMutableSession();
  state.executionKind = executionKind;
  state.executionKindsSeen.add(executionKind);
  const tokens = zeroTokens();
  let modelCalls = 0;
  const seenToolCalls = new Set<string>();
  trackTimestamp(state, createdAt);
  trackTimestamp(state, updatedAt);
  for (const rawBubble of conversation) {
    const bubble = asRecord(rawBubble);
    if (!bubble) continue;
    const type = numberValue(bubble["type"]);
    if (type === 1) state.userTurns += 1;
    if (type === 2) state.assistantMessages += 1;
    const timing = asRecord(bubble["timingInfo"]);
    trackTimestamp(state, millisecondTimestamp(timing?.["clientStartTime"]));
    trackTimestamp(state, millisecondTimestamp(timing?.["clientEndTime"]));
    const tokenCountRecord = asRecord(bubble["tokenCount"]);
    const input = nonNegativeNumberValue(tokenCountRecord?.["inputTokens"]), output = nonNegativeNumberValue(tokenCountRecord?.["outputTokens"]);
    if (input + output > 0) {
      tokens.inputTokens += input; tokens.uncachedInputTokens += input;
      tokens.outputTokens += output; tokens.nonReasoningOutputTokens += output;
      state.maxInputTokensPerCall = Math.max(state.maxInputTokensPerCall, input); modelCalls += 1;
    }
    const modernTool = cursorModernTool(bubble);
    if (modernTool && !seenToolCalls.has(modernTool.id)) {
      seenToolCalls.add(modernTool.id);
      increment(state.tools, modernTool.name);
      increment(state.transportTools, modernTool.name);
    }
    for (const name of cursorToolNames(bubble["capabilitiesRan"])) {
      increment(state.tools, name);
      increment(state.transportTools, name);
    }
  }
  const reportedCost = addCursorReportedCost(state, data);
  const session = finalizeSession(row, state, tokens, 1);
  session.metrics.modelCalls = modelCalls;
  if (reportedCost > 0) {
    session.transcript.warnings.push("Cursor usage value is read from the provider-reported local cost record; it is not inferred from a third-party rate card.");
  } else {
    session.transcript.warnings.push("Cursor retained session metadata without a provider-reported local cost record; no usage value is inferred.");
  }
  if (conversation.length === 0) {
    session.transcript.warnings.push("Cursor retained the session header and usage summary, but not detailed local conversation metrics.");
  }
  return session;
}

async function cursorHeaderWorkspaces(
  database: DatabaseSync,
  databasePath: string,
): Promise<Map<string, string>> {
  const candidates = new Map<string, { path: string; score: number }>();
  const workspaceStorage = join(dirname(dirname(databasePath)), "workspaceStorage");
  const workspacePath = async (workspaceId: string): Promise<string | null> => {
    try {
      const workspace = asRecord(
        JSON.parse(await readFile(join(workspaceStorage, workspaceId, "workspace.json"), "utf8")),
      );
      const uri = stringValue(workspace?.["folder"]) ?? stringValue(workspace?.["workspace"]);
      if (!uri) return null;
      const path = uri.startsWith("file://") ? decodeURIComponent(new URL(uri).pathname) : uri;
      return path.startsWith("/") ? path : null;
    } catch {
      return null;
    }
  };
  const assign = (composerId: string, path: string, score: number): void => {
    const current = candidates.get(composerId);
    if (!current || score > current.score || (score === current.score && path < current.path)) {
      candidates.set(composerId, { path, score });
    }
  };

  const workspaceIds: string[] = [];
  try {
    const directory = await opendir(workspaceStorage);
    for await (const entry of directory) if (entry.isDirectory()) workspaceIds.push(entry.name);
  } catch {
    // Global headers below are still useful when workspace storage is unavailable.
  }
  await mapConcurrent(workspaceIds.sort(), 6, async (workspaceId) => {
    const path = await workspacePath(workspaceId);
    if (!path) return;
    let workspaceDatabase: DatabaseSync | null = null;
    try {
      workspaceDatabase = new DatabaseSync(join(workspaceStorage, workspaceId, "state.vscdb"), {
        readOnly: true,
      });
      const row = workspaceDatabase
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        .get() as { value?: string } | undefined;
      const parsed = asRecord(JSON.parse(row?.value ?? "null"));
      const headers = Array.isArray(parsed?.["allComposers"]) ? parsed["allComposers"] : [];
      for (const rawHeader of headers) {
        const header = asRecord(rawHeader);
        const composerId = stringValue(header?.["composerId"]);
        if (!composerId) continue;
        assign(composerId, path, numberValue(header?.["lastUpdatedAt"]));
      }
    } catch {
      // Continue with every other workspace and the global header fallback.
    } finally {
      workspaceDatabase?.close();
    }
  });

  try {
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")
      .get() as { value?: string } | undefined;
    const parsed = asRecord(JSON.parse(row?.value ?? "null"));
    const headers = Array.isArray(parsed?.["allComposers"]) ? parsed["allComposers"] : [];
    await mapConcurrent(headers, 8, async (rawHeader) => {
      const header = asRecord(rawHeader);
      const composerId = stringValue(header?.["composerId"]);
      const workspaceId = stringValue(asRecord(header?.["workspaceIdentifier"])?.["id"]);
      if (!composerId || !workspaceId) return;
      const path = await workspacePath(workspaceId);
      if (path) assign(composerId, path, numberValue(header?.["lastUpdatedAt"]));
    });
  } catch {
    // Older Cursor stores do not expose global composer headers.
  }
  return new Map([...candidates].map(([composerId, { path }]) => [composerId, path]));
}

export async function cursorSessions(
  databasePath: string,
  repositories: RepositoryRow[],
  workspaceRepositories: Map<string, RepositoryRow>,
  discovered: Map<string, RepositoryRow>,
): Promise<{ sessions: SessionAnalytics[]; warning: string | null }> {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const composerStatement = database.prepare(
      "SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
    );
    const headerWorkspaces = await cursorHeaderWorkspaces(database, databasePath);
    const bubbleStatement = database.prepare(
      "SELECT value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key",
    );
    const results: SessionAnalytics[] = [];
    for (const { value } of composerStatement.iterate() as Iterable<{ value: string }>) {
      let data: JsonRecord | null = null;
      try { data = asRecord(JSON.parse(value)); } catch { continue; }
      if (!data || !stringValue(data["composerId"]) || !millisecondTimestamp(data["createdAt"])) continue;
      const id = stringValue(data["composerId"]) as string;
      const conversation = Array.isArray(data["conversation"]) ? [...data["conversation"]] : [];
      const modernBubbles = bubbleStatement
        .all(`bubbleId:${id}:`, `bubbleId:${id};`) as Array<{ value: string }>;
      if (modernBubbles.length > 0) {
        const seen = new Set(
          conversation
            .map((bubble) => stringValue(asRecord(bubble)?.["bubbleId"]) ?? stringValue(asRecord(bubble)?.["id"]))
            .filter((bubbleId): bubbleId is string => Boolean(bubbleId)),
        );
        for (const { value } of modernBubbles) {
          let bubble: JsonRecord | null = null;
          try { bubble = asRecord(JSON.parse(value)); } catch { continue; }
          if (!bubble) continue;
          const bubbleId = stringValue(bubble["bubbleId"]) ?? stringValue(bubble["id"]);
          if (bubbleId && seen.has(bubbleId)) continue;
          if (bubbleId) seen.add(bubbleId);
          conversation.push(bubble);
        }
      }
      const paths = cursorPaths(data);
      const headerPath = headerWorkspaces.get(id);
      if (headerPath) paths.push(headerPath);
      let cwd = join(homedir(), ".cursor", "unassigned");
      for (const path of paths) {
        const gitRoot = await gitRootForPath(path);
        if (gitRoot) { cwd = gitRoot; break; }
        if (cwd.endsWith("/.cursor/unassigned")) cwd = path.endsWith(".code-workspace") ? dirname(path) : path;
      }
      const repository = await repositoryForPath(cwd, repositories, workspaceRepositories, discovered);
      const executionKind =
        data["isBestOfNSubcomposer"] === true || Boolean(data["subagentInfo"])
          ? "subagent"
          : "top-level";
      const session = analyzeCursorComposer(data, repository, cwd, executionKind, conversation);
      if (session) results.push(session);
    }
    return { sessions: results, warning: null };
  } catch (error) {
    const code = asRecord(error)?.["code"];
    return { sessions: [], warning: code === "ENOENT" ? null : "Cursor local session history could not be read." };
  } finally {
    database?.close();
  }
}

async function cursorSessionsSerialized(
  databasePath: string,
  repositories: RepositoryRow[],
  workspaceRepositories: Map<string, RepositoryRow>,
): Promise<string> {
  return await new Promise<string>((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, ["--max-old-space-size=192", fileURLToPath(new URL("./cursor-worker.ts", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
    child.once("error", rejectWorker);
    child.once("close", (code) => {
      if (code !== 0) {
        void errorOutput;
        rejectWorker(new Error("Cursor analysis process exited before returning a result."));
        return;
      }
      resolveWorker(output);
    });
    child.stdin.end(JSON.stringify({
      databasePath,
      repositories,
      workspaceRepositories: [...workspaceRepositories],
    }));
  });
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function sessionRows(database: DatabaseSync, repositoryIds: string[], includeHidden: boolean) {
  if (repositoryIds.length === 0) return [];
  const placeholders = repositoryIds.map(() => "?").join(", ");
  const rows = database
    .prepare(`
      SELECT
        s.id AS conductor_session_id,
        s.status,
        s.agent_type,
        s.title,
        s.created_at,
        s.updated_at,
        s.claude_session_id AS provider_session_id,
        s.model AS database_model,
        s.is_hidden,
        w.workspace_name,
        w.workspace_path,
        w.branch,
        r.id AS repository_id,
        r.name AS repository_name,
        r.root_path,
        r.remote_url AS repository_remote,
        r.default_branch
      FROM sessions AS s
      JOIN workspaces AS w ON w.id = s.workspace_id
      JOIN repos AS r ON r.id = w.repository_id
      WHERE r.id IN (${placeholders}) AND (? = 1 OR s.is_hidden = 0)
      ORDER BY datetime(s.created_at) DESC
    `)
    .all(...repositoryIds, includeHidden ? 1 : 0);
  return rows as unknown as SessionDatabaseRow[];
}

function chooseRepository(
  repositories: RepositoryRow[],
  repositoryName: string | undefined,
  repositoryRemote: string,
): RepositoryRow {
  if (repositoryName) {
    const matches = repositories.filter(({ name }) => name === repositoryName);
    if (matches.length === 1 && matches[0]) return matches[0];
    if (matches.length > 1) throw new Error(`Several repositories are named ${repositoryName}.`);
    throw new Error(`No evidenced repository is named ${repositoryName}.`);
  }
  const normalized = normalizeRemote(repositoryRemote);
  const matches = repositories.filter(
    ({ remote_url }) => remote_url && normalizeRemote(remote_url) === normalized,
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length === 0) {
    throw new Error("The requested Git remote does not match an evidenced repository.");
  }
  throw new Error("The requested Git remote matches more than one evidenced repository.");
}

function selectRepositories(
  repositories: RepositoryRow[],
  options: AnalyzeOptions,
): RepositoryRow[] {
  if (options.repositoryId) {
    const repository = repositories.find(({ id }) => id === options.repositoryId);
    if (!repository) throw new Error("No evidenced repository has the requested ID.");
    return [repository];
  }
  if (options.repositoryName) {
    return [chooseRepository(repositories, options.repositoryName, options.repositoryRemote ?? "")];
  }
  if (options.repositoryRemote) {
    return [chooseRepository(repositories, undefined, options.repositoryRemote)];
  }
  if (options.repositoryRoot) {
    const canonicalRoot = resolve(options.repositoryRoot);
    const matches = repositories.filter(({ root_path }) => resolve(root_path) === canonicalRoot);
    if (matches.length !== 1 || !matches[0]) {
      throw new Error(
        matches.length === 0
          ? "No evidenced repository has the requested root."
          : "The requested root matches more than one evidenced repository.",
      );
    }
    return [matches[0]];
  }
  return repositories;
}

function mergeModelUsage(target: Map<string, ModelUsage>, source: ModelUsage): void {
  let aggregate = target.get(source.model);
  if (!aggregate) {
    aggregate = { ...zeroTokens(), ...zeroCost(), calls: 0, model: source.model, priced: true };
    target.set(source.model, aggregate);
  }
  aggregate.calls += source.calls;
  aggregate.priced = aggregate.priced && source.priced;
  sumTokens(aggregate, source);
  sumCost(aggregate, source);
}

function aggregate(
  repository: RepositoryRow,
  sessions: SessionAnalytics[],
  rateCard: RateCard,
): RepositoryAnalytics {
  const totalTokens = zeroTokens();
  const spendByDay: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const models = new Map<string, ModelUsage>();
  let estimatedSpendUsd = 0;
  let estimatedUpperSpendUsd = 0;
  let apiEquivalentSpendUsd = 0;
  let providerReportedSpendUsd = 0;
  let subagentSpendUsd = 0;
  let topLevelSpendUsd = 0;
  let pricedTokens = 0;
  let allTokens = 0;
  let compactions = 0;
  for (const session of sessions) {
    sumTokens(totalTokens, session.tokens);
    estimatedSpendUsd += session.cost.totalUsd;
    estimatedUpperSpendUsd += session.cost.upperEstimateUsd;
    if (session.costBasis === "api-list-price-equivalent") apiEquivalentSpendUsd += session.cost.totalUsd;
    if (session.costBasis === "provider-reported") providerReportedSpendUsd += session.cost.totalUsd;
    subagentSpendUsd += session.costByExecution.subagentUsd;
    topLevelSpendUsd += session.costByExecution.topLevelUsd;
    compactions += session.metrics.compactions;
    if (session.pricedTokenCoverage !== null) {
      allTokens += tokenCount(session.tokens);
      pricedTokens += tokenCount(session.tokens) * session.pricedTokenCoverage;
    }
    for (const [day, value] of Object.entries(session.spendByDay)) increment(spendByDay, day, value);
    for (const [name, value] of Object.entries(session.tools)) increment(tools, name, value);
    for (const model of session.models) mergeModelUsage(models, model);
  }
  const analyzedSessions = sessions.filter(({ transcript }) => transcript.status === "ok").length;
  const missingTranscripts = sessions.filter(({ transcript }) => transcript.status === "missing").length;
  const inputDenominator =
    totalTokens.uncachedInputTokens +
    totalTokens.cachedInputTokens +
    totalTokens.cacheWriteInputTokens;
  const named = (record: Record<string, number>): NamedMetric[] =>
    Object.entries(record)
      .map(([name, value]) => ({ name, value }))
      .sort((left, right) => right.value - left.value);
  const warnings: string[] = [];
  const missingProviderIds = sessions.filter(
    ({ transcript }) =>
      transcript.status === "missing" &&
      transcript.warnings.includes("Conductor has no provider session ID."),
  ).length;
  const unmatchedTranscripts = missingTranscripts - missingProviderIds;
  if (missingProviderIds > 0) {
    warnings.push(
      `${missingProviderIds} legacy session${missingProviderIds === 1 ? "" : "s"} cannot be correlated because Conductor recorded no provider session ID.`,
    );
  }
  if (unmatchedTranscripts > 0) {
    warnings.push(
      `${unmatchedTranscripts} session${unmatchedTranscripts === 1 ? "" : "s"} have a provider ID but no validated local transcript.`,
    );
  }
  const unpricedSessions = sessions.filter(({ costComplete }) => !costComplete).length;
  if (unpricedSessions > 0) warnings.push(`${unpricedSessions} sessions include models without a rate card.`);
  return {
    generatedAt: new Date().toISOString(),
    rateCard: {
      currency: rateCard.currency,
      effectiveDate: rateCard.effectiveDate,
      models: Object.entries(rateCard.models).map(([model, { source }]) => ({ model, source })),
    },
    repository: {
      id: repository.id,
      name: repository.name,
    },
    sessions,
    spendByDay: named(spendByDay).sort((left, right) => left.name.localeCompare(right.name)),
    spendByModel: [...models.values()].sort((left, right) => right.totalUsd - left.totalUsd),
    summary: {
      analyzedSessions,
      apiEquivalentSpendUsd,
      cacheReadRatio:
        inputDenominator === 0 ? 0 : totalTokens.cachedInputTokens / inputDenominator,
      compactions,
      estimatedSpendUsd,
      estimatedUpperSpendUsd,
      missingTranscripts,
      outputTokens: totalTokens.outputTokens,
      pricedTokenCoverage: allTokens === 0 ? null : pricedTokens / allTokens,
      providerReportedSpendUsd,
      sessions: sessions.length,
      subagentSessions: sessions.filter(({ executionKind }) => executionKind === "subagent" || executionKind === "mixed").length,
      subagentSpendUsd,
      topLevelSessions: sessions.filter(({ executionKind }) => executionKind === "top-level" || executionKind === "mixed").length,
      topLevelSpendUsd,
      toolCalls: Object.values(tools).reduce((sum, value) => sum + value, 0),
      totalInputTokens: totalTokens.inputTokens,
      unpricedSessions,
    },
    topTools: named(tools),
    warnings,
  };
}

async function analyzeSelectedRepositories(
  options: AnalyzeOptions,
): Promise<{ rateCard: RateCard; repositories: RepositoryAnalytics[] }> {
  const databasePath =
    options.databasePath ?? join(homedir(), "Library/Application Support/com.conductor.app/conductor.db");
  const rateCard = await loadRateCard(options.rateCardPath);
  let database: DatabaseSync | null = null;
  try {
    await stat(databasePath);
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    const code = asRecord(error)?.["code"];
    if (code !== "ENOENT") {
      throw new Error("The optional repository metadata database is unavailable.");
    }
  }
  try {
    const explicitRepositoryFilter = Boolean(
      options.repositoryId || options.repositoryName || options.repositoryRemote || options.repositoryRoot,
    );
    const includeHidden = options.includeHidden ?? !explicitRepositoryFilter;
    const availableRepositories = database
      ? database
          .prepare(
            `SELECT id, name, root_path, remote_url, default_branch
             FROM repos
             WHERE (? = 1 OR hidden = 0)
             ORDER BY lower(name), id`,
          )
          .all(includeHidden ? 1 : 0) as unknown as RepositoryRow[]
      : [];
    const rows = database
      ? sessionRows(database, availableRepositories.map(({ id }) => id), includeHidden)
      : [];
    const repositoryById = new Map(availableRepositories.map((repository) => [repository.id, repository]));
    const workspaceRepositories = new Map<string, RepositoryRow>();
    for (const row of rows) {
      const repository = repositoryById.get(row.repository_id);
      if (repository) workspaceRepositories.set(resolve(row.workspace_path), repository);
    }
    const discovered = new Map<string, RepositoryRow>();
    // Keep Cursor's hydrated composer objects serialized until the much larger
    // Codex and Claude transcript pass has finished. Retaining both object
    // graphs at once needlessly pushes machine-wide scans over V8's heap limit.
    const cursorSerialized = await cursorSessionsSerialized(
      options.cursorDatabasePath ?? join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
      availableRepositories,
      workspaceRepositories,
    );
    const codexRoots = [options.codexRoot ?? join(homedir(), ".codex/sessions")];
    if (options.codexArchiveRoot || !options.codexRoot) {
      codexRoots.push(options.codexArchiveRoot ?? join(homedir(), ".codex/archived_sessions"));
    }
    const claudeRoots = [options.claudeRoot ?? join(homedir(), ".claude/projects")];
    if (!options.claudeRoot) {
      claudeRoots.push(join(homedir(), "Library/Application Support/Claude/local-agent-mode-sessions"));
    }
    const [codexIndexes, claudeIndexes] = await Promise.all([
      Promise.all(codexRoots.map((root) => indexProviderTranscripts(root, null, "codex"))),
      Promise.all(claudeRoots.map((root) => indexProviderTranscripts(root, null, "claude"))),
    ]);
    const codexIndex = mergeTranscriptIndexes(codexIndexes);
    const claudeIndex = mergeTranscriptIndexes(claudeIndexes);
    const [codexCandidates, claudeCandidates] = await Promise.all([
      transcriptCandidates(codexIndex.paths, "codex"),
      transcriptCandidates(claudeIndex.paths, "claude"),
    ]);
    const codexCounterLedger = await buildCodexCounterLedger(
      codexCandidates.map(({ path }) => path),
    );
    const claimedCodexCounters = new Set<string>();
    const candidates = [...codexCandidates, ...claudeCandidates];
    const claimed = new Set<string>();
    const registeredOwners = new Set<string>();
    const registeredRows = rows.filter((row) => {
      if (!row.provider_session_id || (row.agent_type !== "codex" && row.agent_type !== "claude")) return Boolean(row.provider_session_id);
      const key = `${row.agent_type}:${row.provider_session_id}`;
      if (registeredOwners.has(key)) return false;
      registeredOwners.add(key);
      return true;
    });
    const analyzedRows = await mapConcurrent(registeredRows, 1, async (row) => {
      if (row.agent_type !== "codex" && row.agent_type !== "claude") {
        return unavailableSession(row, "unsupported", [
          `Unsupported Conductor agent type: ${row.agent_type || "unknown"}.`,
        ]);
      }
      const provider = row.agent_type as SessionProvider;
      const index = provider === "codex" ? codexIndex.paths : claudeIndex.paths;
      const selected = await selectTranscript(
        index.get(row.provider_session_id as string) ?? [],
        provider,
        row.provider_session_id as string,
        row.workspace_path,
      );
      if (!selected.path) {
        // Provider transcript stores are the canonical evidence source. A stale
        // Conductor row without a matching transcript is not an analyzable
        // session and must not inflate machine totals or coverage warnings.
        return null;
      }
      try {
        const session = provider === "codex"
          ? await analyzeCodex(row, selected.path, rateCard, selected.warnings, codexCounterLedger, claimedCodexCounters)
          : await analyzeClaude(row, selected.path, rateCard, selected.warnings);
        claimed.add(`${provider}:${row.provider_session_id}`);
        return session;
      } catch (error) {
        void error;
        return unavailableSession(row, "invalid", [
          "Transcript parsing failed without exposing local error details.",
        ]);
      }
    });
    const recovered = await mapConcurrent(rows.filter(({ provider_session_id, agent_type }) =>
      !provider_session_id && (agent_type === "codex" || agent_type === "claude")), 1, async (row) => {
      const matches = candidates.filter((candidate) => {
        if (candidate.provider !== row.agent_type || claimed.has(`${candidate.provider}:${candidate.id}`)) return false;
        if (resolve(candidate.cwd) !== resolve(row.workspace_path) || !candidate.timestamp) return false;
        return Math.abs(Date.parse(candidate.timestamp) - Date.parse(row.created_at)) <= 15 * 60_000;
      });
      if (matches.length !== 1 || !matches[0]) return null;
      const candidate = matches[0]; claimed.add(`${candidate.provider}:${candidate.id}`);
      try {
        return candidate.provider === "codex"
          ? await analyzeCodex(row, candidate.path, rateCard, ["Recovered from a unique working-directory and start-time match in the provider transcript store."], codexCounterLedger, claimedCodexCounters)
          : await analyzeClaude(row, candidate.path, rateCard, ["Recovered from a unique working-directory and start-time match in the provider transcript store."]);
      } catch { return null; }
    });
    const discoveredSessions = await mapConcurrent(candidates.filter((candidate) =>
      !claimed.has(`${candidate.provider}:${candidate.id}`)), 1, async (candidate) => {
      const repository = await repositoryForPath(candidate.cwd, availableRepositories, workspaceRepositories, discovered);
      try { return await analyzeTranscriptCandidate(candidate, repository, rateCard, undefined, codexCounterLedger, claimedCodexCounters); } catch { return null; }
    });
    let cursorResult: { sessions: SessionAnalytics[]; warning: string | null };
    try {
      const cursorEnvelope = JSON.parse(cursorSerialized) as {
        discovered: RepositoryRow[];
        sessions: SessionAnalytics[];
        warning: string | null;
      };
      for (const repository of cursorEnvelope.discovered) {
        discovered.set(repository.root_path, repository);
      }
      cursorResult = {
        sessions: cursorEnvelope.sessions,
        warning: cursorEnvelope.warning,
      };
    } catch {
      throw new Error("Cursor analysis returned an invalid result.");
    }
    const allRepositories = [...availableRepositories, ...discovered.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const selectedRepositories = selectRepositories(allRepositories, options);
    const selectedIds = new Set(selectedRepositories.map(({ id }) => id));
    const allSessions = [
      ...analyzedRows.filter((session): session is SessionAnalytics => session !== null),
      ...recovered.filter((session): session is SessionAnalytics => session !== null),
      ...discoveredSessions.filter((session): session is SessionAnalytics => session !== null),
      ...cursorResult.sessions,
    ];
    const sessions = explicitRepositoryFilter
      ? allSessions.filter(({ repositoryId }) => selectedIds.has(repositoryId))
      : allSessions;
    const sessionsByRepository = new Map<string, SessionAnalytics[]>();
    for (const session of sessions) {
      const repositorySessions = sessionsByRepository.get(session.repositoryId) ?? [];
      repositorySessions.push(session);
      sessionsByRepository.set(session.repositoryId, repositorySessions);
    }
    const repositoriesForOutput = selectedRepositories;
    return {
      rateCard,
      repositories: repositoriesForOutput.map((repository) => {
        const result = aggregate(repository, sessionsByRepository.get(repository.id) ?? [], rateCard);
        result.warnings.push(
          ...[codexIndex.warning, claudeIndex.warning, cursorResult.warning].filter(
            (warning): warning is string => Boolean(warning),
          ),
        );
        result.warnings = [...new Set(result.warnings)];
        return result;
      }),
    };
  } finally {
    database?.close();
  }
}

function aggregateMachine(
  repositories: RepositoryAnalytics[],
  rateCard: RateCard,
): MachineAnalytics {
  const sessions = repositories.flatMap(({ sessions: repositorySessions }) => repositorySessions);
  const combined = aggregate(
    {
      default_branch: "",
      id: "all-local-repositories",
      name: "All local repositories",
      remote_url: null,
      root_path: "",
    },
    sessions,
    rateCard,
  );
  return {
    generatedAt: combined.generatedAt,
    rateCard: combined.rateCard,
    repositories: repositories.map(
      ({ repository, spendByDay, spendByModel, summary, topTools, warnings }) => ({
        repository,
        spendByDay,
        spendByModel,
        summary,
        topTools,
        warnings,
      }),
    ),
    sessions,
    spendByDay: combined.spendByDay,
    spendByModel: combined.spendByModel,
    summary: {
      ...combined.summary,
      repositories: repositories.length,
      repositoriesWithSessions: repositories.filter(({ summary }) => summary.sessions > 0).length,
      workingSnapshots: sessions.filter(({ transcript }) => transcript.snapshotWhileWorking).length,
    },
    topTools: combined.topTools,
    warnings: [
      ...new Set([
        ...combined.warnings,
        ...repositories.flatMap(({ warnings }) =>
          warnings.filter((warning) => warning.startsWith("A provider transcript root")),
        ),
      ]),
    ],
  };
}

/** Analyze every locally evidenced repository unless an explicit repository filter is supplied. */
export async function analyzeMachineSessions(
  options: AnalyzeOptions = {},
): Promise<MachineAnalytics> {
  const result = await analyzeSelectedRepositories(options);
  return aggregateMachine(result.repositories, result.rateCard);
}

/** Backward-compatible single-repository entry point for callers that intentionally narrow scope. */
export async function analyzeRepositorySessions(
  options: AnalyzeOptions,
): Promise<RepositoryAnalytics> {
  if (
    !options.repositoryId &&
    !options.repositoryName &&
    !options.repositoryRemote &&
    !options.repositoryRoot
  ) {
    throw new Error(
      "Repository analysis requires --repo-name, --repo-remote, or --repo-root. Use analyzeMachineSessions for the machine-wide view.",
    );
  }
  const result = await analyzeSelectedRepositories(options);
  const repository = result.repositories[0];
  if (!repository) throw new Error("No evidenced repository matched the requested filter.");
  return repository;
}
