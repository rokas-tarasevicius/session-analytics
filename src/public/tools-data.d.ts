import type { SessionAnalytics } from "../types.ts";
import type { MetricCoverage } from "./providers.js";

export type ToolChange = number | null | "new";
export function callCount(value: number): number;
export interface ToolOriginRow {
  name: string; calls: number; callShare: number | null;
  sessions: number; sessionShare: number | null; repositories: number; repositoryShare: number | null;
}
export interface ToolOrigins {
  coverage: MetricCoverage; eligibleRepositories: number; groups: ToolOriginRow[]; servers: ToolOriginRow[];
}
export function buildToolOrigins(sessions: SessionAnalytics[]): ToolOrigins;
export interface ToolRow {
  name: string; calls: number; share: number; sessions: number; repositories: number;
  providers: Array<{ provider: string; label: string; calls: number }>;
  previousCalls: number | null; change: ToolChange; smallBaseline: boolean;
}
export interface ToolsView {
  coverage: MetricCoverage; totalCalls: number | null; eligibleSessions: number; distinctTools: number | null;
  callsPerSession: number | null; previousCoverage: MetricCoverage | null; previousCalls: number | null;
  change: ToolChange; smallBaseline: boolean; tools: ToolRow[];
}
export interface ToolProfile {
  name: string; coverage: MetricCoverage; calls: number | null; share: number | null; sessions: number | null;
  repositories: number | null; callsPerSession: number | null; undatedCalls: number; outsideDaysCalls: number;
  byDay: Array<{ day: string; calls: number; coverage: MetricCoverage }>;
  byProvider: Array<{ provider: string; label: string; calls: number; share: number }>;
  byRepository: Array<{ id: string; name: string; calls: number; share: number }>;
}
export function toolsDays(sessions: SessionAnalytics[], timeZone?: string): string[];
export function buildToolsView(sessions: SessionAnalytics[], options?: { previousSessions?: SessionAnalytics[] | null }): ToolsView;
export function toolProfile(sessions: SessionAnalytics[], name: string, options?: { timeZone?: string; days?: string[]; repositoryNames?: Map<string, string> }): ToolProfile;
