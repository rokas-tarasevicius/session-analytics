import { InteropError } from "./error.ts";
import type { CostBreakdown, MachineAnalytics, ModelUsage, NamedMetric, SharedSnapshot, TokenUsage } from "../types.ts";
import { readJsonFile } from "./files.ts";
import { matchesSchema, snapshotSchema } from "./schema.ts";
import { validateSharedSnapshot } from "./sharing.ts";
import { filterSnapshot } from "../public/export-data.js";
import { approvedWarning } from "../public/evidence.js";
import { timestampMilliseconds } from "../public/timestamps.js";

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-10 * Math.max(1, a, b);
const tokenKeys = ["inputTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteInputTokens", "cacheWrite5mInputTokens", "cacheWrite1hInputTokens", "outputTokens", "reasoningOutputTokens", "nonReasoningOutputTokens"] as const;
const costKeys = ["inputUsd", "cachedInputUsd", "cacheWriteUsd", "outputUsd", "totalUsd", "upperEstimateUsd"] as const;
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
function tokensReconcile(tokens: TokenUsage): boolean {
  return tokens.inputTokens === tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheWriteInputTokens &&
    tokens.outputTokens === tokens.reasoningOutputTokens + tokens.nonReasoningOutputTokens &&
    tokens.cacheWrite5mInputTokens + tokens.cacheWrite1hInputTokens <= tokens.cacheWriteInputTokens;
}
function costReconciles(cost: CostBreakdown, reported: boolean): boolean {
  return (reported || close(cost.totalUsd, cost.inputUsd + cost.cachedInputUsd + cost.cacheWriteUsd + cost.outputUsd)) &&
    (cost.upperEstimateUsd >= cost.totalUsd || close(cost.upperEstimateUsd, cost.totalUsd));
}
function consistent(actual: object, expected: object): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const got = (actual as Record<string, unknown>)[key];
    if (typeof value !== "number" || typeof got !== "number") return value === got;
    // Counters reconcile exactly; only floating-point currency/ratios tolerate rounding.
    return /(?:Sessions|Tokens|Calls|compactions|sessions|repositories|repositoriesWithSessions|workingSnapshots|calls)$/.test(key) ? value === got : close(value, got);
  });
}
function namedEqual(actual: NamedMetric[], expected: NamedMetric[], integer = false): boolean {
  const byName = new Map(actual.map((row) => [row.name, row.value]));
  return byName.size === actual.length && actual.length === expected.length && expected.every((row) => {
    const value = byName.get(row.name);
    return value !== undefined && (integer ? Number.isSafeInteger(value) && value === row.value : close(value, row.value));
  });
}
function modelsEqual(actual: ModelUsage[], expected: ModelUsage[]): boolean {
  const byName = new Map(actual.map((row) => [row.model, row]));
  return byName.size === actual.length && actual.length === expected.length && expected.every((row) => {
    const value = byName.get(row.model);
    return value !== undefined && consistent(value, row);
  });
}

