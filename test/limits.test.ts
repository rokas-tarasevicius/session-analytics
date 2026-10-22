import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readClaudeProfile } from "../src/limits/accounts.ts";
import { collectLimits } from "../src/limits/index.ts";
import { compactObservations, emptyLedger, ledgerName, readLedger, toRow, writeLedger } from "../src/limits/ledger.ts";
import { codexAccountState } from "../src/limits/codex-account.ts";
import { claudeSdkAccount, claudeSdkLimitRecord, codexLimitRecord, statuslineObservations } from "../src/limits/sources.ts";
import type { LimitObservation, LimitsSnapshot } from "../src/limits/types.ts";

const root = new URL("..", import.meta.url).pathname;
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const now = at("2026-10-13T21:00:00Z");

function codexLine(timestamp: string, limits: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: limits } });
}

function sdkLine(observedAt: string, info: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `[${observedAt}] NATIVE: ${JSON.stringify({ observedAt, event: { method: "claude/rate_limit_event", payload: { type: "rate_limit_event", rate_limit_info: info, session_id: "SECRET-SESSION" }, ...extra } })}`;
}

test("Codex rate_limits windows are named by length, scoped by limit id, and carry the plan", () => {
  const weekly = codexLimitRecord(JSON.parse(codexLine("2026-10-13T20:00:00Z", {
    limit_id: "codex", primary: { used_percent: 84, window_minutes: 10080, resets_at: 1792472345 }, secondary: null, plan_type: "pro",
  })));
  assert.equal(weekly?.plan, "pro");
  assert.deepEqual(weekly?.observations.map((item) => [item.meter, item.windowMinutes, item.usedPercent, item.status]), [["seven_day", 10080, 84, "allowed"]]);

  const both = codexLimitRecord(JSON.parse(codexLine("2026-10-13T20:00:00Z", {
    limit_id: "codex_spark", primary: { used_percent: 100, window_minutes: 300, resets_in_seconds: 600 },
    secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1792472345 }, rate_limit_reached_type: "primary", plan_type: "/etc/passwd",
  })));
  assert.equal(both?.plan, null, "unknown plan types are dropped");
  assert.deepEqual(both?.observations.map((item) => [item.meter, item.status, item.resetsAt]), [
    ["codex_spark.five_hour", "rejected", at("2026-10-13T20:00:00Z") + 600],
    ["codex_spark.seven_day", "allowed", 1792472345],
  ]);
  assert.equal(codexLimitRecord({ type: "event_msg", payload: { type: "agent_message", rate_limits: {} } }), null);
});

test("Claude SDK events expand every unified window; the triggering window keeps the status", () => {
  const observations = claudeSdkLimitRecord(JSON.parse(sdkLine("2026-10-13T12:14:00Z", {
    status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: 1791901200,
    unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1791901200 }, seven_day: { utilization: 0.59, resetsAt: 1792404000 } },
  }).replace(/^[^{]*/, "")));
  assert.deepEqual(observations.map((item) => [item.meter, item.windowMinutes, item.usedPercent, item.status]), [
    ["five_hour", 300, 100, "rejected"], ["seven_day", 10080, 59, "unknown"],
  ]);
  // Transcript text that merely mentions the event is not an event.
  assert.deepEqual(claudeSdkLimitRecord({ observedAt: "2026-10-13T12:14:00Z", event: { payload: { type: "user", message: { content: "\"type\":\"rate_limit_event\"" } } } }), []);
});

