// Subscription limits read from saved machines: the same ssh and bundled runtime as snapshots, merged by account key.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createHash } from "node:crypto";

import { analyzeMachineSessions } from "../src/analyzer.ts";
import { combineSnapshots, historyProfileKeys, profileKeyRemaps } from "../src/interop/combine.ts";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { writeMachines, type MachinesConfig } from "../src/machines/config.ts";
import { claudeAccountKey, codexAccountKey } from "../src/limits/accounts.ts";
import { collectLimits, emptyLimitsSnapshot } from "../src/limits/index.ts";
import { readLedger } from "../src/limits/ledger.ts";
import { foldMachineLimits, mergeMachineLimits, validateLimitsSnapshot, type MachineLimits } from "../src/limits/machines.ts";
import type { LimitAccount, LimitObservation, LimitsMachine, LimitsSnapshot } from "../src/limits/types.ts";
import { filterSnapshot } from "../src/public/export-data.js";
import { filteredWarning } from "../src/public/evidence.js";
import { attributeSessions, limitMachines, subscriptionModel } from "../src/public/subscription-data.js";
import type { MachineAnalytics, MachineStatus } from "../src/types.ts";
import { fakeSsh } from "./fake-ssh.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const bin = new URL("../bin/session-analytics.ts", import.meta.url).pathname;
const server = new URL("../src/server.ts", import.meta.url).pathname;
const now = Math.floor(Date.now() / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const session = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const minute = (seconds: number) => Math.round(seconds / 60) * 60;
// Weekly resets: the shared Max account, a Team seat seen here only, the shared Codex account and box2's own Codex account.
const weekMax = minute(now + 3 * 86_400), weekTeam = minute(now + 86_400), weekCodex = minute(now + 4 * 86_400), weekOther = minute(now + 2 * 86_400);

const directory = mkdtempSync(join(tmpdir(), "machine-limits-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const homes = join(directory, "homes"), sshLog = join(directory, "ssh.log");

interface Login { org: string; account: string; type: string | null; orgTier?: string }
const max: Login = { org: "SECRET-ORG-F", account: "SECRET-ACCOUNT-F", type: "claude_max", orgTier: "default_claude_max_20x" };
const team: Login = { org: "SECRET-ORG-S", account: "SECRET-ACCOUNT-S", type: "claude_team", orgTier: "default_raven" };

/** A Claude profile with transcripts (never opened) and an `oauthAccount` full of values that must not leak. */
function claudeProfile(home: string, profile: string, login: Login, sessions: string[], config = join(home, profile, ".claude.json")): void {
  const projects = join(home, profile, "projects", "-home-SECRET-repo");
  mkdirSync(projects, { recursive: true });
  for (const id of sessions) writeFileSync(join(projects, `${id}.jsonl`), "{\"message\":\"SECRET transcript\"}\n");
  writeFileSync(config, JSON.stringify({ oauthAccount: { accountUuid: login.account, organizationUuid: login.org, emailAddress: "SECRET@example.com", organizationName: "SECRET Org", organizationType: login.type, organizationRateLimitTier: login.orgTier ?? null, hasExtraUsageEnabled: false } }));
}

/** T3 Code's Agent SDK event log: one rate_limit_event per [time, session, five-hour %, weekly %, weekly reset]. */
function eventLog(home: string, events: Array<[number, string, number, number, number]>): void {
  const logs = join(home, ".t3", "userdata", "logs", "provider");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "events.thread-SECRET.log"), events.map(([at, id, five, weekly, reset]) => {
    const payload = { type: "rate_limit_event", session_id: id, rate_limit_info: { status: "allowed", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: five, resetsAt: at + 3600 }, seven_day: { utilization: weekly, resetsAt: reset } } } };
    return `[${iso(at)}] NATIVE: ${JSON.stringify({ observedAt: iso(at), event: { method: "claude/rate_limit_event", payload } })}\n`;
  }).join(""));
}

