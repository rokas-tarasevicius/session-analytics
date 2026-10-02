/** Public, content-free outcome evidence. Raw correlation data stays in the collector. */
export type OutcomeConfidence = "strong" | "medium" | "weak";
export type OutcomeSource =
  | "claude-git-operation" | "claude-pr-link" | "claude-branch"
  | "codex-session-git" | "conductor-workspace" | "local-git" | "github";
export type OutcomeEnrichmentStatus = "off" | "not-applicable" | "matched" | "no-match" | "unavailable" | "limited";

export interface OutcomeLink {
  ref: string;
  kind: "branch" | "commit" | "pull-request";
  role: "outcome" | "context";
  identity: "artifact" | "observation";
  confidence: OutcomeConfidence;
  sources: OutcomeSource[];
  created: boolean;
  state: "unknown" | "open" | "closed" | "merged";
  timeToMergeMilliseconds: number | null;
}

export interface OutcomeOperations {
  commits: number;
  pushes: number;
  prsCreated: number;
  prsEdited: number;
  prsMerged: number;
  prsClosed: number;
}

export interface SessionOutcomes {
  editsObserved: boolean;
  editOperations: number;
  linesAdded: number | null;
  linesRemoved: number | null;
  lineCoverage: "unavailable" | "partial" | "complete";
  lineSource: "unavailable" | "claude-cost-state" | "claude-structured-patch" | "codex-file-change" | "cursor-composer" | "mixed";
  operations: OutcomeOperations;
  links: OutcomeLink[];
  agentCoauthoredCommits: number;
  agentCoauthorTrailers: number;
  enrichment: { git: OutcomeEnrichmentStatus; github: OutcomeEnrichmentStatus };
  truncated: boolean;
}

export interface OutcomeRatio {
  value: number | null;
  numerator: number;
  denominator: number;
  minimumDenominator: number;
  minimumSessions: number;
  eligibleSessions: number;
  candidateSessions: number;
  status: "available" | "unavailable" | "insufficient-activity" | "incomplete-pricing";
}

export interface OutcomeSummary {
  sessions: number;
  observedSessions: number;
  editSessions: number;
  commitSessions: number;
  prSessions: number;
  mergedPrSessions: number;
  contextOnlySessions: number;
  lineMeasuredSessions: number;
  linesAdded: number;
  linesRemoved: number;
  apiSessions: number;
  apiPricedSessions: number;
  apiEquivalentValueUsd: number;
  unlinkedApiEquivalentUsd: number;
  unlinkedEditSessions: number;
  pullRequests: {
    linked: number;
    created: number;
    merged: number;
    unidentifiedCreatedOperations: number;
    unidentifiedMergedOperations: number;
  };
  operations: OutcomeOperations;
  commitSessionRate: OutcomeRatio;
  apiEquivalentPerMergedPr: OutcomeRatio;
  linesPerApiDollar: OutcomeRatio;
}