test("malformed limit levels and reset units cannot widen the ledger or leak source content", () => {
  const observedAt = new Date(now * 1000).toISOString();
  const parse = (used: unknown, reset: unknown) => codexLimitRecord({
    timestamp: observedAt, type: "event_msg", payload: { type: "token_count", rate_limits: {
      primary: { used_percent: used, window_minutes: 300, resets_at: reset }, plan_type: "pro", message: "SECRET login@example.com /private/path",
    } },
  })!;
  for (const used of [null, "75", NaN, Infinity, -Infinity]) assert.deepEqual(parse(used, now + 600).observations, []);
  for (const reset of [null, undefined, "1792000000", (now + 600) * 1000, 5_000_000_000]) {
    assert.deepEqual(compactObservations(parse(20, reset).observations, now), [], `invalid reset ${reset}`);
  }
  for (const [used, expected] of [[-1, 0], [125, 125], [2000, 1000]]) {
    const kept = compactObservations(parse(used, now + 600).observations, now);
    assert.equal(kept[0]!.usedPercent, expected);
    assert.doesNotMatch(JSON.stringify(kept), /SECRET|login@example|private\/path/);
  }
  const swapped = codexLimitRecord(JSON.parse(codexLine(observedAt, {
    primary: { used_percent: 20, window_minutes: 10080, resets_at: now + 86_400 },
    secondary: { used_percent: 30, window_minutes: 300, resets_at: now + 600 },
  })))!;
  assert.deepEqual(swapped.observations.map((row) => row.meter), ["seven_day", "five_hour"]);
});

test("unknown SDK status stays bounded, and a statusline reading at its reset is already expired", () => {
  const observations = claudeSdkLimitRecord({ observedAt: new Date(now * 1000).toISOString(), type: "rate_limit_event", rate_limit_info: {
    status: "SECRET login@example.com /private/path", rateLimitType: "five_hour", utilization: 0.5, resetsAt: now + 600,
  } });
  assert.equal(observations[0]!.status, "unknown");
  assert.doesNotMatch(JSON.stringify(observations), /SECRET|login@example|private\/path/);
  assert.deepEqual(statuslineObservations({ rate_limits: { five_hour: { used_percentage: 90, resets_at: now } } }, now), []);
});

test("statusline rate_limits are percentages with Unix reset times; expired windows are skipped", () => {
  const observations = statuslineObservations({ rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: now + 3600 }, seven_day: { used_percentage: 41.2, resets_at: now + 86_400 },
    expired: { used_percentage: 99, resets_at: now - 1 },
  } }, now);
  assert.deepEqual(observations.map((item) => [item.meter, item.usedPercent, item.source]), [["five_hour", 23.5, "claude-statusline"], ["seven_day", 41.2, "claude-statusline"]]);
});

test("compaction keeps one row per meter, cycle and bucket: the highest reading, its earliest time, the worst status", () => {
  const base: LimitObservation = { provider: "claude", account: "", meter: "five_hour", windowMinutes: 300, resetsAt: now + 3600, observedAt: now - 600, usedPercent: 40, status: "allowed", source: "claude-sdk-log" };
  const rows = compactObservations([
    base,
    { ...base, observedAt: now - 500, usedPercent: 90, status: "warning" },
    { ...base, observedAt: now - 400, usedPercent: 90, status: "unknown" },
    { ...base, observedAt: now - 300, usedPercent: 70, status: "rejected" },
    { ...base, observedAt: now - 250, usedPercent: 95, status: "rejected" },
    { ...base, meter: "../../etc", usedPercent: 1 },
    { ...base, account: "claude-../etc", usedPercent: 1 },
    { ...base, observedAt: now - 200 * 86_400 },
  ], now);
  // The cap keeps its own row and time: merging it into the earlier peak would move the lockout start earlier.
  assert.deepEqual(rows.map((row) => [row.usedPercent, row.observedAt, row.status]), [[90, now - 500, "warning"], [70, now - 300, "rejected"]]);
});

test("without .claude.json, the Claude plan is read from the OAuth record as a fixed enum only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "limits-plan-"));
  const path = join(directory, ".credentials.json");
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-SECRET", subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } }));
  const profile = await readClaudeProfile({ directory, isDefault: false }, directory);
  assert.deepEqual([profile.key, profile.plan, profile.planSource], [null, "max-20x", "claude-credentials"]);
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { subscriptionType: "sk-ant-oat-SECRET" } }));
  assert.equal((await readClaudeProfile({ directory, isDefault: false }, directory)).plan, null);
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { subscriptionType: "team", rateLimitTier: "default_claude_max_5x" } }));
  assert.equal((await readClaudeProfile({ directory, isDefault: false }, directory)).plan, "team", "the subscription type wins over a Max-like tier");
});

