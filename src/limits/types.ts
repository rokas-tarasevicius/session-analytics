/** Subscription limit meters: provider-reported "used percent" of a reset window, never content. */

export type LimitProvider = "claude" | "codex";
export type LimitSource = "codex-session" | "codex-account" | "claude-sdk-log" | "claude-statusline";
/**
 * `rejected` means the provider refused requests on this meter (the cap was hit). `overage` means the cap was passed and
 * work continued on paid Claude extra usage, so it is not a lockout. `idle` marks a Codex window that has not started:
 * Codex reports it at 0% with a reset that slides forward with every reading.
 */
export type LimitStatus = "allowed" | "warning" | "rejected" | "overage" | "idle" | "unknown";

export const claudePlans = ["pro", "max-5x", "max-20x", "team", "enterprise"] as const;
export const codexPlans = ["free", "go", "plus", "prolite", "pro", "team", "business", "enterprise", "edu"] as const;
export type ClaudePlan = typeof claudePlans[number];
export type CodexPlan = typeof codexPlans[number];

export interface LimitObservation {
  provider: LimitProvider;
  /** Pseudonymous account key (`LimitAccount.key`); `""` when the reading could not be attributed to an account. */
  account: string;
  /** Bounded meter identifier, for example `five_hour`, `seven_day` or `seven_day_opus`. */
  meter: string;
  /** Window length; `null` when the provider did not report one and the meter name does not imply it. */
  windowMinutes: number | null;
  /** Unix seconds when this window resets. Identifies the reset cycle. */
  resetsAt: number;
  /** Unix seconds of the provider record. */
  observedAt: number;
  /** Percent of the window allowance consumed. Claude reports more than 100 while extra usage is in use. */
  usedPercent: number;
  status: LimitStatus;
  source: LimitSource;
}

/** A banked reset: redeeming it restarts the provider's windows at 0%. Opaque IDs and backend text are never kept. */
export interface ResetCredit {
  status: "available" | "redeeming" | "redeemed" | "unknown";
  /** `all` restores every Codex window; Claude offers restore one window (`five_hour` or `seven_day`). */
  scope: "all" | "five_hour" | "seven_day" | "unknown";
  grantedAt: number | null;
  expiresAt: number | null;
}

export interface CodexAccountState {
  observedAt: number;
  /** Pseudonymous key of the account the app-server answered for; null when it did not say. */
  account: string | null;
  plan: CodexPlan | null;
  /** Raw `planType` enum, kept when it is not a known plan. */
  planType: string | null;
  observations: LimitObservation[];
  /** Codex credits pay for usage after the included allowance runs out. `balance` is in Codex credits, not dollars. */
  credits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null;
  ordinaryUsageAllowed: boolean | null;
  /** `credits` is null when only the count is known. */
  resetCredits: { available: number; credits: ResetCredit[] | null } | null;
  /** Display names of scoped limits, by limit id. */
  limitNames: Record<string, string>;
}

export interface CodexAccountSummary {
  observedAt: number;
  credits: CodexAccountState["credits"];
  ordinaryUsageAllowed: boolean | null;
  resetCredits: CodexAccountState["resetCredits"];
}

/** Claude extra usage (pay-as-you-go after a limit), from Agent SDK events or the profile's `hasExtraUsageEnabled`. */
export interface ClaudeAccountSummary {
  observedAt: number;
  extraUsage: "enabled" | "in-use" | "disabled" | "unknown";
  /** Fixed reason enum when disabled, e.g. `org_level_disabled`. */
  disabledReason: string | null;
}

/** Allowlisted plan enums exactly as the provider stores them; each matches `^[a-z0-9_]{1,48}$` or is null. */
export interface PlanEvidence {
  organizationType: string | null;
  organizationRateLimitTier: string | null;
  userRateLimitTier: string | null;
  seatTier: string | null;
  billingType: string | null;
  /** Codex `plan_type`, kept when it is not a known plan so an unrecognised tier is visible. */
  planType: string | null;
}

/** Where an account's plan came from, most trusted first. */
export type PlanSource = "claude-config" | "claude-credentials" | "codex-account" | "codex-session";

/**
 * One subscription account. Claude keys hash the OAuth organization and account IDs inside the reader, so profile
 * directories logged into the same account share one key; Codex keys hash the ChatGPT account ID. `profile` keys hash a
 * profile path when the account could not be read, `weekly-phase` keys group unattributed Claude readings by weekly reset,
 * and the empty key holds readings that could not be attributed at all.
 */
export interface LimitAccount {
  key: string;
  provider: LimitProvider;
  attribution: "account" | "profile" | "weekly-phase" | "unattributed";
  /** Plan and local profile names, e.g. `Claude Max 20x · work`. Local-only, like `profileNames`. */
  label: string;
  /** Local profile directory names (`default` for `~/.claude` or `~/.codex`). Local-only: never in saved or shared snapshots. */
  profileNames: string[];
  /** Claude: the same keys as `session.historyProfile.profileKey`, so sessions join to accounts. Codex: hashed `CODEX_HOME` keys. */
  profileKeys: string[];
  plan: ClaudePlan | CodexPlan | null;
  planSource: PlanSource | null;
  planEvidence: PlanEvidence | null;
  /** Claude only. */
  extraUsage: ClaudeAccountSummary | null;
  /** Codex only: credit balance and banked resets. */
  codex: CodexAccountSummary | null;
  /** Latest weekly (`seven_day`) reset instant. Claude weekly resets recur at this weekday and time. */
  weeklyAnchor: number | null;
  /** Latest reading on any meter, Unix seconds. */
  lastSeen: number | null;
}

/** Per account and meter: display label and whether the provider still reports it. */
export interface LimitMeterInfo {
  provider: LimitProvider;
  account: string;
  meter: string;
  label: string;
  windowMinutes: number | null;
  lastObservedAt: number;
  /** The account kept reporting other meters for more than this meter's window after its last reading. */
  retired: boolean;
}

export interface LimitSourceHealth {
  source: LimitSource;
  /** `unavailable` means the source location does not exist on this machine. */
  status: "ok" | "empty" | "unavailable";
  /** Observations read during this harvest. */
  read: number;
  /** Most recent observation from this source in the ledger, Unix seconds. */
  latest: number | null;
}

export interface LimitsSnapshot {
  schemaVersion: 2;
  generatedAt: string;
  dataSource: "live" | "snapshot";
  /** True when observations are kept in the private ledger, so history outlives provider log rotation. */
  persisted: boolean;
  /** `unreadable`: the ledger exists but this version cannot read it, so it is left untouched and history is not kept. */
  ledger: "ok" | "off" | "unreadable" | "unwritable";
  /** Deprecated: the plan of each provider's most recently active account. Use `accounts`. */
  plans: { claude: ClaudePlan | null; codex: CodexPlan | null };
  sources: LimitSourceHealth[];
  observations: LimitObservation[];
  accounts: LimitAccount[];
  meters: LimitMeterInfo[];
  /** Banked reset credit counts over time, recorded on change: [provider, account, observedAt, available]. */
  resetCreditHistory: Array<[LimitProvider, string, number, number]>;
  /** Whether the opt-in Codex account read (banked resets) is enabled. */
  codexAccount: "off" | "ok" | "unavailable";
}
