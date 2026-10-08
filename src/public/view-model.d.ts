// Type surface of view-model.js for the node:test helpers test (tsc runs strict on test/).
export type SessionLike = Record<string, any>;
export interface Summary {
  analyzedSessions: number;
  apiEquivalentSpendUsd: number;
  cacheReadRatio: number | null;
  compactions: number;
  estimatedSpendUsd: number;
  estimatedUpperSpendUsd: number;
  missingTranscripts: number;
  outputTokens: number;
  pricedTokenCoverage: number | null;
  providerReportedSpendUsd: number;
  sessions: number;
  subagentSessions: number;
  subagentSpendUsd: number;
  toolCalls: number;
  topLevelSessions: number;
  topLevelSpendUsd: number;
  totalInputTokens: number;
  unpricedSessions: number;
}
export interface NamedMetric { name: string; value: number }
export interface Delta { direction: "up" | "down" | "flat"; label: string; text: string }
export interface Period { endDay: string; length: number; startDay: string }
export interface PaletteItem { group: string; keywords?: string; label: string }
export interface RepositoryRow { repository: { id: string; name: string }; summary: Summary }

export const providerOrder: readonly string[];
export const providerLabels: Record<string, string>;
export function shortMoney(value: number): string;
export function percent(value: number | null | undefined): string;
export function summarize(sessions: SessionLike[]): Summary;
export function mergeModels(sessions: SessionLike[]): Array<Record<string, any>>;
export function namedTotals(sessions: SessionLike[], field: string): NamedMetric[];
export function spendDays(sessions: SessionLike[]): NamedMetric[];
export function coverageWarnings(sessions: SessionLike[]): string[];
export function costTotals(sessions: SessionLike[]): { cached: number; input: number; output: number; reported: number; total: number; upper: number; write: number };
export function groupByRepository(sessions: SessionLike[]): Map<string, SessionLike[]>;
export function sessionsInRange(sessions: SessionLike[], startDay: string | null, endDay: string | null): SessionLike[];
export function daysBetween(startDay: string, endDay: string, cap?: number): string[];
export function dailySpendSeries(sessions: SessionLike[], days: string[]): number[];
export function dailyCountSeries(sessions: SessionLike[], days: string[], accessor: (session: SessionLike) => number): number[];
export function windowStartFor(preset: string, minDay: string, maxDay: string): string;
export function clampWindow(range: { start: string; end: string; min: string; max: string }): { start: string; end: string };
export function previousPeriod(range: { start: string; end: string; min: string }): Period | null;
export function deltaDescription(current: number, previous: number | null | undefined, length: number): Delta | null;
export function downsample(values: number[], maxPoints: number): { indexFor: (index: number) => number; values: number[] };
export function sparklineSummary(label: string, values: number[], days: string[], format: (value: number) => string): string;
export function heatLevel(value: number, maximum: number): number;
export function tickScale(maximum: number): { axisMaximum: number; tick: number };
export function matchesQuery(item: PaletteItem, query: string): boolean;
export const tableAccessors: Record<string, (item: RepositoryRow) => number | string>;
export function sortRepositories(repositories: RepositoryRow[], key: string, direction: "ascending" | "descending"): RepositoryRow[];
export function repositoryKey(id: string): string;
