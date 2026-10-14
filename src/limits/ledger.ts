import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { INDEX_UNAVAILABLE, secureDirectory, secureFile } from "../store/database.ts";
import { accountAttribution, codexPlan, enumValue, identified, nextWeeklyReset, validAccount, weeklyPhase } from "./accounts.ts";
import { limitName } from "./sources.ts";
import {
  claudePlans,
  type ClaudeAccountSummary, type ClaudePlan, type CodexAccountSummary, type CodexPlan, type LimitObservation, type LimitProvider,
  type LimitSource, type LimitStatus, type PlanEvidence, type PlanSource, type ResetCredit,
} from "./types.ts";

/**
 * Private, content-free meter history. Provider logs rotate quickly; this ledger is what makes reset history possible.
 * Version 2 lives in its own file: version 1 binaries (still run by cron or other checkouts) would read a version 2
 * `limits.json` as empty and replace it, so `limits.json` is now only read, as import input.
 */
export const ledgerName = "limits-v2.json";
export const inboxName = "limits-inbox-v2.jsonl";
export const legacyLedgerName = "limits.json";
const maximumLedgerBytes = 16 * 1024 * 1024;
const maximumInboxBytes = 4 * 1024 * 1024;

export const retentionSeconds = 120 * 86_400;
/** Recent cycles keep 15-minute resolution; cycles that reset more than 14 days ago keep 3-hour resolution. */
const recentBucketSeconds = 900;
const archiveBucketSeconds = 3 * 3600;
const archiveAfterSeconds = 14 * 86_400;
/** Reset instants of one window drift by seconds between records; readings within this distance share a cycle. */
const resetToleranceSeconds = 120;
const cursorRetentionSeconds = 7 * 86_400;
const maximumCursors = 4096;

/** [provider, account, meter, windowMinutes, resetsAt, observedAt, usedPercent, status, source] */
export type LedgerRow = [LimitProvider, string, string, number | null, number, number, number, LimitStatus, LimitSource];

/** Byte offset of the last complete line read, with a hash of the bytes before it; `account` is a Codex rollout's creator. */
export interface Cursor { offset: number; fingerprint: string; seen: number; account?: string; retry?: boolean }

export interface LedgerAccount {
  provider: LimitProvider;
  plan: ClaudePlan | CodexPlan | null;
  planSource: PlanSource | null;
  planEvidence: PlanEvidence | null;
  planObservedAt: number | null;
  /** Claude: the latest extra-usage state from this account's own SDK events. */
  extraUsage: ClaudeAccountSummary | null;
  codex: CodexAccountSummary | null;
  profileKeys: string[];
}

export interface Ledger {
  version: 2;
  /** Provider files modified before this Unix time were already harvested. */
  harvestedThrough: number | null;
  /** Newest `limits.json` (version 1) reading already imported; older binaries may still append to that file. */
  importedV1Through: number | null;
  /** Keyed by file identity (`dev:ino`), never by path. */
  cursors: Record<string, Cursor>;
  accounts: Record<string, LedgerAccount>;
  /** Profile key → the account it was last logged into. */
  profiles: Record<string, string>;
  /** A profile's fallback key → the account it turned out to be logged into; applied on every merge. */
  aliases: Record<string, string>;
  /** Codex scoped limit id → display name. */
  limitNames: Record<string, string>;
  rows: LedgerRow[];
  /** [provider, account, observedAt, available], appended only when the count changes. */
  resetCreditHistory: Array<[LimitProvider, string, number, number]>;
  /** Last opt-in Codex account read, Unix seconds; reads are throttled. */
  codexAccountReadAt: number | null;
}

export const emptyLedger = (): Ledger => ({
  version: 2, harvestedThrough: null, importedV1Through: null, cursors: {}, accounts: {}, profiles: {}, aliases: {}, limitNames: {}, rows: [],
  resetCreditHistory: [], codexAccountReadAt: null,
});

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const time = (value: unknown): number | null => finite(value) && value >= 1_500_000_000 && value <= 4_000_000_000 ? Math.floor(value) : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

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

