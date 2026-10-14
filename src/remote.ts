import { spawn } from "node:child_process";
import { analyzeMachineSessionsIsolated } from "./analysis-process.ts";
import { brand } from "./brand.ts";
import { combineSnapshots } from "./interop/combine.ts";
import { maximumSnapshotBytes } from "./interop/files.ts";
import { validateSnapshot } from "./interop/snapshot.ts";
import { canonicalTimeZone, type RemoteMachine, type RemoteOptions } from "./options.ts";
import { track } from "./processes.ts";
import { remoteUnavailableWarning } from "./public/evidence.js";
import { runtimePayload } from "./remote/runtime.ts";
import type { AnalyzeOptions, MachineAnalytics } from "./types.ts";
import { version } from "./version.ts";

const STDERR_TAIL_BYTES = 8192;
export const sshOptions = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-T"];
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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
  failure: "no-ssh" | "timeout" | "too-large" | "cancelled" | null;
  ms: number;
}

export interface SshCall {
  /** stdin to send; without it stdin stays open until the call settles. */
  input?: string;
  /** Epoch milliseconds after which the call is stopped. */
  deadline: number;
  signal?: AbortSignal;
  limit?: number;
}

/** Run plain words on a machine through the user's own ssh, without a terminal or prompts. */
export async function runSsh(destination: string, words: string[], { input, deadline, signal, limit = maximumSnapshotBytes }: SshCall): Promise<SshResult> {
  const started = performance.now();
  return await new Promise((resolve) => {
    const child = track(spawn("ssh", [...sshOptions, "--", destination, ...words], { stdio: ["pipe", "pipe", "pipe"] }));
    const chunks: Buffer[] = [];
    let bytes = 0, stderr = "", settled = false;
    let failure: SshResult["failure"] = null;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      child.stdin.destroy();
      resolve({ code, stdout: Buffer.concat(chunks), stderr, failure, ms: performance.now() - started });
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
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES); });
    child.once("error", (error: NodeJS.ErrnoException) => { failure ??= error.code === "ENOENT" ? "no-ssh" : "cancelled"; finish(null); });
    child.once("close", (code) => finish(code));
  });
}

/** The words before the command: `sudo -n -iu USER` when the machine names an account. */
export function accountPrefix(machine: RemoteMachine): string[] {
  return machine.user ? ["sudo", "-n", "-iu", machine.user] : [];
}

/**
 * Run session-analytics there with these arguments. The bundled runtime sends the bootstrap on stdin
 * and, only when it answers need-runtime (75), sends this install in a second round trip.
 */
export async function runRemote(machine: RemoteMachine, args: string[], call: Omit<SshCall, "input">): Promise<SshResult & { installed: boolean }> {
  const prefix = accountPrefix(machine);
  if (machine.runtime === "installed") return { ...await runSsh(machine.ssh, [...prefix, ...machine.command, ...args], call), installed: false };
  const runtime = runtimePayload();
  const words = (mode: "run" | "install"): string[] => [...prefix, machine.node, "-", "sa1", mode, runtime.version, runtime.digest, ...args];
  const first = await runSsh(machine.ssh, words("run"), { ...call, input: runtime.run });
  if (first.failure || first.code !== 75 || !/^sa1: need-runtime$/m.test(first.stderr)) return { ...first, installed: false };
  const second = await runSsh(machine.ssh, words("install"), { ...call, input: runtime.install });
  return { ...second, ms: first.ms + second.ms, installed: true };
}

export type RemoteFailure = "no-ssh" | "connection" | "dropped" | "sudo" | "no-account" | "permission" | "missing-command" | "no-node" | "node-too-old"
  | "runtime" | "cache-unwritable" | "corrupted" | "version-skew" | "rejected" | "busy" | "index-newer" | "analysis" | "invalid" | "time-zone"
  | "timeout" | "too-large" | "cancelled";