test("harvest is incremental, persists a private ledger, and returns no paths, ids or credentials", async () => {
  const home = mkdtempSync(join(tmpdir(), "limits-home-"));
  const codexRoot = join(home, "codex", "sessions", "2026", "10", "13");
  const logs = join(home, "t3-logs");
  const dataDir = join(home, "data");
  mkdirSync(codexRoot, { recursive: true }); mkdirSync(logs, { recursive: true });
  const rollout = join(codexRoot, "rollout-2026-10-13T20-00-00-SECRETTHREAD.jsonl");
  writeFileSync(rollout, `${codexLine(new Date((now - 3600) * 1000).toISOString(), { primary: { used_percent: 50, window_minutes: 10080, resets_at: now + 5 * 86_400 }, plan_type: "plus" })}\n`);
  const log = join(logs, "events.SECRETTHREAD.log");
  writeFileSync(log, `${sdkLine(new Date((now - 1800) * 1000).toISOString(), { status: "allowed", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: now + 7200 } } })}\n`);
  const environment = { ...process.env, SESSION_ANALYTICS_CLAUDE_EVENT_LOGS: logs, HOME: home, CLAUDE_CONFIG_DIR: join(home, "no-claude") };

  const first = await collectLimits({ dataDir, codexRoot: join(home, "codex", "sessions") }, environment, now);
  assert.equal(first.persisted, true);
  assert.equal(first.plans.codex, "plus");
  assert.deepEqual(first.observations.map((item) => `${item.provider}:${item.meter}:${item.usedPercent}`).sort(), ["claude:five_hour:30", "codex:seven_day:50"]);
  assert.equal(statSync(join(dataDir, "limits-v3.json")).mode & 0o777, 0o600);
  const serialized = JSON.stringify(first) + JSON.stringify(readLedger(dataDir));
  for (const secret of ["SECRET", home, "rollout", "session_id"]) assert.equal(serialized.includes(secret), false, secret);

  // Only the appended tail is read; earlier readings come back from the ledger.
  appendFileSync(rollout, `${codexLine(new Date((now - 60) * 1000).toISOString(), { primary: { used_percent: 55, window_minutes: 10080, resets_at: now + 5 * 86_400 } })}\n`);
  const second = await collectLimits({ dataDir, codexRoot: join(home, "codex", "sessions") }, environment, now);
  assert.equal(second.sources.find((source) => source.source === "codex-session")?.read, 1);
  assert.equal(second.sources.find((source) => source.source === "claude-sdk-log")?.read, 0);
  assert.deepEqual(second.observations.filter((item) => item.provider === "codex").map((item) => item.usedPercent).sort(), [50, 55]);
  assert.equal(second.plans.codex, "plus", "the plan survives in the ledger when new records omit it");
});

test("--no-index harvests without writing the ledger", async () => {
  const home = mkdtempSync(join(tmpdir(), "limits-noindex-"));
  const dataDir = join(home, "data");
  const snapshot = await collectLimits({ dataDir, noIndex: true, codexRoot: join(home, "none") }, { SESSION_ANALYTICS_CLAUDE_EVENT_LOGS: join(home, "none") }, now);
  assert.equal(snapshot.persisted, false);
  assert.throws(() => statSync(dataDir));
  assert.equal(snapshot.sources.find((source) => source.source === "codex-session")?.status, "unavailable");
});

test("limits leaves out extra limits that never moved off 0%, as the dashboard does", () => {
  const home = mkdtempSync(join(tmpdir(), "limits-quiet-meters-"));
  const sessions = join(home, "codex", "sessions"), clock = Math.floor(Date.now() / 1000);
  mkdirSync(sessions, { recursive: true });
  const weekly = (id: string, name: string, used: number) => codexLine(new Date((clock - 600) * 1000).toISOString(),
    { limit_id: id, limit_name: name, plan_type: "pro", primary: { used_percent: used, window_minutes: 10_080, resets_at: clock + 3 * 86_400 } });
  writeFileSync(join(sessions, "rollout-a.jsonl"), [JSON.stringify({ type: "session_meta", payload: { creator_account_id: "account" } }),
    weekly("codex", "Codex", 30), weekly("codex_bengalfox", "GPT-5.3-Codex-Spark", 12), weekly("gpt_reserve", "GPT-Reserve", 0)].join("\n") + "\n");
  const result = spawnSync(process.execPath, [join(root, "bin/session-analytics.ts"), "limits", "--no-remote", "--offline", "--data-dir", join(home, "data"), "--codex-root", sessions], {
    encoding: "utf8", env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, "no-claude"), SESSION_ANALYTICS_CLAUDE_EVENT_LOGS: join(home, "no-logs") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}Weekly · all models +30% used/m);
  assert.match(result.stdout, /^ {2}GPT-5\.3-Codex-Spark · Weekly +12% used/m);
  assert.doesNotMatch(result.stdout, /GPT-Reserve/);
});

