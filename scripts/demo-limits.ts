import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { codexAccountKey } from "../src/limits/accounts.ts";
import { emptyLedger, writeLedger } from "../src/limits/ledger.ts";

/**
 * Synthetic subscription limits for the demo, for the setup the Subscription view is built around: two Claude logins in
 * two profiles (a Team seat that resets on Fridays and runs short, a Max 20x plan that resets on Mondays with one
 * in-place reset) and one ChatGPT Pro account with a banked reset. Meter levels follow the demo's own synthetic activity,
 * so value per 1% calibrates. Every identifier and value here is synthetic.
 */

const HOUR = 3600, DAY = 86_400, WEEK = 7 * DAY;
/** Weekly reset anchors (UTC): Fridays 03:00 for the Team seat, Mondays 10:00 for Max. */
const teamAnchor = Date.parse("2026-01-02T03:00:00Z") / 1000, maxAnchor = Date.parse("2026-01-05T10:00:00Z") / 1000;
export const demoCodexAccount = "synthetic-demo-chatgpt-account";
export const workRepositories = new Set(["acme-web", "billing-api", "mobile-app"]);
/** Sessions on this model report a model-specific weekly limit instead of the account-wide one. */
const scopedModel = "gpt-5.6-terra";

export interface Activity { t: number; work: number }
export interface ClaudeDemoSession { profile: "default" | "work"; sessionId: string; activity: Activity[] }
export interface CodexRecord { timestamp: string; type: string; payload: Record<string, unknown> }
export interface CodexDemoFile { path: string; model: string; records: CodexRecord[] }

const claudeRate = (model: string): number => model.includes("opus") ? 5 : model.includes("haiku") ? 1 : 3;
/** A rough API-value proxy (dollars) for one Claude message, enough to make the synthetic meters move with the work. */
export function claudeWork(model: string, usage: Record<string, number>): number {
  return claudeRate(model) * ((usage["input_tokens"] ?? 0) + 1.25 * (usage["cache_creation_input_tokens"] ?? 0) + 0.1 * (usage["cache_read_input_tokens"] ?? 0) + 5 * (usage["output_tokens"] ?? 0)) / 1e6;
}
const codexWork = (usage: Record<string, number>): number =>
  1.25 * ((usage["input_tokens"] ?? 0) - (usage["cached_input_tokens"] ?? 0) + 0.1 * (usage["cached_input_tokens"] ?? 0) + 8 * (usage["output_tokens"] ?? 0)) / 1e6;

const nextReset = (anchor: number, t: number): number => anchor + (Math.floor((t - anchor) / WEEK) + 1) * WEEK;
const median = (values: number[]): number => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; };
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** Average work of the complete cycles in `[from, to]`, keyed by reset. */
function typicalWeek(events: Array<Activity & { reset: number }>, from: number, to: number): number {
  const totals = new Map<number, number>();
  for (const event of events) if (event.reset - WEEK >= from && event.reset <= to) totals.set(event.reset, (totals.get(event.reset) ?? 0) + event.work);
  const values = [...totals.values()];
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 1;
}

interface Reading { t: number; sessionId: string; weekly: number; weeklyReset: number; session: number; sessionReset: number }

