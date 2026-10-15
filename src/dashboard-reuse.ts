import { brand, serviceId } from "./brand.ts";
import type { DashboardHealth } from "./types.ts";

const printableVersion = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/;

/** Older or newer by release number; dashboards before 0.10 report no version, and a prerelease of the same release is neither. */
function relation(running: unknown, expected: string): "An older" | "A newer" | "Another" {
  if (running === undefined) return "An older";
  if (typeof running !== "string" || !printableVersion.test(running)) return "Another";
  const release = (value: string): number[] => value.split("-")[0]!.split(".").map(Number);
  const [left, right] = [release(running), release(expected)];
  const index = left.findIndex((part, position) => part !== right[position]);
  return index < 0 ? "Another" : left[index]! > right[index]! ? "A newer" : "An older";
}

/**
 * Why a launch may not reuse the dashboard already on its port, or null to reuse it. Reuse needs the same version as
 * well as the same options and this data directory's token: after an upgrade the old process would keep serving old code.
 */
export function reuseRefusal(health: Partial<DashboardHealth> | null, expected: { version: string; optionsHash: string; scanHash: string; instanceToken: string | null }): string | null {
  if (health?.service === serviceId && health.status === "ok" && health.version !== expected.version) {
    // Only a version matching the release grammar is ever printed from the port.
    const shown = typeof health.version === "string" && printableVersion.test(health.version) ? ` (${health.version})` : "";
    return `${relation(health.version, expected.version)} ${brand.name}${shown} is running on this port; this is ${expected.version}. Stop it (Ctrl+C where it runs) or choose --port.`;
  }
  if (health?.service === serviceId && health.status === "ok" && health.dataSource === "live" && expected.instanceToken !== null &&
      health.instanceToken === expected.instanceToken) {
    if (health.optionsHash === expected.optionsHash) return null;
    if (health.scanHash === expected.scanHash) return `${brand.name} is already running on this port with other machines (--remote, --machines or --no-remote differ); stop it or choose --port.`;
  }
  return `${brand.name} is already running on this port with different options; stop it or choose --port.`;
}