/** A Codex rollout its account created, with weekly readings [time, %]. */
function rollout(home: string, account: string, reset: number, readings: Array<[number, number]>): void {
  const sessions = join(home, ".codex", "sessions", "2026", "10");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `rollout-${account}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { creator_account_id: account } }),
    ...readings.map(([at, used]) => JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", plan_type: "pro", primary: { used_percent: used, window_minutes: 10_080, resets_at: reset } } } })),
  ].join("\n") + "\n");
}

/** A Codex app-server that answers for one account with a banked reset, and logs each method it is sent. */
function fakeCodex(path: string, account: string, reset: number): string {
  const methods = `${path}.methods`;
  writeFileSync(path, `#!${process.execPath}
const { appendFileSync } = require("node:fs");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    appendFileSync(${JSON.stringify(methods)}, message.method + "\\n");
    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
    if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { accountId: ${JSON.stringify(account)}, rateLimits: { primary: { usedPercent: 52, windowDurationMins: 10080, resetsAt: ${reset} }, planType: "pro" },
      rateLimitResetCredits: { availableCount: 1, credits: [{ id: "SECRET-CREDIT", resetType: "codexRateLimits", status: "available", grantedAt: ${now - 86_400}, expiresAt: ${now + 20 * 86_400}, title: "SECRET" }] } } }) + "\\n");
  }
});
`, { mode: 0o755 });
  return methods;
}

// This machine: the Max account (its plan not recorded here), a Team seat, and the shared Codex account with its banked resets.
const localHome = join(directory, "local-home");
claudeProfile(localHome, ".claude-fluxary", { ...max, type: null, orgTier: undefined }, [session(1)]);
claudeProfile(localHome, ".claude-stage", team, [session(2)]);
eventLog(localHome, [[now - 20 * 3600, session(1), 0.1, 0.30, weekMax], [now - 10 * 3600, session(1), 0.2, 0.40, weekMax], [now - 8 * 3600, session(2), 0.3, 0.60, weekTeam]]);
rollout(localHome, "SECRET-CODEX", weekCodex, [[now - 12 * 3600, 20]]);
const localCodexMethods = fakeCodex(join(directory, "codex-local"), "SECRET-CODEX", weekCodex);
// agentbox: the same Max account (plan known there), and the same Codex account.
const agentHome = join(homes, "agentbox", "agent-t3");
claudeProfile(agentHome, ".claude", max, [session(11)], join(agentHome, ".claude.json"));
eventLog(agentHome, [[now - 15 * 3600, session(11), 0.15, 0.35, weekMax], [now - 5 * 3600, session(11), 0.25, 0.45, weekMax], [now - 4 * 3600, session(99), 0.1, 0.5, minute(now + 5 * 86_400)]]);
rollout(agentHome, "SECRET-CODEX", weekCodex, [[now - 6 * 3600, 25]]);
const agentCodexMethods = fakeCodex(join(directory, "codex-agentbox"), "SECRET-CODEX", weekCodex);
// box2: a Codex account this machine has never seen.
const boxHome = join(homes, "box2", "ssh-user");
rollout(boxHome, "SECRET-CODEX-2", weekOther, [[now - 3 * 3600, 50]]);
const boxCodexMethods = fakeCodex(join(directory, "codex-box2"), "SECRET-CODEX-2", weekOther);

const shim = join(directory, "bin");
mkdirSync(shim);
writeFileSync(join(shim, "ssh"), fakeSsh);
chmodSync(join(shim, "ssh"), 0o755);
// The remote harvest stops for good, or for three seconds, so only cancellation or patience ends the read.
const hold = (ms: number) => `if (/bin\\/session-analytics\\.(?:ts|js)$/.test(process.argv[1] || "") && process.argv.includes("limits")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});\n`;
writeFileSync(join(directory, "hang.cjs"), hold(120_000));
writeFileSync(join(directory, "slow.cjs"), hold(3_000));
const remoteEnvironment = (data: string, codex: string): Record<string, string> => ({ SESSION_ANALYTICS_DATA_DIR: join(directory, data), SESSION_ANALYTICS_CODEX_BIN: codex });
const environment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SESSION_ANALYTICS_") && key !== "CLAUDE_CONFIG_DIR" && key !== "CODEX_HOME")),
  HOME: localHome, PATH: `${shim}:${process.env["PATH"] ?? ""}`, TZ: "UTC", SESSION_ANALYTICS_CODEX_BIN: join(directory, "codex-local"),
  FAKE_SSH_LOG: sshLog, FAKE_SSH_HOMES: homes, FAKE_SSH_BIN: bin,
  FAKE_SSH_ENVS: JSON.stringify({
    agentbox: remoteEnvironment("agentbox-data", join(directory, "codex-agentbox")),
    box2: remoteEnvironment("box2-data", join(directory, "codex-box2")),
    stuck: { ...remoteEnvironment("stuck-data", join(directory, "codex-agentbox")), HOME: agentHome, NODE_OPTIONS: `--require ${join(directory, "hang.cjs")}` },
    slow: { ...remoteEnvironment("slow-data", join(directory, "codex-agentbox")), HOME: agentHome, NODE_OPTIONS: `--require ${join(directory, "slow.cjs")}` },
  }),
};
const data = (name: string): string => join(directory, "data", name);
const saved = (name: string, machines: MachinesConfig["machines"]): string => { writeMachines({ dataDir: data(name) }, { version: 1, machines }); return data(name); };
const both: MachinesConfig["machines"] = [{ name: "agentbox", ssh: "agentbox", user: "agent-t3", runtime: "bundled", enabled: true }, { name: "box2", ssh: "box2", runtime: "bundled", enabled: true }];
const cli = (args: string[], extra: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> => spawnSync(process.execPath, [bin, ...args], { env: { ...environment, ...extra }, encoding: "utf8", maxBuffer: 1 << 26 });
const json = (result: SpawnSyncReturns<string>): LimitsSnapshot => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout) as LimitsSnapshot; };
const calls = (): Array<{ destination: string; words: string[] }> => (existsSync(sshLog) ? readFileSync(sshLog, "utf8") : "").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { destination: string; words: string[] });
const leftovers = (): string[] => spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes(homes));
async function noLeftovers(): Promise<string[]> {
  for (let attempt = 0; attempt < 100 && leftovers().length; attempt++) await delay(50);
  return leftovers();
}
const keys = { max: claudeAccountKey(max.org, max.account), team: claudeAccountKey(team.org, team.account), codex: codexAccountKey("SECRET-CODEX"), other: codexAccountKey("SECRET-CODEX-2") };
const accountOf = (snapshot: LimitsSnapshot, key: string): LimitAccount => snapshot.accounts.find((account) => account.key === key)!;
const machinesOf = (snapshot: LimitsSnapshot, key: string): string[] => accountOf(snapshot, key).machines!.map(({ key: machine }) => machine);
const weekly = (snapshot: LimitsSnapshot, key: string): number[] => snapshot.observations.filter((row) => row.account === key && row.meter === "seven_day").sort((a, b) => a.observedAt - b.observedAt).map((row) => row.usedPercent);

test("limits reads every saved machine: one account across machines is one account, other accounts stay their own", () => {
  const dir = saved("merge", both);
  rmSync(sshLog, { force: true });
  const merged = json(cli(["limits", "--json", "--data-dir", dir]));
  assert.deepEqual(merged.machines!.map(({ key, state }) => [key, state]), [["local", "ok"], ["agentbox", "ok"], ["box2", "ok"]]);
  assert.deepEqual(machinesOf(merged, keys.max), ["local", "agentbox"], "the same login is one account on both machines");
  assert.deepEqual(weekly(merged, keys.max), [30, 35, 40, 45], "every machine's readings of the cycle");
  assert.equal(accountOf(merged, keys.max).plan, "max-20x", "the plan comes from the machine that knows it");
  assert.equal(accountOf(merged, keys.max).label, "Claude Max 20x · fluxary", "this machine's profile names");
  assert.deepEqual(machinesOf(merged, keys.team), ["local"]);
  assert.deepEqual(machinesOf(merged, keys.codex), ["local", "agentbox"]);
  assert.deepEqual(weekly(merged, keys.codex).filter((used) => used !== 52), [20, 25]);
  assert.deepEqual(machinesOf(merged, keys.other), ["box2"]);
  assert.equal(merged.accounts.filter((account) => account.provider === "claude" && account.attribution !== "account").length, 0, "another machine's readings without an account are never merged");
  // The remote Claude profile key is that machine's own; both profile keys join their machine's sessions.
  assert.equal(accountOf(merged, keys.max).machines![1]!.profileKeys.length, 1);
  assert.notDeepEqual(accountOf(merged, keys.max).machines![0]!.profileKeys, accountOf(merged, keys.max).machines![1]!.profileKeys);

  // Banked resets are account-wide: agentbox shares this machine's Codex account, so only box2 asks its own app-server.
  assert.equal(accountOf(merged, keys.other).codex?.resetCredits?.available, 1);
  assert.equal(accountOf(merged, keys.codex).codex?.resetCredits?.available, 1);
  assert.equal(existsSync(agentCodexMethods), false, "agentbox's app-server is never asked");
  assert.match(readFileSync(boxCodexMethods, "utf8"), /account\/rateLimits\/read/);
  assert.match(readFileSync(localCodexMethods, "utf8"), /account\/rateLimits\/read/);
  const limitsCalls = calls().filter(({ words }) => words.includes("limits"));
  assert.ok(limitsCalls.filter(({ destination }) => destination === "agentbox").every(({ words }) => words.includes("--no-codex-account") && words.includes("--no-remote") && words.includes("--unsettled")));
  assert.deepEqual(limitsCalls.filter(({ destination }) => destination === "box2").map(({ words }) => [words[3], words.includes("--no-codex-account")]), [["run", true], ["install", true], ["run", false]],
    "box2 is asked again, once, with its account read");
  assert.deepEqual(calls().filter(({ destination }) => destination === "agentbox").map(({ words }) => words.slice(0, 4)), [["sudo", "-n", "-iu", "agent-t3"], ["sudo", "-n", "-iu", "agent-t3"]]);

  // Other machines' readings and plans are kept in this machine's ledger; profile names and keys stay with their machine.
  const ledger = readLedger(dir).ledger!;
  assert.ok(ledger.rows.some((row) => row[1] === keys.max && row[2] === "seven_day" && row[6] === 45));
  assert.ok(ledger.rows.some((row) => row[1] === keys.other));
  assert.equal(ledger.accounts[keys.max]!.plan, "max-20x");
  assert.deepEqual(ledger.accounts[keys.other]!.profileKeys, []);
  // A run of this machine alone still shows that history, reported by no machine.
  const alone = json(cli(["limits", "--json", "--data-dir", dir, "--no-remote"]));
  assert.equal(alone.machines, undefined);
  assert.deepEqual(weekly(alone, keys.max), [30, 35, 40, 45]);
  assert.ok(alone.accounts.some((account) => account.key === keys.other));
  // That history is not this machine's login: its Codex sessions still join the only Codex account logged in here.
  assert.deepEqual(attributeSessions([{ provider: "codex" }], alone.accounts).byAccount.get(keys.codex)!.length, 1);
  const spentHere = { provider: "codex", velocity: { version: 1, dimensions: [], undated: [], buckets: [[iso(now - 2 * 3600).slice(0, 10), Number(iso(now - 2 * 3600).slice(11, 13)), 0, [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]] } };
  assert.equal(subscriptionModel({ limits: alone, sessions: [spentHere], timeZone: "UTC", now, range: { from: now - 86_400, to: now } }).accounts.find((item) => item.key === keys.codex)!.value.basis, "provider");
  for (const file of ["agentbox.limits.json", "box2.limits.json"]) assert.equal(statSync(join(dir, "machines", file)).mode & 0o777, 0o600);
  const cached = JSON.parse(readFileSync(join(dir, "machines", "agentbox.limits.json"), "utf8")) as { limits: LimitsSnapshot };
  assert.ok(cached.limits.accounts.every((item) => !item.profileNames.length && !/ · (?:default|fluxary)$/.test(item.label)), "profile names are never stored");
  const everything = JSON.stringify(merged) + readFileSync(join(dir, "limits-v2.json"), "utf8") + readFileSync(join(dir, "machines", "agentbox.limits.json"), "utf8");
  for (const secret of ["SECRET", "example.com", localHome, agentHome, session(1), session(11)]) assert.equal(everything.includes(secret), false, secret);

  const text = cli(["limits", "--data-dir", dir]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Session Analytics · subscription limits · this machine, agentbox and box2\n\nMachines: 3 of 3 read now\n {2}this machine {2}3 accounts in \d+\.\d s\n {2}agentbox {6}2 accounts in \d+\.\d s\n {2}box2 {10}1 account in \d+\.\d s\n/);
  assert.match(text.stdout, /\nClaude Max 20x · fluxary \(\$200\/mo\)\n {2}Reported by this machine and agentbox\n/);
  assert.match(text.stdout, /\nClaude Team · stage\n {2}Reported by this machine\n/);
  assert.match(text.stdout, /\n {2}Reported by box2\n(?:.*\n)*? {2}Banked resets: 1 available/);
  assert.match(text.stdout, /Source codex-session on this machine: ok/);
});

test("failed machine limits keep SSH destinations and account names out of the snapshot", () => {
  const dir = saved("private-failures", [{ name: "box", ssh: "SECRET-HOST", user: "secret-account", runtime: "bundled", enabled: true }]);
  const read = cli(["limits", "--json", "--data-dir", dir, "--offline"], { FAKE_SSH_DOWN: "SECRET-HOST" });
  const snapshot = json(read);
  assert.equal(snapshot.machines![1]!.reason, "connection");
  assert.ok(snapshot.machines![1]!.fix);
  assert.doesNotMatch(read.stdout, /SECRET-HOST|secret-account|Connection refused/);
  assert.match(read.stderr, /SECRET-HOST.*Connection refused/);
});

test("a machine that cannot be read shows its last good limits, marked stale; without them its sessions do not count", () => {
  const dir = data("merge");
  const down = { FAKE_SSH_DOWN: "agentbox" };
  const stale = json(cli(["limits", "--json", "--data-dir", dir], down));
  assert.deepEqual(stale.machines!.map(({ key, state, reason }) => [key, state, reason ?? null]), [["local", "ok", null], ["agentbox", "stale", "connection"], ["box2", "ok", null]]);
  assert.deepEqual(machinesOf(stale, keys.max), ["local", "agentbox"]);
  const text = cli(["limits", "--data-dir", dir], down);
  assert.match(text.stdout, /^Session Analytics · subscription limits · this machine, agentbox \(stale\) and box2\n\nMachines: 2 of 3 read now, 1 from its last good limits\n(?:.*\n)? {2}agentbox {6}unreachable; its last good limits from (?:just now|\d+ min ago) \(2 accounts\)\n {4}Fix: run session-analytics machines check agentbox/);
  assert.match(text.stderr, /^Could not read limits from agentbox: SSH could not connect\..*\n {2}Fix: .*\n {2}Using its last good limits from (?:just now|\d+ min ago)\.\n$/);

  rmSync(join(dir, "machines", "agentbox.limits.json"));
  const failed = json(cli(["limits", "--json", "--data-dir", dir], down));
  assert.deepEqual(failed.machines!.map(({ key, state }) => [key, state]), [["local", "ok"], ["agentbox", "failed"], ["box2", "ok"]]);
  assert.deepEqual(machinesOf(failed, keys.max), ["local"]);
  assert.deepEqual(weekly(failed, keys.max), [30, 35, 40, 45], "agentbox's readings stay in this machine's ledger");
  assert.match(cli(["limits", "--data-dir", dir], down).stdout, /\n {2}agentbox {6}not read: unreachable\n/);
  // Value counts machines whose limits were read: agentbox's sessions are left out, box2's join its only Codex account.
  const spent = (machine: string, provider: string) => ({ provider, machine, velocity: { version: 1, dimensions: [], undated: [], buckets: [[iso(now - 2 * 3600).slice(0, 10), Number(iso(now - 2 * 3600).slice(11, 13)), 0, [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]] } });
  const model = subscriptionModel({ limits: failed, sessions: [spent("agentbox", "codex"), spent("box2", "codex"), spent("local", "codex")], timeZone: "UTC", now, range: { from: now - 86_400, to: now } });
  assert.ok(model.elsewhere.codex > 9, "agentbox's value is not counted");
  assert.equal(model.accounts.find((item) => item.key === keys.other)!.value.basis, "provider");
  assert.equal(model.accounts.find((item) => item.key === keys.codex)!.value.basis, "provider", "this machine's Codex sessions join its only Codex account");

  // --no-remote reads no machine; --machines reads only those.
  rmSync(sshLog, { force: true });
  assert.equal(json(cli(["limits", "--json", "--data-dir", dir, "--no-remote"])).machines, undefined);
  assert.deepEqual(calls(), []);
  assert.deepEqual(json(cli(["limits", "--json", "--data-dir", dir, "--machines", "box2"])).machines!.map(({ key }) => key), ["local", "box2"]);
  assert.deepEqual([...new Set(calls().map(({ destination }) => destination))], ["box2"]);
  const conflict = cli(["limits", "--data-dir", dir, "--no-remote", "--machines", "box2"]);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /--no-remote cannot be combined with --machines/);
  const unsettled = cli(["limits", "--json", "--data-dir", dir, "--unsettled"]);
  assert.equal(unsettled.status, 2);
  assert.match(unsettled.stderr, /--unsettled describes this machine's own readings; use it with --json --no-remote/);
});

test("the deadline and SIGTERM stop a machine's limits read there too, and leave no process behind", async () => {
  const dir = saved("stuck", [{ name: "stuck", ssh: "stuck", runtime: "bundled", enabled: true }]);
  const started = Date.now();
  const late = cli(["limits", "--json", "--data-dir", dir, "--remote-timeout", "2"]), timed = json(late);
  assert.ok(Date.now() - started < 20_000);
  assert.match(late.stderr, /^Could not read limits from stuck: no limits within 2 seconds\.\n {2}Fix: allow more time with --remote-timeout SECONDS: a machine's limits read may use all of it until one has answered/);
  assert.deepEqual(timed.machines!.map(({ key, state, reason }) => [key, state, reason ?? null]), [["local", "ok", null], ["stuck", "failed", "timeout"]]);
  assert.deepEqual(await noLeftovers(), []);

  const child: ChildProcess = spawn(process.execPath, [bin, "limits", "--data-dir", dir], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 400 && !leftovers().some((line) => /bin\/session-analytics\.ts limits/.test(line)); attempt++) await delay(50);
  assert.ok(leftovers().some((line) => /bin\/session-analytics\.ts limits/.test(line)), "the remote harvest is running");
  const stopped = Date.now();
  child.kill("SIGTERM");
  const [code] = await once(child, "exit") as [number | null];
  assert.equal(code, 143);
  assert.ok(Date.now() - stopped < 4_000, `stopped in ${Date.now() - stopped} ms`);
  assert.equal(output, "", "a stopped run prints nothing");
  assert.deepEqual(await noLeftovers(), []);
});

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(typeof address === "object" && address ? address.port : 0)); });
  });
}

test("the dashboard serves this machine's meters at once and merges a slower machine's limits when it answers", async () => {
  const dir = saved("dashboard", [{ name: "slow", ssh: "slow", runtime: "bundled", enabled: true }]);
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [server, "--port", String(port), "--data-dir", dir, "--no-additional-providers", "--offline"], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let output = "";
    child.stdout!.on("data", (chunk) => { output += chunk; });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 400 && !/ready:/.test(output); attempt++) await delay(25);
    const get = async (): Promise<LimitsSnapshot> => await (await fetch(`http://127.0.0.1:${port}/api/limits`)).json() as LimitsSnapshot;
    const first = await get();
    assert.deepEqual(first.machines!.map(({ key, state }) => [key, state]), [["local", "ok"], ["slow", "reading"]], "this machine's meters do not wait");
    assert.deepEqual(machinesOf(first, keys.max), ["local"]);
    let later = first;
    for (let attempt = 0; attempt < 400 && later.machines![1]!.state === "reading"; attempt++) { await delay(50); later = await get(); }
    assert.equal(later.machines![1]!.state, "ok");
    assert.deepEqual(machinesOf(later, keys.max), ["local", "slow"]);
    assert.deepEqual(weekly(later, keys.max), [30, 35, 40, 45]);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  assert.deepEqual(await noLeftovers(), []);
});