const providerOf = (value: unknown): LimitProvider | null => value === "claude" || value === "codex" ? value : null;

export function resetCreditHistory(value: unknown): Ledger["resetCreditHistory"] {
  if (!Array.isArray(value)) return [];
  const rows = new Map<string, [LimitProvider, string, number, number]>();
  for (const row of value) {
    const provider = Array.isArray(row) ? providerOf(row[0]) : null;
    if (!provider || !validAccount(provider, row[1]) || time(row[2]) === null || !finite(row[3]) || row[3] < 0 || row[3] > 1000) continue;
    const next: [LimitProvider, string, number, number] = [provider, row[1], time(row[2])!, Math.floor(row[3])];
    rows.set(next.join("|"), next);
  }
  return [...rows.values()].sort((left, right) => left[2] - right[2]).slice(-500);
}

function planEvidence(value: unknown): PlanEvidence | null {
  const evidence = record(value);
  return evidence ? {
    organizationType: enumValue(evidence["organizationType"]), organizationRateLimitTier: enumValue(evidence["organizationRateLimitTier"]),
    userRateLimitTier: enumValue(evidence["userRateLimitTier"]), seatTier: enumValue(evidence["seatTier"]), billingType: enumValue(evidence["billingType"]),
    planType: enumValue(evidence["planType"]),
  } : null;
}

const planSources = new Set<string>(["claude-config", "claude-credentials", "codex-account", "codex-session"]);
const profileKeyPattern = /^profile-[0-9a-f]{20}$/;

function ledgerAccount(key: string, value: unknown): LedgerAccount | null {
  const account = record(value);
  const provider = providerOf(account?.["provider"]);
  if (!account || !provider || key === "" || !validAccount(provider, key)) return null;
  const plan = provider === "claude" ? ((claudePlans as readonly string[]).includes(account["plan"] as string) ? account["plan"] as ClaudePlan : null) : codexPlan(account["plan"]);
  return {
    provider, plan, planSource: plan && planSources.has(account["planSource"] as string) ? account["planSource"] as PlanSource : null,
    planEvidence: planEvidence(account["planEvidence"]), planObservedAt: time(account["planObservedAt"]),
    extraUsage: provider === "claude" ? claudeSummary(account["extraUsage"]) : null, codex: provider === "codex" ? codexSummary(account["codex"]) : null,
    profileKeys: Array.isArray(account["profileKeys"]) ? [...new Set(account["profileKeys"].filter((item): item is string => typeof item === "string" && profileKeyPattern.test(item)))].slice(0, 32) : [],
  };
}

function cursorOf(value: unknown): Cursor | null {
  const cursor = record(value);
  const seen = time(cursor?.["seen"]);
  if (!cursor || seen === null || !Number.isSafeInteger(cursor["offset"]) || (cursor["offset"] as number) < 0 || typeof cursor["fingerprint"] !== "string" || !/^(?:[0-9a-f]{16})?$/.test(cursor["fingerprint"])) return null;
  const result: Cursor = { offset: cursor["offset"] as number, fingerprint: cursor["fingerprint"], seen };
  if (cursor["account"] === "" || validAccount("codex", cursor["account"])) result.account = cursor["account"] as string;
  if (cursor["retry"] === true) result.retry = true;
  return result;
}

/** Cursors of files not seen for a week are dropped; the table stays bounded. */
function pruneCursors(cursors: Record<string, Cursor>, now: number): Record<string, Cursor> {
  return Object.fromEntries(Object.entries(cursors).filter(([, cursor]) => cursor.seen >= now - cursorRetentionSeconds)
    .sort((left, right) => right[1].seen - left[1].seen).slice(0, maximumCursors));
}

