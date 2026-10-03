import type { OutcomeRatio, SessionAnalytics } from "../types.ts";
import { enrichmentStatuses, summarizeOutcomes } from "./outcomes-summary.js";

export function outcomeReport(sessions: SessionAnalytics[]): string {
  const summary = summarizeOutcomes(sessions);
  const metric = (ratio: OutcomeRatio, dollars = false): string => {
    const value = ratio.value === null ? `N/A (${ratio.status})` : `${dollars ? "$" : ""}${ratio.value.toFixed(2)}`;
    return `${value}; numerator ${ratio.numerator.toFixed(2)}, denominator ${ratio.denominator.toFixed(2)}; ${ratio.eligibleSessions}/${ratio.candidateSessions} eligible sessions` +
      (ratio.incompleteEvidenceSessions ? `; ${ratio.incompleteEvidenceSessions} sessions with incomplete evidence` : "");
  };
  const coverage = summary.coverage;
  const enrichment = (["git", "github"] as const).map((kind) => `${kind === "git" ? "Local Git" : "GitHub"}: ` +
    (enrichmentStatuses.filter((status) => coverage.enrichment[kind][status] > 0)
      .map((status) => `${coverage.enrichment[kind][status]} ${status}`).join(", ") || "no inspected sessions")).join("; ");
  const partialLines = coverage.lines.partial > 0 || coverage.lines.unavailable > 0 || coverage.truncatedSessions > 0;
  return `\nOutcome evidence (independent stages; activity does not prove success or quality)\n` +
    `  Sessions: ${summary.observedSessions}/${summary.sessions} inspected; edits ${summary.editSessions}; commits ${summary.commitSessions}; PRs ${summary.prSessions}; merged PRs ${summary.mergedPrSessions}\n` +
    `  Identified PRs: ${summary.pullRequests.linked} linked; ${summary.pullRequests.created} created; ${summary.pullRequests.merged} merged (deduplicated)\n` +
    `  PR operations without an identity: ${summary.pullRequests.unidentifiedCreatedOperations} created; ${summary.pullRequests.unidentifiedMergedOperations} merged\n` +
    `  Lines${partialLines ? " (observed lower bound)" : ""}: +${summary.linesAdded} / -${summary.linesRemoved}; ${summary.lineMeasuredSessions}/${summary.observedSessions} sessions measured\n` +
    `  Line coverage: ${coverage.lines.complete} complete; ${coverage.lines.partial} partial; ${coverage.lines.unavailable} unavailable (${summary.observedSessions} inspected sessions)\n` +
    `  Evidence coverage: ${summary.sessions - summary.observedSessions} uninspected; ${coverage.truncatedSessions} sessions reached evidence limits${coverage.truncatedSessions ? "; affected counts are lower bounds" : ""}.\n` +
    `  Enrichment (${summary.observedSessions} inspected sessions): ${enrichment}.\n` +
    `  API-equivalent value per merged PR: ${metric(summary.apiEquivalentPerMergedPr, true)}\n` +
    `  Changed lines per API-equivalent dollar: ${metric(summary.linesPerApiDollar)}\n` +
    `  Unlinked edit value: $${summary.unlinkedApiEquivalentUsd.toFixed(2)} across ${summary.unlinkedEditSessions} sessions (heuristic: edits without commit evidence, not abandoned work)\n` +
    `  API pricing: ${summary.apiPricedSessions}/${summary.apiSessions} sessions fully priced. API-equivalent value is not an invoice; PR attribution splits a session equally across its identified PRs.\n` +
    "  Confidence: strong = explicit operation/identified PR link; medium = branch-window match or anonymous PR operation; weak = checkout/workspace context, excluded from produced outcomes.\n";
}
