import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

/**
 * A machine and account as a 16-digit hash: the raw machine ID never leaves this function. `host-` marks one
 * told apart only by its host name, which other machines (a clone, a second default-named Mac) can share.
 */
export function identityOf(machineId: string, uid: string, byHostName = false): string {
  const hash = createHash("sha256").update(`session-analytics machine v1\0${machineId.trim()}\0${uid.trim()}`).digest("hex").slice(0, 16);
  return byHostName ? `host-${hash}` : hash;
}

/** A match of such identities only suggests the same machine; it is never proof enough to drop one. */
export const byHostName = (identity: string): boolean => identity.startsWith("host-");

/** The ID the probe in `machines check` reads the same way: the override, machine-id files, then the Mac's platform UUID. */
function machineId(environment: NodeJS.ProcessEnv): string {
  const set = environment["SESSION_ANALYTICS_MACHINE_ID"]?.trim();
  if (set) return set;
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try { const id = readFileSync(path, "utf8").trim(); if (id) return id; } catch { /* Not on this system. */ }
  }
  if (process.platform !== "darwin") return "";
  try {
    const output = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    return /"IOPlatformUUID" = "([^"]+)"/.exec(output)?.[1]?.trim() ?? "";
  } catch { return ""; }
}

let own: string | undefined;
/**
 * This machine and account, as `machines check` and every remote read compute it. SESSION_ANALYTICS_MACHINE_ID
 * stands in for the machine ID where one image's ID is shared by several machines, such as cloned containers or VMs.
 */
export function localIdentity(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment === process.env && own) return own;
  const id = machineId(environment), uid = String(process.getuid?.() ?? "");
  const identity = id ? identityOf(id, uid) : identityOf(hostname(), uid, true);
  if (environment === process.env) own = identity;
  return identity;
}
