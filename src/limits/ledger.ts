import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { INDEX_UNAVAILABLE, secureDirectory, secureFile } from "../store/database.ts";
import { acquireWriterGate } from "../store/writer-gate.ts";
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
/** Ledger writers in every process take turns through their own gate, so a long index ingest never holds one up. */
export const gateName = "limits-gate";
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
const maximumCreators = 16;

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
  /**
   * A Codex home's fallback key → every account seen creating its rollouts or answering for it. Readings that name no
   * account join the home's account only while exactly one is known; a second one revokes that alias.
   */
  creators: Record<string, string[]>;
  /** Codex scoped limit id → display name. */
  limitNames: Record<string, string>;
  rows: LedgerRow[];
  /** [provider, account, observedAt, available], appended only when the count changes. */
  resetCreditHistory: Array<[LimitProvider, string, number, number]>;
  /** Last opt-in Codex account read, Unix seconds; reads are throttled. */
  codexAccountReadAt: number | null;
  /**
   * The newest reading each of this machine's own sources gave, Unix seconds. Readings folded in from other machines never
   * advance it, so source health describes this machine.
   */
  sourceLatest: Partial<Record<LimitSource, number>>;
}

export const emptyLedger = (): Ledger => ({
  version: 2, harvestedThrough: null, importedV1Through: null, cursors: {}, accounts: {}, profiles: {}, aliases: {}, creators: {}, limitNames: {}, rows: [],
  resetCreditHistory: [], codexAccountReadAt: null, sourceLatest: {},
});

/** `latest` advanced by these readings, per source. */
export function advanceSources(latest: Ledger["sourceLatest"], rows: Array<Pick<LimitObservation, "source" | "observedAt">>): Ledger["sourceLatest"] {
  const next = { ...latest };
  for (const { source, observedAt } of rows) next[source] = Math.max(next[source] ?? 0, Math.floor(observedAt));
  return next;
}

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

