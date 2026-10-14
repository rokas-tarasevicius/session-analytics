import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

import { brand } from "../brand.ts";
import { accountPattern, type RemoteMachine } from "../options.ts";
import { accountPrefix, classifyRemote, fetchRemoteSnapshot, localTimeZone, RemoteError, remoteArguments, runRemote, runSsh } from "../remote.ts";
import { runtimePayload } from "../remote/runtime.ts";
import { version } from "../version.ts";
import type { SavedMachine } from "./config.ts";

export type CheckName = "ssh" | "sudo" | "node" | "machine" | "runtime" | "command" | "history" | "accounts";

export interface CheckResult {
  check: CheckName;
  status: "ok" | "warn" | "fail";
  text: string;
  detail?: string;
  fix?: string;
  ms?: number;
}

export interface MachineCheck {
  name: string;
  ok: boolean;
  /** True once ssh itself worked; `add` saves only then. */
  reachable: boolean;
  checks: CheckResult[];
  /** Keyed hash of the machine and account; never the raw machine ID. */
  identity?: string;
  sessions?: number;
  accounts?: string[];
}

const probeDeadline = (): number => Date.now() + 30_000;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** A machine and account as a 16-digit hash: the raw machine ID never leaves this function. */
function identityOf(machineId: string, uid: string): string {
  return createHash("sha256").update(`session-analytics machine v1\0${machineId.trim()}\0${uid.trim()}`).digest("hex").slice(0, 16);
}

export function localIdentity(): string {
  let id: string;
  try { id = readFileSync("/etc/machine-id", "utf8"); } catch { id = hostname(); }
  return identityOf(id, String(process.getuid?.() ?? ""));
}

// Fixed scripts, sent on stdin to `sh -s`; only a validated node word is substituted.
const probeScript = (node: string): string => `if command -v ${node} >/dev/null 2>&1; then ${node} --version; else echo none; fi
cat /etc/machine-id 2>/dev/null || hostname
id -u
`;
const findUsersScript = `{ getent passwd 2>/dev/null || cat /etc/passwd; } | while IFS=: read -r name _ _ _ _ home shell; do
  case "$shell" in *nologin|*false|"") continue;; esac
  for dir in .claude .codex .t3/userdata; do
    if test -d "$home/$dir" 2>/dev/null || sudo -n test -d "$home/$dir" </dev/null 2>/dev/null; then echo "$name"; break; fi
  done
done
`;

function failed(check: CheckName, error: RemoteError, ms?: number): CheckResult {
  return { check, status: "fail", text: error.message, ...(error.detail ? { detail: error.detail } : {}), ...(error.fix ? { fix: error.fix } : {}), ...(ms !== undefined ? { ms } : {}) };
}

/** Login accounts whose home holds agent history, by name only; homes hidden from the SSH user are tested through `sudo -n`. */
export async function findAccounts(machine: RemoteMachine): Promise<string[] | RemoteError> {
  const result = await runSsh(machine.ssh, ["sh", "-s"], { input: findUsersScript, deadline: probeDeadline(), limit: 65_536 });
  const error = classifyRemote({ ...machine, user: undefined, runtime: "installed" }, result);
  if (error) return error;
  return [...new Set(result.stdout.toString("utf8").split("\n").map((line) => line.trim()).filter((name) => accountPattern.test(name)))].sort();
}

/**
 * The doctor: ssh, sudo, node, duplicate machines, the runtime, then a real read. Each failure
 * carries the exact fix; later checks are skipped once one fails, except the account search.
 */
