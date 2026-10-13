import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { INDEX_UNAVAILABLE, secureDirectory, secureFile } from "../store/database.ts";
import {
  claudePlans, codexPlans,
  type ClaudeAccountSummary, type ClaudePlan, type CodexAccountSummary, type CodexPlan, type ResetCredit, type LimitObservation, type LimitProvider, type LimitSource, type LimitStatus,
} from "./types.ts";

/** Private, content-free meter history. Provider logs rotate quickly; this ledger is what makes reset history possible. */
export const ledgerName = "limits.json";
export const inboxName = "limits-inbox.jsonl";
const maximumLedgerBytes = 16 * 1024 * 1024;
const maximumInboxBytes = 4 * 1024 * 1024;

export const retentionSeconds = 120 * 86_400;
/** Recent cycles keep 15-minute resolution; cycles that reset more than 14 days ago keep 3-hour resolution. */
const recentBucketSeconds = 900;
const archiveBucketSeconds = 3 * 3600;
const archiveAfterSeconds = 14 * 86_400;

/** [provider, meter, windowMinutes, resetsAt, observedAt, usedPercent, status, source] */
export type LedgerRow = [LimitProvider, string, number | null, number, number, number, LimitStatus, LimitSource];

export interface Ledger {
  version: 1;
  /** Provider files modified before this Unix time were already harvested. */
  harvestedThrough: number | null;
  plans: { claude: ClaudePlan | null; codex: CodexPlan | null };
  rows: LedgerRow[];
  accounts?: { codex: CodexAccountSummary | null; claude: ClaudeAccountSummary | null };
  /** [provider, observedAt, available], appended only when the count changes. */
  resetCreditHistory?: Array<["codex" | "claude", number, number]>;
  /** Last opt-in Codex account read, Unix seconds; reads are throttled. */
  codexAccountReadAt?: number | null;
}

export const emptyLedger = (): Ledger => ({
  version: 1, harvestedThrough: null, plans: { claude: null, codex: null }, rows: [],
  accounts: { codex: null, claude: null }, resetCreditHistory: [], codexAccountReadAt: null,
});

const time = (value: unknown): number | null => finite(value) && value >= 1_500_000_000 && value <= 4_000_000_000 ? Math.floor(value) : null;

function resetCredit(value: unknown): ResetCredit | null {
  const credit = value as Partial<ResetCredit> | null;
  if (!credit || typeof credit !== "object") return null;
  return {
    status: credit.status === "available" || credit.status === "redeeming" || credit.status === "redeemed" ? credit.status : "unknown",
    scope: credit.scope === "all" || credit.scope === "five_hour" || credit.scope === "seven_day" ? credit.scope : "unknown",
    grantedAt: time(credit.grantedAt), expiresAt: time(credit.expiresAt),
  };
}

/** Account summaries cross the API and the ledger only through these allowlists. */
export function codexSummary(value: unknown): CodexAccountSummary | null {
  const summary = value as Partial<CodexAccountSummary> | null;
  const observedAt = time(summary?.observedAt);
  if (!summary || observedAt === null) return null;
  const credits = summary.credits && typeof summary.credits === "object"
    ? { hasCredits: summary.credits.hasCredits === true, unlimited: summary.credits.unlimited === true, balance: finite(summary.credits.balance) && summary.credits.balance >= 0 ? summary.credits.balance : null } : null;
  const resets = summary.resetCredits && typeof summary.resetCredits === "object" && finite(summary.resetCredits.available) ? {
    available: Math.max(0, Math.min(1000, Math.floor(summary.resetCredits.available))),
    credits: Array.isArray(summary.resetCredits.credits) ? summary.resetCredits.credits.slice(0, 50).map(resetCredit).filter((credit): credit is ResetCredit => credit !== null) : null,
  } : null;
  return { observedAt, credits, ordinaryUsageAllowed: typeof summary.ordinaryUsageAllowed === "boolean" ? summary.ordinaryUsageAllowed : null, resetCredits: resets };
}

