/** Subscription limit meters: provider-reported "used percent" of a reset window, never content. */

export type LimitProvider = "claude" | "codex";
export type LimitSource = "codex-session" | "codex-account" | "claude-sdk-log" | "claude-statusline";
/** `rejected` means the provider refused requests on this meter (the cap was hit). */
export type LimitStatus = "allowed" | "warning" | "rejected" | "unknown";

export const claudePlans = ["pro", "max-5x", "max-20x", "team", "enterprise"] as const;
export const codexPlans = ["free", "go", "plus", "prolite", "pro", "team", "business", "enterprise", "edu"] as const;
export type ClaudePlan = typeof claudePlans[number];
export type CodexPlan = typeof codexPlans[number];

export interface LimitObservation {
  provider: LimitProvider;
  /** Bounded meter identifier, for example `five_hour`, `seven_day` or `seven_day_opus`. */
  meter: string;
  /** Window length; `null` when the provider did not report one and the meter name does not imply it. */
  windowMinutes: number | null;
  /** Unix seconds when this window resets. Identifies the reset cycle. */
  resetsAt: number;
  /** Unix seconds of the provider record. */
  observedAt: number;
  /** 0–100 percent of the window allowance consumed. */
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
  plan: CodexPlan | null;
  observations: LimitObservation[];
  /** Codex credits pay for usage after the included allowance runs out. `balance` is in Codex credits, not dollars. */
  credits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null;
  ordinaryUsageAllowed: boolean | null;
  /** `credits` is null when only the count is known. */
  resetCredits: { available: number; credits: ResetCredit[] | null } | null;
}

export interface CodexAccountSummary {
  observedAt: number;
  credits: CodexAccountState["credits"];
  ordinaryUsageAllowed: boolean | null;
  resetCredits: CodexAccountState["resetCredits"];
}

/** Claude extra usage (pay-as-you-go after a limit), from Agent SDK events. */
export interface ClaudeAccountSummary {
  observedAt: number;
  extraUsage: "enabled" | "in-use" | "disabled" | "unknown";
  /** Fixed reason enum when disabled, e.g. `org_level_disabled`. */
  disabledReason: string | null;
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
  schemaVersion: 1;
  generatedAt: string;
  dataSource: "live" | "snapshot";
  /** True when observations are kept in the private ledger, so history outlives provider log rotation. */
  persisted: boolean;
  plans: { claude: ClaudePlan | null; codex: CodexPlan | null };
  sources: LimitSourceHealth[];
  observations: LimitObservation[];
  accounts: { codex: CodexAccountSummary | null; claude: ClaudeAccountSummary | null };
  /** Banked reset credit counts over time, recorded on change: [provider, observedAt, available]. */
  resetCreditHistory: Array<["codex" | "claude", number, number]>;
  /** Whether the opt-in Codex account read (banked resets) is enabled. */
  codexAccount: "off" | "ok" | "unavailable";
}
