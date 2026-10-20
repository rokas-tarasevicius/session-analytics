import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import { join } from "node:path";

import { codexPlan, enumValue } from "./accounts.ts";
import type { Cursor } from "./ledger.ts";
import type { ClaudeAccountSummary, CodexAccountState, CodexPlan, LimitObservation, LimitStatus } from "./types.ts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const epochSeconds = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
};

/** Window length implied by a meter name when the record does not carry one. */
export function impliedWindowMinutes(meter: string): number | null {
  const base = meter.slice(meter.lastIndexOf(".") + 1);
  if (base === "five_hour") return 300;
  if (base.startsWith("seven_day")) return 10_080;
  return null;
}

/** Scoped Codex limits keep their id (`codex_spark.seven_day`); the account-wide `codex` limit is the bare window name. */
export function codexMeter(limitId: unknown, windowMinutes: number | null): string {
  const base = windowMinutes === 300 ? "five_hour" : windowMinutes === 10_080 ? "seven_day" : windowMinutes ? `window_${windowMinutes}m` : "window";
  const id = codexLimitId(limitId);
  return id !== "codex" ? `${id}.${base}` : base;
}
export const codexLimitId = (value: unknown): string => {
  const id = typeof value === "string" ? value.toLowerCase() : "codex";
  return /^[a-z0-9_-]{1,40}$/.test(id) ? id : "codex";
};
/** A scoped limit's display name, such as a model family; bounded so a backend string cannot widen the contract. */
export const limitName = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(value) ? value : null;

export interface CodexLimitRecord {
  observations: LimitObservation[]; plan: CodexPlan | null; planType: string | null; credits: CodexAccountState["credits"];
  limitId: string; limitName: string | null;
}

/** Codex `token_count` events carry the account's rate-limit snapshot; windows are identified by length, not slot. */
export function codexLimitRecord(value: unknown): CodexLimitRecord | null {
  const line = record(value);
  const payload = record(line?.["payload"]);
  if (line?.["type"] !== "event_msg" || payload?.["type"] !== "token_count") return null;
  const limits = record(payload["rate_limits"]);
  const observedAt = epochSeconds(line["timestamp"]);
  if (!limits || observedAt === null) return null;
  const reached = limits["rate_limit_reached_type"] !== null && limits["rate_limit_reached_type"] !== undefined;
  const observations: LimitObservation[] = [];
  for (const slot of ["primary", "secondary"]) {
    const window = record(limits[slot]);
    const used = finite(window?.["used_percent"]);
    if (!window || used === null) continue;
    const minutes = finite(window["window_minutes"]);
    const windowMinutes = minutes !== null && minutes > 0 ? Math.round(minutes) : null;
    // Older CLI versions reported a relative `resets_in_seconds` instead of an absolute instant.
    const resetsAt = finite(window["resets_at"]) ?? (finite(window["resets_in_seconds"]) !== null ? observedAt + finite(window["resets_in_seconds"])! : null);
    if (resetsAt === null) continue;
    observations.push({
      provider: "codex", account: "", meter: codexMeter(limits["limit_id"], windowMinutes), windowMinutes, resetsAt, observedAt,
      usedPercent: used, status: used >= 100 || (reached && used >= 99.5) ? "rejected" : "allowed", source: "codex-session",
    });
  }
  const plan = codexPlan(limits["plan_type"]);
  const credits = record(limits["credits"]);
  const balance = typeof credits?.["balance"] === "string" && /^\d+(?:\.\d+)?$/.test(credits["balance"]) ? Number(credits["balance"]) : finite(credits?.["balance"]);
  return observations.length || plan ? {
    observations, plan, planType: enumValue(limits["plan_type"]),
    credits: credits ? { hasCredits: credits["has_credits"] === true, unlimited: credits["unlimited"] === true, balance } : null,
    limitId: codexLimitId(limits["limit_id"]), limitName: limitName(limits["limit_name"]),
  } : null;
}

const claudeStatus = (value: unknown): LimitStatus =>
  value === "allowed" ? "allowed" : value === "allowed_warning" ? "warning" : value === "rejected" ? "rejected" : "unknown";

export interface ClaudeSdkEvent {
  observations: LimitObservation[];
  account: ClaudeAccountSummary | null;
  /** The Claude Code session ID, used only to find the profile it belongs to; never stored. */
  sessionId: string | null;
  /** The weekly window's reset instant, which identifies the account when the session cannot be found. */
  weeklyResetsAt: number | null;
}

/**
 * A Claude Agent SDK `rate_limit_event`, raw or inside a host's event-log envelope (T3 Code writes
 * `{observedAt, event: {payload: {...}}}`). Utilization is a fraction in SDK events and exceeds 1 on extra usage.
 */
