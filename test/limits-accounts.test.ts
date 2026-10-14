import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { claudeAccountKey, codexAccountKey, readClaudeProfile, weeklyPhaseKey } from "../src/limits/accounts.ts";
import { collectLimits, statuslineAccount } from "../src/limits/index.ts";
import { compactObservations, emptyLedger, readLedger, toRow, writeLedger, type Ledger } from "../src/limits/ledger.ts";
import { claudeSdkEvent, statuslineObservations } from "../src/limits/sources.ts";
import type { LimitObservation, LimitsSnapshot } from "../src/limits/types.ts";
import { profileKeyFor } from "../src/metrics/history-coverage.ts";
import { buildMeters } from "../src/public/subscription-data.js";

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
// Before the files these tests write, so every file counts as modified since the previous harvest unless dated otherwise.
const now = at("2026-10-14T06:00:00Z");
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const session = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
// Weekly resets: account A on Mondays 10:00 UTC, account B (a Team seat) on Fridays 03:00 UTC.
const weekA = at("2026-10-19T10:00:00Z"), weekB = at("2026-10-16T03:00:00Z"), strayWeek = at("2026-10-17T22:00:00Z");

interface Login { org: string; account: string; type: string; orgTier?: string; userTier?: string; seat?: string; extra?: boolean }

/** A Claude profile with a transcript per session (never read) and an `oauthAccount` full of values that must not leak. */
function claudeProfile(home: string, directory: string, login: Login, sessions: string[], configPath = join(home, directory, ".claude.json")): string {
  const projects = join(home, directory, "projects", "-Users-someone-SECRET-repo");
  mkdirSync(projects, { recursive: true });
  for (const id of sessions) writeFileSync(join(projects, `${id}.jsonl`), "{\"message\":\"SECRET transcript\"}\n");
  writeFileSync(configPath, JSON.stringify({
    numStartups: 3, projects: { "/Users/someone/SECRET-repo": { history: [{ display: "SECRET prompt" }] } }, padding: "x".repeat(80 * 1024),
    oauthAccount: {
      accountUuid: login.account, organizationUuid: login.org, emailAddress: "SECRET@example.com", displayName: "SECRET Name", organizationName: "SECRET Org",
      organizationRole: "SECRET role", organizationType: login.type, organizationRateLimitTier: login.orgTier ?? null, userRateLimitTier: login.userTier ?? null,
      seatTier: login.seat ?? null, billingType: "stripe_subscription", hasExtraUsageEnabled: login.extra ?? false,
    },
  }));
  return join(home, directory);
}