export function claudeSummary(value: unknown): ClaudeAccountSummary | null {
  const summary = value as Partial<ClaudeAccountSummary> | null;
  const observedAt = time(summary?.observedAt);
  if (!summary || observedAt === null) return null;
  const extraUsage = summary.extraUsage === "enabled" || summary.extraUsage === "in-use" || summary.extraUsage === "disabled" ? summary.extraUsage : "unknown";
  const reason = typeof summary.disabledReason === "string" && /^[a-z][a-z0-9_]{0,48}$/.test(summary.disabledReason) ? summary.disabledReason : null;
  return { observedAt, extraUsage, disabledReason: reason };
}

export function resetCreditHistory(value: unknown): Array<["codex" | "claude", number, number]> {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is ["codex" | "claude", number, number] => Array.isArray(row) && (row[0] === "codex" || row[0] === "claude") && time(row[1]) !== null && finite(row[2]) && row[2] >= 0 && row[2] <= 1000)
    .map((row): ["codex" | "claude", number, number] => [row[0], Math.floor(row[1]), Math.floor(row[2])]).slice(-500);
}

const providers = new Set<string>(["claude", "codex"]);
const sources = new Set<string>(["codex-session", "codex-account", "claude-sdk-log", "claude-statusline"]);
const statuses = new Set<string>(["allowed", "warning", "rejected", "unknown"]);
const meterPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const statusRank: Record<LimitStatus, number> = { unknown: 0, allowed: 1, warning: 2, rejected: 3 };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The only gate into the ledger and the API: every field is re-validated, so a malformed source cannot widen the contract. */
export function validObservation(value: LimitObservation): LimitObservation | null {
  if (!providers.has(value.provider) || !sources.has(value.source) || !statuses.has(value.status)) return null;
  if (typeof value.meter !== "string" || !meterPattern.test(value.meter)) return null;
  if (!finite(value.resetsAt) || !finite(value.observedAt) || !finite(value.usedPercent)) return null;
  if (value.resetsAt < 1_500_000_000 || value.resetsAt > 4_000_000_000 || value.observedAt < 1_500_000_000 || value.observedAt > 4_000_000_000) return null;
  if (value.windowMinutes !== null && (!Number.isInteger(value.windowMinutes) || value.windowMinutes <= 0 || value.windowMinutes > 60 * 24 * 62)) return null;
  return {
    provider: value.provider, meter: value.meter, windowMinutes: value.windowMinutes,
    // Reset instants can drift by a second between records of one window; minute precision keeps one cycle per window.
    resetsAt: Math.round(value.resetsAt / 60) * 60,
    observedAt: Math.floor(value.observedAt),
    usedPercent: Math.round(Math.min(1000, Math.max(0, value.usedPercent)) * 10) / 10,
    status: value.status, source: value.source,
  };
}

export const toRow = (value: LimitObservation): LedgerRow =>
  [value.provider, value.meter, value.windowMinutes, value.resetsAt, value.observedAt, value.usedPercent, value.status, value.source];

export const fromRow = (row: LedgerRow): LimitObservation | null => Array.isArray(row) && row.length === 8
  ? validObservation({ provider: row[0], meter: row[1], windowMinutes: row[2], resetsAt: row[3], observedAt: row[4], usedPercent: row[5], status: row[6], source: row[7] })
  : null;

/**
 * Merge observations into one row per meter, reset cycle and time bucket. Each bucket keeps its highest reading
 * (earliest on ties, so the first moment a cap was reached survives) and its most severe status.
 */
