import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { parseMachines, readMachines, remoteFor, writeMachines, type MachinesConfig } from "../src/machines/config.ts";
import { OptionError, remoteOptionsFrom, type RemoteMachine } from "../src/options.ts";
import { classifyRemote, requestDigest, runSsh, stderrDetail, type SshResult } from "../src/remote.ts";
import { bootstrap as bootstrapSource } from "../src/remote/bootstrap.ts";
import { buildRuntime, runtimePayload } from "../src/remote/runtime.ts";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { remoteUnavailableWarning, staleMachineWarning } from "../src/public/evidence.js";
import type { MachineAnalytics } from "../src/types.ts";
import { version } from "../src/version.ts";
import { fakeSsh } from "./fake-ssh.ts";
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "./fixtures.ts";

const run = promisify(execFile);
const bin = new URL("../bin/session-analytics.ts", import.meta.url).pathname;
const server = new URL("../src/server.ts", import.meta.url).pathname;

/** Pinned: a change to the bootstrap is a protocol change; review it, then update this hash. */
const bootstrapSha256 = "068f7720e267658f88ee9db64fabf71b921d8d494c9e18f529a01d5c6b701bf6";

interface SshCall { destination: string; words: string[] }

let directory: string;
let local: SessionAnalyticsFixture;
let remote: SessionAnalyticsFixture;
let environment: NodeJS.ProcessEnv;
let localFlags: string[];
let sshLog: string;
let localSessions: number;

const dataDir = (name: string): string => join(directory, "data", name);
const machinesFile = (name: string, config: MachinesConfig): Promise<void> => {
  writeMachines({ dataDir: dataDir(name) }, config);
  return Promise.resolve();
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "machines-fixture-"));
  local = await createSessionAnalyticsFixture(join(directory, "local"));
  remote = await createSessionAnalyticsFixture(join(directory, "remote"));
  const shim = join(directory, "bin");
  await mkdir(shim);
  await writeFile(join(shim, "ssh"), fakeSsh);
  await chmod(join(shim, "ssh"), 0o755);
  await writeFile(join(directory, "old-node.cjs"), `Object.defineProperty(process, "version", { value: "v22.3.0" });\n`);
  // The remote analysis worker never finishes, so only cancellation can end the read.
  await writeFile(join(directory, "hang.cjs"), `if (/analysis-worker\\.(?:ts|js)$/.test(process.argv[1] || "")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);\n`);
  sshLog = join(directory, "ssh.log");
  const fixtureEnvironment = (fixture: SessionAnalyticsFixture, data: string): Record<string, string> => ({
    SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0", SESSION_ANALYTICS_DATA_DIR: data,
    SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot, SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot, SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot,
    SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath, SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath,
  });
  const empty = join(directory, "nothing");
  environment = {
    ...process.env, PATH: `${shim}:${process.env["PATH"] ?? ""}`, TZ: "UTC",
    FAKE_SSH_LOG: sshLog, FAKE_SSH_HOMES: join(directory, "homes"), FAKE_SSH_OLD_NODE: join(directory, "old-node.cjs"), FAKE_SSH_BIN: bin, FAKE_SSH_HANG_SCRIPT: join(directory, "hang.cjs"),
    FAKE_SSH_ENVS: JSON.stringify({
      server: fixtureEnvironment(remote, join(directory, "remote-data")),
      "server-again": fixtureEnvironment(remote, join(directory, "remote-data")),
      slow: { ...fixtureEnvironment(remote, join(directory, "slow-data")), NODE_OPTIONS: `--require ${join(directory, "hang.cjs")}` },
      helper: fixtureEnvironment(remote, join(directory, "helper-data")),
      shared: fixtureEnvironment(remote, join(directory, "shared-data")),
      "hostonly-a": fixtureEnvironment(remote, join(directory, "hostonly-a-data")),
      "hostonly-b": fixtureEnvironment(remote, join(directory, "hostonly-b-data")),
      empty: { SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0", SESSION_ANALYTICS_DATA_DIR: join(directory, "empty-data"), SESSION_ANALYTICS_CLAUDE_ROOT: empty,
        SESSION_ANALYTICS_CODEX_ROOT: empty, SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: empty, SESSION_ANALYTICS_CONDUCTOR_DATABASE: join(empty, "db"), SESSION_ANALYTICS_CURSOR_DATABASE: join(empty, "cursor") },
    }),
  };
  for (const key of Object.keys(environment)) if (key.startsWith("SESSION_ANALYTICS_")) delete environment[key];
  localFlags = ["--claude-root", local.claudeRoot, "--codex-root", local.codexRoot, "--codex-archive-root", local.codexArchiveRoot, "--database", local.databasePath,
    "--cursor-database", local.cursorDatabasePath, "--no-additional-providers", "--no-index", "--offline"];
  const own = await run(process.execPath, [bin, "report", "--json", ...localFlags, "--no-remote", "--portable-ids"], { env: environment, maxBuffer: 1 << 28 });
  localSessions = validateSnapshot(JSON.parse(own.stdout)).summary.sessions;
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

async function calls(): Promise<SshCall[]> {
  return (await readFile(sshLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as SshCall);
}
function cli(args: string[], extra: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [bin, ...args], { env: { ...environment, ...extra }, encoding: "utf8", maxBuffer: 1 << 28 });
}
/** Processes still running from this test's fake machines. */
function leftovers(): string[] {
  return spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes(join(directory, "homes")));
}
async function noLeftovers(): Promise<string[]> {
  for (let attempt = 0; attempt < 100 && leftovers().length; attempt++) await delay(50);
  return leftovers();
}
/** The bootstrap's rule: a group of this account's own name with no other member. */
function privateGroup(gid: number): boolean {
  if (gid !== process.getgid?.()) return false;
  try {
    const user = userInfo().username;
    return readFileSync("/etc/group", "utf8").split("\n").some((line) => {
      const [name, , id, members = ""] = line.split(":");
      return name === user && id === String(gid) && members.split(",").every((member) => !member || member === user);
    });
  } catch { return false; }
}
const machine = (fields: Partial<RemoteMachine> = {}): RemoteMachine => ({ name: "box", ssh: "box", runtime: "bundled", node: "node", command: ["session-analytics"], saved: true, ...fields });
const result = (code: number | null, stderr = "", failure: SshResult["failure"] = null): SshResult => ({ code, stderr, failure, stdout: Buffer.alloc(0), ms: 1 });

