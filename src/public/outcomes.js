import { summarizeOutcomes } from "./outcomes-summary.js";

const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const number = (value) => new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value);
const sourceNames = {
  "claude-git-operation": "Claude operation result", "claude-pr-link": "Claude PR link", "claude-branch": "Recorded branch",
  "codex-session-git": "Codex starting checkout", "conductor-workspace": "Workspace context", "local-git": "Branch and time match", github: "GitHub state",
};
let provider = "all", stage = "all", page = 0;
const size = 20;

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined && value !== null) element.textContent = value;
  if (className) element.className = className;
  return element;
}
function note(value) { return node("p", value, "chart-note"); }
function cell(value, detail) {
  const element = node("td"); element.append(node("strong", value));
  if (detail) element.append(node("small", detail));
  return element;
}
function metric(label, value, detail) {
  const article = node("article", null, "metric-card");
  article.append(node("span", label), node("strong", value), node("small", detail)); return article;
}
function ratioValue(ratio, format = number) { return ratio.value === null ? "N/A" : format(ratio.value); }
function ratioNote(ratio, unit) {
  const reason = { available: "", unavailable: "No eligible denominator. ", "insufficient-activity": `Needs ≥${ratio.minimumDenominator} ${unit} and ≥${ratio.minimumSessions} eligible sessions. `, "incomplete-pricing": "Incomplete pricing; ratio withheld. " }[ratio.status];
  return `${reason}${number(ratio.numerator)} / ${number(ratio.denominator)} ${unit}; ${ratio.eligibleSessions}/${ratio.candidateSessions} eligible sessions.`;
}
function panel(title, kicker) {
  const article = node("article", null, "panel"); const header = node("header"), block = node("div");
  block.append(node("p", kicker, "kicker"), node("h2", title)); header.append(block); article.append(header); return article;
}
function table(headers) {
  const wrap = node("div", null, "table-wrap"), element = node("table"), head = node("thead"), row = node("tr"), body = node("tbody");
  headers.forEach((label) => { const th = node("th", label); th.scope = "col"; row.append(th); });
  head.append(row); element.append(head, body); wrap.append(element); return { wrap, body };
}
function matches(session, mergedRefs) {
  const outcomes = session.outcomes;
  if (stage === "all") return true;
  if (!outcomes) return false;
  if (stage === "edits") return outcomes.editsObserved;
  if (stage === "commits") return outcomes.links.some((link) => link.kind === "commit" && link.role === "outcome");
  if (stage === "prs") return outcomes.links.some((link) => link.kind === "pull-request" && link.role === "outcome");
  if (stage === "merged") return outcomes.links.some((link) => link.kind === "pull-request" && link.role === "outcome" && (link.state === "merged" || mergedRefs.has(link.ref)));
  return outcomes.editsObserved && !outcomes.links.some((link) => link.kind === "commit" && link.role === "outcome");
}

