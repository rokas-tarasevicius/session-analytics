// Shared by the analyzer, report, and browser: filtered metrics use the same rules.
const operations = () => ({ commits: 0, pushes: 0, prsCreated: 0, prsEdited: 0, prsMerged: 0, prsClosed: 0 });
const priced = (session) => session.costBasis === "api-list-price-equivalent" &&
  session.costComplete && session.pricedTokenCoverage === 1;
const produced = (outcomes, kind) => outcomes.links.filter((link) => link.kind === kind && link.role === "outcome");
export const enrichmentStatuses = ["off", "not-applicable", "matched", "no-match", "unavailable", "limited"];
const statusCounts = () => Object.fromEntries(enrichmentStatuses.map((status) => [status, 0]));

export function mergedOutcomeRefs(sessions) {
  return new Set(sessions.flatMap((session) => session.outcomes ? produced(session.outcomes, "pull-request")
    .filter((link) => link.identity === "artifact" && link.state === "merged").map((link) => link.ref) : []));
}

// These semantic predicates also drive the drilldowns. Bounded link details
// can disappear while a successful operation counter still survives.
export function outcomeEvidence(session, mergedRefs = new Set()) {
  const outcomes = session.outcomes;
  const edits = Boolean(outcomes?.editsObserved);
  const commits = Boolean(outcomes && (outcomes.operations.commits > 0 || produced(outcomes, "commit").length));
  const prs = outcomes ? produced(outcomes, "pull-request") : [];
  return { edits, commits, prs: prs.length > 0,
    merged: prs.some((link) => link.state === "merged" || mergedRefs.has(link.ref)),
    unlinked: edits && !commits && session.costBasis === "api-list-price-equivalent" };
}

function ratio(numerator, denominator, eligibleSessions, candidateSessions, minimumDenominator, minimumSessions = 1, incomplete = false, incompleteEvidenceSessions = 0) {
  const status = incompleteEvidenceSessions ? "incomplete-evidence" : !denominator || !candidateSessions ? "unavailable"
    : incomplete ? "incomplete-pricing"
    : denominator < minimumDenominator || eligibleSessions < minimumSessions ? "insufficient-activity" : "available";
  return { value: status === "available" ? numerator / denominator : null, numerator, denominator,
    minimumDenominator, minimumSessions, eligibleSessions, candidateSessions, incompleteEvidenceSessions, status };
}