function failureText(reason: RemoteFailure, machine: RemoteMachine | null, found: string, timeoutMs: number): string {
  const account = machine?.user ?? "the SSH account";
  const texts: Record<RemoteFailure, string> = {
    "no-ssh": "ssh is not available on this machine",
    connection: "SSH could not connect or log in without a prompt",
    dropped: "the SSH session ended without an exit status (connection dropped, or the remote process was killed)",
    sudo: `sudo needs a password to run as ${account}`,
    "no-account": `the account ${account} does not exist there`,
    permission: "the remote command is not executable for that account",
    "missing-command": "session-analytics was not found on the remote PATH",
    "no-node": `node was not found on ${account}'s login PATH`,
    "node-too-old": `the remote Node.js is ${found || "too old"}; the bundled runtime needs 24 or later`,
    runtime: "the bundled runtime could not start there",
    "cache-unwritable": `the bundled runtime cannot be stored in ${account}'s ~/.cache`,
    corrupted: "the bundled runtime arrived damaged",
    "version-skew": `the remote runs session-analytics ${found}, this machine ${version}`,
    rejected: "the remote session-analytics rejected the request (probably another version)",
    busy: "the remote index is busy with another read",
    "index-newer": "the remote index was created by a newer session-analytics",
    analysis: "the remote analysis failed",
    invalid: "the remote output was not a valid full snapshot",
    "time-zone": "the remote snapshot used another time zone",
    timeout: `no snapshot within ${Math.round(timeoutMs / 1000)} seconds`,
    "too-large": "the remote snapshot exceeded the snapshot size limit",
    cancelled: "the read was stopped",
  };
  return texts[reason];
}

/** The exact next step for each reason; empty when there is none to take. */
function fixText(reason: RemoteFailure, machine: RemoteMachine | null): string {
  if (!machine) return "";
  const command = brand.command, name = machine.name, as = machine.user ? ` --user ${machine.user}` : "";
  const check = machine.saved ? `${command} machines check ${name}` : `${command} machines add ${machine.ssh}${as}`;
  const bundled = machine.saved ? `${command} machines set ${name} --runtime bundled` : `${command} machines add ${machine.ssh}${as}`;
  const node = machine.saved ? `${command} machines set ${name} --node /usr/bin/node` : `${command} machines add ${machine.ssh}${as} --node /usr/bin/node`;
  const fixes: Record<RemoteFailure, string> = {
    "no-ssh": "install an OpenSSH client so that ssh is on PATH",
    connection: `run ssh ${machine.ssh} true once in a terminal to accept the host key and check the login (ssh-copy-id ${machine.ssh} installs a key)`,
    dropped: `check that the machine is up and has memory to spare, then ${check}`,
    sudo: machine.user
      ? `on that machine run: echo "$USER ALL=(${machine.user}) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/session-analytics && sudo chmod 0440 /etc/sudoers.d/session-analytics`
      : "allow that command through sudo without a password there",
    "no-account": machine.saved ? `${command} machines check ${name} --find-users lists the accounts with agent history` : "check the account name in --remote-command",
    permission: `use the bundled runtime: ${bundled}`,
    "missing-command": machine.saved
      ? `use the bundled runtime (${bundled}), or name the command in full: ${command} machines set ${name} --command "node /path/to/session-analytics/bin/session-analytics.ts"`
      : `use the bundled runtime (${bundled}), or name the command in full: --remote-command "node /path/to/session-analytics/bin/session-analytics.ts"`,
    "no-node": `install Node.js 24 or later there, or point to it: ${node}`,
    "node-too-old": `install Node.js 24 or later there, or point to a newer one: ${node}`,
    runtime: `retry; if it persists, run ${check}`,
    "cache-unwritable": machine.saved ? `${command} machines set ${name} --runtime installed, or set XDG_CACHE_HOME to a writable directory in that account's profile` : "set XDG_CACHE_HOME to a writable directory in that account's profile",
    corrupted: "retry the read",
    "version-skew": `install ${version} there, or use the bundled runtime: ${bundled}`,
    rejected: `run the same version on both machines, or use the bundled runtime: ${bundled}`,
    busy: "retry in a minute; an earlier read there is still finishing",
    "index-newer": "upgrade session-analytics on this machine, or read with --no-index",
    analysis: `run ${check}`,
    invalid: `make sure nothing in that account's login profile prints to stdout${machine.runtime === "installed" ? `, and run the same version on both machines (${bundled})` : ""}`,
    "time-zone": "",
    timeout: `allow more time with --remote-timeout SECONDS, or warm its index once with ${check}`,
    "too-large": "read it with --exclude-hidden, or merge snapshot files instead (see docs/interop.md)",
    cancelled: "",
  };
  return fixes[reason];
}