test("the bootstrap is pinned and parses on old Node", () => {
  const source = bootstrapSource;
  assert.equal(createHash("sha256").update(source).digest("hex"), bootstrapSha256);
  // Syntax newer than Node 8 would hide the node-too-old message behind a SyntaxError.
  for (const modern of ["??", "?.", "catch {", "...", "class ", "async ", "await ", "**", "#"]) assert.ok(!source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n").includes(modern), modern);
});

test("the bootstrap installs on need-runtime, verifies its digest and refuses what it cannot run", async () => {
  const cache = join(directory, "bootstrap-cache");
  const payload = runtimePayload();
  const bootstrap = (mode: string, args: string[], input: string, extra: NodeJS.ProcessEnv = {}, preload: string[] = []) => spawnSync(process.execPath, [...preload, "-", "sa1", mode, ...args], { input, encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cache, ...extra } });
  const name = `${payload.version}-${payload.digest.slice(0, 16)}`;
  let answer = bootstrap("run", [payload.version, payload.digest, "--version"], payload.run);
  assert.deepEqual([answer.status, answer.stderr], [75, "sa1: need-runtime\n"]);
  answer = bootstrap("install", [payload.version, payload.digest.replace(/^./, (digit) => digit === "0" ? "1" : "0"), "--version"], payload.install);
  assert.deepEqual([answer.status, answer.stderr], [81, "sa1: digest-mismatch\n"]);
  assert.deepEqual(await readdir(join(cache, "session-analytics", "runtime")).catch(() => []), []);
  // Older runtimes beyond the newest three and 14 days are pruned; recent ones stay.
  const root = join(cache, "session-analytics", "runtime");
  const old = new Date(Date.now() - 30 * 86_400_000);
  for (const [index, sibling] of ["0.1.0-aaaaaaaaaaaaaaaa", "0.2.0-bbbbbbbbbbbbbbbb", "0.3.0-cccccccccccccccc", "0.4.0-dddddddddddddddd"].entries()) {
    await mkdir(join(root, sibling), { recursive: true });
    const time = index === 3 ? new Date() : new Date(old.getTime() + index * 1000);
    await utimes(join(root, sibling), time, time);
  }
  answer = bootstrap("install", [payload.version, payload.digest, "--version"], payload.install);
  assert.equal(answer.status, 0, answer.stderr);
  assert.equal(answer.stdout.trim(), payload.version);
  assert.deepEqual((await readdir(root)).sort(), ["0.3.0-cccccccccccccccc", "0.4.0-dddddddddddddddd", name].sort());
  assert.equal((await stat(join(root, name))).mode & 0o777, 0o700);
  answer = bootstrap("run", [payload.version, payload.digest, "--version"], payload.run);
  assert.deepEqual([answer.status, answer.stdout.trim()], [0, payload.version]);
  // A damaged cache is detected and reported as need-runtime again.
  await writeFile(join(root, name, "package.json"), "{}");
  assert.equal(bootstrap("run", [payload.version, payload.digest, "--version"], payload.run).status, 75);
  assert.deepEqual([bootstrap("run", ["0.9", payload.digest], payload.run).status, bootstrap("run", [payload.version, "abc"], payload.run).status, bootstrap("install", [payload.version, payload.digest], payload.run).status], [79, 79, 79]);
  answer = bootstrap("run", [payload.version, payload.digest], payload.run, {}, ["--require", join(directory, "old-node.cjs")]);
  assert.deepEqual([answer.status, answer.stderr], [78, "sa1: node-too-old v22.3.0\n"]);
  const locked = join(directory, "locked-cache");
  await mkdir(locked, { mode: 0o500 });
  answer = bootstrap("install", [payload.version, payload.digest], payload.install, { XDG_CACHE_HOME: locked });
  assert.equal(answer.status, 80);
  assert.match(answer.stderr, /^sa1: cache-unwritable E[A-Z]+\n$/);
  // A cache another account could swap between verification and start is refused, even with a good runtime in it.
  const linked = join(directory, "linked-cache"), elsewhere = join(directory, "elsewhere-cache");
  await mkdir(linked);
  await mkdir(join(elsewhere, "runtime"), { recursive: true });
  await symlink(elsewhere, join(linked, "session-analytics"));
  const shared = join(directory, "shared-cache");
  await mkdir(shared);
  await chmod(shared, 0o777);
  // So is one inside a directory others can write to, at any level, as OpenSSH's StrictModes would say.
  const open = join(directory, "open-parent"), below = join(open, "cache");
  await mkdir(below, { recursive: true });
  await chmod(open, 0o777);
  // The message names the directory at fault: the link itself, or the open directory as the walk up resolved it.
  for (const [unsafe, named] of [[linked, join(linked, "session-analytics")], [shared, await realpath(shared)], [below, await realpath(open)]] as const) {
    for (const [mode, input] of [["run", payload.run], ["install", payload.install]] as const) {
      answer = bootstrap(mode, [payload.version, payload.digest, "--version"], input, { XDG_CACHE_HOME: unsafe });
      assert.deepEqual([answer.status, answer.stderr], [80, `sa1: cache-unwritable not-private ${named}\n`], `${unsafe} ${mode}`);
    }
  }
  // A group-writable parent is refused too, unless the group is this account's own private group.
  const grouped = join(directory, "group-cache");
  await mkdir(grouped);
  await chmod(grouped, 0o770);
  answer = bootstrap("install", [payload.version, payload.digest, "--version"], payload.install, { XDG_CACHE_HOME: grouped });
  assert.equal(answer.status, privateGroup((await stat(grouped)).gid) ? 0 : 80, answer.stderr);
  // A shared sticky directory such as /tmp is fine: no one else can rename what this account creates there.
  await chmod(shared, 0o1777);
  answer = bootstrap("install", [payload.version, payload.digest, "--version"], payload.install, { XDG_CACHE_HOME: shared });
  assert.deepEqual([answer.status, answer.stdout.trim()], [0, payload.version], answer.stderr);
  // Runtime directories opened up by hand are made private again; one others could write to is emptied, not trusted.
  await chmod(root, 0o755);
  assert.equal(bootstrap("run", [payload.version, payload.digest, "--version"], payload.run).status, 75);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  const sharedRoot = join(shared, "session-analytics", "runtime");
  assert.deepEqual((await readdir(sharedRoot)).filter((entry) => !entry.startsWith(".")), [name]);
  await chmod(sharedRoot, 0o777);
  assert.equal(bootstrap("run", [payload.version, payload.digest, "--version"], payload.run, { XDG_CACHE_HOME: shared }).status, 75);
  assert.deepEqual(await readdir(sharedRoot), []);
  assert.equal((await stat(sharedRoot)).mode & 0o777, 0o700);
  // A runtime directory that is a link is removed rather than followed.
  await symlink(join(root, name), join(sharedRoot, name));
  assert.equal(bootstrap("run", [payload.version, payload.digest, "--version"], payload.run, { XDG_CACHE_HOME: shared }).status, 75);
  assert.deepEqual(await readdir(sharedRoot), []);
  // Only an entry point the verified manifest lists runs: a stray bin/session-analytics.js next to the source is ignored.
  answer = bootstrap("install", [payload.version, payload.digest, "--version"], payload.install, { XDG_CACHE_HOME: shared });
  assert.equal(answer.status, 0, answer.stderr);
  await writeFile(join(sharedRoot, name, "bin", "session-analytics.js"), `process.stdout.write("planted\\n");\n`);
  answer = bootstrap("run", [payload.version, payload.digest, "--version"], payload.run, { XDG_CACHE_HOME: shared });
  assert.deepEqual([answer.status, answer.stdout.trim()], [0, payload.version], answer.stderr);
  // A relative XDG_CACHE_HOME is ignored in favour of ~/.cache, like the XDG specification says.
  answer = bootstrap("run", [payload.version, payload.digest], payload.run, { XDG_CACHE_HOME: "relative", HOME: join(directory, "relative-home") });
  assert.equal(answer.status, 75);
});

test("the bundled runtime packs a compiled install too and runs its bin/session-analytics.js", async () => {
  const root = join(directory, "compiled");
  for (const folder of ["bin", "src/remote", "data", "schemas"]) await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, "package.json"), `{"type":"module"}\n`);
  await writeFile(join(root, "bin", "session-analytics.js"), `process.stdout.write("compiled " + process.argv.slice(2).join(" ") + "\\n");\n`);
  await writeFile(join(root, "src", "remote", "runtime.js"), "export {};\n");
  await writeFile(join(root, "src", ".DS_Store"), "skipped");
  const payload = buildRuntime(root);
  assert.equal(payload.files, 3);
  assert.notEqual(payload.digest, runtimePayload().digest);
  const answer = spawnSync(process.execPath, ["-", "sa1", "install", payload.version, payload.digest, "report", "--json"], {
    input: payload.install, encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: join(directory, "compiled-cache") },
  });
  assert.equal(answer.status, 0, answer.stderr);
  assert.equal(answer.stdout.trim(), "compiled report --json");
});

