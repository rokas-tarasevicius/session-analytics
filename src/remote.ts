import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { AnalysisHooks } from "./analyzer.ts";
import { analyzeMachineSessionsIsolated } from "./analysis-process.ts";
import { brand } from "./brand.ts";
import { combineSnapshots, historyProfileKeys, profileKeyRemaps } from "./interop/combine.ts";
import { maximumSnapshotBytes } from "./interop/files.ts";
import { validateSnapshot } from "./interop/snapshot.ts";
import { canonicalTimeZone, type RemoteMachine, type RemoteOptions } from "./options.ts";
import { stopping, track } from "./processes.ts";
import { lastGoodMaxAgeMs, readLastGood, writeLastGood } from "./machines/cache.ts";
import { byHostName, localIdentity } from "./machines/identity.ts";
import { remoteUnavailableWarning, staleMachineWarning } from "./public/evidence.js";
import { localMachine, machineAge } from "./public/machines.js";
import { runtimePayload, type RuntimePayload } from "./remote/runtime.ts";
import type { AnalyzeOptions, MachineAnalytics, MachineReason, MachineStatus } from "./types.ts";
import { version } from "./version.ts";

const STDERR_TAIL_BYTES = 8192;
// No prompts, no terminal, and nothing a host's ssh_config adds: no forwarded agent, X11 or ports for code
// running there, no LocalCommand output mixed into the snapshot, and no RemoteCommand in place of ours.
export const sshOptions = [
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-T",
  "-a", "-x", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "RemoteCommand=none",
];
export const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The request every remote machine runs: a full snapshot in this machine's zone, with portable repository IDs. */
export function remoteArguments(options: AnalyzeOptions & { timeZone: string }): string[] {
  return [
    "report", "--json", "--no-remote", "--portable-ids", "--time-zone", options.timeZone,
    ...(options.offline ? ["--offline"] : []),
    ...(options.noIndex ? ["--no-index"] : []),
    ...(options.includeHidden === false ? ["--exclude-hidden"] : []),
    ...(options.additionalProviders === false ? ["--no-additional-providers"] : []),
    ...(options.pricingPolicy ? ["--pricing-policy", options.pricingPolicy] : []),
    ...(options.pricingSources ? ["--pricing-sources", options.pricingSources.join(",")] : []),
    ...(options.pricingMaxAgeDays !== undefined ? ["--pricing-max-age-days", String(options.pricingMaxAgeDays)] : []),
  ];
}

export interface SshResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** Set when this machine ended the call rather than the remote command. */
  failure: "no-ssh" | "local-runtime" | "timeout" | "too-large" | "cancelled" | null;
  ms: number;
}

export interface SshCall {
  /** stdin to send; without it stdin stays open until the call settles. */
  input?: string;
  /** Epoch milliseconds after which the call is stopped. */
  deadline: number;
  signal?: AbortSignal;
  limit?: number;
  /** ssh options before the destination, after the fixed ones. */
  options?: string[];
}

