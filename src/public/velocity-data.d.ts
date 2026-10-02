import type { SessionAnalytics } from "../types.ts";
export type Metric = "value" | "input" | "uncached" | "cacheRead" | "cacheWrite" | "output" | "reasoning" | "calls" | "tools" | "sessions";
export interface VelocityOptions { start: string; end: string; group?: string; metric?: Metric; granularity?: string; mode?: string; limit?: number }
export interface Series { id: string; label: string; total: number; values: number[] }
export interface VelocityData {
  start: string; end: string; metric: Metric; granularity: string; mode: string;
  keys: string[]; series: Series[]; allSeries: Series[];
  daily: Array<{ day: string; values: number[]; total: number }>;
  rolling: Array<number | null>; totals: number[]; undated: number[];
  coverage: { priceTokens: number; cacheReadInput: number; cacheWriteInput: number; reasoningOutput: number };
  earliest: string | null; missingSessions: number; contributingSessions: number;
}
export interface Period { start: string; end: string; days: number; coveredDays: number; covered: boolean; value: number; calls: number }
export interface Comparison { current: Period; previous: Period; delta: number | null }
export const metricDefinitions: Record<Metric, { index: number; label: string; unit: string; minimum: number }>;
export const agentLabels: Record<string, string>;
export function localDay(timestamp: string, timeZone?: string): string | null;
export function shiftDay(day: string, amount: number): string;
export function calendarDays(start: string, end: string): string[];
export function periodKey(day: string, granularity: string): string;
export function buildVelocity(sessions: SessionAnalytics[], options: VelocityOptions): VelocityData;
export function guardedDelta(current: number, previous: number, metric: Metric, previousCalls?: number): number | null;
export function quantile(values: number[], fraction: number): number | null;
export function velocityIndicators(data: VelocityData, today: string): {
  week: Comparison; month: Comparison;
  burn: { today: number | null; median: number | null; days: number; activeDays: number; ratio: number | null };
  projection: { value: number; low: number; high: number; observed: number; sampleDays: number; activeDays: number; remainingDays: number; monthEnd: string } | null;
  completeThrough: string; end: string; trailing: Period;
};
export function topMovers(sessions: SessionAnalytics[], options: VelocityOptions, today: string): {
  start: string; end: string; previousStart: string; previousEnd: string; available: boolean;
  rows: Array<{ group: string; label: string; current: number; previous: number; increase: number; delta: number | null }>;
};
