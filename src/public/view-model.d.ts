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
  /** Mixed sessions also count in topLevelSessions and subagentSessions. */
  mixedSessions: number;
  unknownExecutionSessions: number;
}
export interface NamedMetric { name: string; value: number }
export interface Delta { direction: "up" | "down" | "flat"; label: string; text: string }
export interface Period { endDay: string; length: number; startDay: string }
export interface PaletteItem { group: string; keywords?: string; label: string }
export interface RepositoryRow { repository: { id: string; name: string }; summary: Summary; usage?: { value: number; evidence: LedgerEvidence; available?: boolean } }

export const providerOrder: readonly string[];
export const providerLabels: Record<string, string>;
export function shortMoney(value: number): string;
export function percent(value: number | null | undefined): string;
export function summarize(sessions: SessionLike[]): Summary;
export function namedTotals(sessions: SessionLike[], field: string): NamedMetric[];
export function coverageWarnings(sessions: SessionLike[]): string[];
export interface LedgerEvidence { known: number; eligible: number; unsupported: number; complete: boolean }
/** One (provider, model) of the window's activity ledger; `sums` holds the 14 ledger counters. */
export interface LedgerModel {
  id: string; provider: string; model: string; label: string; value: number; api: number; reported: number; upper: number;
  share: number; sessions: number; calls: number; sums: number[]; evidence: LedgerEvidence;
}
export interface LedgerProvider {
  provider: string; total: number; api: number; reported: number; upper: number; unattributed: number; evidence: LedgerEvidence; models: LedgerModel[];
}
export interface LedgerMoney {
  start: string; end: string; total: number; api: number; reported: number; upper: number; evidence: LedgerEvidence;
  providers: LedgerProvider[]; models: LedgerModel[]; undated: number; unledgered: { sessions: number; value: number };
  missingSessions: number; sessionDated: number; sessionDatedSessions: number; contributingSessions: number;
}
export function mergeEvidence(target: LedgerEvidence, source: LedgerEvidence): LedgerEvidence;
export function pricedShare(evidence: LedgerEvidence | null | undefined): number | null;
export function pricedPercent(evidence: LedgerEvidence | null | undefined): string;
export function ledgerMoney(sessions: SessionLike[], window: { start: string; end: string }): LedgerMoney;
export function groupByRepository(sessions: SessionLike[]): Map<string, SessionLike[]>;
export function sessionStartDay(session: SessionLike, timeZone?: string): string | null;
export function sessionsInRange(sessions: SessionLike[], startDay: string | null, endDay: string | null, timeZone?: string): SessionLike[];
export function daysBetween(startDay: string, endDay: string, cap?: number): string[];
export function dailySpendSeries(sessions: SessionLike[], days: string[]): number[];
export function dailyCountSeries(sessions: SessionLike[], days: string[], accessor: (session: SessionLike) => number, timeZone?: string): number[];
export function windowStartFor(preset: string, minDay: string, maxDay: string): string;
export function clampWindow(range: { start: string; end: string; min: string; max: string }): { start: string; end: string };
export function validDay(value: unknown): string | null;
export type WindowAdjustment = "invalid-start" | "invalid-end" | "swapped" | "clamped";
export function resolveCustomWindow(range: { start: string | null | undefined; end: string | null | undefined; previousStart?: string | null; previousEnd?: string | null; min: string; max: string }): { start: string; end: string; adjusted: WindowAdjustment[] };
export function previousPeriod(range: { start: string; end: string; min: string }): Period | null;
export function deltaDescription(current: number, previous: number | null | undefined, length: number): Delta | null;
export function downsample(values: number[], maxPoints: number): { indexFor: (index: number) => number; values: number[] };
export function sparklineSummary(label: string, values: number[], days: string[], format: (value: number) => string): string;
export function heatLevel(value: number, maximum: number): number;
export function activityGrid(sessions: SessionLike[], timeZone?: string): { grid: number[][]; counted: number; maximum: number };
export function heatLegend(maximum: number): Array<{ level: number; min: number; max: number }>;
export function tickScale(maximum: number): { axisMaximum: number; tick: number };
export function matchesQuery(item: PaletteItem, query: string): boolean;
export function paletteScore(item: PaletteItem, query: string): { score: number; tier: number };
export function rankPaletteItems<T extends PaletteItem>(items: T[], query: string): T[];
export function isTextEntryTarget(target: unknown): boolean;
export function presentProviders(sessions: Array<{ provider: string }>): string[];
export function providerShortcutTarget(key: string, providers: readonly string[]): string | null;
export function singleFlight<A extends unknown[], R>(task: (...args: A) => R | Promise<R>): (...args: A) => Promise<R>;
export const tableAccessors: Record<string, (item: RepositoryRow) => number | string>;
export function sortRepositories(repositories: RepositoryRow[], key: string, direction: "ascending" | "descending"): RepositoryRow[];
export function repositoryKey(id: string): string;