/** An account record from the ledger or another machine, through the same allowlists. */
export function ledgerAccount(key: string, value: unknown): LedgerAccount | null {
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

/** A fall of this many points inside one cycle, confirmed by the next reading, is an in-place reset (as in the view). */
const resetDrop = 5;

/**
 * Number the segments of each cycle: a provider can restart a meter at 0% without moving its reset, and readings after
 * that must never share a bucket with the higher readings before it. Same rule as the view's `segmentsOf`.
 */
function segmentOrdinals(series: LimitObservation[], ordinals: Map<LimitObservation, number>): void {
  for (const cycle of groupBy(series.filter((item) => item.status !== "idle"), (item) => String(item.resetsAt)).values()) {
    const sorted = [...cycle].sort((left, right) => left.observedAt - right.observedAt);
    let ordinal = 0, top = -Infinity;
    sorted.forEach((item, index) => {
      const next = sorted[index + 1], floor = top - resetDrop;
      if (index > 0 && item.usedPercent <= floor && (next ? next.usedPercent <= floor : item.usedPercent <= top / 2)) { ordinal += 1; top = -Infinity; }
      ordinals.set(item, ordinal);
      top = Math.max(top, item.usedPercent);
    });
  }
}

/** A total order, so the latest reading of a series is the same whatever order ledgers are merged in. */
const laterReading = (left: LimitObservation, right: LimitObservation): boolean =>
  (left.observedAt - right.observedAt || left.usedPercent - right.usedPercent || statusRank[left.status] - statusRank[right.status] ||
    (left.source > right.source ? 1 : left.source < right.source ? -1 : 0)) > 0;

/**
 * Normalize readings into one row per account, meter, reset cycle, segment and time bucket. Each bucket keeps its highest
 * reading (earliest on ties) with the most severe status among them; a rejected reading keeps its own row and time, so
 * the moment a cap was hit is never moved earlier, and each meter's latest reading keeps its own row, so the level shown
 * now is never an earlier, higher reading. Unattributed Claude readings join their account first, readings of windows
 * that have not started are reduced to one marker, and reset instants within two minutes are one cycle.
 */
export function compactObservations(observations: Iterable<LimitObservation>, now: number): LimitObservation[] {
  const valid: LimitObservation[] = [];
  for (const candidate of observations) {
    const observation = validObservation(candidate);
    if (observation && observation.observedAt >= now - retentionSeconds) valid.push(observation);
  }
  mergeWeeklyPhases(valid);
  const normalized: LimitObservation[] = [];
  const ordinals = new Map<LimitObservation, number>();
  for (const series of groupBy(valid, seriesKey).values()) {
    const kept = markIdle(series);
    clusterResets(kept);
    quarantineInterleaved(kept);
    segmentOrdinals(kept, ordinals);
    normalized.push(...kept);
  }
  const latest = new Map<string, LimitObservation>();
  for (const observation of normalized) {
    const current = latest.get(seriesKey(observation));
    if (observation.status !== "idle" && (!current || laterReading(observation, current))) latest.set(seriesKey(observation), observation);
  }
  const buckets = new Map<string, LimitObservation>();
  for (const observation of normalized) {
    const last = latest.get(seriesKey(observation));
    // An identical copy of the latest reading (the same ledger merged twice) is that reading.
    if (last && last !== observation && last.observedAt === observation.observedAt && last.usedPercent === observation.usedPercent && last.resetsAt === observation.resetsAt && last.status === observation.status) continue;
    const size = observation.resetsAt < now - archiveAfterSeconds ? archiveBucketSeconds : recentBucketSeconds;
    const kind = observation.status === "rejected" ? "rejected" : observation.status === "idle" ? "idle" : last === observation ? "latest" : "";
    const key = `${seriesKey(observation)}|${observation.resetsAt}|${ordinals.get(observation) ?? 0}|${Math.floor(observation.observedAt / size)}|${kind}`;
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

/**
 * `null` when the file does not exist; `oversize` when it exceeds the cap. Links and foreign-owned files throw. A file
 * another writer replaced between open and stat (no links left) is opened again; its old content is still whole.
 */
function readPrivate(path: string, limit: number): string | "oversize" | null {
  for (let attempt = 0; ; attempt += 1) {
    let descriptor: number;
    try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const info = fstatSync(descriptor);
      if (info.nlink === 0 && attempt < 3) continue;
      if (!info.isFile() || info.nlink > 1 || (process.getuid && info.uid !== process.getuid())) throw new Error(INDEX_UNAVAILABLE);
      if (info.size > limit) return "oversize";
      return readFileSync(descriptor, "utf8");
    } finally { closeSync(descriptor); }
  }
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
  const creators: Record<string, string[]> = {};
  for (const [key, accounts] of Object.entries(record(value["creators"]) ?? {})) {
    const valid = Array.isArray(accounts) ? accounts.filter((account) => aliasValid(key, account)) : [];
    if (key.startsWith("codex-") && valid.length) creators[key] = [...new Set(valid)].slice(0, maximumCreators);
  }
  const limitNames: Record<string, string> = {};
  for (const [key, name] of Object.entries(record(value["limitNames"]) ?? {})) if (/^[a-z0-9_-]{1,40}$/.test(key) && limitName(name)) limitNames[key] = name as string;
  const rows = (value["rows"] as LedgerRow[]).map(fromRow).filter((row): row is LimitObservation => row !== null);
  // A ledger without `sourceLatest` predates other machines' readings being folded in: every reading in it is this machine's.
  const latest = record(value["sourceLatest"]), sourceLatest: Ledger["sourceLatest"] = {};
  for (const [source, at] of Object.entries(latest ?? {})) if (sources.has(source) && time(at) !== null) sourceLatest[source as LimitSource] = time(at)!;
  return {
    status: "ok",
    ledger: {
      version: 2, harvestedThrough: time(value["harvestedThrough"]), importedV1Through: time(value["importedV1Through"]),
      cursors: pruneCursors(cursors, now), accounts, profiles, aliases, creators, limitNames, rows: rows.map(toRow),
      resetCreditHistory: resetCreditHistory(value["resetCreditHistory"]),
      codexAccountReadAt: time(value["codexAccountReadAt"]), sourceLatest: latest ? sourceLatest : advanceSources({}, rows),
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

/**
 * The newest plan evidence wins, including a newer reading of a plan this version does not recognise (a tier change);
 * a record without plan evidence (no `planObservedAt`) never replaces one with it.
 */
export function mergeAccount(left: LedgerAccount | undefined, right: LedgerAccount): LedgerAccount {
  if (!left) return { ...right, profileKeys: [...right.profileKeys] };
  const [older, newer] = [left.planObservedAt, right.planObservedAt];
  const plan = newer !== null && (older === null || newer >= older) ? right : older !== null ? left : right.plan ? right : left;
  return {
    provider: right.provider, plan: plan.plan, planSource: plan.planSource, planEvidence: plan.planEvidence ?? left.planEvidence ?? right.planEvidence, planObservedAt: plan.planObservedAt,
    extraUsage: later(left.extraUsage, right.extraUsage), codex: later(left.codex, right.codex),
    profileKeys: [...new Set([...left.profileKeys, ...right.profileKeys])].slice(-32),
  };
}

/**
 * Union two ledgers. Rows max-merge per bucket, so merging is commutative; cursors keep the furthest read; account
 * summaries keep the latest observation. Every write merges with the file on disk under the limits gate, so harvests in
 * other processes (cron and the dashboard) never erase each other's readings.
 */
export function mergeLedgers(left: Ledger, right: Ledger, now: number): Ledger {
  const cursors = { ...left.cursors };
  for (const [identity, cursor] of Object.entries(right.cursors)) {
    const current = cursors[identity];
    if (!current || cursor.offset > current.offset || (cursor.offset === current.offset && (!cursor.retry || cursor.seen >= current.seen))) cursors[identity] = cursor;
  }
  const creators: Record<string, string[]> = { ...left.creators };
  for (const [key, accounts] of Object.entries(right.creators)) creators[key] = [...new Set([...creators[key] ?? [], ...accounts])].sort().slice(0, maximumCreators);
  // A home that turned out to hold two logins no longer sends its unattributed readings to either.
  const aliases = Object.fromEntries(Object.entries({ ...left.aliases, ...right.aliases }).filter(([key]) => (creators[key]?.length ?? 0) <= 1));
  const [first, second] = [applyAliases({ ...left, aliases }), applyAliases({ ...right, aliases })];
  const accounts = { ...first.accounts };
  for (const [key, account] of Object.entries(second.accounts)) accounts[key] = mergeAccount(accounts[key], account);
  const max = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
  return {
    version: 2, harvestedThrough: max(left.harvestedThrough, right.harvestedThrough), importedV1Through: max(left.importedV1Through, right.importedV1Through),
    cursors: pruneCursors(cursors, now), accounts, profiles: { ...left.profiles, ...right.profiles }, aliases, creators, limitNames: { ...left.limitNames, ...right.limitNames },
    rows: compactObservations([...first.rows, ...second.rows].map(fromRow).filter((row): row is LimitObservation => row !== null), now).map(toRow),
    resetCreditHistory: resetCreditHistory([...first.resetCreditHistory, ...second.resetCreditHistory]),
    codexAccountReadAt: max(left.codexAccountReadAt, right.codexAccountReadAt),
    sourceLatest: advanceSources(left.sourceLatest, Object.entries(right.sourceLatest).map(([source, observedAt]) => ({ source: source as LimitSource, observedAt }))),
  };
}

export const LEDGER_UNREADABLE = "The limits ledger was written by another version or cannot be replaced; it was left untouched.";

/**
 * Merge into the ledger on disk and replace it atomically, holding the limits gate: the current file is re-read under it,
 * so no writer in any process drops what another wrote. With `inbox`, the status-line inbox is claimed and merged in
 * the same turn, and its claim is deleted only once the new ledger is in place. A ledger this version cannot read is
 * never overwritten.
 */
export function writeLedger(directory: string, ledger: Ledger, now = Date.now() / 1000, { inbox = false } = {}): { ledger: Ledger; inbox: LimitObservation[] } {
  secureDirectory(directory);
  const gate = join(directory, gateName);
  secureDirectory(gate);
  const release = acquireWriterGate(gate);
  try {
    const path = ledgerPath(directory);
    secureFile(path);
    const current = readLedger(directory, now);
    if (!current.ledger) throw new Error(LEDGER_UNREADABLE);
    const claims = inbox ? claimInbox(directory) : [];
    const samples = claims.flatMap((claim) => claim.observations);
    try {
      const merged = mergeLedgers(current.ledger, samples.length ? { ...ledger, rows: [...ledger.rows, ...samples.map(toRow)], sourceLatest: advanceSources(ledger.sourceLatest, samples) } : ledger, now);
      const temporary = `${path}.${randomBytes(16).toString("hex")}.next`;
      writeFileSync(temporary, `${JSON.stringify(merged)}\n`, { mode: 0o600, flag: "wx" });
      try { renameSync(temporary, path); }
      finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      settleClaims(directory, claims);
      return { ledger: merged, inbox: samples };
    } catch (error) {
      // Put the samples back for the next harvest; if even that fails, the claims stay on disk and are taken next time.
      try { if (samples.length) appendInbox(directory, samples); for (const claim of claims) unlinkSync(claim.path); } catch { /* Kept as claims. */ }
      throw error;
    }
  } finally { release(); }
}

/** Statusline samples arrive many times a minute; they are appended here and folded into the ledger on the next harvest. */
export function appendInbox(directory: string, observations: LimitObservation[]): void {
  const rows = observations.map(validObservation).filter((row): row is LimitObservation => row !== null).map(toRow);
  if (!rows.length) return;
  secureDirectory(directory);
  const path = inboxPath(directory);
  secureFile(path);
  // Created by the open itself: a harvest may claim (rename) the inbox at any moment.
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink > 1 || (process.getuid && info.uid !== process.getuid())) throw new Error(INDEX_UNAVAILABLE);
    if (info.size > maximumInboxBytes) return;
    writeFileSync(descriptor, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  } finally { closeSync(descriptor); }
}

interface Claim { path: string; bytes: number; observations: LimitObservation[] }

const claimPattern = /^limits-inbox-v2\.jsonl\.[0-9a-f]{16}\.merging$/;

function inboxRows(text: string): LimitObservation[] {
  const observations: LimitObservation[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { const row = fromRow(JSON.parse(line) as LedgerRow); if (row) observations.push(row); } catch { /* A torn final line is skipped. */ }
  }
  return observations;
}

function readClaim(path: string): Claim | null {
  try {
    const text = readPrivate(path, maximumInboxBytes * 2);
    if (text === null) return null;
    return text === "oversize" ? { path, bytes: Infinity, observations: [] } : { path, bytes: Buffer.byteLength(text), observations: inboxRows(text) };
  } catch { return null; }
}

/**
 * Claims the inbox by renaming it, so samples appended meanwhile land in a fresh inbox. Claims a stopped harvest left
 * behind are taken too: the caller holds the gate, so no other harvest is merging them. Merging is idempotent, so a
 * claim taken twice adds nothing twice.
 */
function claimInbox(directory: string): Claim[] {
  try { renameSync(inboxPath(directory), `${inboxPath(directory)}.${randomBytes(8).toString("hex")}.merging`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return readdirSync(directory).filter((name) => claimPattern.test(name)).map((name) => readClaim(join(directory, name))).filter((claim): claim is Claim => claim !== null);
}

/** A status line that opened the inbox just before it was claimed may append after the claim was read; that tail goes back. */
function settleClaims(directory: string, claims: Claim[]): void {
  for (const claim of claims) {
    try {
      const text = readPrivate(claim.path, maximumInboxBytes * 2);
      if (typeof text === "string" && text !== "oversize" && Buffer.byteLength(text) > claim.bytes) appendInbox(directory, inboxRows(Buffer.from(text).subarray(claim.bytes).toString("utf8")));
      unlinkSync(claim.path);
    } catch { /* Taken again by the next harvest. */ }
  }
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