const account = (provider: "claude" | "codex", key: string, extra: Partial<LimitAccount> = {}): LimitAccount => ({
  key, provider, attribution: key === "" ? "unattributed" : key.includes("-w-") ? "weekly-phase" : key.includes("-p-") ? "profile" : "account", label: key,
  profileNames: [], profileKeys: [], plan: null, planSource: null, planEvidence: null, planObservedAt: null, extraUsage: null, codex: null, weeklyAnchor: null, lastSeen: null, ...extra,
});
const reading = (provider: "claude" | "codex", key: string, observedAt: number, usedPercent: number, extra: Partial<LimitObservation> = {}): LimitObservation =>
  ({ provider, account: key, meter: "seven_day", windowMinutes: 10_080, resetsAt: weekMax, observedAt, usedPercent, status: "allowed", source: provider === "codex" ? "codex-session" : "claude-sdk-log", ...extra });
const limitsOf = (accounts: LimitAccount[], observations: LimitObservation[], generatedAt = now): LimitsSnapshot =>
  ({ ...emptyLimitsSnapshot("live", generatedAt), persisted: true, ledger: "ok", accounts, observations });
const status = (key: string, state: LimitsMachine["state"] = "ok"): LimitsMachine => ({ key, label: key === "local" ? "laptop" : key, state, readAt: state === "failed" ? null : iso(now), durationMs: 10 });