/**
 * The most telling stderr line, sanitized, for this terminal only. Node's version trailer, stack
 * frames and source excerpts are skipped so a crash shows its error, not `Node.js v24.x`.
 */
export function stderrDetail(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.replace(/[\u0000-\u001f\u007f]/g, "").trim())
    .filter((line) => line && !/^Node\.js v\d/.test(line) && !/^at\s/.test(line) && !/^\^+$/.test(line) && !/^\[stdin\]:\d+$/.test(line) && line !== "sa1: need-runtime");
  const telling = lines.filter((line) => /^[A-Za-z]*Error\b|^sudo:|^sa1:|denied|not found|required|refused|failed|unknown|cannot|could not|busy|newer|no such|timed out|killed|stopped/i.test(line));
  return (telling.at(-1) ?? lines.at(-1) ?? "").slice(0, 300);
}

/** A fixed reason and its fix, plus the most telling stderr line, for this terminal only. */
export class RemoteError extends Error {
  readonly reason: RemoteFailure;
  readonly detail: string;
  readonly fix: string;
  constructor(reason: RemoteFailure, machine: RemoteMachine | null = null, stderr = "", found = "", timeoutMs = 0) {
    super(failureText(reason, machine, found, timeoutMs));
    this.reason = reason;
    this.detail = stderrDetail(stderr);
    this.fix = fixText(reason, machine);
  }
}