test("exit codes and stderr map to fixed reasons with the exact fix", () => {
  const saved = machine({ user: "agents" }), adhoc = machine({ name: "server", ssh: "server", runtime: "installed", saved: false });
  const cases: Array<[RemoteMachine, SshResult, string, RegExp]> = [
    [saved, result(255, "Host key verification failed.\n"), "connection", /ssh box true once in a terminal/],
    [saved, result(255, "ssh: connect to host box port 22: Connection refused\n"), "connection", /check that box is up/],
    [saved, result(255, "ssh: Could not resolve hostname box: nodename nor servname provided\n"), "unknown-host", /ssh -G box/],
    [saved, result(255, "fake@box: Permission denied (publickey).\n"), "login-refused", /key passphrase.*ssh-add.*ssh-copy-id box/],
    [saved, { ...result(1), stdout: Buffer.from("This account is currently not available.\n") }, "login-shell", /machines set box --no-login-shell/],
    [adhoc, result(null, "", "local-runtime"), "local-runtime", /reinstall session-analytics on this machine/],
    [saved, result(255, ""), "dropped", /machines check box/],
    [saved, result(1, "sudo: a password is required\n"), "sudo", /ALL=\(agents\) NOPASSWD: ALL.*sudoers\.d\/session-analytics/],
    [saved, result(1, "sudo: interactive authentication is required\n"), "sudo", /NOPASSWD/],
    [saved, result(1, "sudo: unknown user agents\n"), "no-account", /machines check box --find-users/],
    [saved, result(1, "sudo: user 'agents' not found\n"), "no-account", /--find-users/],
    [saved, result(127, "-bash: line 1: node: command not found\n"), "no-node", /machines set box --node \/usr\/bin\/node/],
    [saved, result(78, "sa1: node-too-old v18.19.1\n"), "node-too-old", /Node\.js 24/],
    [saved, result(80, "sa1: cache-unwritable EACCES\n"), "cache-unwritable", /machines set box --runtime installed/],
    [saved, result(81, "sa1: digest-mismatch\n"), "corrupted", /retry/],
    [saved, result(79, "sa1: bad-request\n"), "runtime", /machines check box/],
    [adhoc, result(127, "bash: line 1: session-analytics: command not found\n"), "missing-command", /machines add server.*--remote-command "node \/path/],
    [adhoc, result(126, "bash: line 1: /usr/local/bin/session-analytics: Permission denied\n"), "permission", /machines add server/],
    [adhoc, result(1, "node:internal/modules/cjs/loader:1386\n  throw err;\nError: Cannot find module '/nope/bin/session-analytics.ts'\n    at Module._resolveFilename\n\nNode.js v24.21.0\n"), "missing-command", /--remote-command "node \/path/],
    [adhoc, result(1, "sudo: user 'agents' not found\n"), "no-account", /--remote-command/],
    [adhoc, result(2, "Unknown session analytics argument: --no-remote\n"), "rejected", /same version/],
    [adhoc, result(1, "The local index is busy; another ingest or maintenance command is running.\n"), "busy", /retry in a minute/],
    [adhoc, result(1, "The local index was created by a newer version; upgrade or use --no-index.\n"), "index-newer", /--no-index/],
    [adhoc, result(1, "node:internal/modules/run_main:123\n    triggerUncaughtException(\nError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension \".ts\"\n    at Object.getFileProtocolModuleFormat\n\nNode.js v20.11.0\n"), "node-too-old", /Node\.js 24/],
    [adhoc, result(1, "TypeError: boom\n    at main (file.ts:1:1)\n\nNode.js v24.21.0\n"), "analysis", /machines add server/],
    [saved, result(null, "", "timeout"), "timeout", /--remote-timeout SECONDS.*machines check box/],
    [saved, result(null, "", "too-large"), "too-large", /--exclude-hidden/],
  ];
  for (const [target, outcome, reason, fix] of cases) {
    const error = classifyRemote(target, outcome, 300_000);
    assert.equal(error?.reason, reason, outcome.stderr);
    assert.match(error.fix, fix, reason);
  }
  assert.equal(classifyRemote(saved, result(0)), null);
  // The useful line, never Node's version trailer or a stack frame.
  assert.equal(classifyRemote(adhoc, result(1, "TypeError: boom\n    at main (file.ts:1:1)\n\nNode.js v24.21.0\n"))!.detail, "TypeError: boom");
  assert.equal(stderrDetail("Welcome!\n\u001b[31msudo: a password is required\u001b[0m\n\n"), "[31msudo: a password is required[0m");
  // C1 controls (an 8-bit CSI) and bidirectional overrides never reach the terminal either.
  assert.equal(stderrDetail("Error: boom \u009b2J\u202eevil\u200b\n"), "Error: boom 2Jevil");
  assert.equal(stderrDetail("\n\n\n"), "");
  assert.match(classifyRemote(saved, result(78, "sa1: node-too-old v18.19.1\n"))!.message, /v18\.19\.1/);
  assert.equal(classifyRemote(adhoc, result(1, "sudo: user 'agents' not found\n"))!.message, "the account named after sudo does not exist there");
  assert.equal(classifyRemote(saved, result(1, "sudo: user 'agents' not found\n"))!.message, "the account agents does not exist there");
  // A Node.js path that was given is what is missing, not the login PATH, and the fix names the way back to it.
  const pinned = classifyRemote(machine({ node: "/opt/node/bin/node" }), result(127, "-bash: line 1: /opt/node/bin/node: command not found\n"))!;
  assert.equal(pinned.message, "/opt/node/bin/node was not found there");
  assert.match(pinned.fix, /machines set box --node \/path\/to\/node, or --node node to use the login PATH$/);
  const adding = classifyRemote(machine({ node: "/opt/node/bin/node", saved: false }), result(127))!;
  assert.match(adding.fix, /machines add box --node \/path\/to\/node, or leave out --node to use the login PATH$/);
  assert.equal(classifyRemote(saved, result(127))!.message, "node was not found on agents's login PATH");
});

test("failed machine snapshots keep destinations, accounts, paths and stderr in this terminal only", async () => {
  const data = dataDir("private-failures");
  await machinesFile("private-failures", { version: 1, machines: [
    { name: "box", ssh: "SECRET-HOST", user: "secret-account", runtime: "bundled", enabled: true },
    { name: "lockbox", ssh: "server", user: "locked", runtime: "bundled", enabled: true },
    { name: "nodebox", ssh: "SECRET-NODE-HOST", node: "/SECRET/PATH/node", runtime: "bundled", enabled: true },
  ] });
  const read = cli(["report", "--json", ...localFlags, "--data-dir", data], { FAKE_SSH_DOWN: "SECRET-HOST" });
  assert.equal(read.status, 0, read.stderr);
  const snapshot = validateSnapshot(JSON.parse(read.stdout));
  assert.deepEqual(snapshot.machines!.slice(1).map(({ reason }) => reason), ["connection", "sudo", "no-node"]);
  assert.ok(snapshot.machines!.slice(1).every(({ fix }) => fix));
  assert.doesNotMatch(read.stdout, /SECRET|secret-account|locked|Connection refused/);
  assert.match(read.stderr, /SECRET-HOST.*Connection refused/);
  assert.match(read.stderr, /SECRET\/PATH/);
});

test("machines.json is strict, private and decides which machines a run reads", async () => {
  const valid: MachinesConfig = { version: 1, local: { label: "laptop" }, machines: [
    { name: "agentbox", ssh: "agentbox", user: "agent-t3", runtime: "bundled", enabled: true, addedAt: "2026-10-14T11:00:00Z" },
    { name: "build", ssh: "ci@build-box", runtime: "installed", command: ["session-analytics"], enabled: true },
    { name: "old", ssh: "old", runtime: "bundled", node: "/usr/bin/node", enabled: false },
  ] };
  assert.deepEqual(parseMachines(structuredClone(valid)), valid);
  const broken = (change: (config: Record<string, unknown> & { machines: Array<Record<string, unknown>> }) => void): void => {
    const config = structuredClone(valid) as unknown as Record<string, unknown> & { machines: Array<Record<string, unknown>> };
    change(config);
    assert.throws(() => parseMachines(config), OptionError);
  };
  broken((config) => { config["version"] = 2; });
  broken((config) => { config["extra"] = true; });
  broken((config) => { config.machines[0]!["name"] = "local"; });
  broken((config) => { config.machines[0]!["name"] = "-flag"; });
  broken((config) => { config.machines[1]!["name"] = "AGENTBOX"; });
  broken((config) => { config.machines[0]!["ssh"] = "-oProxyCommand=touch"; });
  broken((config) => { config.machines[0]!["user"] = "Agent T3"; });
  broken((config) => { config.machines[0]!["user"] = "$(id)"; });
  broken((config) => { config.machines[2]!["node"] = "~/bin/node"; });
  broken((config) => { config.machines[2]!["node"] = "/usr/bin/node; rm"; });
  broken((config) => { config.machines[1]!["command"] = ["session-analytics;", "touch"]; });
  broken((config) => { config.machines[0]!["command"] = ["session-analytics"]; });
  broken((config) => { config.machines[0]!["runtime"] = "docker"; });
  broken((config) => { config.machines[0]!["identity"] = "secret"; });
  broken((config) => { config.machines[0]!["prompt"] = "hello"; });
  // ~ after sudo would expand to the SSH user's home.
  broken((config) => { config.machines[1]!["user"] = "agents"; config.machines[1]!["command"] = ["node", "~/sa/bin/session-analytics.ts"]; });

  const data = dataDir("strict");
  assert.equal(readMachines({ dataDir: data }), null);
  writeMachines({ dataDir: data }, valid);
  assert.equal((await stat(join(data, "machines.json"))).mode & 0o777, 0o600);
  assert.deepEqual(readMachines({ dataDir: data }), valid);
  assert.deepEqual((await readdir(data)).sort(), ["machines.json"]);
  await writeFile(join(data, "machines.json"), JSON.stringify({ ...valid, version: 7 }));
  assert.throws(() => remoteFor([], {}, { dataDir: data }), (error) => error instanceof OptionError && /machines\.json is invalid: its version is not 1/.test(error.message));
  // An explicit choice does not depend on a broken file.
  assert.deepEqual(remoteFor(["--no-remote"], {}, { dataDir: data }).machines, []);
  writeMachines({ dataDir: data }, valid);

  // Saved: only enabled machines, in order, with the generated sudo account.
  const saved = remoteOptionsFrom([], {}, valid);
  assert.deepEqual(saved.machines.map(({ name, runtime, user, saved: own }) => [name, runtime, user, own]), [["agentbox", "bundled", "agent-t3", true], ["build", "installed", undefined, true]]);
  assert.equal(saved.local, "laptop");
  assert.match(saved.digest!, /^[0-9a-f]{64}$/);
  assert.equal(remoteOptionsFrom([], {}, structuredClone(valid)).digest, saved.digest);
  assert.notEqual(remoteOptionsFrom([], {}, { ...valid, machines: valid.machines.map((entry) => entry.name === "agentbox" ? { ...entry, user: "agents" } : entry) }).digest, saved.digest);
  // A newly recorded check changes duplicate-machine handling even when the SSH target stays the same.
  assert.notEqual(remoteOptionsFrom([], {}, { ...valid, machines: valid.machines.map((entry) => ({ ...entry, identity: "0123456789abcdef" })) }).digest, saved.digest);
  // --machines narrows to saved machines, including a disabled one asked for by name.
  assert.deepEqual(remoteOptionsFrom(["--machines", "OLD,agentbox"], {}, valid).machines.map(({ name }) => name), ["old", "agentbox"]);
  assert.throws(() => remoteOptionsFrom(["--machines", "missing"], {}, valid), OptionError);
  assert.throws(() => remoteOptionsFrom(["--machines", "build", "--machines", "old"], {}, valid), OptionError);
  // Precedence: --no-remote, then --remote, then the deprecated variable, then the file.
  assert.deepEqual(remoteOptionsFrom(["--no-remote"], { SESSION_ANALYTICS_REMOTE: "elsewhere" }, valid).machines, []);
  assert.deepEqual(remoteOptionsFrom(["--remote", "a"], { SESSION_ANALYTICS_REMOTE: "elsewhere" }, valid).machines.map(({ ssh, runtime, saved: own }) => [ssh, runtime, own]), [["a", "installed", false]]);
  assert.deepEqual(remoteOptionsFrom([], { SESSION_ANALYTICS_REMOTE: "elsewhere" }, valid).machines.map(({ ssh }) => ssh), ["elsewhere"]);
  // An explicit --machines wins over the deprecated variable, which still gets its notice.
  assert.deepEqual(remoteOptionsFrom(["--machines", "build"], { SESSION_ANALYTICS_REMOTE: "elsewhere" }, valid).machines.map(({ name }) => name), ["build"]);
  const deprecated: string[] = [];
  assert.deepEqual(remoteFor(["--machines", "build"], { SESSION_ANALYTICS_REMOTE: "elsewhere" }, { dataDir: data }, (line) => deprecated.push(line)).machines.map(({ name }) => name), ["build"]);
  assert.match(deprecated.join(), /SESSION_ANALYTICS_REMOTE is deprecated/);
  for (const argv of [["--no-remote", "--machines", "build"], ["--remote", "a", "--machines", "build"], ["--remote-command", "session-analytics"], ["--remote-timeout", "0"], ["--remote-timeout", "1.5"]]) {
    assert.throws(() => remoteOptionsFrom(argv, {}, valid), OptionError, argv.join(" "));
  }
  assert.equal(remoteOptionsFrom(["--remote-timeout", "45"], {}, valid).timeoutMs, 45_000);
  assert.equal(remoteOptionsFrom([], { SESSION_ANALYTICS_REMOTE_TIMEOUT: "9" }, valid).timeoutMs, 9_000);
  // Saved machines step aside for options that describe this machine alone; explicit ones refuse them.
  const notices: string[] = [];
  assert.deepEqual(remoteFor(["--repo-name", "x"], {}, { dataDir: data, repositoryName: "x" }, (line) => notices.push(line)).machines, []);
  assert.match(notices.join(), /Saved machines are not read/);
  remoteFor([], { SESSION_ANALYTICS_REMOTE: "elsewhere" }, { dataDir: data }, (line) => notices.push(line));
  assert.match(notices.join(), /SESSION_ANALYTICS_REMOTE is deprecated/);
});

test("machines add, list, set, rename and remove keep a valid private file", async () => {
  const data = dataDir("cli");
  const added = cli(["machines", "add", "server", "--user", "agents", "--data-dir", data, "--remote-timeout", "60"]);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /^server {2}\(ssh server, as agents, bundled runtime\)\n {2}✓ ssh .*\n {2}✓ sudo .*\n {2}✓ node .*\n {2}✓ machine .*\n {2}✓ runtime .*installed now.*\n {2}✓ history {3}5 sessions, 3 repositories in \d+\.\d s\n/);
  assert.match(added.stdout, /bundled runtime is this session-analytics .* agents's ~\/\.cache\/session-analytics\/runtime on server/);
  assert.match(added.stdout, /Saved server\. A plain session-analytics now reads this machine and server\./);
  let config = readMachines({ dataDir: data })!;
  assert.deepEqual(config.machines.map(({ name, ssh, user, runtime, enabled }) => ({ name, ssh, user, runtime, enabled })), [{ name: "server", ssh: "server", user: "agents", runtime: "bundled", enabled: true }]);
  assert.match(config.machines[0]!.identity!, /^[0-9a-f]{16}$/);
  // The same machine and account under another alias, this machine itself, and an unreachable one are not saved.
  // While adding, a fix never names a machine that is not saved.
  const twin = cli(["machines", "add", "server-again", "--user", "agents", "--data-dir", data]);
  assert.equal(twin.status, 1);
  assert.match(twin.stdout, /✗ machine {3}the same machine and account as server; reading both would count its history twice\n {4}Fix: it is already saved as server; if they are different machines cloned from one image, set SESSION_ANALYTICS_MACHINE_ID/);
  const down = cli(["machines", "add", "down", "--data-dir", data]);
  assert.equal(down.status, 1);
  assert.match(down.stdout, /✗ ssh .*SSH could not connect.*Connection refused\n {4}Fix: check that down is up and its SSH server is reachable from here, then run ssh down true once in a terminal/);
  assert.match(down.stderr, /Not saved/);
  // A mistyped account is not saved either, and the accounts with history are listed with the command to use one.
  const typo = cli(["machines", "add", "server", "--user", "ghost", "--name", "ghostbox", "--data-dir", data]);
  assert.equal(typo.status, 1, typo.stdout);
  assert.match(typo.stdout, /✗ sudo {6}the account ghost does not exist there\. sudo: unknown user ghost\n {4}Fix: check the account name; session-analytics machines add server --find-users lists the accounts with agent history\n {2}✓ accounts {2}agent history found for agents, svc \(no login shell\)\n {4}Fix: session-analytics machines add server --user ACCOUNT, where ACCOUNT is one of agents, svc\n/);
  assert.doesNotMatch(typo.stdout, /bundled runtime is|Saved/);
  assert.match(typo.stderr, /Not saved/);
  // Read as the SSH account with no history: saved, and the closing line names the accounts that have some.
  const empty = cli(["machines", "add", "empty", "--data-dir", data]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /! history {3}no agent history for ssh-user \(0 sessions in \d+\.\d s\)\n {4}Fix: if agents run as another account there: session-analytics machines set empty --user ACCOUNT, where ACCOUNT is one of agents, svc\n/);
  assert.match(empty.stdout, /\nSaved empty\. A plain session-analytics now reads this machine and server, empty\.\nIt has no agent history for that account yet; if agents run as another account there: session-analytics machines set empty --user ACCOUNT/);
  assert.equal(cli(["machines", "remove", "empty", "--data-dir", data]).status, 0);
  // A service account's nologin shell refuses sudo -i: saved with the fix, and read without a login shell after it.
  const service = cli(["machines", "add", "server", "--user", "svc", "--name", "svcbox", "--data-dir", data]);
  assert.equal(service.status, 0, service.stderr);
  assert.match(service.stdout, /✗ sudo {6}svc's login shell refuses to run commands \(nologin or false\)\n {4}Fix: read it without a login shell: session-analytics machines set svcbox --no-login-shell/);
  assert.match(service.stdout, /\nSaved svcbox, but it cannot be read until this is fixed: read it without a login shell/);
  assert.doesNotMatch(service.stdout, /bundled runtime is/);
  assert.equal(cli(["machines", "set", "svcbox", "--no-login-shell", "--data-dir", data]).status, 0);
  const serviceCheck = cli(["machines", "check", "svcbox", "--data-dir", data]);
  assert.equal(serviceCheck.status, 0, serviceCheck.stdout);
  assert.match(serviceCheck.stdout, /^svcbox {2}\(ssh server, as svc without a login shell, bundled runtime\)\n {2}✓ ssh .*\n {2}✓ sudo {6}sudo -n -H -u svc works without a password\n/);
  assert.ok((await calls()).some(({ words }) => words.slice(0, 5).join(" ") === "sudo -n -H -u svc"));
  assert.equal(cli(["machines", "remove", "svcbox", "--data-dir", data]).status, 0);
  // An address names itself rather than by its first octet.
  const address = cli(["machines", "add", "192.168.1.20", "--no-check", "--data-dir", data]);
  assert.match(address.stdout, /Saved 192-168-1-20\./);
  assert.match(address.stdout, /copied on the first read into your ~\/\.cache/);
  assert.equal(cli(["machines", "remove", "192-168-1-20", "--data-dir", data]).status, 0);
  const duplicate = cli(["machines", "add", "other@server", "--name", "SERVER", "--data-dir", data, "--no-check"]);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /already saved/);
  for (const args of [["add", "-oProxyCommand=x"], ["add", "box", "--user", "Bad User"], ["add", "box", "--no-login-shell", "--no-check"], ["set", "server", "--login-shell", "--no-login-shell"], ["add", "box", "--node", "~/node"], ["add", "box", "--command", "x", "--runtime", "bundled"], ["add", "box", "--user", "a", "--command", "node ~/sa.ts"], ["add", "box", "--name", "local"], ["add", "box", "--no-check", "--no-check"], ["set", "missing", "--enable"], ["rename", "server", "bad label"], ["frobnicate"]]) {
    const refused = cli(["machines", ...args, "--data-dir", data]);
    assert.equal(refused.status, 2, args.join(" "));
  }
  assert.equal(cli(["machines", "add", "build.example.com", "--runtime", "installed", "--no-check", "--data-dir", data]).status, 0);
  assert.equal(cli(["machines", "set", "build", "--disable", "--data-dir", data]).status, 0);
  assert.equal(cli(["machines", "set", "server", "--no-user", "--node", "/usr/bin/node", "--data-dir", data]).status, 0);
  assert.equal(cli(["machines", "rename", "local", "laptop", "--data-dir", data]).status, 0);
  assert.equal(cli(["machines", "rename", "server", "agentbox", "--data-dir", data]).status, 0);
  config = readMachines({ dataDir: data })!;
  assert.equal(config.local?.label, "laptop");
  assert.deepEqual(config.machines.map(({ name, ssh, user, node, runtime, enabled, identity }) => ({ name, ssh, user, node, runtime, enabled, identity })), [
    { name: "agentbox", ssh: "server", user: undefined, node: "/usr/bin/node", runtime: "bundled", enabled: true, identity: undefined },
    { name: "build", ssh: "build.example.com", user: undefined, node: undefined, runtime: "installed", enabled: false, identity: undefined },
  ]);
  const listed = cli(["machines", "list", "--data-dir", data]);
  assert.match(listed.stdout, /This machine: laptop\nNAME +SSH +ACCOUNT +RUNTIME +STATE\nagentbox +server +- +bundled \(\/usr\/bin\/node\) +enabled\nbuild +build\.example\.com +- +installed: session-analytics +disabled\n/);
  assert.deepEqual(JSON.parse(cli(["machines", "list", "--json", "--data-dir", data]).stdout), config);
  assert.equal(cli(["machines", "remove", "build", "--data-dir", data]).status, 0);
  assert.deepEqual(readMachines({ dataDir: data })!.machines.map(({ name }) => name), ["agentbox"]);
  assert.equal((await stat(join(data, "machines.json"))).mode & 0o777, 0o600);
  assert.match(cli(["machines", "--help"]).stdout, /machines add <ssh-dest>/);
  assert.match(cli(["--help"]).stdout, /machines <command>/);
});

test("machines check is a doctor: each failure names its fix, and --find-users lists accounts by name", async () => {
  const data = dataDir("check");
  await machinesFile("check", { version: 1, machines: [
    { name: "server", ssh: "server", user: "agents", runtime: "bundled", enabled: true },
    { name: "locked", ssh: "server", user: "locked", runtime: "bundled", enabled: true },
    { name: "nonode", ssh: "nonode", runtime: "bundled", enabled: true },
    { name: "oldnode", ssh: "oldnode", runtime: "bundled", enabled: true },
    { name: "chatty", ssh: "chatty", runtime: "bundled", enabled: true },
    { name: "missing", ssh: "server", user: "ssh-user", runtime: "installed", command: ["/opt/missing/session-analytics"], enabled: false },
    { name: "shared", ssh: "shared", runtime: "bundled", enabled: true },
  ] });
  const checked = cli(["machines", "check", "--data-dir", data, "--find-users"]);
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /server {2}\(ssh server, as agents, bundled runtime\)\n(?: {2}✓ .*\n)+ {2}✓ history {3}\d+ sessions, \d+ repositories in \d+\.\d s\n {2}✓ accounts {2}agent history found for agents, svc \(no login shell\)\n(?! {4}Fix)/);
  assert.match(checked.stdout, /locked .*\n {2}✓ ssh .*\n {2}✗ sudo {6}sudo -n could not run commands as locked without a password\. sudo: a password is required\n {4}Fix: on that machine run: echo "\$USER ALL=\(locked\) NOPASSWD: ALL"/);
  assert.match(checked.stdout, /locked[\s\S]*✓ accounts {2}agent history found for agents, svc \(no login shell\)\n {4}Fix: session-analytics machines set locked --user ACCOUNT, where ACCOUNT is one of agents, svc\n/);
  // A login that works only through a shared connection someone else opened is a warning with its fix, not a pass.
  assert.match(checked.stdout, /shared {2}\(ssh shared, bundled runtime\)\n {2}! ssh {7}connected in \d+\.\d s, but only through an open shared connection; on its own: SSH refused the login without a prompt\. fake@shared: Permission denied \(publickey\)\.\n {4}Fix: run ssh shared true in a terminal\. If it asks for a key passphrase, load the key into your agent/);
  assert.match(checked.stdout, /shared[^]*✓ history/);
  assert.match(checked.stdout, /✗ node {6}node was not found on the SSH account's login PATH\n {4}Fix: install Node\.js 24 or later there, or point to it: session-analytics machines set nonode --node \/usr\/bin\/node/);
  assert.match(checked.stdout, /oldnode .*\n(?: {2}✓ .*\n)+ {2}✗ runtime {3}the remote Node\.js is v22\.3\.0; the bundled runtime needs 24 or later\. sa1: node-too-old v22\.3\.0\n/);
  assert.match(checked.stdout, /missing  \(ssh server, as ssh-user, installed: \/opt\/missing\/session-analytics, disabled\)[\s\S]*✗ command {3}session-analytics was not found there/);
  assert.match(checked.stdout, /chatty .*\n {2}✓ ssh .*\n {2}✗ node {6}the remote answered the machine probe with something else\n {4}Fix: make sure nothing in that account's login profile prints to stdout\n/);
  assert.doesNotMatch(checked.stdout, /Welcome/);
  assert.match(checked.stdout, /locked, nonode, oldnode, chatty, missing failed a check/);
  const json = JSON.parse(cli(["machines", "check", "server", "--json", "--data-dir", data]).stdout) as { machines: Array<{ name: string; ok: boolean; checks: Array<{ check: string; status: string }> }> };
  assert.deepEqual(json.machines.map(({ name, ok, checks }) => [name, ok, checks.map(({ check, status }) => `${check}:${status}`)]),
    [["server", true, ["ssh:ok", "sudo:ok", "node:ok", "machine:ok", "runtime:ok", "history:ok"]]]);
  assert.doesNotMatch(JSON.stringify(json), /id-server|machine-id/);
  assert.match(readMachines({ dataDir: data })!.machines[0]!.identity!, /^[0-9a-f]{16}$/);
  assert.equal(cli(["machines", "check", "nowhere", "--data-dir", data]).status, 2);
});

test("a plain report reads saved machines with the bundled runtime: install once, then run from the cache", async () => {
  const data = dataDir("report");
  await machinesFile("report", { version: 1, local: { label: "laptop" }, machines: [
    { name: "server", ssh: "server", user: "agents", runtime: "bundled", enabled: true },
    { name: "empty", ssh: "empty", runtime: "bundled", enabled: true },
    { name: "down", ssh: "down", runtime: "bundled", enabled: true },
  ] });
  await rm(join(directory, "homes", "server"), { recursive: true, force: true });
  await rm(sshLog, { force: true });
  const first = cli(["report", ...localFlags, "--data-dir", data]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^Session Analytics · laptop, server and empty \(not read: down\)\n/);
  assert.match(first.stderr, /Read 5 sessions across 3 repositories from server in \d+\.\d s\./);
  assert.match(first.stderr, /empty: no agent history for this account \(0 sessions read\)\.\n {2}Fix: if agents run as another account there: session-analytics machines set empty --user NAME/);
  assert.match(first.stderr, /Could not read down: SSH could not connect/);
  // The header lists what was read, with counts and timing, and each machine not read with its reason and fix.
  assert.match(first.stdout, /\nMachines: 3 of 4 read now\n {2}laptop {2}\d+ sessions, \d+ repositories in \d+\.\d s\n {2}server {2}5 sessions, 3 repositories in \d+\.\d s\n {2}empty {3}0 sessions, 0 repositories in \d+\.\d s \(no history for this account\)\n {4}Fix: if agents run as another account there: session-analytics machines set empty --user NAME.*\n {2}down {4}not read: unreachable\n {4}Fix: run session-analytics machines check down/);
  assert.deepEqual((await calls()).filter(({ destination }) => destination === "server").map(({ words }) => words[7]), ["run", "install"]);
  assert.deepEqual((await calls()).find(({ destination }) => destination === "server")!.words.slice(0, 6), ["sudo", "-n", "-iu", "agents", "node", "-"]);
  await rm(sshLog, { force: true });
  const json = cli(["report", "--json", ...localFlags, "--data-dir", data]);
  const snapshot = validateSnapshot(JSON.parse(json.stdout));
  assert.ok(snapshot.warnings.includes(remoteUnavailableWarning));
  assert.equal(snapshot.summary.sessions, localSessions);
  assert.deepEqual((await calls()).filter(({ destination }) => destination === "server").map(({ words }) => words[7]), ["run"]);
  // --machines narrows; --no-remote reads nothing else.
  await rm(sshLog, { force: true });
  assert.equal(cli(["report", "--json", ...localFlags, "--data-dir", data, "--machines", "empty"]).status, 0);
  assert.deepEqual((await calls()).map(({ destination }) => destination), ["empty"]);
  await rm(sshLog, { force: true });
  assert.equal(cli(["report", "--json", ...localFlags, "--data-dir", data, "--no-remote"]).status, 0);
  assert.deepEqual(await calls(), []);
  // Repository filters are this machine's; saved machines step aside with a notice.
  const focused = cli(["report", "--json", ...localFlags, "--data-dir", data, "--repo-root", local.repositoryRoot]);
  assert.equal(focused.status, 0, focused.stderr);
  assert.match(focused.stderr, /Saved machines are not read/);
  assert.deepEqual(await calls(), []);
});

test("the deadline stops the remote work too, and no process is left behind", async () => {
  const data = dataDir("slow");
  await machinesFile("slow", { version: 1, machines: [{ name: "slow", ssh: "slow", runtime: "bundled", enabled: true }] });
  // Install the runtime first, so the read below is a plain run.
  assert.equal(cli(["machines", "check", "slow", "--data-dir", data, "--remote-timeout", "2"]).status, 1);
  const started = Date.now();
  const slow = cli(["report", "--json", ...localFlags, "--data-dir", data, "--remote-timeout", "2"]);
  assert.equal(slow.status, 0, slow.stderr);
  assert.ok(Date.now() - started < 15_000);
  assert.match(slow.stderr, /Could not read slow: no snapshot within 2 seconds\.\n {2}Fix: allow more time with --remote-timeout SECONDS/);
  assert.deepEqual(await noLeftovers(), []);
});

test("SIGTERM stops report quietly with the signal's exit code, and the remote work with it", async () => {
  const child: ChildProcess = spawn(process.execPath, [bin, "report", "--json", ...localFlags, "--data-dir", dataDir("slow")], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 200 && !leftovers().some((line) => line.includes("analysis-worker")); attempt++) await delay(50);
  assert.ok(leftovers().some((line) => line.includes("analysis-worker")), "the remote read is running");
  const stopped = Date.now();
  child.kill("SIGTERM");
  const [code] = await once(child, "exit") as [number | null];
  assert.equal(code, 143);
  assert.ok(Date.now() - stopped < 4_000, `stopped in ${Date.now() - stopped} ms`);
  // The stop is not reported as a failed analysis or an unreadable machine.
  assert.equal(output, "");
  assert.deepEqual(await noLeftovers(), []);
});

test("SIGTERM stops a dashboard with a read in flight at once, with its ssh and the remote work", async () => {
  const data = dataDir("slow");
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(typeof address === "object" && address ? address.port : 0)); });
  });
  const child: ChildProcess = spawn(process.execPath, [server, "--port", String(port), ...localFlags, "--data-dir", data], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout!.on("data", (chunk) => { stdout += chunk; });
  for (let attempt = 0; attempt < 400 && !/ready:/.test(stdout); attempt++) await delay(25);
  const request = fetch(`http://127.0.0.1:${port}/api/analytics`).catch(() => null);
  for (let attempt = 0; attempt < 200 && !leftovers().some((line) => line.includes("analysis-worker")); attempt++) await delay(50);
  assert.ok(leftovers().some((line) => line.includes("analysis-worker")), "the remote read is running");
  const stopped = Date.now();
  child.kill("SIGTERM");
  const [code] = await once(child, "exit") as [number | null];
  assert.equal(code, 0);
  assert.ok(Date.now() - stopped < 4_000, `stopped in ${Date.now() - stopped} ms`);
  await request;
  assert.deepEqual(await noLeftovers(), []);
});

