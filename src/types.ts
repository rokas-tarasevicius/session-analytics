export type SessionProvider = "claude" | "codex" | "cursor" | "copilot" | "opencode" | "gemini" | "antigravity" | "unsupported";

import type { SessionHistory, HistoryStatistics, HistoryReconciliation, HistoryCoverage, HistoryProfileEvidence } from "./metrics/history-types.ts";

export type SessionStatus = "idle" | "working" | "completed" | "failed" | "error" | "interrupted" | "cancelled" | "pending" | "unknown";
import type { McpContext, McpSessionEvidence, McpSourceHealth } from "./mcp/types.ts";
export type * from "./mcp/types.ts";

export type CostBasis = "api-list-price-equivalent" | "provider-reported" | "unavailable";
export type ExecutionKind = "mixed" | "subagent" | "top-level" | "unknown";
export type { IndexStatus, IndexScanStats } from "./store/database.ts";

// Velocity is additive: old snapshots remain readable without these fields.
export type ClaudeEntrypoint = "cli" | "sdk" | "desktop" | "unknown";
export type ClaudeSubagentType = "general-purpose" | "explore" | "plan" | "other";
export type CodexSource = "cli" | "exec" | "vscode" | "subagent" | "review" | "unknown";
export type CodexOriginator = "cli" | "exec" | "vscode" | "desktop" | "unknown";
export type VelocityAgent =
  | "claude-cli" | "claude-sdk" | "claude-desktop" | "claude-unknown"
  | "claude-general-purpose" | "claude-explore" | "claude-plan" | "claude-subagent"
  | "codex-cli" | "codex-exec" | "codex-vscode" | "codex-desktop" | "codex-subagent" | "codex-review" | "codex-unknown"
  | "cursor" | "copilot" | "opencode" | "gemini" | "antigravity";
export type VelocityEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "unknown";
export interface AgentIdentity {
  claudeEntrypoint?: ClaudeEntrypoint;
  claudeSubagentType?: ClaudeSubagentType | "mixed";
  codexSource?: CodexSource;
  codexOriginator?: CodexOriginator;
}
export interface VelocityDimension {
  agent: VelocityAgent;
  model: string;
  executionKind: Exclude<ExecutionKind, "mixed">;
  effort: VelocityEffort;
}
/** Fixed-order counters avoid repeating field names in every hourly cell. */
export type VelocityValues = [
  valueUsd: number, inputTokens: number, uncachedInputTokens: number,
  cachedInputTokens: number, cacheWriteInputTokens: number, outputTokens: number,
  reasoningOutputTokens: number, modelCalls: number, toolCalls: number, sessionsStarted: number,
  pricedTokens: number, reasoningKnownOutputTokens: number,
  cacheReadKnownInputTokens: number, cacheWriteKnownInputTokens: number,
];
export interface SessionVelocity {
  dimensions: VelocityDimension[];
  buckets: Array<[day: string, hour: number, dimension: number, values: VelocityValues]>;
  undated: Array<[dimension: number, values: VelocityValues]>;
  /** Session-dated cells: counters whose own request/run time the source does not record,
   * placed on the session's last evidenced activity time (see docs/metrics.md). Absent when empty. */
  sessionDated?: Array<[day: string, hour: number, dimension: number, values: VelocityValues]>;
}
export interface VelocityMetadata {
  version: 1;
  timeZone: string;
}

export interface LongContextRate {
  inputMultiplier: number;
  outputMultiplier: number;
  thresholdInputTokens: number;
}

export interface ModelRate {
  provider: SessionProvider;
  inputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWrite5mPerMillion?: number;
  cacheWrite1hPerMillion?: number;
  cacheWriteMultiplier?: number;
  cacheWriteObservable?: boolean;
  outputPerMillion: number;
  longContext?: LongContextRate;
  contextTiers?: ContextPriceTier[];
  assumptions?: PricingAssumption[];
  source: string;
}

/** Numeric-only projection of the currently resolved public rate; built field by field. */
export interface PublicModelRate {
  provider: SessionProvider;
  inputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWrite5mPerMillion?: number;
  cacheWrite1hPerMillion?: number;
  cacheWriteMultiplier?: number;
  cacheWriteObservable?: boolean;
  outputPerMillion: number;
  longContext?: LongContextRate;
  contextTiers?: Array<Omit<ContextPriceTier, "assumptions">>;
}

/** Absolute USD/million prices above a per-request input boundary. */
export interface ContextPriceTier {
  aboveInputTokens: number;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWrite5mPerMillion?: number;
  cacheWrite1hPerMillion?: number;
  assumptions?: PricingAssumption[];
}

