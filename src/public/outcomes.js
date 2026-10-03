import { enrichmentStatuses, mergedOutcomeRefs, outcomeEvidence, summarizeOutcomes } from "./outcomes-summary.js";
import { DASH, dataTable, el, evidence, filterBar, kpi, note, panel, selectField } from "./ui.js";

const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const number = (value) => new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value);
const sourceNames = {
  "claude-git-operation": "Claude operation result", "claude-pr-link": "Claude PR link", "claude-branch": "Recorded branch",
  "codex-session-git": "Codex starting checkout", "conductor-workspace": "Workspace context", "local-git": "Branch and time match", github: "GitHub state",
};
let provider = "all", stage = "all", page = 0;
const size = 20;

function cell(value, detail) { return { text: value, detail }; }
function ratioValue(ratio, format = number) { return ratio.value === null ? null : format(ratio.value); }
function ratioReason(ratio) {
  return { available: "", unavailable: "No eligible denominator", "insufficient-activity": `Needs ≥${ratio.minimumDenominator} ${ratio.minimumDenominator === 1 ? "unit" : "units"} and ≥${ratio.minimumSessions} eligible sessions`, "incomplete-pricing": "Incomplete pricing; ratio withheld", "incomplete-evidence": "Incomplete PR associations; ratio withheld" }[ratio.status];
}
function ratioNote(ratio, unit) {
  return `${number(ratio.numerator)} / ${number(ratio.denominator)} ${unit} · ${ratio.eligibleSessions}/${ratio.candidateSessions} eligible sessions` +
    (ratio.incompleteEvidenceSessions ? ` · ${ratio.incompleteEvidenceSessions} sessions with incomplete evidence` : "");
}
function matches(session, mergedRefs) {
  if (stage === "all") return true;
  return outcomeEvidence(session, mergedRefs)[stage] ?? false;
}