test("a plain launch reuses the dashboard started with the same saved machines", async () => {
  const data = dataDir("dashboard");
  await machinesFile("dashboard", { version: 1, machines: [{ name: "server", ssh: "server", user: "agents", runtime: "bundled", enabled: true }] });
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(typeof address === "object" && address ? address.port : 0)); });
  });
  const child: ChildProcess = spawn(process.execPath, [server, "--port", String(port), ...localFlags, "--data-dir", data], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let stdout = "", stderr = "";
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    // This machine's snapshot is served first; the server's sessions follow when it answers.
    for (let attempt = 0; attempt < 400 && !/from server/.test(stdout); attempt++) await delay(25);
    assert.match(stdout, /Analyzed \d+\/\d+ sessions/);
    assert.match(stdout, /Read 5 sessions across 3 repositories from server/);
    const again = cli(["dashboard", "--no-open", "--port", String(port), ...localFlags, "--data-dir", data]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already running/);
    // machines add, set and remove reach the running dashboard, so a plain launch still reuses it.
    const get = async <T>(path: string): Promise<T> => (await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as T;
    assert.equal(cli(["machines", "add", "empty", "--no-check", "--data-dir", data]).status, 0);
    const added = cli(["dashboard", "--no-open", "--port", String(port), ...localFlags, "--data-dir", data]);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /already running/);
    let statuses = await get<{ machines: MachineAnalytics["machines"] }>("/api/machines");
    for (let attempt = 0; attempt < 400 && (statuses.machines!.some(({ state }) => state === "reading") || !/empty: no agent history/.test(stderr)); attempt++) { await delay(25); statuses = await get("/api/machines"); }
    assert.deepEqual(statuses.machines!.map(({ key }) => key), ["local", "server", "empty"]);
    assert.match(stdout, /Saved machines changed; now reading this machine and server, empty\./);
    const combined = validateSnapshot(await get("/api/analytics"));
    assert.deepEqual(combined.machines!.map(({ key, state }) => [key, state]), [["local", "ok"], ["server", "ok"], ["empty", "ok"]]);
    assert.equal(cli(["machines", "set", "empty", "--disable", "--data-dir", data]).status, 0);
    statuses = await get("/api/machines");
    assert.deepEqual(statuses.machines!.map(({ key }) => key), ["local", "server"]);
    for (let attempt = 0; attempt < 400 && statuses.machines!.some(({ state }) => state === "reading"); attempt++) { await delay(25); statuses = await get("/api/machines"); }
    // Reading the machines again does not scan this machine again.
    const scans = (stdout.match(/Analyzed /g) ?? []).length;
    assert.deepEqual((await get<{ machines: MachineAnalytics["machines"] }>("/api/machines?read=1")).machines!.map(({ key, state }) => [key, state]), [["local", "ok"], ["server", "reading"]]);
    for (let attempt = 0; attempt < 400 && statuses.machines!.some(({ state }) => state === "reading"); attempt++) { await delay(25); statuses = await get("/api/machines"); }
    assert.equal((stdout.match(/Analyzed /g) ?? []).length, scans);
    // Other machines chosen on the command line are another dashboard, and the message says so.
    const other = cli(["dashboard", "--no-open", "--port", String(port), ...localFlags, "--data-dir", data, "--no-remote"]);
    assert.equal(other.status, 1);
    assert.match(other.stderr, /already running on this port with other machines/);
    const options = cli(["dashboard", "--no-open", "--port", String(port), ...localFlags, "--data-dir", data, "--exclude-hidden"]);
    assert.equal(options.status, 1);
    assert.match(options.stderr, /different options/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

test("a dashboard started without machines reads the first one added at once, and serves its last scan when the last one goes", async () => {
  const data = dataDir("first-add");
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [server, "--port", String(port), ...localFlags, "--data-dir", data], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let stdout = "";
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    for (let attempt = 0; attempt < 400 && !/Analyzed /.test(stdout); attempt++) await delay(25);
    const get = async <T>(path: string): Promise<T> => (await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as T;
    assert.equal(validateSnapshot(await get("/api/analytics")).machines, undefined);
    assert.equal(cli(["machines", "add", "server", "--user", "agents", "--no-check", "--data-dir", data]).status, 0);
    // Only /api/machines is asked: this machine's scan and the machine's read start without a snapshot request.
    let statuses = await get<{ machines: MachineAnalytics["machines"] }>("/api/machines");
    for (let attempt = 0; attempt < 400 && (!statuses.machines!.length || statuses.machines!.some(({ state }) => state === "reading")); attempt++) { await delay(25); statuses = await get("/api/machines"); }
    assert.deepEqual(statuses.machines!.map(({ key, state }) => [key, state]), [["local", "ok"], ["server", "ok"]]);
    const combined = validateSnapshot(await get("/api/analytics"));
    assert.deepEqual(combined.machines!.map(({ key, state }) => [key, state]), [["local", "ok"], ["server", "ok"]]);
    assert.equal(combined.machines![1]!.sessions, 5);
    // Without machines, this machine's last scan is the snapshot again, with no new scan.
    assert.equal(cli(["machines", "remove", "server", "--data-dir", data]).status, 0);
    const alone = validateSnapshot(await get("/api/analytics"));
    assert.equal(alone.machines, undefined);
    assert.equal(alone.generatedAt, combined.machines![0]!.readAt);
    assert.equal(alone.summary.sessions, localSessions);
    assert.deepEqual((await get<{ machines: MachineAnalytics["machines"] }>("/api/machines")).machines, []);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(typeof address === "object" && address ? address.port : 0)); });
  });
}