/** One Claude account's readings: weekly levels per cycle (restarting at an in-place reset), 5-hour windows, one capped window. */
function claudeReadings(sessions: ClaudeDemoSession[], anchor: number, close: number, now: number, options: { inPlace?: boolean; capWindow?: boolean }): Reading[] {
  const events = sessions.flatMap((session) => session.activity.map((item) => ({ ...item, sessionId: session.sessionId, reset: nextReset(anchor, item.t) })))
    .filter((event) => event.t <= now).sort((left, right) => left.t - right.t);
  if (!events.length) return [];
  const full = typicalWeek(events, events[0]!.t, now) / close;
  // In-place reset: in the gap after the meter passes 10%, early enough that readings follow; this week if possible.
  let restart: number | null = null;
  if (options.inPlace) {
    for (const reset of [nextReset(anchor, now), nextReset(anchor, now) - WEEK]) {
      const cycle = events.filter((event) => event.reset === reset);
      let level = 0;
      for (let index = 0; index + 4 < cycle.length && restart === null; index += 1) {
        level += cycle[index]!.work / full * 100;
        const gap = cycle[index + 1]!.t - cycle[index]!.t;
        if (level >= 10 && gap >= 20 * 60 && cycle[index + 1]!.t < now - 3 * HOUR) restart = (cycle[index]!.t + cycle[index + 1]!.t) / 2;
      }
      if (restart !== null) break;
    }
  }
  // 5-hour windows open with the first message after the previous window ends.
  const windows: Array<{ start: number; end: number; work: number }> = [];
  const windowOf = events.map((event) => {
    let window = windows.at(-1);
    if (!window || event.t >= window.end) { window = { start: event.t, end: event.t + 5 * HOUR, work: 0 }; windows.push(window); }
    window.work += event.work;
    return window;
  });
  const sessionFull = Math.max(1.6 * median(windows.map((window) => window.work)), 1e-9);
  // One recent, complete window runs into the 5-hour limit (at 70% of its work) and stays locked out to its end.
  const capped = options.capWindow ? windows.filter((window) => window.start >= now - 3 * DAY && window.end <= now - HOUR).sort((left, right) => right.work - left.work)[0] ?? null : null;
  const readings: Reading[] = [];
  let weekly = 0, cycle = 0, lastEmitted = -Infinity;
  const spent = new Map<object, number>();
  events.forEach((event, index) => {
    if (event.reset !== cycle) { cycle = event.reset; weekly = 0; }
    if (restart !== null && index > 0 && event.t > restart && events[index - 1]!.t < restart) weekly = 0;
    weekly += event.work / full * 100;
    const window = windowOf[index]!;
    const used = (spent.get(window) ?? 0) + event.work; spent.set(window, used);
    const level = window === capped ? Math.min(100, used / (0.7 * window.work) * 100) : Math.min(97, used / sessionFull * 100);
    const next = events[index + 1];
    // Hosts log an event per request; one every 10 minutes and the last of each session are plenty.
    if (event.t - lastEmitted < 600 && next && next.sessionId === event.sessionId) return;
    lastEmitted = event.t;
    readings.push({ t: event.t, sessionId: event.sessionId, weekly: Math.min(100, weekly), weeklyReset: event.reset, session: level, sessionReset: window.end });
  });
  // A request a few minutes ago, so the meters are fresh whenever the demo starts; it opens a 5-hour window if none is open.
  const last = readings.at(-1)!, fresh = now - 8 * 60, open = windows.at(-1)!.end > fresh;
  readings.push({ ...last, t: fresh, weeklyReset: nextReset(anchor, fresh), weekly: nextReset(anchor, fresh) === last.weeklyReset ? last.weekly : 0,
    session: open ? last.session : 1, sessionReset: open ? last.sessionReset : fresh + 5 * HOUR });
  return readings;
}

/** A T3 Code provider log line: a Claude Agent SDK `rate_limit_event` in T3's envelope. */
function sdkEventLine(reading: Reading, overage: Record<string, unknown>): string {
  const unifiedWindows = { five_hour: { utilization: reading.session / 100, resetsAt: reading.sessionReset }, seven_day: { utilization: reading.weekly / 100, resetsAt: reading.weeklyReset } };
  const binding = reading.session > reading.weekly ? "five_hour" : "seven_day";
  const level = Math.max(reading.session, reading.weekly);
  const payload = {
    type: "rate_limit_event", session_id: reading.sessionId,
    rate_limit_info: { status: level >= 100 ? "rejected" : level >= 80 ? "allowed_warning" : "allowed", rateLimitType: binding, unifiedWindows, isUsingOverage: false, ...overage },
  };
  return `[${iso(reading.t)}] NATIVE: ${JSON.stringify({ observedAt: iso(reading.t), event: { method: "claude/rate_limit_event", payload } })}\n`;
}

/** Codex cycles around one redeemed banked reset: the redemption restarts the week, and later resets follow it. */
function codexCycles(times: number[], now: number) {
  // The redemption lands on a reading with another reading shortly before it, so the level it gave back was observed.
  const redeemed = times.find((t, index) => t >= now - 13.5 * DAY && t <= now - 8 * DAY && index > 0 && t - times[index - 1]! < 6 * HOUR) ?? now - 12 * DAY;
  const scheduled = redeemed + 2 * DAY + 9 * HOUR;
  return {
    redeemed,
    of(t: number): { start: number; reset: number } {
      if (t >= redeemed) { const reset = nextReset(redeemed, t); return { start: reset - WEEK, reset }; }
      const reset = t >= scheduled - WEEK ? scheduled : nextReset(scheduled, t);
      return { start: reset - WEEK, reset };
    },
  };
}

