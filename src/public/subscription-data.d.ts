import type { CodexAccountSummary, LimitAccount, LimitMeterInfo, LimitObservation, LimitProvider, LimitSourceHealth, LimitStatus, LimitsSnapshot } from "../limits/types.ts";
import type { PlanPayer, SubscriptionPlan } from "./subscription-plans.js";

export const HOUR: number;
export const DAY: number;
export const WEEK: number;
export const MONTH_DAYS: number;
export const calibrationMinimum: number;
export const providerNames: Record<LimitProvider, string>;
export function identified(key: string): boolean;

export interface Sample { t: number; used: number; status: LimitStatus }
/** Part of a cycle between in-place resets. `before` is the last reading before the reset that started it. */
export interface Segment { start: number; end: number; before: Sample | null; samples: Sample[]; peak: number; last: Sample; cappedAt: number | null }
export interface Cycle {
  resetsAt: number; start: number; end: number; samples: Sample[]; segments: Segment[];
  /** The closing segment's last reading and highest reading. */
  last: Sample; peak: number;
  cappedAt: number | null; endedEarly: boolean; closed: boolean;
}
export interface Meter {
  key: string; provider: LimitProvider; account: string; meter: string; label: string; windowMinutes: number | null;
  retired: boolean;
  /** Idle markers (an unstarted Codex window) never form a cycle, so a meter with only those has none. */
  cycles: Cycle[];
}
export interface LiveMeter {
  meter: Meter; cycle: Cycle | null; segment: Segment | null;
  state: "idle" | "retired" | "active" | "capped" | "overage" | "unreported"; used: number;
  /** The next reset: the live cycle's, or a Claude weekly meter's fixed schedule while idle; null when the next request starts a window. */
  nextResetAt: number | null;
  rate?: number; remaining?: number; projected?: number | null; tooEarly?: boolean; stale?: boolean; capAt?: number | null;
  elapsed?: number; capsEarly?: boolean; mayBeUsedUp?: boolean; dailyBudget?: number | null; observedAt?: number;
}
export interface CalibrationPoint { resetsAt: number; start: number; at: number; used: number; spent: number; perPercent: number }
export interface Calibration { perPercent: number | null; cycles: number; excluded: number; low: number | null; high: number | null; points: CalibrationPoint[] }
export interface InPlaceReset { at: number; restored: number | null; restoredUsd: number | null; cause: "credit" | "provider" }
export interface ResetCycle {
  resetsAt: number; start: number; end: number; peak: number; lowerBound: boolean; endedEarly: boolean;
  capped: boolean; lockedSeconds: number; expired: number | null; expiredUsd: number | null;
  restored: number | null; restoredUsd: number | null; cause: "credit" | "unknown" | null; inPlace: InPlaceReset[];
}
export interface SessionWindows {
  windows: Array<{ start: number; end: number; resetsAt: number; peak: number; active: boolean; cappedAt: number | null; lockedSeconds: number }>;
  from: number; to: number; capped: number; lockedSeconds: number; averagePeak: number | null;
}
export interface Economics {
  plan: SubscriptionPlan | null; payer: PlanPayer | null; monthlyPrice: number | null; weeklyCapacity: number | null; monthlyPotential: number | null;
  days: number; price: number | null; potential: number | null; multiple: number | null; utilization: number | null;
  /** Null when no session can be attributed to the account, so its value is unknown rather than zero. */
  extracted: number | null;
}
export interface BankedCredit { scope: "all" | "five_hour" | "seven_day" | "unknown"; expiresAt: number | null; grantedAt: number | null; source: "provider" }
export interface BankedResets {
  provider: LimitProvider; credits: BankedCredit[]; available: number; known: boolean; observedAt: number | null; nextExpiry: number | null;
  upToUsd: number | null; fullValue(credit: BankedCredit): number | null; nowValue(credit: BankedCredit): number | null;
}
export interface ValueRange { from: number; to: number }
/** `profiles`: sessions in the account's profiles; `provider`: the provider's only account takes this machine's sessions; `none`: nothing attributable. */
export type ValueBasis = "profiles" | "provider" | "none";
export interface AccountUtilization {
  account: LimitAccount; key: string; provider: LimitProvider; label: string; identified: boolean; planId: string | null;
  meters: Meter[]; weeklyMeter: Meter | null; sessionMeter: Meter | null; weekly: LiveMeter | null; session: LiveMeter | null; live: LiveMeter[];
  /** In-place resets of the live weekly cycle. */
  history: ResetCycle[]; restarts: InPlaceReset[]; windows: SessionWindows | null; calibration: Calibration; sessionCalibration: Calibration | null;
  resets: BankedResets; economics: Economics; period: { from: number; to: number; days: number; firstReading: number | null };
  value: { basis: ValueBasis; sessions: number };
  utilization: { mean: number; closed: number; includesProjection: boolean } | null;
  excluded?: boolean;
}
export interface SubscriptionTotals {
  extracted: number; unattributed: number;
  priced: { accounts: number; extracted: number; price: number; multiple: number | null };
  organization: { accounts: number; extracted: number }; unpriced: { accounts: number; extracted: number };
  monthlyPotential: number | null; potentialMultiple: number | null; capacityUsed: number | null; potential: number | null;
  resetsUsed: number | null; banked: number;
}
export interface SubscriptionModel {
  meters: Meter[]; accounts: Array<AccountUtilization & { excluded: boolean }>; totals: SubscriptionTotals;
  /** Value of sessions no account could claim, and whether other machines' sessions are combined in. */
  unattributed: { claude: number; codex: number; remote: boolean };
}
export interface Recommendation {
  tone: "act" | "watch" | "good" | "setup"; provider: LimitProvider | null; account: string | null; score: number;
  title: string; detail: string; impactUsd: number | null;
}
export interface HourlyValue { between(from: number, to: number): number; empty: boolean }
export interface SessionLike { provider: string; historyProfile?: { profileKey: string } }

