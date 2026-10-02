import type { OutcomeRatio, SessionAnalytics } from "../types.ts";
import { summarizeOutcomes } from "./outcomes-summary.js";

export function outcomeReport(sessions: SessionAnalytics[]): string {
  const summary = summarizeOutcomes(sessions);
  const metric = (ratio: OutcomeRatio, dollars = false): string => {
    const value = ratio.value === null ? `N/A (${ratio.status})` : `${dollars ? "$" : ""}${ratio.value.toFixed(2)}`;
    return `${value}; numerator ${ratio.numerator.toFixed(2)}, denominator ${ratio.denominator.toFixed(2)}; ${ratio.eligibleSessions}/${ratio.candidateSessions} eligible sessions`;
  };
  return `\nOutcome evidence (independent stages; activity does not prove success or quality)\n` +
    `  Sessions: ${summary.observedSessions}/${summary.sessions} inspected; edits ${summary.editSessions}; commits ${summary.commitSessions}; PRs ${summary.prSessions}; merged PRs ${summary.mergedPrSessions}\n` +
    `  Identified PRs: ${summary.pullRequests.linked} linked; ${summary.pullRequests.created} created; ${summary.pullRequests.merged} merged (deduplicated)\n` +
    `  PR operations without an identity: ${summary.pullRequests.unidentifiedCreatedOperations} created; ${summary.pullRequests.unidentifiedMergedOperations} merged\n` +
    `  Lines: +${summary.linesAdded} / -${summary.linesRemoved}; ${summary.lineMeasuredSessions}/${summary.observedSessions} sessions measured\n` +
    `  API-equivalent value per merged PR: ${metric(summary.apiEquivalentPerMergedPr, true)}\n` +
    `  Changed lines per API-equivalent dollar: ${metric(summary.linesPerApiDollar)}\n` +
    `  Unlinked edit value: $${summary.unlinkedApiEquivalentUsd.toFixed(2)} across ${summary.unlinkedEditSessions} sessions (heuristic: edits without commit evidence, not abandoned work)\n` +
    `  API pricing: ${summary.apiPricedSessions}/${summary.apiSessions} sessions fully priced. API-equivalent value is not an invoice; PR attribution splits a session equally across its identified PRs.\n` +
    "  Confidence: strong = explicit operation/identified PR link; medium = branch-window match or anonymous PR operation; weak = checkout/workspace context, excluded from produced outcomes.\n";
}
