import { createReadStream } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { claudePlans, codexPlans, type ClaudeAccountSummary, type ClaudePlan, type CodexAccountState, type CodexPlan, type LimitObservation, type LimitStatus } from "./types.ts";

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

function codexMeter(limitId: unknown, windowMinutes: number | null): string {
  const base = windowMinutes === 300 ? "five_hour" : windowMinutes === 10_080 ? "seven_day" : windowMinutes ? `window_${windowMinutes}m` : "window";
  const id = typeof limitId === "string" ? limitId.toLowerCase() : "codex";
  return id !== "codex" && /^[a-z0-9_-]{1,40}$/.test(id) ? `${id}.${base}` : base;
}

export interface CodexLimitRecord { observations: LimitObservation[]; plan: CodexPlan | null; credits: CodexAccountState["credits"] }

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
      provider: "codex", meter: codexMeter(limits["limit_id"], windowMinutes), windowMinutes, resetsAt, observedAt,
      usedPercent: used, status: used >= 100 || (reached && used >= 99.5) ? "rejected" : "allowed", source: "codex-session",
    });
  }
  const plan = typeof limits["plan_type"] === "string" && (codexPlans as readonly string[]).includes(limits["plan_type"]) ? limits["plan_type"] as CodexPlan : null;
  const credits = record(limits["credits"]);
  const balance = typeof credits?.["balance"] === "string" && /^\d+(?:\.\d+)?$/.test(credits["balance"]) ? Number(credits["balance"]) : finite(credits?.["balance"]);
  return observations.length || plan ? {
    observations, plan,
    credits: credits ? { hasCredits: credits["has_credits"] === true, unlimited: credits["unlimited"] === true, balance } : null,
  } : null;
}

const claudeStatus = (value: unknown): LimitStatus =>
  value === "allowed" ? "allowed" : value === "allowed_warning" ? "warning" : value === "rejected" ? "rejected" : "unknown";

/**
 * A Claude Agent SDK `rate_limit_event`, raw or inside a host's event-log envelope (T3 Code writes
 * `{observedAt, event: {payload: {...}}}`). Utilization is a 0–1 fraction in SDK events.
 */
export function claudeSdkLimitRecord(value: unknown): LimitObservation[] {
  const envelope = record(value);
  const event = record(envelope?.["event"]);
  const message = [record(event?.["payload"]), record(envelope?.["payload"]), envelope].find((candidate) => candidate?.["type"] === "rate_limit_event");
  const info = record(message?.["rate_limit_info"]);
  const observedAt = epochSeconds(envelope?.["observedAt"]) ?? epochSeconds(event?.["createdAt"]) ?? epochSeconds(envelope?.["timestamp"]);
  if (!info || observedAt === null) return [];
  const windows = new Map<string, Record<string, unknown>>();
  for (const [name, window] of Object.entries(record(info["unifiedWindows"]) ?? {})) if (record(window)) windows.set(name, record(window)!);
  const triggered = typeof info["rateLimitType"] === "string" ? info["rateLimitType"] : null;
  if (triggered && !windows.has(triggered)) windows.set(triggered, { utilization: info["utilization"], resetsAt: info["resetsAt"] });
  const observations: LimitObservation[] = [];
  for (const [meter, window] of windows) {
    const utilization = finite(window["utilization"]), resetsAt = finite(window["resetsAt"]);
    if (utilization === null || resetsAt === null) continue;
    observations.push({
      provider: "claude", meter, windowMinutes: impliedWindowMinutes(meter), resetsAt, observedAt,
      usedPercent: utilization * 100, status: meter === triggered ? claudeStatus(info["status"]) : "unknown", source: "claude-sdk-log",
    });
  }
  return observations;
}

/** Claude extra-usage state carried on SDK rate-limit events; reasons are kept only when they are short snake_case enums. */
export function claudeSdkAccount(value: unknown): ClaudeAccountSummary | null {
  const envelope = record(value);
  const event = record(envelope?.["event"]);
  const message = [record(event?.["payload"]), record(envelope?.["payload"]), envelope].find((candidate) => candidate?.["type"] === "rate_limit_event");
  const info = record(message?.["rate_limit_info"]);
  const observedAt = epochSeconds(envelope?.["observedAt"]) ?? epochSeconds(event?.["createdAt"]) ?? epochSeconds(envelope?.["timestamp"]);
  if (!info || observedAt === null || !("overageStatus" in info || "isUsingOverage" in info || "overageEnabled" in info)) return null;
  const reason = typeof info["overageDisabledReason"] === "string" && /^[a-z][a-z0-9_]{0,48}$/.test(info["overageDisabledReason"]) ? info["overageDisabledReason"] : null;
  const extraUsage = info["isUsingOverage"] === true ? "in-use"
    : info["overageEnabled"] === false || info["overageStatus"] === "rejected" ? "disabled"
    : info["overageEnabled"] === true || info["overageStatus"] === "allowed" || info["overageStatus"] === "allowed_warning" ? "enabled" : "unknown";
  return { observedAt, extraUsage, disabledReason: extraUsage === "disabled" ? reason : null };
}