export function compactObservations(observations: Iterable<LimitObservation>, now: number): LimitObservation[] {
  const buckets = new Map<string, LimitObservation>();
  for (const candidate of observations) {
    const observation = validObservation(candidate);
    if (!observation || observation.observedAt < now - retentionSeconds) continue;
    const size = observation.resetsAt < now - archiveAfterSeconds ? archiveBucketSeconds : recentBucketSeconds;
    const key = `${observation.provider}|${observation.meter}|${observation.resetsAt}|${Math.floor(observation.observedAt / size)}`;
    const current = buckets.get(key);
    if (!current) { buckets.set(key, observation); continue; }
    const higher = observation.usedPercent > current.usedPercent ||
      (observation.usedPercent === current.usedPercent && observation.observedAt < current.observedAt);
    const kept = higher ? { ...observation } : current;
    if (statusRank[current.status] > statusRank[kept.status]) kept.status = current.status;
    if (statusRank[observation.status] > statusRank[kept.status]) kept.status = observation.status;
    buckets.set(key, kept);
  }
  return [...buckets.values()].sort((left, right) =>
    left.provider.localeCompare(right.provider) || left.meter.localeCompare(right.meter) ||
    left.resetsAt - right.resetsAt || left.observedAt - right.observedAt);
}

export const ledgerPath = (directory: string): string => join(directory, ledgerName);
export const inboxPath = (directory: string): string => join(directory, inboxName);

function readPrivate(path: string, limit: number): string | null {
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new Error(INDEX_UNAVAILABLE);
    if (info.size > limit) return null;
    return readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
}

function plan<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : null;
}

export function readLedger(directory: string): Ledger {
  const text = readPrivate(ledgerPath(directory), maximumLedgerBytes);
  if (!text) return emptyLedger();
  try {
    const value = JSON.parse(text) as Partial<Ledger>;
    if (value.version !== 1 || !Array.isArray(value.rows)) return emptyLedger();
    return {
      version: 1,
      harvestedThrough: finite(value.harvestedThrough) ? value.harvestedThrough : null,
      plans: { claude: plan(value.plans?.claude, claudePlans), codex: plan(value.plans?.codex, codexPlans) },
      rows: value.rows.map(fromRow).filter((row): row is LimitObservation => row !== null).map(toRow),
      accounts: { codex: codexSummary(value.accounts?.codex), claude: claudeSummary(value.accounts?.claude) },
      resetCreditHistory: resetCreditHistory(value.resetCreditHistory),
      codexAccountReadAt: time(value.codexAccountReadAt),
    };
  } catch { return emptyLedger(); }
}

/** Atomic replacement; the directory and file keep the index's private permissions. */
export function writeLedger(directory: string, ledger: Ledger): void {
  secureDirectory(directory);
  const path = ledgerPath(directory);
  secureFile(path);
  const temporary = `${path}.${randomBytes(16).toString("hex")}.next`;
  writeFileSync(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

/** Statusline samples arrive many times a minute; they are appended here and folded into the ledger on the next harvest. */
export function appendInbox(directory: string, observations: LimitObservation[]): void {
  const rows = observations.map(validObservation).filter((row): row is LimitObservation => row !== null).map(toRow);
  if (!rows.length) return;
  secureDirectory(directory);
  const path = inboxPath(directory);
  secureFile(path, true);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    if (fstatSync(descriptor).size > maximumInboxBytes) return;
    writeFileSync(descriptor, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  } finally { closeSync(descriptor); }
}

/** Claims the inbox by renaming it first, so samples appended during the merge land in a fresh inbox. */
export function drainInbox(directory: string): LimitObservation[] {
  const path = inboxPath(directory);
  const claimed = `${path}.${randomBytes(8).toString("hex")}.merging`;
  try { renameSync(path, claimed); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  try {
    const text = readPrivate(claimed, maximumInboxBytes * 2) ?? "";
    const observations: LimitObservation[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const row = fromRow(JSON.parse(line) as LedgerRow); if (row) observations.push(row); } catch { /* A torn final line is skipped. */ }
    }
    return observations;
  } finally { try { unlinkSync(claimed); } catch { /* Already removed. */ } }
}

/** Puts back an inbox claim that could not be merged, so a failed write never drops statusline samples. */
export function restoreInbox(directory: string, observations: LimitObservation[]): void {
  try { appendInbox(directory, observations); } catch { /* The ledger is best-effort history. */ }
}