/** Run plain words on a machine through the user's own ssh, without a terminal or prompts. */
export async function runSsh(destination: string, words: string[], { input, deadline, signal, limit = maximumSnapshotBytes, options = [] }: SshCall): Promise<SshResult> {
  const started = performance.now();
  // Nothing new starts once a signal is stopping this process: it would outlive the exit.
  if (stopping() || signal?.aborted) return { code: null, stdout: Buffer.alloc(0), stderr: "", failure: "cancelled", ms: 0 };
  return await new Promise((resolve) => {
    const child = track(spawn("ssh", [...sshOptions, ...options, "--", destination, ...words], { stdio: ["pipe", "pipe", "pipe"] }));
    const chunks: Buffer[] = [];
    let bytes = 0, stderr = "", settled = false, exitCode: number | null | undefined, grace: NodeJS.Timeout | undefined, lastData = 0;
    let failure: SshResult["failure"] = null;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", cancel);
      child.stdin.destroy();
      resolve({ code, stdout: Buffer.concat(chunks), stderr, failure, ms: performance.now() - started });
    };
    // Once ssh has exited, a helper that inherited its pipes (a ProxyCommand that backgrounds, say) must not hold
    // the call open until the deadline: what is still arriving gets a moment, renewed while it flows, then the pipes go.
    // Timers run before I/O, so after a busy moment the check waits one turn for output that queued behind it.
    const linger = (): void => {
      if (exitCode === undefined || settled) return;
      clearTimeout(grace);
      grace = setTimeout(() => setImmediate(() => {
        if (settled) return;
        if (performance.now() - lastData < 1_000) { linger(); return; }
        child.stdout.destroy(); child.stderr.destroy(); finish(exitCode ?? null);
      }), 1_000);
      grace.unref();
    };
    // Killing ssh closes the channel; the bundled runtime notices and stops the remote work.
    // The pipes are dropped too, so a helper that inherited them cannot hold the call open.
    const stop = (reason: NonNullable<SshResult["failure"]>): void => {
      if (settled) return;
      failure ??= reason;
      child.kill("SIGTERM");
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
      setTimeout(() => { child.kill("SIGKILL"); finish(null); }, 1_000).unref();
    };
    const cancel = (): void => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), Math.max(0, deadline - Date.now()));
    timer.unref();
    if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
    child.stdin.on("error", () => { /* The remote may exit before reading its input. */ });
    if (input !== undefined) child.stdin.end(input);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) stop("too-large");
      else if (!failure) chunks.push(chunk);
      lastData = performance.now();
      linger();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES); lastData = performance.now(); linger(); });
    child.once("error", (error: NodeJS.ErrnoException) => { failure ??= error.code === "ENOENT" ? "no-ssh" : "cancelled"; finish(null); });
    child.once("exit", (code) => { exitCode = code; if (code === null) failure ??= "cancelled"; linger(); });
    child.once("close", (code) => { if (code === null) failure ??= "cancelled"; finish(code); });
  });
}

/** The words before the command: `sudo -n -iu USER` when the machine names an account, without -i for one with no login shell. */
export function accountPrefix(machine: RemoteMachine): string[] {
  if (!machine.user) return [];
  return machine.loginShell === false ? ["sudo", "-n", "-H", "-u", machine.user] : ["sudo", "-n", "-iu", machine.user];
}

/**
 * Run session-analytics there with these arguments. The bundled runtime sends the bootstrap on stdin
 * and, only when it answers need-runtime (75), sends this install in a second round trip.
 */
export async function runRemote(machine: RemoteMachine, args: string[], call: Omit<SshCall, "input">): Promise<SshResult & { installed: boolean }> {
  const prefix = accountPrefix(machine);
  if (machine.runtime === "installed") return { ...await runSsh(machine.ssh, [...prefix, ...machine.command, ...args], call), installed: false };
  let runtime: RuntimePayload;
  // An install missing its own files cannot pack the runtime; that is this machine's problem, not the remote's.
  try { runtime = runtimePayload(); } catch { return { code: null, stdout: Buffer.alloc(0), stderr: "", failure: "local-runtime", ms: 0, installed: false }; }
  const words = (mode: "run" | "install"): string[] => [...prefix, machine.node, "-", "sa1", mode, runtime.version, runtime.digest, ...args];
  const first = await runSsh(machine.ssh, words("run"), { ...call, input: runtime.run });
  if (first.failure || first.code !== 75 || !/^sa1: need-runtime$/m.test(first.stderr)) return { ...first, installed: false };
  const second = await runSsh(machine.ssh, words("install"), { ...call, input: runtime.install });
  return { ...second, ms: first.ms + second.ms, installed: true };
}

export type RemoteFailure = Exclude<MachineReason, "no-history">;