export function summarizeOutcomes(sessions) {
  const result = {
    sessions: sessions.length, observedSessions: 0, editSessions: 0, commitSessions: 0,
    prSessions: 0, mergedPrSessions: 0, contextOnlySessions: 0, lineMeasuredSessions: 0,
    coverage: { lines: { complete: 0, partial: 0, unavailable: 0 }, truncatedSessions: 0,
      enrichment: { git: statusCounts(), github: statusCounts() } },
    linesAdded: 0, linesRemoved: 0, apiSessions: 0, apiPricedSessions: 0, apiEquivalentValueUsd: 0,
    unlinkedApiEquivalentUsd: 0, unlinkedEditSessions: 0,
    pullRequests: { linked: 0, created: 0, merged: 0, unidentifiedCreatedOperations: 0, unidentifiedMergedOperations: 0 },
    operations: operations(),
  };
  // References identify artifacts across sessions and providers. Never add per-session PR counts.
  const prs = new Map();
  for (const session of sessions) {
    const outcomes = session.outcomes;
    if (!outcomes) continue;
    for (const link of produced(outcomes, "pull-request")) {
      if (link.identity !== "artifact") continue;
      const previous = prs.get(link.ref) || { created: false, merged: false };
      previous.created ||= link.created;
      previous.merged ||= link.state === "merged";
      prs.set(link.ref, previous);
    }
  }
  const mergedPricedRefs = new Set();
  const mergedRefsInScope = mergedOutcomeRefs(sessions);
  let mergeValue = 0, mergeEligible = 0, mergeCandidates = 0, mergeUnpriced = 0, mergeIncomplete = 0;
  let lineValue = 0, changedLines = 0, lineEligible = 0, lineCandidates = 0;
  for (const session of sessions) {
    const outcomes = session.outcomes;
    if (!outcomes) continue;
    result.observedSessions += 1;
    const evidence = outcomeEvidence(session, mergedRefsInScope);
    const prLinks = produced(outcomes, "pull-request");
    result.editSessions += Number(evidence.edits);
    result.commitSessions += Number(evidence.commits);
    result.prSessions += Number(evidence.prs);
    result.mergedPrSessions += Number(evidence.merged);
    result.contextOnlySessions += Number(!evidence.commits && !evidence.prs && outcomes.links.length > 0 && outcomes.links.every((link) => link.role === "context"));
    result.coverage.lines[outcomes.lineCoverage] += 1;
    result.coverage.truncatedSessions += Number(outcomes.truncated);
    for (const kind of ["git", "github"]) result.coverage.enrichment[kind][outcomes.enrichment[kind]] += 1;
    for (const key of Object.keys(result.operations)) result.operations[key] += outcomes.operations[key];
    for (const link of prLinks.filter((link) => link.identity === "observation")) {
      result.pullRequests.unidentifiedCreatedOperations += Number(link.created);
      result.pullRequests.unidentifiedMergedOperations += Number(link.state === "merged");
    }
    const measured = outcomes.linesAdded !== null && outcomes.linesRemoved !== null;
    if (measured) {
      result.lineMeasuredSessions += 1;
      result.linesAdded += outcomes.linesAdded;
      result.linesRemoved += outcomes.linesRemoved;
    }
    if (session.costBasis !== "api-list-price-equivalent") continue;
    result.apiSessions += 1;
    result.apiPricedSessions += Number(priced(session));
    result.apiEquivalentValueUsd += session.cost.totalUsd;
    if (evidence.unlinked) {
      result.unlinkedEditSessions += 1;
      result.unlinkedApiEquivalentUsd += session.cost.totalUsd;
    }
    if (measured) {
      lineCandidates += 1;
      if (priced(session) && session.cost.totalUsd > 0 && outcomes.lineCoverage === "complete") {
        lineEligible += 1;
        lineValue += session.cost.totalUsd;
        changedLines += outcomes.linesAdded + outcomes.linesRemoved;
      }
    }
    const refs = [...new Set(prLinks.filter((link) => link.identity === "artifact").map((link) => link.ref))];
    const mergedRefs = refs.filter((ref) => prs.get(ref)?.merged);
    // Older projections without the specific flag are conservative at a cap.
    const associationsComplete = outcomes.prAssociationsComplete ?? !outcomes.truncated;
    if (mergedRefs.length || !associationsComplete) {
      mergeCandidates += 1;
      mergeIncomplete += Number(!associationsComplete);
      mergeUnpriced += Number(!priced(session));
      // Allocate across ALL identified PRs in the session, including open PRs.
      // This is an attribution heuristic, not the full cost of producing the PR.
      for (const ref of mergedRefs) mergedPricedRefs.add(ref);
      if (priced(session) && associationsComplete) {
        mergeEligible += 1;
        mergeValue += session.cost.totalUsd * mergedRefs.length / refs.length;
      }
    }
  }
  result.pullRequests.linked = prs.size;
  result.pullRequests.created = [...prs.values()].filter((pr) => pr.created).length;
  result.pullRequests.merged = [...prs.values()].filter((pr) => pr.merged).length;
  return { ...result,
    commitSessionRate: ratio(result.commitSessions, result.observedSessions, result.observedSessions, sessions.length, 5),
    apiEquivalentPerMergedPr: ratio(mergeValue, mergedPricedRefs.size, mergeEligible, mergeCandidates, 3, 1, mergeUnpriced > 0, mergeIncomplete),
    linesPerApiDollar: ratio(changedLines, lineValue, lineEligible, lineCandidates, 1, 5),
  };
}
