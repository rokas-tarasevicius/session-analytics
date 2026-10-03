import type { SessionAnalytics } from "../types.ts";
import type { OutcomeEnrichmentStatus, OutcomeSummary } from "./outcome-types.ts";
export function summarizeOutcomes(sessions: readonly SessionAnalytics[]): OutcomeSummary;
export const enrichmentStatuses: readonly OutcomeEnrichmentStatus[];
export function mergedOutcomeRefs(sessions: readonly SessionAnalytics[]): Set<string>;
export function outcomeEvidence(session: SessionAnalytics, mergedRefs?: ReadonlySet<string>): {
  edits: boolean; commits: boolean; prs: boolean; merged: boolean; unlinked: boolean;
};