function failureText(reason: RemoteFailure, machine: RemoteMachine | null, found: string, timeoutMs: number): string {
  const account = machine?.user ?? "the SSH account";
  const texts: Record<RemoteFailure, string> = {
    "no-ssh": "ssh is not available on this machine",
    "unknown-host": `${machine?.ssh ?? "that host"} is not a host name ssh can resolve`,
    connection: "SSH could not connect",
    "login-refused": "SSH refused the login without a prompt",
    dropped: "the SSH session ended without an exit status (connection dropped, or the remote process was killed)",
    sudo: `sudo -n could not run commands as ${account} without a password`,
    "no-account": machine?.user ? `the account ${machine.user} does not exist there` : "the account named after sudo does not exist there",
    "login-shell": `${account}'s login shell refuses to run commands (nologin or false)`,
    permission: "the remote command is not executable for that account",
    "missing-command": "session-analytics was not found there",
    "no-node": machine && machine.node !== "node" ? `${machine.node} was not found there` : `node was not found on ${account}'s ${machine?.loginShell === false ? "sudo" : "login"} PATH`,
    "node-too-old": `the remote Node.js is ${found || "too old"}; the bundled runtime needs 24 or later`,
    "local-runtime": "this machine could not pack its bundled runtime (its own install is missing files)",
    runtime: "the bundled runtime could not start there",
    "cache-unwritable": `the bundled runtime cannot be stored safely in ${account}'s ~/.cache`,
    corrupted: "the bundled runtime arrived damaged",
    "version-skew": `the remote runs session-analytics ${found}, this machine ${version}`,
    rejected: "the remote session-analytics rejected the request (probably another version)",
    busy: "the remote index is busy with another read",
    "index-newer": "the remote index was created by a newer session-analytics",
    analysis: "the remote analysis failed",
    invalid: found ? `the remote answered ${found} with something else` : "the remote output was not a valid full snapshot",
    "time-zone": "the remote snapshot used another time zone",
    timeout: `no ${found === "limits" ? "limits" : "snapshot"} within ${Math.round(timeoutMs / 1000)} second${Math.round(timeoutMs / 1000) === 1 ? "" : "s"}`,
    "too-large": found === "limits" ? "the remote limits exceeded their size limit" : "the remote snapshot exceeded the snapshot size limit",
    cancelled: "the read was stopped",
    "same-machine": found ? `the same machine and account as ${found}, so its history is counted once` : "this machine and account, which is always read",
  };
  return texts[reason];
}

/**
 * The exact next step for each reason; empty when there is none to take. A saved machine's fix changes it with
 * `machines set`; an unsaved one, including one `machines add` has not saved yet, is added again with other options.
 * `found` is `limits` for a limits read, whose time-out and size limit are its own.
 */
function fixText(reason: RemoteFailure, machine: RemoteMachine | null, found = ""): string {
  if (!machine) return "";
  const command = brand.command, name = machine.name, ssh = machine.ssh;
  const add = `${command} machines add ${ssh}${machine.user ? ` --user ${machine.user}` : ""}${machine.loginShell === false ? " --no-login-shell" : ""}`;
  const check = machine.saved ? `${command} machines check ${name}` : add;
  const bundled = machine.saved ? `${command} machines set ${name} --runtime bundled` : add;
  // A Node.js path that was given and is missing there: name the way back to the login PATH too.
  const node = machine.node !== "node" ? machine.saved ? `${command} machines set ${name} --node /path/to/node, or --node node to use the login PATH` : `${add} --node /path/to/node, or leave out --node to use the login PATH`
    : machine.saved ? `${command} machines set ${name} --node /usr/bin/node` : `${add} --node /usr/bin/node`;
  const fixes: Record<RemoteFailure, string> = {
    "no-ssh": "install an OpenSSH client so that ssh is on PATH",
    "unknown-host": `check the name: ssh -G ${ssh} shows how your ~/.ssh/config resolves it, and ssh ${ssh} true tries it`,
    connection: `check that ${ssh} is up and its SSH server is reachable from here, then run ssh ${ssh} true once in a terminal (it also accepts a new host key)`,
    "login-refused": `run ssh ${ssh} true in a terminal. If it asks for a key passphrase, load the key into your agent so BatchMode can use it (ssh-add ~/.ssh/KEY, with --apple-use-keychain on a Mac, or AddKeysToAgent yes in ~/.ssh/config); if it asks for a password, ssh-copy-id ${ssh} installs a key`,
    dropped: `check that the machine is up and has memory to spare, then ${check}`,
    sudo: machine.user
      ? `on that machine run: echo "$USER ALL=(${machine.user}) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/session-analytics-${machine.user} && sudo chmod 0440 /etc/sudoers.d/session-analytics-${machine.user}`
      : "allow that command through sudo without a password there",
    "no-account": machine.saved ? `${command} machines check ${name} --find-users lists the accounts with agent history`
      : machine.user ? `check the account name; ${command} machines add ${ssh} --find-users lists the accounts with agent history` : "check the account name in --remote-command",
    "login-shell": machine.saved ? `read it without a login shell: ${command} machines set ${name} --no-login-shell (node then comes from sudo's PATH, or name it with --node)`
      : machine.user ? `read it without a login shell: ${add} --no-login-shell` : "use sudo -n -H -u ACCOUNT rather than -iu in --remote-command, and name node by its full path",
    permission: `use the bundled runtime: ${bundled}`,
    "missing-command": machine.saved
      ? `use the bundled runtime (${bundled}), or name the command in full: ${command} machines set ${name} --command "node /path/to/session-analytics/bin/session-analytics.ts"`
      : `use the bundled runtime (${bundled}), or name the command in full: --remote-command "node /path/to/session-analytics/bin/session-analytics.ts"`,
    "no-node": `install Node.js 24 or later there, or point to it: ${node}`,
    "node-too-old": `install Node.js 24 or later there, or point to a newer one: ${node}`,
    "local-runtime": `reinstall session-analytics on this machine, or run an install there instead: ${machine.saved ? `${command} machines set ${name} --runtime installed` : `${add} --runtime installed`}`,
    runtime: `retry; if it persists, run ${check}`,
    "cache-unwritable": machine.saved ? `${command} machines set ${name} --runtime installed, or set XDG_CACHE_HOME to a private, writable directory in that account's profile` : "set XDG_CACHE_HOME to a private, writable directory in that account's profile",
    corrupted: "retry the read",
    "version-skew": `install ${version} there, or use the bundled runtime: ${bundled}`,
    rejected: `run the same version on both machines, or use the bundled runtime: ${bundled}`,
    busy: "retry in a minute; an earlier read there is still finishing",
    "index-newer": "upgrade session-analytics on this machine, or read with --no-index",
    analysis: `run ${check}`,
    invalid: `make sure nothing in that account's login profile prints to stdout${machine.runtime === "installed" ? `, and run the same version on both machines (${bundled})` : ""}`,
    "time-zone": "",
    timeout: found === "limits" ? "allow more time with --remote-timeout SECONDS: a machine's limits read may use all of it until one has answered, later reads stop after 60 seconds"
      : `allow more time with --remote-timeout SECONDS, or warm its index once with ${check}`,
    "too-large": found === "limits" ? "" : "read it with --exclude-hidden, or merge snapshot files instead (see docs/interop.md)",
    cancelled: "",
    "same-machine": `${machine.saved ? `${command} machines remove ${name}` : `leave ${ssh} out of --remote`}; if it is another machine cloned from the same image, set SESSION_ANALYTICS_MACHINE_ID to a different value in each account's profile instead`,
  };
  return fixes[reason];
}

