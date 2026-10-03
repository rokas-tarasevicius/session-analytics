import type { LatencyDistribution, ReliabilityStats, ReliabilitySummary, SessionReliability, BehaviorFlag } from "../metrics/reliability-types.ts";
export function emptyLatency(): LatencyDistribution;
export function latencyFrom(values: number[]): LatencyDistribution;
export function mergeLatency(values: LatencyDistribution[]): LatencyDistribution;
export function emptyStats(): ReliabilityStats;
export function mergeStats(values: ReliabilityStats[]): ReliabilityStats;
export function emptyFlags(): Record<BehaviorFlag, number>;
export function errorDenominator(stats: ReliabilityStats): number;
export function errorRate(stats: ReliabilityStats): number | null;
export function guardedShare(numerator: number, denominator: number): number | null;
export function summarizeReliability(sessions: Array<{ reliability?: SessionReliability }>): ReliabilitySummary;
export interface ReliabilityComparison {
  name: string;
  sessions: number;
  coveredSessions: number;
  totals: ReliabilityStats;
  verification: { eligibleSessions: number; skippedSessions: number };
}
export function summarizeReliabilityComparisons(sessions: Array<{ provider: string; repositoryId: string; repositoryName: string; reliability?: SessionReliability }>): { providers: ReliabilityComparison[]; repositories: ReliabilityComparison[] };
