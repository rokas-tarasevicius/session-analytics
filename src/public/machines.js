// Machines behind a combined snapshot, shared by the dashboard and the report: short reasons, ages,
// coverage notes that name the machine, and the machine filter. Content-free: labels, counts and times.
import { discoveryWarnings, remoteUnavailableWarning, staleMachineWarning } from "./evidence.js";

/** This machine's key in a snapshot that combines machines: the machine that read the others, and the only one whose limits are read. */
export const localMachine = "local";

/** A few words for each reason; the terminal that read the machine printed the full sentence and its detail. */
export const machineReasons = {
  "no-ssh": "ssh is missing here", "unknown-host": "host name not found", connection: "unreachable", "login-refused": "SSH login refused",
  dropped: "connection dropped", sudo: "sudo needs a password", "no-account": "no such account", "login-shell": "account has no login shell",
  permission: "command not executable", "missing-command": "session-analytics not found", "no-node": "Node.js not found", "node-too-old": "Node.js too old",
  "local-runtime": "runtime incomplete here", runtime: "runtime did not start", "cache-unwritable": "cache not writable or not private",
  corrupted: "runtime damaged in transit", "version-skew": "another version", rejected: "request rejected", busy: "index busy",
  "index-newer": "index from a newer version", analysis: "analysis failed", invalid: "invalid output", "time-zone": "another time zone",
  timeout: "timed out", "too-large": "snapshot too large", cancelled: "read stopped", "no-history": "no history for this account",
  "same-machine": "same machine as another",
};

/** "just now", "12 min ago", "3 h ago", "2 days ago"; null when the time is unknown. */
export function machineAge(readAt, now = Date.now()) {
  const time = Date.parse(readAt ?? "");
  if (!Number.isFinite(time)) return null;
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 2880 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
}

/** How many machines are in each state. */
export function machineTally(machines) {
  const count = (state) => machines.filter((machine) => machine.state === state).length;
  return { total: machines.length, ok: count("ok"), stale: count("stale"), failed: count("failed"), reading: count("reading") };
}

/** One machine's state in a few words: empty when it was read with history. */
export function machineNote(machine, now = Date.now()) {
  const reason = machine.reason ? machineReasons[machine.reason] ?? machine.reason : null, age = machineAge(machine.readAt, now);
  if (machine.state === "reading") return age ? `reading · showing ${age}` : "reading";
  if (machine.state === "failed") return reason ? `not read: ${reason}` : "not read";
  if (machine.state === "stale") return `${reason ?? "not read"} · showing ${age ?? "an older read"}`;
  return reason ?? "";
}

/** Each discovery warning prefixed with the machines that raised it, when the snapshot combines machines. */
export function machineWarningSources(machines, warnings) {
  if (!machines || machines.length < 2) return warnings;
  return warnings.map((warning) => {
    const from = discoveryWarnings.includes(warning) ? machines.filter((machine) => machine.warnings?.includes(warning)).map(({ label }) => label) : [];
    return from.length ? `${from.join(", ")}: ${warning}` : warning;
  });
}

/**
 * Coverage notes that name machines: a discovery warning says which machines raised it, and each
 * machine that is missing, stale, still reading or empty says so. One machine's snapshot is unchanged.
 */
export function machineWarnings(machines, warnings, now = Date.now()) {
  if (!machines || machines.length < 2) return warnings;
  const notes = machineWarningSources(machines, warnings.filter((warning) => warning !== remoteUnavailableWarning && warning !== staleMachineWarning));
  for (const machine of machines) {
    const reason = machine.reason ? machineReasons[machine.reason] ?? machine.reason : "not read", age = machineAge(machine.readAt, now);
    if (machine.reason === "same-machine") notes.push(`${machine.label} is the same machine and account as another one; its sessions are counted once.`);
    else if (machine.state === "failed") notes.push(`${machine.label} could not be read (${reason}); its sessions are missing.`);
    else if (machine.state === "stale") notes.push(`${machine.label} could not be read (${reason}); its last good snapshot from ${age} is used instead.`);
    else if (machine.state === "reading") notes.push(age ? `${machine.label} is still being read; its snapshot from ${age} is shown until it answers.` : `${machine.label} is still being read; its sessions are not included yet.`);
    else if (machine.reason === "no-history") notes.push(`${machine.label} has no agent history for the account it was read as.`);
  }
  return [...new Set(notes)];
}

/** The machine a session came from; a session without a key belongs to the first machine. */
export function sessionMachine(session, machines) {
  return session.machine ?? machines?.[0]?.key ?? null;
}

/**
 * The snapshot narrowed to some machines, for the dashboard filter: their sessions and the repositories
 * those touch. History coverage spans every machine, so a narrowed snapshot leaves it out.
 */
export function machineView(snapshot, keys) {
  const machines = snapshot.machines ?? [];
  const sessions = snapshot.sessions.filter((session) => keys.has(sessionMachine(session, machines)));
  if (!machines.length || sessions.length === snapshot.sessions.length) return snapshot;
  const touched = new Set(sessions.map(({ repositoryId }) => repositoryId));
  const { historyCoverage: _, ...rest } = snapshot;
  return { ...rest, sessions, repositories: snapshot.repositories.filter(({ repository }) => touched.has(repository.id)) };
}
