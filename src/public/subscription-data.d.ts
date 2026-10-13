import type { ClaudeAccountSummary, CodexAccountSummary, LimitObservation, LimitProvider, LimitSourceHealth, LimitStatus } from "../limits/types.ts";
import type { SubscriptionPlan } from "./subscription-plans.js";

export const HOUR: number;
export const DAY: number;
export const MONTH_DAYS: number;
export const providerNames: Record<LimitProvider, string>;

export interface Sample { t: number; used: number; status: LimitStatus }
export interface Cycle {
  resetsAt: number; start: number; end: number; samples: Sample[]; peak: number; last: Sample;
  cappedAt: number | null; endedEarly: boolean; closed: boolean;
}
export interface Meter { key: string; provider: LimitProvider; meter: string; label: string; windowMinutes: number | null; cycles: Cycle[]; primary: boolean }
export interface LiveMeter {
  meter: Meter; cycle: Cycle | null; previous: Cycle | null; state: "idle" | "active" | "capped" | "unreported"; used: number;
  elapsed?: number | null; rate?: number; recentRate?: number | null; remaining?: number; projected?: number | null;
  capAt?: number | null; capsEarly?: boolean; paceDelta?: number | null; dailyBudget?: number | null; stale?: boolean; observedAt?: number;
}
export interface Calibration { perPercent: number | null; cycles: number; low: number | null; high: number | null; points: Array<{ resetsAt: number; used: number; spent: number; perPercent: number }> }
export interface ResetCycle {
  resetsAt: number; start: number; end: number; peak: number; lowerBound: boolean; endedEarly: boolean;
  capped: boolean; lockedSeconds: number; expired: number | null; expiredUsd: number | null;
  restored: number | null; restoredUsd: number | null; cause: "credit" | "unknown" | null;
}
export interface SessionWindows {
  windows: Array<{ start: number; end: number; resetsAt: number; peak: number; active: boolean; cappedAt: number | null; lockedSeconds: number }>;
  from: number; to: number; capped: number; lockedSeconds: number; averagePeak: number | null;
}
export interface Economics {
  plan: SubscriptionPlan | null; monthlyPrice: number | null; weeklyCapacity: number | null; monthlyPotential: number | null;
  days: number; price: number | null; potential: number | null; extracted: number;
  multiple: number | null; potentialMultiple: number | null; utilization: number | null; leftOnTable: number | null;
}
export interface BankedCredit { scope: "all" | "five_hour" | "seven_day" | "unknown"; expiresAt: number | null; grantedAt: number | null; source: "provider" }
export interface BankedResets {
  provider: LimitProvider; credits: BankedCredit[]; available: number; known: boolean; observedAt: number | null; nextExpiry: number | null;
  upToUsd: number | null; fullValue(credit: BankedCredit): number | null; nowValue(credit: BankedCredit): number | null;
}
export const redeemWhere: { codex: string };
export function bankedResets(input: {
  provider: LimitProvider; account?: CodexAccountSummary | ClaudeAccountSummary | null;
  weekly?: LiveMeter | null; session?: LiveMeter | null; perPercent?: number | null; sessionPerPercent?: number | null; now: number;
}): BankedResets;
export interface ProviderUtilization {
  provider: LimitProvider; planId: string | null; meters: Meter[]; weeklyMeter: Meter | null; sessionMeter: Meter | null;
  weekly: LiveMeter | null; session: LiveMeter | null; live: LiveMeter[]; history: ResetCycle[]; windows: SessionWindows | null;
  calibration: Calibration; sessionCalibration: Calibration | null; economics: Economics;
  account: CodexAccountSummary | ClaudeAccountSummary | null; resets: BankedResets;
  utilization: { mean: number; closed: number; includesProjection: boolean } | null;
}
export interface Recommendation { tone: "act" | "watch" | "good" | "setup"; provider: LimitProvider | null; score: number; title: string; detail: string; impactUsd: number | null }

export function meterLabel(meter: string): string;
export function meterBase(meter: string): string;
export function buildMeters(observations: LimitObservation[], now: number): Meter[];
export function findMeter(meters: Meter[], provider: LimitProvider, meter: string): Meter | null;
export function liveMeter(meter: Meter, now: number, reportedUntil?: number | null): LiveMeter;
export function latestReading(meters: Meter[]): number | null;
export function hourlyValue(sessions: unknown[], provider: LimitProvider, timeZone?: string): { between(from: number, to: number): number; empty: boolean };
export function calibrate(meter: Meter | null, value: { between(from: number, to: number): number }): Calibration;
export function resetHistory(meter: Meter | null, perPercent?: number | null, creditHistory?: Array<[LimitProvider, number, number]>): ResetCycle[];
export function sessionWindows(meter: Meter | null, now: number, span?: number): SessionWindows;
export function economics(input: { provider: LimitProvider; planId: string | null; perPercent: number | null; extracted: number; days: number }): Economics;
export function resetUtilization(history: ResetCycle[], live: LiveMeter | null, limit?: number): { mean: number; closed: number; includesProjection: boolean } | null;
export function formatDuration(seconds: number): string;
export function recommendations(providers: ProviderUtilization[], options: { now: number; sources?: LimitSourceHealth[]; persisted?: boolean; codexAccount?: "off" | "ok" | "unavailable"; formatTime?: (seconds: number) => string }): Recommendation[];
export function providerUtilization(input: {
  provider: LimitProvider; meters: Meter[]; sessions: unknown[]; timeZone: string; now: number; planId: string | null; extracted: number; days: number;
  account?: CodexAccountSummary | ClaudeAccountSummary | null; creditHistory?: Array<[LimitProvider, number, number]>;
}): ProviderUtilization;
