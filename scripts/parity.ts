#!/usr/bin/env node
/** Read-only source audit. Only allowlisted aggregates and hashed session keys leave this runner. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AnalysisHeapLimitError, analyzeMachineSessionsIsolated } from "../src/analysis-process.ts";
import { matchesSchema, snapshotSchema, type Schema } from "../src/interop/schema.ts";
import { indexStatus } from "../src/store/database.ts";
import type { AnalyzeOptions, SessionAnalytics } from "../src/types.ts";
import { changedEvidence, evidenceGenerations } from "./parity-evidence.ts";
import { indexParityWarning } from "../src/public/evidence.js";

const tokenKeys = ["inputTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteInputTokens",
  "cacheWrite5mInputTokens", "cacheWrite1hInputTokens", "outputTokens", "reasoningOutputTokens", "nonReasoningOutputTokens"] as const;
const costKeys = ["cachedInputUsd", "cacheWriteUsd", "inputUsd", "outputUsd", "totalUsd", "upperEstimateUsd"] as const;
const numeric = <K extends string>(value: Record<K, number>, keys: readonly K[]) => Object.fromEntries(keys.map((key) => [key, value[key] ?? 0]));

export function paritySession(session: SessionAnalytics) {
  return {
    sessionKey: /^[a-f0-9]{12}$/.test(session.sessionKey) ? session.sessionKey : createHash("sha256").update(session.sessionKey).digest("hex").slice(0, 12),
    provider: session.provider,
    month: Number.isFinite(Date.parse(session.createdAt)) ? new Date(session.createdAt).toISOString().slice(0, 7) : "undated",
    transcript: { status: session.transcript.status, files: session.transcript.files },
    executionKind: session.executionKind, costBasis: session.costBasis, costComplete: session.costComplete,
    pricedTokenCoverage: session.pricedTokenCoverage,
    costByExecution: { topLevelUsd: session.costByExecution.topLevelUsd, subagentUsd: session.costByExecution.subagentUsd, unknownUsd: session.costByExecution.unknownUsd },
    tokens: numeric({ ...session.tokens }, tokenKeys), cost: numeric({ ...session.cost }, costKeys),
    models: session.models.map((model) => ({ model: model.model, calls: model.calls, priced: model.priced,
      pricingCoverage: model.pricingCoverage ? { pricedTokens: model.pricingCoverage.pricedTokens, eligibleTokens: model.pricingCoverage.eligibleTokens } : null,
      pricing: (model.pricing ?? []).map((p) => ({ source: p.source, kind: p.kind, snapshotDate: p.snapshotDate,
        payloadSha256: p.payloadSha256, rateModel: p.rateModel, match: p.match, temporal: p.temporal, assumptions: [...p.assumptions].sort() }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      tokens: numeric({ ...model }, tokenKeys), cost: numeric({ ...model }, costKeys) })).sort((a, b) => a.model.localeCompare(b.model)),
  };
}
type ParitySession = ReturnType<typeof paritySession>;

function compareFields(a: unknown, b: unknown, path: string, fields: Set<string>): void {
  // Tolerance is only for USD fields; token counters and multiplicity are exact.
  if (typeof a === "number" && typeof b === "number" && (path.includes("cost.") || path.startsWith("costByExecution.")) && Math.abs(a - b) < 0.01) return;
  if (a === b) return;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      compareFields((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key],
        `${path}${path ? "." : ""}${Array.isArray(a) ? "*" : key}`, fields);
    }
  } else fields.add(path);
}

export function parityDiff(full: ParitySession[], indexed: ParitySession[]) {
  const group = (sessions: ParitySession[]) => {
    const result = new Map<string, ParitySession[]>();
    for (const session of sessions) result.set(session.sessionKey, [...result.get(session.sessionKey) ?? [], session]);
    return result;
  };
  const before = group(full), after = group(indexed);
  const differences: Array<{ sessionKey: string; fields: string[] }> = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(key), b = after.get(key), fields = new Set<string>();
    if (!a || !b) fields.add(a ? "missing" : "extra");
    else if (a.length !== 1 || b.length !== 1) fields.add("duplicate");
    else compareFields(a[0], b[0], "", fields);
    if (fields.size) differences.push({ sessionKey: key, fields: [...fields].sort() });
  }
  return differences;
}

export function monthlyDiff(full: ParitySession[], indexed: ParitySession[]) {
  const group = (sessions: ParitySession[]) => new Map(monthlyTotals(sessions).map((row) => [`${row.month}:${row.provider}`, row]));
  const before = group(full), after = group(indexed);
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((key) => {
    const a = before.get(key), b = after.get(key), fields = new Set<string>();
    if (!a || !b) fields.add(a ? "missing" : "extra"); else compareFields(a, b, "", fields);
    return fields.size ? [{ month: (a ?? b)!.month, provider: (a ?? b)!.provider, fields: [...fields].sort() }] : [];
  });
}

export function monthlyTotals(sessions: ParitySession[]) {
  const totals = new Map<string, { month: string; provider: string; sessions: number; invalid: number; tokens: Record<string, number>; cost: Record<string, number> }>();
  for (const session of [...sessions].sort((a, b) => a.sessionKey.localeCompare(b.sessionKey))) {
    const key = `${session.month}:${session.provider}`;
    const total = totals.get(key) ?? { month: session.month, provider: session.provider, sessions: 0, invalid: 0, tokens: {}, cost: {} };
    total.sessions++;
    if (session.transcript.status === "invalid") total.invalid++;
    for (const field of tokenKeys) total.tokens[field] = (total.tokens[field] ?? 0) + session.tokens[field]!;
    for (const field of costKeys) total.cost[field] = (total.cost[field] ?? 0) + session.cost[field]!;
    totals.set(key, total);
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

/** Diagnostics report schema-owned field names only, never values or dynamic dictionary keys. */
export function schemaFailureFields(value: unknown, schema: Schema, path = "session"): string[] {
  const matches = (item: unknown, rule: Schema) => matchesSchema(item, { ...rule, $defs: snapshotSchema.$defs });
  if (matches(value, schema)) return [];
  if (schema.$ref) return schemaFailureFields(value, snapshotSchema.$defs![schema.$ref.slice(8)]!, path);
  if (schema.anyOf) return [path];
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const fields: string[] = [];
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fields.push(`${path}.${key}`);
    for (const [key, item] of Object.entries(value)) {
      const known = Object.hasOwn(schema.properties ?? {}, key);
      const child = known ? schema.properties![key] : typeof schema.additionalProperties === "object" ? schema.additionalProperties : null;
      if (child) fields.push(...schemaFailureFields(item, child, `${path}.${known ? key : "*"}`));
      else fields.push(`${path}.*`);
      if (schema.propertyNames && !matches(key, schema.propertyNames)) fields.push(`${path}.*`);
    }
    return [...new Set(fields.length ? fields : [path])];
  }
  if (schema.type === "array" && Array.isArray(value)) {
    const fields = value.flatMap((item, i) => schemaFailureFields(item, schema.prefixItems?.[i] ?? schema.items ?? {}, `${path}.*`));
    return [...new Set(fields.length ? fields : [path])];
  }
  return [path];
}