export function renderOutcomes(container, scopeSessions) {
  container.replaceChildren();
  const sessions = scopeSessions.filter((session) => provider === "all" || session.provider === provider);
  const summary = summarizeOutcomes(sessions);
  const controls = node("div", null, "outcome-controls");
  const providerLabel = node("label"), providerSelect = node("select");
  providerLabel.append(node("span", "Agent"));
  for (const [value, label] of [["all", "All agents"], ["claude", "Claude"], ["codex", "Codex"], ["cursor", "Cursor"]]) providerSelect.append(new Option(label, value));
  providerSelect.value = provider;
  providerSelect.addEventListener("change", () => { provider = providerSelect.value; page = 0; renderOutcomes(container, scopeSessions); });
  providerLabel.append(providerSelect);
  controls.append(providerLabel, note(`${summary.observedSessions}/${summary.sessions} sessions inspected · ${summary.lineMeasuredSessions}/${summary.observedSessions} with line counts · ${summary.apiPricedSessions}/${summary.apiSessions} API sessions fully priced`));
  container.append(controls);
  if (!sessions.length) {
    container.append(node("p", "No sessions match this repository, date window, and agent. Change a filter to inspect outcome evidence.", "empty-state")); return;
  }

  const funnel = panel("Sessions → edits → commits → PRs → merged", "EVIDENCE FUNNEL");
  const stages = node("div", null, "outcome-funnel");
  const choose = (value) => { stage = value; page = 0; renderOutcomes(container, scopeSessions); container.querySelector("#outcome-session-evidence").scrollIntoView({ block: "start", behavior: "smooth" }); };
  for (const [label, value, key] of [["Sessions", summary.observedSessions, "all"], ["Edits", summary.editSessions, "edits"], ["Commits", summary.commitSessions, "commits"], ["PRs", summary.prSessions, "prs"], ["Merged PRs", summary.mergedPrSessions, "merged"]]) {
    const button = node("button", null, "outcome-stage"); button.type = "button";
    button.setAttribute("aria-pressed", String(stage === key));
    button.append(node("span", label), node("strong", number(value)));
    const meter = document.createElement("meter"); meter.min = 0; meter.max = Math.max(1, summary.observedSessions); meter.value = value; meter.setAttribute("aria-label", `${label}: ${value} of ${summary.observedSessions} inspected sessions`);
    button.append(meter, node("small", `${value}/${summary.observedSessions} sessions`));
    button.addEventListener("click", () => choose(key)); stages.append(button);
  }
  funnel.append(stages, note("Independent evidence stages, not a conversion rate. A session can link a PR without recording an edit or commit. Missing evidence is not evidence of failure. Select a stage to inspect sessions."));
  container.append(funnel);

  const cards = node("div", null, "metric-grid compact-metrics");
  cards.append(
    metric("Identified PRs merged", number(summary.pullRequests.merged), `${summary.pullRequests.linked} linked · ${summary.pullRequests.created} created · deduplicated across sessions`),
    metric("API value / merged PR", ratioValue(summary.apiEquivalentPerMergedPr, money), ratioNote(summary.apiEquivalentPerMergedPr, "merged PRs")),
    metric("Changed lines / API dollar", ratioValue(summary.linesPerApiDollar), ratioNote(summary.linesPerApiDollar, "USD")),
    metric("Unlinked edit value", money(summary.unlinkedApiEquivalentUsd), `${summary.unlinkedEditSessions} API sessions with edits but no commit evidence. Heuristic; may be valid work in progress.`),
  );
  container.append(cards, note("API-equivalent value is not an invoice. PR attribution divides each session's value equally across all its identified PRs. Only linked session value is included; this is not the full cost of a change. Line counts include repeated edits and deletions, not surviving code. Cursor value is excluded from both dollar ratios."));

  const comparison = panel("Value and evidence by repository and agent", "COMPARE WITH COVERAGE");
  const grouped = new Map();
  for (const session of sessions) {
    const key = `${session.repositoryId}:${session.provider}`;
    const group = grouped.get(key) || { name: session.repositoryName, provider: session.provider, sessions: [] };
    group.sessions.push(session); grouped.set(key, group);
  }
  const comparisonTable = table(["Repository / agent", "Evidence sessions", "PRs created / merged", "API value / merged PR", "Changed lines / $", "Unlinked edit value"]);
  for (const group of [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider))) {
    const value = summarizeOutcomes(group.sessions), row = node("tr");
    row.append(cell(group.name, group.provider), cell(`${value.commitSessions} commits · ${value.prSessions} PRs`, `${value.observedSessions}/${value.sessions} inspected · ${value.lineMeasuredSessions} with lines`),
      cell(`${value.pullRequests.created} / ${value.pullRequests.merged}`, "PRs may appear in multiple agent rows"),
      cell(ratioValue(value.apiEquivalentPerMergedPr, money), ratioNote(value.apiEquivalentPerMergedPr, "PRs")),
      cell(ratioValue(value.linesPerApiDollar), ratioNote(value.linesPerApiDollar, "USD")),
      cell(money(value.unlinkedApiEquivalentUsd), `${value.unlinkedEditSessions} sessions · ${value.apiPricedSessions}/${value.apiSessions} fully priced`));
    comparisonTable.body.append(row);
  }
  comparison.append(comparisonTable.wrap); container.append(comparison);

  const legend = panel("How to read the evidence", "CONFIDENCE, NOT A VERDICT");
  const legendList = node("div", null, "outcome-legend");
  for (const [strength, description] of [["Strong", "An explicit commit operation or an identified PR link. A link proves association, not authorship or success."], ["Medium", "A local commit on an evidenced branch during the session, or a PR operation without an identity. Concurrent human work may match."], ["Weak", "Starting checkout, branch, or workspace context. These never count as produced commits or merged PRs."]]) {
    const block = node("div"); block.append(node("strong", strength), note(description)); legendList.append(block);
  }
  legend.append(legendList, note(`Observed operations: ${summary.operations.commits} commits · ${summary.operations.pushes} pushes · ${summary.operations.prsCreated} PR creates · ${summary.operations.prsEdited} edits · ${summary.operations.prsMerged} merges · ${summary.operations.prsClosed} closes. Operations are not unique artifacts. ${summary.pullRequests.unidentifiedCreatedOperations} creates and ${summary.pullRequests.unidentifiedMergedOperations} merges lack a PR identity and are excluded from distinct PR totals.`));
  legend.append(note("Coverage differs by agent: Claude can record Git operations and PR links; Codex starting checkout metadata is context only; Cursor line totals do not link commits or PRs. Unlinked value can reflect these recording gaps. Compare similar work with the same evidence coverage."));
  const enrichment = ["git", "github"].map((kind) => {
    const states = new Map();
    for (const session of sessions) { const state = session.outcomes?.enrichment[kind] ?? "unavailable"; states.set(state, (states.get(state) || 0) + 1); }
    return `${kind === "git" ? "Local Git" : "GitHub"}: ${[...states].map(([state, count]) => `${count} ${state}`).join(", ")}`;
  });
  legend.append(note(`${enrichment.join(". ")}. Enrichment is optional and off by default. ${sessions.filter((session) => session.outcomes?.truncated).length} sessions reached evidence limits.`));
  container.append(legend);

  const evidence = panel("Inspect session evidence", "PSEUDONYMOUS REFERENCES"); evidence.id = "outcome-session-evidence";
  const stageLabel = node("label"), stageSelect = node("select"); stageLabel.append(node("span", "Show sessions"));
  for (const [value, label] of [["all", "All sessions"], ["edits", "With edits"], ["commits", "With commit evidence"], ["prs", "With PR evidence"], ["merged", "With a merge observation"], ["unlinked", "Edits without commit evidence"]]) stageSelect.append(new Option(label, value));
  stageSelect.value = stage; stageSelect.addEventListener("change", () => { stage = stageSelect.value; page = 0; renderOutcomes(container, scopeSessions); }); stageLabel.append(stageSelect); evidence.append(stageLabel);
  const mergedRefs = new Set(sessions.flatMap((session) => (session.outcomes?.links || []).filter((link) => link.role === "outcome" && link.identity === "artifact" && link.state === "merged").map((link) => link.ref)));
  const filtered = sessions.filter((session) => matches(session, mergedRefs)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  page = Math.min(page, Math.max(0, Math.ceil(filtered.length / size) - 1));
  const detailTable = table(["Session", "Line evidence", "Commit / PR links", "Context"]);
  for (const session of filtered.slice(page * size, (page + 1) * size)) {
    const row = node("tr"), outcomes = session.outcomes;
    const outcomeCell = node("td"), contextCell = node("td");
    for (const link of outcomes?.links || []) {
      const details = node("details");
      details.append(node("summary", `${link.kind} ${link.ref.slice(-8)} · ${link.confidence}${link.state === "unknown" ? "" : ` · ${link.state}`}`));
      details.append(note(`${link.sources.map((source) => sourceNames[source]).join("; ")}. ${link.identity === "observation" ? "No artifact identity; excluded from distinct PR totals. " : ""}${link.created ? "Creation recorded. " : ""}${link.timeToMergeMilliseconds === null ? "" : `${number(link.timeToMergeMilliseconds / 3_600_000)} hours from PR creation to merge.`}`));
      (link.role === "context" ? contextCell : outcomeCell).append(details);
    }
    if (!outcomeCell.childNodes.length) outcomeCell.append(node("span", "No commit or PR evidence"));
    if (!contextCell.childNodes.length) contextCell.append(node("span", "None recorded"));
    row.append(cell(session.sessionKey, `${session.repositoryName} · ${session.provider} · ${session.createdAt.slice(0, 10)}`),
      cell(outcomes?.linesAdded === null || !outcomes ? "Unavailable" : `+${number(outcomes.linesAdded)} / −${number(outcomes.linesRemoved)}`, `${outcomes?.editsObserved ? "Edit activity observed" : "No edit activity observed"}${outcomes?.lineCoverage === "partial" ? " · partial line counts" : ""}`), outcomeCell, contextCell);
    detailTable.body.append(row);
  }
  if (!filtered.length) evidence.append(node("p", "No sessions have this evidence in the current scope.", "empty-state"));
  else evidence.append(detailTable.wrap);
  const pagination = node("div", null, "session-pagination");
  for (const [label, delta] of [["Previous", -1], ["Next", 1]]) {
    const button = node("button", label, "button"); button.type = "button";
    button.disabled = delta < 0 ? page === 0 : (page + 1) * size >= filtered.length;
    button.addEventListener("click", () => { page += delta; renderOutcomes(container, scopeSessions); container.querySelector("#outcome-session-evidence").scrollIntoView({ block: "start" }); });
    pagination.append(button);
  }
  pagination.prepend(node("span", `${filtered.length ? page * size + 1 : 0}–${Math.min((page + 1) * size, filtered.length)} of ${filtered.length} sessions`));
  evidence.append(pagination); container.append(evidence);
}