const providers = new Set<string>(["claude", "codex"]);
const sources = new Set<string>(["codex-session", "codex-account", "claude-sdk-log", "claude-statusline"]);
const statuses = new Set<string>(["allowed", "warning", "rejected", "overage", "idle", "unknown"]);
const meterPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const statusRank: Record<LimitStatus, number> = { unknown: 0, idle: 0, allowed: 1, warning: 2, overage: 3, rejected: 4 };

/** The only gate into the ledger and the API: every field is re-validated, so a malformed source cannot widen the contract. */
export function validObservation(value: LimitObservation): LimitObservation | null {
  if (!providers.has(value.provider) || !sources.has(value.source) || !statuses.has(value.status)) return null;
  if (!validAccount(value.provider, value.account)) return null;
  if (typeof value.meter !== "string" || !meterPattern.test(value.meter)) return null;
  if (!finite(value.resetsAt) || !finite(value.observedAt) || !finite(value.usedPercent)) return null;
  if (value.resetsAt < 1_500_000_000 || value.resetsAt > 4_000_000_000 || value.observedAt < 1_500_000_000 || value.observedAt > 4_000_000_000) return null;
  if (value.windowMinutes !== null && (!Number.isInteger(value.windowMinutes) || value.windowMinutes <= 0 || value.windowMinutes > 60 * 24 * 62)) return null;
  return {
    provider: value.provider, account: value.account, meter: value.meter, windowMinutes: value.windowMinutes,
    resetsAt: Math.round(value.resetsAt), observedAt: Math.floor(value.observedAt),
    usedPercent: Math.round(Math.min(1000, Math.max(0, value.usedPercent)) * 10) / 10,
    status: value.status, source: value.source,
  };
}

export const toRow = (value: LimitObservation): LedgerRow =>
  [value.provider, value.account, value.meter, value.windowMinutes, value.resetsAt, value.observedAt, value.usedPercent, value.status, value.source];

export const fromRow = (row: LedgerRow): LimitObservation | null => Array.isArray(row) && row.length === 9
  ? validObservation({ provider: row[0], account: row[1], meter: row[2], windowMinutes: row[3], resetsAt: row[4], observedAt: row[5], usedPercent: row[6], status: row[7], source: row[8] })
  : null;

const seriesKey = (observation: LimitObservation): string => `${observation.provider}|${observation.account}|${observation.meter}`;

function groupBy<T>(items: Iterable<T>, key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group) group.push(item); else groups.set(name, [item]);
  }
  return groups;
}

/**
 * Unattributed Claude readings are keyed by their weekly reset's minute of the week. Each one joins a real account when
 * that account has a weekly reading with exactly the same reset instant, and only when exactly one account does.
 */
function mergeWeeklyPhases(observations: LimitObservation[]): void {
  const owners = new Map<number, Set<string>>();
  for (const observation of observations) {
    if (observation.provider !== "claude" || observation.meter !== "seven_day" || !identified(observation.account)) continue;
    const minute = Math.round(observation.resetsAt / 60);
    owners.set(minute, (owners.get(minute) ?? new Set()).add(observation.account));
  }
  for (const observation of observations) {
    const phase = weeklyPhase(observation.account);
    if (phase === null) continue;
    const weekly = observation.meter.startsWith("seven_day") ? observation.resetsAt : nextWeeklyReset(phase, observation.observedAt);
    const owner = owners.get(Math.round(weekly / 60));
    if (owner?.size === 1) observation.account = [...owner][0]!;
  }
}

/**
 * A window that has not started is reported at 0% with a reset one window after each reading, so the reset slides
 * forward: every Codex window, and Claude's 5-hour window (its reset floored to 10 minutes; Claude's weekly reset is fixed).
 * Such a reading starts a real cycle only when another reading confirms the same reset later or above 0%;
 * otherwise only the latest one is kept per meter, as an `idle` marker, and only while no later reading supersedes it.
 * Unattributed readings keep no marker: an idle window of no known account says nothing.
 */