export async function runParity(options: AnalyzeOptions) {
  let baseline: ParitySession[] = [];
  let baselineGenerations: Map<string, string>[] = [];
  let failed = false;
  for (const phase of ["full", "cold", "warm"] as const) {
    process.stderr.write(`Parity: ${phase} scan started.\n`);
    const before = await evidenceGenerations(options);
    const start = performance.now();
    let snapshot;
    try { snapshot = await analyzeMachineSessionsIsolated({ ...options, noIndex: phase === "full" }); }
    catch (error) {
      process.stdout.write(JSON.stringify({ phase, milliseconds: Math.round(performance.now() - start),
        failure: error instanceof AnalysisHeapLimitError ? "worker-heap-limit" : "analysis-unavailable",
        ...(error instanceof AnalysisHeapLimitError ? { stage: error.stage } : {}) }) + "\n");
      throw error;
    }
    const milliseconds = Math.round(performance.now() - start);
    const after = await evidenceGenerations(options);
    const sessions = snapshot.sessions.map(paritySession);
    const invalidSchemaFields: Record<string, number> = {};
    for (const session of snapshot.sessions) for (const field of schemaFailureFields(session, snapshotSchema.$defs!["SessionAnalytics"]!)) {
      invalidSchemaFields[field] = (invalidSchemaFields[field] ?? 0) + 1;
    }
    if (phase === "full") { baseline = sessions; baselineGenerations = [before, after]; }
    const differences = phase === "full" ? [] : parityDiff(baseline, sessions);
    const monthlyDifferences = phase === "full" ? [] : monthlyDiff(baseline, sessions);
    const changed = changedEvidence(...baselineGenerations, before, after);
    const keys = [...new Set([...baseline, ...sessions].map((s) => s.sessionKey))];
    const changedSessions = keys.filter((key) => changed.has(key)).sort();
    // The generation inventory covers native transcripts and their Conductor metadata.
    // Do not certify other provider stores as unchanged merely because they are absent.
    const unverified = new Set(keys.filter((key) => [...baselineGenerations, before, after].some((generation) => !generation.has(key))));
    const unchanged = (rows: ParitySession[]) => rows.filter((s) => !changed.has(s.sessionKey) && !unverified.has(s.sessionKey));
    const unchangedDifferences = phase === "full" ? [] : parityDiff(unchanged(baseline), unchanged(sessions));
    const unchangedMonthlyDifferences = phase === "full" ? [] : monthlyDiff(unchanged(baseline), unchanged(sessions));
    const index = phase === "full" ? null : indexStatus(options).lastScan;
    const fellBack = snapshot.warnings.includes(indexParityWarning);
    failed ||= differences.length > 0 || monthlyDifferences.length > 0 || Object.keys(invalidSchemaFields).length > 0 ||
      phase !== "full" && (!index || fellBack);
    process.stdout.write(JSON.stringify({ phase, milliseconds, sessions: sessions.length,
      index, fellBack,
      invalidSchemaFields, totals: monthlyTotals(sessions), differences, monthlyDifferences,
      changedEvidenceSessions: changedSessions, unchangedSessions: unchanged(sessions).length,
      unverifiedEvidenceSessions: [...unverified].sort(),
      unchangedDifferences, unchangedMonthlyDifferences }) + "\n");
  }
  return !failed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const machine = args.length === 1 && args[0] === "--machine";
  const demoRoot = args.length === 2 && args[0] === "--demo-root" ? resolve(args[1]!) : null;
  if (!machine && !demoRoot) {
    process.stderr.write("Usage: node scripts/parity.ts --machine | --demo-root PATH\n");
    process.exitCode = 2; return;
  }
  const lane = fileURLToPath(new URL("../.lane/", import.meta.url));
  await mkdir(lane, { recursive: true });
  const dataDir = await mkdtemp(join(lane, "parity-data-"));
  process.env["SESSION_ANALYTICS_DATA_DIR"] = dataDir;
  const lock = "/tmp/session-analytics-realscan.lock";
  let locked = false;
  try {
    if (machine) {
      process.stderr.write("Parity: waiting for the shared real-scan lock.\n");
      while (!locked) {
        try { await mkdir(lock); locked = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await setTimeout(5000); }
      }
    }
    const options: AnalyzeOptions = { dataDir, offline: true, includeHidden: true, ...(demoRoot ? {
      claudeRoot: join(demoRoot, "claude/projects"), codexRoot: join(demoRoot, "codex/sessions"),
      codexArchiveRoot: join(demoRoot, "codex/archived_sessions"), cursorDatabasePath: join(demoRoot, "cursor/User/globalStorage/state.vscdb"),
      databasePath: join(demoRoot, "conductor-not-present.db"), additionalProviders: false,
    } : {}) };
    if (!await runParity(options)) process.exitCode = 1;
  } finally {
    if (locked) await rmdir(lock);
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch { process.stderr.write("Parity audit failed; no source or local error details were emitted.\n"); process.exitCode = 2; }
}