function sdkEvent(observedAt: number, sessionId: string | null, windows: Record<string, [number, number]>, info: Record<string, unknown> = {}): string {
  const unifiedWindows = Object.fromEntries(Object.entries(windows).map(([name, [utilization, resetsAt]]) => [name, { utilization, resetsAt }]));
  const payload = { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", unifiedWindows, ...info }, ...(sessionId ? { session_id: sessionId } : {}) };
  return `[${iso(observedAt)}] NATIVE: ${JSON.stringify({ observedAt: iso(observedAt), event: { method: "claude/rate_limit_event", payload } })}\n`;
}

const loginA: Login = { org: "SECRET-ORG-A", account: "SECRET-ACCOUNT-A", type: "claude_max", orgTier: "default_claude_max_20x" };
const loginB: Login = { org: "SECRET-ORG-B", account: "SECRET-ACCOUNT-B", type: "claude_team", orgTier: "default_raven", userTier: "default_claude_max_5x", seat: "team_tier_1", extra: true };

/** Two Claude accounts used side by side, the default profile logged into the same account as `.claude-a`. */
function twoAccounts() {
  const home = mkdtempSync(join(tmpdir(), "limits-accounts-"));
  const logs = join(home, ".t3", "userdata", "logs", "provider");
  mkdirSync(logs, { recursive: true });
  const a = claudeProfile(home, ".claude-a", loginA, [session(1)]);
  claudeProfile(home, ".claude", loginA, [session(2)], join(home, ".claude.json"));
  const b = claudeProfile(home, ".claude-b", loginB, [session(3)]);
  let lines = "";
  for (let hour = 0; hour < 6; hour += 1) {
    const t = now - 6 * 3600 + hour * 3600;
    lines += sdkEvent(t, session(1 + (hour % 2)), { five_hour: [0.1 + hour * 0.05, now + 3600], seven_day: [0.2 + hour * 0.01, weekA] }, { overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false });
    lines += sdkEvent(t + 1800, session(3), { five_hour: [0.4 + hour * 0.05, now - 1800 + 4 * 3600], seven_day: [0.8 + hour * 0.01, weekB] }, { overageStatus: "allowed", isUsingOverage: false });
  }
  // B passes its 5-hour allowance and continues on extra usage: rejected, but not a lockout.
  lines += sdkEvent(now - 600, session(3), { five_hour: [1.18, now - 1800 + 4 * 3600], seven_day: [0.9, weekB] }, { status: "rejected", overageStatus: "allowed", isUsingOverage: true });
  // A session no profile holds: provisional weekly-phase account, merged into A only because its weekly reset is A's.
  lines += sdkEvent(now - 300, session(9), { five_hour: [0.5, now + 3600], seven_day: [0.27, weekA] });
  lines += sdkEvent(now - 200, session(8), { five_hour: [0.05, now + 7200], seven_day: [0.5, strayWeek] });
  writeFileSync(join(logs, "events.thread-SECRET.log"), lines);
  return { home, a, b, logs, dataDir: join(home, "data") };
}

const environmentFor = (home: string): NodeJS.ProcessEnv => ({ HOME: home, SESSION_ANALYTICS_CODEX_ACCOUNT: "0" });
const own = (snapshot: LimitsSnapshot, key: string, meter: string) => snapshot.observations.filter((row) => row.account === key && row.meter === meter);

test("two Claude accounts used side by side stay separate series, each with its own plan, label, weekly anchor and extra usage", async () => {
  const { home, a, b, dataDir } = twoAccounts();
  const snapshot = await collectLimits({ dataDir, codexRoot: join(home, "none") }, environmentFor(home), now);
  const keyA = claudeAccountKey(loginA.org, loginA.account), keyB = claudeAccountKey(loginB.org, loginB.account);
  const claude = snapshot.accounts.filter((account) => account.provider === "claude");
  assert.deepEqual(Object.fromEntries(claude.map((account) => [account.key, [account.attribution, account.plan, account.label.split(" (")[0], account.profileNames]])), {
    [keyA]: ["account", "max-20x", "Claude Max 20x · a", ["default", "a"]],
    [keyB]: ["account", "team", "Claude Team · b", ["b"]],
    [weeklyPhaseKey(strayWeek)]: ["weekly-phase", null, "Claude · unidentified account", []],
  });
  const accountA = claude.find((account) => account.key === keyA)!, accountB = claude.find((account) => account.key === keyB)!;
  assert.deepEqual(accountA.profileKeys.sort(), [profileKeyFor(realpathSync(join(home, ".claude"))), profileKeyFor(realpathSync(a))].sort(), "the same keys as session.historyProfile");
  assert.deepEqual(accountB.profileKeys, [profileKeyFor(realpathSync(b))]);
  assert.deepEqual([accountA.weeklyAnchor, accountB.weeklyAnchor], [weekA, weekB]);
  assert.deepEqual(accountB.planEvidence, { organizationType: "claude_team", organizationRateLimitTier: "default_raven", userRateLimitTier: "default_claude_max_5x", seatTier: "team_tier_1", billingType: "stripe_subscription", planType: null });
  assert.deepEqual([accountA.extraUsage?.extraUsage, accountA.extraUsage?.disabledReason, accountB.extraUsage?.extraUsage], ["disabled", "org_level_disabled", "in-use"]);
  assert.equal(snapshot.plans.claude, "max-20x", "the deprecated plans field follows the most recently active account");

  // Each account's weekly and 5-hour readings form one uninterrupted cycle; no reading crossed over.
  assert.deepEqual([...new Set(own(snapshot, keyA, "seven_day").map((row) => row.resetsAt))], [weekA]);
  assert.deepEqual([...new Set(own(snapshot, keyB, "seven_day").map((row) => row.resetsAt))], [weekB]);
  assert.ok(own(snapshot, keyA, "five_hour").some((row) => row.usedPercent === 50), "the unknown session joined A by its weekly reset");
  for (const key of [keyA, keyB]) {
    const meters = buildMeters(snapshot.observations.filter((row) => row.account === key), now);
    assert.deepEqual(meters.flatMap((meter) => meter.cycles).filter((cycle) => cycle.endedEarly), [], key);
  }
  const overage = own(snapshot, keyB, "five_hour").at(-1)!;
  assert.deepEqual([overage.usedPercent, overage.status], [118, "overage"], "extra usage keeps the reading past 100% and is not a cap");
  assert.deepEqual(own(snapshot, weeklyPhaseKey(strayWeek), "seven_day").map((row) => row.usedPercent), [50], "an unmatched weekly phase is never folded into an account");

  const serialized = JSON.stringify(snapshot) + readFileSync(join(dataDir, "limits-v2.json"), "utf8");
  for (const secret of ["SECRET", "example.com", home, session(1)]) assert.equal(serialized.includes(secret), false, secret);
});

test(".claude.json is read past 64 KB and only allowlisted plan enums, the extra-usage flag and a hash of the ids leave the reader", async () => {
  const home = mkdtempSync(join(tmpdir(), "limits-claude-json-"));
  const directory = claudeProfile(home, ".claude-x", { ...loginB, seat: "SECRET seat", userTier: "default_claude_max_5x" }, []);
  const profile = await readClaudeProfile({ directory, isDefault: false }, home);
  assert.equal(profile.key, claudeAccountKey(loginB.org, loginB.account));
  assert.match(profile.key!, /^claude-[0-9a-f]{16}$/);
  assert.deepEqual([profile.plan, profile.planSource, profile.planEvidence?.seatTier, profile.extraUsageEnabled], ["team", "claude-config", null, true], "a Team seat with a Max-like user tier is Team");
  assert.equal(JSON.stringify(profile).includes("SECRET"), false);

  writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_5x", accountUuid: "u", organizationUuid: "o" } }));
  assert.equal((await readClaudeProfile({ directory, isDefault: false }, home)).plan, "max-5x");
  writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { organizationType: "claude_pro" } }));
  assert.deepEqual(Object.values(await readClaudeProfile({ directory, isDefault: false }, home)).slice(0, 2), [null, "pro"], "no ids: no account key");
});