function markIdle(series: LimitObservation[]): LimitObservation[] {
  const first = series[0];
  if (!first || (first.provider === "claude" && first.windowMinutes !== 300)) return series;
  const floored = first.provider === "claude" ? 600 : 0;
  const rolling = (item: LimitObservation) => {
    const lead = item.windowMinutes === null ? NaN : item.observedAt + item.windowMinutes * 60 - item.resetsAt;
    return item.usedPercent === 0 && lead >= -180 && lead <= floored + 180;
  };
  const byReset = [...series].sort((left, right) => left.resetsAt - right.resetsAt);
  const confirmed = (item: LimitObservation) => {
    let low = 0, high = byReset.length;
    while (low < high) { const middle = (low + high) >> 1; if (byReset[middle]!.resetsAt < item.resetsAt - resetToleranceSeconds) low = middle + 1; else high = middle; }
    for (let index = low; index < byReset.length && byReset[index]!.resetsAt <= item.resetsAt + resetToleranceSeconds; index += 1) {
      const other = byReset[index]!;
      if (other !== item && (other.usedPercent > 0 || other.observedAt - item.observedAt > 600)) return true;
    }
    return false;
  };
  const kept: LimitObservation[] = [];
  let idle: LimitObservation | null = null;
  for (const item of series) {
    if (!rolling(item)) kept.push(item);
    else if (confirmed(item)) kept.push(item.status === "idle" ? { ...item, status: "allowed" } : item);
    else if (!idle || item.observedAt > idle.observedAt) idle = item;
  }
  const marker: LimitObservation | null = idle;
  if (marker && marker.account !== "" && kept.every((item) => item.observedAt < marker.observedAt)) kept.push({ ...marker, status: "idle" });
  return kept;
}

/** Snap each reset instant to the busiest cycle within the tolerance; cycles never chain into each other. */
function clusterResets(series: LimitObservation[]): void {
  const counts = new Map<number, number>();
  for (const item of series) if (item.status !== "idle") counts.set(item.resetsAt, (counts.get(item.resetsAt) ?? 0) + 1);
  const anchors: number[] = [];
  const snapped = new Map<number, number>();
  for (const [value] of [...counts].sort((left, right) => right[1] - left[1] || left[0] - right[0])) {
    let best: number | null = null;
    for (const anchor of anchors) if (Math.abs(anchor - value) <= resetToleranceSeconds && (best === null || Math.abs(anchor - value) < Math.abs(best - value))) best = anchor;
    if (best === null) anchors.push(value);
    snapped.set(value, best ?? value);
  }
  for (const item of series) if (item.status !== "idle") item.resetsAt = snapped.get(item.resetsAt)!;
}

/**
 * One Codex account is in one cycle at a time. A cycle whose readings all fall inside a busier cycle's readings of the same
 * meter came from another limit context (another login or workspace in the same files), so it is moved to unattributed.
 */
function quarantineInterleaved(series: LimitObservation[]): void {
  if (series[0]?.provider !== "codex" || series[0].account === "") return;
  const cycles = [...groupBy(series.filter((item) => item.status !== "idle"), (item) => String(item.resetsAt)).values()].map((items) => ({
    items, first: items.reduce((value, item) => Math.min(value, item.observedAt), Infinity), last: items.reduce((value, item) => Math.max(value, item.observedAt), 0),
  }));
  for (const cycle of cycles) {
    if (cycles.some((other) => other !== cycle && other.first < cycle.first && other.last > cycle.last && other.items.length > cycle.items.length)) {
      for (const item of cycle.items) item.account = "";
    }
  }
}

/**
 * Normalize readings into one row per account, meter, reset cycle and time bucket. Each bucket keeps its highest reading
 * (earliest on ties) with the most severe status among them; a rejected reading keeps its own row and time, so the moment
 * a cap was hit is never moved earlier. Unattributed Claude readings join their account first, readings of windows that
 * have not started are reduced to one marker, and reset instants within two minutes are one cycle.
 */
