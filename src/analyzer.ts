import { claudeProfileResolver, collectHistoryCoverage } from "./metrics/history-coverage.ts";
import { calibrateRecovery, type RecoveryComparison } from "./metrics/recovery-calibration.ts";
import { createHash } from "node:crypto";
import { canonicalizeRemote, repositoryRemoteAtRoot } from "./repository-remotes.ts";
import { spawn } from "node:child_process";
import { createReadStream, realpathSync } from "node:fs";
import { opendir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { readJsonLines } from "./jsonl-lines.ts";
import type { DatabaseSync } from "node:sqlite";
import { openSourceDatabase } from "./source-database.ts";
import { fileURLToPath } from "node:url";

import {
  VelocityAccumulator, claudeEntrypoint, claudeSubagentType, codexOriginator, codexSource, counterExposed,
  publicModelId, usageVelocity, velocityDimension, velocityMetadata, zeroVelocity,
} from "./metrics/velocity.ts";
import { claudeContextWindow } from "./metrics/context-windows.ts";
import { CompactionCounter } from "./metrics/compactions.ts";
import { boundedTimestamp } from "./metrics/bounded-time.ts";
import { TranscriptLifecycle, sameVersion } from "./metrics/transcript-lifecycle.ts";
import { publicModel } from "./public-model.ts";

import { aggregateSessions } from "./public/export-data.js";
import { normalizeTimestamp, timestampMilliseconds } from "./public/timestamps.js";
import { modelPattern, metadataPattern, sessionStatuses, scanWarnings, indexParityWarning } from "./public/evidence.js";
import { McpEvidenceCollector } from "./mcp/evidence.ts";
import { sourceHealth } from "./mcp/source-health.ts";

import { IndexScan } from "./store/index.ts";
import { IndexParityError } from "./store/parity.ts";
import { INDEX_INTEGRITY } from "./store/database.ts";
import { codexCounterFingerprint, readCodexLedger } from "./store/codex-ledger.ts";
import { codexIntervalKey, codexIntervalCovered } from "./metrics/codex-counter-intervals.ts";

import type {
  AgentIdentity, ClaudeSubagentType, VelocityDimension,
  AnalyzeOptions,
  RateCard,
  CostBreakdown,
  ModelRate,
  ModelUsage,
  MachineAnalytics,
  RepositoryAnalytics,
  SessionAnalytics,
  SessionDatabaseRow,
  SessionMetrics,
  SessionProvider,
  SessionStatus,
  TokenUsage,
} from "./types.ts";

import { desktopMetadataPath } from "./providers/claude-desktop.ts";
import { createClaudeAdapter } from "./providers/claude.ts";
import { buildClaudeUsageOwners, type ClaudeUsageOwners } from "./providers/claude-ownership.ts";
import { mapConcurrent } from "./concurrency.ts";
import { track } from "./processes.ts";
import { additionalProviderSessions } from "./providers/index.ts";
import { modelName, name as safeName, effortName, safeTime, statusName } from "./providers/common.ts";
import { conductorFallback, conductorLegacyProviderIds } from "./providers/conductor.ts";
import { loadReviewed, loadPricingCatalog, mergeProvenance, publicRateCard, resolveRate, type PricingCatalog } from "./pricing/catalog.ts";
import { projectModelId } from "./public/model-id.js";
import { priceUsage } from "./pricing/usage.ts";
import { moduleUrl } from "./module-url.ts";
import { workerExitMessage } from "./store/errors.ts";

const publicMetadataName = new RegExp(metadataPattern);
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
  compactionReceipt?: boolean;
  nativeCumulative?: TokenUsage | null;
  turnKey?: string | null;
  dimension: VelocityDimension;
  lastReasoningExposed: boolean;
  lastCacheReadExposed: boolean;
  totalReasoningExposed: boolean;
  totalCacheReadExposed: boolean;
  stream: string;
  evidence: RequestEvidence;
  requestSizeKnown: boolean;
  executionKind: SessionAnalytics["executionKind"];
  fingerprint: string | null;
  last: TokenUsage | null;
  model: string;
  timestamp: string | null;
  total: TokenUsage;
  inputForRequest: number;
}

interface CodexCounterLedger extends Map<string, CodexCounterOwner> {
  inheritedCallKeysByPath?: Map<string, Set<string>>;
}
interface CodexCounterOwner {
  nativeReceipt?: boolean;
  identityKey?: string;
  ancestorKeys?: string[];
  createdAt?: string | null;
  /** Earliest evidence of this state, independently of nearest-activity ranking. */
  earliestTimestamp?: string;
  activityDeltaMilliseconds: number;
  modelFallback: string | null;
  path: string;
  timestamp: string;
}

interface TranscriptCandidate {
  repositoryRemote?: string | null;
  /** All validated Codex pages; never crosses the public projection. */
  paths?: string[];
  cwd: string;
  id: string;
  path: string;
  provider: "claude" | "codex";
  timestamp: string | null;
}

/** Per-request context evidence; only native Claude and Codex requests carry it. */
export interface RequestEvidence {
  contextWindow: number | null;
  requestInputKnown: boolean;
}

export interface MutableSession {
  agentIdentity: AgentIdentity;
  velocity: VelocityAccumulator;
  startDimension: VelocityDimension | null;
  /** Native providers reconcile compaction boundaries and context fill; others keep their own counters. */
  requestProvider: "claude" | "codex" | null;
  compactionCounter: CompactionCounter;
  contextUtilizationPeak: number | null;
  /** Deduplicated native Claude request tokens per UTC day and model, for history coverage. */
  historyDays: Map<string, { day: string; model: string; tokens: number }>;
  completeness: "complete" | "partial" | "unknown";
  liveness: "inactive" | "active" | "unknown";
  mcpEvidence: McpEvidenceCollector;
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
  key = safeName(key) ?? "unknown_tool";
  target[key] = (Object.hasOwn(target, key) ? target[key]! : 0) + amount;
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

function isoDay(timestamp: string | null): string | null {
  const instant = timestampMilliseconds(timestamp);
  return Number.isFinite(instant) ? new Date(instant).toISOString().slice(0, 10) : null;
}

function trackTimestamp(session: MutableSession, timestamp: string | null): void {
  const instant = timestampMilliseconds(timestamp);
  if (!Number.isFinite(instant)) return;
  const normalized = new Date(instant).toISOString();
  if (!session.firstEventAt || instant < Date.parse(session.firstEventAt)) session.firstEventAt = normalized;
  if (!session.lastEventAt || instant > Date.parse(session.lastEventAt)) session.lastEventAt = normalized;
}

function normalizeRemote(value: string): string {
  return canonicalizeRemote(value) ?? "";
}

function durationMilliseconds(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  const startValue = timestampMilliseconds(start);
  const endValue = timestampMilliseconds(end);
  return Number.isFinite(startValue) && Number.isFinite(endValue)
    ? Math.max(0, endValue - startValue)
    : 0;
}

export async function loadRateCard(path?: string | URL): Promise<RateCard> {
  return (await loadReviewed(path)).card;
}
export function calculateCost(rate: ModelRate, usage: TokenUsage, inputForRequest: number): CostBreakdown {
  return priceUsage(rate, usage, inputForRequest).cost;
}

function addModelUsage(
  session: MutableSession,
  rateCard: PricingCatalog,
  model: string,
  usage: TokenUsage,
  inputForRequest: number,
  timestamp: string | null,
  _fallbackTimestamp: string,
  executionKind: SessionAnalytics["executionKind"] = session.executionKind,
  velocityContext?: { dimension: VelocityDimension; reasoning: boolean; cacheRead: boolean; cacheWrite: boolean },
  requestEvidence?: RequestEvidence,
  requestSizeKnown = true,
  calls = 1,
): void {
  timestamp = normalizeTimestamp(timestamp);
  model = projectModelId(model);
  if (requestSizeKnown) session.maxInputTokensPerCall = Math.max(session.maxInputTokensPerCall, inputForRequest);
  let aggregate = session.models.get(model);
  if (!aggregate) {
    aggregate = {
      ...zeroTokens(),
      ...zeroCost(),
      calls: 0,
      model,
      priced: true,
      pricing: [],
      pricingCoverage: { pricedTokens: 0, eligibleTokens: 0 },
    };
    session.models.set(model, aggregate);
  }
  aggregate.calls += calls;
  sumTokens(aggregate, usage);
  aggregate.pricingCoverage!.eligibleTokens += tokenCount(usage);
  const selected = resolveRate(rateCard, model, timestamp);
  const pricedRequest = selected ? priceUsage(selected.rate, usage, inputForRequest) : null;
  const accountingDay = isoDay(timestamp);
  session.mcpEvidence.usage(accountingDay ?? "", tokenCount(usage), pricedRequest?.pricedTokens ?? 0);
  if (requestEvidence && session.requestProvider) {
    // Peak fill pairs each request's input with its reported window, or a reviewed Claude capacity.
    const reportedWindow = requestEvidence.contextWindow !== null && requestEvidence.contextWindow > 0 ? requestEvidence.contextWindow : null;
    const window = reportedWindow ?? (session.requestProvider === "claude" ? claudeContextWindow(publicModel(model)) : null);
    if (requestEvidence.requestInputKnown && window) {
      session.contextUtilizationPeak = Math.max(session.contextUtilizationPeak ?? 0, usage.inputTokens / window);
    }
    const day = session.requestProvider === "claude" ? boundedTimestamp(timestamp)?.slice(0, 10) : undefined;
    if (day) {
      const historyModel = publicModel(model), key = `${day}:${historyModel}`;
      const row = session.historyDays.get(key) ?? { day, model: historyModel, tokens: 0 };
      row.tokens += tokenCount(usage); session.historyDays.set(key, row);
    }
    if (requestEvidence.requestInputKnown) {
      session.maxInputTokensPerCall = Math.max(session.maxInputTokensPerCall, usage.inputTokens);
      session.maxContextWindow = Math.max(session.maxContextWindow,
        requestEvidence.contextWindow ?? (session.requestProvider === "claude" ? claudeContextWindow(model) : null) ?? 0);
    }
  }
  if (velocityContext && !selected) session.velocity.add(timestamp, velocityContext.dimension, usageVelocity(usage, 0, 0, velocityContext, calls));
  if (!selected) {
    aggregate.priced = false;
    return;
  }
  const { cost, pricedTokens, assumptions } = pricedRequest!;
  if (calls === 0 && selected.rate.longContext) {
    cost.upperEstimateUsd = Math.max(cost.upperEstimateUsd, priceUsage(selected.rate, usage, selected.rate.longContext.thresholdInputTokens + 1).cost.upperEstimateUsd);
  }
  mergeProvenance(aggregate, [{ ...selected.provenance, assumptions }]);
  aggregate.pricingCoverage!.pricedTokens += pricedTokens;
  aggregate.priced &&= pricedTokens === tokenCount(usage);
  if (velocityContext) session.velocity.add(timestamp, velocityContext.dimension, usageVelocity(usage, cost.totalUsd, pricedTokens, velocityContext, calls));
  sumCost(aggregate, cost);
  if (executionKind === "subagent") session.costByExecution.subagentUsd += cost.totalUsd;
  else if (executionKind === "top-level") session.costByExecution.topLevelUsd += cost.totalUsd;
  else session.costByExecution.unknownUsd += cost.totalUsd;
  // Undated request value belongs only in all-time totals and velocity.undated.
  if (accountingDay) increment(session.spendByDay, accountingDay, cost.totalUsd);
}

function createMutableSession(): MutableSession {
  return {
    agentIdentity: {},
    velocity: new VelocityAccumulator(),
    startDimension: null,
    requestProvider: null,
    compactionCounter: new CompactionCounter(),
    contextUtilizationPeak: null,
    historyDays: new Map(),
    completeness: "unknown",
    liveness: "unknown",
    mcpEvidence: new McpEvidenceCollector(),
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
  const lines = readJsonLines(input);
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let record: JsonRecord | null;
    try { record = asRecord(JSON.parse(line)); }
    catch {
      // The caller reports a single bounded warning instead of returning transcript content.
      visitor({ __parse_error: true }, lineNumber);
      continue;
    }
    if (record) visitor(record, lineNumber);
    else visitor({ __parse_error: true }, lineNumber);
  }
}

async function transcriptIdentity(
  path: string,
  provider: SessionProvider,
): Promise<{ cwd: string | null; id: string | null; timestamp: string | null; parentId?: string | null; forkCreatedAt?: string | null; repositoryRemote?: string | null }> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = readJsonLines(input);
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
      return { cwd: stringValue(payload?.["cwd"]), id: stringValue(payload?.["id"]), timestamp: normalizeTimestamp(record["timestamp"]),
        repositoryRemote: stringValue(asRecord(payload?.["git"])?.["repository_url"]),
        forkCreatedAt: normalizeTimestamp(payload?.["timestamp"]) ?? normalizeTimestamp(record["timestamp"]),
        parentId: stringValue(payload?.["forked_from_id"]) ?? stringValue(asRecord(asRecord(asRecord(payload?.["source"])?.["subagent"])?.["thread_spawn"])?.["parent_thread_id"]) };
    }
    if (provider === "claude") {
      claudeId ??= stringValue(record["sessionId"]);
      claudeCwd ??= stringValue(record["cwd"]);
      claudeTimestamp ??= normalizeTimestamp(record["timestamp"]);
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
): Promise<{ path: string | null; paths: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const matching: Array<{ path: string; timestamp: string | null; cwdMatches: boolean }> = [];
  for (const candidate of candidates) {
    const identity = await transcriptIdentity(candidate, provider);
    if (identity.id === providerSessionId) matching.push({ path: candidate, timestamp: identity.timestamp, cwdMatches: identity.cwd === workspacePath });
  }
  matching.sort((a, b) => Number(a.path.includes("/subagents/")) - Number(b.path.includes("/subagents/")) || (a.timestamp ?? "").localeCompare(b.timestamp ?? "") || a.path.localeCompare(b.path));
  const hasPrimary = provider === "claude" && matching.some(item => !item.path.includes("/subagents/"));
  const selected = matching.find(item => item.cwdMatches && (!hasPrimary || !item.path.includes("/subagents/")));
  if (selected) return { path: selected.path, paths: matching.map(item => item.path), warnings };
  if (matching.length) warnings.push("Transcript ID matched, but its recorded working directory did not.");
  else if (candidates.length) warnings.push("Transcript filename matched, but provider metadata validation failed.");
  return { path: null, paths: [], warnings };
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
  // An observed ancestor request predating child creation is copied history.
  if (candidate.createdAt && current.identityKey && candidate.ancestorKeys?.includes(current.identityKey) && current.timestamp < candidate.createdAt) return false;
  if (current.createdAt && candidate.identityKey && current.ancestorKeys?.includes(candidate.identityKey) && candidate.timestamp < current.createdAt) return true;
  if (candidate.activityDeltaMilliseconds !== current.activityDeltaMilliseconds) {
    return candidate.activityDeltaMilliseconds < current.activityDeltaMilliseconds;
  }
  if (candidate.timestamp !== current.timestamp) return candidate.timestamp < current.timestamp;
  return candidate.path < current.path;
}

