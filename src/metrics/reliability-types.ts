/** Content-free public reliability projection. Call IDs, paths and digests are internal only. */
export type ToolClass = "read" | "search" | "edit" | "write" | "shell" | "test_build" | "vcs" | "web" | "mcp" | "delegate" | "plan" | "other";
export type ToolOutcome = "success" | "error" | "denied" | "interrupted" | "timeout" | "unknown";
export type ErrorClass = "not_found" | "edit_anchor_mismatch" | "permission_denied_user" | "permission_denied_policy" | "hook_blocked" | "timeout" | "command_not_found" | "nonzero_exit" | "test_failed" | "interrupted" | "api_rate_limit" | "api_server_error" | "mcp_error" | "unknown";
export type BehaviorFlag = "exact_repeat" | "repeated_failure" | "failed_edit_cascade" | "edit_thrash" | "reread_churn" | "search_loop";
export interface LatencyDistribution {
  samples: number;
  /** Sparse [bucket upper bound in milliseconds, count] pairs; at most 10% rounding. */
  buckets: Array<[number, number]>;
  p50Ms: number | null;
  p95Ms: number | null;
}
export interface ReliabilityStats {
  calls: number;
  outcomes: Record<ToolOutcome, number>;
  errors: Partial<Record<ErrorClass, number>>;
  latency: LatencyDistribution;
}
export interface ToolReliability extends ReliabilityStats { name: string; toolClass: ToolClass }
export interface McpReliability extends ReliabilityStats { server: string; connectionFailures: number }
export interface SessionReliability {
  version: 1;
  contentRules: "enabled" | "disabled";
  hashing: "enabled" | "disabled" | "unavailable";
  /** Namespaced structured call evidence, without expanding opaque code-mode wrappers. */
  tools: ToolReliability[];
  mcp: McpReliability[];
  coverage: {
    argumentCalls: number;
    fileCalls: number;
    unmatchedResults: number;
    /** Parsing, retained-state or hashing safeguard hit: behavior/verification are unavailable. */
    truncated: boolean;
  };
  flags: Record<BehaviorFlag, number> | null;
  verification: {
    checks: number;
    passed: number;
    failed: number;
    editCalls: number;
    /** Checks / (edit + write + check calls), guarded below five eligible calls. */
    share: number | null;
    /** True for a skip; false only for a completed check started after edits completed. Null for overlap/incomplete evidence. */
    skip: boolean | null;
    /** Preceding calls and elapsed time in the main transcript only. */
    stepsToFirstEdit: number | null;
    msToFirstEdit: number | null;
  };
  hooks: { runs: number; blocks: number; latency: LatencyDistribution };
  permissions: {
    denials: number;
    modes: Partial<Record<"default" | "auto" | "bypassPermissions" | "plan" | "acceptEdits" | "dontAsk" | "unknown", number>>;
    approvalPolicies: Partial<Record<"untrusted" | "on-failure" | "on-request" | "never" | "unknown", number>>;
    sandboxes: Partial<Record<"read-only" | "workspace-write" | "danger-full-access" | "external-sandbox" | "unknown", number>>;
  };
  apiErrors: Partial<Record<"api_rate_limit" | "api_server_error" | "unknown", number>>;
}

/** Derived on demand from sessions, also in the browser after filtering. */
export interface ReliabilitySummary {
  sessions: number;
  coveredSessions: number;
  contentRuleSessions: number;
  flagSessions: number;
  truncatedSessions: number;
  totals: ReliabilityStats;
  tools: ToolReliability[];
  classes: Array<ReliabilityStats & { toolClass: ToolClass }>;
  mcp: McpReliability[];
  flags: Record<BehaviorFlag, number>;
  verification: SessionReliability["verification"] & { eligibleSessions: number; skippedSessions: number; firstEditSessions: number; timedEditSessions: number };
  hooks: SessionReliability["hooks"];
  permissions: SessionReliability["permissions"];
  apiErrors: SessionReliability["apiErrors"];
}