test("merging keeps one account per key: the newest plan, the freshest event and banked resets; groups without an account stay apart", () => {
  const maxKey = keys.max, codex = keys.codex, profile = "claude-p-aaaaaaaaaaaaaaaa", phase = "claude-w-1234";
  const local = limitsOf([
    account("claude", maxKey, { profileKeys: ["profile-aaaaaaaaaaaaaaaaaaaa"], profileNames: ["fluxary"], extraUsage: { observedAt: now - 3600, extraUsage: "disabled", disabledReason: "org_level_disabled" } }),
    account("claude", profile, { profileKeys: ["profile-cccccccccccccccccccc"], profileNames: ["work"] }), account("claude", phase), account("claude", ""),
    account("codex", codex, { profileKeys: ["profile-dddddddddddddddddddd"], profileNames: ["default"], codex: { observedAt: now - 7200, credits: null, ordinaryUsageAllowed: true, resetCredits: { available: 2, credits: null } } }),
  ], [
    reading("claude", maxKey, now - 7200, 30), reading("claude", maxKey, now - 600, 100, { status: "unknown", source: "claude-statusline" }),
    reading("claude", profile, now - 7200, 10), reading("claude", phase, now - 7200, 70, { resetsAt: minute(now + 6 * 86_400) }), reading("claude", "", now - 7200, 80, { meter: "five_hour", windowMinutes: 300, resetsAt: now + 3600 }),
    reading("codex", codex, now - 9000, 20, { resetsAt: weekCodex }),
  ]);
  const remote = limitsOf([
    account("claude", maxKey, { profileKeys: ["profile-bbbbbbbbbbbbbbbbbbbb"], profileNames: ["default"], plan: "max-20x", planSource: "claude-config", planObservedAt: now - 60,
      extraUsage: { observedAt: now - 60, extraUsage: "enabled", disabledReason: null } }),
    account("claude", profile, { profileKeys: ["profile-cccccccccccccccccccc"], profileNames: ["work"] }), account("claude", phase), account("claude", ""),
    account("codex", codex, { profileKeys: ["profile-eeeeeeeeeeeeeeeeeeee"], profileNames: ["default"], codex: { observedAt: now - 3600, credits: { hasCredits: true, unlimited: false, balance: 40 }, ordinaryUsageAllowed: null, resetCredits: null } }),
  ], [
    reading("claude", maxKey, now - 7200, 30), reading("claude", maxKey, now - 3600, 35),
    reading("claude", profile, now - 7200, 15), reading("claude", phase, now - 7000, 75, { resetsAt: minute(now + 6 * 86_400) }), reading("claude", "", now - 7000, 90, { meter: "five_hour", windowMinutes: 300, resetsAt: now + 3600 }),
    reading("codex", codex, now - 3600, 25, { resetsAt: weekCodex }),
  ], now - 60);
  const merged = mergeMachineLimits(local, status("local"), [{ status: status("agentbox"), snapshot: validateLimitsSnapshot(JSON.parse(JSON.stringify(remote))) }], null, now);
  const max = accountOf(merged, maxKey);
  assert.deepEqual([max.plan, max.planObservedAt, max.label], ["max-20x", now - 60, "Claude Max 20x · fluxary"]);
  assert.deepEqual(max.extraUsage, { observedAt: now - 3600, extraUsage: "disabled", disabledReason: "org_level_disabled" }, "an event beats another machine's profile default");
  assert.deepEqual(weekly(merged, maxKey), [30, 35, 100], "a reading both machines hold counts once");
  assert.equal(merged.observations.find((row) => row.account === maxKey && row.usedPercent === 100)!.status, "rejected", "settled with the merged account: extra usage off");
  assert.deepEqual(max.machines, [{ key: "local", profileKeys: ["profile-aaaaaaaaaaaaaaaaaaaa"] }, { key: "agentbox", profileKeys: ["profile-bbbbbbbbbbbbbbbbbbbb"] }]);
  const banked = accountOf(merged, codex).codex!;
  assert.deepEqual([banked.observedAt, banked.credits?.balance, banked.resetCredits?.available, banked.ordinaryUsageAllowed], [now - 3600, 40, 2, true], "the freshest state, with the latest banked resets");
  // Groups without an account are this machine's alone, and a profile key from another machine is that machine's.
  assert.deepEqual(merged.observations.filter((row) => row.account === phase || row.account === "").map((row) => row.usedPercent).sort(), [70, 80]);
  assert.deepEqual(weekly(merged, profile), [10]);
  const qualified = merged.accounts.filter((item) => item.attribution === "profile" && item.key !== profile);
  assert.equal(qualified.length, 1);
  assert.match(qualified[0]!.key, /^claude-p-[0-9a-f]{16}$/);
  assert.deepEqual([weekly(merged, qualified[0]!.key), qualified[0]!.machines!.map(({ key }) => key)], [[15], ["agentbox"]]);
  assert.deepEqual(merged.machines!.map(({ key }) => key), ["local", "agentbox"]);
  assert.deepEqual(mergeMachineLimits(local, status("local"), [], null, now).machines, undefined, "one machine's limits are unchanged");
  // A machine that failed contributes nothing, and an identical copy of this machine's limits adds nothing.
  const failed = mergeMachineLimits(local, status("local"), [{ status: status("agentbox", "failed"), snapshot: null }], null, now);
  assert.deepEqual(accountOf(failed, maxKey).machines!.map(({ key }) => key), ["local"]);
  const twice = mergeMachineLimits(local, status("local"), [{ status: status("again"), snapshot: local }], null, now);
  assert.deepEqual(weekly(twice, maxKey), [30, 100]);
  assert.throws(() => validateLimitsSnapshot({ ...remote, schemaVersion: 1 }));
  assert.equal(validateLimitsSnapshot({ ...remote, accounts: [{ ...remote.accounts[0], label: "SECRET <b>", profileNames: ["../SECRET", "ok"] }] }).accounts[0]!.label, "Claude Max 20x · ok", "labels are rebuilt from plain names");
});