/** Claude Code statusline input: `rate_limits.<window>.used_percentage` (0–100) and `resets_at` (Unix seconds). */
export function statuslineObservations(value: unknown, now: number): LimitObservation[] {
  const limits = record(record(value)?.["rate_limits"]);
  const observations: LimitObservation[] = [];
  for (const [meter, window] of Object.entries(limits ?? {})) {
    const used = finite(record(window)?.["used_percentage"]), resetsAt = finite(record(window)?.["resets_at"]);
    if (used === null || resetsAt === null || resetsAt <= now) continue;
    observations.push({
      provider: "claude", meter, windowMinutes: impliedWindowMinutes(meter), resetsAt, observedAt: Math.floor(now),
      usedPercent: used, status: used >= 100 ? "rejected" : "unknown", source: "claude-statusline",
    });
  }
  return observations;
}

/**
 * Plan tier from Claude Code's local OAuth record. Only `subscriptionType` and `rateLimitTier` are inspected, and only a
 * fixed plan enum leaves this function; the file is never written and no token is read into the result.
 */
export async function claudePlanFrom(paths: string[]): Promise<ClaudePlan | null> {
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 64 * 1024) continue;
      const oauth = record(record(JSON.parse(await readFile(path, "utf8")))?.["claudeAiOauth"]);
      const tier = typeof oauth?.["rateLimitTier"] === "string" ? oauth["rateLimitTier"] : "";
      const type = typeof oauth?.["subscriptionType"] === "string" ? oauth["subscriptionType"] : "";
      const plan = /max_20x/.test(tier) ? "max-20x" : /max_5x/.test(tier) || type === "max" ? "max-5x" : type;
      if ((claudePlans as readonly string[]).includes(plan)) return plan as ClaudePlan;
    } catch { /* Missing or unreadable records leave the plan to the dashboard setting. */ }
  }
  return null;
}

/** Per-process read cursors keyed by file identity: provider files are append-only and rotate by rename, so a
 * later harvest reads only each file's new tail, including after `events.log` becomes `events.log.1`. */
const cursors = new Map<string, number>();
export const resetCursors = (): void => cursors.clear();

const newline = 0x0a;

/** Streams complete lines appended since the last read and decodes only the lines containing `marker`. */
async function scanAppended(path: string, marker: string, visit: (line: string) => void): Promise<boolean> {
  const info = await stat(path);
  if (!info.isFile()) return false;
  const identity = `${info.dev}:${info.ino}`;
  const previous = cursors.get(identity);
  const start = previous !== undefined && previous <= info.size ? previous : 0;
  if (start === info.size) return false;
  const needle = Buffer.from(marker);
  let pending: Buffer[] = [], pendingLength = 0, consumed = 0;
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
  cursors.set(identity, start + consumed);
  return true;
}

async function* files(root: string, accept: (name: string) => boolean, since: number): AsyncGenerator<string> {
  let directory;
  try { directory = await opendir(root); } catch { return; }
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path, accept, since);
    else if (entry.isFile() && accept(entry.name)) {
      try { if ((await stat(path)).mtimeMs / 1000 >= since) yield path; } catch { /* Removed while walking. */ }
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

const parsed = (line: string): unknown => {
  const start = line.indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(start ? line.slice(start) : line); } catch { return null; }
};

export interface HarvestResult {
  observations: LimitObservation[]; available: boolean; codexPlan?: CodexPlan | null; codexPlanAt?: number;
  codexCredits?: { observedAt: number; credits: CodexAccountState["credits"] } | null; claudeAccount?: ClaudeAccountSummary | null;
}

export async function harvestCodex(roots: string[], since: number): Promise<HarvestResult> {
  const result: HarvestResult = { observations: [], available: false, codexPlan: null, codexPlanAt: 0 };
  for (const root of roots) {
    if (!(await exists(root))) continue;
    result.available = true;
    for await (const path of files(root, (name) => name.endsWith(".jsonl"), since)) {
      try {
        await scanAppended(path, "\"rate_limits\"", (line) => {
          const limits = codexLimitRecord(parsed(line));
          if (!limits) return;
          result.observations.push(...limits.observations);
          const at = limits.observations[0]?.observedAt ?? 0;
          if (limits.plan && at >= result.codexPlanAt!) { result.codexPlan = limits.plan; result.codexPlanAt = at; }
          if (limits.credits && at >= (result.codexCredits?.observedAt ?? 0)) result.codexCredits = { observedAt: at, credits: limits.credits };
        });
      } catch { /* An unreadable file is skipped; the next harvest retries it. */ }
    }
  }
  return result;
}

export async function harvestClaudeEventLogs(roots: string[], since: number): Promise<HarvestResult> {
  const result: HarvestResult = { observations: [], available: false };
  for (const root of roots) {
    if (!(await exists(root))) continue;
    result.available = true;
    for await (const path of files(root, (name) => /\.(?:log|jsonl)(?:\.\d+)?$/.test(name), since)) {
      try {
        await scanAppended(path, "\"rate_limit_event\"", (line) => {
          const value = parsed(line);
          result.observations.push(...claudeSdkLimitRecord(value));
          const account = claudeSdkAccount(value);
          if (account && account.observedAt >= (result.claudeAccount?.observedAt ?? 0)) result.claudeAccount = account;
        });
      } catch { /* Rotated away while reading. */ }
    }
  }
  return result;
}