test("the dashboard notices in-place machine edits with unchanged size and modification time", async () => {
  const data = dataDir("same-stamp"), file = join(data, "machines.json");
  await machinesFile("same-stamp", { version: 1, machines: [{ name: "box", ssh: "down", runtime: "installed", enabled: false }] });
  const time = new Date("2026-10-01T12:00:00Z");
  await utimes(file, time, time);
  const initial = await stat(file), original = await readFile(file, "utf8");
  const port = await freePort();
  const child = spawn(process.execPath, [server, "--port", String(port), ...localFlags, "--data-dir", data], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let output = "";
    child.stdout!.on("data", (chunk) => { output += chunk; });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 400 && !/ready:/.test(output); attempt++) await delay(25);
    const get = async <T>(path: string): Promise<T> => (await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as T;
    await get("/api/analytics");
    assert.deepEqual((await get<{ machines: unknown[] }>("/api/machines")).machines, []);
    // Editors and synchronizers can restore mtime after replacing a same-length value in place.
    await writeFile(file, original.replace('"enabled": false', '"enabled": true '));
    await utimes(file, time, time);
    const changed = await stat(file);
    assert.deepEqual([changed.ino, changed.size, changed.mtimeMs], [initial.ino, initial.size, initial.mtimeMs]);
    let statuses = await get<{ machines: Array<{ key: string; state: string }> }>("/api/machines");
    for (let attempt = 0; attempt < 120 && (statuses.machines.length < 2 || statuses.machines.some(({ state }) => state === "reading")); attempt++) {
      await delay(25); statuses = await get("/api/machines");
    }
    assert.deepEqual(statuses.machines.map(({ key, state }) => [key, state]), [["local", "ok"], ["box", "failed"]]);
  } finally {
    child.kill("SIGTERM"); await once(child, "exit");
  }
});