export type PricingSource = "models.dev" | "litellm";
export type PricingPolicy = "reviewed-first" | "api-first" | "reviewed-only";
export type PricingAssumption = "anthropic-cache-1h-2x" | "codex-cache-write-upper-1.25x"
  | "cache-write-upper-multiplier" | "cache-read-at-input" | "cache-write-5m-at-input"
  | "cache-write-5m-multiplier" | "cache-write-1h-at-5m" | "context-cache-read-at-base"
  | "context-cache-write-5m-at-base" | "context-cache-write-1h-at-base" | "cache-write-ttl-5m";

export interface RateProvenance {
  source: PricingSource | "reviewed";
  kind: "api" | "reviewed" | "fallback";
  snapshotDate: string;
  payloadSha256: string;
  rateModel: string;
  match: "exact" | "alias";
  temporal: "at-or-before" | "oldest" | "undated";
  assumptions: PricingAssumption[];
}

export interface PricingSourceStatus {
  source: PricingSource;
  url: string;
  fetchedAt: string | null;
  payloadSha256: string | null;
  ageDays: number | null;
  stale: boolean;
  models: number;
  rejectedModels: number;
}

export interface PricingStatus {
  offline: boolean;
  policy: PricingPolicy;
  refreshAfterDays: number;
  newestSnapshotAt: string | null;
  ageDays: number | null;
  stale: boolean;
  snapshots: number;
  sources: PricingSourceStatus[];
  warnings: Array<"cache-unavailable" | "invalid-snapshot" | "large-price-change" | "rejected-models">;
}

export interface PricingCoverage {
  modelsSeen: number;
  modelsPriced: number;
  ratio: number | null;
  bySource: Array<{ source: PricingSource | "reviewed"; models: number }>;
  unpricedModels: string[];
}

export interface PriceChange {
  source: PricingSource;
  model: string;
  change: "added" | "removed" | "changed";
  large: boolean;
  before: ModelRate | null;
  after: ModelRate | null;
}

export interface PricingUpdateResult {
  status: "updated" | "partial" | "failed" | "offline" | "reviewed-only";
  sources: Array<{ source: PricingSource; status: "updated" | "failed"; models: number; rejectedModels: number }>;
  changes: PriceChange[];
}

export interface PricingRatesView {
  currency: "USD";
  status: PricingStatus;
  models: Array<{ model: string; rate: ModelRate; provenance: RateProvenance }>;
}

export interface PricingDiffView {
  comparisons: Array<{ source: PricingSource; before: string | null; after: string | null }>;
  changes: PriceChange[];
}

export interface PricingStatusView { status: PricingStatus; coverage: PricingCoverage }

export interface PricingOptions {
  dataDir?: string;
  offline?: boolean;
  pricingPolicy?: PricingPolicy;
  pricingSources?: PricingSource[];
  pricingMaxAgeDays?: number;
}

export interface RateCard {
  currency: "USD";
  effectiveDate: string;
  models: Record<string, ModelRate>;
  reviewedOverrides?: string[];
}

export interface TokenUsage {
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  /** Known non-reasoning output when a separate reasoning breakdown is exposed.
   * outputTokens may exceed reasoningOutputTokens + nonReasoningOutputTokens:
   * the nonnegative remainder has no observed reasoning classification.
   * Older snapshots/providers may retain a full partition using legacy estimates. */
  nonReasoningOutputTokens: number;
}

export interface CostBreakdown {
  cachedInputUsd: number;
  cacheWriteUsd: number;
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  upperEstimateUsd: number;
}

export interface ModelUsage extends TokenUsage, CostBreakdown {
  model: string;
  calls: number;
  priced: boolean;
  /** All rate snapshots used for this model; empty for unpriced/provider-reported usage. */
  pricing?: RateProvenance[];
  /** API-priceable token denominator; absent for provider-reported usage. */
  pricingCoverage?: { pricedTokens: number; eligibleTokens: number };
}

export interface SessionMetrics {
  assistantMessages: number;
  compactions: number;
  contextUtilizationPeak: number | null;
  delegatedAgents: number;
  durationMilliseconds: number;
  eventSpanMilliseconds: number;
  maxContextWindow: number;
  maxInputTokensPerCall: number;
  modelCalls: number;
  queueOperations: number;
  summaries: number;
  taskCompletions: number;
  taskStarts: number;
  toolCalls: number;
  transportToolCalls: number;
  userTurns: number;
}

export interface TranscriptHealth {
  /** False when the session start was unavailable; fallback dates are not start evidence. */
  startTimeKnown?: boolean;
  completeness?: "complete" | "partial" | "unknown";
  liveness?: "inactive" | "active" | "unknown";
  files: number;
  snapshotWhileWorking: boolean;
  status: "invalid" | "missing" | "ok" | "unsupported";
  warnings: string[];
  /** Last indexed facts retained after the provider removed their source. Absent on live/full-scan evidence. */
  sourceDeleted?: boolean;
}

