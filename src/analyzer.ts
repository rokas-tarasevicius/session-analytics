import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { opendir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ReliabilityCollector, type ReliabilityContext } from "./metrics/reliability.ts";
import { combineReliability, observeClaude, observeCodex } from "./metrics/reliability-providers.ts";
import { loadReliabilitySecret } from "./metrics/reliability-secret.ts";
import type { SessionReliability } from "./metrics/reliability-types.ts";

import {
  VelocityAccumulator, claudeEntrypoint, claudeSubagentType, codexOriginator, codexSource, counterExposed,
  publicModelId, usageVelocity, velocityDimension, velocityMetadata, zeroVelocity,
} from "./metrics/velocity.ts";
import { CacheContextCollector, claudeRequestEvidence, type RequestEvidence } from "./metrics/cache-context.ts";
import { claudeContextWindow } from "./metrics/context-windows.ts";
import { LimitsCollector } from "./metrics/limits.ts";
import type { LimitsCacheAnalytics } from "./metrics/limits-cache-types.ts";
import { timestamp as normalizedTimestamp } from "./metrics/limits-utils.ts";
import { publicModel } from "./public-model.ts";
import { boundContextDetail } from "./metrics/context-detail.ts";
import { OutcomeCollector } from "./metrics/outcomes.ts";
import { OutcomeEnricher } from "./metrics/outcomes-enrichment.ts";
import { summarizeOutcomes } from "./metrics/outcomes-summary.js";
import { WorkflowCollector } from "./metrics/workflow.ts";
import { addRepositorySkills, historyForTranscript, loadWorkflowSources } from "./metrics/workflow-inventory.ts";
import type { WorkflowSources } from "./metrics/workflow-inventory.ts";
import type { WorkflowInventory } from "./metrics/workflow-types.ts";
import { summarizeWorkflow } from "./public/workflow-data.js";
import { cacheGapSignals } from "./insights/cache-gaps.ts";
import { TranscriptLifecycle } from "./insights/transcript-evidence.ts";
import { captureReviewSource, sameVersion, verifyReviewSource } from "./insights/review-source.ts";
import type { ReviewSource } from "./insights/review-source.ts";
import { canonicalMcpServer } from "./insights/mcp-attribution.ts";

import { aggregateSessions } from "./public/export-data.js";
import { normalizeTimestamp, timestampMilliseconds } from "./public/timestamps.js";
import { modelPattern, metadataPattern, sessionStatuses, scanWarnings } from "./public/evidence.js";
import { McpEvidenceCollector } from "./mcp/evidence.ts";
import { sourceHealth } from "./mcp/source-health.ts";

import { IndexScan } from "./store/index.ts";
import { codexCounterFingerprint, readCodexLedger } from "./store/codex-ledger.ts";

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

import { createClaudeAdapter } from "./providers/claude.ts";
import { additionalProviderSessions } from "./providers/index.ts";
import { modelName, name as safeName, effortName, safeTime, statusName } from "./providers/common.ts";
import { conductorFallback } from "./providers/conductor.ts";
import { loadReviewed, loadPricingCatalog, mergeProvenance, publicRateCard, resolveRate, type PricingCatalog } from "./pricing/catalog.ts";
import { projectModelId } from "./public/model-id.js";
import { priceUsage } from "./pricing/usage.ts";

const toolRoot = new URL(".", import.meta.url);
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
  dimension: VelocityDimension;
  lastReasoningExposed: boolean;
  lastCacheReadExposed: boolean;
  totalReasoningExposed: boolean;
  totalCacheReadExposed: boolean;
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

export interface MutableSession {
  agentIdentity: AgentIdentity;
  velocity: VelocityAccumulator;
  startDimension: VelocityDimension | null;
  limitsCache: CacheContextCollector;
  limitsProvider: "claude" | "codex" | null;
  outcomes?: SessionAnalytics["outcomes"];
  workflow?: WorkflowCollector;
  mcpServers: Record<string, number>;
  requestSizes: { observedTokens: number; unknownTokens: number };
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
  skills: Record<string, number>;
  spendByDay: Record<string, number>;
  summaries: number;
  taskCompletions: number;
  taskStarts: number;
  tools: Record<string, number>;
  transportTools: Record<string, number>;
  userTurns: number;
  warnings: string[];
}