test("a machine that fails is shown from its last good snapshot, marked stale, and --strict exits 3", async () => {
  const data = dataDir("stale");
  const saved = (ssh: string): MachinesConfig => ({ version: 1, local: { label: "laptop" }, machines: [{ name: "server", ssh, user: "agents", runtime: "bundled", enabled: true }] });
  await machinesFile("stale", saved("server"));
  const good = cli(["report", "--json", ...localFlags, "--data-dir", data, "--strict"]);
  assert.equal(good.status, 0, good.stderr);
  const fresh = validateSnapshot(JSON.parse(good.stdout));
  assert.deepEqual(fresh.machines!.map(({ key, label, state }) => [key, label, state]), [["local", "laptop", "ok"], ["server", "server", "ok"]]);
  // The bundled runtime says which version produced it; its identity stays out of the snapshot.
  assert.equal(fresh.machines![1]!.version, version);
  assert.ok(fresh.machines!.every(({ identity }) => identity === undefined));
  for (const name of ["server.json", "server.snapshot.json"]) assert.equal((await stat(join(data, "machines", name))).mode & 0o777, 0o600);
  // The machine is down now.
  const down = { FAKE_SSH_DOWN: "server" };
  const text = cli(["report", ...localFlags, "--data-dir", data, "--strict"], down);
  assert.equal(text.status, 3, text.stderr);
  assert.match(text.stdout, /^Session Analytics · laptop and server \(stale\)\n/);
  assert.match(text.stdout, /\nMachines: 1 of 2 read now, 1 from a last good snapshot\n.*\n {2}server {2}unreachable; its last good snapshot from (?:just now|\d+ min ago) \(5 sessions, 3 repositories\)\n {4}Fix: run session-analytics machines check server/);
  assert.match(text.stderr, /Could not read server: SSH could not connect.*\n {2}Fix: .*\n {2}Using its last good snapshot from (?:just now|\d+ min ago) \(5 sessions\)\./);
  assert.match(text.stderr, /--strict: server was not read now; exiting with 3\.\n$/);
  const stale = validateSnapshot(JSON.parse(cli(["report", "--json", ...localFlags, "--data-dir", data], down).stdout));
  assert.deepEqual(stale.machines!.map(({ state, reason }) => [state, reason ?? null]), [["ok", null], ["stale", "connection"]]);
  assert.equal(stale.machines![1]!.readAt, fresh.machines![1]!.readAt);
  assert.ok(stale.warnings.includes(staleMachineWarning) && !stale.warnings.includes(remoteUnavailableWarning));
  // Another version, or another request, reads the machine again rather than reuse its snapshot.
  const meta = join(data, "machines", "server.json"), record = await readFile(meta, "utf8");
  const state = (args: string[] = [], extra: NodeJS.ProcessEnv = down): string | undefined => (JSON.parse(cli(["report", "--json", ...localFlags, "--data-dir", data, ...args], extra).stdout) as MachineAnalytics).machines![1]!.state;
  await writeFile(meta, JSON.stringify({ ...JSON.parse(record), tool: "0.0.1" }));
  assert.equal(state(), "failed");
  await writeFile(meta, record);
  assert.equal(state(["--time-zone", "Asia/Tokyo"]), "failed");
  // --no-index leaves retained history out, so an indexed read's snapshot does not stand in for it.
  assert.equal(requestDigest(["report", "--no-index"]) === requestDigest(["report"]), false);
  assert.equal(requestDigest(["report", "--offline"]), requestDigest(["report"]));
  // A record never vouches for another read's snapshot.
  const snapshotFile = join(data, "machines", "server.snapshot.json"), bytes = await readFile(snapshotFile, "utf8");
  await writeFile(snapshotFile, `${bytes} `);
  assert.equal(state(), "failed");
  await writeFile(snapshotFile, bytes);
  assert.equal(state(), "stale");
  // A machine pointed elsewhere by hand (or by a dashboard that still holds the old one) never shows the old host's snapshot.
  writeMachines({ dataDir: data }, saved("down"));
  assert.equal(state([], {}), "failed");
  writeMachines({ dataDir: data }, saved("server"));
  assert.equal(state(), "stale");
  // Pointing the machine elsewhere, or removing it, forgets its snapshot.
  assert.equal(cli(["machines", "set", "server", "--ssh", "server-again", "--data-dir", data]).status, 0);
  assert.deepEqual(await readdir(join(data, "machines")), []);
});

