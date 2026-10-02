/** Development-only schema generator. Exhaustive mapped types catch field drift in tsc. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CostBasis, CostBreakdown, ExecutionKind, MachineAnalytics, ModelUsage, NamedMetric, RepositoryAnalytics, RepositoryRollup, SessionAnalytics, SessionMetrics, SessionProvider, SharedCounters, SharedRepository, SharedSnapshot, SkillEvidence, TokenUsage, TranscriptHealth } from "../src/types.ts";

type Schema = Record<string, unknown>;
const number = { type: "number", minimum: 0 };
const text = { type: "string" };
const boolean = { type: "boolean" };
const nullable = (schema: Schema) => ({ anyOf: [schema, { type: "null" }] });
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const array = (items: Schema) => ({ type: "array", items });
const record = (values: Schema) => ({ type: "object", additionalProperties: values });
const enumeration = <T extends string>(values: Record<T, true>) => ({ anyOf: Object.keys(values).map((value) => ({ const: value })) });
function object<T>(properties: { [K in keyof T]-?: Schema }): Schema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
const tokenFields: { [K in keyof TokenUsage]: Schema } = {
  inputTokens: number, uncachedInputTokens: number, cachedInputTokens: number, cacheWriteInputTokens: number,
  cacheWrite5mInputTokens: number, cacheWrite1hInputTokens: number, outputTokens: number,
  reasoningOutputTokens: number, nonReasoningOutputTokens: number,
};
const costFields: { [K in keyof CostBreakdown]: Schema } = {
  cachedInputUsd: number, cacheWriteUsd: number, inputUsd: number, outputUsd: number, totalUsd: number, upperEstimateUsd: number,
};
const summaryFields: { [K in keyof RepositoryAnalytics["summary"]]: Schema } = {
  analyzedSessions: number, apiEquivalentSpendUsd: number, cacheReadRatio: number, compactions: number,
  estimatedSpendUsd: number, estimatedUpperSpendUsd: number, missingTranscripts: number, outputTokens: number,
  pricedTokenCoverage: nullable(number), providerReportedSpendUsd: number, sessions: number,
  subagentSessions: number, subagentSpendUsd: number, topLevelSessions: number, topLevelSpendUsd: number,
  toolCalls: number, totalInputTokens: number, unpricedSessions: number,
};
const sharedFields: { [K in keyof SharedCounters]: Schema } = {
  sessions: number, inputTokens: number, outputTokens: number, pricedTokens: number, priceableTokens: number,
  apiEquivalentSpendUsd: number, providerReportedSpendUsd: number, estimatedUpperSpendUsd: number,
  toolCalls: number, compactions: number,
};

export function snapshotSchemas(): Record<string, Schema> {
  const definitions = {
    TokenUsage: object<TokenUsage>(tokenFields), CostBreakdown: object<CostBreakdown>(costFields),
    ModelUsage: object<ModelUsage>({ ...tokenFields, ...costFields, model: text, calls: number, priced: boolean }),
    NamedMetric: object<NamedMetric>({ name: text, value: number }),
    Summary: object<RepositoryAnalytics["summary"]>(summaryFields),
    Repository: object<RepositoryAnalytics["repository"]>({ id: text, name: text }),
    RateCard: object<RepositoryAnalytics["rateCard"]>({ currency: { const: "USD" }, effectiveDate: text, models: array(object<{model: string; source: string}>({ model: text, source: { type: "string", pattern: "^https?://" } })) }),
    SessionMetrics: object<SessionMetrics>({
      assistantMessages: number, compactions: number, contextUtilizationPeak: nullable(number), delegatedAgents: number,
      durationMilliseconds: number, eventSpanMilliseconds: number, maxContextWindow: number, maxInputTokensPerCall: number,
      modelCalls: number, queueOperations: number, summaries: number, taskCompletions: number, taskStarts: number,
      toolCalls: number, transportToolCalls: number, userTurns: number,
    }),
    TranscriptHealth: object<TranscriptHealth>({ files: number, snapshotWhileWorking: boolean, status: enumeration<TranscriptHealth["status"]>({ invalid: true, missing: true, ok: true, unsupported: true }), warnings: array(text) }),
    SessionAnalytics: object<SessionAnalytics>({
      cost: ref("CostBreakdown"), costBasis: enumeration<CostBasis>({ "api-list-price-equivalent": true, "provider-reported": true, unavailable: true }),
      costByExecution: object<SessionAnalytics["costByExecution"]>({ subagentUsd: number, topLevelUsd: number, unknownUsd: number }),
      costComplete: boolean, createdAt: text, effort: nullable(text), executionKind: enumeration<ExecutionKind>({ mixed: true, subagent: true, "top-level": true, unknown: true }),
      firstEventAt: nullable(text), lastEventAt: nullable(text), metrics: ref("SessionMetrics"), models: array(ref("ModelUsage")),
      pricedTokenCoverage: nullable(number), provider: enumeration<SessionProvider>({ claude: true, codex: true, cursor: true }), repositoryId: text,
      repositoryName: text, sessionKey: text, skillEvidence: enumeration<SkillEvidence>({ explicit: true, inferred: true, unavailable: true }),
      skills: record(number), spendByDay: record(number), status: text, tokens: ref("TokenUsage"), tools: record(number),
      transcript: ref("TranscriptHealth"), transportTools: record(number), updatedAt: text,
    }),
    RepositoryRollup: object<RepositoryRollup>({ repository: ref("Repository"), spendByDay: array(ref("NamedMetric")), spendByModel: array(ref("ModelUsage")), summary: ref("Summary"), topTools: array(ref("NamedMetric")), warnings: array(text) }),
    RepositoryAnalytics: object<RepositoryAnalytics>({ schemaVersion: { const: 1 }, generatedAt: text, rateCard: ref("RateCard"), repository: ref("Repository"), sessions: array(ref("SessionAnalytics")), spendByDay: array(ref("NamedMetric")), spendByModel: array(ref("ModelUsage")), summary: ref("Summary"), topTools: array(ref("NamedMetric")), warnings: array(text) }),
    MachineAnalytics: object<MachineAnalytics>({
      schemaVersion: { const: 1 }, generatedAt: text, rateCard: ref("RateCard"), repositories: array(ref("RepositoryRollup")),
      sessions: array(ref("SessionAnalytics")), spendByDay: array(ref("NamedMetric")), spendByModel: array(ref("ModelUsage")),
      summary: object<MachineAnalytics["summary"]>({ ...summaryFields, repositories: number, repositoriesWithSessions: number, workingSnapshots: number }),
      topTools: array(ref("NamedMetric")), warnings: array(text),
    }),
  };
  const sharedDefinitions = {
    SharedCounters: object<SharedCounters>(sharedFields),
    SharedRepository: object<SharedRepository>({ ...sharedFields, repository: { type: "string", pattern: "^(repo-[a-f0-9]{32}|alias-[A-Za-z0-9][A-Za-z0-9._-]{0,63})$" } }),
    SharedSnapshot: object<SharedSnapshot>({ schemaVersion: { const: 1 }, kind: { const: "shared" }, minimumSessions: number, sources: array({ type: "string", pattern: "^source-[a-f0-9]{32}$" }), repositories: array(ref("SharedRepository")), summary: ref("SharedCounters") }),
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