export function compactObservations(observations: Iterable<LimitObservation>, now: number): LimitObservation[] {
  const valid: LimitObservation[] = [];
  for (const candidate of observations) {
    const observation = validObservation(candidate);
    if (observation && observation.observedAt >= now - retentionSeconds) valid.push(observation);
  }
  mergeWeeklyPhases(valid);
  const normalized: LimitObservation[] = [];
  for (const series of groupBy(valid, seriesKey).values()) {
    const kept = markIdle(series);
    clusterResets(kept);
    quarantineInterleaved(kept);
    normalized.push(...kept);
  }
  const buckets = new Map<string, LimitObservation>();
  for (const observation of normalized) {
    const size = observation.resetsAt < now - archiveAfterSeconds ? archiveBucketSeconds : recentBucketSeconds;
    const kind = observation.status === "rejected" ? "rejected" : observation.status === "idle" ? "idle" : "";
    const key = `${seriesKey(observation)}|${observation.resetsAt}|${Math.floor(observation.observedAt / size)}|${kind}`;
    const current = buckets.get(key);
    if (!current) { buckets.set(key, observation); continue; }
    if (kind === "rejected") { if (observation.observedAt < current.observedAt) buckets.set(key, observation); continue; }
    const higher = observation.usedPercent > current.usedPercent ||
      (observation.usedPercent === current.usedPercent && observation.observedAt < current.observedAt);
    const kept = higher ? { ...observation } : current;
    if (statusRank[current.status] > statusRank[kept.status]) kept.status = current.status;
    if (statusRank[observation.status] > statusRank[kept.status]) kept.status = observation.status;
    buckets.set(key, kept);
  }
  return [...buckets.values()].sort((left, right) =>
    left.provider.localeCompare(right.provider) || left.account.localeCompare(right.account) || left.meter.localeCompare(right.meter) ||
    left.resetsAt - right.resetsAt || left.observedAt - right.observedAt);
}

export const ledgerPath = (directory: string): string => join(directory, ledgerName);
export const inboxPath = (directory: string): string => join(directory, inboxName);

/** `null` when the file does not exist; `oversize` when it exceeds the cap. Links and foreign-owned files throw. */
function readPrivate(path: string, limit: number): string | "oversize" | null {
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new Error(INDEX_UNAVAILABLE);
    if (info.size > limit) return "oversize";
    return readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
}

/**
 * `corrupt`: not parseable or over the size cap, safe to set aside. `foreign`: another version's ledger, or a file this
 * user must not replace (a link, another owner); it is never written.
 */
export type LedgerRead = { status: "missing" | "ok"; ledger: Ledger } | { status: "corrupt" | "foreign"; ledger: null };

export function readLedger(directory: string, now = Date.now() / 1000): LedgerRead {
  let text: string | "oversize" | null;
  try { text = readPrivate(ledgerPath(directory), maximumLedgerBytes); } catch { return { status: "foreign", ledger: null }; }
  if (text === null) return { status: "missing", ledger: emptyLedger() };
  if (text === "oversize") return { status: "corrupt", ledger: null };
  let value: Record<string, unknown> | null;
  try { value = record(JSON.parse(text)); } catch { return { status: "corrupt", ledger: null }; }
  if (!value || !Array.isArray(value["rows"])) return { status: "corrupt", ledger: null };
  if (value["version"] !== 2) return { status: "foreign", ledger: null };
  const accounts: Record<string, LedgerAccount> = {};
  for (const [key, account] of Object.entries(record(value["accounts"]) ?? {})) { const valid = ledgerAccount(key, account); if (valid) accounts[key] = valid; }
  const cursors: Record<string, Cursor> = {};
  for (const [key, cursor] of Object.entries(record(value["cursors"]) ?? {})) { const valid = cursorOf(cursor); if (valid && /^\d+:\d+$/.test(key)) cursors[key] = valid; }
  const profiles: Record<string, string> = {};
  for (const [key, account] of Object.entries(record(value["profiles"]) ?? {})) if (profileKeyPattern.test(key) && typeof account === "string" && identified(account) && (validAccount("claude", account) || validAccount("codex", account))) profiles[key] = account;
  const aliases: Record<string, string> = {};
  for (const [key, account] of Object.entries(record(value["aliases"]) ?? {})) if (aliasValid(key, account)) aliases[key] = account;
  const limitNames: Record<string, string> = {};
  for (const [key, name] of Object.entries(record(value["limitNames"]) ?? {})) if (/^[a-z0-9_-]{1,40}$/.test(key) && limitName(name)) limitNames[key] = name as string;
  return {
    status: "ok",
    ledger: {
      version: 2, harvestedThrough: time(value["harvestedThrough"]), importedV1Through: time(value["importedV1Through"]),
      cursors: pruneCursors(cursors, now), accounts, profiles, aliases, limitNames,
      rows: (value["rows"] as LedgerRow[]).map(fromRow).filter((row): row is LimitObservation => row !== null).map(toRow),
      resetCreditHistory: resetCreditHistory(value["resetCreditHistory"]),
      codexAccountReadAt: time(value["codexAccountReadAt"]),
    },
  };
}

