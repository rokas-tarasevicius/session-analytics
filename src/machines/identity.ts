import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

/** A machine and account as a 16-digit hash: the raw machine ID never leaves this function. */
export function identityOf(machineId: string, uid: string): string {
  return createHash("sha256").update(`session-analytics machine v1\0${machineId.trim()}\0${uid.trim()}`).digest("hex").slice(0, 16);
}

/**
 * This machine and account, as `machines check` and every remote read compute it. SESSION_ANALYTICS_MACHINE_ID
 * stands in for /etc/machine-id where one image's ID is shared by several machines, such as cloned containers.
 */
export function localIdentity(environment: NodeJS.ProcessEnv = process.env): string {
  let id = environment["SESSION_ANALYTICS_MACHINE_ID"]?.trim() ?? "";
  if (!id) { try { id = readFileSync("/etc/machine-id", "utf8").trim(); } catch { /* macOS and others have none. */ } }
  return identityOf(id || hostname(), String(process.getuid?.() ?? ""));
}