export interface SessionAnalytics {
  history?: SessionHistory;
  historyStatistics?: HistoryStatistics;
  historyProfile?: HistoryProfileEvidence;
  /** Present for added evidence sources; absence preserves the legacy provider contract. */
  evidence?: ProviderEvidence;
  conductor?: ConductorResultMetrics;

  agentIdentity?: AgentIdentity;
  velocity?: SessionVelocity;
  mcpEvidence?: McpSessionEvidence;
  /** Key of the machine whose copy of this session was kept, in snapshots that combine machines. */
  machine?: string;
  cost: CostBreakdown;
  costBasis: CostBasis;
  costByExecution: {
    subagentUsd: number;
    topLevelUsd: number;
    unknownUsd: number;
  };
  costComplete: boolean;
  createdAt: string;
  effort: string | null;
  executionKind: ExecutionKind;
  firstEventAt: string | null;
  lastEventAt: string | null;
  metrics: SessionMetrics;
  models: ModelUsage[];
  pricedTokenCoverage: number | null;
  provider: SessionProvider;
  repositoryId: string;
  repositoryName: string;
  sessionKey: string;
  spendByDay: Record<string, number>;
  status: SessionStatus;
  tokens: TokenUsage;
  tools: Record<string, number>;
  transcript: TranscriptHealth;
  transportTools: Record<string, number>;
  updatedAt: string;
}

export interface NamedMetric {
  name: string;
  value: number;
}

export interface RepositoryAnalytics {
  velocity?: VelocityMetadata;
  schemaVersion: 1;
  generatedAt: string;
  rateCard: {
    currency: "USD";
    effectiveDate: string;
    models: Array<{ model: string; source: string; provenance?: RateProvenance; rate?: PublicModelRate }>;
    pricing?: PricingStatus;
  };
  repository: {
    id: string;
    name: string;
  };
  sessions: SessionAnalytics[];
  summary: {
    analyzedSessions: number;
    apiEquivalentSpendUsd: number;
    cacheReadRatio: number | null;
    compactions: number;
    estimatedSpendUsd: number;
    estimatedUpperSpendUsd: number;
    missingTranscripts: number;
    outputTokens: number;
    pricedTokenCoverage: number | null;
    providerReportedSpendUsd: number;
    sessions: number;
    subagentSessions: number;
    subagentSpendUsd: number;
    topLevelSessions: number;
    topLevelSpendUsd: number;
    toolCalls: number;
    totalInputTokens: number;
    unpricedSessions: number;
  };
  spendByDay: NamedMetric[];
  spendByModel: ModelUsage[];
  topTools: NamedMetric[];
  warnings: string[];
}

/** Why a machine was not read, or read with a caveat: a fixed reason, never remote text. */
export type MachineReason = "no-ssh" | "unknown-host" | "connection" | "login-refused" | "dropped" | "sudo" | "no-account" | "login-shell" | "permission"
  | "missing-command" | "no-node" | "node-too-old" | "local-runtime" | "runtime" | "cache-unwritable" | "corrupted" | "version-skew" | "rejected" | "busy"
  | "index-newer" | "analysis" | "invalid" | "time-zone" | "timeout" | "too-large" | "cancelled" | "no-history" | "same-machine";

/**
 * One machine behind a combined snapshot. `stale` carries its last good snapshot after a failed read;
 * `reading` appears only in a dashboard snapshot served before that machine answered.
 */
export interface MachineStatus {
  key: string;
  label: string;
  state: "ok" | "stale" | "failed" | "reading";
  reason?: MachineReason;
  /** The exact next step, built from the saved configuration only. */
  fix?: string;
  /** Sessions and repositories read from this machine, before duplicates across machines are removed. */
  sessions: number;
  repositories: number;
  /** When the snapshot in use was read; null when none is. */
  readAt: string | null;
  durationMs: number | null;
  /** The session-analytics version that produced it, when known. */
  version: string | null;
  /** Hash of the machine ID and account (`host-` when only the host name told it); only a single machine's own report carries it. */
  identity?: string;
  /** Fixed discovery warnings that came from this machine. */
  warnings?: string[];
}

export interface MachineAnalytics {
  /** Present when the snapshot combines machines (and in a machine's own report for another one). */
  machines?: MachineStatus[];
  historyCoverage?: HistoryCoverage;
  velocity?: VelocityMetadata;
  schemaVersion: 1;
  mcpSourceHealth?: McpSourceHealth[];
  mcpContext?: McpContext;
  generatedAt: string;
  rateCard: RepositoryAnalytics["rateCard"];
  repositories: RepositoryRollup[];
  sessions: SessionAnalytics[];
  spendByDay: NamedMetric[];
  spendByModel: ModelUsage[];
  summary: RepositoryAnalytics["summary"] & {
    repositories: number;
    repositoriesWithSessions: number;
    workingSnapshots: number;
  };
  topTools: NamedMetric[];
  warnings: string[];
}

