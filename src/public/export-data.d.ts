import type { MachineAnalytics } from "../types.ts";
export function csv(rows: Array<Record<string, unknown>>, columns: string[]): string;
export function csvTables(snapshot: MachineAnalytics): Record<string, string>;
export function filterSnapshot(snapshot: MachineAnalytics, filters?: { repositoryId?: string | null; start?: string | null; end?: string | null; providers?: string[] | null; repositoryIds?: string[] | null }): MachineAnalytics;