test("status-line readings belong to the account of their CLAUDE_CONFIG_DIR, transcript or session", async () => {
  const { home, b } = twoAccounts();
  const keyA = claudeAccountKey(loginA.org, loginA.account), keyB = claudeAccountKey(loginB.org, loginB.account);
  const base = { HOME: home };
  assert.equal(await statuslineAccount({ session_id: session(1) }, { ...base, CLAUDE_CONFIG_DIR: b }), keyB, "the inherited config directory wins");
  assert.equal(await statuslineAccount({ transcript_path: join(b, "projects", "-repo", `${session(7)}.jsonl`) }, base), keyB);
  assert.equal(await statuslineAccount({ session_id: session(1) }, base), keyA);
  assert.equal(await statuslineAccount({ session_id: session(2) }, base), keyA, "the default profile shares A's login");
  assert.equal(await statuslineAccount({ session_id: session(9), rate_limits: { seven_day: { used_percentage: 3, resets_at: weekB } } }, base), weeklyPhaseKey(weekB));
  assert.equal(await statuslineAccount({}, base), "");
  const observations = statuslineObservations({ rate_limits: { five_hour: { used_percentage: 104, resets_at: now + 600 } } }, now, keyB);
  assert.deepEqual(observations.map((row) => [row.account, row.status]), [[keyB, "overage"]], "only a reading past 100% proves extra usage");
});