export interface RepositoryRollup {
  repository: RepositoryAnalytics["repository"];
  spendByDay: NamedMetric[];
  spendByModel: ModelUsage[];
  summary: RepositoryAnalytics["summary"];
  topTools: NamedMetric[];
  warnings: string[];
}

export interface SessionDatabaseRow {
  agent_type: string;
  branch: string | null;
  conductor_session_id: string;
  created_at: string;
  database_model: string | null;
  default_branch: string;
  is_hidden: number;
  provider_session_id: string | null;
  repository_id: string;
  repository_name: string;
  repository_remote: string;
  root_path: string;
  status: string;
  title: string;
  updated_at: string;
  workspace_name: string | null;
  workspace_path: string;
}

export interface AnalyzeOptions extends PricingOptions {
  cursorSdkRoot?: string;
  cursorTranscriptRoot?: string;
  copilotRoot?: string;
  opencodeDatabasePath?: string;
  geminiRoot?: string;
  antigravityRoot?: string;
  /** Disable discovery of additional stores; explicit store options still apply. */
  additionalProviders?: boolean;
  /** Internal launch context, never accepted as an MCP tool argument or returned as a path. */
  mcpCwd?: string;
  noIndex?: boolean;
  claudeRoot?: string;
  codexArchiveRoot?: string;
  codexRoot?: string;
  cursorDatabasePath?: string;
  databasePath?: string;
  includeHidden?: boolean;
  /** Give registered repositories with a Git remote the remote-derived ID every machine computes. */
  portableIds?: boolean;
  /** IANA zone for local day/hour activity cells; the analysis worker runs with it as `TZ`. */
  timeZone?: string;
  rateCardPath?: string;
  repositoryId?: string;
  repositoryName?: string;
  repositoryRemote?: string;
  repositoryRoot?: string;
}

/** Live dashboard hint, separate from saved analytics and rates CLI status. */
export interface PricingUpdateAvailability {
  updateAvailable: boolean;
  fetchedAt: string | null;
}

export interface DashboardHealth {
  service: "session-analytics";
  dataSource: "live" | "snapshot";
  snapshot: "ready" | "building" | "not-started";
  status: "ok";
  instanceToken: string;
  /** Every option that changes the snapshot, including the machines read. */
  optionsHash: string;
  /** The same without the machines, so a launch can tell that only the machines differ. */
  scanHash: string;
  /** Tool version: a launch reuses only a dashboard running the same version. */
  version: string;
  /** Present only when this live dashboard can fetch public prices. */
  pricing?: PricingUpdateAvailability;
}

export interface ProviderEvidence {
  /** Partial means retained usage does not prove a complete, disjoint accounting interval. */
  accounting?: "complete" | "partial";
  source: "conductor-result" | "conductor-messages" | "cursor-sdk" | "cursor-transcript" | "copilot-events" | "opencode-db" | "gemini-chat" | "antigravity-db";
  fidelity: "message" | "summary" | "activity-only";
  tokens: "reported" | "unavailable";
  tools: "observed" | "unavailable";
  turns: "observed" | "unavailable";
  timing: "provider" | "file-mtime";
  usageUnit: "request" | "run" | "session" | "unavailable";
}

export type ConductorTerminalReason = "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries" | "completed" | "cancelled" | "interrupted" | "unknown";
export interface ConductorResultMetrics {
  reconciliation?: HistoryReconciliation;
  /** Deduplicated turn-local receipt usage, never added to cumulative model totals. */
  turnLocalTokens?: TokenUsage | null;
  resultRecords: number;
  reportedTurns: number | null;
  durationMilliseconds: number | null;
  apiDurationMilliseconds: number | null;
  permissionDenials: number | null;
  errorResults: number;
  terminalReasons: Partial<Record<ConductorTerminalReason, number>>;
}

/** Aggregate-only interchange format; never a substitute for session evidence. */
export interface SharedCounters {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  pricedTokens: number;
  priceableTokens: number;
  apiEquivalentSpendUsd: number;
  providerReportedSpendUsd: number;
  estimatedUpperSpendUsd: number;
  toolCalls: number;
  compactions: number;
}

export interface SharedRepository extends SharedCounters {
  repository: string;
}

export interface SharedSnapshot {
  schemaVersion: 1;
  kind: "shared";
  minimumSessions: number;
  sources: string[];
  repositories: SharedRepository[];
  summary: SharedCounters;
}
