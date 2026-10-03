import assert from "node:assert/strict";
import type { OutcomeSummary, SessionOutcomes } from "../src/metrics/outcome-types.ts";

const keys = (value: object, expected: string[]) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const count = (value: number) => assert.ok(Number.isSafeInteger(value) && value >= 0);
const number = (value: number) => assert.ok(Number.isFinite(value) && value >= 0);
const oneOf = (value: string, allowed: string[]) => assert.ok(allowed.includes(value));
const operationKeys = ["commits", "pushes", "prsCreated", "prsEdited", "prsMerged", "prsClosed"];
const enrichmentStates = ["off", "not-applicable", "matched", "no-match", "unavailable", "limited"];

/** The same exact-key/enum check can audit a real snapshot without printing its values. */
export function assertSessionOutcomeProjection(outcomes: SessionOutcomes): void {
  keys(outcomes, ["editsObserved", "editOperations", "linesAdded", "linesRemoved", "lineCoverage", "lineSource", "operations", "links", "agentCoauthoredCommits", "agentCoauthorTrailers", "enrichment", "truncated", "prAssociationsComplete"]);
  for (const value of [outcomes.editsObserved, outcomes.truncated, outcomes.prAssociationsComplete]) assert.equal(typeof value, "boolean");
  for (const value of [outcomes.editOperations, outcomes.agentCoauthoredCommits, outcomes.agentCoauthorTrailers]) count(value);
  for (const value of [outcomes.linesAdded, outcomes.linesRemoved]) if (value !== null) count(value);
  assert.equal(outcomes.linesAdded === null, outcomes.linesRemoved === null);
  assert.equal(outcomes.linesAdded === null, outcomes.lineCoverage === "unavailable");
  oneOf(outcomes.lineCoverage, ["complete", "partial", "unavailable"]);
  oneOf(outcomes.lineSource, ["claude-cost-state", "claude-structured-patch", "codex-file-change", "cursor-composer", "mixed", "unavailable"]);
  keys(outcomes.operations, operationKeys); Object.values(outcomes.operations).forEach(count);
  keys(outcomes.enrichment, ["git", "github"]); Object.values(outcomes.enrichment).forEach((state) => oneOf(state, enrichmentStates));
  assert.ok(outcomes.links.length <= 128);
  for (const link of outcomes.links) {
    keys(link, ["ref", "kind", "role", "identity", "confidence", "sources", "created", "state", "timeToMergeMilliseconds"]);
    assert.match(link.ref, /^(branch|commit|pr|commit-event|pr-event|workspace-pr)-[a-f0-9]{24}$/);
    oneOf(link.kind, ["branch", "commit", "pull-request"]); oneOf(link.role, ["outcome", "context"]);
    oneOf(link.identity, ["artifact", "observation"]); oneOf(link.confidence, ["strong", "medium", "weak"]);
    oneOf(link.state, ["unknown", "open", "closed", "merged"]); assert.equal(typeof link.created, "boolean");
    if (link.timeToMergeMilliseconds !== null) count(link.timeToMergeMilliseconds);
    assert.equal(new Set(link.sources).size, link.sources.length);
    link.sources.forEach((source) => oneOf(source, ["claude-git-operation", "claude-pr-link", "claude-branch", "codex-session-git", "conductor-workspace", "local-git", "github"]));
  }
}

export function assertOutcomeSummaryProjection(summary: OutcomeSummary): void {
  const counters = ["sessions", "observedSessions", "editSessions", "commitSessions", "prSessions", "mergedPrSessions", "contextOnlySessions", "lineMeasuredSessions", "linesAdded", "linesRemoved", "apiSessions", "apiPricedSessions", "unlinkedEditSessions"] as const;
  keys(summary, [...counters, "apiEquivalentValueUsd", "unlinkedApiEquivalentUsd", "coverage", "pullRequests", "operations", "commitSessionRate", "apiEquivalentPerMergedPr", "linesPerApiDollar"]);
  counters.forEach((key) => count(summary[key])); number(summary.apiEquivalentValueUsd); number(summary.unlinkedApiEquivalentUsd);
  keys(summary.operations, operationKeys); Object.values(summary.operations).forEach(count);
  keys(summary.pullRequests, ["linked", "created", "merged", "unidentifiedCreatedOperations", "unidentifiedMergedOperations"]);
  Object.values(summary.pullRequests).forEach(count);
  keys(summary.coverage, ["lines", "truncatedSessions", "enrichment"]); count(summary.coverage.truncatedSessions);
  keys(summary.coverage.lines, ["complete", "partial", "unavailable"]); Object.values(summary.coverage.lines).forEach(count);
  assert.equal(Object.values(summary.coverage.lines).reduce((sum, value) => sum + value, 0), summary.observedSessions);
  assert.equal(summary.coverage.lines.complete + summary.coverage.lines.partial, summary.lineMeasuredSessions);
  keys(summary.coverage.enrichment, ["git", "github"]);
  for (const states of Object.values(summary.coverage.enrichment)) {
    keys(states, enrichmentStates); Object.values(states).forEach(count);
    assert.equal(Object.values(states).reduce((sum, value) => sum + value, 0), summary.observedSessions);
  }
  for (const ratio of [summary.commitSessionRate, summary.apiEquivalentPerMergedPr, summary.linesPerApiDollar]) {
    keys(ratio, ["value", "numerator", "denominator", "minimumDenominator", "minimumSessions", "eligibleSessions", "candidateSessions", "incompleteEvidenceSessions", "status"]);
    number(ratio.numerator); number(ratio.denominator); number(ratio.minimumDenominator);
    [ratio.minimumSessions, ratio.eligibleSessions, ratio.candidateSessions, ratio.incompleteEvidenceSessions].forEach(count);
    oneOf(ratio.status, ["available", "unavailable", "insufficient-activity", "incomplete-pricing", "incomplete-evidence"]);
    assert.equal(ratio.value === null, ratio.status !== "available");
    assert.ok(ratio.eligibleSessions <= ratio.candidateSessions && ratio.incompleteEvidenceSessions <= ratio.candidateSessions);
    if (ratio.value !== null) { number(ratio.value); assert.equal(ratio.value, ratio.numerator / ratio.denominator); }
  }
}