test("Claude rejected-while-on-extra-usage is overage; rejected without it is a cap", () => {
  const event = (info: Record<string, unknown>) => claudeSdkEvent(JSON.parse(sdkEvent(now, session(1), { five_hour: [1.25, now + 600] }, info).replace(/^[^{]*/, "")))!;
  assert.deepEqual(event({ status: "rejected", isUsingOverage: true }).observations.map((row) => [row.usedPercent, row.status]), [[125, "overage"]]);
  assert.deepEqual(event({ status: "rejected", overageInUse: true }).observations.map((row) => row.status), ["overage"]);
  assert.deepEqual(event({ status: "rejected", overageStatus: "rejected" }).observations.map((row) => row.status), ["rejected"]);
  assert.equal(event({}).sessionId, session(1));
});

const codexReading = (observedAt: number, resetsAt: number, usedPercent: number, meter = "seven_day", account = "codex-0123456789abcdef"): LimitObservation =>
  ({ provider: "codex", account, meter, windowMinutes: meter.endsWith("five_hour") ? 300 : 10_080, resetsAt, observedAt, usedPercent, status: "allowed", source: "codex-session" });

test("Codex windows that have not started are one idle marker, superseded by the first started window", () => {
  const window = 10_080 * 60, t = now - 3 * 86_400;
  const rolling = [0, 60, 125, 190].map((offset) => codexReading(t + offset, t + offset + window + 2, 0));
  const idle = compactObservations(rolling, now);
  assert.deepEqual(idle.map((row) => [row.observedAt, row.status]), [[t + 190, "idle"]], "rolling 0% readings never chain into a cycle");

  const started = [codexReading(t + 3600, t + 3600 + window, 0), codexReading(t + 4800, t + 3600 + window + 1, 3)];
  const rows = compactObservations([...rolling, ...started], now);
  assert.deepEqual(rows.map((row) => [row.observedAt, row.usedPercent, row.status]), [[t + 3600, 0, "allowed"], [t + 4800, 3, "allowed"]]);
  assert.equal(new Set(rows.map((row) => row.resetsAt)).size, 1);
  const claude = compactObservations(rolling.map((row) => ({ ...row, provider: "claude" as const, account: "", source: "claude-sdk-log" as const })), now);
  assert.equal(claude.filter((row) => row.status === "idle").length, 0, "only Codex slides an unstarted window");
});

test("reset instants within two minutes are one cycle, snapped to the busiest instant without chaining", () => {
  const reset = now + 2 * 86_400;
  const rows = compactObservations([
    codexReading(now - 7200, reset, 10), codexReading(now - 3600, reset + 31, 11), codexReading(now - 2400, reset + 31, 12),
    codexReading(now - 1200, reset + 100, 13), codexReading(now - 600, reset + 220, 14), codexReading(now - 300, reset + 400, 2),
  ], now);
  assert.deepEqual(rows.map((row) => [row.usedPercent, row.resetsAt - reset]), [[10, 31], [11, 31], [12, 31], [13, 31], [14, 220], [2, 400]]);
});

test("a Codex cycle nested inside a busier cycle of the same account came from another limit context and is unattributed", () => {
  const busy = [0, 2, 4, 6, 8].map((hour) => codexReading(now - 10 * 3600 + hour * 3600, now + 3 * 86_400, 30 + hour));
  const nested = [codexReading(now - 5 * 3600, now + 5 * 86_400, 70), codexReading(now - 5 * 3600 + 60, now + 5 * 86_400, 70)];
  const rows = compactObservations([...busy, ...nested], now);
  assert.deepEqual([...new Set(rows.filter((row) => row.usedPercent === 70).map((row) => row.account))], [""]);
  assert.equal(rows.filter((row) => row.account !== "").length, 5);
});

test("overlapping harvests in one process are serialized and neither erases the other's readings", async () => {
  const { home, logs, dataDir } = twoAccounts();
  const options = { dataDir, codexRoot: join(home, "none") };
  const [first, second] = await Promise.all([collectLimits(options, environmentFor(home), now), collectLimits(options, environmentFor(home), now + 1)]);
  assert.ok(first.observations.length > 0);
  assert.equal(second.observations.length, first.observations.length, "the second harvest read nothing new and still sees everything");
  const log = join(logs, "events.thread-SECRET.log");
  writeFileSync(log, sdkEvent(now + 60, session(3), { five_hour: [0.2, now + 4 * 3600], seven_day: [0.91, weekB] }), { flag: "a" });
  utimesSync(log, now + 100, now + 100);
  const third = await collectLimits(options, environmentFor(home), now + 120);
  assert.equal(third.sources.find((source) => source.source === "claude-sdk-log")?.read, 2);
  assert.equal(third.observations.length, first.observations.length + 2);
});

test("every write merges with the ledger on disk, so a concurrent writer's rows, cursors and accounts survive", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "limits-merge-"));
  const row = (usedPercent: number, observedAt: number) => toRow(codexReading(observedAt, now + 86_400, usedPercent));
  const cron: Ledger = { ...emptyLedger(), harvestedThrough: now - 60, rows: [row(40, now - 3600)], cursors: { "1:2": { offset: 900, fingerprint: "0123456789abcdef", seen: now } } };
  const dashboard: Ledger = { ...emptyLedger(), harvestedThrough: now - 120, rows: [row(45, now - 1200)], cursors: { "1:2": { offset: 400, fingerprint: "fedcba9876543210", seen: now } } };
  writeLedger(dataDir, cron, now);
  const merged = writeLedger(dataDir, dashboard, now);
  assert.deepEqual(merged.rows.map((item) => item[6]), [40, 45]);
  assert.deepEqual([merged.harvestedThrough, merged.cursors["1:2"]?.offset], [now - 60, 900]);
  assert.deepEqual(readLedger(dataDir, now).ledger?.rows, merged.rows);
});