/** Moves an unparseable ledger aside instead of replacing it, so nothing is destroyed. */
export function setAsideLedger(directory: string, now = Date.now() / 1000): void {
  renameSync(ledgerPath(directory), `${ledgerPath(directory)}.unreadable-${Math.floor(now)}`);
}

function aliasValid(key: string, account: unknown): account is string {
  const provider = key.startsWith("claude-") ? "claude" : "codex";
  return validAccount(provider, key) && validAccount(provider, account) && accountAttribution(key) === "profile" && accountAttribution(account) === "account";
}

/** Readings first kept under a profile's fallback key belong to the account that profile turned out to be logged into. */
export function applyAliases(ledger: Ledger): Ledger {
  const alias = (key: string) => ledger.aliases[key] ?? key;
  if (!Object.keys(ledger.aliases).length) return ledger;
  const accounts: Record<string, LedgerAccount> = {};
  for (const [key, account] of Object.entries(ledger.accounts)) accounts[alias(key)] = mergeAccount(accounts[alias(key)], account);
  return {
    ...ledger, accounts,
    rows: ledger.rows.map((row): LedgerRow => ledger.aliases[row[1]] ? [row[0], alias(row[1]), ...row.slice(2)] as LedgerRow : row),
    resetCreditHistory: ledger.resetCreditHistory.map((row): [LimitProvider, string, number, number] => [row[0], alias(row[1]), row[2], row[3]]),
  };
}

const later = <T extends { observedAt: number }>(left: T | null, right: T | null): T | null =>
  !left ? right : !right ? left : right.observedAt >= left.observedAt ? right : left;

export function mergeAccount(left: LedgerAccount | undefined, right: LedgerAccount): LedgerAccount {
  if (!left) return { ...right, profileKeys: [...right.profileKeys] };
  const plan = (right.planObservedAt ?? 0) >= (left.planObservedAt ?? 0) && right.plan ? right : left.plan ? left : right;
  return {
    provider: right.provider, plan: plan.plan, planSource: plan.planSource, planEvidence: plan.planEvidence ?? left.planEvidence ?? right.planEvidence, planObservedAt: plan.planObservedAt,
    extraUsage: later(left.extraUsage, right.extraUsage), codex: later(left.codex, right.codex),
    profileKeys: [...new Set([...left.profileKeys, ...right.profileKeys])].slice(-32),
  };
}

/**
 * Union two ledgers. Rows max-merge per bucket, so merging is commutative; cursors keep the furthest read; account
 * summaries keep the latest observation. Used on every write, so a concurrent harvest (cron and the dashboard) never
 * erases the other's readings.
 */
