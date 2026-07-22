export type SessionProvider = "claude" | "codex" | "cursor";
export type CostBasis = "api-list-price-equivalent" | "provider-reported" | "unavailable";
export type ExecutionKind = "mixed" | "subagent" | "top-level" | "unknown";

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
  source: string;
}

export interface RateCard {
  currency: "USD";
  effectiveDate: string;
  models: Record<string, ModelRate>;
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
  files: number;
  snapshotWhileWorking: boolean;
  status: "invalid" | "missing" | "ok" | "unsupported";
  warnings: string[];
}

export interface SessionAnalytics {
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
  status: string;
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
  generatedAt: string;
  rateCard: {
    currency: "USD";
    effectiveDate: string;
    models: Array<{ model: string; source: string }>;
  };
  repository: {
    id: string;
    name: string;
  };
  sessions: SessionAnalytics[];
  summary: {
    analyzedSessions: number;
    apiEquivalentSpendUsd: number;
    cacheReadRatio: number;
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

export interface MachineAnalytics {
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

export interface AnalyzeOptions {
  claudeRoot?: string;
  codexArchiveRoot?: string;
  codexRoot?: string;
  cursorDatabasePath?: string;
  databasePath?: string;
  includeHidden?: boolean;
  rateCardPath?: string;
  repositoryId?: string;
  repositoryName?: string;
  repositoryRemote?: string;
  repositoryRoot?: string;
}