test("another machine's colliding profile keys are remapped as the combined snapshot remaps them, so its sessions join the account", async () => {
  const fixture = await createSessionAnalyticsFixture(join(directory, "fixture"));
  writeFileSync(join(fixture.claudeRoot, "stats-cache.json"), JSON.stringify({ dailyModelTokensVersion: 5, lastComputedDate: "2026-07-20", dailyModelTokens: [], modelUsage: {} }));
  const { repositoryRoot: _, remote: __, ...options } = fixture;
  const here = await analyzeMachineSessions(options);
  // The same profile path on another machine: its own sessions, the same profile keys.
  const { historyCoverage, ...source } = structuredClone(here);
  const sessions = source.sessions.map((row) => ({ ...row, sessionKey: createHash("sha256").update(`agentbox:${row.provider}:${row.sessionKey}`).digest("hex").slice(0, 12) }));
  const filtered = filterSnapshot({ ...source, sessions });
  const there: MachineAnalytics = validateSnapshot({ ...filtered, warnings: filtered.warnings.filter((warning) => warning !== filteredWarning), historyCoverage });
  const statuses: MachineStatus[] = ["local", "agentbox"].map((key) => ({ key, label: key, state: "ok", sessions: 1, repositories: 1, readAt: iso(now), durationMs: 1, version: null }));
  const combined = combineSnapshots([here, there], { machines: statuses });
  const profiles = historyProfileKeys(here)!;
  assert.ok(profiles.length > 0 && combined.sessions.some((row) => row.machine === "agentbox" && row.historyProfile && !profiles.includes(row.historyProfile.profileKey)), "the fixture collides");
  const remaps = new Map(profileKeyRemaps([here, there].map(historyProfileKeys)).map((pairs, index) => [statuses[index]!.key, new Map(pairs)]));
  const login = (snapshot: number) => limitsOf([account("claude", keys.max, { profileKeys: profiles, profileNames: ["default"] })], [reading("claude", keys.max, snapshot, 40)]);
  const others: MachineLimits[] = [{ status: status("agentbox"), snapshot: login(now - 60) }];
  for (const given of [remaps, null]) {
    const merged = mergeMachineLimits(login(now - 120), status("local"), others, given, now);
    const joined = attributeSessions(combined.sessions, merged.accounts, { read: limitMachines(merged) }).byAccount.get(keys.max)!;
    const native = combined.sessions.filter((row) => row.provider === "claude" && row.historyProfile);
    assert.deepEqual(joined.map((row) => row.machine).sort(), native.map((row) => row.machine).sort(), "every native Claude session of both machines joins the account");
    assert.ok(joined.some((row) => row.machine === "agentbox"));
  }
  const unmapped = mergeMachineLimits(login(now - 120), status("local"), others, new Map([["agentbox", new Map()]]), now);
  assert.ok(!attributeSessions(combined.sessions, unmapped.accounts, { read: limitMachines(unmapped) }).byAccount.get(keys.max)!.some((row) => row.machine === "agentbox"), "without the remap they would not");
});