export function claudeSdkEvent(value: unknown): ClaudeSdkEvent | null {
  const envelope = record(value);
  const event = record(envelope?.["event"]);
  const message = [record(event?.["payload"]), record(envelope?.["payload"]), envelope].find((candidate) => candidate?.["type"] === "rate_limit_event");
  const info = record(message?.["rate_limit_info"]);
  const observedAt = epochSeconds(envelope?.["observedAt"]) ?? epochSeconds(event?.["createdAt"]) ?? epochSeconds(envelope?.["timestamp"]);
  if (!info || observedAt === null) return null;
  const windows = new Map<string, Record<string, unknown>>();
  for (const [name, window] of Object.entries(record(info["unifiedWindows"]) ?? {})) if (record(window)) windows.set(name, record(window)!);
  const triggered = typeof info["rateLimitType"] === "string" ? info["rateLimitType"] : null;
  if (triggered && !windows.has(triggered)) windows.set(triggered, { utilization: info["utilization"], resetsAt: info["resetsAt"] });
  // Rejected while extra usage pays for the overflow: work continues, so this is not a lockout.
  const overage = info["isUsingOverage"] === true || info["overageInUse"] === true;
  const account = extraUsageState(info, observedAt);
  const observations: LimitObservation[] = [];
  for (const [meter, window] of windows) {
    const utilization = finite(window["utilization"]), resetsAt = finite(window["resetsAt"]);
    if (utilization === null || resetsAt === null) continue;
    const status = meter === triggered ? claudeStatus(info["status"]) : "unknown";
    // Extra usage pays past every window's cap, not only the one the event reports on. A full window that is not the
    // event's own stays unresolved unless extra usage is off; the snapshot settles it from the account's state.
    const full = utilization >= 1;
    observations.push({
      provider: "claude", account: "", meter, windowMinutes: impliedWindowMinutes(meter), resetsAt, observedAt, usedPercent: utilization * 100,
      status: overage && (full || status === "rejected") ? "overage" : full && status === "unknown" && account?.extraUsage === "disabled" ? "rejected" : status,
      source: "claude-sdk-log",
    });
  }
  const sessionId = typeof message?.["session_id"] === "string" && /^[0-9a-f-]{36}$/.test(message["session_id"]) ? message["session_id"] : null;
  return { observations, account, sessionId, weeklyResetsAt: finite(record(windows.get("seven_day"))?.["resetsAt"]) };
}

export const claudeSdkLimitRecord = (value: unknown): LimitObservation[] => claudeSdkEvent(value)?.observations ?? [];

/** Claude extra-usage state carried on SDK rate-limit events; reasons are kept only when they are short snake_case enums. */
function extraUsageState(info: Record<string, unknown>, observedAt: number): ClaudeAccountSummary | null {
  if (!("overageStatus" in info || "isUsingOverage" in info || "overageInUse" in info || "overageEnabled" in info)) return null;
  const reason = typeof info["overageDisabledReason"] === "string" && /^[a-z][a-z0-9_]{0,48}$/.test(info["overageDisabledReason"]) ? info["overageDisabledReason"] : null;
  const extraUsage = info["isUsingOverage"] === true || info["overageInUse"] === true ? "in-use"
    : info["overageEnabled"] === false || info["overageStatus"] === "rejected" ? "disabled"
    : info["overageEnabled"] === true || info["overageStatus"] === "allowed" || info["overageStatus"] === "allowed_warning" ? "enabled" : "unknown";
  return { observedAt, extraUsage, disabledReason: extraUsage === "disabled" ? reason : null };
}

export const claudeSdkAccount = (value: unknown): ClaudeAccountSummary | null => claudeSdkEvent(value)?.account ?? null;

/** Claude Code statusline input: `rate_limits.<window>.used_percentage` (0–100) and `resets_at` (Unix seconds). */
export function statuslineObservations(value: unknown, now: number, account = ""): LimitObservation[] {
  const limits = record(record(value)?.["rate_limits"]);
  const observations: LimitObservation[] = [];
  for (const [meter, window] of Object.entries(limits ?? {})) {
    const used = finite(record(window)?.["used_percentage"]), resetsAt = finite(record(window)?.["resets_at"]);
    if (used === null || resetsAt === null || resetsAt <= now) continue;
    observations.push({
      provider: "claude", account, meter, windowMinutes: impliedWindowMinutes(meter), resetsAt, observedAt: Math.floor(now),
      // The status line does not say whether a full window refused requests or went on to extra usage (hard caps read
      // 101-102% too); the snapshot settles readings at or past 100% from the account's extra-usage state.
      usedPercent: used, status: "unknown", source: "claude-statusline",
    });
  }
  return observations;
}

/**
 * Read cursors keyed by file identity (`dev:ino`): provider files are append-only and rotate by rename, so a later harvest
 * reads only each file's new tail, including after `events.log` becomes `events.log.1`. A cursor resumes only when a hash
 * of the beginning and bytes just before its offset still matches, which also catches truncation and inode reuse even
 * when a regrown file happens to repeat the old cursor's suffix. Only bounded samples are hashed, never stored.
 */
export type Cursors = Map<string, Cursor>;
const fingerprintBytes = 64;
const fingerprintPrefixBytes = 4096;