/** Adds `rate_limits` to every Codex `token_count` record; returns when the banked reset was redeemed. */
function codexLimits(files: CodexDemoFile[], now: number): number {
  const events = files.flatMap((file) => file.records.filter((record) => record.payload["type"] === "token_count").map((record) => ({
    record, scoped: file.model === scopedModel, t: Date.parse(record.timestamp) / 1000,
    work: codexWork(((record.payload["info"] as Record<string, unknown>)["last_token_usage"] ?? {}) as Record<string, number>),
  }))).filter((event) => event.t <= now).sort((left, right) => left.t - right.t);
  const cycles = codexCycles(events.map((event) => event.t), now);
  const tagged = events.map((event) => ({ ...event, ...cycles.of(event.t) }));
  const typical = (scoped: boolean) => typicalWeek(tagged.filter((event) => event.scoped === scoped), tagged[0]?.t ?? now, now);
  const full = { main: typical(false) / 0.65, scoped: typical(true) / 0.3 };
  // The redeemed week reached 96% just before the banked reset restarted it.
  const beforeRedemption = new Set(tagged.filter((event) => !event.scoped && event.t < cycles.redeemed && event.reset === cycles.of(cycles.redeemed - 1).reset));
  const redeemedWork = [...beforeRedemption].reduce((total, event) => total + event.work, 0);
  const levels = new Map<string, number>();
  for (const event of tagged) {
    const key = `${event.scoped}|${event.reset}`;
    const level = (levels.get(key) ?? 0) + event.work;
    levels.set(key, level);
    const used = beforeRedemption.has(event) ? level / redeemedWork * 96 : level / (event.scoped ? full.scoped : full.main) * 100;
    event.record.payload["rate_limits"] = {
      limit_id: event.scoped ? "codex_terra" : "codex", limit_name: event.scoped ? "GPT-5.6-Terra" : null,
      primary: { used_percent: Math.round(Math.min(100, used) * 10) / 10, window_minutes: 10_080, resets_at: event.reset }, secondary: null,
      credits: { has_credits: true, unlimited: false, balance: "1250" }, plan_type: "pro", rate_limit_reached_type: used >= 100 ? "primary" : null,
    };
  }
  return cycles.redeemed;
}

/**
 * Writes the demo's limit sources: each Claude profile's `.claude.json` (synthetic `oauthAccount` enums and IDs only),
 * T3-style Agent SDK event logs under the synthetic home, `rate_limits` on the Codex rollouts (written by the caller), and
 * a ledger holding one earlier Codex account read with a banked reset, because the demo never starts a Codex app-server.
 */
export function seedLimitsDemo({ home, profiles, dataDir, claude, codex, now }: {
  home: string; profiles: Record<"default" | "work", string>; dataDir: string; claude: ClaudeDemoSession[]; codex: CodexDemoFile[]; now: number;
}): string {
  const login = (organization: string, account: string, type: string, extra: Record<string, unknown>) => ({
    oauthAccount: { accountUuid: `synthetic-demo-${account}`, organizationUuid: `synthetic-demo-${organization}`, organizationType: type, billingType: "stripe_subscription", ...extra },
  });
  writeFileSync(join(home, ".claude.json"), JSON.stringify(login("personal", "personal", "claude_max", { organizationRateLimitTier: "default_claude_max_20x", hasExtraUsageEnabled: true })));
  writeFileSync(join(profiles.work, ".claude.json"), JSON.stringify(login("acme", "work", "claude_team", {
    organizationRateLimitTier: "default_raven", userRateLimitTier: "default_claude_max_5x", seatTier: "team_tier_1", hasExtraUsageEnabled: false,
  })));
  const logs = join(home, ".t3", "userdata", "logs", "provider");
  mkdirSync(logs, { recursive: true });
  const accounts = [
    { profile: "work" as const, anchor: teamAnchor, close: 1.0, options: { capWindow: true }, overage: { overageStatus: "rejected", overageDisabledReason: "org_level_disabled" } },
    { profile: "default" as const, anchor: maxAnchor, close: 0.45, options: { inPlace: true }, overage: { overageStatus: "allowed" } },
  ];
  for (const account of accounts) {
    const readings = claudeReadings(claude.filter((session) => session.profile === account.profile), account.anchor, account.close, now, account.options);
    const threads = new Map<string, string>();
    for (const reading of readings) threads.set(reading.sessionId, (threads.get(reading.sessionId) ?? "") + sdkEventLine(reading, account.overage));
    for (const [sessionId, lines] of threads) writeFileSync(join(logs, `events.thread-${sessionId.slice(0, 8)}.log`), lines, { flag: "a" });
  }
  const redeemed = codexLimits(codex, now);
  const key = codexAccountKey(demoCodexAccount);
  writeLedger(dataDir, {
    ...emptyLedger(),
    accounts: { [key]: {
      provider: "codex", plan: "pro", planSource: "codex-account", planObservedAt: Math.floor(now - HOUR), extraUsage: null, profileKeys: [],
      planEvidence: { organizationType: null, organizationRateLimitTier: null, userRateLimitTier: null, seatTier: null, billingType: null, planType: "pro" },
      codex: { observedAt: Math.floor(now - HOUR), credits: { hasCredits: true, unlimited: false, balance: 1250 }, ordinaryUsageAllowed: true,
        resetCredits: { available: 1, credits: [{ status: "available", scope: "all", grantedAt: Math.floor(now - 7 * DAY), expiresAt: Math.floor(now + 23 * DAY) }] } },
    } },
    resetCreditHistory: [["codex", key, Math.floor(redeemed - 2 * HOUR), 2], ["codex", key, Math.floor(redeemed + 10 * 60), 1]],
  }, now);
  return logs;
}
