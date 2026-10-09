import type { SessionAnalytics } from "../types.ts";
export type Metric = "value" | "input" | "uncached" | "cacheRead" | "cacheWrite" | "output" | "reasoning" | "calls" | "tools" | "sessions";
export interface VelocityOptions { start: string; end: string; group?: string; metric?: Metric; granularity?: string; mode?: string; limit?: number }
export interface Evidence { known: number; eligible: number; unsupported: number; complete: boolean }
/** `sums` is the group's in-window total of all 14 ledger counters; `sessions` counts the sessions contributing a cell. */
export interface Series { id: string; label: string; total: number; values: number[]; calls: number; evidence: Evidence; sums: number[]; sessions: number }
export interface VelocityData {
  start: string; end: string; group: string; metric: Metric; granularity: string; mode: string;
  keys: string[]; series: Series[]; allSeries: Series[];
  /** `gaps`: eligible tokens without metric evidence by model id on that day (null when complete). */
  daily: Array<{ day: string; values: number[]; total: number; evidence: Evidence; gaps: Map<string, number> | null }>;
  /** 7-day average of the plotted total; `rollingPartial` marks points whose window has incomplete metric evidence. */
  rolling: Array<number | null>; rollingPartial: boolean[]; totals: number[]; undated: number[];
  /** In-window totals of session-dated cells (already included in `totals`), and the sessions session-dating some of the selected metric. */
  sessionDated: number[]; sessionDatedSessions: number;
  coverage: { priceTokens: number; cacheReadInput: number; cacheWriteInput: number; reasoningOutput: number };
  evidence: Evidence;
  earliest: string | null; missingSessions: number; unledgered: { sessions: number; value: number }; contributingSessions: number;
}
export interface Period { start: string; end: string; days: number; coveredDays: number; covered: boolean; value: number; calls: number; evidence: Evidence; gaps?: Map<string, number> | null }
export type ComparisonStatus = "change" | "new" | "idle" | "unavailable";
/** `partial`: observed values with incomplete metric evidence (above the floor); `cause` names the models missing it. */
export interface Comparison { current: Period; previous: Period; delta: number | null; status: ComparisonStatus; reason: string | null; partial: boolean; cause: string | null }
export interface PeriodComparison extends Comparison { rolledBack: boolean }
export const metricDefinitions: Record<Metric, { index: number; label: string; unit: string; minimum: number }>;
export const agentLabels: Record<string, string>;
export const agentSeriesLimit: number;
export function evidenceCause(gaps: Map<string, number> | null | undefined, metric: string): string | null;
export function moverBaseline(metric: Metric): number;
export function localDay(timestamp: unknown, timeZone?: string): string | null;
export function sessionStartWindow(sessions: SessionAnalytics[], options: { start: string; end: string; timeZone: string }): { sessions: SessionAnalytics[]; undatedStarts: number };
export function shiftDay(day: string, amount: number): string;
export function calendarDays(start: string, end: string): string[];
export function periodKey(day: string, granularity: string): string;
export function buildVelocity(sessions: SessionAnalytics[], options: VelocityOptions): VelocityData;
export function averagePrice(data: VelocityData): { total: number; days: number; activeDays: number; perActiveDay: number | null; perCalendarDay: number | null };
export function guardedDelta(current: number, previous: number, metric: Metric, previousCalls?: number): number | null;
export const comparisonEvidenceFloor: number;
export const ledgerlessSources: Set<string>;
export function ledgerCells(velocity: SessionAnalytics["velocity"]): Array<[day: string, hour: number, dimension: number, values: number[], sessionDated: boolean]>;
export function periodFromVelocity(data: VelocityData): Period;
export function comparisonSpan(end: string, today: string | null): { start: string; end: string };
export function comparePeriods(current: Period, previous: Period, metric: Metric, options?: { missingSessions?: number }): Comparison;
export function quantile(values: number[], fraction: number): number | null;
export function velocityIndicators(data: VelocityData, today: string): {
  week: PeriodComparison; month: PeriodComparison;
  burn: { today: number | null; median: number | null; days: number; activeDays: number; ratio: number | null; partial: boolean; cause: string | null; reason: string | null; todayEvidence: Evidence; baselineEvidence: Evidence };
  projection: { value: number; low: number; high: number; observed: number; sampleDays: number; activeDays: number; remainingDays: number; monthEnd: string; partial: boolean; cause: string | null } | null;
  /** Why there is no projection (null when there is one). */
  projectionReason: string | null;
  projectionEvidence: { sample: Evidence; observed: Evidence };
  completeThrough: string; end: string; trailing: Period;
};
export function topMovers(sessions: SessionAnalytics[], options: VelocityOptions, today: string): {
  start: string; end: string; previousStart: string; previousEnd: string; available: boolean; excludedGroups: number;
  /** `change` is signed; `base` is "new" (no prior value) or "small" (prior below `moverBaseline`) when `delta` is null. */
  rows: Array<{ group: string; label: string; current: number; previous: number; change: number; delta: number | null; base: "new" | "small" | null; partial: boolean; currentEvidence: Evidence; previousEvidence: Evidence }>;
};
