import { brand, serviceId } from "./brand.ts";
import type { DashboardHealth } from "./types.ts";

/**
 * Why a launch may not reuse the dashboard already on its port, or null to reuse it. Reuse needs the same version as
 * well as the same options and this data directory's token: after an upgrade the old process would keep serving old code.
 */
export function reuseRefusal(health: Partial<DashboardHealth> | null, expected: { version: string; optionsHash: string; instanceToken: string | null }): string | null {
  if (health?.service === serviceId && health.status === "ok" && health.version !== expected.version) {
    // Older dashboards report no version. Only a plain X.Y.Z from the port is ever printed.
    const running = typeof health.version === "string" && /^\d+\.\d+\.\d+$/.test(health.version) ? health.version : null;
    return `${running && running.localeCompare(expected.version, "en", { numeric: true }) > 0 ? "A newer" : "An older"} ${brand.name}${running ? ` (${running})` : ""} is running on this port; this is ${expected.version}. Stop it (Ctrl+C where it runs) or choose --port.`;
  }
  if (health?.service === serviceId && health.status === "ok" && health.dataSource === "live" && expected.instanceToken !== null &&
      health.optionsHash === expected.optionsHash && health.instanceToken === expected.instanceToken) return null;
  return `${brand.name} is already running on this port with different options; stop it or choose --port.`;
}
