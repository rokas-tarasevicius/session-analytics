import { validHistoryCoverage, validSessionHistory } from "../metrics/history-validation.ts";
import { InteropError } from "./error.ts";
import type { CostBreakdown, MachineAnalytics, ModelUsage, NamedMetric, SharedSnapshot, TokenUsage } from "../types.ts";
import { readJsonFile } from "./files.ts";
import { matchesSchema, snapshotSchema } from "./schema.ts";
import { validateSharedSnapshot } from "./sharing.ts";
import { filterSnapshot } from "../public/export-data.js";
import { approvedWarning } from "../public/evidence.js";
import { validModelId } from "../public/model-id.js";
import { timestampMilliseconds } from "../public/timestamps.js";

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-10 * Math.max(1, a, b);
const tokenKeys = ["inputTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteInputTokens", "cacheWrite5mInputTokens", "cacheWrite1hInputTokens", "outputTokens", "reasoningOutputTokens", "nonReasoningOutputTokens"] as const;
const costKeys = ["inputUsd", "cachedInputUsd", "cacheWriteUsd", "outputUsd", "totalUsd", "upperEstimateUsd"] as const;
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
function tokensReconcile(tokens: TokenUsage): boolean {
  return tokens.inputTokens === tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheWriteInputTokens &&
    // A missing reasoning breakdown leaves an unclassified output remainder.
    // Reject overlapping subclasses, but do not require unknown output to be
    // falsely assigned to non-reasoning just to satisfy a complete partition.
    tokens.outputTokens >= tokens.reasoningOutputTokens + tokens.nonReasoningOutputTokens &&
    tokens.cacheWrite5mInputTokens + tokens.cacheWrite1hInputTokens <= tokens.cacheWriteInputTokens;
}
function costReconciles(cost: CostBreakdown, reported: boolean): boolean {
  return (reported || close(cost.totalUsd, cost.inputUsd + cost.cachedInputUsd + cost.cacheWriteUsd + cost.outputUsd)) &&
    (cost.upperEstimateUsd >= cost.totalUsd || close(cost.upperEstimateUsd, cost.totalUsd));
}
function consistent(actual: unknown, expected: unknown, key = ""): boolean {
  if (typeof actual === "number" && typeof expected === "number") {
    // Integer evidence must remain exact; currency and ratios tolerate floating-point summation.
    return /(?:Sessions|Tokens|Calls|compactions|sessions|repositories|repositoriesWithSessions|workingSnapshots|calls)$/.test(key) ? actual === expected : close(actual, expected);
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => consistent(actual[i], v, key));
  if (expected && typeof expected === "object") return !!actual && typeof actual === "object" && Object.entries(expected).every(([k, v]) => consistent((actual as Record<string, unknown>)[k], v, k));
  return actual === expected;
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

/** Fields that snapshots written before 0.7 could carry. They are dropped on load, never validated or returned. */
const legacyMachineFields = ["limitsCache", "outcomes", "workflow"];
const legacyRepositoryFields = ["outcomes"];
const legacySessionFields = ["reliability", "limitsCache", "outcomes", "workflow", "insightSignals", "skills", "skillEvidence"];
const legacyMcpEvidenceFields = ["toolOutcomes", "rateLimits", "truncated"];
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const without = (value: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  keys.some((key) => Object.hasOwn(value, key)) ? Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) : value;

/** Accept older full snapshots by ignoring removed analysis fields; every remaining field is still validated. */
export function withoutLegacyFields(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const machine = without(value, legacyMachineFields);
  return {
    ...machine,
    ...(Array.isArray(machine["repositories"]) ? { repositories: machine["repositories"].map((repository) => isRecord(repository) ? without(repository, legacyRepositoryFields) : repository) } : {}),
    ...(Array.isArray(machine["sessions"]) ? { sessions: machine["sessions"].map((session) => {
      if (!isRecord(session)) return session;
      const result = without(session, legacySessionFields);
      return isRecord(result["mcpEvidence"]) ? { ...result, mcpEvidence: without(result["mcpEvidence"], legacyMcpEvidenceFields) } : result;
    }) } : {}),
  };
}

export function validateSnapshot(input: unknown): MachineAnalytics {
  const fail = (): never => { throw new InteropError("Snapshot is invalid, inconsistent, or unsupported."); };
  const value = withoutLegacyFields(input);
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
  if (!validHistoryCoverage(snapshot)) fail();
  // Every session and profile names a machine the snapshot lists; a single machine's report names none.
  const machines = new Set(snapshot.machines?.map(({ key }) => key));
  if (snapshot.machines && (machines.size !== snapshot.machines.length || snapshot.machines.some(({ readAt }) => readAt !== null && !date(readAt)))) fail();
  if (snapshot.historyCoverage?.profiles.some(({ machine }) => machine !== undefined && !machines.has(machine))) fail();
  for (const session of snapshot.sessions) {
    if (!validSessionHistory(session)) fail();
    if (session.machine !== undefined && !machines.has(session.machine)) fail();
    const key = `${session.provider}:${session.sessionKey}`;
    if (sessions.has(key) || repositories.get(session.repositoryId) !== session.repositoryName) fail();
    if (![session.createdAt, session.updatedAt, session.firstEventAt, session.lastEventAt].every((value) => value === null || date(value))) fail();
    if (!session.transcript.warnings.every(approvedWarning)) fail();
    if (session.pricedTokenCoverage !== null && session.pricedTokenCoverage > 1) fail();
    if (new Set(session.models.map(({ model }) => model)).size !== session.models.length) fail();
    if (Object.keys(session.spendByDay).some((day) => !/^\d{4}-\d\d-\d\d$/.test(day) || !date(`${day}T00:00:00Z`))) fail();
    const source = session.evidence?.source;
    const cursor = session.provider === "cursor" && !source;
    const receipt = source === "conductor-result";
    const summaryUsage = source === "cursor-sdk";
    const reported = session.costBasis === "provider-reported";
    const activity = session.evidence?.fidelity === "activity-only";
    if (!tokensReconcile(session.tokens) || !costReconciles(session.cost, reported)) fail();
    for (const model of session.models) {
      if (model.model !== "<unknown>" && !validModelId(model.model)) fail();
      if (!tokensReconcile(model) || !costReconciles(model, reported)) fail();
      const coverage = model.pricingCoverage;
      if (coverage && (coverage.eligibleTokens !== model.inputTokens + model.outputTokens || coverage.pricedTokens > coverage.eligibleTokens || model.priced !== (coverage.pricedTokens === coverage.eligibleTokens))) fail();
      if (!model.priced && !coverage && costKeys.some((key) => model[key] !== 0)) fail();
    }
    // Receipt totals are authoritative; model allocations can cover a different retained interval.
    if (!receipt) for (const key of costKeys) if (!close(session.cost[key], sum(session.models.map((model) => model[key])))) fail();
    if (!close(session.cost.totalUsd, sum(Object.values(session.costByExecution)))) fail();
    // Every ledger, including session-dated cells, conserves the session's value.
    const ledger = session.velocity ? [...session.velocity.buckets.map(([, , , values]) => values), ...session.velocity.undated.map(([, values]) => values),
      ...(session.velocity.sessionDated ?? []).map(([, , , values]) => values)] : null;
    if (ledger && (receipt || summaryUsage) && !close(session.cost.totalUsd, sum(ledger.map((values) => values[0])))) fail();
    if (session.metrics.toolCalls !== sum(Object.values(session.tools)) || session.metrics.transportToolCalls !== sum(Object.values(session.transportTools))) fail();
    if (cursor || receipt) {
      if (session.pricedTokenCoverage !== null || Object.keys(session.spendByDay).length) fail();
      if (cursor) {
        if (session.models.some((model) => tokenKeys.some((key) => model[key] !== 0))) fail();
        if (!["provider-reported", "unavailable"].includes(session.costBasis) || session.cost.totalUsd > 0 && session.costBasis !== "provider-reported") fail();
        if (!session.costComplete && session.costBasis !== "unavailable") fail();
      } else {
        if (!["provider-reported", "unavailable"].includes(session.costBasis) || session.evidence?.accounting === "partial" && session.costComplete) fail();
      }
    } else {
      for (const key of tokenKeys) if (session.tokens[key] !== sum(session.models.map((model) => model[key]))) fail();
      if (session.metrics.modelCalls !== sum(session.models.map((model) => model.calls))) fail();
      if (summaryUsage && !session.velocity) {
        if (Object.keys(session.spendByDay).length) fail();
      } else if (session.history) {
        if (!close(session.cost.totalUsd, sum(Object.values(session.spendByDay)) + (session.history.undatedValueUsd ?? 0))) fail();
      } else if (!session.velocity) {
        if (!close(session.cost.totalUsd, sum(Object.values(session.spendByDay)))) fail();
      } else {
        // Daily spend records activity-dated value only; session-dated value is outside it.
        const dated = session.velocity.buckets.map(([, , , values]) => values);
        const undated = [...session.velocity.undated.map(([, values]) => values), ...(session.velocity.sessionDated ?? []).map(([, , , values]) => values)];
        const cells = [...dated, ...undated], datedSpend = sum(Object.values(session.spendByDay));
        if (!close(datedSpend, sum(dated.map(values => values[0]))) ||
            !close(session.cost.totalUsd, datedSpend + sum(undated.map(values => values[0]))) ||
            sum(cells.map(values => values[1])) !== session.tokens.inputTokens ||
            sum(cells.map(values => values[5])) !== session.tokens.outputTokens ||
            sum(cells.map(values => values[7])) !== session.metrics.modelCalls ||
            cells.some(values => values[0] > 0 && values[1] + values[5] === 0)) fail();
      }
      const denominator = session.tokens.inputTokens + session.tokens.outputTokens;
      const numerator = sum(session.models.map((model) => model.pricingCoverage?.pricedTokens ?? (model.priced ? model.inputTokens + model.outputTokens : 0)));
      if (!Number.isSafeInteger(denominator) || !Number.isSafeInteger(numerator)) fail();
      if (denominator === 0 ? session.pricedTokenCoverage !== null : session.pricedTokenCoverage === null || !close(session.pricedTokenCoverage, numerator / denominator)) fail();
      if (session.provider === "unsupported") {
        if (session.transcript.status !== "unsupported" || session.costBasis !== "unavailable" || denominator || session.models.length || session.metrics.modelCalls || session.metrics.toolCalls) fail();
      } else if (activity) {
        if (session.costBasis !== "unavailable" || denominator || session.models.length || session.costComplete) fail();
      } else if (session.costBasis !== "api-list-price-equivalent" && !(source && !session.cost.totalUsd && session.costBasis === "unavailable")) fail();
      const incompleteIterations = session.provider === "claude" && session.transcript.completeness === "partial" && session.transcript.warnings.includes("Iteration billing is incomplete; uncertain attempts were omitted or left unpriced.");
      const complete = !incompleteIterations && (session.evidence ? denominator > 0 && numerator === denominator && session.evidence.accounting !== "partial" : session.pricedTokenCoverage === null || session.pricedTokenCoverage === 1);
      if (session.costComplete !== complete) fail();
    }
    sessions.add(key);
  }
  const recomputed = filterSnapshot(snapshot);
  const rollups = [snapshot, ...snapshot.repositories], expected = [recomputed, ...recomputed.repositories];
  const migrated = new Set<number>();
  for (let index = 0; index < rollups.length; index++) {
    const actual = rollups[index]!, canonical = expected[index]!;
    let summary = actual.summary;
    if (!consistent(summary, canonical.summary)) {
      // v0.6.0 exported these derived fields with older semantics. Accept only
      // their independently reproducible legacy values, then normalize them;
      // session evidence and every other arithmetic check remain unchanged.
      const selected = index === 0 ? snapshot.sessions : snapshot.sessions.filter((session) => session.repositoryId === snapshot.repositories[index - 1]!.repository.id);
      const legacy = { ...canonical.summary,
        unpricedSessions: selected.filter((session) => !session.costComplete).length,
        cacheReadRatio: canonical.summary.cacheReadRatio ?? 0,
        ...(index === 0 ? { workingSnapshots: selected.filter((session) => session.transcript.snapshotWhileWorking).length } : {}),
      };
      const normalized = { ...summary };
      for (const key of ["unpricedSessions", "cacheReadRatio", "workingSnapshots"] as const) {
        const old = legacy as unknown as Record<string, unknown>, current = canonical.summary as unknown as Record<string, unknown>;
        const candidate = normalized as unknown as Record<string, unknown>;
        if (candidate[key] === old[key]) candidate[key] = current[key];
      }
      if (consistent(normalized, canonical.summary)) { summary = canonical.summary; migrated.add(index); }
    }
    if (!actual.warnings.every(approvedWarning) || !consistent(summary, canonical.summary) ||
      !namedEqual(actual.spendByDay, canonical.spendByDay) || !namedEqual(actual.topTools, canonical.topTools, true) ||
      !modelsEqual(actual.spendByModel, canonical.spendByModel)) fail();
  }
  if (!migrated.size) return snapshot;
  const normalizeWarnings = (warnings: string[], unpriced: number) => [...new Set(warnings.flatMap((warning) =>
    /^\d+ sessions? include models without a rate card\.$/.test(warning)
      ? unpriced ? [`${unpriced} sessions have incomplete token pricing.`] : [] : [warning]))];
  return { ...snapshot,
    summary: migrated.has(0) ? recomputed.summary : snapshot.summary,
    warnings: normalizeWarnings(snapshot.warnings, recomputed.summary.unpricedSessions),
    repositories: snapshot.repositories.map((repository, index) => ({ ...repository,
      ...(migrated.has(index + 1) ? { summary: recomputed.repositories[index]!.summary } : {}),
      warnings: normalizeWarnings(repository.warnings, recomputed.repositories[index]!.summary.unpricedSessions),
    })),
  };
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
