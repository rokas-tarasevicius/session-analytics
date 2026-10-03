import { InteropError } from "./error.ts";
import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { serviceId } from "../brand.ts";
import type { MachineAnalytics, SharedCounters, SharedRepository, SharedSnapshot } from "../types.ts";
import { readJsonFile } from "./files.ts";
import { matchesSchema, sharedSchema } from "./schema.ts";

const keys = ["sessions", "inputTokens", "outputTokens", "pricedTokens", "priceableTokens", "apiEquivalentSpendUsd", "providerReportedSpendUsd", "estimatedUpperSpendUsd", "toolCalls", "compactions"] as const satisfies ReadonlyArray<keyof SharedCounters>;
const zero = (): SharedCounters => ({ sessions: 0, inputTokens: 0, outputTokens: 0, pricedTokens: 0, priceableTokens: 0, apiEquivalentSpendUsd: 0, providerReportedSpendUsd: 0, estimatedUpperSpendUsd: 0, toolCalls: 0, compactions: 0 });
const countKeys = ["sessions", "inputTokens", "outputTokens", "priceableTokens", "toolCalls", "compactions"] as const;
const add = (target: SharedCounters, source: SharedCounters): void => { for (const key of keys) target[key] += source[key]; };
const digest = (secret: Buffer, domain: string, value = ""): string => createHmac("sha256", secret).update(`${domain}\0${value}`).digest("hex").slice(0, 32);
const fail = (): never => { throw new InteropError("Shared snapshot is invalid, inconsistent, or unsupported."); };

export function defaultShareKeyPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment["XDG_STATE_HOME"] || join(homedir(), ".local", "state"), serviceId, "sharing.key");
}

export async function loadShareKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(randomBytes(32)); await file.sync(); } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size !== 32 || (stats.mode & 0o077) !== 0) throw new InteropError("Sharing key must be a private 32-byte file.");
    return await file.readFile();
  } finally { await file.close(); }
}

export async function readAliases(path: string): Promise<Record<string, string>> {
  const value = await readJsonFile(path, 1024 * 1024);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((alias) => typeof alias !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias))) {
    throw new InteropError("Aliases must map repository IDs to short letters, digits, dots, underscores, or hyphens.");
  }
  return value as Record<string, string>;
}

/** Disjoint repository buckets only: no total or marginal can reconstruct a suppressed row. */
export function shareSnapshot(snapshot: MachineAnalytics, secret: Buffer, minimumSessions = 5, aliases: Record<string, string> = {}): SharedSnapshot {
  if (secret.length !== 32 || !Number.isSafeInteger(minimumSessions) || minimumSessions < 2) throw new InteropError("Sharing requires a 32-byte key and a minimum session count of at least 2.");
  const repositoryIds = new Set(snapshot.repositories.map(({ repository }) => repository.id));
  if (Object.keys(aliases).some((id) => !repositoryIds.has(id))) throw new InteropError("An alias does not match a repository in this snapshot.");
  const seen = new Set<string>();
  const rows = new Map<string, SharedRepository>();
  for (const session of snapshot.sessions) {
    const identity = `${session.provider}:${session.sessionKey}`;
    if (seen.has(identity)) throw new InteropError("Duplicate session evidence cannot be shared.");
    seen.add(identity);
    if (session.transcript.status !== "ok") continue;
    const alias = Object.hasOwn(aliases, session.repositoryId) ? aliases[session.repositoryId] : undefined;
    if (alias !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)) throw new InteropError("Repository alias is invalid.");
    const repository = alias === undefined ? `repo-${digest(secret, "repository-v1", session.repositoryId)}` : `alias-${alias}`;
    const row = rows.get(repository) ?? { repository, ...zero() };
    const tokens = session.tokens.inputTokens + session.tokens.outputTokens;
    add(row, {
      sessions: 1, inputTokens: session.tokens.inputTokens, outputTokens: session.tokens.outputTokens,
      priceableTokens: session.pricedTokenCoverage === null ? 0 : tokens,
      pricedTokens: tokens * (session.pricedTokenCoverage ?? 0),
      apiEquivalentSpendUsd: session.costBasis === "api-list-price-equivalent" ? session.cost.totalUsd : 0,
      providerReportedSpendUsd: session.costBasis === "provider-reported" ? session.cost.totalUsd : 0,
      estimatedUpperSpendUsd: session.cost.upperEstimateUsd,
      toolCalls: session.metrics.toolCalls, compactions: session.metrics.compactions,
    });
    rows.set(repository, row);
  }
  const repositories = [...rows.values()].filter((row) => row.sessions >= minimumSessions).sort((a, b) => a.repository.localeCompare(b.repository));
  const summary = zero();
  for (const row of repositories) add(summary, row);
  const result: SharedSnapshot = { schemaVersion: 1, kind: "shared", minimumSessions, sources: repositories.length ? [`source-${digest(secret, "source-v1")}`] : [], repositories, summary };
  return validateSharedSnapshot(result);
}

export function validateSharedSnapshot(value: unknown): SharedSnapshot {
  if (!matchesSchema(value, sharedSchema)) fail();
  const snapshot = value as SharedSnapshot;
  if (!Number.isSafeInteger(snapshot.minimumSessions) || snapshot.minimumSessions < 2 || new Set(snapshot.sources).size !== snapshot.sources.length) fail();
  if ((snapshot.repositories.length > 0) !== (snapshot.sources.length > 0)) fail();
  const names = new Set<string>();
  const summary = zero();
  for (const row of snapshot.repositories) {
    if (names.has(row.repository) || row.sessions < snapshot.minimumSessions) fail();
    for (const key of countKeys) if (!Number.isSafeInteger(row[key])) fail();
    if (row.pricedTokens > row.priceableTokens + 1e-6 || row.priceableTokens > row.inputTokens + row.outputTokens + 1e-6) fail();
    names.add(row.repository); add(summary, row);
  }
  for (const key of countKeys) if (!Number.isSafeInteger(snapshot.summary[key]) || snapshot.summary[key] !== summary[key]) fail();
  for (const key of keys) if (!Number.isFinite(summary[key]) || summary[key] > Number.MAX_SAFE_INTEGER || Math.abs(snapshot.summary[key] - summary[key]) > 1e-8 * Math.max(1, summary[key])) fail();
  return snapshot;
}

export function mergeSharedSnapshots(values: unknown[]): SharedSnapshot {
  if (!values.length) throw new InteropError("Merge requires at least one shared snapshot.");
  const snapshots = values.map(validateSharedSnapshot);
  const minimumSessions = snapshots[0]!.minimumSessions;
  const sources = new Set<string>();
  const rows = new Map<string, SharedRepository>();
  for (const snapshot of snapshots) {
    if (snapshot.minimumSessions !== minimumSessions) throw new InteropError("Shared snapshots must use the same minimum session count.");
    for (const source of snapshot.sources) {
      if (sources.has(source)) throw new InteropError("Repeated sharing source: overlapping evidence cannot be merged safely.");
      sources.add(source);
    }
    for (const source of snapshot.repositories) {
      const row = rows.get(source.repository) ?? { repository: source.repository, ...zero() };
      add(row, source); rows.set(source.repository, row);
    }
  }
  const repositories = [...rows.values()].sort((a, b) => a.repository.localeCompare(b.repository));
  const summary = zero();
  for (const row of repositories) add(summary, row);
  return validateSharedSnapshot({ schemaVersion: 1, kind: "shared", minimumSessions, sources: [...sources].sort(), repositories, summary });
}
