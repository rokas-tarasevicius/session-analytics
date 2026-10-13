import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { OptionError, remoteOptionsFrom } from "../src/options.ts";
import { remoteArguments } from "../src/remote.ts";
import { duplicateMachineWarning, filteredWarning, remoteUnavailableWarning } from "../src/public/evidence.js";
import { filterSnapshot } from "../src/public/export-data.js";
import type { MachineAnalytics } from "../src/types.ts";
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "./fixtures.ts";

const run = promisify(execFile);
const bin = new URL("../bin/session-analytics.ts", import.meta.url).pathname;
const server = new URL("../src/server.ts", import.meta.url).pathname;

/**
 * A stand-in for `ssh` on PATH. It records every call, then answers as the named machine:
 * `server` runs the real report against a second fixture, `copied` prints a prepared snapshot,
 * and the others fail the way real machines do.
 */
const fakeSsh = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2), at = args.indexOf("--");
const [destination, ...command] = args.slice(at + 1);
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ options: args.slice(0, at), destination, command }) + "\\n");
const report = command.indexOf("report");
if (destination === "down") { process.stderr.write("ssh: connect to host down port 22: Connection refused\\n"); process.exit(255); }
if (destination === "old") { process.stderr.write("Unknown session analytics argument: --portable-ids\\n"); process.exit(2); }
if (destination === "missing") { process.stderr.write("bash: line 1: session-analytics: command not found\\n"); process.exit(127); }
if (destination === "noisy") { process.stdout.write("Welcome to noisy!\\n" + readFileSync(process.env.FAKE_SSH_COPIED, "utf8")); process.exit(0); }
if (destination === "copied" || destination === "elsewhere") { process.stdout.write(readFileSync(destination === "copied" ? process.env.FAKE_SSH_COPIED : process.env.FAKE_SSH_ELSEWHERE, "utf8")); process.exit(0); }
if (destination === "server") {
  const result = spawnSync(process.execPath, [process.env.FAKE_SSH_BIN, ...command.slice(report)], { env: { ...process.env, ...JSON.parse(process.env.FAKE_SSH_REMOTE_ENV) }, encoding: "utf8", maxBuffer: 1 << 28 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
}
process.exit(255);
`;

interface SshCall { options: string[]; destination: string; command: string[] }

let directory: string;
let local: SessionAnalyticsFixture;
let remote: SessionAnalyticsFixture;
let localSnapshot: MachineAnalytics;
let copiedSessions: number;
let environment: NodeJS.ProcessEnv;
let localFlags: string[];
let sshLog: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "remote-fixture-"));
  local = await createSessionAnalyticsFixture(join(directory, "local"));
  remote = await createSessionAnalyticsFixture(join(directory, "remote"));
  const copiedPath = join(directory, "copied.json"), elsewherePath = join(directory, "elsewhere.json");
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "ssh"), fakeSsh);
  await chmod(join(bin, "ssh"), 0o755);
  sshLog = join(directory, "ssh.log");
  environment = {
    ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, TZ: "UTC",
    FAKE_SSH_LOG: sshLog, FAKE_SSH_COPIED: copiedPath, FAKE_SSH_ELSEWHERE: elsewherePath, FAKE_SSH_BIN: new URL("../bin/session-analytics.ts", import.meta.url).pathname,
    FAKE_SSH_REMOTE_ENV: JSON.stringify({
      SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0", SESSION_ANALYTICS_DATA_DIR: join(directory, "remote", "data"),
      SESSION_ANALYTICS_CLAUDE_ROOT: remote.claudeRoot, SESSION_ANALYTICS_CODEX_ROOT: remote.codexRoot, SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: remote.codexArchiveRoot,
      SESSION_ANALYTICS_CONDUCTOR_DATABASE: remote.databasePath, SESSION_ANALYTICS_CURSOR_DATABASE: remote.cursorDatabasePath,
    }),
  };
  for (const key of Object.keys(environment)) if (key.startsWith("SESSION_ANALYTICS_")) delete environment[key];
  localFlags = ["--claude-root", local.claudeRoot, "--codex-root", local.codexRoot, "--codex-archive-root", local.codexArchiveRoot, "--database", local.databasePath,
    "--cursor-database", local.cursorDatabasePath, "--no-additional-providers", "--no-index", "--offline", "--data-dir", join(directory, "local", "data")];
  // This machine alone, as the CLI reports it for combination.
  localSnapshot = (await report("--portable-ids")).snapshot;
  // Another machine's distinct sessions in the same shapes.
  const { historyCoverage, ...source } = structuredClone(localSnapshot);
  const sessions = source.sessions.map((session) => ({ ...session, sessionKey: createHash("sha256").update(`copied:${session.provider}:${session.sessionKey}`).digest("hex").slice(0, 12) }));
  const copied = filterSnapshot({ ...source, sessions });
  copiedSessions = sessions.length;
  await writeFile(copiedPath, JSON.stringify(validateSnapshot({ ...copied, warnings: copied.warnings.filter((warning) => warning !== filteredWarning) })));
  await writeFile(elsewherePath, JSON.stringify({ ...JSON.parse(await readFile(copiedPath, "utf8")), velocity: { version: 1, timeZone: "Asia/Tokyo" } }));
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

async function calls(): Promise<SshCall[]> {
  return (await readFile(sshLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as SshCall);
}
async function report(...args: string[]): Promise<{ snapshot: MachineAnalytics; stderr: string }> {
  const result = await run(process.execPath, [bin, "report", "--json", ...localFlags, ...args], { env: environment, maxBuffer: 1 << 28 });
  return { snapshot: validateSnapshot(JSON.parse(result.stdout)), stderr: result.stderr };
}

test("--remote combines this machine with others read over the user's ssh", async () => {
  await rm(sshLog, { force: true });
  const { snapshot, stderr } = await report("--remote", "server,copied");
  // `server` holds the same fixture sessions (deduplicated); `copied` adds distinct ones.
  assert.equal(snapshot.summary.sessions, localSnapshot.summary.sessions + copiedSessions);
  assert.ok(snapshot.warnings.includes(duplicateMachineWarning));
  assert.ok(!snapshot.warnings.includes(remoteUnavailableWarning));
  assert.equal(snapshot.velocity?.timeZone, "UTC");
  assert.deepEqual(snapshot.repositories.map(({ repository }) => repository.id), localSnapshot.repositories.map(({ repository }) => repository.id));
  assert.match(stderr, /Read 5 sessions across 3 repositories from server\./);
  assert.match(stderr, /from copied\./);
  const recorded = await calls();
  assert.deepEqual(recorded.map(({ destination }) => destination).sort(), ["copied", "server"]);
  for (const call of recorded) {
    assert.deepEqual(call.options, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-T"]);
    assert.deepEqual(call.command, ["session-analytics", ...remoteArguments({ timeZone: "UTC", offline: true, noIndex: true, additionalProviders: false })]);
    // This machine's paths and switches that describe it stay here.
    assert.doesNotMatch(JSON.stringify(call), new RegExp(directory.replaceAll("/", "\\/")));
  }
  assert.deepEqual(recorded[0]!.command.slice(1, 6), ["report", "--json", "--portable-ids", "--time-zone", "UTC"]);
});

test("unreachable, outdated and noisy machines leave a warning and the rest of the snapshot", async () => {
  const { snapshot, stderr } = await report("--remote", "down,old,missing,noisy,elsewhere,copied", "--time-zone", "UTC");
  assert.equal(snapshot.summary.sessions, localSnapshot.summary.sessions + copiedSessions);
  assert.ok(snapshot.warnings.includes(remoteUnavailableWarning));
  assert.match(stderr, /Could not read down: SSH could not connect.*Connection refused/);
  assert.match(stderr, /Could not read old: the remote session-analytics rejected the request.*Unknown session analytics argument/);
  assert.match(stderr, /Could not read missing: the remote command was not found; set --remote-command/);
  assert.match(stderr, /Could not read noisy: the remote output was not a valid full snapshot/);
  assert.match(stderr, /Could not read elsewhere: the remote snapshot used another time zone/);
  // The warning survives a filtered export like other discovery failures.
  assert.ok(filterSnapshot(snapshot, { repositoryId: snapshot.repositories[0]!.repository.id }).warnings.includes(remoteUnavailableWarning));
  const noSsh = spawnSync(process.execPath, [bin, "report", "--json", ...localFlags, "--remote", "copied"], { env: { ...environment, PATH: join(directory, "local") }, encoding: "utf8" });
  assert.equal(noSsh.status, 0, noSsh.stderr);
  assert.match(noSsh.stderr, /Could not read copied: ssh is not available on this machine/);
});

test("--remote-command and forwarded switches reach the remote command line; local-only options are refused", async () => {
  await rm(sshLog, { force: true });
  await report("--remote", "copied", "--remote-command", "sudo -n -iu agents session-analytics", "--time-zone", "Asia/Tokyo", "--exclude-hidden", "--pricing-policy", "reviewed-only");
  const [call] = await calls();
  assert.deepEqual(call!.command.slice(0, 5), ["sudo", "-n", "-iu", "agents", "session-analytics"]);
  assert.deepEqual(call!.command.slice(5), remoteArguments({ timeZone: "Asia/Tokyo", offline: true, noIndex: true, additionalProviders: false, includeHidden: false, pricingPolicy: "reviewed-only" }));
  for (const args of [["--remote", "-oProxyCommand=touch"], ["--remote", "two words"], ["--remote", "copied,copied"], ["--remote", "copied", "--remote-command", "session-analytics; touch x"],
    ["--remote", "copied", "--remote-command", "$(touch x)"], ["--remote", "copied", "--repo-name", "conductor"], ["--remote", "copied", "--rate-card", join(directory, "card.json")]]) {
    const refused = spawnSync(process.execPath, [bin, "report", "--json", ...localFlags, ...args], { env: environment, encoding: "utf8" });
    assert.equal(refused.status, 2, args.join(" "));
    assert.equal(refused.stdout, "");
  }
  const input = join(directory, "saved.json");
  await writeFile(input, JSON.stringify(localSnapshot));
  const refused = spawnSync(process.execPath, [bin, "report", "--json", "--snapshot", input, "--remote", "copied"], { env: environment, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  // A remote configured in the environment does not apply to a saved snapshot.
  const saved = spawnSync(process.execPath, [bin, "report", "--json", "--snapshot", input], { env: { ...environment, SESSION_ANALYTICS_REMOTE: "down" }, encoding: "utf8" });
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), localSnapshot);
  assert.throws(() => remoteOptionsFrom([], { SESSION_ANALYTICS_REMOTE: "ok,-bad" }), OptionError);
  assert.deepEqual(remoteOptionsFrom([], { SESSION_ANALYTICS_REMOTE: " a , user@b.example ", SESSION_ANALYTICS_REMOTE_COMMAND: "node ~/sa/bin/session-analytics.ts" }),
    { remotes: ["a", "user@b.example"], command: ["node", "~/sa/bin/session-analytics.ts"] });
});

test("export and the dashboard read remote machines, and refresh reads them again", async () => {
  const output = join(directory, "export");
  await run(process.execPath, [bin, "export", "--format", "csv", "--out", output, ...localFlags, "--remote", "copied"], { env: environment });
  const sessions = (await readFile(join(output, "sessions.csv"), "utf8")).trim().split("\r\n");
  assert.equal(sessions.length - 1, localSnapshot.summary.sessions + copiedSessions);
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(typeof address === "object" && address ? address.port : 0)); });
  });
  await rm(sshLog, { force: true });
  const child: ChildProcess = spawn(process.execPath, [server, "--port", String(port), ...localFlags, "--remote", "copied"], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let stdout = "";
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    for (let attempt = 0; attempt < 400 && !/Analyzed/.test(stdout); attempt++) await delay(25);
    const get = async (path: string): Promise<MachineAnalytics> => (await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as MachineAnalytics;
    assert.equal((await get("/api/analytics")).summary.sessions, localSnapshot.summary.sessions + copiedSessions);
    assert.equal((await calls()).length, 1);
    await get("/api/analytics?refresh=1");
    assert.equal((await calls()).length, 2);
    assert.match(stdout, /from copied\./);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});