test("a ledger this version cannot read is never overwritten; an unparseable one is set aside", async () => {
  const home = mkdtempSync(join(tmpdir(), "limits-unreadable-"));
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const path = join(dataDir, "limits-v2.json");
  const future = JSON.stringify({ version: 3, rows: [["claude", "x", "five_hour"]] });
  writeFileSync(path, future, { mode: 0o600 });
  const options = { dataDir, codexRoot: join(home, "none") };
  const environment = { ...environmentFor(home), SESSION_ANALYTICS_CLAUDE_EVENT_LOGS: join(home, "none") };
  const snapshot = await collectLimits(options, environment, now);
  assert.deepEqual([snapshot.ledger, snapshot.persisted], ["unreadable", false]);
  assert.equal(readFileSync(path, "utf8"), future);
  assert.throws(() => writeLedger(dataDir, emptyLedger(), now), /left untouched/);
  assert.equal(readFileSync(path, "utf8"), future);

  writeFileSync(path, "{\"version\":2,\"rows\":[", { mode: 0o600 });
  const recovered = await collectLimits(options, environment, now);
  assert.deepEqual([recovered.ledger, recovered.persisted], ["ok", true]);
  assert.deepEqual(readdirSync(dataDir).filter((name) => name.includes("unreadable")), [`limits-v2.json.unreadable-${now}`]);
});