async function buildCodexCounterLedger(
  paths: string[], index: IndexScan | null = null,
  retainedOwners: Map<string, { path: string; timestamp: string; modelFallback: string | null }> = new Map(),
): Promise<Map<string, CodexCounterOwner>> {
  const owners: CodexCounterLedger = new Map<string, CodexCounterOwner>();
  const identities = new Map<string, Awaited<ReturnType<typeof transcriptIdentity>>>();
  const parents = new Map<string, string>();
  for (const path of paths) {
    const identity = await transcriptIdentity(path, "codex"); identities.set(path, identity);
    if (identity.id && identity.parentId) parents.set(identity.id, identity.parentId);
  }
  const ancestorsOf = (id: string | null): Set<string> => {
    const result = new Set<string>(); let parent = id ? parents.get(id) : null;
    while (parent && !result.has(parent)) { result.add(parent); parent = parents.get(parent); }
    return result;
  };
  const ancestorIds = new Set(parents.values());
  const ancestorStates = new Map<string, Map<string, string>>();
  const ancestorCalls = new Map<string, Array<{ key: string; timestamp: string | null }>>();
  const nativeReceipts: Array<{ fingerprint: string; key: string; owner: CodexCounterOwner }> = [];
  owners.inheritedCallKeysByPath = new Map();
  const ordered = [...paths].sort((a, b) => ancestorsOf(identities.get(a)?.id ?? null).size - ancestorsOf(identities.get(b)?.id ?? null).size || a.localeCompare(b));
  for (const path of ordered) {
    const identity = identities.get(path)!;
    const ancestors = ancestorsOf(identity.id);
    const created = identity.forkCreatedAt ?? identity.timestamp;
    const evidence = index ? await index.codexLedger(path) : (await readCodexLedger(path)).evidence;
    const modelFallback = evidence.models.length === 1 ? evidence.models[0] ?? null : null;
    const inherited = new Set<string>();
    // Only calls physically present in this page can be replayed by it. Keeping
    // every ancestor call for every descendant grows with the entire fork tree.
    const observedCalls = new Set((evidence.calls ?? []).map(call => call.key));
    if (created && observedCalls.size) for (const ancestor of ancestors) for (const call of ancestorCalls.get(ancestor) ?? []) {
      if (observedCalls.has(call.key) && call.timestamp && call.timestamp < created) inherited.add(call.key);
    }
    owners.inheritedCallKeysByPath.set(path, inherited);
    if (identity.id && ancestorIds.has(identity.id)) ancestorCalls.set(identity.id, [...(ancestorCalls.get(identity.id) ?? []), ...(evidence.calls ?? [])]);
    for (const observation of evidence.observations) {
      const earliestTimestamp = observation.earliestTimestamp ?? observation.timestamp;
      if (identity.id && ancestorIds.has(identity.id)) {
        const states = ancestorStates.get(identity.id) ?? new Map<string, string>();
        if (!states.has(observation.fingerprint) || earliestTimestamp < states.get(observation.fingerprint)!) states.set(observation.fingerprint, earliestTimestamp);
        ancestorStates.set(identity.id, states);
      }
      const replay = created && [...ancestors].some(ancestor => {
        const earlier = ancestorStates.get(ancestor)?.get(observation.fingerprint);
        return earlier && earlier < created;
      });
      const candidate = { activityDeltaMilliseconds: observation.activityDeltaMilliseconds ?? Infinity, modelFallback, path, timestamp: observation.timestamp, earliestTimestamp };
      if (!replay && codexCounterOwnerPrecedes(candidate, owners.get(observation.fingerprint))) owners.set(observation.fingerprint, candidate);
    }
    for (const receipt of evidence.receipts ?? []) nativeReceipts.push({ ...receipt,
      owner: { path, timestamp: receipt.timestamp, modelFallback, activityDeltaMilliseconds: -1, nativeReceipt: true } });
  }
  for (const receipt of nativeReceipts) {
    if (owners.has(receipt.fingerprint)) owners.set(receipt.fingerprint, receipt.owner);
    owners.set(receipt.key, receipt.owner);
  }
  for (const [fingerprint, owner] of retainedOwners) owners.set(fingerprint, { ...owner, activityDeltaMilliseconds: -1 });
  for (const [fingerprint, owner] of owners) {
    if (index?.isPrunedCounter(fingerprint)) owners.set(fingerprint, { ...owner, path: "pruned", timestamp: "", activityDeltaMilliseconds: -1 });
  }
  index?.setCounterDependencies(owners);
  return owners;
}

