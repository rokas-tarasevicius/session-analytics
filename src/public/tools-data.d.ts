import type { SessionAnalytics } from "../types.ts";
import type { MetricCoverage } from "./providers.js";

export type ToolChange = number | null | "new";
export interface ToolRow {
  name: string; calls: number; share: number; sessions: number; repositories: number;
  previousCalls: number | null; change: ToolChange;
}
export interface ToolsView {
  coverage: MetricCoverage; totalCalls: number | null; eligibleSessions: number; distinctTools: number | null;
  callsPerSession: number | null; previousCoverage: MetricCoverage | null; previousCalls: number | null;
  change: ToolChange; tools: ToolRow[];
}
export interface ToolProfile {
  name: string; coverage: MetricCoverage; calls: number | null; share: number | null; sessions: number | null;
  repositories: number | null; callsPerSession: number | null; undatedCalls: number; outsideDaysCalls: number;
  byDay: Array<{ day: string; calls: number; coverage: MetricCoverage }>;
  byProvider: Array<{ provider: string; label: string; calls: number; share: number }>;
  byRepository: Array<{ id: string; name: string; calls: number; share: number }>;
}
export function toolsDays(sessions: SessionAnalytics[]): string[];
export function buildToolsView(sessions: SessionAnalytics[], options?: { previousSessions?: SessionAnalytics[] | null }): ToolsView;
export function toolProfile(sessions: SessionAnalytics[], name: string, options?: { days?: string[]; repositoryNames?: Map<string, string> }): ToolProfile;