async function fingerprint(path: string, offset: number): Promise<string> {
  const length = Math.min(fingerprintBytes, offset);
  const prefix = Math.min(fingerprintPrefixBytes, offset - length);
  const buffer = Buffer.alloc(prefix + length);
  if (length) {
    const handle = await open(path, "r");
    try {
      if (prefix) await handle.read(buffer, 0, prefix, 0);
      await handle.read(buffer, prefix, length, offset - length);
    } finally { await handle.close(); }
  }
  return createHash("sha256").update("session-analytics/limits/cursor/v2\0").update(buffer).digest("hex").slice(0, 16);
}

const newline = 0x0a;

/** Streams complete lines appended since the last read and decodes only the lines containing `marker`. */
async function scanAppended(path: string, info: Stats, marker: string, cursors: Cursors, now: number, visit: (line: string) => void): Promise<Cursor> {
  const identity = `${info.dev}:${info.ino}`;
  const previous = cursors.get(identity);
  const resume = previous !== undefined && previous.offset <= info.size && await fingerprint(path, previous.offset) === previous.fingerprint;
  const start = resume ? previous.offset : 0;
  const needle = Buffer.from(marker);
  let pending: Buffer[] = [], pendingLength = 0, consumed = 0;
  if (start < info.size) {
    for await (const chunk of createReadStream(path, { start, highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
      let from = 0, end: number;
      while ((end = chunk.indexOf(newline, from)) >= 0) {
        const tail = chunk.subarray(from, end);
        const line = pendingLength ? Buffer.concat([...pending, tail], pendingLength + tail.length) : tail;
        consumed += line.length + 1;
        if (line.includes(needle)) visit(line.toString("utf8"));
        pending = []; pendingLength = 0; from = end + 1;
      }
      if (from < chunk.length) { const rest = chunk.subarray(from); pending.push(rest); pendingLength += rest.length; }
    }
  }
  const cursor: Cursor = { offset: start + consumed, fingerprint: consumed || !resume ? await fingerprint(path, start + consumed) : previous.fingerprint, seen: Math.floor(now) };
  if (resume && previous.account !== undefined) cursor.account = previous.account;
  cursors.set(identity, cursor);
  return cursor;
}

/** Files modified since `since`, plus files whose last read failed. */
async function* files(root: string, accept: (name: string) => boolean, since: number, cursors: Cursors): AsyncGenerator<[string, Stats]> {
  let directory;
  try { directory = await opendir(root); } catch { return; }
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path, accept, since, cursors);
    else if (entry.isFile() && accept(entry.name)) {
      let info: Stats;
      try { info = await stat(path); } catch { continue; } // Removed while walking.
      if (info.mtimeMs / 1000 >= since || cursors.get(`${info.dev}:${info.ino}`)?.retry) yield [path, info];
    }
  }
}

/** A file that could not be read keeps its old offset and is retried by the next harvest even if it is not modified again. */
function retry(cursors: Cursors, info: Stats, now: number): void {
  const identity = `${info.dev}:${info.ino}`;
  const previous = cursors.get(identity);
  cursors.set(identity, { offset: previous?.offset ?? 0, fingerprint: previous?.fingerprint ?? "", seen: Math.floor(now), retry: true });
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

const parsed = (line: string): unknown => {
  const start = line.indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(start ? line.slice(start) : line); } catch { return null; }
};

export interface CodexHarvest {
  /** Per rollout: the root it was found under, the account that created it (hashed), and its new rate-limit records. */
  files: Array<{ root: string; account: string | null; records: CodexLimitRecord[] }>;
  available: boolean;
}

export async function harvestCodex(roots: string[], since: number, cursors: Cursors, now: number, creator: (path: string) => Promise<string | null>): Promise<CodexHarvest> {
  const result: CodexHarvest = { files: [], available: false };
  for (const root of roots) {
    if (!(await exists(root))) continue;
    result.available = true;
    for await (const [path, info] of files(root, (name) => name.endsWith(".jsonl"), since, cursors)) {
      const records: CodexLimitRecord[] = [];
      try {
        const cursor = await scanAppended(path, info, "\"rate_limits\"", cursors, now, (line) => {
          const limits = codexLimitRecord(parsed(line));
          if (limits) records.push(limits);
        });
        // The creating account is read once per file and kept with its cursor; "" records that the rollout names none.
        cursor.account ??= await creator(path) ?? "";
        if (records.length) result.files.push({ root, account: cursor.account || null, records });
      } catch { retry(cursors, info, now); }
    }
  }
  return result;
}

export interface ClaudeHarvest { events: ClaudeSdkEvent[]; available: boolean }

export async function harvestClaudeEventLogs(roots: string[], since: number, cursors: Cursors, now: number): Promise<ClaudeHarvest> {
  const result: ClaudeHarvest = { events: [], available: false };
  for (const root of roots) {
    if (!(await exists(root))) continue;
    result.available = true;
    for await (const [path, info] of files(root, (name) => /\.(?:log|jsonl)(?:\.\d+)?$/.test(name), since, cursors)) {
      const events: ClaudeSdkEvent[] = [];
      try {
        await scanAppended(path, info, "\"rate_limit_event\"", cursors, now, (line) => {
          const event = claudeSdkEvent(parsed(line));
          if (event) events.push(event);
        });
        result.events.push(...events);
      } catch { retry(cursors, info, now); }
    }
  }
  return result;
}