const sshProblem = /^ssh:|Permission denied \(|Host key verification failed|Could not resolve hostname|Connection (?:refused|timed out|closed|reset)|No route to host|kex_exchange_identification|Too many authentication failures/m;

/** Map an ssh result to a reason: transport, account, runtime, then the remote analysis itself. */
export function classifyRemote(machine: RemoteMachine, result: SshResult, timeoutMs = 0): RemoteError | null {
  const error = (reason: RemoteFailure, found = ""): RemoteError => new RemoteError(reason, machine, reason === "no-ssh" ? "" : result.stderr, found, timeoutMs);
  if (result.failure) return error(result.failure);
  if (result.code === 0) return null;
  const { stderr } = result;
  if (result.code === 255) return error(sshProblem.test(stderr) ? "connection" : "dropped");
  if (/^sudo: .*(?:password is required|terminal is required)/m.test(stderr)) return error("sudo");
  if (/^sudo: (?:unknown user|user .* not found|.*: unknown user)/mi.test(stderr)) return error("no-account");
  const bootstrap: Partial<Record<number, RemoteFailure>> = { 75: "runtime", 78: "node-too-old", 79: "runtime", 80: "cache-unwritable", 81: "corrupted" };
  const reason = machine.runtime === "bundled" ? bootstrap[result.code ?? -1] : undefined;
  if (reason) return error(reason, /^sa1: node-too-old (v[\d.]+)$/m.exec(stderr)?.[1] ?? "");
  if (result.code === 126) return error("permission");
  if (result.code === 127) return error(machine.runtime === "bundled" ? "no-node" : "missing-command");
  if (result.code === 2) return error("rejected");
  if (/ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|bad option: --experimental-strip-types/.test(stderr)) return error("node-too-old");
  if (/The local index is busy/.test(stderr)) return error("busy");
  if (/The local index was created by a newer version/.test(stderr)) return error("index-newer");
  return error("analysis");
}

/** An installed remote's version, or null when it does not answer with one. */
export async function remoteVersion(machine: RemoteMachine, signal?: AbortSignal): Promise<string | null> {
  const result = await runRemote(machine, ["--version"], { deadline: Date.now() + 30_000, signal, limit: 4096 });
  const answer = result.stdout.toString("utf8").trim();
  return result.code === 0 && versionPattern.test(answer) ? answer : null;
}

/** One machine's validated snapshot. An installed remote that fails as if it ran another version is asked which. */
export async function fetchRemoteSnapshot(machine: RemoteMachine, args: string[], { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<MachineAnalytics> {
  const result = await runRemote(machine, args, { deadline: Date.now() + timeoutMs, signal });
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
    const found = await remoteVersion(machine, signal);
    if (found && found !== version) throw new RemoteError("version-skew", machine, result.stderr, found);
  }
  if (failure) throw failure;
  return snapshot!;
}

/** This machine's zone as an IANA name, so every machine buckets activity in the same calendar. */
export function localTimeZone(): string {
  return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
}

export interface MachineRead {
  name: string;
  state: "read" | "empty" | "failed";
  sessions?: number;
  ms?: number;
  error?: RemoteError;
}

/** The terminal lines for one machine: what was read, or why not and what to run. */
export function machineReadLines(read: MachineRead, machine: RemoteMachine): string {
  if (read.state === "failed") {
    const error = read.error!;
    return `Could not read ${read.name}: ${error.message}.${error.detail ? ` ${error.detail}` : ""}${error.fix ? `\n  Fix: ${error.fix}` : ""}`;
  }
  if (read.state === "empty") {
    const fix = machine.saved
      ? `${brand.command} machines set ${machine.name} --user NAME; ${brand.command} machines check ${machine.name} --find-users lists accounts with history`
      : `${brand.command} machines add ${machine.ssh} --user NAME`;
    return `${read.name}: no agent history for this account (0 sessions read).\n  Fix: if agents run as another account there: ${fix}`;
  }
  return "";
}

/**
 * This machine and every remote one, combined into one validated snapshot. The local scan and the
 * remote reads run at the same time, and each machine is reported as soon as it settles. A machine
 * that cannot be read leaves a fixed warning in the snapshot; a failed local scan stops the reads
 * and fails the whole result.
 */
export async function analyzeMachines(
  options: AnalyzeOptions,
  remote: RemoteOptions,
  report: (line: string, failed: boolean, read?: MachineRead) => void = () => {},
  signal?: AbortSignal,
): Promise<MachineAnalytics> {
  if (!remote.machines.length) return await analyzeMachineSessionsIsolated(options);
  const local = { ...options, portableIds: true, timeZone: options.timeZone ?? localTimeZone() };
  const args = remoteArguments(local);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const reads = remote.machines.map(async (machine): Promise<MachineAnalytics | null> => {
    const started = performance.now();
    let read: MachineRead;
    let snapshot: MachineAnalytics | null = null;
    try {
      snapshot = await fetchRemoteSnapshot(machine, args, { timeoutMs: remote.timeoutMs, signal: controller.signal });
      if (snapshot.velocity?.timeZone !== local.timeZone) throw new RemoteError("time-zone", machine);
      read = { name: machine.name, state: snapshot.summary.sessions ? "read" : "empty", sessions: snapshot.summary.sessions, ms: performance.now() - started };
    } catch (error) {
      snapshot = null;
      read = { name: machine.name, state: "failed", error: error instanceof RemoteError ? error : new RemoteError("analysis", machine) };
    }
    if (read.state === "failed" && read.error?.reason === "cancelled" && signal?.aborted) return null;
    const line = read.state === "read"
      ? `Read ${snapshot!.summary.sessions} sessions across ${snapshot!.summary.repositories} repositories from ${machine.name} in ${(read.ms! / 1000).toFixed(1)} s.`
      : machineReadLines(read, machine);
    report(line, read.state !== "read", read);
    return snapshot;
  });
  try {
    const own = await analyzeMachineSessionsIsolated(local).catch((error: unknown) => { controller.abort(); throw error; });
    const others = await Promise.all(reads);
    const snapshots = [own, ...others.filter((snapshot): snapshot is MachineAnalytics => snapshot !== null)];
    return combineSnapshots(snapshots, snapshots.length <= remote.machines.length ? [remoteUnavailableWarning] : []);
  } finally {
    signal?.removeEventListener("abort", abort);
    await Promise.allSettled(reads);
  }
}
