import { spawn } from "node:child_process";
import { analyzeMachineSessionsIsolated } from "./analysis-process.ts";
import { combineSnapshots } from "./interop/combine.ts";
import { maximumSnapshotBytes } from "./interop/files.ts";
import { validateSnapshot } from "./interop/snapshot.ts";
import { canonicalTimeZone, type RemoteOptions } from "./options.ts";
import { remoteUnavailableWarning } from "./public/evidence.js";
import type { AnalyzeOptions, MachineAnalytics } from "./types.ts";

/** A remote machine that has not answered by then is stopped and reported as unavailable. */
export const REMOTE_DEADLINE_MS = 300_000;
const STDERR_TAIL_BYTES = 4096;

/** The request every remote machine runs: a full snapshot in this machine's zone, with portable repository IDs. */
export function remoteArguments(options: AnalyzeOptions & { timeZone: string }): string[] {
  return [
    "report", "--json", "--portable-ids", "--time-zone", options.timeZone,
    ...(options.offline ? ["--offline"] : []),
    ...(options.noIndex ? ["--no-index"] : []),
    ...(options.includeHidden === false ? ["--exclude-hidden"] : []),
    ...(options.additionalProviders === false ? ["--no-additional-providers"] : []),
    ...(options.pricingPolicy ? ["--pricing-policy", options.pricingPolicy] : []),
    ...(options.pricingSources ? ["--pricing-sources", options.pricingSources.join(",")] : []),
    ...(options.pricingMaxAgeDays !== undefined ? ["--pricing-max-age-days", String(options.pricingMaxAgeDays)] : []),
  ];
}

type RemoteFailure = "no-ssh" | "connection" | "missing-command" | "rejected" | "analysis" | "invalid" | "time-zone" | "timeout" | "too-large";
const failureText: Record<RemoteFailure, string> = {
  "no-ssh": "ssh is not available on this machine",
  connection: "SSH could not connect or log in without a prompt (use keys or an agent)",
  "missing-command": "the remote command was not found; set --remote-command",
  rejected: "the remote session-analytics rejected the request; install the same version there",
  analysis: "the remote analysis failed",
  invalid: "the remote output was not a valid full snapshot; check that nothing else prints to stdout and that both machines run the same version",
  "time-zone": "the remote snapshot used another time zone",
  timeout: `no snapshot within ${REMOTE_DEADLINE_MS / 1000} seconds`,
  "too-large": "the remote snapshot exceeded the snapshot size limit",
};

/** A fixed reason, plus the last line ssh or the remote command printed on stderr, for this terminal only. */
export class RemoteError extends Error {
  readonly detail: string;
  constructor(reason: RemoteFailure, stderr = "") {
    super(failureText[reason]);
    this.detail = stderr.split(/\r?\n/).map((line) => line.replace(/[\u0000-\u001f\u007f]/g, "").trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? "";
  }
}

/** Run the remote report through the user's own ssh, without a terminal or local input. */
export async function fetchRemoteSnapshot(destination: string, command: string[], args: string[]): Promise<MachineAnalytics> {
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh", [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-T",
      "--", destination, ...command, ...args,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0, stderrTail = "";
    let failure: RemoteFailure | null = null;
    const stop = (reason: RemoteFailure): void => {
      failure ??= reason;
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => stop("timeout"), REMOTE_DEADLINE_MS);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumSnapshotBytes) stop("too-large");
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES); });
    child.once("error", (error: NodeJS.ErrnoException) => { failure ??= error.code === "ENOENT" ? "no-ssh" : "connection"; });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (failure) { reject(new RemoteError(failure, failure === "no-ssh" ? "" : stderrTail)); return; }
      if (code !== 0) {
        reject(new RemoteError(code === 255 ? "connection" : code === 127 ? "missing-command" : code === 2 ? "rejected" : "analysis", stderrTail));
        return;
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(new RemoteError("invalid")); return; }
      if (!value || typeof value !== "object" || "kind" in value) { reject(new RemoteError("invalid")); return; }
      try { resolve(validateSnapshot(value)); } catch { reject(new RemoteError("invalid")); }
    });
  });
}

/** This machine's zone as an IANA name, so every machine buckets activity in the same calendar. */
export function localTimeZone(): string {
  return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
}

/**
 * This machine and every remote one, combined into one validated snapshot. The local scan and the
 * remote reads run at the same time. A machine that cannot be read is named in `report` and leaves a
 * fixed warning in the snapshot; only a failed local scan fails the whole result.
 */
export async function analyzeMachines(
  options: AnalyzeOptions,
  remote: RemoteOptions,
  report: (line: string, failed: boolean) => void = () => {},
): Promise<MachineAnalytics> {
  if (!remote.remotes.length) return await analyzeMachineSessionsIsolated(options);
  const local = { ...options, portableIds: true, timeZone: options.timeZone ?? localTimeZone() };
  const args = remoteArguments(local);
  const [own, ...others] = await Promise.allSettled([
    analyzeMachineSessionsIsolated(local),
    ...remote.remotes.map((destination) => fetchRemoteSnapshot(destination, remote.command, args)),
  ]);
  if (own.status === "rejected") throw own.reason;
  const snapshots = [own.value];
  let unavailable = false;
  others.forEach((result, index) => {
    const destination = remote.remotes[index]!;
    const error = result.status === "rejected"
      ? result.reason instanceof RemoteError ? result.reason : new RemoteError("analysis")
      : result.value.velocity?.timeZone === own.value.velocity?.timeZone ? null : new RemoteError("time-zone");
    if (error) {
      unavailable = true;
      report(`Could not read ${destination}: ${error.message}.${error.detail ? ` ${error.detail}` : ""}`, true);
    } else if (result.status === "fulfilled") {
      snapshots.push(result.value);
      report(`Read ${result.value.summary.sessions} sessions across ${result.value.summary.repositories} repositories from ${destination}.`, false);
    }
  });
  return combineSnapshots(snapshots, unavailable ? [remoteUnavailableWarning] : []);
}