test("limits statusline records readings once per change and prints them", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "limits-statusline-"));
  const resets = Math.floor(Date.now() / 1000) + 3 * 3600;
  const input = JSON.stringify({ model: { display_name: "Opus" }, rate_limits: { five_hour: { used_percentage: 46, resets_at: resets } } });
  // A home without Claude profiles: the readings stay unattributed rather than reading this machine's logins.
  const env = { ...process.env, HOME: dataDir, CLAUDE_CONFIG_DIR: "" };
  const run = () => spawnSync(process.execPath, [join(root, "bin/session-analytics.ts"), "limits", "statusline", "--data-dir", dataDir], { input, encoding: "utf8", env });
  const first = run();
  assert.equal(first.status, 0);
  assert.match(first.stdout, /^5h 46% ↻[23]h/);
  run();
  const inbox = join(dataDir, "limits-inbox-v2.jsonl");
  assert.equal(statSync(inbox).mode & 0o777, 0o600);
  assert.equal(spawnSync("wc", ["-l", inbox], { encoding: "utf8" }).stdout.trim().split(" ")[0], "1");
  const garbage = spawnSync(process.execPath, [join(root, "bin/session-analytics.ts"), "limits", "statusline", "--data-dir", dataDir], { input: "not json", encoding: "utf8" });
  assert.equal(garbage.status, 0);
});

test("the Codex account read projects banked reset credits and drops ids, titles and the account", () => {
  const state = codexAccountState({
    ordinaryUsageAllowed: true, accountId: "acct-SECRET", rateLimitUpsell: { text: "SECRET" },
    rateLimits: { primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: now + 6 * 86_400 }, credits: { hasCredits: true, unlimited: false, balance: "44223.83" }, planType: "pro" },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: now + 6 * 86_400 }, credits: { hasCredits: true, unlimited: false, balance: "44223.83" }, planType: "pro" } },
    rateLimitResetCredits: { availableCount: 1, credits: [{ id: "credit-SECRET", resetType: "codexRateLimits", status: "available", grantedAt: now - 6 * 86_400, expiresAt: now + 24 * 86_400, title: "SECRET title", description: "SECRET" }] },
  }, now);
  assert.equal(state?.plan, "pro");
  assert.deepEqual(state?.credits, { hasCredits: true, unlimited: false, balance: 44223.83 });
  assert.deepEqual(state?.resetCredits, { available: 1, credits: [{ status: "available", scope: "all", grantedAt: now - 6 * 86_400, expiresAt: now + 24 * 86_400 }] });
  assert.deepEqual(state?.observations.map((item) => [item.meter, item.usedPercent, item.source]), [["seven_day", 1, "codex-account"]]);
  assert.equal(JSON.stringify(state).includes("SECRET"), false);
});