test("the merged plan is the latest change on any machine, and a Max plan guessed without its tier never beats one read with it", () => {
  const evidence = (tier: string | null) => ({ organizationType: "claude_max", organizationRateLimitTier: tier, userRateLimitTier: null, seatTier: null, billingType: null, planType: null });
  const read = (plan: "max-5x" | "max-20x", tier: string | null, at: number, profile: string) => limitsOf([account("claude", keys.max, { profileKeys: [profile], plan, planSource: "claude-config", planEvidence: evidence(tier), planObservedAt: at })],
    [reading("claude", keys.max, now - 600, 40)]);
  const plan = (local: LimitsSnapshot, remote: LimitsSnapshot, state: LimitsMachine["state"]) =>
    accountOf(mergeMachineLimits(local, status("local"), [{ status: status("agentbox", state), snapshot: validateLimitsSnapshot(JSON.parse(JSON.stringify(remote))) }], null, now), keys.max).plan;
  const here = (plan: "max-5x" | "max-20x", tier: string | null, at: number) => read(plan, tier, at, "profile-aaaaaaaaaaaaaaaaaaaa");
  const there = (plan: "max-5x" | "max-20x", tier: string | null, at: number) => read(plan, tier, at, "profile-bbbbbbbbbbbbbbbbbbbb");
  // This machine reads the organization type without its tier; agentbox reads the tier. Read now or from its last good limits, agentbox's wins.
  for (const [at, state] of [[now + 1, "ok"], [now - 1800, "stale"]] as const) assert.equal(plan(here("max-5x", null, now), there("max-20x", "default_claude_max_20x", at), state), "max-20x", state);
  // Both read a tier but disagree: the plan first read more recently is the change, whichever machine was read last.
  const before = (machine: typeof here) => machine("max-5x", "default_claude_max_5x", now - 30 * 86_400), after = (machine: typeof here) => machine("max-20x", "default_claude_max_20x", now - 86_400);
  for (const state of ["ok", "stale"] as const) {
    assert.equal(plan(before(here), after(there), state), "max-20x", state);
    assert.equal(plan(after(here), before(there), state), "max-20x", state);
  }
});

