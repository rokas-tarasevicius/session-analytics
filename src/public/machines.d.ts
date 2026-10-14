import type { MachineAnalytics, MachineReason, MachineStatus, SessionAnalytics } from "../types.ts";
export const machineReasons: Record<MachineReason, string>;
export function machineAge(readAt: string | null | undefined, now?: number): string | null;
export function machineTally(machines: MachineStatus[]): { total: number; ok: number; stale: number; failed: number; reading: number };
export function machineNote(machine: MachineStatus, now?: number): string;
export function machineWarnings(machines: MachineStatus[] | undefined, warnings: string[], now?: number): string[];
export function sessionMachine(session: SessionAnalytics, machines: MachineStatus[] | undefined): string | null;
export function machineView(snapshot: MachineAnalytics, keys: Set<string>): MachineAnalytics;