export function meterLabel(meter: string): string;
export function meterBase(meter: string): string;
export function buildMeters(observations: LimitObservation[], now: number, infos?: LimitMeterInfo[]): Meter[];
export function liveMeter(meter: Meter, now: number, reportedUntil?: number | null, options?: { project?: boolean }): LiveMeter;
export function latestReading(meters: Meter[]): number | null;
export function hourlyValue(sessions: unknown[], timeZone?: string): HourlyValue;
export function zonedDayStart(day: string, timeZone?: string): number;
export function attributeSessions<S extends SessionLike>(
  sessions: S[], accounts: LimitAccount[], options?: { local?: ((session: S) => boolean) | null },
): { byAccount: Map<string, S[]>; unattributed: { claude: S[]; codex: S[] } };
export function calibrate(meter: Meter | null, value: { between(from: number, to: number): number }): Calibration;
export function resetHistory(meter: Meter | null, perPercent?: number | null, creditHistory?: LimitsSnapshot["resetCreditHistory"]): ResetCycle[];
export function inPlaceResets(meter: Meter, cycle: Cycle, perPercent?: number | null, creditHistory?: LimitsSnapshot["resetCreditHistory"]): InPlaceReset[];
export function exactClose(cycle: ResetCycle): boolean;
export function sessionWindows(meter: Meter | null, now: number, span?: number): SessionWindows;
export const redeemWhere: { codex: string };
export function bankedResets(input: {
  provider: LimitProvider; summary?: CodexAccountSummary | null;
  weekly?: LiveMeter | null; session?: LiveMeter | null; perPercent?: number | null; sessionPerPercent?: number | null; now: number;
}): BankedResets;
export function economics(input: { provider: LimitProvider; planId: string | null; payer?: PlanPayer | null; perPercent: number | null; extracted: number | null; days: number }): Economics;
export function resetUtilization(history: ResetCycle[], live: LiveMeter | null, limit?: number): { mean: number; closed: number; includesProjection: boolean } | null;
export function visibleMeters(item: AccountUtilization): { weekly: LiveMeter | null; session: LiveMeter | null; extra: LiveMeter[] };
export interface AccountStatus {
  kind: "capped" | "overage" | "runs-out" | "may-be-used-up" | "stale" | "too-early" | "on-track" | "idle" | "levels-only";
  tone: "danger" | "warn" | "ok" | "muted"; rank: number; used: number; meter: "weekly" | "session";
  /** Run-out instant; `until`: the reset that ends a cap or an idle week; `since`: the last reading; `early`: seconds before the reset. */
  at: number | null; until: number | null; since: number | null; early: number | null;
}
export function limitStatus(item: AccountUtilization, now: number): AccountStatus;
export function compareUrgency(left: AccountStatus, right: AccountStatus): number;
export function meterPace(live: LiveMeter | null, now: number): { segment: number; cycle: number; budget: number | null } | null;
export function formatDuration(seconds: number): string;
export function accountUtilization(input: {
  account: LimitAccount; meters: Meter[]; sessions?: unknown[]; timeZone?: string; now: number; range: ValueRange;
  planId?: string | null; payer?: PlanPayer | null; creditHistory?: LimitsSnapshot["resetCreditHistory"]; basis?: ValueBasis;
}): AccountUtilization;
export function subscriptionTotals(items: Array<AccountUtilization & { excluded?: boolean }>, unattributed?: { claude?: number; codex?: number }): SubscriptionTotals;
export function subscriptionModel(input: {
  limits: Pick<LimitsSnapshot, "accounts" | "observations" | "meters" | "resetCreditHistory">; sessions: SessionLike[];
  timeZone?: string; now: number; range: ValueRange; plans?: Record<string, string | null | undefined>; payers?: Record<string, PlanPayer | null | undefined>;
  local?: ((session: SessionLike) => boolean) | null;
}): SubscriptionModel;
export function recommendations(items: AccountUtilization[], options: {
  now: number; sources?: LimitSourceHealth[]; persisted?: boolean; codexAccount?: "off" | "ok" | "unavailable"; formatTime?: (seconds: number) => string;
}): Recommendation[];