test("a plan keeps the time it was first read here, and another machine's plan never replaces this machine's in its ledger", async () => {
  const home = join(directory, "plan-home"), dir = data("plan");
  const login = (tier: string) => claudeProfile(home, ".claude-max", { ...max, orgTier: tier }, []);
  login("default_claude_max_5x");
  const options = { dataDir: dir, claudeRoot: join(home, ".claude-max", "projects"), codexRoot: join(home, "no-codex", "sessions"), codexAccount: false };
  const harvest = async (at: number) => { const found = accountOf(await collectLimits(options, { HOME: home }, at), keys.max); return [found.plan, found.planObservedAt]; };
  assert.deepEqual(await harvest(now - 600), ["max-5x", now - 600]);
  assert.deepEqual(await harvest(now - 300), ["max-5x", now - 600], "read again unchanged, it keeps the time it was first read");
  foldMachineLimits(dir, limitsOf([account("claude", keys.max, { plan: "max-20x", planSource: "claude-config", planObservedAt: now - 60 })], [reading("claude", keys.max, now - 120, 40)]), now - 50);
  assert.deepEqual([readLedger(dir, now).ledger!.accounts[keys.max]!.plan, readLedger(dir, now).ledger!.accounts[keys.max]!.planObservedAt], ["max-5x", now - 600], "the fold leaves this machine's plan alone");
  assert.deepEqual(await harvest(now - 30), ["max-5x", now - 600]);
  login("default_claude_max_20x");
  assert.deepEqual(await harvest(now), ["max-20x", now], "a change is stamped when it is first read");
  // An account this machine never read a plan for takes the plan another machine read.
  foldMachineLimits(dir, limitsOf([account("claude", keys.team, { plan: "team", planSource: "claude-config", planObservedAt: now - 60 })], [reading("claude", keys.team, now - 120, 40, { resetsAt: weekTeam })]), now);
  assert.deepEqual([readLedger(dir, now).ledger!.accounts[keys.team]!.plan, readLedger(dir, now).ledger!.accounts[keys.team]!.planObservedAt], ["team", null]);
});