export function validateSnapshot(value: unknown): MachineAnalytics {
  const fail = (): never => { throw new InteropError("Snapshot is invalid, inconsistent, or unsupported."); };
  if (!matchesSchema(value, snapshotSchema)) fail();
  const snapshot = value as MachineAnalytics;
  const date = (value: string) => Number.isFinite(timestampMilliseconds(value));
  if (!date(snapshot.generatedAt)) fail();
  if (!/^\d{4}-\d\d-\d\d$/.test(snapshot.rateCard.effectiveDate) || !date(`${snapshot.rateCard.effectiveDate}T00:00:00Z`)) fail();
  for (const { source } of snapshot.rateCard.models) {
    try {
      const url = new URL(source);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail();
    } catch { fail(); }
  }
  const repositories = new Map(snapshot.repositories.map(({ repository }) => [repository.id, repository.name]));
  if (repositories.size !== snapshot.repositories.length) fail();
  const sessions = new Set<string>();
  for (const session of snapshot.sessions) {
    const key = `${session.provider}:${session.sessionKey}`;
    if (sessions.has(key) || repositories.get(session.repositoryId) !== session.repositoryName) fail();
    if (![session.createdAt, session.updatedAt, session.firstEventAt, session.lastEventAt].every((value) => value === null || date(value))) fail();
    if (!session.transcript.warnings.every(approvedWarning)) fail();
    if (session.pricedTokenCoverage !== null && session.pricedTokenCoverage > 1) fail();
    if (new Set(session.models.map(({ model }) => model)).size !== session.models.length) fail();
    if (Object.keys(session.spendByDay).some((day) => !/^\d{4}-\d\d-\d\d$/.test(day) || !date(`${day}T00:00:00Z`))) fail();
    const cursor = session.provider === "cursor";
    if (!tokensReconcile(session.tokens) || !costReconciles(session.cost, cursor)) fail();
    for (const model of session.models) {
      if (!tokensReconcile(model) || !costReconciles(model, cursor)) fail();
      if (!model.priced && costKeys.some((key) => model[key] !== 0)) fail();
    }
    for (const key of costKeys) if (!close(session.cost[key], sum(session.models.map((model) => model[key])))) fail();
    if (!close(session.cost.totalUsd, sum(Object.values(session.costByExecution)))) fail();
    if (session.metrics.toolCalls !== sum(Object.values(session.tools)) || session.metrics.transportToolCalls !== sum(Object.values(session.transportTools))) fail();
    if (cursor) {
      // Cursor's bubble tokens cannot be attributed to its model-level reported costs.
      if (session.models.some((model) => tokenKeys.some((key) => model[key] !== 0)) || session.pricedTokenCoverage !== null || Object.keys(session.spendByDay).length) fail();
      if (session.costBasis !== (session.cost.totalUsd > 0 ? "provider-reported" : "unavailable")) fail();
    } else {
      for (const key of tokenKeys) if (session.tokens[key] !== sum(session.models.map((model) => model[key]))) fail();
      if (session.metrics.modelCalls !== sum(session.models.map((model) => model.calls))) fail();
      if (!close(session.cost.totalUsd, sum(Object.values(session.spendByDay)))) fail();
      const denominator = session.tokens.inputTokens + session.tokens.outputTokens;
      const numerator = sum(session.models.filter((model) => model.priced).map((model) => model.inputTokens + model.outputTokens));
      if (!Number.isSafeInteger(denominator) || !Number.isSafeInteger(numerator)) fail();
      if (denominator === 0 ? session.pricedTokenCoverage !== null : session.pricedTokenCoverage === null || !close(session.pricedTokenCoverage, numerator / denominator)) fail();
      if (session.provider === "unsupported") {
        if (session.transcript.status !== "unsupported" || session.costBasis !== "unavailable" || denominator || session.models.length || session.metrics.modelCalls || session.metrics.toolCalls) fail();
      } else if (session.costBasis !== "api-list-price-equivalent") fail();
    }
    if (session.costComplete !== (session.pricedTokenCoverage === null || session.pricedTokenCoverage === 1)) fail();
    sessions.add(key);
  }
  const recomputed = filterSnapshot(snapshot);
  const rollups = [snapshot, ...snapshot.repositories], expected = [recomputed, ...recomputed.repositories];
  for (let index = 0; index < rollups.length; index++) {
    const actual = rollups[index]!, canonical = expected[index]!;
    if (!actual.warnings.every(approvedWarning) || !consistent(actual.summary, canonical.summary) ||
      !namedEqual(actual.spendByDay, canonical.spendByDay) || !namedEqual(actual.topTools, canonical.topTools, true) ||
      !modelsEqual(actual.spendByModel, canonical.spendByModel)) fail();
  }
  return snapshot;
}

export async function loadSnapshot(path: string): Promise<MachineAnalytics | SharedSnapshot> {
  try {
    const value = await readJsonFile(path);
    return value && typeof value === "object" && "kind" in value ? validateSharedSnapshot(value) : validateSnapshot(value);
  } catch { throw new InteropError("Snapshot file is invalid, unsupported, or unavailable."); }
}

export async function loadMachineSnapshot(path: string): Promise<MachineAnalytics> {
  const snapshot = await loadSnapshot(path);
  if ("kind" in snapshot) throw new InteropError("This command requires a full snapshot, not a shared aggregate.");
  return snapshot;
}