/**
 * The most telling stderr line, sanitized, for this terminal only. Node's version trailer, stack
 * frames and source excerpts are skipped so a crash shows its error, not `Node.js v24.x`.
 */
export function stderrDetail(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.replace(/[\p{Cc}\p{Cf}]/gu, "").trim())
    .filter((line) => line && !/^Node\.js v\d/.test(line) && !/^at\s/.test(line) && !/^\^+$/.test(line) && !/^\[stdin\]:\d+$/.test(line) && line !== "sa1: need-runtime");
  const telling = lines.filter((line) => /^[A-Za-z]*Error\b|^sudo(?:-rs)?:|^Sorry, user|^sa1:|denied|not found|required|refused|failed|unknown|cannot|could not|busy|newer|no such|timed out|killed|stopped/i.test(line));
  return (telling.at(-1) ?? lines.at(-1) ?? "").slice(0, 300);
}

/** A fixed reason and its fix, plus the most telling stderr line, for this terminal only. */
export class RemoteError extends Error {
  readonly reason: RemoteFailure;
  readonly detail: string;
  readonly fix: string;
  /** Snapshot hints use only the public label; the terminal keeps the exact configuration. */
  readonly snapshotFix: string;
  constructor(reason: RemoteFailure, machine: RemoteMachine | null = null, stderr = "", found = "", timeoutMs = 0) {
    super(failureText(reason, machine, found, timeoutMs));
    this.reason = reason;
    this.detail = stderrDetail(stderr);
    this.fix = fixText(reason, machine, found);
    this.snapshotFix = this.fix && machine?.saved && ["unknown-host", "connection", "login-refused", "sudo"].includes(reason)
      ? `run ${brand.command} machines check ${machine.name} for the exact diagnostic and fix` : this.fix;
  }
}

