import type { MachineAnalytics, SessionAnalytics, SharedSnapshot } from "../types.ts";
/** A full snapshot with the activity-ledger window behind daily.csv and a sentence stating each file's value basis. */
export interface ExportSelection {
  snapshot: MachineAnalytics;
  ledger: { sessions: SessionAnalytics[]; start: string; end: string } | null;
  basis: string | null;
}
export function downloadFile(filename: string, text: string, type: string): void;
export function openExportMenu(): void;
export function installExportMenu(
  getSelection: () => MachineAnalytics | SharedSnapshot | ExportSelection | null,
  options?: { unavailableMessage?: () => string },
): () => void;