test("version 1 history is imported once, attributed by weekly phase, majority and the sole Codex account, and never written", async () => {
  const { home, dataDir } = twoAccounts();
  mkdirSync(dataDir, { mode: 0o700 });
  const keyA = claudeAccountKey(loginA.org, loginA.account), keyB = claudeAccountKey(loginB.org, loginB.account);
  const codexHome = join(home, ".codex", "sessions", "2026", "10", "14");
  mkdirSync(codexHome, { recursive: true });
  const creator = "SECRET-CHATGPT-ACCOUNT";
  writeFileSync(join(codexHome, "rollout-SECRET.jsonl"), [
    { type: "session_meta", payload: { id: "SECRET", creator_account_id: creator } },
    { timestamp: iso(now - 3600), type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", plan_type: "pro", primary: { used_percent: 20, window_minutes: 10_080, resets_at: now + 4 * 86_400 } } } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const lastWeekA = weekA - 7 * 86_400, lastWeekB = weekB - 7 * 86_400, t1 = lastWeekA - 2 * 86_400, t2 = lastWeekB - 86_400;
  const v1Row = (provider: string, meter: string, resetsAt: number, observedAt: number, used: number) =>
    [provider, meter, meter === "five_hour" ? 300 : 10_080, resetsAt, observedAt, used, "unknown", provider === "codex" ? "codex-session" : "claude-sdk-log"];
  const legacy = JSON.stringify({ version: 1, harvestedThrough: now - 86_400, plans: { claude: null, codex: "pro" }, rows: [
    v1Row("claude", "seven_day", lastWeekA, t1, 50), v1Row("claude", "five_hour", t1 + 3600, t1, 20), v1Row("claude", "five_hour", t1 + 3600, t1 + 900, 30),
    v1Row("claude", "seven_day", lastWeekB, t2, 60), v1Row("claude", "seven_day_opus", lastWeekB, t2, 10),
    v1Row("claude", "seven_day", at("2026-10-10T12:00:00Z"), t2, 5), v1Row("codex", "seven_day", now - 86_400, now - 3 * 86_400, 77),
  ], resetCreditHistory: [["codex", now - 5 * 86_400, 2]] });
  writeFileSync(join(dataDir, "limits.json"), legacy, { mode: 0o600 });

  const snapshot = await collectLimits({ dataDir }, environmentFor(home), now);
  const codexKey = codexAccountKey(creator);
  const imported = (observedAt: number, meter: string) => snapshot.observations.filter((row) => row.observedAt === observedAt && row.meter === meter).map((row) => row.account);
  assert.deepEqual(imported(t1, "seven_day"), [keyA]);
  assert.deepEqual(imported(t1, "five_hour"), [keyA]);
  assert.deepEqual(imported(t1 + 900, "five_hour"), [keyA], "a 5-hour cycle follows the weekly readings taken with it");
  assert.deepEqual([imported(t2, "seven_day").sort(), imported(t2, "seven_day_opus")], [["", keyB].sort(), [keyB]], "an unknown weekly phase stays unattributed");
  assert.deepEqual(imported(now - 3 * 86_400, "seven_day"), [codexKey]);
  assert.deepEqual(snapshot.resetCreditHistory, [["codex", codexKey, now - 5 * 86_400, 2]]);
  assert.equal(snapshot.accounts.find((account) => account.key === "")?.label, "Unattributed history");
  assert.equal(readFileSync(join(dataDir, "limits.json"), "utf8"), legacy, "the version 1 ledger is only read");
  assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);

  const again = await collectLimits({ dataDir }, environmentFor(home), now + 60);
  assert.equal(again.observations.length, snapshot.observations.length, "the import is idempotent");
  const value = JSON.parse(legacy);
  value.rows.push(v1Row("claude", "seven_day", weekB, now + 30, 93));
  writeFileSync(join(dataDir, "limits.json"), JSON.stringify(value));
  const later = await collectLimits({ dataDir }, environmentFor(home), now + 120);
  assert.deepEqual(later.observations.filter((row) => row.observedAt === now + 30).map((row) => row.account), [keyB], "rows an older binary adds later are imported too");
});

test("Codex rollouts are attributed to their creating account; scoped meters carry the provider's limit name and retire", async () => {
  const home = mkdtempSync(join(tmpdir(), "limits-codex-"));
  const sessions = join(home, ".codex", "sessions", "2026", "10");
  mkdirSync(sessions, { recursive: true });
  const line = (observedAt: number, limits: Record<string, unknown>) => JSON.stringify({ timestamp: iso(observedAt), type: "event_msg", payload: { type: "token_count", rate_limits: limits } });
  writeFileSync(join(sessions, "rollout-a.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { creator_account_id: "SECRET-ACCOUNT" } }),
    line(now - 9 * 86_400, { limit_id: "codex_bengalfox", limit_name: "GPT-5.3-Codex-Spark", plan_type: "pro", primary: { used_percent: 4, window_minutes: 10_080, resets_at: now - 3 * 86_400 } }),
    line(now - 9 * 86_400, { limit_id: "other_scope", limit_name: "<script>", plan_type: "pro", primary: { used_percent: 5, window_minutes: 300, resets_at: now - 9 * 86_400 + 3600 } }),
  ].join("\n") + "\n");
  writeFileSync(join(sessions, "rollout-b.jsonl"), `${line(now - 600, { limit_id: "codex", plan_type: "pro", primary: { used_percent: 30, window_minutes: 10_080, resets_at: now + 3 * 86_400 } })}\n`);
  const snapshot = await collectLimits({ dataDir: join(home, "data") }, environmentFor(home), now);
  const key = codexAccountKey("SECRET-ACCOUNT");
  assert.deepEqual(snapshot.accounts.map((account) => [account.key, account.plan, account.label]), [[key, "pro", "ChatGPT Pro 200 · default"]], "a rollout without a creator joins its home's only account");
  assert.deepEqual(snapshot.meters.map((meter) => [meter.meter, meter.label, meter.retired]), [
    ["codex_bengalfox.seven_day", "GPT-5.3-Codex-Spark · Weekly", true],
    ["other_scope.five_hour", "Model-scoped limit · 5-hour window", true],
    ["seven_day", "Weekly · all models", false],
  ]);
  assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);
});

// Root reads a mode-000 file, so the unreadable case cannot be staged there.
test("cursors persist with a fingerprint: rewritten files are re-read, unreadable files are retried without being modified", { skip: process.getuid?.() === 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "limits-cursors-"));
  const logs = join(home, "logs");
  mkdirSync(logs);
  const log = join(logs, "events.log"), locked = join(logs, "events.locked.log");
  const options = { dataDir: join(home, "data"), codexRoot: join(home, "none") };
  const environment = { ...environmentFor(home), SESSION_ANALYTICS_CLAUDE_EVENT_LOGS: logs };
  const read = (snapshot: LimitsSnapshot) => snapshot.sources.find((source) => source.source === "claude-sdk-log")?.read;
  writeFileSync(log, sdkEvent(now - 600, null, { five_hour: [0.31, now + 3600] }));
  writeFileSync(locked, sdkEvent(now - 500, null, { five_hour: [0.6, now + 7200] }));
  chmodSync(locked, 0o000);
  assert.equal(read(await collectLimits(options, environment, now)), 1);
  assert.equal(read(await collectLimits(options, environment, now + 60)), 0, "the cursor resumes at the end");

  writeFileSync(log, sdkEvent(now - 2000, null, { five_hour: [0.32, now + 3600] }));
  utimesSync(log, now + 100, now + 100);
  chmodSync(locked, 0o600);
  utimesSync(locked, now - 86_400, now - 86_400);
  const later = await collectLimits(options, environment, now + 120);
  assert.equal(read(later), 2, "same size, different bytes: read again; the file that failed is retried though unchanged");
  assert.deepEqual(later.observations.map((row) => row.usedPercent).sort(), [31, 32, 60]);
});