async function analyzeCodex(
  row: SessionDatabaseRow,
  path: string,
  rateCard: PricingCatalog,
  inheritedWarnings: string[],
  counterLedger: Map<string, CodexCounterOwner> | null = null,
  claimedCounters: Set<string> = new Set<string>(),
  index: IndexScan | null = null,
  attributedCounters: Set<string> | null = null,
  isPrunedCounter: (fingerprint: string) => boolean = () => false,
  evidencePaths: string[] = [path],
): Promise<SessionAnalytics | null> {
  if (index) {
    const attributed = new Set<string>();
    return index.session(row, evidencePaths, inheritedWarnings,
      () => analyzeCodex(row, path, rateCard, inheritedWarnings, counterLedger, claimedCounters, null, attributed, (counter) => index.isPrunedCounter(counter), evidencePaths),
      claimedCounters, counterLedger, attributed, evidencePaths.map(page => [...((counterLedger as CodexCounterLedger | null)?.inheritedCallKeysByPath?.get(page) ?? [])].sort()));
  }
  const state = createMutableSession();
  state.requestProvider = "codex";
  const mcpEvidence = state.mcpEvidence;
  state.warnings.push(...inheritedWarnings);
  const tokenEvents: TokenEvent[] = [];
  let intervalScope: string | null = null, threadCreatedAt: string | null = null;
  const intervalAncestors = new Set<string>();
  const receiptEvents = new Map<string, TokenEvent>();
  const compactionReceipts = new Set<string>();
  const modelsByTurn = new Map<string, string>();
  let currentTurn: string | null = null;
  let ownThread: string | null = null;
  const usageMatchKey = (turn: string | null | undefined, usage: TokenUsage): string => JSON.stringify([
    turn ?? null, usage.inputTokens, usage.cachedInputTokens,
    usage.outputTokens, usage.reasoningOutputTokens,
  ]);
  const seenCalls = new Set<string>();
  let currentModel = projectModelId(row.database_model);
  let currentIdentity: AgentIdentity = {};
  const sourceBefore = await Promise.all(evidencePaths.map((page) => stat(page)));
  const lifecycle = new TranscriptLifecycle();
  let parseErrors = 0;
  // Codex has recorded the same lifecycle events in several shapes over time:
  // legacy `event_msg` notifications, `item_completed` items, and top-level
  // `compacted` records. A file can carry more than one shape for the same
  // event. Turns/messages use the largest shape count; compaction boundaries
  // are reconciled individually by the compaction counter.
  const legacy = { agentMessages: 0, compactions: 0, userMessages: 0 };
  const compactedRecords = { count: 0 };
  const items = {
    agentMessages: new Set<string>(),
    compactions: new Set<string>(),
    userMessages: new Set<string>(),
  };

  let lineOffset = 0;
  for (const path of evidencePaths) {
  let pageLines = 0;
  await visitJsonLines(path, (record, pageLine) => {
    pageLines = pageLine;
    const line = lineOffset + pageLine;
    const inherited = (counterLedger as CodexCounterLedger | null)?.inheritedCallKeysByPath?.get(path);
    if (record["type"] === "response_item" && inherited?.size) {
      const item = asRecord(record["payload"]), id = stringValue(item?.["call_id"]) ?? stringValue(item?.["id"]);
      if (id && inherited.has(createHash("sha256").update(id).digest("hex"))) return;
    }
    mcpEvidence.codex(record);
    if (record["__parse_error"] === true) {
      parseErrors += 1;
      return;
    }
    // A spawned/forked rollout may replay its parent's session_meta after its
    // own header. Foreign metadata describes inherited context, not a source
    // transition of this thread. Preserve legitimate same-thread upgrades.
    if (record["type"] === "session_meta") {
      const metadataThreadId = stringValue(asRecord(record["payload"])?.["id"]);
      const expectedThread = ownThread ?? row.provider_session_id;
      if (metadataThreadId && expectedThread && metadataThreadId !== expectedThread) return;
    }
    const timestamp = normalizeTimestamp(record["timestamp"]);
    lifecycle.observe("codex", record);
    trackTimestamp(state, timestamp);
    const type = stringValue(record["type"]);
    const payload = asRecord(record["payload"]);
    const payloadType = stringValue(payload?.["type"]);

    if (type === "session_meta") {
      ownThread ??= stringValue(payload?.["id"]);
      if (!intervalScope) {
        const parent = asRecord(asRecord(asRecord(payload?.["source"])?.["subagent"])?.["thread_spawn"]);
        for (const id of [stringValue(payload?.["forked_from_id"]), stringValue(parent?.["parent_thread_id"])]) if (id) intervalAncestors.add(id);
        intervalScope = createHash("sha256").update(intervalAncestors.values().next().value ?? ownThread ?? row.conductor_session_id).digest("hex");
        threadCreatedAt = normalizeTimestamp(payload?.["timestamp"]) ?? timestamp;
      }
      currentIdentity = { codexSource: codexSource(payload?.["source"]), codexOriginator: codexOriginator(payload?.["originator"]) };
      if (!state.agentIdentity.codexSource) state.agentIdentity = currentIdentity;
      state.executionKind = asRecord(payload?.["source"])?.["subagent"]
        ? "subagent"
        : "top-level";
      state.executionKindsSeen.add(state.executionKind);
      return;
    }

    if (type === "turn_context") {
      currentTurn = stringValue(payload?.["turn_id"]) ?? currentTurn;
      if (payload && Object.hasOwn(payload, "model")) currentModel = projectModelId(payload["model"]);
      if (currentTurn) modelsByTurn.set(currentTurn, currentModel);
      state.effort = effortName(payload?.["effort"]) ?? state.effort;
      state.startDimension ??= velocityDimension("codex", currentIdentity, state.executionKind, currentModel, state.effort);
      return;
    }
    // Explicit receipts identify individual billable responses, including
    // compaction requests that never enter the legacy cumulative counter.
    if (type === "token_usage_record" || (type === "event_msg" && payloadType === "token_usage_record")) {
      const usage = asRecord(payload?.["usage"]);
      const thread = stringValue(payload?.["thread_id"]);
      const response = stringValue(payload?.["response_id"]);
      const turnKey = stringValue(payload?.["turn_id"]);
      if (!usage || !thread || !response || (ownThread && thread !== ownThread)) return;
      if (!counterExposed(usage["input_tokens"]) || !counterExposed(usage["output_tokens"])) return;
      const key = `receipt:${createHash("sha256").update(JSON.stringify([thread, response])).digest("hex")}`;
      if (receiptEvents.has(key)) return;
      const tokens = codexUsage(usage);
      const model = (turnKey ? modelsByTurn.get(turnKey) : null) ?? currentModel;
      receiptEvents.set(key, {
        nativeCumulative: asRecord(payload?.["thread_token_usage"]) ? codexUsage(asRecord(payload?.["thread_token_usage"])) : null,
        turnKey, dimension: velocityDimension("codex", currentIdentity, state.executionKind, model, state.effort),
        lastReasoningExposed: counterExposed(usage["reasoning_output_tokens"]),
        lastCacheReadExposed: counterExposed(usage["cached_input_tokens"]),
        totalReasoningExposed: false, totalCacheReadExposed: false,
        stream: path, evidence: { contextWindow: null, requestInputKnown: true },
        requestSizeKnown: true, executionKind: state.executionKind, fingerprint: null,
        inputForRequest: tokens.inputTokens, last: tokens, model, timestamp, total: zeroTokens(),
      });
      return;
    }
    if (type === "compacted") {
      const response = stringValue(payload?.["compaction_response_id"]);
      if (response && ownThread) compactionReceipts.add(`receipt:${createHash("sha256").update(JSON.stringify([ownThread, response])).digest("hex")}`);
      compactedRecords.count += 1;
      state.compactionCounter.add(path, "compacted", stringValue(record["id"]) ?? stringValue(payload?.["id"]), timestamp);
      return;
    }
    if (type === "event_msg") {
      if (payloadType === "user_message") legacy.userMessages += 1;
      if (payloadType === "agent_message") legacy.agentMessages += 1;
      if (payloadType === "task_started") {
        state.taskStarts += 1;
        currentTurn = stringValue(payload?.["turn_id"]) ?? currentTurn;
      }
      if (payloadType === "task_complete") state.taskCompletions += 1;
      if (payloadType === "context_compacted") {
        legacy.compactions += 1;
        state.compactionCounter.add(path, "legacy", stringValue(payload?.["id"]), timestamp);
      }
      if (payloadType === "item_completed") {
        const item = asRecord(payload?.["item"]);
        const itemId = stringValue(item?.["id"]) ?? `${line}`;
        const itemType = stringValue(item?.["type"]);
        if (itemType === "UserMessage") items.userMessages.add(itemId);
        if (itemType === "AgentMessage") items.agentMessages.add(itemId);
        if (itemType === "ContextCompaction") {
          items.compactions.add(itemId);
          state.compactionCounter.add(path, "item", stringValue(item?.["id"]), timestamp);
        }
      }
      if (payloadType === "token_count") {
        const info = asRecord(payload?.["info"]);
        const total = asRecord(info?.["total_token_usage"]);
        if (total) {
          const last = asRecord(info?.["last_token_usage"]);
          const inputForRequest = nonNegativeNumberValue(last?.["input_tokens"]);
          state.maxContextWindow = Math.max(
            state.maxContextWindow,
            nonNegativeNumberValue(info?.["model_context_window"]),
          );
          tokenEvents.push({
            turnKey: currentTurn,
            dimension: velocityDimension("codex", currentIdentity, state.executionKind, currentModel, state.effort),
            lastReasoningExposed: counterExposed(last?.["reasoning_output_tokens"]),
            lastCacheReadExposed: counterExposed(last?.["cached_input_tokens"]),
            totalReasoningExposed: counterExposed(total["reasoning_output_tokens"]),
            totalCacheReadExposed: counterExposed(total["cached_input_tokens"]),
            stream: path,
            evidence: { contextWindow: nonNegativeNumberValue(info?.["model_context_window"]) || null,
              requestInputKnown: typeof last?.["input_tokens"] === "number" && Number.isFinite(last["input_tokens"]) && last["input_tokens"] >= 0 },
            requestSizeKnown: typeof last?.["input_tokens"] === "number" && Number.isFinite(last["input_tokens"]) && last["input_tokens"] >= 0,
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
      state.velocity.tool(timestamp, velocityDimension("codex", currentIdentity, state.executionKind, currentModel, state.effort), Math.max(1, nested.length));
      if (nested.length === 0) {
        increment(state.tools, transportName);
      } else {
        for (const name of nested) increment(state.tools, name);
      }
    }
  });
  lineOffset += pageLines;
  }

  state.userTurns = Math.max(legacy.userMessages, items.userMessages.size);
  state.assistantMessages = Math.max(legacy.agentMessages, items.agentMessages.size);
  state.compactions = Math.max(legacy.compactions, compactedRecords.count, items.compactions.size);
  if (parseErrors > 0) state.warnings.push(`${parseErrors} malformed JSONL records were skipped.`);
  const finalTokens = zeroTokens();
  let previous = zeroTokens();
  let previousReasoningExposed = false, previousCacheReadExposed = false;
  let baselined = false;
  let counterResets = 0, repeatedAfterDecrease = 0, unprovenCrossFileCollisions = 0;
  const observedEpochs = new Map<string, number>();
  let sharedSnapshots = 0;
  let missingLastUsage = 0;
  let unattributableBaselines = 0;
  const accountedLegacy = new Map<string, number>();
  const accountedLegacyAcrossTurns = new Map<string, number>();
  let previousStream: string | null = null;
  for (const event of tokenEvents) {
    // Cumulative-only baselines must never cross file boundaries.
    if (previousStream !== event.stream) {
      previous = zeroTokens(); baselined = false;
      previousReasoningExposed = false; previousCacheReadExposed = false;
      previousStream = event.stream;
    }
    const reset = !monotonic(event.total, previous);
    if (reset) counterResets += 1;
    const priorEpoch = event.fingerprint ? observedEpochs.get(event.fingerprint) : undefined;
    const repeatedInLaterEpoch = priorEpoch !== undefined && priorEpoch < counterResets;
    if (event.fingerprint) observedEpochs.set(event.fingerprint, counterResets);
    // A Codex cumulative counter is process-wide, so the first snapshot a file
    // observes - and the first after the counter moves backwards - already
    // contains requests this session never issued. Only the delta between two
    // snapshots this file actually observed is attributable to it; charging a
    // whole counter to one event bills an entire process history to a single
    // session and a single calendar day.
    const attributableDelta = baselined && !reset
      ? tokenDelta(event.total, previous)
      : zeroTokens();
    // A difference has a known breakdown only if both endpoints expose it.
    let exposure = {
      reasoning: baselined && !reset && previousReasoningExposed && event.totalReasoningExposed,
      cacheRead: baselined && !reset && previousCacheReadExposed && event.totalCacheReadExposed,
    };
    const intervalStart = previous;
    previous = event.total;
    previousReasoningExposed = event.totalReasoningExposed;
    previousCacheReadExposed = event.totalCacheReadExposed;
    baselined = true;
    let observed = attributableDelta;
    const owner = event.fingerprint ? counterLedger?.get(event.fingerprint) : undefined;
    if (event.last && tokenCount(event.last) > 0 && event.fingerprint) {
      if (
        owner?.nativeReceipt || isPrunedCounter(event.fingerprint) ||
        (owner && (owner.path !== event.stream || owner.timestamp !== event.timestamp)) ||
        claimedCounters.has(event.fingerprint)
      ) {
        if (repeatedInLaterEpoch && !isPrunedCounter(event.fingerprint)) repeatedAfterDecrease++;
        if (owner && !owner.nativeReceipt && owner.path !== "pruned" && !evidencePaths.includes(owner.path)) unprovenCrossFileCollisions++;
        sharedSnapshots += 1;
        continue;
      }
      claimedCounters.add(event.fingerprint);
      attributedCounters?.add(event.fingerprint);
      observed = event.last;
      exposure = { reasoning: event.lastReasoningExposed, cacheRead: event.lastCacheReadExposed };
    } else {
      // Even a present all-zero last record is unusable: this is a cumulative
      // observation, with no evidenced request size for context or pricing.
      event.evidence.requestInputKnown = false;
      missingLastUsage += 1;
      if (event.fingerprint && tokenCount(attributableDelta) > 0 && (isPrunedCounter(event.fingerprint) ||
          (owner && (owner.path !== event.stream || owner.timestamp !== event.timestamp)) || claimedCounters.has(event.fingerprint))) {
        sharedSnapshots++; continue;
      }
      if (tokenCount(attributableDelta) > 0 && [...receiptEvents].some(([key, receipt]) =>
          compactionReceipts.has(key) && receipt.nativeCumulative && receipt.last &&
          usageMatchKey(null, receipt.nativeCumulative) === usageMatchKey(null, event.total) &&
          usageMatchKey(null, receipt.last) === usageMatchKey(null, attributableDelta))) {
        sharedSnapshots++; continue;
      }
      if (tokenCount(attributableDelta) > 0) {
        const intervalKey = `${intervalScope ?? "unknown"}:${codexIntervalKey(intervalStart, event.total)}`;
        const eligibleFingerprints = function* (): Generator<string> {
          if (!event.timestamp || !counterLedger) return;
          for (const [fingerprint, owner] of counterLedger) {
            if (owner.timestamp > event.timestamp) continue;
            if (owner.path === event.stream) { yield fingerprint; continue; }
            const id = basename(owner.path).match(/([0-9a-f]{8}-[0-9a-f-]{27})(?:_[0-9a-f]{8}-[0-9a-f-]{27})?\.jsonl$/i)?.[1];
            if (id && intervalAncestors.has(id) && threadCreatedAt && (owner.earliestTimestamp ?? owner.timestamp) < threadCreatedAt) yield fingerprint;
          }
        };
        const covered = codexIntervalCovered(intervalStart, event.total, eligibleFingerprints());
        if (claimedCounters.has(intervalKey) || covered) { sharedSnapshots++; continue; }
        claimedCounters.add(intervalKey); attributedCounters?.add(intervalKey);
      }
      if (event.fingerprint && tokenCount(attributableDelta) > 0) {
        if (isPrunedCounter(event.fingerprint) ||
          (owner && (owner.path !== event.stream || owner.timestamp !== event.timestamp)) ||
          claimedCounters.has(event.fingerprint)) {
          sharedSnapshots += 1;
          continue;
        }
        claimedCounters.add(event.fingerprint);
        attributedCounters?.add(event.fingerprint);
      }
      if (tokenCount(attributableDelta) === 0 && tokenCount(event.total) > 0) {
        unattributableBaselines += 1;
      }
    }
    sumTokens(finalTokens, observed);
    if (tokenCount(observed) > 0) {
      const matchKey = usageMatchKey(event.turnKey, observed);
      accountedLegacy.set(matchKey, (accountedLegacy.get(matchKey) ?? 0) + 1);
      const usageKey = usageMatchKey(null, observed);
      accountedLegacyAcrossTurns.set(usageKey, (accountedLegacyAcrossTurns.get(usageKey) ?? 0) + 1);
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
        { dimension: { ...event.dimension, model }, ...exposure, cacheWrite: false },
        event.evidence,
        Boolean(event.last && tokenCount(event.last) > 0 && event.requestSizeKnown),
      );
    }
  }
  // First consume exact-turn counterparts. A selected repeated counter may
  // arrive after the context moved to another turn, so reconcile remaining
  // same-thread usage vectors in a second pass. Every counter funds one match.
  const unmatchedReceipts: TokenEvent[] = [];
  for (const [receiptKey, event] of receiptEvents) {
    if (!event.last || tokenCount(event.last) === 0 || claimedCounters.has(receiptKey) || isPrunedCounter(receiptKey)) continue;
    claimedCounters.add(receiptKey);
    attributedCounters?.add(receiptKey);
    if (compactionReceipts.has(receiptKey)) { event.compactionReceipt = true; unmatchedReceipts.push(event); continue; }
    const matchKey = usageMatchKey(event.turnKey, event.last);
    const matches = accountedLegacy.get(matchKey) ?? 0;
    if (matches > 0) {
      accountedLegacy.set(matchKey, matches - 1);
      const usageKey = usageMatchKey(null, event.last);
      accountedLegacyAcrossTurns.set(usageKey, (accountedLegacyAcrossTurns.get(usageKey) ?? 0) - 1);
      continue;
    }
    unmatchedReceipts.push(event);
  }
  for (const event of unmatchedReceipts) {
    const usage = event.last!;
    const usageKey = usageMatchKey(null, usage);
    const matches = accountedLegacyAcrossTurns.get(usageKey) ?? 0;
    if (matches > 0 && !event.compactionReceipt) {
      accountedLegacyAcrossTurns.set(usageKey, matches - 1);
      continue;
    }
    sumTokens(finalTokens, usage);
    const model = (event.turnKey ? modelsByTurn.get(event.turnKey) : null) ?? event.model;
    addModelUsage(state, rateCard, model, usage, event.inputForRequest, event.timestamp,
      row.updated_at, event.executionKind,
      { dimension: { ...event.dimension, model }, reasoning: event.lastReasoningExposed,
        cacheRead: event.lastCacheReadExposed, cacheWrite: false }, event.evidence, true);
  }
  if (counterResets > 0) {
    state.warnings.push(
      `${counterResets} cumulative token counter reset${counterResets === 1 ? " was" : "s were"} re-baselined as a new observed segment.`,
    );
  }
  if (tokenEvents.length === 0 && receiptEvents.size === 0) state.warnings.push("No cumulative Codex token counter was found.");
  if (sharedSnapshots > 0) {
    state.warnings.push(
      `${sharedSnapshots} repeated process-wide token snapshot${sharedSnapshots === 1 ? " was" : "s were"} excluded from this session.`,
    );
  }
  if (missingLastUsage > 0) {
    state.warnings.push(
      `${missingLastUsage} token event${missingLastUsage === 1 ? " lacks" : "s lack"} per-request usage; only deltas between snapshots this session observed were counted.`,
    );
  }
  if (unattributableBaselines > 0) {
    state.warnings.push(
      `${unattributableBaselines} process-wide counter baseline${unattributableBaselines === 1 ? " was" : "s were"} excluded because the requests inside it were not observed by this session.`,
    );
  }
  state.warnings.push(
    "Codex does not expose cache-write tokens separately; the upper estimate treats all uncached input as cache writes.",
  );
  if (unprovenCrossFileCollisions) state.warnings.push("Accounting may be incomplete: matching numeric token states across evidence files were excluded without a proven process/request identity. Distinct requests can have identical counters.");
  if (repeatedAfterDecrease) state.warnings.push("Accounting may be incomplete: a repeated numeric token state after a counter decrease was excluded without a proven reset/request identity. The decrease alone cannot distinguish a new request from replay.");
  const sourceAfter = await Promise.all(evidencePaths.map((page) => stat(page)));
  state.completeness = parseErrors || unprovenCrossFileCollisions || repeatedAfterDecrease || sourceBefore.some((before, i) => !sameVersion(before, sourceAfter[i]!)) ? "partial" : "complete";
  state.liveness = lifecycle.liveness();
  return finalizeSession(row, state, finalTokens, evidencePaths.length);
}

const claudeAdapter = createClaudeAdapter({
  createMutableSession, walkJsonl, visitJsonLines, trackTimestamp, addModelUsage, finalizeSession,
  async discoverRoots({ home, environment }) {
    return (await discoverProviderRoots({ home, claudeConfigDirectory: environment["CLAUDE_CONFIG_DIR"], codexHome: environment["CODEX_HOME"] })).claude;
  },
  async identify(root) { return transcriptCandidates((await indexProviderTranscripts(root, null, "claude")).paths, "claude"); },
});

async function claudeEvidencePaths(mainPath: string): Promise<string[]> {
  const paths = [mainPath];
  const metadata = desktopMetadataPath(mainPath);
  if (metadata) for (const evidence of [metadata, join(metadata.slice(0, -5), "audit.jsonl")]) {
    try { if ((await stat(evidence)).isFile()) paths.push(evidence); } catch { /* Optional evidence is unavailable. */ }
  }
  try { for await (const path of walkJsonl(mainPath.replace(/\.(?:jsonl|json)$/i, "") + "/subagents")) paths.push(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return paths;
}

async function analyzeClaude(row: SessionDatabaseRow, path: string, rateCard: PricingCatalog, warnings: string[], index: IndexScan | null = null, usageOwners?: ClaudeUsageOwners, mainPaths: string[] = [path], profileOf?: (path: string) => string | null): Promise<SessionAnalytics | null> {
  if (index && path.includes("/subagents/") && row.provider_session_id) {
    const retained = index.retainedClaudeParent(row.provider_session_id, path);
    if (retained) return retained;
  }
  const evidencePaths = index ? [...new Set((await Promise.all(mainPaths.map(claudeEvidencePaths))).flat())] : [];
  // Messages shared with a resumed copy are accounted across sessions, so only those sessions skip the index.
  if (index && !usageOwners?.sharedBy(evidencePaths)) {
    return index.session(row, evidencePaths, warnings,
      () => analyzeClaude(row, path, rateCard, warnings, null, usageOwners, mainPaths, profileOf));
  }
  const session = await claudeAdapter.analyze({ path, cwd: row.workspace_path, id: row.provider_session_id ?? "", provider: "claude", timestamp: row.created_at }, { row, rateCard, warnings, usageOwners, mainPaths, profileKey: profileOf?.(path) ?? null });
  if (!session) throw new Error("Claude evidence could not be analyzed.");
  return session;
}

function finalizeSession(
  row: SessionDatabaseRow,
  state: MutableSession,
  tokens: TokenUsage,
  files: number,
): SessionAnalytics {
  const publicStatus: SessionStatus = sessionStatuses.find((status) => status === row.status) ?? "unknown";
  const publicProvider: SessionProvider = row.agent_type === "claude" || row.agent_type === "codex" || row.agent_type === "cursor" ? row.agent_type : "unsupported";
  const createdAt = normalizeTimestamp(row.created_at) ?? state.firstEventAt;
  const updatedAt = normalizeTimestamp(row.updated_at) ?? state.lastEventAt ?? createdAt;
  if (!createdAt || !updatedAt) throw new Error("Provider timestamps are unavailable.");
  for (const names of [state.tools, state.transportTools]) {
    for (const name of Object.keys(names)) if (publicMetadataName.exec(name)?.[0] !== name) {
      const count = names[name]!; delete names[name];
      increment(names, "unknown_tool", count);
      state.warnings.push("Some provider metadata was omitted because it was not a bounded public identifier.");
    }
  }
  const models = [...state.models.values()].sort((left, right) => right.totalUsd - left.totalUsd);
  const cost = zeroCost();
  let pricedTokens = 0;
  let priceEligibleTokens = 0;
  for (const model of models) {
    sumCost(cost, model);
    priceEligibleTokens += model.pricingCoverage?.eligibleTokens ?? tokenCount(model);
    pricedTokens += model.pricingCoverage?.pricedTokens ?? (model.priced ? tokenCount(model) : 0);
  }
  const pricedTokenCoverage = priceEligibleTokens === 0 ? null : pricedTokens / priceEligibleTokens;
  const eventSpanMilliseconds = durationMilliseconds(state.firstEventAt, state.lastEventAt);
  const sessionDuration = durationMilliseconds(row.created_at, state.lastEventAt ?? row.updated_at);
  const toolCalls = Object.values(state.tools).reduce((sum, value) => sum + value, 0);
  const transportToolCalls = Object.values(state.transportTools).reduce(
    (sum, value) => sum + value,
    0,
  );
  const executionKind =
    state.executionKindsSeen.size > 1
      ? "mixed"
      : ([...state.executionKindsSeen][0] ?? state.executionKind);
  for (const model of models) {
    if (model.model === "<unknown>") state.warnings.push("Provider history did not record a stable model ID; those tokens are excluded from API-equivalent spend coverage.");
    else if (!model.priced) state.warnings.push(model.pricing?.length
      ? `Some token classes have estimated or unavailable rates for ${model.model}.`
      : `No rate card is configured for ${model.model}.`);
  }
  const metrics: SessionMetrics = {
    assistantMessages: state.assistantMessages,
    compactions: state.requestProvider ? state.compactionCounter.count() : state.compactions,
    contextUtilizationPeak: state.requestProvider ? state.contextUtilizationPeak : null,
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
    mcpEvidence: state.mcpEvidence.finish(row.status === "working"),
    agentIdentity: state.agentIdentity,
    velocity: state.velocity.finish(row.created_at, state.startDimension ?? velocityDimension(row.agent_type as SessionProvider, state.agentIdentity, state.executionKind, "<unknown>", null)),
    cost,
    costBasis: publicProvider === "unsupported" ? "unavailable" :
      row.agent_type === "cursor"
        ? cost.totalUsd > 0
          ? "provider-reported"
          : "unavailable"
        : "api-list-price-equivalent",
    costByExecution: { ...state.costByExecution },
    costComplete: pricedTokenCoverage === null || pricedTokenCoverage === 1,
    createdAt,
    effort: state.effort && publicMetadataName.exec(state.effort)?.[0] === state.effort ? state.effort : null,
    executionKind,
    firstEventAt: state.firstEventAt,
    lastEventAt: state.lastEventAt,
    metrics,
    models,
    pricedTokenCoverage,
    provider: publicProvider,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    sessionKey: createHash("sha256").update(row.conductor_session_id).digest("hex").slice(0, 12),
    spendByDay: state.spendByDay,
    status: publicStatus,
    tokens,
    tools: state.tools,
    transcript: {
      startTimeKnown: Boolean(safeTime(row.created_at)),
      completeness: state.completeness,
      liveness: row.status === "working" ? "active" : state.liveness,
      files,
      snapshotWhileWorking: row.status === "working",
      status: "ok",
      warnings: [...new Set(state.warnings)],
    },
    transportTools: state.transportTools,
    updatedAt,
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

export interface ProviderRootEnvironment {
  /** Claude Code's configuration directory override (`CLAUDE_CONFIG_DIR`). */
  claudeConfigDirectory?: string | undefined;
  /** Codex's home directory override (`CODEX_HOME`). */
  codexHome?: string | undefined;
  home: string;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Profile directories for one provider: the default (`~/.claude`), sibling
 * profiles that people create for separate accounts (`~/.claude-work`), and an
 * explicit environment override. Sibling profiles are only returned when they
 * exist; the default is always returned so a missing store stays visible.
 */
async function providerProfiles(
  home: string,
  defaultName: ".claude" | ".codex",
  override: string | undefined,
): Promise<string[]> {
  const profiles = [join(home, defaultName)];
  if (override) profiles.push(resolve(override));
  try {
    const entries = await readdir(home, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(`${defaultName}-`) && (entry.isDirectory() || entry.isSymbolicLink())) {
        profiles.push(join(home, entry.name));
      }
    }
  } catch {
    // An unreadable home directory leaves the default and explicit profiles.
  }
  return profiles;
}

/** Keep the first occurrence of each root after resolving symbolic links. */
async function uniqueRoots(roots: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const root of roots) {
    let canonical = resolve(root);
    try {
      canonical = await realpath(root);
    } catch {
      // A missing root keeps its resolved path so its absence is still reported.
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(root);
  }
  return unique;
}

/** Every local Claude Code and Codex transcript root, across all profiles. */
export async function discoverProviderRoots(
  environment: ProviderRootEnvironment,
): Promise<{ claude: string[]; codex: string[] }> {
  const { home } = environment;
  const claudeProfiles = await providerProfiles(home, ".claude", environment.claudeConfigDirectory);
  const claude: string[] = [join(home, ".claude", "projects")];
  for (const profile of [...claudeProfiles, join(home, ".config", "claude")]) {
    const projects = join(profile, "projects");
    if (await directoryExists(projects)) claude.push(projects);
  }
  const desktopAgents = join(home, "Library/Application Support/Claude/local-agent-mode-sessions");
  if (await directoryExists(desktopAgents)) claude.push(desktopAgents);

  const codexProfiles = await providerProfiles(home, ".codex", environment.codexHome);
  const codex: string[] = [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")];
  for (const profile of codexProfiles) {
    for (const store of ["sessions", "archived_sessions"]) {
      const root = join(profile, store);
      if (await directoryExists(root)) codex.push(root);
    }
  }
  return { claude: await uniqueRoots(claude), codex: await uniqueRoots(codex) };
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
  unavailable: () => void = () => {},
): AsyncGenerator<string> {
  const directory = await opendir(root);
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      try { yield* walkProviderTranscripts(path, provider, unavailable); }
      catch { unavailable(); }
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
  let unreadable = false;
  try {
    for await (const path of walkProviderTranscripts(root, provider, () => { unreadable = true; })) {
      if (provider === "claude" && path.includes("/subagents/")) {
        const identity = await transcriptIdentity(path, provider);
        const parent = basename(path.split("/subagents/")[0]!);
        if (identity.id === parent && identity.cwd && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(parent)) {
          const mains = index.get(parent) ?? [];
          mains.push(path); index.set(parent, mains);
        }
        continue;
      }
      if (provider === "claude" && basename(path) === "audit.jsonl") continue;
      const match = basename(path).match(provider === "codex"
        ? /([0-9a-f]{8}-[0-9a-f-]{27})(?:_[0-9a-f]{8}-[0-9a-f-]{27})?\.jsonl$/i
        : /([0-9a-f]{8}-[0-9a-f-]{27})\.(?:jsonl|json)$/i);
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
  return { paths: index, warning: unreadable ? "Some provider evidence directories could not be read." : null };
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
  if (provider === "codex") for (const [filenameId, paths] of [...index]) for (const path of [...paths]) {
    const identity = await transcriptIdentity(path, provider);
    if (!identity.id || identity.id === filenameId || !index.has(identity.id)) continue;
    let conflict = false;
    await visitJsonLines(path, record => {
      const payload = asRecord(record["payload"]);
      if (record["type"] === "session_meta" && payload?.["id"] !== identity.id) conflict = true;
      if (record["type"] !== "token_usage_record" && record["type"] !== "event_msg") return;
      for (const field of ["thread_id", "session_id"]) if (typeof payload?.[field] === "string" && payload[field] !== identity.id) conflict = true;
    });
    if (!conflict) { index.get(identity.id)!.push(path); index.set(filenameId, paths.filter(item => item !== path)); }
  }
  const entries = [...index.entries()];
  // A session_meta record can contain several megabytes of prompt context.
  // Keep identity parsing deliberately narrow so concurrent JSON decoding does
  // not multiply that transient allocation during a machine-wide scan.
  const candidates = await mapConcurrent(entries, 2, async ([filenameId, paths]): Promise<TranscriptCandidate | null> => {
    const validated: Array<{ cwd: string; path: string; timestamp: string | null; repositoryRemote?: string | null }> = [];
    for (const path of paths) {
      const identity = await transcriptIdentity(path, provider);
      if (identity.id === filenameId && identity.cwd) {
        validated.push({ cwd: identity.cwd, path, timestamp: identity.timestamp, repositoryRemote: identity.repositoryRemote });
      }
    }
    validated.sort((a, b) => Number(a.path.includes("/subagents/")) - Number(b.path.includes("/subagents/")) || (a.timestamp ?? "").localeCompare(b.timestamp ?? "") || a.path.localeCompare(b.path));
    if (provider === "codex" && validated.length > 1) {
      const hashes = new Set<string>();
      for (let position = 0; position < validated.length;) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(validated[position]!.path)) hash.update(chunk);
        const digest = hash.digest("hex");
        if (hashes.has(digest)) validated.splice(position, 1);
        else { hashes.add(digest); position++; }
      }
    }
    const first = validated[0];
    return first ? { ...first, id: filenameId, provider,
      paths: validated.map((page) => page.path) } : null;
  });
  return candidates.filter((candidate): candidate is TranscriptCandidate => candidate !== null);
}

async function gitRootForPath(rawPath: string): Promise<string | null> {
  let current = await realpath(rawPath).catch(() => resolve(rawPath));
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
        if (!gitDirectory) return current;
        const commonPointer = await readFile(join(gitDirectory, "commondir"), "utf8").catch(() => null);
        // Older retained markers may lack commondir. Keep the conventional
        // layout fallback, while explicit pointers also cover nonstandard storage.
        const conventional = gitDirectory.match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/);
        const commonDirectory = commonPointer ? resolve(gitDirectory, commonPointer.trim())
          : conventional ? join(conventional[1]!, ".git") : gitDirectory;
        // .git can point at separate storage; commondir is authoritative for linked trees.
        const canonicalCommon = await realpath(commonDirectory).catch(() => commonDirectory);
        return basename(canonicalCommon) === ".git" ? dirname(canonicalCommon) : canonicalCommon;
      }
    } catch {
      // Continue toward the filesystem root.
    }
    if (current === root) return null;
    current = dirname(current);
  }
}

let cachedTemporaryDirectoryRoots: string[] | null = null;
/** macOS exposes /tmp and /var through /private; a deleted directory keeps whichever spelling was recorded. */
function withoutPrivateAlias(path: string): string {
  return resolve(path).replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, "");
}
/** Temporary roots in one spelling: the OS temporary directory (through and without symbolic links) and /tmp. */
function temporaryDirectoryRoots(): string[] {
  if (cachedTemporaryDirectoryRoots === null) {
    let canonical = resolve(tmpdir());
    try { canonical = realpathSync(tmpdir()); } catch { /* keep the configured spelling */ }
    cachedTemporaryDirectoryRoots = [...new Set([tmpdir(), canonical, "/tmp"].map(withoutPrivateAlias))];
  }
  return cachedTemporaryDirectoryRoots;
}
function isTemporaryPath(path: string): boolean {
  const comparable = withoutPrivateAlias(path);
  // Per-user macOS temporary directories, including ones from other users' sessions or earlier boots.
  return /^\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/.test(comparable) ||
    temporaryDirectoryRoots().some((root) => pathInside(comparable, root));
}

/** Discovered IDs hash the grouping root. A remote root (`remote:<identity>`) gives every machine the same ID. */
function discoveredRepositoryId(groupingRoot: string): string {
  return `discovered-${createHash("sha256").update(groupingRoot).digest("hex").slice(0, 20)}`;
}

/** One shared group for working directories without any repository evidence. */
const NO_REPOSITORY_NAME = "No repository detected";
const NO_REPOSITORY_ID = discoveredRepositoryId("no-repository");
/** Earlier releases named every non-Git directory `<basename> · <hash> (local directory)`. */
const LEGACY_LOCAL_DIRECTORY_SUFFIX = " (local directory)";
/** Rows without a root directory are keyed by ID in a scan's discovered map. */
function rootlessKey(repositoryId: string): string { return `id:${repositoryId}`; }
// Private working directories routed to the shared group, per scan. Adapters that
// match transcripts by project path still need them; they never reach output.
const noRepositoryPaths = new WeakMap<Map<string, RepositoryRow>, Set<string>>();
export function noRepositoryPathsOf(discovered: Map<string, RepositoryRow>): Set<string> {
  let paths = noRepositoryPaths.get(discovered);
  if (!paths) { paths = new Set(); noRepositoryPaths.set(discovered, paths); }
  return paths;
}
function noRepositoryGroup(discovered: Map<string, RepositoryRow>, path?: string): RepositoryRow {
  if (path) noRepositoryPathsOf(discovered).add(path);
  let repository = discovered.get(rootlessKey(NO_REPOSITORY_ID));
  if (!repository) {
    // No root: no directory's Git history belongs to this group.
    repository = { default_branch: "", id: NO_REPOSITORY_ID, name: NO_REPOSITORY_NAME, remote_url: null, root_path: "" };
    discovered.set(rootlessKey(NO_REPOSITORY_ID), repository);
  }
  return repository;
}

function pathInside(path: string, root: string): boolean {
  const resolvedPath = resolve(path), resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

// One scan owns one discovered map. Thousands of sessions share a few hundred working
// directories, and each lookup walks the filesystem and every workspace root.
const repositoryLookups = new WeakMap<Map<string, RepositoryRow>, Map<string, Promise<RepositoryRow>>>();

function repositoryForPath(
  cwd: string,
  repositories: RepositoryRow[],
  workspaceRepositories: Map<string, RepositoryRow>,
  discovered: Map<string, RepositoryRow>,
  metadataRemote: string | null = null,
): Promise<RepositoryRow> {
  let lookups = repositoryLookups.get(discovered);
  if (!lookups) { lookups = new Map(); repositoryLookups.set(discovered, lookups); }
  const key = JSON.stringify([cwd, metadataRemote]);
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = resolveRepositoryForPath(cwd, repositories, workspaceRepositories, discovered, metadataRemote);
    lookups.set(key, lookup);
  }
  return lookup;
}

async function resolveRepositoryForPath(
  cwd: string,
  repositories: RepositoryRow[],
  workspaceRepositories: Map<string, RepositoryRow>,
  discovered: Map<string, RepositoryRow>,
  metadataRemote: string | null,
): Promise<RepositoryRow> {
  const resolvedCwd = await realpath(cwd).catch(() => resolve(cwd));
  const workspaceMatch = workspaceRepositories.get(resolvedCwd);
  if (workspaceMatch) return workspaceMatch;
  metadataRemote = canonicalizeRemote(metadataRemote) ? metadataRemote : null;
  const gitRoot = metadataRemote && !(await stat(resolvedCwd).catch(() => null)) ? null : await gitRootForPath(resolvedCwd);
  const repositoryRemote = (gitRoot ? await repositoryRemoteAtRoot(gitRoot) : null) ?? metadataRemote;
  const remoteIdentity = repositoryRemote ? normalizeRemote(repositoryRemote) : null;
  // Workspace keys are normalized absolute paths: the deepest owning ancestor is the longest containing root.
  for (let root = resolvedCwd; ; root = dirname(root)) {
    const repository = workspaceRepositories.get(root);
    if (repository && (root !== parse(root).root || root === resolvedCwd)) {
      // Explicit workspace ownership survives deletion. A nested independent
      // Git boundary must retain its own identity, including linked worktrees.
      const sameRemote = Boolean(remoteIdentity && repository.remote_url && normalizeRemote(repository.remote_url) === remoteIdentity);
      if (!gitRoot ? !metadataRemote || sameRemote
        : resolve(gitRoot) === resolve(root) || resolve(gitRoot) === resolve(repository.root_path) || sameRemote) return repository;
    }
    if (dirname(root) === root) break;
  }
  const direct = repositories
    .filter(({ root_path }) => root_path && pathInside(resolvedCwd, root_path))
    .sort((left, right) => resolve(right.root_path).length - resolve(left.root_path).length)[0];
  if (direct && !gitRoot && !metadataRemote) return direct;
  const workspaceParts = resolvedCwd.match(/\/conductor\/workspaces\/([^/]+)\//);
  const named = workspaceParts?.[1]
    ? repositories.find(({ name }) => name === workspaceParts[1])
    : null;
  if (named && !gitRoot && !metadataRemote) return named;
  if (gitRoot) {
    const registered = repositories.find(({ root_path }) => resolve(root_path) === resolve(gitRoot));
    if (registered) return registered;
  }
  if (remoteIdentity) {
    const registeredByRemote = repositories.filter(({ remote_url }) => remote_url && normalizeRemote(remote_url) === remoteIdentity);
    if (registeredByRemote.length === 1) return registeredByRemote[0]!;
  }
  // Without a Git root, a recorded remote or Conductor ownership a directory is not a
  // repository: scratch folders, the home directory and deleted checkouts share one group.
  const ephemeral = !gitRoot && !remoteIdentity;
  if (ephemeral && !isTemporaryPath(resolvedCwd)) return noRepositoryGroup(discovered, resolvedCwd);
  const ephemeralRoot = "/private/var/folders/session-analytics-ephemeral";
  const groupingRoot = remoteIdentity ? `remote:${remoteIdentity}` : gitRoot ?? ephemeralRoot;
  const existing = discovered.get(groupingRoot);
  if (existing) return existing;
  const repository: RepositoryRow = {
    default_branch: "",
    id: discoveredRepositoryId(groupingRoot),
    name: remoteIdentity ? basename(remoteIdentity) : gitRoot ? basename(gitRoot) : "Ephemeral automation sessions",
    remote_url: repositoryRemote,
    root_path: ephemeral ? ephemeralRoot : gitRoot ?? resolvedCwd,
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
  rateCard: PricingCatalog,
  warnings: string[] = ["Discovered directly from the machine-wide provider transcript store."],
  codexCounterLedger: Map<string, CodexCounterOwner> | null = null,
  claimedCodexCounters: Set<string> = new Set<string>(),
  index: IndexScan | null = null,
  claudeUsageOwners?: ClaudeUsageOwners,
  claudeProfileOf?: (path: string) => string | null,
): Promise<SessionAnalytics | null> {
  const timestamp = candidate.timestamp ?? new Date((await stat(candidate.path)).mtimeMs).toISOString();
  const row = syntheticSessionRow(candidate.provider, candidate.id, candidate.cwd, timestamp, repository);
  const session = candidate.provider === "codex"
    ? await analyzeCodex(row, candidate.path, rateCard, warnings, codexCounterLedger, claimedCodexCounters, index, null, () => false, candidate.paths)
    : await analyzeClaude(row, candidate.path, rateCard, warnings, index, claudeUsageOwners, candidate.paths, claudeProfileOf);
  if (session) session.transcript.startTimeKnown = Boolean(safeTime(candidate.timestamp));
  return session;
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
  for (const [rawModel, rawUsage] of Object.entries(usageData ?? {})) {
    const model = projectModelId(rawModel);
    const usage = asRecord(rawUsage);
    const cents = usage?.["costInCents"];
    if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) continue;
    const value = cents / 100;
    const aggregate: ModelUsage = state.models.get(model) ?? {
      ...zeroTokens(),
      ...zeroCost(),
      calls: 0,
      model: publicModelId(model),
      priced: true,
      pricing: [],
    };
    aggregate.totalUsd += value;
    aggregate.upperEstimateUsd += value;
    state.models.set(model, aggregate);
    const values = zeroVelocity(); values[0] = value;
    state.velocity.add(null, velocityDimension("cursor", {}, state.executionKind, model, null), values);
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
    const timestamp = millisecondTimestamp(timing?.["clientStartTime"]);
    const dimension = velocityDimension("cursor", {}, executionKind, "<unknown>", null);
    trackTimestamp(state, millisecondTimestamp(timing?.["clientStartTime"]));
    trackTimestamp(state, millisecondTimestamp(timing?.["clientEndTime"]));
    const tokenCountRecord = asRecord(bubble["tokenCount"]);
    const input = nonNegativeNumberValue(tokenCountRecord?.["inputTokens"]), output = nonNegativeNumberValue(tokenCountRecord?.["outputTokens"]);
    if (input + output > 0) {
      tokens.inputTokens += input; tokens.uncachedInputTokens += input;
      tokens.outputTokens += output; tokens.nonReasoningOutputTokens += output;
      state.maxInputTokensPerCall = Math.max(state.maxInputTokensPerCall, input); modelCalls += 1;
      const values = zeroVelocity();
      values[1] = input; values[2] = input; values[5] = output; values[7] = 1;
      state.velocity.add(timestamp, dimension, values);
    }
    const modernTool = cursorModernTool(bubble);
    if (modernTool && !seenToolCalls.has(modernTool.id)) {
      seenToolCalls.add(modernTool.id);
      state.velocity.tool(timestamp, dimension);
      increment(state.tools, modernTool.name);
      increment(state.transportTools, modernTool.name);
    }
    for (const name of cursorToolNames(bubble["capabilitiesRan"])) {
      state.velocity.tool(timestamp, dimension);
      increment(state.tools, name);
      increment(state.transportTools, name);
    }
  }
  const reportedCost = addCursorReportedCost(state, data);
  const session = finalizeSession(row, state, tokens, 1);
  session.metrics.modelCalls = modelCalls;
  session.costComplete = session.costBasis !== "unavailable";
  const hasReportedCost = Object.values(asRecord(data["usageData"]) ?? {}).some((raw) => {
    const cents = asRecord(raw)?.["costInCents"];
    return typeof cents === "number" && Number.isFinite(cents) && cents >= 0;
  });
  if (hasReportedCost) { session.costBasis = "provider-reported"; session.costComplete = true; }
  if (hasReportedCost) {
    session.transcript.warnings.push("Cursor usage value is read from the provider-reported local cost record; it is not inferred from a third-party rate card.");
  } else {
    session.transcript.warnings.push("Cursor retained session metadata without a provider-reported local cost record; no usage value is inferred.");
  }
  if (conversation.length === 0) {
    session.transcript.warnings.push("Cursor retained the session header and usage summary, but not detailed local conversation metrics.");
  }
  return session;
}

interface CursorHeaderEvidence {
  subagents: Set<string>;
  workspaces: Map<string, string>;
}

async function cursorHeaderWorkspaces(
  database: DatabaseSync,
  databasePath: string,
): Promise<CursorHeaderEvidence> {
  const candidates = new Map<string, { path: string; score: number }>();
  const subagents = new Set<string>();
  const workspaceStorage = join(dirname(dirname(databasePath)), "workspaceStorage");
  const workspacePath = async (workspaceId: string): Promise<string | null> => {
    try {
      const workspace = asRecord(
        JSON.parse(await readFile(join(workspaceStorage, workspaceId, "workspace.json"), "utf8")),
      );
      const folderUri = stringValue(workspace?.["folder"]);
      const workspaceUri = stringValue(workspace?.["workspace"]);
      const uri = folderUri ?? workspaceUri;
      if (!uri) return null;
      const path = uri.startsWith("file://") ? decodeURIComponent(new URL(uri).pathname) : uri;
      if (!path.startsWith("/")) return null;
      if (folderUri) return path;
      // A saved workspace is a manifest, not a repository path. Only a unique
      // folder identifies a cwd; multi-root workspaces need separate evidence.
      const config = asRecord(JSON.parse(await readFile(path, "utf8")));
      const folders = Array.isArray(config?.["folders"]) ? config["folders"] : [];
      const roots = new Set<string>();
      for (const raw of folders) {
        const folder = asRecord(raw);
        const folderPath = stringValue(folder?.["path"]);
        const folderUri = stringValue(folder?.["uri"]);
        if (folderPath) roots.add(resolve(dirname(path), folderPath));
        else if (folderUri?.startsWith("file://")) {
          roots.add(decodeURIComponent(new URL(folderUri).pathname));
        }
      }
      return roots.size === 1 ? [...roots][0]! : null;
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
      workspaceDatabase = openSourceDatabase(join(workspaceStorage, workspaceId, "state.vscdb"));
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

  try {
    // Current Cursor builds moved global composer headers out of ItemTable and
    // into a dedicated table keyed by composer and workspace storage IDs.
    const rows = database
      .prepare("SELECT composerId, workspaceId, lastUpdatedAt, isSubagent FROM composerHeaders")
      .all() as Array<Record<string, unknown>>;
    await mapConcurrent(rows, 8, async (header) => {
      const composerId = stringValue(header["composerId"]);
      const workspaceId = stringValue(header["workspaceId"]);
      if (!composerId) return;
      if (numberValue(header["isSubagent"]) === 1) subagents.add(composerId);
      const path = workspaceId ? await workspacePath(workspaceId) : null;
      if (path) assign(composerId, path, numberValue(header["lastUpdatedAt"]));
    });
  } catch {
    // Cursor builds before the headers table keep headers in ItemTable.
  }
  return {
    subagents,
    workspaces: new Map([...candidates].map(([composerId, { path }]) => [composerId, path])),
  };
}

export async function cursorSessions(
  databasePath: string,
  repositories: RepositoryRow[],
  workspaceRepositories: Map<string, RepositoryRow>,
  discovered: Map<string, RepositoryRow>,
): Promise<{ sessions: SessionAnalytics[]; warning: string | null }> {
  let database: DatabaseSync | null = null;
  try {
    database = openSourceDatabase(databasePath);
    repositories = await Promise.all(repositories.map(async (repository) => ({
      ...repository,
      root_path: await realpath(repository.root_path).catch(() => resolve(repository.root_path)),
    })));
    const composerStatement = database.prepare(
      "SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
    );
    const headerWorkspaces = await cursorHeaderWorkspaces(database, databasePath);
    const bubbleStatement = database.prepare(
      "SELECT value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key",
    );
    const results: SessionAnalytics[] = [];
    let partialRead = false;
    for (const { value } of composerStatement.iterate() as Iterable<{ value: string }>) {
      let data: JsonRecord | null = null;
      try { data = asRecord(JSON.parse(value)); } catch { partialRead = true; continue; }
      if (!data || !stringValue(data["composerId"]) || !millisecondTimestamp(data["createdAt"])) { partialRead = true; continue; }
      const id = stringValue(data["composerId"]) as string;
      const conversation: unknown[] = [];
      const inlinePositions = new Map<string, number>();
      for (const raw of Array.isArray(data["conversation"]) ? data["conversation"] : []) {
        const bubble = asRecord(raw);
        const bubbleId = stringValue(bubble?.["bubbleId"]) ?? stringValue(bubble?.["id"]);
        const previous = bubbleId ? inlinePositions.get(bubbleId) : undefined;
        if (previous !== undefined) conversation[previous] = raw;
        else {
          if (bubbleId) inlinePositions.set(bubbleId, conversation.length);
          conversation.push(raw);
        }
      }
      const modernBubbles = bubbleStatement
        .all(`bubbleId:${id}:`, `bubbleId:${id};`) as Array<{ value: string }>;
      for (const { value } of modernBubbles) {
        let bubble: JsonRecord | null = null;
        try { bubble = asRecord(JSON.parse(value)); } catch { partialRead = true; continue; }
        if (!bubble) { partialRead = true; continue; }
        const bubbleId = stringValue(bubble["bubbleId"]) ?? stringValue(bubble["id"]);
        const previous = bubbleId ? inlinePositions.get(bubbleId) : undefined;
        // Split disk storage is the current persisted snapshot after migration.
        if (previous !== undefined) conversation[previous] = bubble;
        else {
          if (bubbleId) inlinePositions.set(bubbleId, conversation.length);
          conversation.push(bubble);
        }
      }
      const hasReportedUsage = Object.values(asRecord(data["usageData"]) ?? {}).some((raw) => {
        const cents = asRecord(raw)?.["costInCents"];
        return typeof cents === "number" && Number.isFinite(cents) && cents >= 0;
      });
      const hasReportedEdits = nonNegativeNumberValue(data["totalLinesAdded"]) + nonNegativeNumberValue(data["totalLinesRemoved"]) > 0;
      if (data["isDraft"] === true && conversation.length === 0 && !hasReportedUsage && !hasReportedEdits) continue;
      const headerPath = headerWorkspaces.workspaces.get(id);
      // The session workspace is authoritative; references can point to other repos.
      const paths = headerPath ? [headerPath] : cursorPaths(data);
      let cwd = join(homedir(), ".cursor", "unassigned");
      for (const path of paths) {
        const gitRoot = await gitRootForPath(path);
        if (gitRoot) { cwd = gitRoot; break; }
        if (cwd.endsWith("/.cursor/unassigned")) cwd = path.endsWith(".code-workspace") ? dirname(path) : path;
      }
      let repository: RepositoryRow;
      if (cwd === join(homedir(), ".cursor", "unassigned")) {
        const key = createHash("sha256").update("cursor-composer:unassigned").digest("hex").slice(0, 20);
        const root = `unassigned:${key}`;
        repository = discovered.get(root) ?? {
          id: `discovered-${key}`, name: `Cursor · unassigned ${key.slice(0, 4)}`,
          root_path: root, remote_url: null, default_branch: "",
        };
        discovered.set(root, repository);
      } else {
        repository = await repositoryForPath(cwd, repositories, workspaceRepositories, discovered);
      }
      const executionKind =
        data["isBestOfNSubcomposer"] === true ||
        Boolean(data["subagentInfo"]) ||
        headerWorkspaces.subagents.has(id)
          ? "subagent"
          : "top-level";
      const session = analyzeCursorComposer(data, repository, cwd, executionKind, conversation);
      if (session) results.push(session);
    }
    return { sessions: results, warning: partialRead ? "Cursor local session history could not be read." : null };
  } catch (error) {
    const code = asRecord(error)?.["code"];
    return { sessions: [], warning: code === "ENOENT" ? "Cursor local session history is missing." : "Cursor local session history could not be read." };
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
    const child = track(spawn(process.execPath, ["--max-old-space-size=192", fileURLToPath(moduleUrl("./cursor-worker.ts", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"],
    }));
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
    child.once("error", rejectWorker);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectWorker(new Error(workerExitMessage(output, errorOutput) ?? "Cursor analysis process exited before returning a result."));
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

function sessionRows(database: DatabaseSync, repositoryIds: string[], includeHidden: boolean) {
  // Retained result receipts remain evidence after repository/workspace deletion.
  // Optional workspace columns vary by Conductor version. Older schemas remain supported.
  const workspaceColumns = new Set((database.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map(({ name }) => name));
  const placeholders = repositoryIds.map(() => "?").join(", ") || "NULL";
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
      LEFT JOIN workspaces AS w ON w.id = s.workspace_id
      LEFT JOIN repos AS r ON r.id = w.repository_id
      WHERE (r.id IN (${placeholders}) OR r.id IS NULL) AND (? = 1 OR s.is_hidden = 0)
      ORDER BY datetime(s.created_at) DESC
    `)
    .all(...repositoryIds, includeHidden ? 1 : 0);
  return (rows as unknown as SessionDatabaseRow[]).map((row) => row.repository_id ? row : {
    ...row, repository_id: "unassigned:conductor", repository_name: "Conductor · unassigned",
    root_path: "unassigned:conductor", repository_remote: "", default_branch: "",
    workspace_path: row.workspace_path || "unassigned:conductor",
  });
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

async function selectRepositories(
  repositories: RepositoryRow[],
  options: AnalyzeOptions,
  index: IndexScan | null = null,
  portableIds: Map<string, string> = new Map(),
): Promise<RepositoryRow[]> {
  if (options.repositoryId) {
    // A portable ID can stand for several local registrations of one remote; they are reported together.
    const matches = repositories.filter(({ id }) => id === options.repositoryId || portableIds.get(id) === options.repositoryId);
    if (!matches.length) throw new Error("No evidenced repository has the requested ID.");
    return matches;
  }
  if (options.repositoryName) {
    return [chooseRepository(repositories, options.repositoryName, options.repositoryRemote ?? "")];
  }
  if (options.repositoryRemote) {
    const requestedRemote = normalizeRemote(options.repositoryRemote);
    if (!requestedRemote) throw new Error("No unique evidenced repository has the requested remote.");
    const matches = repositories.filter((repository) =>
      normalizeRemote(repository.remote_url ?? "") === requestedRemote ||
      index?.matchesRemote(repository.id, options.repositoryRemote as string));
    if (matches.length !== 1) throw new Error("No unique evidenced repository has the requested remote.");
    return matches;
  }
  if (options.repositoryRoot) {
    const canonicalRoot = await realpath(options.repositoryRoot).catch(() => resolve(options.repositoryRoot!));
    const gitRoot = await gitRootForPath(canonicalRoot);
    const remote = gitRoot ? await repositoryRemoteAtRoot(gitRoot) : null;
    const remoteIdentity = remote ? normalizeRemote(remote) : null;
    const matches = repositories.filter(({ id, root_path, remote_url }) =>
      (root_path && resolve(root_path) === canonicalRoot) || index?.matchesRoot(id, canonicalRoot) ||
      Boolean(remoteIdentity && remote_url && normalizeRemote(remote_url) === remoteIdentity));
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

function aggregate(
  repository: RepositoryRow,
  sessions: SessionAnalytics[],
  rateCard: PricingCatalog,
): RepositoryAnalytics {
  return {
    velocity: velocityMetadata(),
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    rateCard: publicRateCard(rateCard),
    repository: {
      id: repository.id,
      name: repository.name,
    },
    sessions,
    ...aggregateSessions(sessions),
  };
}

/** Callbacks the analysis process passes; they never travel with the serialized options. */
export interface AnalysisHooks {
  /** The index parses every present session again: it was cold, or its code or prices changed. */
  onFullParse?: () => void;
}

async function analyzeSelectedRepositories(
  options: AnalyzeOptions,
  hooks: AnalysisHooks = {},
): Promise<{ historyCoverage?: MachineAnalytics["historyCoverage"]; rateCard: PricingCatalog; repositories: RepositoryAnalytics[]; providerWarnings: string[]; mcpContext?: MachineAnalytics["mcpContext"]; mcpSourceHealth: MachineAnalytics["mcpSourceHealth"] }> {
  const databasePath =
    options.databasePath ?? join(homedir(), "Library/Application Support/com.conductor.app/conductor.db");
  const rateCard = await loadPricingCatalog(options);
  let database: DatabaseSync | null = null;
  let index: IndexScan | null = null;
  try {
    await stat(databasePath);
    database = openSourceDatabase(databasePath);
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
    const includeHidden = options.includeHidden ?? true;
    index = await IndexScan.open(options, rateCard, includeHidden);
    if (index?.fullParse) hooks.onFullParse?.();
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
    for (const repository of availableRepositories) {
      repository.root_path = await realpath(repository.root_path).catch(() => resolve(repository.root_path));
    }
    const rows = database
      ? sessionRows(database, availableRepositories.map(({ id }) => id), includeHidden)
      : [];
    if (rows.some((row) => row.repository_id === "unassigned:conductor")) {
      availableRepositories.push({ id: "unassigned:conductor", name: "Conductor · unassigned",
        root_path: "unassigned:conductor", remote_url: null, default_branch: "" });
    }
    // Conductor repository IDs are raw application identifiers. Replace them
    // with stable pseudonymous keys before anything reaches the projection.
    const publicRepositoryIds = new Map(
      availableRepositories.map(({ id }) => [
        id,
        `conductor-${createHash("sha256").update(`conductor:${id}`).digest("hex").slice(0, 20)}`,
      ]),
    );
    for (const repository of availableRepositories) {
      repository.id = publicRepositoryIds.get(repository.id) ?? repository.id;
    }
    for (const row of rows) {
      row.repository_id = publicRepositoryIds.get(row.repository_id) ?? row.repository_id;
      row.root_path = availableRepositories.find((repository) => repository.id === row.repository_id)?.root_path ?? row.root_path;
    }
    const repositoryById = new Map(availableRepositories.map((repository) => [repository.id, repository]));
    const workspaceRepositories = new Map<string, RepositoryRow>();
    if (database) {
      // Workspace ownership exists independently of Conductor session records.
      const columns = new Set((database.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map(({ name }) => name));
      const secondary = columns.has("secondary_directory_name") ? "secondary_directory_name" : "NULL";
      const workspaceRows = database.prepare(`SELECT repository_id, workspace_path, ${secondary} AS secondary_directory_name FROM workspaces`).all() as unknown as Array<{ repository_id: string; workspace_path: string | null; secondary_directory_name: string | null }>;
      for (const workspace of workspaceRows) {
        const repository = repositoryById.get(publicRepositoryIds.get(workspace.repository_id) ?? workspace.repository_id);
        if (!repository || !workspace.workspace_path) continue;
        const workspacePath = await realpath(workspace.workspace_path).catch(() => resolve(workspace.workspace_path!));
        workspaceRepositories.set(workspacePath, repository);
        if (workspace.secondary_directory_name) {
          const alias = resolve(dirname(workspace.workspace_path), workspace.secondary_directory_name);
          workspaceRepositories.set(await realpath(alias).catch(() => alias), repository);
        }
      }
    }
    const discovered = new Map<string, RepositoryRow>();
    // Keep Cursor's hydrated composer objects serialized until the much larger
    // Codex and Claude transcript pass has finished. Retaining both object
    // graphs at once needlessly pushes machine-wide scans over V8's heap limit.
    const cursorDatabasePath = options.cursorDatabasePath ?? join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    const cursorSerialized = await cursorSessionsSerialized(
      cursorDatabasePath,
      availableRepositories,
      workspaceRepositories,
    );
    // Explicit roots replace discovery for that provider, so a narrowed or
    // synthetic scan never mixes in the machine's own history.
    const discoveredRoots = await discoverProviderRoots({
      claudeConfigDirectory: process.env["CLAUDE_CONFIG_DIR"],
      codexHome: process.env["CODEX_HOME"],
      home: homedir(),
    });
    const codexRoots = options.codexRoot || options.codexArchiveRoot
      ? [options.codexRoot, options.codexArchiveRoot].filter((root): root is string => Boolean(root))
      : discoveredRoots.codex;
    const claudeRoots = options.claudeRoot ? [options.claudeRoot] : await claudeAdapter.discoverRoots({ home: homedir(), options, environment: process.env });
    const claudeProfileOf = await claudeProfileResolver(claudeRoots);
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
    const claudeUsageOwners = await buildClaudeUsageOwners(claudeCandidates, claudeEvidencePaths, visitJsonLines, index?.ownership);
    const codexCounterLedger = await buildCodexCounterLedger(
      codexCandidates.flatMap(({ path, paths }) => paths ?? [path]), index,
      index?.retainedCounterOwners(new Set(codexCandidates.map(({ id }) => index!.identity("codex", id))), [...codexIndex.paths.values()].flat()),
    );
    const claimedCodexCounters = new Set<string>();
    const candidates = [...codexCandidates, ...claudeCandidates];
    const claimed = new Set<string>();
    const registeredOwners = new Set<string>();
    const registeredRows: SessionDatabaseRow[] = [];
    const registeredSelections = new Map<string, Awaited<ReturnType<typeof selectTranscript>>>();
    for (const row of rows) {
      // Orphan metadata cannot override a repository inferred from native evidence.
      if (row.root_path === "unassigned:conductor" || !row.provider_session_id) continue;
      if (row.agent_type === "codex" || row.agent_type === "claude") {
        const identity = `${row.agent_type}:${row.provider_session_id}`;
        if (registeredOwners.has(identity)) continue;
        const paths = row.agent_type === "codex" ? codexIndex.paths : claudeIndex.paths;
        const selected = await selectTranscript(paths.get(row.provider_session_id) ?? [], row.agent_type, row.provider_session_id, row.workspace_path);
        if (!selected.path) continue;
        registeredSelections.set(row.conductor_session_id, selected);
        registeredOwners.add(identity);
      }
      registeredRows.push(row);
    }
    await index?.prefetch([...codexIndex.paths.values(), ...claudeIndex.paths.values()].flat());
    const analyzedRows = await mapConcurrent(registeredRows, 1, async (row) => {
      if (row.agent_type !== "codex" && row.agent_type !== "claude") {
        return ["cursor", "copilot", "opencode", "gemini"].includes(row.agent_type) ? null : unavailableSession(row, "unsupported", ["Unsupported Conductor agent type."]);
      }
      const provider = row.agent_type as SessionProvider;
      const selected = registeredSelections.get(row.conductor_session_id)!;
      try {
        const session = provider === "codex"
          ? await analyzeCodex(row, selected.path!, rateCard, selected.warnings, codexCounterLedger, claimedCodexCounters, index, null, () => false, selected.paths)
          : await analyzeClaude(row, selected.path!, rateCard, selected.warnings, index, claudeUsageOwners, selected.paths, claudeProfileOf);
        claimed.add(`${provider}:${row.provider_session_id}`);
        return session;
      } catch (error) {
        if (error instanceof IndexParityError) throw error;
        return unavailableSession(row, "invalid", [
          "Transcript parsing failed without exposing local error details.",
        ]);
      }
    });
    const legacyRows = rows.filter(({ provider_session_id, agent_type }) =>
      !provider_session_id && (agent_type === "codex" || agent_type === "claude"));
    const legacyProviderIds = conductorLegacyProviderIds(database, legacyRows);
    const legacyMatches = new Map(legacyRows.map((row) => [row.conductor_session_id, candidates.filter((candidate) => {
      if (candidate.provider !== row.agent_type || claimed.has(`${candidate.provider}:${candidate.id}`)) return false;
      const explicit = legacyProviderIds.get(row.conductor_session_id);
      if (explicit?.size && (explicit.size !== 1 || !explicit.has(candidate.id))) return false;
      if (resolve(candidate.cwd) !== resolve(row.workspace_path) || !candidate.timestamp) return false;
      return Math.abs(timestampMilliseconds(candidate.timestamp) - timestampMilliseconds(row.created_at)) <= 15 * 60_000;
    })]));
    const possibleLegacyOwners = new Map<string, number>();
    for (const matches of legacyMatches.values()) for (const candidate of matches) {
      const identity = `${candidate.provider}:${candidate.id}`;
      possibleLegacyOwners.set(identity, (possibleLegacyOwners.get(identity) ?? 0) + 1);
    }
    const recovered = await mapConcurrent(legacyRows, 1, async (row) => {
      const matches = legacyMatches.get(row.conductor_session_id) ?? [];
      if (matches.length !== 1 || !matches[0] || possibleLegacyOwners.get(`${matches[0].provider}:${matches[0].id}`) !== 1) return null;
      const candidate = matches[0]; claimed.add(`${candidate.provider}:${candidate.id}`);
      try {
        return candidate.provider === "codex"
          ? await analyzeCodex(row, candidate.path, rateCard, ["Recovered from a unique working-directory and start-time match in the provider transcript store."], codexCounterLedger, claimedCodexCounters, index, null, () => false, candidate.paths)
          : await analyzeClaude(row, candidate.path, rateCard, ["Recovered from a unique working-directory and start-time match in the provider transcript store."], index, claudeUsageOwners, candidate.paths, claudeProfileOf);
      } catch (error) { if (error instanceof IndexParityError) throw error; return null; }
    });
    const discoveredSessions = await mapConcurrent(candidates.filter((candidate) =>
      !claimed.has(`${candidate.provider}:${candidate.id}`)), 1, async (candidate) => {
      const repository = await repositoryForPath(candidate.cwd, availableRepositories, workspaceRepositories, discovered, candidate.repositoryRemote);
      try {
        return await analyzeTranscriptCandidate(candidate, repository, rateCard, undefined, codexCounterLedger, claimedCodexCounters, index, claudeUsageOwners, claudeProfileOf);
      }
      catch (error) { if (error instanceof IndexParityError) throw error; return null; }
    });
    let cursorResult: { sessions: SessionAnalytics[]; warning: string | null };
    try {
      const cursorEnvelope = JSON.parse(cursorSerialized) as {
        discovered: RepositoryRow[];
        noRepositoryPaths?: string[];
        sessions: SessionAnalytics[];
        warning: string | null;
      };
      for (const repository of cursorEnvelope.discovered) {
        discovered.set(repository.root_path || rootlessKey(repository.id), repository);
      }
      for (const path of cursorEnvelope.noRepositoryPaths ?? []) noRepositoryPathsOf(discovered).add(path);
      cursorResult = {
        sessions: cursorEnvelope.sessions,
        warning: cursorEnvelope.warning,
      };
    } catch {
      throw new Error("Cursor analysis returned an invalid result.");
    }
    const allSessions = [
      ...analyzedRows.filter((session): session is SessionAnalytics => session !== null),
      ...recovered.filter((session): session is SessionAnalytics => session !== null),
      ...discoveredSessions.filter((session): session is SessionAnalytics => session !== null),
      ...cursorResult.sessions,
    ];
    // Provider adapters return only allowlisted sessions; identities stay in this process.
    const pricing = { rateCard, resolveRate: (model: string, at: string | null) => resolveRate(rateCard, model, at), price: (rate: ModelRate, usage: TokenUsage, input: number) => priceUsage(rate, usage, input).cost };
    const additional = await additionalProviderSessions({
      home: homedir(), options, environment: process.env, pricing, existingSessions: allSessions,
      knownPaths: [...new Set([...availableRepositories.map((r) => r.root_path), ...workspaceRepositories.keys(), ...discovered.keys(), ...noRepositoryPathsOf(discovered), ...candidates.map((c) => c.cwd)])],
      async repositoryForSession(identity, source) {
        if (identity.cwd) return repositoryForPath(identity.cwd, availableRepositories, workspaceRepositories, discovered);
        const key = createHash("sha256").update(`${source}:${identity.group ?? identity.id}`).digest("hex").slice(0, 20);
        const root = `unassigned:${key}`;
        let repository = discovered.get(root);
        if (!repository) {
          repository = { id: `discovered-${key}`, name: `${source === "gemini-chat" ? "Gemini" : source === "copilot-events" ? "Copilot" : source === "opencode-db" ? "OpenCode" : "Cursor"} · unassigned ${key.slice(0, 4)}`, root_path: root, remote_url: null, default_branch: "" };
          discovered.set(root, repository);
        }
        return repository;
      },
    });
    const knownSessionKeys = new Set(allSessions.map((session) => session.sessionKey));
    for (const session of additional.sessions) {
      const owners = rows.filter((row) => row.agent_type === session.provider && row.provider_session_id &&
        createHash("sha256").update(`${row.agent_type}:${row.provider_session_id}`).digest("hex").slice(0, 12) === session.sessionKey);
      if (owners.length === 1) session.sessionKey = createHash("sha256").update(owners[0]!.conductor_session_id).digest("hex").slice(0, 12);
      if (!knownSessionKeys.has(session.sessionKey)) { allSessions.push(session); knownSessionKeys.add(session.sessionKey); }
    }
    const canonicalIdentities = new Set([...candidates.map((c) => `${c.provider}:${c.id}`), ...additional.identities]);
    const analyzedKeys = new Set(allSessions.map((s) => s.sessionKey));
    const eligibleRows = rows.filter((row) => {
      // A registered row can contain earlier identities connected by explicit
      // resets. Let the fallback filter each receipt against canonical evidence.
      if (row.provider_session_id) return true;
      // Preserve the unique-legacy-match guard for otherwise unidentified rows.
      return !analyzedKeys.has(createHash("sha256").update(row.conductor_session_id).digest("hex").slice(0, 12));
    });
    const pairedRecovery: RecoveryComparison[] = [];
    try {
      for (const session of conductorFallback(database, eligibleRows, canonicalIdentities, pricing,
        explicitRepositoryFilter ? undefined : (session) => { pairedRecovery.push({ sessionKey: session.sessionKey, cost: { totalUsd: session.cost.totalUsd },
          conductor: { reconciliation: { receiptFloorApplied: session.conductor?.reconciliation?.receiptFloorApplied === true } } }); }, index?.conductor)) {
        allSessions.push(session);
        if (!repositoryById.has(session.repositoryId)) {
          const root = `unassigned:${session.repositoryId}`;
          discovered.set(root, { id: session.repositoryId, name: session.repositoryName, root_path: root, remote_url: null, default_branch: "" });
        }
      }
    } catch (error) {
      // Index failures rerun the whole scan unindexed; only source failures are tolerated here.
      if (error instanceof IndexParityError || (error instanceof Error && error.message === INDEX_INTEGRITY)) throw error;
      additional.warnings.push("A provider evidence fallback could not be read; canonical sessions were retained.");
    }
    // Keep additional mutable stores fresh while retaining their entire public evidence on disk.
    for (const session of allSessions.filter((s) => s.evidence || s.provider === "unsupported")) {
      const repository = [...availableRepositories, ...discovered.values()].find((r) => r.id === session.repositoryId);
      index?.recordFresh(session, repository?.root_path ?? "", repository?.remote_url ?? "");
    }
    for (const candidate of candidates) {
      const fallbackKey = createHash("sha256").update(`${candidate.provider}:${candidate.id}`).digest("hex").slice(0, 12);
      index?.supersedeFallback(candidate.provider, fallbackKey);
    }
    // Persist only Cursor's public facts; keep its mutable databases on the fresh-read path.
    for (const session of cursorResult.sessions) {
      const repository = [...availableRepositories, ...discovered.values()].find(({ id }) => id === session.repositoryId);
      index?.recordCursor(session, repository?.root_path ?? "", repository?.remote_url ?? "");
    }
    let cursorComplete = !cursorResult.warning;
    if (index && !cursorComplete) {
      // node:sqlite can report a missing database as ERR_SQLITE_ERROR rather than ENOENT.
      try { await stat(cursorDatabasePath); }
      catch (error) { cursorComplete = asRecord(error)?.["code"] === "ENOENT"; }
    }
    const retainedSessions = index?.retained(
      [...codexIndex.paths.values(), ...claudeIndex.paths.values()].flat(),
      ![codexIndex.warning, claudeIndex.warning].some((warning) => warning?.includes("could not be read")),
      cursorComplete, additional.warnings.length === 0,
    ) ?? [];
    for (const session of [...retainedSessions, ...allSessions.filter(session => session.transcript.sourceDeleted)]) {
      const currentRepository = [...availableRepositories, ...discovered.values()].find((repository) =>
        repository.id === session.repositoryId || Boolean(repository.root_path && index?.matchesRoot(session.repositoryId, repository.root_path)));
      // Sessions indexed under a retired per-directory group had no repository evidence either.
      // The shared group has no root to match, so retained members rejoin it by ID.
      const repository = currentRepository ??
        (session.repositoryId === NO_REPOSITORY_ID || session.repositoryName.endsWith(LEGACY_LOCAL_DIRECTORY_SUFFIX)
          ? noRepositoryGroup(discovered) : null);
      if (repository) {
        session.repositoryId = repository.id;
        session.repositoryName = repository.name;
      }
      if (![...availableRepositories, ...discovered.values()].some(({ id }) => id === session.repositoryId)) {
        discovered.set(rootlessKey(session.repositoryId), {
          id: session.repositoryId, name: session.repositoryName, root_path: "", remote_url: null, default_branch: "",
        });
      }
    }
    allSessions.push(...retainedSessions);
    const retainedPopulation = allSessions.filter((session) => !index || index.inRetention(session));
    const allRepositories = [...availableRepositories, ...discovered.values()].sort((left, right) => left.name.localeCompare(right.name));
    // Build remaps before selection so --repo-id accepts portable IDs. Applying them after the
    // index commit keeps cached sessions and their signatures under local identities.
    const portableIds = new Map<string, string>();
    if (options.portableIds) {
      for (const { id, remote_url } of availableRepositories) {
        const remote = remote_url ? normalizeRemote(remote_url) : "";
        if (remote) portableIds.set(id, discoveredRepositoryId(`remote:${remote}`));
      }
      for (const { id, root_path, remote_url } of discovered.values()) {
        if (!remote_url && root_path && id === discoveredRepositoryId(root_path) && await gitRootForPath(root_path) === root_path) {
          portableIds.set(id, discoveredRepositoryId(JSON.stringify(["local", hostname(), root_path])));
        }
      }
    }
    const selectedRepositories = await selectRepositories(allRepositories, options, index, portableIds);
    // Resolve launch context after all provider adapters assigned repositories.
    let mcpContext: MachineAnalytics["mcpContext"];
    if (options.mcpCwd) {
      const inRepository = await gitRootForPath(options.mcpCwd) ||
        availableRepositories.some(({ root_path }) => root_path && pathInside(options.mcpCwd!, root_path)) ||
        workspaceRepositories.has(resolve(options.mcpCwd));
      const current = explicitRepositoryFilter ? selectedRepositories[0] : inRepository
        ? await repositoryForPath(options.mcpCwd, availableRepositories, workspaceRepositories, discovered) : null;
      mcpContext = { repositoryId: current ? portableIds.get(current.id) ?? current.id : null };
    }
    const selectedIds = new Set(selectedRepositories.map(({ id }) => id));
    const sessions = explicitRepositoryFilter
      ? retainedPopulation.filter(({ repositoryId }) => selectedIds.has(repositoryId))
      : retainedPopulation;
    const stableIndex = await index?.commit();
    const portableSessionKeys = new Map<string, string>();
    if (options.portableIds) for (const row of rows) {
      if ((row.agent_type === "claude" || row.agent_type === "codex") && row.provider_session_id) {
        const localKey = createHash("sha256").update(row.conductor_session_id).digest("hex").slice(0, 12);
        portableSessionKeys.set(`${row.agent_type}:${localKey}`, createHash("sha256").update(`${row.agent_type}:${row.provider_session_id}`).digest("hex").slice(0, 12));
      }
    }
    const outputKey = (session: SessionAnalytics): string => portableSessionKeys.get(`${session.provider}:${session.sessionKey}`) ?? session.sessionKey;
    const outputSessions = new Map<string, SessionAnalytics>();
    for (const session of sessions) {
      const key = `${session.provider}:${outputKey(session)}`, current = outputSessions.get(key);
      const time = timestampMilliseconds(session.lastEventAt), prior = timestampMilliseconds(current?.lastEventAt);
      const last = Number.isFinite(time) ? time : -Infinity, previous = Number.isFinite(prior) ? prior : -Infinity;
      if (!current || last > previous || (last === previous && session.metrics.modelCalls > current.metrics.modelCalls)) outputSessions.set(key, session);
    }
    const sessionsByRepository = new Map<string, SessionAnalytics[]>();
    for (const session of outputSessions.values()) {
      const repositorySessions = sessionsByRepository.get(session.repositoryId) ?? [];
      repositorySessions.push(session);
      sessionsByRepository.set(session.repositoryId, repositorySessions);
    }
    // Committed facts keep local IDs; registrations sharing a portable ID become one repository.
    const repositoriesForOutput = new Map<string, { repository: RepositoryRow; sessions: SessionAnalytics[] }>();
    for (const repository of selectedRepositories) {
      const id = portableIds.get(repository.id) ?? repository.id;
      const output = repositoriesForOutput.get(id) ?? { repository: id === repository.id ? repository : { ...repository, id }, sessions: [] };
      for (const session of sessionsByRepository.get(repository.id) ?? []) {
        output.sessions.push({ ...session, sessionKey: outputKey(session), repositoryId: id, repositoryName: output.repository.name });
      }
      repositoriesForOutput.set(id, output);
    }
    return {
      ...(!explicitRepositoryFilter ? { historyCoverage: {
        ...await collectHistoryCoverage(claudeRoots, [...outputSessions.values()], rateCard, options.claudeRoot ? undefined : { home: homedir(), override: process.env["CLAUDE_CONFIG_DIR"] }),
        recoveryCalibration: calibrateRecovery([...outputSessions.values()], pairedRecovery),
      } } : {}),
      ...(mcpContext ? { mcpContext } : {}),
      mcpSourceHealth: [sourceHealth("claude", claudeIndexes.map((item) => item.warning)),
        sourceHealth("codex", codexIndexes.map((item) => item.warning)), sourceHealth("cursor", [cursorResult.warning])],
      rateCard,
      providerWarnings: [...new Set(additional.warnings)],
      repositories: [...repositoriesForOutput.values()].map(({ repository, sessions: repositorySessions }) => {
        const result = aggregate(repository, repositorySessions, rateCard);
        result.warnings.push(
          ...[codexIndex.warning, claudeIndex.warning, cursorResult.warning, ...additional.warnings].filter(
            (warning): warning is string => Boolean(warning),
          ),
        );
        if (stableIndex === false) result.warnings.push("Evidence changed during analysis; unstable index groups were deferred until the next scan.");
        result.warnings = [...new Set([...result.warnings.filter((warning) => !warning.startsWith("A provider transcript root")), ...scanWarnings(result.warnings)])];
        return result;
      }),
    };
  } catch (error) {
    if (!(error instanceof IndexParityError) || options.noIndex) throw error;
    // Discard every partial claim and close the writer before a fresh, unindexed scan.
    const failedIndex = index; index = null; failedIndex?.close();
    const failedDatabase = database; database = null; failedDatabase?.close();
    const result = await analyzeSelectedRepositories({ ...options, noIndex: true });
    result.providerWarnings.push(indexParityWarning);
    for (const repository of result.repositories) repository.warnings.push(indexParityWarning);
    return result;
  } finally {
    database?.close();
    index?.close();
  }
}

function aggregateMachine(
  repositories: RepositoryAnalytics[],
  rateCard: PricingCatalog,
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
    velocity: combined.velocity,
    generatedAt: combined.generatedAt,
    schemaVersion: 1,
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
      workingSnapshots: sessions.filter(({ transcript }) => transcript.snapshotWhileWorking && !transcript.sourceDeleted &&
        !transcript.warnings.includes("Source availability could not be checked; showing the last indexed facts.")).length,
    },
    topTools: combined.topTools,
    warnings: [
      ...new Set([
        ...combined.warnings,
        ...repositories.flatMap(({ warnings }) =>
          [...warnings.filter((warning) => warning.startsWith("A provider ")), ...scanWarnings(warnings), ...warnings.filter((w) => w.startsWith("Evidence changed during analysis"))],
        ),
      ]),
    ],
  };
}

/** Analyze every locally evidenced repository unless an explicit repository filter is supplied. */
export async function analyzeMachineSessions(
  options: AnalyzeOptions = {},
  hooks: AnalysisHooks = {},
): Promise<MachineAnalytics> {
  const result = await analyzeSelectedRepositories(options, hooks);
  const machine = aggregateMachine(result.repositories, result.rateCard);
  machine.warnings = [...new Set([...machine.warnings, ...result.providerWarnings])];
  if (result.historyCoverage) machine.historyCoverage = result.historyCoverage;
  machine.mcpSourceHealth = result.mcpSourceHealth;
  if (result.mcpContext) machine.mcpContext = result.mcpContext;
  return machine;
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