test("a machine saved with its check is shown from its last good snapshot when a later read fails", async () => {
  const data = dataDir("checked");
  const added = cli(["machines", "add", "server", "--user", "agents", "--data-dir", data]);
  assert.equal(added.status, 0, added.stdout);
  const good = validateSnapshot(JSON.parse(cli(["report", "--json", ...localFlags, "--data-dir", data]).stdout));
  assert.deepEqual(good.machines!.map(({ state }) => state), ["ok", "ok"]);
  // The check's shell probe and the runtime's --identify-machine name the same machine and account alike.
  const identity = readMachines({ dataDir: data })!.machines[0]!.identity;
  assert.match(identity ?? "", /^[0-9a-f]{16}$/);
  assert.equal((JSON.parse(await readFile(join(data, "machines", "server.json"), "utf8")) as { identity?: string }).identity, identity);
  const stale = validateSnapshot(JSON.parse(cli(["report", "--json", ...localFlags, "--data-dir", data], { FAKE_SSH_DOWN: "server" }).stdout));
  assert.deepEqual(stale.machines!.map(({ state, reason }) => [state, reason ?? null]), [["ok", null], ["stale", "connection"]]);
  assert.equal(stale.machines![1]!.sessions, good.machines![1]!.sessions);
});

test("the same machine reached twice is counted once, and this machine is never read as another", async () => {
  const data = dataDir("twice");
  await machinesFile("twice", { version: 1, machines: [
    { name: "server", ssh: "server", user: "agents", runtime: "bundled", enabled: true },
    { name: "again", ssh: "server-again", user: "agents", runtime: "bundled", enabled: true },
  ] });
  const text = cli(["report", ...localFlags, "--data-dir", data, "--strict"]);
  assert.equal(text.status, 3, text.stderr);
  assert.match(text.stdout, /^Session Analytics · this machine and server \(not read: again\)\n/);
  assert.match(text.stdout, /\n {2}again {9}not read: same machine as another\n {4}Fix: session-analytics machines remove again; if it is another machine cloned from the same image, set SESSION_ANALYTICS_MACHINE_ID to a different value in each account's profile instead\n/);
  assert.match(text.stderr, /Not counting again: the same machine and account as server, so its history is counted once\.\n {2}Fix: session-analytics machines remove again/);
  const snapshot = validateSnapshot(JSON.parse(cli(["report", "--json", ...localFlags, "--data-dir", data]).stdout));
  assert.deepEqual(snapshot.machines!.map(({ key, state, reason }) => [key, state, reason ?? null]), [["local", "ok", null], ["server", "ok", null], ["again", "failed", "same-machine"]]);
  // The SSH account there is this test's own account, so under this machine's ID it is this machine and account.
  await machinesFile("self", { version: 1, machines: [{ name: "server", ssh: "server", runtime: "bundled", enabled: true }] });
  const self = cli(["report", "--json", ...localFlags, "--data-dir", dataDir("self")], { SESSION_ANALYTICS_MACHINE_ID: "id-server" });
  assert.equal(self.status, 0, self.stderr);
  assert.match(self.stderr, /Could not read server: this machine and account, which is always read\.\n {2}Fix: session-analytics machines remove server/);
  assert.deepEqual((JSON.parse(self.stdout) as MachineAnalytics).machines!.map(({ state, reason }) => [state, reason ?? null]), [["ok", null], ["failed", "same-machine"]]);
});

test("the dashboard serves this machine first, shows a slow machine's last good snapshot while it reads, then marks it stale", async () => {
  const data = dataDir("progressive");
  await machinesFile("progressive", { version: 1, machines: [{ name: "server", ssh: "server", user: "agents", runtime: "bundled", enabled: true }] });
  assert.equal(cli(["report", "--json", ...localFlags, "--data-dir", data]).status, 0);
  // The machine's analysis now never finishes.
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [server, "--port", String(port), ...localFlags, "--data-dir", data, "--remote-timeout", "8"], { env: { ...environment, FAKE_SSH_HANG: "server" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let output = "";
    child.stdout!.on("data", (chunk) => { output += chunk; });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 400 && !/ready:/.test(output); attempt++) await delay(25);
    const get = async <T>(path: string): Promise<T> => (await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as T;
    const first = validateSnapshot(await get("/api/analytics"));
    assert.deepEqual(first.machines!.map(({ key, state }) => [key, state]), [["local", "ok"], ["server", "reading"]]);
    assert.equal(first.machines![1]!.sessions, 5);
    assert.ok(first.machines![1]!.readAt);
    const reading = await get<{ machines: MachineAnalytics["machines"] }>("/api/machines");
    assert.deepEqual(reading.machines!.map(({ key, state }) => [key, state]), [["local", "ok"], ["server", "reading"]]);
    let settled = reading;
    for (let attempt = 0; attempt < 400 && settled.machines![1]!.state === "reading"; attempt++) { await delay(50); settled = await get("/api/machines"); }
    assert.deepEqual([settled.machines![1]!.state, settled.machines![1]!.reason], ["stale", "timeout"]);
    const after = validateSnapshot(await get("/api/analytics"));
    assert.deepEqual(after.machines!.map(({ key, state }) => [key, state]), [["local", "ok"], ["server", "stale"]]);
    assert.ok(after.warnings.includes(staleMachineWarning));
    assert.match(output, /Could not read server: no snapshot within 8 seconds\.[^]*Using its last good snapshot from/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  assert.deepEqual(await noLeftovers(), []);
});


test("an ssh that exits while a helper holds its pipes settles at once, not at the deadline", async () => {
  const data = dataDir("helper");
  await machinesFile("helper", { version: 1, machines: [{ name: "helper", ssh: "helper", runtime: "bundled", enabled: true }] });
  try {
    const started = Date.now();
    const read = cli(["report", "--json", ...localFlags, "--data-dir", data, "--remote-timeout", "15", "--strict"]);
    assert.equal(read.status, 0, read.stderr);
    assert.ok(Date.now() - started < 12_000, `took ${Date.now() - started} ms`);
    assert.match(read.stderr, /Read 5 sessions across 3 repositories from helper/);
  } finally { spawnSync("pkill", ["-f", "fake-ssh-helper"]); }
});

test("machines commands change machines.json from the file as it is, so a long check keeps a concurrent add", async () => {
  const data = dataDir("concurrent");
  await machinesFile("concurrent", { version: 1, machines: [{ name: "slow", ssh: "slow", runtime: "bundled", enabled: true }] });
  const checking = spawn(process.execPath, [bin, "machines", "check", "slow", "--data-dir", data, "--remote-timeout", "4"], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  checking.stdout!.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 400 && !/✓ runtime/.test(output); attempt++) await delay(25);
  const added = cli(["machines", "add", "boxb", "--no-check", "--data-dir", data]);
  assert.equal(added.status, 0, added.stderr);
  const [code] = await once(checking, "exit") as [number | null];
  assert.equal(code, 1);
  const config = readMachines({ dataDir: data })!;
  assert.deepEqual(config.machines.map(({ name }) => name), ["slow", "boxb"]);
  assert.match(config.machines[0]!.identity!, /^[0-9a-f]{16}$/);
  assert.deepEqual((await readdir(data)).filter((name) => name.startsWith("machines.json")), ["machines.json"]);
});

test("a match by host name alone warns rather than refuses, and names the override", async () => {
  const data = dataDir("hostonly");
  const first = cli(["machines", "add", "hostonly-a", "--data-dir", data]);
  assert.equal(first.status, 0, first.stdout);
  assert.match(readMachines({ dataDir: data })!.machines[0]!.identity!, /^host-[0-9a-f]{16}$/);
  const clone = cli(["machines", "add", "hostonly-b", "--data-dir", data]);
  assert.equal(clone.status, 0, clone.stdout);
  assert.match(clone.stdout, /! machine {3}the same host name and account as hostonly-a, with no machine ID there to tell them apart\n {4}Fix: if it is hostonly-a, it is already read; otherwise set SESSION_ANALYTICS_MACHINE_ID to a unique value in that account's profile there\n/);
  assert.deepEqual(readMachines({ dataDir: data })!.machines.map(({ name }) => name), ["hostonly-a", "hostonly-b"]);
});

test("--strict counts a machine still reading in a saved dashboard snapshot as not read now", async () => {
  const data = dataDir("reading");
  await machinesFile("reading", { version: 1, machines: [{ name: "server", ssh: "server", user: "agents", runtime: "bundled", enabled: true }] });
  const good = cli(["report", "--json", ...localFlags, "--data-dir", data]);
  assert.equal(good.status, 0, good.stderr);
  const snapshot = JSON.parse(good.stdout) as MachineAnalytics;
  snapshot.machines![1]!.state = "reading";
  const file = join(directory, "reading-snapshot.json");
  await writeFile(file, JSON.stringify(snapshot));
  const text = cli(["report", "--snapshot", file, "--strict"]);
  assert.equal(text.status, 3, text.stderr);
  assert.match(text.stdout, /^Session Analytics · this machine and server \(reading\)\n/);
  assert.match(text.stdout, /\nMachines: 1 of 2 read now, 1 still reading when this snapshot was made\n.*\n {2}server {8}still reading; its last good snapshot from/);
  assert.match(text.stderr, /--strict: server was not read now; exiting with 3\.\n$/);
});

test("SIGTERM during machines check --find-users starts no new ssh and leaves none behind", async () => {
  const data = dataDir("slow-find");
  await machinesFile("slow-find", { version: 1, machines: [{ name: "slow", ssh: "slow", runtime: "bundled", enabled: true }] });
  const child: ChildProcess = spawn(process.execPath, [bin, "machines", "check", "slow", "--find-users", "--data-dir", data, "--remote-timeout", "60"], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  for (let attempt = 0; attempt < 200 && !leftovers().some((line) => line.includes("analysis-worker")); attempt++) await delay(50);
  assert.ok(leftovers().some((line) => line.includes("analysis-worker")), "the remote read is running");
  child.kill("SIGTERM");
  const [code] = await once(child, "exit") as [number | null];
  assert.equal(code, 143);
  await delay(500);
  const shim = join(directory, "bin", "ssh");
  assert.deepEqual(spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes(shim)), []);
  assert.deepEqual(await noLeftovers(), []);
});