export function renderOutcomes(container, scopeSessions) {
  container.replaceChildren();
  const sessions = scopeSessions.filter((session) => provider === "all" || session.provider === provider);
  const summary = summarizeOutcomes(sessions);
  const controls = el("div", null, "outcome-controls");
  const agent = selectField("outcome-agent", "Agent", [["all", "All agents"], ["claude", "Claude"], ["codex", "Codex"], ["cursor", "Cursor"], ["copilot", "Copilot CLI"], ["opencode", "OpenCode"], ["gemini", "Gemini CLI"], ["unsupported", "Unsupported"]], provider, (value) => { provider = value; page = 0; renderOutcomes(container, scopeSessions); });
  controls.append(filterBar(agent.wrapper), el("p", `${summary.observedSessions}/${summary.sessions} sessions inspected · ${summary.lineMeasuredSessions}/${summary.observedSessions} with line counts · ${summary.apiPricedSessions}/${summary.apiSessions} API sessions fully priced`, "evidence-line"));
  container.append(controls);
  if (!sessions.length) {
    container.append(el("p", "No sessions match this repository, date window, and agent. Change a filter to inspect outcome evidence.", "empty-state")); return;
  }

  const funnel = panel({ kicker: "Evidence funnel", title: "Sessions → edits → commits → PRs → merged", meta: "Select a stage to inspect sessions" });
  const stages = el("div", null, "stage-grid");
  const choose = (value) => { stage = value; page = 0; renderOutcomes(container, scopeSessions); container.querySelector("#outcome-session-evidence").scrollIntoView({ block: "start", behavior: "smooth" }); };
  for (const [label, value, key] of [["Sessions", summary.observedSessions, "all"], ["Edits", summary.editSessions, "edits"], ["Commits", summary.commitSessions, "commits"], ["PRs", summary.prSessions, "prs"], ["Merged PRs", summary.mergedPrSessions, "merged"]]) {
    const button = el("button", null, "outcome-stage"); button.type = "button";
    button.setAttribute("aria-pressed", String(stage === key));
    button.append(el("span", label), el("strong", number(value)));
    const meter = document.createElement("meter"); meter.min = 0; meter.max = Math.max(1, summary.observedSessions); meter.value = value; meter.setAttribute("aria-label", `${label}: ${value} of ${summary.observedSessions} inspected sessions`);
    button.append(meter, el("small", `${value}/${summary.observedSessions} sessions`));
    button.addEventListener("click", () => choose(key)); stages.append(button);
  }
  funnel.append(stages, evidence([
    "Independent evidence stages, not a conversion rate. A session can link a PR without recording an edit or commit. Missing evidence is not evidence of failure.",
    `Observed operations: ${summary.operations.commits} commits · ${summary.operations.pushes} pushes · ${summary.operations.prsCreated} PR creates · ${summary.operations.prsEdited} edits · ${summary.operations.prsMerged} merges · ${summary.operations.prsClosed} closes. Operations are not unique artifacts. ${summary.pullRequests.unidentifiedCreatedOperations} creates and ${summary.pullRequests.unidentifiedMergedOperations} merges lack a PR identity and are excluded from distinct PR totals.`,
  ]));
  container.append(funnel);

  const cards = el("div", null, "kpi-grid compact-metrics");
  cards.append(
    kpi({ label: "Identified PRs merged", value: number(summary.pullRequests.merged), note: `${summary.pullRequests.linked} linked · ${summary.pullRequests.created} created · deduplicated across sessions`, accent: true }),
    kpi({ label: "API value / merged PR", value: ratioValue(summary.apiEquivalentPerMergedPr, money), reason: ratioReason(summary.apiEquivalentPerMergedPr), note: ratioNote(summary.apiEquivalentPerMergedPr, "merged PRs") }),
    kpi({ label: "Changed lines / API dollar", value: ratioValue(summary.linesPerApiDollar), reason: ratioReason(summary.linesPerApiDollar), note: ratioNote(summary.linesPerApiDollar, "USD") }),
    kpi({ label: "Unlinked edit value", value: summary.apiPricedSessions ? money(summary.unlinkedApiEquivalentUsd) : null, reason: "No fully priced API sessions", note: `${summary.unlinkedEditSessions} API sessions with edits but no commit evidence · heuristic, may be work in progress` }),
  );
  container.append(cards, evidence([
    "API-equivalent value is not an invoice. PR attribution divides each session's value equally across all its identified PRs. Only linked session value is included; this is not the full cost of a change. Line counts include repeated edits and deletions, not surviving code. Cursor value is excluded from both dollar ratios.",
    "A dash (N/A) marks a withheld ratio: no eligible denominator, an activity guard not met, incomplete pricing, or incomplete PR associations. Ratios are never shown as 0.",
  ]));

  const comparison = panel({ kicker: "Compare with coverage", title: "Value and evidence by repository and agent" });
  const grouped = new Map();
  for (const session of sessions) {
    const key = `${session.repositoryId}:${session.provider}`;
    const group = grouped.get(key) || { name: session.repositoryName, provider: session.provider, sessions: [] };
    group.sessions.push(session); grouped.set(key, group);
  }
  const rows = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider)).map((group) => {
    const value = summarizeOutcomes(group.sessions);
    return [cell(group.name, group.provider), cell(`${value.commitSessions} commits · ${value.prSessions} PRs`, `${value.observedSessions}/${value.sessions} inspected · ${value.lineMeasuredSessions} with lines`),
      cell(`${value.pullRequests.created} / ${value.pullRequests.merged}`, "PRs may appear in multiple agent rows"),
      cell(ratioValue(value.apiEquivalentPerMergedPr, money) ?? DASH, ratioValue(value.apiEquivalentPerMergedPr, money) === null ? ratioReason(value.apiEquivalentPerMergedPr) : ratioNote(value.apiEquivalentPerMergedPr, "PRs")),
      cell(ratioValue(value.linesPerApiDollar) ?? DASH, ratioValue(value.linesPerApiDollar) === null ? ratioReason(value.linesPerApiDollar) : ratioNote(value.linesPerApiDollar, "USD")),
      cell(value.apiPricedSessions ? money(value.unlinkedApiEquivalentUsd) : DASH, `${value.unlinkedEditSessions} sessions · ${value.apiPricedSessions}/${value.apiSessions} fully priced`)];
  });
  comparison.append(dataTable([{ text: "Repository / agent", align: "left" }, { text: "Evidence sessions", align: "left" }, "PRs created / merged", "API value / merged PR", "Changed lines / $", "Unlinked edit value"], rows));
  container.append(comparison);

  const enrichment = ["git", "github"].map((kind) => {
    const states = summary.coverage.enrichment[kind];
    return `${kind === "git" ? "Local Git" : "GitHub"}: ${enrichmentStatuses.filter((state) => states[state]).map((state) => `${states[state]} ${state}`).join(", ") || "no inspected sessions"}`;
  });
  container.append(evidence([
    "How to read the evidence. Strong: an explicit commit operation or an identified PR link; a link proves association, not authorship or success. Medium: a local commit on an evidenced branch during the session, or a PR operation without an identity; concurrent human work may match. Weak: starting checkout, branch, or workspace context; these never count as produced commits or merged PRs.",
    "Coverage differs by agent: Claude can record Git operations and PR links; Codex starting checkout metadata is context only; Cursor line totals do not link commits or PRs. Unlinked value can reflect these recording gaps. Compare similar work with the same evidence coverage.",
    `${enrichment.join(". ")}. Enrichment is optional and off by default. ${summary.coverage.truncatedSessions} sessions reached evidence limits; affected counts are lower bounds.`,
    `Line coverage: ${summary.coverage.lines.complete} complete · ${summary.coverage.lines.partial} partial · ${summary.coverage.lines.unavailable} unavailable, out of ${summary.observedSessions} inspected sessions. Partial counts are lower bounds and excluded from the line-value ratio.`,
  ], { title: "Confidence, not a verdict" }));

  const evidencePanel = panel({ kicker: "Pseudonymous references", title: "Inspect session evidence" }); evidencePanel.id = "outcome-session-evidence";
  const stageField = selectField("outcome-stage", "Show sessions", [["all", "All sessions"], ["edits", "With edits"], ["commits", "With commit evidence"], ["prs", "With PR evidence"], ["merged", "With a merge observation"], ["unlinked", "Edits without commit evidence"]], stage, (value) => { stage = value; page = 0; renderOutcomes(container, scopeSessions); });
  evidencePanel.append(filterBar(stageField.wrapper));
  const mergedRefs = mergedOutcomeRefs(sessions);
  const filtered = sessions.filter((session) => matches(session, mergedRefs)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  page = Math.min(page, Math.max(0, Math.ceil(filtered.length / size) - 1));
  const detailRows = [];
  for (const session of filtered.slice(page * size, (page + 1) * size)) {
    const outcomes = session.outcomes;
    const outcomeCell = el("div"), contextCell = el("div");
    for (const link of outcomes?.links || []) {
      const details = el("details", null, "link");
      details.append(el("summary", `${link.kind} ${link.ref.slice(-8)} · ${link.confidence}${link.state === "unknown" ? "" : ` · ${link.state}`}`));
      details.append(note(`${link.sources.map((source) => sourceNames[source]).join("; ")}. ${link.identity === "observation" ? "No artifact identity; excluded from distinct PR totals. " : ""}${link.created ? "Creation recorded. " : ""}${link.timeToMergeMilliseconds === null ? "" : `${number(link.timeToMergeMilliseconds / 3_600_000)} hours from PR creation to merge.`}`));
      (link.role === "context" ? contextCell : outcomeCell).append(details);
    }
    if (outcomes?.operations.commits > 0 && !outcomes.links.some((link) => link.kind === "commit" && link.role === "outcome")) {
      outcomeCell.append(note("Commit operation recorded; link details were truncated."));
    }
    if (!outcomeCell.childNodes.length) outcomeCell.append(el("span", "No commit or PR evidence", "muted"));
    if (!contextCell.childNodes.length) contextCell.append(el("span", "None recorded", "muted"));
    detailRows.push([cell(session.sessionKey, `${session.repositoryName} · ${session.provider} · ${session.createdAt.slice(0, 10)}`),
      cell(outcomes?.linesAdded === null || !outcomes ? "Unavailable" : `+${number(outcomes.linesAdded)} / −${number(outcomes.linesRemoved)}`, `${outcomes?.editsObserved ? "Edit activity observed" : "No edit activity observed"}${outcomes?.lineCoverage === "partial" ? " · partial line counts" : ""}`), outcomeCell, contextCell]);
  }
  if (!filtered.length) evidencePanel.append(el("p", "No sessions have this evidence in the current scope.", "empty-state"));
  else evidencePanel.append(dataTable([{ text: "Session", align: "left" }, { text: "Line evidence", align: "left" }, { text: "Commit / PR links", align: "left" }, { text: "Context", align: "left" }], detailRows, { className: "outcome-sessions" }));
  const pagination = el("div", null, "session-pagination");
  for (const [label, delta] of [["Previous", -1], ["Next", 1]]) {
    const button = el("button", label, "button"); button.type = "button";
    button.disabled = delta < 0 ? page === 0 : (page + 1) * size >= filtered.length;
    button.addEventListener("click", () => { page += delta; renderOutcomes(container, scopeSessions); container.querySelector("#outcome-session-evidence").scrollIntoView({ block: "start" }); });
    pagination.append(button);
  }
  pagination.prepend(el("span", `${filtered.length ? page * size + 1 : 0}–${Math.min((page + 1) * size, filtered.length)} of ${filtered.length} sessions`));
  evidencePanel.append(pagination); container.append(evidencePanel);
}