// Optional projections must never suppress core usage or tool accounting.
function updateWorkflow(state: MutableSession, update: (collector: WorkflowCollector) => void): void {
  if (!state.workflow) return;
  try { update(state.workflow); }
  catch { state.workflow.gap("projection"); }
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

function isoDay(timestamp: string | null, fallback: string): string {
  const date = new Date(safeTime(timestamp) ?? safeTime(fallback) ?? "2000-01-01T00:00:00Z");
  return date.toISOString().slice(0, 10);
}

function trackTimestamp(session: MutableSession, timestamp: string | null): void {
  const instant = timestampMilliseconds(timestamp);
  if (!Number.isFinite(instant)) return;
  const normalized = new Date(instant).toISOString();
  if (!session.firstEventAt || instant < Date.parse(session.firstEventAt)) session.firstEventAt = normalized;
  if (!session.lastEventAt || instant > Date.parse(session.lastEventAt)) session.lastEventAt = normalized;
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
  fallbackTimestamp: string,
  executionKind: SessionAnalytics["executionKind"] = session.executionKind,
  velocityContext?: { dimension: VelocityDimension; reasoning: boolean; cacheRead: boolean; cacheWrite: boolean },
  requestEvidence?: RequestEvidence,
  requestSizeKnown = true,
): void {
  model = projectModelId(model);
  if (requestSizeKnown) session.maxInputTokensPerCall = Math.max(session.maxInputTokensPerCall, inputForRequest);
  session.requestSizes[requestSizeKnown ? "observedTokens" : "unknownTokens"] += tokenCount(usage);
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
  aggregate.calls += 1;
  sumTokens(aggregate, usage);
  aggregate.pricingCoverage!.eligibleTokens += tokenCount(usage);
  const selected = resolveRate(rateCard, model, timestamp);
  const pricedRequest = selected ? priceUsage(selected.rate, usage, inputForRequest) : null;
  session.mcpEvidence.usage(isoDay(timestamp, fallbackTimestamp), tokenCount(usage), pricedRequest?.pricedTokens ?? 0);
  if (requestEvidence && session.limitsProvider) {
    session.limitsCache.addRequest(model, usage, selected?.rate, pricedRequest?.cost ?? null, timestamp, executionKind, requestEvidence, session.limitsProvider);
    if (requestEvidence.requestInputKnown) {
      session.maxInputTokensPerCall = Math.max(session.maxInputTokensPerCall, usage.inputTokens);
      session.maxContextWindow = Math.max(session.maxContextWindow,
        requestEvidence.contextWindow ?? (session.limitsProvider === "claude" ? claudeContextWindow(model) : null) ?? 0);
    }
  }
  if (velocityContext && !selected) session.velocity.add(timestamp, velocityContext.dimension, usageVelocity(usage, 0, false, velocityContext));
  if (!selected) {
    aggregate.priced = false;
    return;
  }
  const { cost, pricedTokens, assumptions } = pricedRequest!;
  mergeProvenance(aggregate, [{ ...selected.provenance, assumptions }]);
  aggregate.pricingCoverage!.pricedTokens += pricedTokens;
  aggregate.priced &&= pricedTokens === tokenCount(usage);
  if (velocityContext) session.velocity.add(timestamp, velocityContext.dimension, usageVelocity(usage, cost.totalUsd, pricedTokens === tokenCount(usage), velocityContext));
  // Claude child transcripts contribute to accounting, but not to their
  // parent's interaction clock. Codex child threads have their own clock.
  updateWorkflow(session, (workflow) => workflow.value(timestamp, cost.totalUsd, executionKind));
  sumCost(aggregate, cost);
  if (executionKind === "subagent") session.costByExecution.subagentUsd += cost.totalUsd;
  else if (executionKind === "top-level") session.costByExecution.topLevelUsd += cost.totalUsd;
  else session.costByExecution.unknownUsd += cost.totalUsd;
  increment(session.spendByDay, isoDay(timestamp, fallbackTimestamp), cost.totalUsd);
}

function createMutableSession(): MutableSession {
  return {
    agentIdentity: {},
    velocity: new VelocityAccumulator(),
    startDimension: null,
    limitsCache: new CacheContextCollector(),
    limitsProvider: null,
    mcpServers: Object.create(null) as Record<string, number>,
    requestSizes: { observedTokens: 0, unknownTokens: 0 },
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
    skills: {},
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
      return { cwd: stringValue(payload?.["cwd"]), id: stringValue(payload?.["id"]), timestamp: normalizeTimestamp(record["timestamp"]) };
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

function normalizedSkillName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name) ? name : null;
}

function inferredSkillNames(input: unknown): string[] {
  if (typeof input !== "string") return [];
  const names = new Set<string>();
  const pattern = /(?:^|[\\/'"`\s])([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/SKILL\.md\b/g;
  for (const match of input.matchAll(pattern)) {
    const name = normalizedSkillName(match[1]);
    if (name) names.add(name);
  }
  return [...names];
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

async function buildCodexCounterLedger(
  paths: string[], index: IndexScan | null = null,
  retainedOwners: Map<string, { path: string; timestamp: string; modelFallback: string | null }> = new Map(),
): Promise<Map<string, CodexCounterOwner>> {
  const owners = new Map<string, CodexCounterOwner>();
  for (const path of paths) {
    const evidence = index ? await index.codexLedger(path) : (await readCodexLedger(path)).evidence;
    const modelFallback = evidence.models.length === 1 ? evidence.models[0] ?? null : null;
    for (const observation of evidence.observations) {
      const candidate = {
        activityDeltaMilliseconds: observation.activityDeltaMilliseconds ?? Infinity,
        modelFallback, path, timestamp: observation.timestamp,
      };
      if (codexCounterOwnerPrecedes(candidate, owners.get(observation.fingerprint))) owners.set(observation.fingerprint, candidate);
    }
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
  reliabilityContext: ReliabilityContext = { contentRules: false, secret: null },
  limits?: LimitsCollector,
  outcomeEnricher: OutcomeEnricher = new OutcomeEnricher(),

  index: IndexScan | null = null,
  attributedCounters: Set<string> | null = null,
  isPrunedCounter: (fingerprint: string) => boolean = () => false,
): Promise<SessionAnalytics | null> {
  if (index) {
    const attributed = new Set<string>();
    return index.session(row, [path], inheritedWarnings,
      () => analyzeCodex(row, path, rateCard, inheritedWarnings, counterLedger, claimedCounters, reliabilityContext, limits, outcomeEnricher, null, attributed, (counter) => index.isPrunedCounter(counter)),
      claimedCounters, counterLedger, attributed);
  }
  const state = createMutableSession();
  const reliability = new ReliabilityCollector(reliabilityContext);
  let reliabilityCwd = row.workspace_path;
  state.limitsProvider = "codex";
  state.limitsCache.profileKey = limits?.profileKey(path) ?? null;
  const sessionLimits = limits?.fork();
  const outcomes = new OutcomeCollector(row);
  state.workflow = new WorkflowCollector("codex");
  const mcpEvidence = state.mcpEvidence;
  state.warnings.push(...inheritedWarnings);
  const tokenEvents: TokenEvent[] = [];
  const seenCalls = new Set<string>();
  let currentModel = projectModelId(row.database_model);
  let currentIdentity: AgentIdentity = {};
  const sourceBefore = await stat(path);
  const lifecycle = new TranscriptLifecycle();
  const seenMcp = new Set<string>();
  let parseErrors = 0;
  // Codex has recorded the same lifecycle events in several shapes over time:
  // legacy `event_msg` notifications, `item_completed` items, and top-level
  // `compacted` records. A file can carry more than one shape for the same
  // event. Turns/messages use the largest shape count; compaction boundaries
  // are reconciled individually by the shared cache/context collector.
  const legacy = { agentMessages: 0, compactions: 0, userMessages: 0 };
  const compactedRecords = { count: 0 };
  const items = {
    agentMessages: new Set<string>(),
    compactions: new Set<string>(),
    userMessages: new Set<string>(),
  };

  await visitJsonLines(path, (record, line) => {
    mcpEvidence.codex(record);
    if (record["__parse_error"] === true) {
      parseErrors += 1;
      reliability.truncated = true;
      state.workflow?.gap("malformed");
      return;
    }
    if (record["type"] === "session_meta" || record["type"] === "turn_context") {
      reliabilityCwd = stringValue(asRecord(record["payload"])?.["cwd"]) ?? reliabilityCwd;
    }
    observeCodex(reliability, record, line, reliabilityCwd);
    const timestamp = normalizeTimestamp(record["timestamp"]);
    outcomes.observeCodex(record, line);
    lifecycle.observe("codex", record);
    trackTimestamp(state, timestamp);
    updateWorkflow(state, (workflow) => workflow.observe(record, line));
    const type = stringValue(record["type"]);
    const payload = asRecord(record["payload"]);
    const payloadType = stringValue(payload?.["type"]);
    sessionLimits?.observe(path, record, row.conductor_session_id);

    if (type === "session_meta") {
      currentIdentity = { codexSource: codexSource(payload?.["source"]), codexOriginator: codexOriginator(payload?.["originator"]) };
      if (!state.agentIdentity.codexSource) state.agentIdentity = currentIdentity;
      state.executionKind = asRecord(payload?.["source"])?.["subagent"]
        ? "subagent"
        : "top-level";
      state.executionKindsSeen.add(state.executionKind);
      return;
    }

    if (type === "turn_context") {
      if (payload && Object.hasOwn(payload, "model")) currentModel = projectModelId(payload["model"]);
      state.effort = effortName(payload?.["effort"]) ?? state.effort;
      state.startDimension ??= velocityDimension("codex", currentIdentity, state.executionKind, currentModel, state.effort);
      return;
    }
    if (type === "compacted") {
      compactedRecords.count += 1;
      state.limitsCache.addCompaction(path, "compacted", stringValue(record["id"]) ?? stringValue(payload?.["id"]), timestamp, state.executionKind, Math.max(legacy.userMessages, items.userMessages.size));
      return;
    }
    if (type === "event_msg") {
      if (payloadType === "user_message") legacy.userMessages += 1;
      if (payloadType === "agent_message") legacy.agentMessages += 1;
      if (payloadType === "task_started") state.taskStarts += 1;
      if (payloadType === "task_complete") state.taskCompletions += 1;
      if (payloadType === "context_compacted") {
        legacy.compactions += 1;
        state.limitsCache.addCompaction(path, "legacy", stringValue(payload?.["id"]), timestamp, state.executionKind, Math.max(legacy.userMessages, items.userMessages.size));
      }
      if (payloadType === "item_completed") {
        const item = asRecord(payload?.["item"]);
        const itemId = stringValue(item?.["id"]) ?? `${line}`;
        const itemType = stringValue(item?.["type"]);
        if (itemType === "UserMessage") items.userMessages.add(itemId);
        if (itemType === "AgentMessage") items.agentMessages.add(itemId);
        if (itemType === "ContextCompaction") {
          items.compactions.add(itemId);
          state.limitsCache.addCompaction(path, "item", stringValue(item?.["id"]), timestamp, state.executionKind, Math.max(legacy.userMessages, items.userMessages.size));
        }
        if (itemType === "McpToolCall" && !seenMcp.has(itemId)) {
          seenMcp.add(itemId);
          const server = canonicalMcpServer(item?.["server"]);
          if (server) increment(state.mcpServers, server);
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
            dimension: velocityDimension("codex", currentIdentity, state.executionKind, currentModel, state.effort),
            lastReasoningExposed: counterExposed(last?.["reasoning_output_tokens"]),
            lastCacheReadExposed: counterExposed(last?.["cached_input_tokens"]),
            totalReasoningExposed: counterExposed(total["reasoning_output_tokens"]),
            totalCacheReadExposed: counterExposed(total["cached_input_tokens"]),
            evidence: { stream: path, contextWindow: nonNegativeNumberValue(info?.["model_context_window"]) || null,
              requestInputKnown: typeof last?.["input_tokens"] === "number" && Number.isFinite(last["input_tokens"]) && last["input_tokens"] >= 0,
              compactions: Math.max(legacy.compactions, compactedRecords.count, items.compactions.size), reportedReason: null, ttlMinutes: null },
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
      updateWorkflow(state, (workflow) => workflow.tool(timestamp, Math.max(1, nested.length)));
      const canReadSkill =
        ["Bash", "Read", "exec_command", "read_file"].includes(transportName) ||
        nested.some((name) => ["exec_command", "read_file"].includes(name));
      if (canReadSkill) {
        const skillInput = payload?.["input"] ?? payload?.["arguments"];
        for (const name of inferredSkillNames(skillInput)) increment(state.skills, name);
      }
      state.velocity.tool(timestamp, velocityDimension("codex", currentIdentity, state.executionKind, currentModel, state.effort), Math.max(1, nested.length));
      if (nested.length === 0) {
        increment(state.tools, transportName);
      } else {
        for (const name of nested) increment(state.tools, name);
      }
    }
  });

  state.userTurns = Math.max(legacy.userMessages, items.userMessages.size);
  state.assistantMessages = Math.max(legacy.agentMessages, items.agentMessages.size);
  state.compactions = Math.max(legacy.compactions, compactedRecords.count, items.compactions.size);
  if (parseErrors > 0) state.warnings.push(`${parseErrors} malformed JSONL records were skipped.`);
  const finalTokens = zeroTokens();
  let previous = zeroTokens();
  let previousReasoningExposed = false, previousCacheReadExposed = false;
  let baselined = false;
  let counterResets = 0;
  let sharedSnapshots = 0;
  let missingLastUsage = 0;
  let unattributableBaselines = 0;
  for (const event of tokenEvents) {
    const reset = !monotonic(event.total, previous);
    if (reset) counterResets += 1;
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
    previous = event.total;
    previousReasoningExposed = event.totalReasoningExposed;
    previousCacheReadExposed = event.totalCacheReadExposed;
    baselined = true;
    let observed = attributableDelta;
    const owner = event.fingerprint ? counterLedger?.get(event.fingerprint) : undefined;
    if (event.last && tokenCount(event.last) > 0 && event.fingerprint) {
      if (
        isPrunedCounter(event.fingerprint) ||
        (owner && (owner.path !== path || owner.timestamp !== event.timestamp)) ||
        claimedCounters.has(event.fingerprint)
      ) {
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
      if (tokenCount(attributableDelta) === 0 && tokenCount(event.total) > 0) {
        unattributableBaselines += 1;
      }
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
        { dimension: { ...event.dimension, model }, ...exposure, cacheWrite: false },
        event.evidence,
        Boolean(event.last && tokenCount(event.last) > 0 && event.requestSizeKnown),
      );
    }
  }
  if (counterResets > 0) {
    state.warnings.push(
      `${counterResets} cumulative token counter reset${counterResets === 1 ? " was" : "s were"} re-baselined as a new observed segment.`,
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
  const sourceAfter = await stat(path);
  state.completeness = parseErrors || !sameVersion(sourceBefore, sourceAfter) ? "partial" : "complete";
  state.liveness = lifecycle.liveness();
  state.outcomes = await outcomes.finish(outcomeEnricher, state.firstEventAt, state.lastEventAt);
  const result = finalizeSession(row, state, finalTokens, 1);
  result.reliability = combineReliability([reliability.finish()], row.status === "working");
  if (result.limitsCache && sessionLimits) result.limitsCache.quotaEvidence = sessionLimits.evidence();
  return result;
}

const claudeAdapter = createClaudeAdapter({
  createMutableSession, walkJsonl, visitJsonLines, trackTimestamp, addModelUsage, finalizeSession, updateWorkflow,
  async discoverRoots({ home, environment }) {
    return (await discoverProviderRoots({ home, claudeConfigDirectory: environment["CLAUDE_CONFIG_DIR"], codexHome: environment["CODEX_HOME"] })).claude;
  },
  async identify(root) { return transcriptCandidates((await indexProviderTranscripts(root, null, "claude")).paths, "claude"); },
});

async function claudeEvidencePaths(mainPath: string): Promise<string[]> {
  const paths = [mainPath];
  try { for await (const path of walkJsonl(mainPath.slice(0, -6) + "/subagents")) paths.push(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return paths;
}

async function analyzeClaude(row: SessionDatabaseRow, path: string, rateCard: PricingCatalog, warnings: string[], reliabilityContext: ReliabilityContext = { contentRules: false, secret: null }, limits?: LimitsCollector, outcomeEnricher: OutcomeEnricher = new OutcomeEnricher(), workflowSources?: WorkflowSources, contentRules = false, index: IndexScan | null = null): Promise<SessionAnalytics | null> {
  if (index) {
    const history = await historyForTranscript(path, workflowSources, row.root_path);
    const dependency = history ? { available: history.available, commands: [...history.commands], registry: [...history.commandNames] } : null;
    return index.session(row, await claudeEvidencePaths(path), warnings,
      () => analyzeClaude(row, path, rateCard, warnings, reliabilityContext, limits, outcomeEnricher, workflowSources, contentRules),
      undefined, undefined, undefined, dependency);
  }
  const session = await claudeAdapter.analyze({ path, cwd: row.workspace_path, id: row.provider_session_id ?? "", provider: "claude", timestamp: row.created_at }, { row, rateCard, warnings, reliabilityContext, limits, outcomeEnricher, workflowSources, contentRules });
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
  for (const names of [state.tools, state.transportTools, state.skills]) {
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
  const limitsCache = state.limitsProvider ? state.limitsCache.finalize() : undefined;
  const contextUtilizationPeak = limitsCache?.context.peakFill ?? null;
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
    compactions: limitsCache?.compactionCount ?? state.compactions,
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
  let workflow: SessionAnalytics["workflow"];
  try { workflow = state.workflow?.finish(Date.now(), row.status === "working"); }
  catch { state.warnings.push("Workflow projection is unavailable; accounting was retained."); }
  return {
    mcpEvidence: state.mcpEvidence.finish(row.status === "working"),
    agentIdentity: state.agentIdentity,
    velocity: state.velocity.finish(row.created_at, state.startDimension ?? velocityDimension(row.agent_type as SessionProvider, state.agentIdentity, state.executionKind, "<unknown>", null)),
    ...(limitsCache ? { limitsCache } : {}),
    ...(workflow ? { workflow } : {}),
    ...(row.agent_type === "claude" || row.agent_type === "codex" ? { insightSignals: { requestSizes: { ...state.requestSizes }, ...(Object.keys(state.mcpServers).length ? { mcpServers: state.mcpServers } : {}) } } : {}),
    cost,
    ...(state.outcomes ? { outcomes: state.outcomes } : {}),
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
    skillEvidence:
      row.agent_type === "claude"
        ? "explicit"
        : row.agent_type === "codex"
          ? "inferred"
          : "unavailable",
    skills: state.skills,
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
  rateCard: PricingCatalog,
  warnings: string[] = ["Discovered directly from the machine-wide provider transcript store."],
  codexCounterLedger: Map<string, CodexCounterOwner> | null = null,
  claimedCodexCounters: Set<string> = new Set<string>(),
  reliabilityContext: ReliabilityContext = { contentRules: false, secret: null },
  limits?: LimitsCollector,
  outcomeEnricher: OutcomeEnricher = new OutcomeEnricher(),
  workflowSources?: WorkflowSources,
  contentRules = false,
  index: IndexScan | null = null,
): Promise<SessionAnalytics | null> {
  const timestamp = candidate.timestamp ?? new Date((await stat(candidate.path)).mtimeMs).toISOString();
  const row = syntheticSessionRow(candidate.provider, candidate.id, candidate.cwd, timestamp, repository);
  const session = candidate.provider === "codex"
    ? await analyzeCodex(row, candidate.path, rateCard, warnings, codexCounterLedger, claimedCodexCounters, reliabilityContext, limits, outcomeEnricher, index)
    : await analyzeClaude(row, candidate.path, rateCard, warnings, reliabilityContext, limits, outcomeEnricher, workflowSources, contentRules, index);
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
  for (const [rawModel, rawUsage] of Object.entries(usageData ?? {})) {
    const model = projectModelId(rawModel);
    const usage = asRecord(rawUsage);
    const value = Math.max(0, numberValue(usage?.["costInCents"]) / 100);
    if (value === 0) continue;
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
  const outcomes = new OutcomeCollector(row);
  outcomes.observeCursor(data);
  state.outcomes = outcomes.project();
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
      const headerPath = headerWorkspaces.workspaces.get(id);
      if (headerPath) paths.push(headerPath);
      let cwd = join(homedir(), ".cursor", "unassigned");
      for (const path of paths) {
        const gitRoot = await gitRootForPath(path);
        if (gitRoot) { cwd = gitRoot; break; }
        if (cwd.endsWith("/.cursor/unassigned")) cwd = path.endsWith(".code-workspace") ? dirname(path) : path;
      }
      const repository = await repositoryForPath(cwd, repositories, workspaceRepositories, discovered);
      const executionKind =
        data["isBestOfNSubcomposer"] === true ||
        Boolean(data["subagentInfo"]) ||
        headerWorkspaces.subagents.has(id)
          ? "subagent"
          : "top-level";
      const session = analyzeCursorComposer(data, repository, cwd, executionKind, conversation);
      if (session) results.push(session);
    }
    return { sessions: results, warning: null };
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
  // Optional workspace columns vary by Conductor version. Older schemas remain supported.
  const workspaceColumns = new Set((database.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map(({ name }) => name));
  const archiveCommit = workspaceColumns.has("archive_commit") ? "w.archive_commit" : "NULL";
  const prPresent = workspaceColumns.has("pr_title") ? "CASE WHEN length(trim(w.pr_title)) > 0 THEN 1 ELSE 0 END" : "0";
  const workspaceStatus = workspaceColumns.has("derived_status") ? "w.derived_status" : "NULL";
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
        w.id AS outcome_workspace_id,
        ${archiveCommit} AS outcome_archive_commit,
        ${prPresent} AS outcome_pr_present,
        ${workspaceStatus} AS outcome_workspace_status,
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
  index: IndexScan | null = null,
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
    const matches = repositories.filter((repository) =>
      normalizeRemote(repository.remote_url ?? "") === normalizeRemote(options.repositoryRemote as string) ||
      index?.matchesRemote(repository.id, options.repositoryRemote as string));
    if (matches.length !== 1) throw new Error("No unique evidenced repository has the requested remote.");
    return matches;
  }
  if (options.repositoryRoot) {
    const canonicalRoot = resolve(options.repositoryRoot);
    const matches = repositories.filter(({ id, root_path }) => (root_path && resolve(root_path) === canonicalRoot) || index?.matchesRoot(id, canonicalRoot));
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
    outcomes: summarizeOutcomes(sessions),
    rateCard: publicRateCard(rateCard),
    repository: {
      id: repository.id,
      name: repository.name,
    },
    sessions,
    ...aggregateSessions(sessions),
  };
}

/** Internal review hook. Paths stay in the review worker and never enter a snapshot. */
export type EvidenceObserver = ((session: SessionAnalytics, path: string, source: ReviewSource) => void) & { sessionKey?: string };

async function analyzeObservedEvidence(path: string, provider: "claude" | "codex", id: string, cwd: string, analyze: () => Promise<SessionAnalytics | null>, observer?: EvidenceObserver, correlationId = `${provider}:${id}`): Promise<SessionAnalytics | null> {
  const selected = observer && (!observer.sessionKey || observer.sessionKey === createHash("sha256").update(correlationId).digest("hex").slice(0, 12));
  const source = selected ? await captureReviewSource(path, provider) : null;
  if (source && (source.id !== id || source.cwd !== cwd)) throw new Error("Review evidence identity changed.");
  const session = await analyze();
  if (source && session) { await verifyReviewSource(path, source); observer!(session, path, source); }
  return session;
}

async function analyzeSelectedRepositories(
  options: AnalyzeOptions,
  observeEvidence?: EvidenceObserver,
): Promise<{ rateCard: PricingCatalog; repositories: RepositoryAnalytics[]; providerWarnings: string[]; limitsCache: LimitsCacheAnalytics; workflowInventory: WorkflowInventory; mcpContext?: MachineAnalytics["mcpContext"]; mcpSourceHealth: MachineAnalytics["mcpSourceHealth"] }> {
  const databasePath =
    options.databasePath ?? join(homedir(), "Library/Application Support/com.conductor.app/conductor.db");
  const rateCard = await loadPricingCatalog(options);
  const reliabilityContext: ReliabilityContext = {
    contentRules: options.reliabilityContentRules === true,
    secret: options.reliabilityContentRules === true ? await loadReliabilitySecret(options.dataDir) : null,
  };
  const outcomeEnricher = new OutcomeEnricher(options);
  let database: DatabaseSync | null = null;
  let index: IndexScan | null = null;
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
    const includeHidden = options.includeHidden ?? true;
    index = observeEvidence || options.outcomesGit || options.outcomesGithub ? null : await IndexScan.open(options, rateCard, includeHidden);
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
    }
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
    const limits = await LimitsCollector.create({ claude: claudeRoots, codex: codexRoots, home: homedir(),
      dataDirectory: options.dataDir, includeDesktop: !options.claudeRoot });
    const workflowSources = await loadWorkflowSources(claudeRoots, codexRoots,
      options.codexRoot || options.codexArchiveRoot ? undefined : join(homedir(), ".agents", "skills"));
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
      codexCandidates.map(({ path }) => path), index,
      index?.retainedCounterOwners(new Set(codexCandidates.map(({ id }) => index!.identity("codex", id))), [...codexIndex.paths.values()].flat()),
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
        return ["cursor", "copilot", "opencode", "gemini"].includes(row.agent_type) ? null : unavailableSession(row, "unsupported", ["Unsupported Conductor agent type."]);
      }
      const provider = row.agent_type as SessionProvider;
      const transcriptPaths = provider === "codex" ? codexIndex.paths : claudeIndex.paths;
      const selected = await selectTranscript(
        transcriptPaths.get(row.provider_session_id as string) ?? [],
        provider,
        row.provider_session_id as string,
        row.workspace_path,
      );
      if (!selected.path) {
        // Result-only evidence is considered after all canonical providers.
        return null;
      }
      try {
        const session = await analyzeObservedEvidence(selected.path, provider as "claude" | "codex", row.provider_session_id!, row.workspace_path, async () => provider === "codex"
          ? await analyzeCodex(row, selected.path!, rateCard, selected.warnings, codexCounterLedger, claimedCodexCounters, reliabilityContext, limits, outcomeEnricher, index)
          : await analyzeClaude(row, selected.path!, rateCard, selected.warnings, reliabilityContext, limits, outcomeEnricher, workflowSources, options.workflowContentRules, index), observeEvidence, row.conductor_session_id);
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
        return Math.abs(timestampMilliseconds(candidate.timestamp) - timestampMilliseconds(row.created_at)) <= 15 * 60_000;
      });
      if (matches.length !== 1 || !matches[0]) return null;
      const candidate = matches[0]; claimed.add(`${candidate.provider}:${candidate.id}`);
      try {
        return await analyzeObservedEvidence(candidate.path, candidate.provider, candidate.id, candidate.cwd, async () => candidate.provider === "codex"
          ? await analyzeCodex(row, candidate.path, rateCard, ["Recovered from a unique working-directory and start-time match in the provider transcript store."], codexCounterLedger, claimedCodexCounters, reliabilityContext, limits, outcomeEnricher, index)
          : await analyzeClaude(row, candidate.path, rateCard, ["Recovered from a unique working-directory and start-time match in the provider transcript store."], reliabilityContext, limits, outcomeEnricher, workflowSources, options.workflowContentRules, index), observeEvidence, row.conductor_session_id);
      } catch { return null; }
    });
    const discoveredSessions = await mapConcurrent(candidates.filter((candidate) =>
      !claimed.has(`${candidate.provider}:${candidate.id}`)), 1, async (candidate) => {
      const repository = await repositoryForPath(candidate.cwd, availableRepositories, workspaceRepositories, discovered);
      try { return await analyzeObservedEvidence(candidate.path, candidate.provider, candidate.id, candidate.cwd, () => analyzeTranscriptCandidate(candidate, repository, rateCard, undefined, codexCounterLedger, claimedCodexCounters, reliabilityContext, limits, outcomeEnricher, workflowSources, options.workflowContentRules, index), observeEvidence); } catch { return null; }
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
      knownPaths: [...new Set([...availableRepositories.map((r) => r.root_path), ...workspaceRepositories.keys(), ...discovered.keys(), ...candidates.map((c) => c.cwd)])],
      async repositoryForSession(identity, source) {
        if (identity.cwd) return repositoryForPath(identity.cwd, availableRepositories, workspaceRepositories, discovered);
        const key = createHash("sha256").update(`${source}:${identity.group ?? identity.id}`).digest("hex").slice(0, 20);
        const root = `unassigned:${key}`;
        let repository = discovered.get(root);
        if (!repository) {
          repository = { id: `discovered-${key}`, name: `${source === "gemini-chat" ? "Gemini" : "Cursor"} · unassigned ${key.slice(0, 4)}`, root_path: root, remote_url: null, default_branch: "" };
          discovered.set(root, repository);
        }
        return repository;
      },
    });
    allSessions.push(...additional.sessions);
    const canonicalIdentities = new Set([...candidates.map((c) => `${c.provider}:${c.id}`), ...additional.identities]);
    const analyzedKeys = new Set(allSessions.map((s) => s.sessionKey));
    const eligibleRows = rows.filter((row) => {
      if (analyzedKeys.has(createHash("sha256").update(row.conductor_session_id).digest("hex").slice(0, 12))) return false;
      const identity = `${row.agent_type}:${row.provider_session_id}`;
      return !row.provider_session_id || (!canonicalIdentities.has(identity) && !analyzedKeys.has(createHash("sha256").update(identity).digest("hex").slice(0, 12)));
    });
    try {
      for (const session of conductorFallback(database, eligibleRows, canonicalIdentities, pricing)) {
        allSessions.push(session);
        if (!repositoryById.has(session.repositoryId)) {
          const root = `unassigned:${session.repositoryId}`;
          discovered.set(root, { id: session.repositoryId, name: session.repositoryName, root_path: root, remote_url: null, default_branch: "" });
        }
      }
    } catch { additional.warnings.push("A provider evidence fallback could not be read; canonical sessions were retained."); }
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
    for (const session of retainedSessions) {
      const currentRepository = [...availableRepositories, ...discovered.values()].find((repository) =>
        repository.id === session.repositoryId || Boolean(repository.root_path && index?.matchesRoot(session.repositoryId, repository.root_path)));
      if (currentRepository) {
        session.repositoryId = currentRepository.id;
        session.repositoryName = currentRepository.name;
      }
      if (![...availableRepositories, ...discovered.values()].some(({ id }) => id === session.repositoryId)) {
        discovered.set(`retained:${session.repositoryId}`, {
          id: session.repositoryId, name: session.repositoryName, root_path: "", remote_url: null, default_branch: "",
        });
      }
    }
    allSessions.push(...retainedSessions);
    const retainedPopulation = allSessions.filter((session) => !index || index.inRetention(session));
    const allRepositories = [...availableRepositories, ...discovered.values()].sort((left, right) => left.name.localeCompare(right.name));
    const selectedRepositories = selectRepositories(allRepositories, options, index);
    // Resolve launch context after all provider adapters assigned repositories.
    let mcpContext: MachineAnalytics["mcpContext"];
    if (options.mcpCwd) {
      const inRepository = await gitRootForPath(options.mcpCwd) ||
        availableRepositories.some(({ root_path }) => root_path && pathInside(options.mcpCwd!, root_path)) ||
        workspaceRepositories.has(resolve(options.mcpCwd));
      const current = explicitRepositoryFilter ? selectedRepositories[0] : inRepository
        ? await repositoryForPath(options.mcpCwd, availableRepositories, workspaceRepositories, discovered) : null;
      mcpContext = { repositoryId: current?.id ?? null };
    }
    const selectedIds = new Set(selectedRepositories.map(({ id }) => id));
    for (const session of retainedPopulation) limits.replay(session.limitsCache?.quotaEvidence ?? []);
    const sessions = explicitRepositoryFilter
      ? retainedPopulation.filter(({ repositoryId }) => selectedIds.has(repositoryId))
      : retainedPopulation;
    const sessionsByRepository = new Map<string, SessionAnalytics[]>();
    boundContextDetail(sessions);
    for (const session of sessions) {
      const repositorySessions = sessionsByRepository.get(session.repositoryId) ?? [];
      repositorySessions.push(session);
      sessionsByRepository.set(session.repositoryId, repositorySessions);
    }
    const repositoriesForOutput = selectedRepositories;
    await addRepositorySkills(workflowSources.inventory, selectedRepositories);
    const stableIndex = await index?.commit();
    return {
      ...(mcpContext ? { mcpContext } : {}),
      mcpSourceHealth: [sourceHealth("claude", claudeIndexes.map((item) => item.warning)),
        sourceHealth("codex", codexIndexes.map((item) => item.warning)), sourceHealth("cursor", [cursorResult.warning])],
      rateCard,
      providerWarnings: [...new Set(additional.warnings)],
      limitsCache: limits.finalize(sessions, new Date().toISOString(), explicitRepositoryFilter),
      workflowInventory: workflowSources.inventory,
      repositories: repositoriesForOutput.map((repository) => {
        const result = aggregate(repository, sessionsByRepository.get(repository.id) ?? [], rateCard);
        result.workflow = summarizeWorkflow(result.sessions, workflowSources.inventory, result.generatedAt, [result.repository.id]);
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
    outcomes: combined.outcomes,
    schemaVersion: 1,
    rateCard: combined.rateCard,
    repositories: repositories.map(
      ({ repository, spendByDay, spendByModel, summary, topTools, warnings, outcomes }) => ({
        outcomes,
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
  observeEvidence?: EvidenceObserver,
): Promise<MachineAnalytics> {
  const result = await analyzeSelectedRepositories(options, observeEvidence);
  const machine = aggregateMachine(result.repositories, result.rateCard);
  machine.warnings = [...new Set([...machine.warnings, ...result.providerWarnings])];
  machine.limitsCache = result.limitsCache;
  machine.workflow = summarizeWorkflow(machine.sessions, result.workflowInventory, machine.generatedAt, machine.repositories.map((r) => r.repository.id));
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
  return { ...repository, limitsCache: result.limitsCache };
}