export function mergeLedgers(left: Ledger, right: Ledger, now: number): Ledger {
  const cursors = { ...left.cursors };
  for (const [identity, cursor] of Object.entries(right.cursors)) {
    const current = cursors[identity];
    if (!current || cursor.offset > current.offset || (cursor.offset === current.offset && (!cursor.retry || cursor.seen >= current.seen))) cursors[identity] = cursor;
  }
  const aliases = { ...left.aliases, ...right.aliases };
  const [first, second] = [applyAliases({ ...left, aliases }), applyAliases({ ...right, aliases })];
  const accounts = { ...first.accounts };
  for (const [key, account] of Object.entries(second.accounts)) accounts[key] = mergeAccount(accounts[key], account);
  const max = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
  return {
    version: 2, harvestedThrough: max(left.harvestedThrough, right.harvestedThrough), importedV1Through: max(left.importedV1Through, right.importedV1Through),
    cursors: pruneCursors(cursors, now), accounts, profiles: { ...left.profiles, ...right.profiles }, aliases, limitNames: { ...left.limitNames, ...right.limitNames },
    rows: compactObservations([...first.rows, ...second.rows].map(fromRow).filter((row): row is LimitObservation => row !== null), now).map(toRow),
    resetCreditHistory: resetCreditHistory([...first.resetCreditHistory, ...second.resetCreditHistory]),
    codexAccountReadAt: max(left.codexAccountReadAt, right.codexAccountReadAt),
  };
}

export const LEDGER_UNREADABLE = "The limits ledger was written by another version or cannot be replaced; it was left untouched.";

/**
 * Merge into the ledger on disk and replace it atomically. The current file is re-read just before the rename, so a write
 * never drops what another process wrote meanwhile, and a ledger this version cannot read is never overwritten.
 */
