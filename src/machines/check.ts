import { sourceHealthNotes } from "../public/evidence.js";
import { brand } from "../brand.ts";
import { accountPattern, type RemoteMachine } from "../options.ts";
import { stopping } from "../processes.ts";
import { accountPrefix, classifyRemote, fetchRemoteSnapshot, localTimeZone, noHistoryFix, RemoteError, remoteArguments, runRemote, runSsh, versionPattern } from "../remote.ts";
import { runtimePayload } from "../remote/runtime.ts";
import { version } from "../version.ts";
import type { SavedMachine } from "./config.ts";
import { byHostName, identityOf, localIdentity } from "./identity.ts";

export type CheckName = "ssh" | "sudo" | "node" | "machine" | "runtime" | "command" | "history" | "accounts";

export interface CheckResult {
  check: CheckName;
  status: "ok" | "warn" | "fail";
  text: string;
  /** The most telling line ssh or the remote printed, sanitized. */
  detail?: string;
  fix?: string;
  ms?: number;
}

export interface MachineCheck {
  name: string;
  ok: boolean;
  /** True once ssh itself worked. */
  reachable: boolean;
  /** A failure `add` does not save: no login, no such account, or this machine or a saved one again. */
  refused: boolean;
  checks: CheckResult[];
  /** Hash of the machine ID and account; never the raw machine ID. */
  identity?: string;
  sessions?: number;
  accounts?: string[];
}

/** A login account there with agent history; one whose shell refuses commands is read with --no-login-shell. */
interface Account { name: string; loginShell: boolean }

const command = brand.command;
const probeDeadline = (): number => Date.now() + 30_000;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

// Fixed scripts, sent on stdin to `sh -s`; only a validated node word is substituted. The machine ID is read the
// way this machine reads its own (src/machines/identity.ts), and marked `host` when only the host name is left.
const probeScript = (node: string): string => `if command -v ${node} >/dev/null 2>&1; then ${node} --version; else echo none; fi
machine="\${SESSION_ANALYTICS_MACHINE_ID:-}"
[ -n "$machine" ] || machine=$(cat /etc/machine-id 2>/dev/null)
[ -n "$machine" ] || machine=$(cat /var/lib/dbus/machine-id 2>/dev/null)
[ -n "$machine" ] || machine=$(/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | sed -n 's/.*"IOPlatformUUID" = "\\([^"]*\\)".*/\\1/p')
if [ -n "$machine" ]; then echo "id $machine"; else echo "host $(hostname)"; fi
id -u
id -un
`;
// macOS has no getent, so its accounts come from dscl. sudo is tried once, then only for homes the SSH user cannot enter,
// so a machine without passwordless sudo logs one refusal rather than one per account. An account whose shell refuses
// commands (a service account) is listed too, marked, because it can still be read without a login shell.
const findUsersScript = `if sudo -n true </dev/null >/dev/null 2>&1; then sudo=yes; else sudo=; fi
{ getent passwd 2>/dev/null || { command -v dscl >/dev/null 2>&1 && dscl . -list /Users NFSHomeDirectory | awk '{ print $1 ":*::::" $2 ":/bin/sh" }'; } || cat /etc/passwd; } |
while IFS=: read -r name _ _ _ _ home shell; do
  [ -d "$home" ] || continue
  case "$shell" in *nologin|*false|"") login=" no-login-shell";; *) login=;; esac
  for dir in .claude .codex .t3/userdata; do
    if test -d "$home/$dir" 2>/dev/null || { test -n "$sudo" && ! test -x "$home" && sudo -n test -d "$home/$dir" </dev/null 2>/dev/null; }; then echo "$name$login"; break; fi
  done
done
`;

function failed(check: CheckName, error: RemoteError, ms?: number): CheckResult {
  return { check, status: "fail", text: error.message, ...(error.detail ? { detail: error.detail } : {}), ...(error.fix ? { fix: error.fix } : {}), ...(ms !== undefined ? { ms } : {}) };
}