const sshProblem = /^ssh:|Permission denied \(|Host key verification failed|Could not resolve hostname|Connection (?:refused|timed out|closed|reset)|No route to host|kex_exchange_identification|Too many authentication failures/m;

/** Map an ssh result to a reason: transport, account, runtime, then the remote analysis itself. */
export function classifyRemote(machine: RemoteMachine, result: SshResult, timeoutMs = 0): RemoteError | null {
  const error = (reason: RemoteFailure, found = ""): RemoteError => new RemoteError(reason, machine, reason === "no-ssh" || reason === "local-runtime" ? "" : result.stderr, found, timeoutMs);
  if (result.failure) return error(result.failure);
  if (result.code === 0) return null;
  const { stderr } = result;
  if (result.code === 255) {
    if (!sshProblem.test(stderr)) return error("dropped");
    return error(/Could not resolve hostname/.test(stderr) ? "unknown-host" : /Permission denied \(|Too many authentication failures/.test(stderr) ? "login-refused" : "connection");
  }
  // nologin says so on stdout; false says nothing at all.
  if (result.code === 1 && /^This account is currently not available\.?$/m.test(result.stdout.subarray(0, 4096).toString("utf8"))) return error("login-shell");
  // Classic sudo and sudo-rs word these differently.
  if (/^sudo(?:-rs)?: .*(?:password is required|terminal is required|interactive authentication is required|I'm afraid I can't do that|is not allowed to|may not run sudo|not in the sudoers)|^Sorry, user .* (?:is not allowed|may not run)/m.test(stderr)) return error("sudo");
  if (/^sudo(?:-rs)?: (?:unknown user|user .* not found|.*: unknown user)/mi.test(stderr)) return error("no-account");
  const bootstrap: Partial<Record<number, RemoteFailure>> = { 75: "runtime", 78: "node-too-old", 79: "runtime", 80: "cache-unwritable", 81: "corrupted" };
  const reason = machine.runtime === "bundled" ? bootstrap[result.code ?? -1] : undefined;
  if (reason) return error(reason, /^sa1: node-too-old (v[\d.]+)$/m.exec(stderr)?.[1] ?? "");
  if (result.code === 126) return error("permission");
  if (result.code === 127) return error(machine.runtime === "bundled" ? "no-node" : "missing-command");
  if (result.code === 2) return error("rejected");
  if (machine.runtime === "installed" && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(stderr)) return error("missing-command");
  if (/ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|bad option: --experimental-strip-types/.test(stderr)) return error("node-too-old");
  if (/The local index is busy/.test(stderr)) return error("busy");
  if (/The local index was created by a newer version/.test(stderr)) return error("index-newer");
  return error("analysis");
}

/** An installed remote's version, or null when it does not answer with one. */
export async function remoteVersion(machine: RemoteMachine, signal?: AbortSignal, deadline = Date.now() + 30_000): Promise<string | null> {
  if (Date.now() >= deadline) return null;
  const result = await runRemote(machine, ["--version"], { deadline: Math.min(deadline, Date.now() + 30_000), signal, limit: 4096 });
  const answer = result.stdout.toString("utf8").trim();
  return result.code === 0 && versionPattern.test(answer) ? answer : null;
}

/** One machine's validated snapshot. An installed remote that fails as if it ran another version is asked which. */
export async function fetchRemoteSnapshot(machine: RemoteMachine, args: string[], { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<MachineAnalytics> {
  const deadline = Date.now() + timeoutMs;
  const result = await runRemote(machine, args, { deadline, signal });
  let failure = classifyRemote(machine, result, timeoutMs);
  let snapshot: MachineAnalytics | null = null;
  if (!failure) {
    try {
      const value: unknown = JSON.parse(result.stdout.toString("utf8"));
      if (!value || typeof value !== "object" || "kind" in value) throw new Error("shared");
      snapshot = validateSnapshot(value);
    } catch { failure = new RemoteError("invalid", machine); }
  }
  if (failure && machine.runtime === "installed" && ["rejected", "invalid", "analysis", "index-newer"].includes(failure.reason)) {
    const found = await remoteVersion(machine, signal, deadline);
    if (found && found !== version) throw new RemoteError("version-skew", machine, result.stderr, found);
  }
  if (failure) throw failure;
  return snapshot!;
}

/** This machine's zone as an IANA name, so every machine buckets activity in the same calendar. */
export function localTimeZone(): string {
  return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
}

/** A machine's key in combined snapshots and its last good files: a saved name in lower case, or a plain form of a destination. */
export function machineKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "machine";
}

/** Each machine's key, in order: its `machineKey`, numbered `-2`, `-3`… when another machine or `local` has it already. */
export function machineKeys(machines: ReadonlyArray<Pick<RemoteMachine, "name">>): string[] {
  const keys = new Set<string>([localMachine]);
  return machines.map(({ name }) => {
    let key = machineKey(name);
    for (let attempt = 2; keys.has(key); attempt++) key = `${machineKey(name).slice(0, 60)}-${attempt}`;
    keys.add(key);
    return key;
  });
}

/**
 * What a remote read asks for, so a last good snapshot answers only the same request. Only --offline is left
 * out: the remote report makes no network request either way. --no-index changes the result (no retained history).
 */
export function requestDigest(args: string[]): string {
  return createHash("sha256").update(args.filter((arg) => arg !== "--offline").join("\0")).digest("hex").slice(0, 32);
}

/** Which saved machine, SSH destination and account a last good snapshot came from. */
export function targetDigest(machine: RemoteMachine): string {
  return createHash("sha256").update(JSON.stringify([machine.ssh, machine.user ?? null])).digest("hex").slice(0, 32);
}

/** The hint for a machine read with no sessions. */
export function noHistoryFix(machine: RemoteMachine): string {
  return machine.saved
    ? `if agents run as another account there: ${brand.command} machines set ${machine.name} --user NAME; ${brand.command} machines check ${machine.name} --find-users lists accounts with history`
    : `if agents run as another account there: ${brand.command} machines add ${machine.ssh} --user NAME`;
}

/** The terminal lines for one machine: what was read, or why not, what to run and what is shown instead. */
export function machineReadLines(machine: RemoteMachine, status: MachineStatus, error?: RemoteError): string {
  if (error) {
    const stale = status.state === "stale" ? `\n  Using its last good snapshot from ${machineAge(status.readAt) ?? "an earlier read"} (${status.sessions} sessions).` : "";
    return `Could not read ${machine.name}: ${error.message}.${error.detail ? ` ${error.detail}` : ""}${error.fix ? `\n  Fix: ${error.fix}` : ""}${stale}`;
  }
  if (!status.sessions) return `${machine.name}: no agent history for this account (0 sessions read).\n  Fix: ${noHistoryFix(machine)}`;
  return `Read ${status.sessions} sessions across ${status.repositories} repositories from ${machine.name} in ${((status.durationMs ?? 0) / 1000).toFixed(1)} s.`;
}

/** One other machine: how it is reached, its current status and the snapshot it contributes. */
export interface MachineReading {
  machine: RemoteMachine;
  status: MachineStatus;
  /** The latest good read, or the last good one while stale or reading again. */
  snapshot: MachineAnalytics | null;
  /** Hash of the machine ID and account that answered. */
  identity?: string;
  /** The read in flight. */
  pending: Promise<void> | null;
  /** The machine this one duplicates, once reported. */
  twin?: string;
}

export interface MachineReads {
  readings: MachineReading[];
  /** Settles when last good snapshots are loaded for machines not read yet (with `preload`). */
  loaded: Promise<void>;
  /** Start a read for every machine that is not reading now; resolves when those have settled. */
  start(): Promise<void>;
  /** Stop the reads in flight. */
  abort(): void;
  /** This machine's snapshot with each other machine's current one, and how each was read. */
  combine(local: MachineAnalytics, localMs: number): MachineAnalytics;
  /** Each machine's Claude profile keys as the last combined snapshot names them, by machine key; null before the first. */
  profileKeys(): Map<string, Map<string, string>> | null;
}

/** The options every machine is read with: this machine's zone and portable repository IDs, so snapshots combine. */
export function machineOptions(options: AnalyzeOptions): AnalyzeOptions & { timeZone: string } {
  return { ...options, portableIds: true, timeZone: options.timeZone ?? localTimeZone() };
}

/**
 * Reads other machines, each on its own: a machine starts a new read only when it is not reading, and
 * its status and snapshot change as soon as that read settles. A failed read keeps the machine's last
 * good snapshot (from this process, else from the data directory for a saved machine), marked stale.
 * With `preload`, saved machines show their last good snapshot while their first read runs.
 */
export function machineReads(
  options: AnalyzeOptions & { timeZone: string },
  remote: RemoteOptions,
  { report = () => {}, signal, onSettle = () => {}, preload = false }: { report?: (line: string, failed: boolean) => void; signal?: AbortSignal; onSettle?: () => void; preload?: boolean } = {},
): MachineReads {
  const args = remoteArguments(options), request = requestDigest(args);
  let controller = new AbortController();
  const abort = (): void => { controller.abort(); controller = new AbortController(); };
  signal?.addEventListener("abort", abort, { once: true });
  const keys = machineKeys(remote.machines);
  const readings: MachineReading[] = remote.machines.map((machine, index) =>
    ({ machine, pending: null, snapshot: null, status: { key: keys[index]!, label: machine.name, state: "reading", sessions: 0, repositories: 0, readAt: null, durationMs: null, version: null } }));
  let remapped: Map<string, Map<string, string>> | null = null;
  const lastGood = async (reading: MachineReading): Promise<Pick<MachineReading, "snapshot" | "status" | "identity"> | null> => {
    const { machine } = reading;
    const found = machine.saved ? await readLastGood(options, reading.status.key, { request, target: targetDigest(machine), ...(machine.identity ? { identity: machine.identity } : {}) }) : null;
    if (!found) return null;
    const { record, snapshot } = found;
    return { snapshot, ...(record.identity ? { identity: record.identity } : {}), status: { ...reading.status, sessions: record.sessions, repositories: record.repositories, readAt: record.readAt, durationMs: record.durationMs, version: record.producer } };
  };
  const loaded = Promise.all(readings.map(async (reading) => {
    if (!preload) return;
    const found = await lastGood(reading);
    // A read that settled first has newer news.
    if (found && reading.status.state === "reading" && !reading.snapshot) Object.assign(reading, found, { status: { ...found.status, state: "reading" } });
  })).then(() => {});

  const read = async (reading: MachineReading, stop: AbortSignal): Promise<void> => {
    const { machine } = reading, { key, label } = reading.status;
    const started = performance.now();
    let error: RemoteError | undefined;
    try {
      const answer = await fetchRemoteSnapshot(machine, machine.runtime === "bundled" ? [...args, "--identify-machine"] : args, { timeoutMs: remote.timeoutMs, signal: stop });
      if (answer.velocity?.timeZone !== options.timeZone) throw new RemoteError("time-zone", machine);
      // The bundled runtime describes itself; that entry is about the read, not part of the history.
      const { machines: [self] = [], ...snapshot } = answer;
      const identity = self?.identity ?? machine.identity;
      // A match by host name alone may be a clone or a namesake, so it is never dropped.
      if (identity && identity === localIdentity() && !byHostName(identity)) throw new RemoteError("same-machine", machine);
      const status: MachineStatus = {
        key, label, state: "ok", ...(snapshot.summary.sessions ? {} : { reason: "no-history" as const, fix: noHistoryFix(machine) }),
        sessions: snapshot.summary.sessions, repositories: snapshot.summary.repositories, readAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started), version: self?.version ?? null,
      };
      Object.assign(reading, { snapshot, status, identity, twin: undefined });
      if (machine.saved) {
        try { writeLastGood(options, key, { request, target: targetDigest(machine), readAt: status.readAt!, durationMs: status.durationMs!, producer: status.version, sessions: status.sessions, repositories: status.repositories, ...(identity ? { identity } : {}) }, snapshot); }
        catch { /* The cache only softens a later failure. */ }
      }
    } catch (caught) {
      // Stopped because this machine failed or is shutting down: that error, not this one, is the news.
      const stopped = stop.aborted || stopping();
      error = stopped ? new RemoteError("cancelled", machine) : caught instanceof RemoteError ? caught : new RemoteError("analysis", machine);
      // The previous snapshot of this process is the newest good one; otherwise the stored one.
      const age = reading.status.readAt ? Date.now() - Date.parse(reading.status.readAt) : Infinity;
      const kept = error.reason === "same-machine" ? null
        : reading.snapshot && age <= lastGoodMaxAgeMs ? { snapshot: reading.snapshot, status: reading.status, ...(reading.identity ? { identity: reading.identity } : {}) }
        : stopped ? null : await lastGood(reading);
      const reason = error.reason, fix = error.snapshotFix ? { fix: error.snapshotFix } : {};
      if (kept) Object.assign(reading, kept, { status: { ...kept.status, state: "stale", reason, ...fix } });
      else Object.assign(reading, { snapshot: null, identity: undefined, status: { key, label, state: "failed", reason, ...fix, sessions: 0, repositories: 0, readAt: null, durationMs: null, version: null } });
      if (stopped) return;
    }
    report(machineReadLines(machine, reading.status, error), Boolean(error) || !reading.status.sessions);
  };

  const start = (): Promise<void> => {
    const stop = signal?.aborted ? signal : controller.signal;
    for (const reading of readings) {
      if (reading.pending) continue;
      const { key, label, sessions, repositories, readAt, durationMs, version: producer } = reading.status;
      reading.status = { key, label, state: "reading", sessions, repositories, readAt, durationMs, version: producer };
      reading.pending = read(reading, stop).finally(() => { reading.pending = null; onSettle(); });
    }
    return Promise.all(readings.map(({ pending }) => pending)).then(() => {});
  };

  const combine = (local: MachineAnalytics, localMs: number): MachineAnalytics => {
    // A machine reached twice counts once: answers read now win, in the configured order, then stale ones.
    const seen = new Map<string, string>([[localIdentity(), remote.local]]), twins = new Map<MachineReading, string>();
    for (const reading of [...readings].sort((left, right) => Number(left.status.state !== "ok") - Number(right.status.state !== "ok"))) {
      if (!reading.snapshot || !reading.identity || byHostName(reading.identity)) continue;
      const twin = seen.get(reading.identity);
      if (twin) twins.set(reading, twin); else seen.set(reading.identity, reading.machine.name);
    }
    const statuses: MachineStatus[] = [{ key: localMachine, label: remote.local, state: "ok", sessions: local.summary.sessions, repositories: local.summary.repositories, readAt: local.generatedAt, durationMs: Math.round(localMs), version }];
    const inputs: Array<MachineAnalytics | null> = [local];
    for (const reading of readings) {
      const twin = twins.get(reading);
      if (!twin) { statuses.push(reading.status); inputs.push(reading.snapshot); continue; }
      const error = new RemoteError("same-machine", reading.machine, "", twin);
      if (reading.twin !== twin) { reading.twin = twin; report(`Not counting ${reading.machine.name}: ${error.message}.${error.fix ? `\n  Fix: ${error.fix}` : ""}`, true); }
      const { key, label } = reading.status;
      statuses.push({ key, label, state: "failed", reason: "same-machine", ...(error.snapshotFix ? { fix: error.snapshotFix } : {}), sessions: 0, repositories: 0, readAt: null, durationMs: null, version: null });
      inputs.push(null);
    }
    const warnings = [...(statuses.some(({ state }) => state === "failed") ? [remoteUnavailableWarning] : []), ...(statuses.some(({ state }) => state === "stale") ? [staleMachineWarning] : [])];
    const combined = combineSnapshots(inputs, { machines: statuses, warnings });
    const remaps = profileKeyRemaps(inputs.map(historyProfileKeys));
    remapped = new Map(statuses.map(({ key }, index) => [key, new Map(remaps[index])]));
    return combined;
  };

  return { readings, loaded, start, abort, combine, profileKeys: () => remapped };
}

/**
 * This machine and every remote one, combined into one validated snapshot. The local scan and the
 * remote reads run at the same time, and each machine is reported as soon as it settles. A machine
 * that cannot be read is listed with its reason and, when it has one, its last good snapshot; a
 * failed local scan stops the reads and fails the whole result.
 */
export async function analyzeMachines(
  options: AnalyzeOptions,
  remote: RemoteOptions,
  report: (line: string, failed: boolean) => void = () => {},
  signal?: AbortSignal,
  hooks: AnalysisHooks = {},
): Promise<MachineAnalytics> {
  if (!remote.machines.length) return await analyzeMachineSessionsIsolated(options, hooks);
  const local = machineOptions(options);
  const reads = machineReads(local, remote, { report, ...(signal ? { signal } : {}) });
  const settled = reads.start();
  try {
    const started = performance.now();
    const own = await analyzeMachineSessionsIsolated(local, hooks).catch((error: unknown) => { reads.abort(); throw error; });
    const ms = performance.now() - started;
    await settled;
    // A stopped run never passes for this machine alone.
    if (signal?.aborted || stopping()) throw new RemoteError("cancelled");
    return reads.combine(own, ms);
  } finally {
    await settled;
  }
}
