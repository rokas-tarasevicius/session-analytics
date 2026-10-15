import { metricSchemas, model as publicModelSchema } from "./metric-schema.ts";
/** Development-only schema generator. Exhaustive mapped types catch field drift in tsc. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CostBasis, CostBreakdown, ExecutionKind, LongContextRate, MachineAnalytics, MachineReason, MachineStatus, PublicModelRate, ModelUsage, NamedMetric, RepositoryAnalytics, RepositoryRollup, SessionAnalytics, SessionMetrics, SessionProvider, SharedCounters, SharedRepository, SharedSnapshot, TokenUsage, TranscriptHealth } from "../src/types.ts";
import { fixedWarnings, warningPatterns, repositoryKeyPattern, modelPattern, metadataPattern, sessionStatuses } from "../src/public/evidence.js";

type Schema = Record<string, unknown>;
const number = { type: "number", minimum: 0 };
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const text = { type: "string" };
const model = publicModelSchema;
const metadata = { type: "string", pattern: metadataPattern };
const repositoryKey = { type: "string", pattern: repositoryKeyPattern };
const warning = { anyOf: [...fixedWarnings.map((value) => ({ const: value })), ...warningPatterns.map((pattern) => ({ type: "string", pattern }))] };
const boolean = { type: "boolean" };
const nullable = (schema: Schema) => ({ anyOf: [schema, { type: "null" }] });
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const array = (items: Schema) => ({ type: "array", items });
const record = (values: Schema) => ({ type: "object", additionalProperties: values });
const enumeration = <T extends string>(values: Record<T, true>) => ({ anyOf: Object.keys(values).map((value) => ({ const: value })) });
const machineKey = { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" };
const machineReasons: Record<MachineReason, true> = {
  "no-ssh": true, "unknown-host": true, connection: true, "login-refused": true, dropped: true, sudo: true, "no-account": true, "login-shell": true, permission: true,
  "missing-command": true, "no-node": true, "node-too-old": true, "local-runtime": true, runtime: true, "cache-unwritable": true, corrupted: true, "version-skew": true,
  rejected: true, busy: true, "index-newer": true, analysis: true, invalid: true, "time-zone": true, timeout: true, "too-large": true, cancelled: true, "no-history": true,
  "same-machine": true,
};
function object<T>(properties: { [K in keyof T]-?: Schema }, optional: Array<keyof T> = []): Schema {
  return { type: "object", properties, required: Object.keys(properties).filter((key) => !optional.includes(key as keyof T)), additionalProperties: false };
}
const tokenFields: { [K in keyof TokenUsage]: Schema } = {
  inputTokens: integer, uncachedInputTokens: integer, cachedInputTokens: integer, cacheWriteInputTokens: integer,
  cacheWrite5mInputTokens: integer, cacheWrite1hInputTokens: integer, outputTokens: integer,
  reasoningOutputTokens: integer, nonReasoningOutputTokens: integer,
};
const costFields: { [K in keyof CostBreakdown]: Schema } = {
  cachedInputUsd: number, cacheWriteUsd: number, inputUsd: number, outputUsd: number, totalUsd: number, upperEstimateUsd: number,
};
const summaryFields: { [K in keyof RepositoryAnalytics["summary"]]: Schema } = {
  analyzedSessions: integer, apiEquivalentSpendUsd: number, cacheReadRatio: nullable(number), compactions: integer,
  estimatedSpendUsd: number, estimatedUpperSpendUsd: number, missingTranscripts: integer, outputTokens: integer,
  pricedTokenCoverage: nullable(number), providerReportedSpendUsd: number, sessions: integer,
  subagentSessions: integer, subagentSpendUsd: number, topLevelSessions: integer, topLevelSpendUsd: number,
  toolCalls: integer, totalInputTokens: integer, unpricedSessions: integer,
};
const sharedFields: { [K in keyof SharedCounters]: Schema } = {
  sessions: integer, inputTokens: integer, outputTokens: integer, pricedTokens: number, priceableTokens: integer,
  apiEquivalentSpendUsd: number, providerReportedSpendUsd: number, estimatedUpperSpendUsd: number,
  toolCalls: integer, compactions: integer,
};

export function snapshotSchemas(): Record<string, Schema> {
  const definitions = {
    ...metricSchemas(),
    TokenUsage: object<TokenUsage>(tokenFields), CostBreakdown: object<CostBreakdown>(costFields),
    ModelUsage: object<ModelUsage>({ ...tokenFields, ...costFields, model, calls: integer, priced: boolean, pricing: array(ref("RateProvenance")), pricingCoverage: object({ pricedTokens: integer, eligibleTokens: integer }) }, ["pricing", "pricingCoverage"]),
    NamedMetric: object<NamedMetric>({ name: text, value: number }),
    Summary: object<RepositoryAnalytics["summary"]>(summaryFields),
    Repository: object<RepositoryAnalytics["repository"]>({ id: repositoryKey, name: { type: "string", minLength: 1, maxLength: 256, pattern: "^[^/\\\\\\u0000-\\u001f\\u007f]+$" } }),
    PublicModelRate: object<PublicModelRate>({
      provider: enumeration<SessionProvider>({ claude: true, codex: true, cursor: true, copilot: true, opencode: true, gemini: true, unsupported: true }),
      inputPerMillion: number, cachedInputPerMillion: number, cacheReadPerMillion: number, cacheWrite5mPerMillion: number,
      cacheWrite1hPerMillion: number, cacheWriteMultiplier: number, cacheWriteObservable: boolean, outputPerMillion: number,
      longContext: object<LongContextRate>({ inputMultiplier: number, outputMultiplier: number, thresholdInputTokens: integer }),
      contextTiers: array(object<NonNullable<PublicModelRate["contextTiers"]>[number]>({ aboveInputTokens: integer, inputPerMillion: number,
        outputPerMillion: number, cacheReadPerMillion: number, cacheWrite5mPerMillion: number, cacheWrite1hPerMillion: number },
        ["cacheReadPerMillion", "cacheWrite5mPerMillion", "cacheWrite1hPerMillion"])),
    }, ["cachedInputPerMillion", "cacheReadPerMillion", "cacheWrite5mPerMillion", "cacheWrite1hPerMillion", "cacheWriteMultiplier", "cacheWriteObservable", "longContext", "contextTiers"]),
    RateCard: object<RepositoryAnalytics["rateCard"]>({ currency: { const: "USD" }, effectiveDate: text, pricing: ref("PricingStatus"), models: array(object<{model: string; source: string; provenance?: unknown; rate?: unknown}>({ model, source: { type: "string", pattern: "^https?://" }, provenance: ref("RateProvenance"), rate: ref("PublicModelRate") }, ["provenance", "rate"])) }, ["pricing"]),
    SessionMetrics: object<SessionMetrics>({
      assistantMessages: integer, compactions: integer, contextUtilizationPeak: nullable(number), delegatedAgents: integer,
      durationMilliseconds: number, eventSpanMilliseconds: number, maxContextWindow: integer, maxInputTokensPerCall: integer,
      modelCalls: integer, queueOperations: integer, summaries: integer, taskCompletions: integer, taskStarts: integer,
      toolCalls: integer, transportToolCalls: integer, userTurns: integer,
    }),
    TranscriptHealth: object<TranscriptHealth>({ sourceDeleted: boolean, startTimeKnown: boolean, completeness: { anyOf: ["complete", "partial", "unknown"].map((value) => ({ const: value })) }, liveness: { anyOf: ["inactive", "active", "unknown"].map((value) => ({ const: value })) }, files: integer, snapshotWhileWorking: boolean, status: enumeration<TranscriptHealth["status"]>({ invalid: true, missing: true, ok: true, unsupported: true }), warnings: array(warning) }, ["sourceDeleted", "startTimeKnown", "completeness", "liveness"]),
    SessionAnalytics: object<SessionAnalytics>({
      history: ref("SessionHistory"), historyStatistics: ref("HistoryStatistics"), historyProfile: ref("HistoryProfileEvidence"), mcpEvidence: ref("McpSessionEvidence"),
      evidence: ref("ProviderEvidence"), conductor: ref("ConductorResultMetrics"), agentIdentity: ref("AgentIdentity"), velocity: ref("SessionVelocity"),
      cost: ref("CostBreakdown"), costBasis: enumeration<CostBasis>({ "api-list-price-equivalent": true, "provider-reported": true, unavailable: true }),
      costByExecution: object<SessionAnalytics["costByExecution"]>({ subagentUsd: number, topLevelUsd: number, unknownUsd: number }),
      costComplete: boolean, createdAt: text, effort: nullable(metadata), executionKind: enumeration<ExecutionKind>({ mixed: true, subagent: true, "top-level": true, unknown: true }),
      firstEventAt: nullable(text), lastEventAt: nullable(text), metrics: ref("SessionMetrics"), models: array(ref("ModelUsage")),
      pricedTokenCoverage: nullable(number), provider: enumeration<SessionProvider>({ claude: true, codex: true, cursor: true, copilot: true, opencode: true, gemini: true, unsupported: true }), repositoryId: repositoryKey,
      repositoryName: text, sessionKey: { type: "string", pattern: "^[a-f0-9]{12}$" },
      spendByDay: record(number), status: { anyOf: sessionStatuses.map((value) => ({ const: value })) }, tokens: ref("TokenUsage"), tools: { ...record(integer), propertyNames: metadata },
      transcript: ref("TranscriptHealth"), transportTools: { ...record(integer), propertyNames: metadata }, updatedAt: text, machine: machineKey,
    }, ["history", "historyStatistics", "historyProfile", "mcpEvidence", "evidence", "conductor", "agentIdentity", "velocity", "machine"]),
    MachineStatus: object<MachineStatus>({
      key: machineKey, label: { type: "string", minLength: 1, maxLength: 256 },
      state: enumeration<MachineStatus["state"]>({ ok: true, stale: true, failed: true, reading: true }), reason: enumeration(machineReasons),
      fix: { type: "string", minLength: 1, maxLength: 1024 }, sessions: integer, repositories: integer, readAt: nullable(text), durationMs: nullable(number),
      version: nullable({ type: "string", pattern: "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$" }), identity: { type: "string", pattern: "^(?:host-)?[0-9a-f]{16}$" }, warnings: array(warning),
    }, ["reason", "fix", "identity", "warnings"]),
    RepositoryRollup: object<RepositoryRollup>({ repository: ref("Repository"), spendByDay: array(ref("NamedMetric")), spendByModel: array(ref("ModelUsage")), summary: ref("Summary"), topTools: array(ref("NamedMetric")), warnings: array(warning) }),
    RepositoryAnalytics: object<RepositoryAnalytics>({ velocity: ref("VelocityMetadata"), schemaVersion: { const: 1 }, generatedAt: text, rateCard: ref("RateCard"), repository: ref("Repository"), sessions: array(ref("SessionAnalytics")), spendByDay: array(ref("NamedMetric")), spendByModel: array(ref("ModelUsage")), summary: ref("Summary"), topTools: array(ref("NamedMetric")), warnings: array(warning) }, ["velocity"]),
    MachineAnalytics: object<MachineAnalytics>({
      machines: { ...array(ref("MachineStatus")), maxItems: 256 },
      historyCoverage: ref("HistoryCoverage"),
      mcpSourceHealth: array(ref("McpSourceHealth")), mcpContext: ref("McpContext"),
      velocity: ref("VelocityMetadata"),
      schemaVersion: { const: 1 }, generatedAt: text, rateCard: ref("RateCard"), repositories: array(ref("RepositoryRollup")),
      sessions: array(ref("SessionAnalytics")), spendByDay: array(ref("NamedMetric")), spendByModel: array(ref("ModelUsage")),
      summary: object<MachineAnalytics["summary"]>({ ...summaryFields, repositories: integer, repositoriesWithSessions: integer, workingSnapshots: integer }),
      topTools: array(ref("NamedMetric")), warnings: array(warning),
    }, ["machines", "historyCoverage", "velocity", "mcpSourceHealth", "mcpContext"]),
  };
  const sharedDefinitions = {
    SharedCounters: object<SharedCounters>(sharedFields),
    SharedRepository: object<SharedRepository>({ ...sharedFields, repository: { type: "string", pattern: "^(repo-[a-f0-9]{32}|alias-[A-Za-z0-9][A-Za-z0-9._-]{0,63})$" } }),
    SharedSnapshot: object<SharedSnapshot>({ schemaVersion: { const: 1 }, kind: { const: "shared" }, minimumSessions: integer, sources: array({ type: "string", pattern: "^source-[a-f0-9]{32}$" }), repositories: array(ref("SharedRepository")), summary: ref("SharedCounters") }),
  };
  const schema = (name: string, root: string, defs: unknown) => ({
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: `urn:session-analytics:${name}:1`, title: root,
    description: "Generated by scripts/snapshot-schema.ts; field maps are checked against src/types.ts. Unknown fields are rejected.",
    ...ref(root), $defs: defs,
  });
  return { "snapshot.v1.schema.json": schema("snapshot", "MachineAnalytics", definitions), "shared.v1.schema.json": schema("shared", "SharedSnapshot", sharedDefinitions) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(new URL("../schemas/", import.meta.url), { recursive: true });
  for (const [name, schema] of Object.entries(snapshotSchemas())) {
    const path = new URL(`../schemas/${name}`, import.meta.url);
    const serialized = `${JSON.stringify(schema, null, 2)}\n`;
    if (process.argv.includes("--check")) {
      if (await readFile(path, "utf8") !== serialized) throw new Error("Snapshot schemas need regeneration.");
    } else await writeFile(path, serialized);
  }
}