export function writeLedger(directory: string, ledger: Ledger, now = Date.now() / 1000): Ledger {
  secureDirectory(directory);
  const path = ledgerPath(directory);
  secureFile(path);
  const current = readLedger(directory, now);
  if (!current.ledger) throw new Error(LEDGER_UNREADABLE);
  const merged = current.status === "ok" ? mergeLedgers(current.ledger, ledger, now) : ledger;
  const temporary = `${path}.${randomBytes(16).toString("hex")}.next`;
  writeFileSync(temporary, `${JSON.stringify(merged)}\n`, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  return merged;
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

/**
 * Claims the inbox by renaming it first, so samples appended during the merge land in a fresh inbox and two harvests
 * never drain the same samples. A failed write restores the claim; a successful one is merged on write.
 */
export function drainInbox(directory: string): LimitObservation[] {
  const path = inboxPath(directory);
  const claimed = `${path}.${randomBytes(8).toString("hex")}.merging`;
  try { renameSync(path, claimed); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  try {
    const text = readPrivate(claimed, maximumInboxBytes * 2);
    const observations: LimitObservation[] = [];
    for (const line of typeof text === "string" && text !== "oversize" ? text.split("\n") : []) {
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

export interface LegacyLedger {
  observations: LimitObservation[];
  codexPlan: CodexPlan | null;
  codex: CodexAccountSummary | null;
  resetCreditHistory: Array<[number, number]>;
}

/** The version 1 ledger (`limits.json`), read-only: its rows carry no account. */
export function readLegacyLedger(directory: string): LegacyLedger | null {
  let value: Record<string, unknown> | null;
  try {
    const text = readPrivate(join(directory, legacyLedgerName), maximumLedgerBytes);
    if (typeof text !== "string" || text === "oversize") return null;
    value = record(JSON.parse(text));
  } catch { return null; }
  if (value?.["version"] !== 1 || !Array.isArray(value["rows"])) return null;
  const observations: LimitObservation[] = [];
  for (const row of value["rows"] as unknown[]) {
    if (!Array.isArray(row) || row.length !== 8) continue;
    const observation = validObservation({ provider: row[0], account: "", meter: row[1], windowMinutes: row[2], resetsAt: row[3], observedAt: row[4], usedPercent: row[5], status: row[6], source: row[7] });
    if (observation) observations.push(observation);
  }
  return {
    observations, codexPlan: codexPlan(record(value["plans"])?.["codex"]), codex: codexSummary(record(value["accounts"])?.["codex"]),
    resetCreditHistory: Array.isArray(value["resetCreditHistory"]) ? (value["resetCreditHistory"] as unknown[])
      .filter((row): row is ["codex", number, number] => Array.isArray(row) && row[0] === "codex" && time(row[1]) !== null && finite(row[2]) && row[2] >= 0 && row[2] <= 1000)
      .map((row): [number, number] => [time(row[1])!, Math.floor(row[2])]) : [],
  };
}

const weekMinute = (resetsAt: number): number => Math.round(resetsAt / 60) % 10_080;

/**
 * Give version 1 readings an account. A Claude weekly reading goes to the one account whose weekly resets fall at the
 * same minute of the week; other Claude readings join the account whose harvested readings share their cycle, else the
 * majority of the weekly readings taken at the same instants in their cycle; Codex readings go to the only Codex account.
 * Anything else stays unattributed (`""`). Readings the ledger already holds (same meter, instant and value) are skipped.
 */
export function attributeLegacy(legacy: LimitObservation[], current: LimitObservation[], codexAccounts: string[]): LimitObservation[] {
  const phases = new Map<number, Set<string>>();
  const held = new Set<string>();
  for (const row of current) {
    held.add(`${row.provider}|${row.meter}|${row.observedAt}|${row.usedPercent}`);
    if (row.provider === "claude" && row.meter.startsWith("seven_day") && identified(row.account)) phases.set(weekMinute(row.resetsAt), (phases.get(weekMinute(row.resetsAt)) ?? new Set()).add(row.account));
  }
  const weeklyOwner = (row: LimitObservation) => { const owners = phases.get(weekMinute(row.resetsAt)); return owners?.size === 1 ? [...owners][0]! : ""; };
  // A cycle the harvest already attributed (the event logs still hold it) keeps that account.
  const harvested = groupBy(current.filter((row) => row.provider === "claude" && identified(row.account)), (row) => row.meter);
  const harvestedOwner = (meter: string, resetsAt: number) => {
    const owners = new Set((harvested.get(meter) ?? []).filter((row) => Math.abs(row.resetsAt - resetsAt) <= resetToleranceSeconds).map((row) => row.account));
    return owners.size === 1 ? [...owners][0]! : null;
  };
  const instants = new Map<number, string[]>();
  for (const row of legacy) {
    if (row.provider !== "claude" || !row.meter.startsWith("seven_day")) continue;
    const owner = weeklyOwner(row);
    if (owner) instants.set(row.observedAt, [...(instants.get(row.observedAt) ?? []), owner]);
  }
  const cycleOwner = new Map<string, string>();
  for (const [key, rows] of groupBy(legacy.filter((row) => row.provider === "claude" && !row.meter.startsWith("seven_day")), (row) => `${row.meter}|${row.resetsAt}`)) {
    const votes = new Map<string, number>();
    let total = 0;
    for (const row of rows) for (const owner of instants.get(row.observedAt) ?? []) { votes.set(owner, (votes.get(owner) ?? 0) + 1); total += 1; }
    const [winner, count] = [...votes].sort((left, right) => right[1] - left[1])[0] ?? ["", 0];
    cycleOwner.set(key, harvestedOwner(rows[0]!.meter, rows[0]!.resetsAt) ?? (count * 2 > total ? winner : ""));
  }
  return legacy.filter((row) => !held.has(`${row.provider}|${row.meter}|${row.observedAt}|${row.usedPercent}`)).map((row) => ({
    ...row,
    account: row.provider === "codex" ? (codexAccounts.length === 1 ? codexAccounts[0]! : "")
      : row.meter.startsWith("seven_day") ? weeklyOwner(row) : cycleOwner.get(`${row.meter}|${row.resetsAt}`) ?? "",
  }));
}