export async function checkMachine(
  machine: RemoteMachine,
  { timeoutMs, others = [], findUsers = false, onCheck = () => {} }: { timeoutMs: number; others?: SavedMachine[]; findUsers?: boolean; onCheck?: (check: CheckResult) => void },
): Promise<MachineCheck> {
  const result: MachineCheck = { name: machine.name, ok: false, reachable: false, checks: [] };
  const add = (check: CheckResult): boolean => { result.checks.push(check); onCheck(check); return check.status !== "fail"; };
  const finish = async (): Promise<MachineCheck> => {
    if (findUsers && result.reachable) {
      const accounts = await findAccounts(machine);
      if (accounts instanceof RemoteError) add(failed("accounts", accounts));
      else {
        result.accounts = accounts;
        const hint = accounts.length && (!machine.user || !accounts.includes(machine.user)) ? `${brand.command} machines set ${machine.name} --user ${accounts[0]}` : undefined;
        add({ check: "accounts", status: accounts.length ? "ok" : "warn", text: accounts.length ? `agent history found for ${accounts.join(", ")}` : "no login account has .claude, .codex or .t3/userdata", ...(hint ? { fix: hint } : {}) });
      }
    }
    result.ok = result.checks.every((check) => check.status !== "fail");
    return result;
  };

  const ssh = await runSsh(machine.ssh, ["true"], { deadline: probeDeadline() });
  const sshError = classifyRemote({ ...machine, user: undefined }, ssh);
  if (!add(sshError ? failed("ssh", sshError, ssh.ms) : { check: "ssh", status: "ok", text: `connected in ${seconds(ssh.ms)} without a prompt`, ms: ssh.ms })) return await finish();
  result.reachable = true;

  if (machine.user) {
    const sudo = await runSsh(machine.ssh, [...accountPrefix(machine), "true"], { deadline: probeDeadline() });
    const error = classifyRemote(machine, sudo);
    if (!add(error ? failed("sudo", error) : { check: "sudo", status: "ok", text: `sudo -n -iu ${machine.user} works without a password` })) return await finish();
  }

  const probe = await runSsh(machine.ssh, [...accountPrefix(machine), "sh", "-s"], { input: probeScript(machine.node), deadline: probeDeadline(), limit: 65_536 });
  const probeError = classifyRemote({ ...machine, runtime: "installed" }, probe);
  const [nodeVersion = "", machineId = "", uid = ""] = probe.stdout.toString("utf8").split("\n").map((line) => line.trim());
  if (probeError || !machineId || !/^\d+$/.test(uid)) {
    add(failed("node", probeError ?? new RemoteError("invalid", machine, probe.stderr)));
    return await finish();
  }
  if (machine.runtime === "bundled") {
    const major = /^v(\d+)\.\d+\.\d+$/.exec(nodeVersion)?.[1];
    const error = !major ? new RemoteError("no-node", machine) : Number(major) < 24 ? new RemoteError("node-too-old", machine, "", nodeVersion) : null;
    if (!add(error ? failed("node", error) : { check: "node", status: "ok", text: `${nodeVersion} (needs 24 or later)` })) return await finish();
  }
  result.identity = identityOf(machineId, uid);
  const twin = others.find((other) => other.name.toLowerCase() !== machine.name.toLowerCase() && other.identity === result.identity);
  if (!add(result.identity === localIdentity()
    ? { check: "machine", status: "fail", text: "this is this machine and account, which is always read", fix: `${brand.command} machines remove ${machine.name}` }
    : twin
      ? { check: "machine", status: "fail", text: `the same machine and account as ${twin.name}; reading both would count its history twice`, fix: `${brand.command} machines remove ${machine.name}` }
      : { check: "machine", status: "ok", text: "not this machine, and not saved under another name" })) return await finish();

  const runtime = await runRemote(machine, ["--version"], { deadline: Date.now() + timeoutMs, limit: 4096 });
  const answer = runtime.stdout.toString("utf8").trim();
  const runtimeError = classifyRemote(machine, runtime, timeoutMs);
  if (machine.runtime === "bundled") {
    const payload = runtimePayload();
    const stored = runtime.installed ? `installed now (${Math.round(payload.bytes / 1024)} KB in ${seconds(runtime.ms)})` : "cached";
    if (!add(runtimeError ? failed("runtime", runtimeError, runtime.ms) : { check: "runtime", status: "ok", text: `${answer}+${payload.digest.slice(0, 8)} ${stored}`, ms: runtime.ms })) return await finish();
  } else {
    const error = runtimeError ?? (answer === version ? null : /^\d+\.\d+\.\d+/.test(answer) ? new RemoteError("version-skew", machine, "", answer) : new RemoteError("invalid", machine));
    if (!add(error ? failed("command", error) : { check: "command", status: "ok", text: `${machine.command.join(" ")} runs ${answer}, the same as this machine` })) return await finish();
  }

  const started = performance.now();
  try {
    const snapshot = await fetchRemoteSnapshot(machine, remoteArguments({ timeZone: localTimeZone() }), { timeoutMs });
    const ms = performance.now() - started;
    result.sessions = snapshot.summary.sessions;
    add(snapshot.summary.sessions
      ? { check: "history", status: "ok", text: `${snapshot.summary.sessions} sessions, ${snapshot.summary.repositories} repositories in ${seconds(ms)}`, ms }
      : {
        check: "history", status: "warn", text: `no agent history for this account (0 sessions in ${seconds(ms)})`, ms,
        fix: `if agents run as another account: ${brand.command} machines set ${machine.name} --user NAME; add --find-users to list accounts with history`,
      });
  } catch (error) {
    add(failed("history", error instanceof RemoteError ? error : new RemoteError("analysis", machine), performance.now() - started));
  }
  return await finish();
}

const marks = { ok: "✓", warn: "!", fail: "✗" } as const;

/** The heading for one machine: how it is reached and run. */
export function checkHeading(machine: RemoteMachine, enabled = true): string {
  const how = [`ssh ${machine.ssh}`, ...(machine.user ? [`as ${machine.user}`] : []), machine.runtime === "bundled" ? "bundled runtime" : `installed: ${machine.command.join(" ")}`, ...(enabled ? [] : ["disabled"])];
  return `${machine.name}  (${how.join(", ")})\n`;
}

/** One check's line, and its fix on the next line. */
export function checkLine(item: CheckResult): string {
  return `  ${marks[item.status]} ${item.check.padEnd(9)} ${item.text}${item.detail ? `. ${item.detail}` : ""}\n${item.fix ? `    Fix: ${item.fix}\n` : ""}`;
}
