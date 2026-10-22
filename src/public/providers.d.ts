import type { SessionAnalytics, SessionProvider } from "../types.ts";
import type { McpSourceHealth } from "../mcp/types.ts";
export function sourceCheckNotes(health?: McpSourceHealth[]): string[];
export const providerLabels: Record<SessionProvider, string>;
export const providerIds: SessionProvider[];
export const providerColors: Record<SessionProvider, string>;
export function providerEvidenceRows(sessions: SessionAnalytics[]): Array<{ source: string; provider: SessionProvider; sessions: number; tokenSessions: number; toolSessions: number; fileTimes: number; partial: number; fidelity: string }>;
export type Metric = "tokens" | "tools" | "turns" | "calls" | "compactions" | "duration" | "cost" | "apiCost" | "reportedCost";
export interface MetricCoverage { eligible: number; selected: number }
export function metricEligible(session: SessionAnalytics, metric: Metric): boolean;
export function metricCoverage(sessions: SessionAnalytics[], metric: Metric): MetricCoverage;
export function coveredValue(value: number, coverage: MetricCoverage, format?: (value: number) => string): string;