test("Claude extra-usage state comes from SDK events as fixed enums", () => {
  const line = sdkLine("2026-10-13T12:00:00Z", { status: "allowed", overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false });
  assert.deepEqual(claudeSdkAccount(JSON.parse(line.replace(/^[^{]*/, ""))), { observedAt: at("2026-10-13T12:00:00Z"), extraUsage: "disabled", disabledReason: "org_level_disabled" });
  const odd = sdkLine("2026-10-13T12:00:00Z", { status: "allowed", overageStatus: "rejected", overageDisabledReason: "/home/SECRET" });
  assert.equal(claudeSdkAccount(JSON.parse(odd.replace(/^[^{]*/, "")))?.disabledReason, null);
});

test("banked resets are read through the Codex app-server by default, throttled, and never redeemed", async () => {
  const home = mkdtempSync(join(tmpdir(), "limits-account-"));
  const methods = join(home, "methods.log");
  const fake = join(home, "codex");
  writeFileSync(fake, `#!${process.execPath}
const { appendFileSync } = require("node:fs");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    appendFileSync(${JSON.stringify(methods)}, message.method + "\\n");
    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
    if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: {
      ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 92, windowDurationMins: 10080, resetsAt: ${now + 5 * 86_400} }, planType: "pro" },
      rateLimitResetCredits: { availableCount: 2, credits: [{ id: "x", resetType: "codexRateLimits", status: "available", grantedAt: ${now - 86_400}, expiresAt: ${now + 2 * 86_400}, title: null, description: null }] },
    } }) + "\\n");
  }
});
`, { mode: 0o755 });
  const environment = { HOME: home, SESSION_ANALYTICS_CODEX_BIN: fake, SESSION_ANALYTICS_CLAUDE_EVENT_LOGS: join(home, "none"), CLAUDE_CONFIG_DIR: join(home, "none") };
  const dataDir = join(home, "data");
  const off = await collectLimits({ dataDir, codexAccount: false }, environment, now);
  assert.equal(off.codexAccount, "off");
  const offline = await collectLimits({ dataDir, offline: true }, environment, now);
  assert.equal(offline.codexAccount, "off");
  assert.throws(() => statSync(methods), "no app-server when turned off or offline");

  const codex = (snapshot: LimitsSnapshot) => snapshot.accounts.find((account) => account.provider === "codex");
  const first = await collectLimits({ dataDir }, environment, now);
  assert.equal(first.codexAccount, "ok");
  assert.deepEqual(codex(first)?.codex?.resetCredits?.available, 2);
  assert.equal(codex(first)?.codex?.resetCredits?.credits?.[0]?.expiresAt, now + 2 * 86_400);
  assert.equal(codex(first)?.plan, "pro");
  assert.deepEqual(first.resetCreditHistory, [["codex", codex(first)!.key, now, 2]]);
  assert.ok(first.observations.some((item) => item.source === "codex-account" && item.usedPercent === 92 && item.account === codex(first)!.key));
  const second = await collectLimits({ dataDir }, environment, now + 60);
  assert.equal(codex(second)?.codex?.resetCredits?.available, 2, "throttled reads keep the last account state");
  const sent = readFileSync(methods, "utf8").trim().split("\n");
  assert.deepEqual(sent, ["initialize", "initialized", "account/rateLimits/read"], "one read, and never account/rateLimitResetCredit/consume");
});

test("per-reading Codex plans are a closed allowlist in sources, ledger, and remote output", () => {
  const sentinel = "private_sentinel_branch_and_prompt";
  const session = codexLimitRecord(JSON.parse(codexLine(new Date(now * 1000).toISOString(), {
    primary: { used_percent: 20, window_minutes: 10080, resets_at: now + 86_400 }, plan_type: sentinel,
  })))!;
  const rows = compactObservations(session.observations, now);
  assert.equal(rows[0]!.planType, "other");
  assert.doesNotMatch(JSON.stringify(rows), /private_sentinel/);
  const account = codexAccountState({ rateLimits: { planType: sentinel, primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: now + 86_400 } } }, now)!;
  assert.equal(account.observations[0]!.planType, "other");
  assert.doesNotMatch(JSON.stringify(account.observations), /private_sentinel/);
  assert.equal(compactObservations([{ ...rows[0]!, planType: sentinel } as unknown as LimitObservation], now)[0]!.planType, "other");
  const directory = mkdtempSync(join(tmpdir(), "limits-plan-privacy-"));
  writeLedger(directory, { ...emptyLedger(), rows: [toRow({ ...rows[0]!, planType: sentinel } as unknown as LimitObservation)] }, now);
  assert.doesNotMatch(readFileSync(join(directory, ledgerName), "utf8"), /private_sentinel/);
  assert.equal(readLedger(directory, now).ledger!.rows[0]![9], "other");
  assert.equal(codexLimitRecord(JSON.parse(codexLine(new Date(now * 1000).toISOString(), {
    primary: { used_percent: 20, window_minutes: 10080, resets_at: now + 86_400 }, plan_type: "pro",
  })))!.observations[0]!.planType, "pro");
});
