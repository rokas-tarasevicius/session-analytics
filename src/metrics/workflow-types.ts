import type { SessionProvider } from "../types.ts";

export interface WorkflowHistogram {
  /** Exact discrete samples, compressed by value. No transcript identifiers. */
  bins: Array<{ value: number; count: number }>;
  samples: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface WorkflowSpan { start: string; end: string }
export type WorkflowArchetype = "quick" | "standard" | "deep" | "marathon";
export type WorkflowEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type WorkflowEntrypoint = "cli" | "sdk-ts" | "local-agent" | "vscode" | "exec" | "subagent" | "review" | "unknown";
export type WorkflowOriginator = "codex_cli_rs" | "codex_vscode" | "codex_exec" | "codex_sdk" | "app-server" | "unknown";
export interface WorkflowMix {
  at: string;
  model: string | null;
  effort: WorkflowEffort | null;
  cliVersion: string | null;
  entrypoint: WorkflowEntrypoint;
  originator: WorkflowOriginator;
}

export interface SessionWorkflow {
  schemaVersion: 1;
  scope: "primary-transcript";
  ending: "terminal" | "interrupted" | "inferred" | "open" | "unavailable";
  coverage: {
    timing: "observed" | "partial" | "unavailable";
    humanTurns: "observed" | "partial" | "not-applicable";
    timestampedEvents: number;
    untimedEvents: number;
    droppedEvents: number;
    malformedRecords: number;
    projectionErrors: number;
    contentRules: boolean;
  };
  humanTurns: number | null;
  toolCalls: number;
  toolRuns: WorkflowHistogram;
  turnWallTime: WorkflowHistogram;
  recordedTurnDurations: number;
  inferredTurnDurations: number;
  time: {
    activeMilliseconds: number;
    waitingForHumanMilliseconds: number;
    unclassifiedMilliseconds: number;
    observedSpanMilliseconds: number;
    idleThresholdMilliseconds: number;
    waitingCapMilliseconds: number;
    activeSpans: WorkflowSpan[];
  };
  interruptions: {
    interrupted: number;
    replaced: number;
    other: number;
    subagentInterrupted: number;
    claudeMarkers: number | null;
  };
  steering: {
    midTurnHumanTurns: number;
    planEntries: number;
    planItems: number;
    queueOperations: { enqueue: number; dequeue: number; remove: number; other: number };
    queueReasons: { prompt: number; interrupt: number; completion: number; cancellation: number; other: number; unspecified: number };
  };
  archetype: WorkflowArchetype | null;
  abandonment: "flagged" | "not-flagged" | "insufficient-evidence" | "ongoing";
  mix: WorkflowMix[];
  commands: Array<{ name: string; at: string }>;
  unrecognizedCommands: number;
  commandHistoryAvailable: boolean;
  valueByHour: Array<{ hour: string; usd: number }>;
  pricedRequests: number;
  timestampedPricedRequests: number;
}

export interface WorkflowSkill {
  name: string;
  provider: "claude" | "codex";
  repositoryId: string | null;
}
export interface WorkflowInventory {
  skills: WorkflowSkill[];
  directoriesRead: number;
  directoriesUnavailable: number;
  historyFilesRead: number;
  historyFilesUnavailable: number;
  malformedHistoryRecords: number;
}

export interface WorkflowConcurrency {
  peak: number;
  activeSessionMilliseconds: number;
  wallClockActiveMilliseconds: number;
  effectiveParallelism: number | null;
  eligibleSessions: number;
  timeline: Array<WorkflowSpan & { sessions: number }>;
  daily: Array<{ day: string; peak: number; activeSessionMilliseconds: number; wallClockActiveMilliseconds: number }>;
}
export interface WorkflowComparison {
  repositoryId: string;
  provider: SessionProvider;
  dimension: "cliVersion" | "model";
  archetype: WorkflowArchetype;
  effort: WorkflowEffort | null;
  entrypoint: WorkflowEntrypoint;
  heldConstant: string;
  durationEvidence: "provider-duration" | "event-derived" | "mixed";
  before: string;
  after: string;
  changedAt: string;
  beforeSessions: number;
  afterSessions: number;
  status: "eligible" | "small-cohort" | "overlapping-eras";
  beforeTurnP50: number | null;
  afterTurnP50: number | null;
  beforeRunP50: number | null;
  afterRunP50: number | null;
  turnTimeChange: number | null;
}

export interface WorkflowSummary {
  schemaVersion: 1;
  coverage: { sessions: number; supportedSessions: number; timedSessions: number; humanSessions: number; contentRuleSessions: number; partialSessions: number };
  autonomy: { humanTurns: number; turnsPerSession: number | null; toolRuns: WorkflowHistogram; turnWallTime: WorkflowHistogram; recordedTurnDurations: number; inferredTurnDurations: number };
  time: { activeMilliseconds: number; waitingForHumanMilliseconds: number; unclassifiedMilliseconds: number };
  interruptions: SessionWorkflow["interruptions"] & { eligibleHumanTurns: number; perHumanTurn: number | null; eligibleSessions: number };
  steering: SessionWorkflow["steering"];
  concurrency: WorkflowConcurrency;
  repositories: Array<{ repositoryId: string; sessions: number; peak: number; effectiveParallelism: number | null; activeSessionMilliseconds: number; wallClockActiveMilliseconds: number }>;
  archetypes: Record<WorkflowArchetype | "unavailable", number>;
  abandonment: { flagged: number; eligible: number; ongoing: number; insufficientEvidence: number };
  patterns: {
    timezone: "UTC";
    cells: Array<{ weekday: number; hour: number; activeMilliseconds: number; apiEquivalentUsd: number }>;
    activeDays: number;
    longestStreakDays: number;
    currentStreakDays: number;
    asOfDay: string;
    pricedRequests: number;
    timestampedPricedRequests: number;
  };
  mix: Array<{ day: string; provider: SessionProvider; dimension: "model" | "effort" | "cliVersion" | "entrypoint" | "originator"; name: string; sessions: number }>;
  comparisons: WorkflowComparison[];
  commands: Array<{ name: string; count: number }>;
  unrecognizedCommands: number;
  commandHistorySessions: number;
  installedSkills: Array<WorkflowSkill & { observedInvocations: number }>;
  inventory: Omit<WorkflowInventory, "skills">;
}