/** Login accounts whose home holds agent history, by name only; homes hidden from the SSH user are tested through `sudo -n`. */
export async function findAccounts(machine: RemoteMachine): Promise<Account[] | RemoteError> {
  const result = await runSsh(machine.ssh, ["sh", "-s"], { input: findUsersScript, deadline: probeDeadline(), limit: 65_536 });
  const error = classifyRemote({ ...machine, user: undefined, runtime: "installed" }, result);
  if (error) return error;
  const accounts = new Map<string, Account>();
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const [name = "", marker] = line.trim().split(" ");
    if (accountPattern.test(name) && (marker === undefined || marker === "no-login-shell")) accounts.set(name, { name, loginShell: marker === undefined });
  }
  return [...accounts.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The doctor: ssh, sudo, node, duplicate machines, the runtime, then a real read. Each failure
 * carries the exact fix; later checks are skipped once one fails, except the account search.
 * While `adding`, a failure that keeps the machine from being saved names `machines add` in its fix,
 * and accounts with history are looked up when the account named does not exist or has none.
 */
export async function checkMachine(
  machine: RemoteMachine,
  { timeoutMs, others = [], findUsers = false, adding = false, onCheck = () => {} }: { timeoutMs: number; others?: SavedMachine[]; findUsers?: boolean; adding?: boolean; onCheck?: (check: CheckResult) => void },
): Promise<MachineCheck> {
  const result: MachineCheck = { name: machine.name, ok: false, reachable: false, refused: false, checks: [] };
  const unsaved: RemoteMachine = adding ? { ...machine, saved: false } : machine;
  let accounts: Account[] | RemoteError | undefined, wantAccounts = findUsers, account = machine.user;
  const lookup = async (): Promise<Account[] | RemoteError> => accounts ??= await findAccounts(machine);
  const add = (check: CheckResult): boolean => {
    if (check.ms !== undefined) check.ms = Math.round(check.ms);
    result.checks.push(check);
    onCheck(check);
    return check.status !== "fail";
  };
  // When the account read has no history, the others that do (but root): the ones agents may run as.
  const candidates = (found: Account[]): Account[] => found.some(({ name }) => name === account) ? [] : found.filter(({ name }) => name !== "root");
  // A machine not saved (refused while adding) is added again; a saved one is changed.
  const hint = (found: Account[]): string | undefined => {
    if (!found.length) return undefined;
    const target = adding && result.refused ? `${command} machines add ${machine.ssh}` : `${command} machines set ${machine.name}`;
    return found.length === 1 ? `${target} --user ${found[0]!.name}${found[0]!.loginShell ? "" : " --no-login-shell"}`
      : `${target} --user ACCOUNT, where ACCOUNT is one of ${found.map(({ name }) => name).join(", ")}`;
  };
  const finish = async (): Promise<MachineCheck> => {
    // A signal is stopping this process; nothing new starts.
    if (wantAccounts && result.reachable && !stopping()) {
      const found = await lookup();
      if (found instanceof RemoteError) add(failed("accounts", found));
      else {
        result.accounts = found.map(({ name }) => name);
        const fix = hint(candidates(found));
        add({
          check: "accounts", status: found.length ? "ok" : "warn",
          text: found.length ? `agent history found for ${found.map(({ name, loginShell }) => `${name}${loginShell ? "" : " (no login shell)"}`).join(", ")}` : "no login account has .claude, .codex or .t3/userdata",
          ...(fix ? { fix } : {}),
        });
      }
    }
    result.ok = result.checks.every((check) => check.status !== "fail");
    return result;
  };

  const ssh = await runSsh(machine.ssh, ["true"], { deadline: probeDeadline() });
  const sshError = classifyRemote({ ...unsaved, user: undefined }, ssh);
  if (sshError) { result.refused = true; add(failed("ssh", sshError, ssh.ms)); return await finish(); }
  result.reachable = true;
  // A shared connection someone else opened (ControlMaster) can hide a login that BatchMode cannot make on its own.
  const shared = (await runSsh(machine.ssh, [], { deadline: probeDeadline(), options: ["-O", "check"] })).code === 0;
  const fresh = shared ? classifyRemote({ ...unsaved, user: undefined }, await runSsh(machine.ssh, ["true"], { deadline: probeDeadline(), options: ["-o", "ControlMaster=no", "-o", "ControlPath=none"] })) : null;
  add(fresh
    ? { check: "ssh", status: "warn", text: `connected in ${seconds(ssh.ms)}, but only through an open shared connection; on its own: ${fresh.message}`, ...(fresh.detail ? { detail: fresh.detail } : {}), ...(fresh.fix ? { fix: fresh.fix } : {}), ms: ssh.ms }
    : { check: "ssh", status: "ok", text: `connected in ${seconds(ssh.ms)} without a prompt`, ms: ssh.ms });

  if (machine.user) {
    const sudo = await runSsh(machine.ssh, [...accountPrefix(machine), "true"], { deadline: probeDeadline() });
    let error = classifyRemote(machine, sudo);
    // `true` cannot fail by itself: a silent exit 1 is a login shell such as /bin/false refusing it.
    if (error?.reason === "analysis" && sudo.code === 1 && !sudo.stderr.trim()) error = new RemoteError("login-shell", machine);
    // An account that does not exist is a typo while adding: not saved, and the accounts with history are listed.
    if (adding && error?.reason === "no-account") { error = classifyRemote(unsaved, sudo); wantAccounts = result.refused = true; }
    const how = machine.loginShell === false ? `sudo -n -H -u ${machine.user}` : `sudo -n -iu ${machine.user}`;
    if (!add(error ? failed("sudo", error) : { check: "sudo", status: "ok", text: `${how} works without a password` })) return await finish();
  }

  const probe = await runSsh(machine.ssh, [...accountPrefix(machine), "sh", "-s"], { input: probeScript(machine.node), deadline: probeDeadline(), limit: 65_536 });
  const probeError = classifyRemote({ ...machine, runtime: "installed" }, probe);
  const [nodeVersion = "", machineLine = "", uid = "", login = ""] = probe.stdout.toString("utf8").split("\n").map((line) => line.trim());
  const [, source, machineId = ""] = /^(id|host) (.+)$/.exec(machineLine) ?? [];
  if (probeError || !source || !/^\d+$/.test(uid)) {
    add(failed("node", probeError ?? new RemoteError("invalid", machine, probe.stderr, "the machine probe")));
    return await finish();
  }
  if (accountPattern.test(login)) account ??= login;
  if (machine.runtime === "bundled") {
    const major = /^v(\d+)\.\d+\.\d+$/.exec(nodeVersion)?.[1];
    const error = !major ? new RemoteError("no-node", machine) : Number(major) < 24 ? new RemoteError("node-too-old", machine, "", nodeVersion) : null;
    if (!add(error ? failed("node", error) : { check: "node", status: "ok", text: `${nodeVersion} (needs 24 or later)` })) return await finish();
  }
  result.identity = identityOf(machineId, uid, source === "host");
  if (!add(sameMachine(machine, result.identity, others, adding))) { result.refused = true; return await finish(); }

  const runtime = await runRemote(machine, ["--version"], { deadline: Date.now() + timeoutMs, limit: 4096 });
  // Anything but a version (a login profile that prints, say) would also break every snapshot read, and is never echoed.
  const answer = runtime.stdout.toString("utf8").trim(), known = versionPattern.test(answer);
  const runtimeError = classifyRemote(machine, runtime, timeoutMs);
  if (machine.runtime === "bundled") {
    const error = runtimeError ?? (known ? null : new RemoteError("invalid", machine, "", "--version"));
    if (error) { add(failed("runtime", error, runtime.ms)); return await finish(); }
    // The read above built it, so this is the same payload.
    const payload = runtimePayload();
    add({ check: "runtime", status: "ok", text: `${answer}+${payload.digest.slice(0, 8)} ${runtime.installed ? `installed now (${Math.round(payload.bytes / 1024)} KB in ${seconds(runtime.ms)})` : "cached"}`, ms: runtime.ms });
  } else {
    const error = runtimeError ?? (answer === version ? null : known ? new RemoteError("version-skew", machine, "", answer) : new RemoteError("invalid", machine, "", "--version"));
    if (!add(error ? failed("command", error) : { check: "command", status: "ok", text: `${machine.command.join(" ")} runs ${answer}, the same as this machine` })) return await finish();
  }

  const started = performance.now();
  try {
    const snapshot = await fetchRemoteSnapshot(machine, remoteArguments({ timeZone: localTimeZone() }), { timeoutMs });
    const ms = performance.now() - started;
    result.sessions = snapshot.summary.sessions;
    if (snapshot.summary.sessions) add({ check: "history", status: "ok", text: `${snapshot.summary.sessions} sessions, ${snapshot.summary.repositories} repositories in ${seconds(ms)}`, detail: sourceHealthNotes(snapshot.mcpSourceHealth ?? []).join(" "), ms });
    else {
      // While adding, look for the account the agents run as, so the fix can name it.
      const found = (adding || findUsers) && !stopping() ? await lookup() : undefined;
      const fix = Array.isArray(found) && candidates(found).length ? `if agents run as another account there: ${hint(candidates(found))}` : noHistoryFix(machine);
      add({ check: "history", status: "warn", text: `no sessions observed for ${account ?? "this account"} (0 sessions in ${seconds(ms)})`, detail: sourceHealthNotes(snapshot.mcpSourceHealth ?? []).join(" "), ms, fix });
    }
  } catch (error) {
    add(failed("history", error instanceof RemoteError ? error : new RemoteError("analysis", machine), performance.now() - started));
  }
  return await finish();
}

/**
 * Whether the identity is this machine's or another saved machine's. Only a match by machine ID is proof: one by
 * host name alone (no machine ID there) may be a clone or a namesake, so it warns and is never refused or dropped.
 */
function sameMachine(machine: RemoteMachine, identity: string, others: SavedMachine[], adding: boolean): CheckResult {
  const twin = others.find((other) => other.name.toLowerCase() !== machine.name.toLowerCase() && other.identity === identity);
  const self = identity === localIdentity();
  if (!self && !twin) return { check: "machine", status: "ok", text: "not this machine, and not saved under another name" };
  const clone = `if ${twin ? "they are different machines" : "it is another machine"} cloned from one image, set SESSION_ANALYTICS_MACHINE_ID to a different value in each account's profile`;
  if (byHostName(identity)) {
    return {
      check: "machine", status: "warn", text: `the same host name and account as ${self ? "this machine" : twin!.name}, with no machine ID there to tell them apart`,
      fix: `if it is ${self ? "this machine" : twin!.name}, ${adding ? "it is already read" : `${command} machines remove ${machine.name}`}; otherwise set SESSION_ANALYTICS_MACHINE_ID to a unique value in that account's profile there`,
    };
  }
  if (self) return { check: "machine", status: "fail", text: "this is this machine and account, which is always read", fix: `${adding ? "nothing to add" : `${command} machines remove ${machine.name}`}; ${clone}` };
  return {
    check: "machine", status: "fail", text: `the same machine and account as ${twin!.name}; reading both would count its history twice`,
    fix: `${adding ? `it is already saved as ${twin!.name}` : `${command} machines remove ${machine.name}`}; ${clone}`,
  };
}

const marks = { ok: "✓", warn: "!", fail: "✗" } as const;

/** The heading for one machine: how it is reached and run. */
export function checkHeading(machine: RemoteMachine, enabled = true): string {
  const how = [`ssh ${machine.ssh}`, ...(machine.user ? [`as ${machine.user}${machine.loginShell === false ? " without a login shell" : ""}`] : []),
    machine.runtime === "bundled" ? "bundled runtime" : `installed: ${machine.command.join(" ")}`, ...(enabled ? [] : ["disabled"])];
  return `${machine.name}  (${how.join(", ")})\n`;
}

/** One check's line, and its fix on the next line. */
export function checkLine(item: CheckResult): string {
  return `  ${marks[item.status]} ${item.check.padEnd(9)} ${item.text}${item.detail ? `. ${item.detail}` : ""}\n${item.fix ? `    Fix: ${item.fix}\n` : ""}`;
}