test("readings kept under a profile's fallback key join its account once the login is known, and stay joined across merges", async () => {
  const home = mkdtempSync(join(tmpdir(), "limits-alias-"));
  const logs = join(home, "logs");
  mkdirSync(logs);
  const profile = claudeProfile(home, ".claude-new", loginA, [session(1)]);
  writeFileSync(join(profile, ".claude.json"), JSON.stringify({ numStartups: 1 }));
  writeFileSync(join(logs, "events.log"), sdkEvent(now - 3600, session(1), { five_hour: [0.2, now + 3600], seven_day: [0.3, weekA] }));
  const options = { dataDir: join(home, "data"), codexRoot: join(home, "none") };
  const environment = { ...environmentFor(home), SESSION_ANALYTICS_CLAUDE_EVENT_LOGS: logs };
  const before = await collectLimits(options, environment, now);
  const fallback = before.accounts.find((account) => account.provider === "claude")!;
  assert.equal(fallback.attribution, "profile");
  const stale = readLedger(options.dataDir, now).ledger!;

  claudeProfile(home, ".claude-new", loginA, [session(1)]);
  const after = await collectLimits(options, environment, now + 60);
  const key = claudeAccountKey(loginA.org, loginA.account);
  assert.deepEqual([...new Set(after.observations.map((row) => row.account))], [key]);
  // A process still holding the old ledger writes it back: its rows are re-keyed, not resurrected.
  const merged = writeLedger(options.dataDir, stale, now + 120);
  assert.deepEqual([...new Set(merged.rows.map((row) => row[1]))], [key]);
  assert.deepEqual(Object.keys(merged.accounts), [key]);
});