test("Sources describe this machine: readings folded in from another machine never count as its own", async () => {
  const home = join(directory, "sources-home");
  rollout(home, "SECRET-CODEX", weekCodex, [[now - 3600, 20]]);
  const options = (dir: string, codex = join(home, ".codex", "sessions")) => ({ dataDir: data(dir), claudeRoot: join(home, "no-claude", "projects"), codexRoot: codex, codexAccount: false });
  const codexSource = async (dir: string, at: number, codex?: string) => (await collectLimits(options(dir, codex), { HOME: home }, at)).sources.find((item) => item.source === "codex-session")!;
  const elsewhere = limitsOf([account("codex", keys.codex), account("codex", keys.other)], [reading("codex", keys.codex, now - 120, 30, { resetsAt: weekCodex }), reading("codex", keys.other, now - 120, 50, { resetsAt: weekOther })]);
  assert.deepEqual([(await codexSource("sources", now - 60)).status, (await codexSource("sources", now - 60)).latest], ["ok", now - 3600]);
  foldMachineLimits(data("sources"), elsewhere, now - 50);
  assert.equal((await codexSource("sources", now)).latest, now - 3600, "agentbox's later reading is not this machine's");
  assert.ok((await collectLimits(options("sources"), { HOME: home }, now)).observations.some((row) => row.account === keys.other), "its history is still shown");
  // A machine without Codex shows another machine's Codex readings, but no Codex source of its own.
  foldMachineLimits(data("sources-bare"), elsewhere, now - 50);
  const bare = await codexSource("sources-bare", now, join(home, "no-codex", "sessions"));
  assert.deepEqual([bare.status, bare.latest], ["unavailable", null]);
  // A ledger from before other machines were folded in holds only this machine's readings, so they are its sources' too.
  const path = join(data("sources-old"), "limits-v2.json");
  await collectLimits(options("sources-old"), { HOME: home }, now - 60);
  const { sourceLatest: _, ...older } = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify(older));
  assert.equal((await codexSource("sources-old", now)).latest, now - 3600);
});

test("a machine reached twice, or this machine reached as another, counts once", () => {
  const environment2 = { FAKE_SSH_ENVS: JSON.stringify({ ...JSON.parse(environment["FAKE_SSH_ENVS"]!), "agentbox-again": { ...remoteEnvironment("agentbox-data", join(directory, "codex-agentbox")), HOME: agentHome } }) };
  const dir = saved("twice", [both[0]!, { name: "agentbox-again", ssh: "agentbox-again", user: "agent-t3", runtime: "bundled", enabled: true }, both[1]!]);
  const twice = cli(["limits", "--json", "--data-dir", dir], environment2), merged = json(twice);
  assert.deepEqual(merged.machines!.map(({ key, state, reason }) => [key, state, reason ?? null]), [["local", "ok", null], ["agentbox", "ok", null], ["agentbox-again", "failed", "same-machine"], ["box2", "ok", null]]);
  assert.deepEqual(machinesOf(merged, keys.max), ["local", "agentbox"]);
  assert.equal(merged.accounts.filter((item) => item.attribution === "profile").length, 0, "its profile-keyed readings are not counted twice");
  assert.match(twice.stderr, /^Not counting limits from agentbox-again: the same machine and account as agentbox, so its history is counted once\.\n {2}Fix: .*machines remove agentbox-again/m);
  // This machine, reached over SSH as box2, is this machine's harvest already.
  const self = json(cli(["limits", "--json", "--data-dir", dir, "--machines", "box2"], { ...environment2, SESSION_ANALYTICS_MACHINE_ID: "id-box2" }));
  assert.deepEqual(self.machines!.map(({ key, state, reason }) => [key, state, reason ?? null]), [["local", "ok", null], ["box2", "failed", "same-machine"]]);
  assert.equal(self.accounts.some((item) => item.key === keys.other && item.machines?.length), false);
  const own = cli(["limits", "--json", "--no-remote", "--identify-machine", "--data-dir", dir], { SESSION_ANALYTICS_MACHINE_ID: "fixture-machine" });
  assert.match(JSON.parse(own.stdout).machines[0].identity, /^[0-9a-f]{16}$/);
  assert.match(cli(["limits", "--json", "--identify-machine", "--data-dir", dir]).stderr, /--identify-machine describes this machine's own readings; use it with --json --no-remote/);
});

test("remote per-reading plan evidence is revalidated before API output and ledger storage", () => {
  const sentinel = "private_sentinel_content";
  const snapshot = emptyLimitsSnapshot("live", now);
  const row: LimitObservation = { provider: "codex", account: keys.codex, meter: "seven_day", windowMinutes: 10_080,
    resetsAt: now + 86_400, observedAt: now, usedPercent: 20, status: "allowed", source: "codex-session", planType: "plus" };
  const valid = validateLimitsSnapshot({ ...snapshot, observations: [row] });
  assert.equal(valid.observations[0]!.planType, "plus");
  const unsafe = validateLimitsSnapshot({ ...snapshot, observations: [{ ...row, planType: sentinel, prompt: sentinel }] });
  assert.equal(unsafe.observations[0]!.planType, "unknown");
  assert.doesNotMatch(JSON.stringify(unsafe), /private_sentinel_content/);
});
