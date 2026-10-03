import type { SessionAnalytics } from "../types.ts";
export type Metric = "tokens" | "tools" | "turns" | "calls" | "compactions" | "duration" | "cost" | "apiCost" | "reportedCost" | "skills";
export interface MetricCoverage { eligible: number; selected: number }
export function metricEligible(session: SessionAnalytics, metric: Metric): boolean;
export function metricCoverage(sessions: SessionAnalytics[], metric: Metric): MetricCoverage;
export function coveredValue(value: number, coverage: MetricCoverage, format?: (value: number) => string): string;
