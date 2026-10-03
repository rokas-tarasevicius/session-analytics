import { errorDenominator, errorRate, guardedShare, summarizeReliability, summarizeReliabilityComparisons } from "./reliability-data.js";

const n = (value) => value.toLocaleString("en");
const percent = (value) => value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
const latency = (value) => value === null ? "N/A" : value < 1000 ? `≈${n(value)} ms` : `≈${(value / 1000).toFixed(1)} s`;
const label = (value) => value.replaceAll("_", " ");
function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}
function table(title, headers, rows, note) {
  const panel = node("article", undefined, "panel reliability-table-panel");
  const heading = node("header"); heading.append(node("h3", title)); panel.append(heading);
  if (note) panel.append(node("p", note, "chart-note"));
  if (!rows.length) { panel.append(node("p", "No evidence in the selected scope.", "muted")); return panel; }
  const wrap = node("div", undefined, "reliability-table-scroll"); wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", title);
  const table = node("table"), caption = node("caption", title, "reliability-sr-only"), head = node("thead"), headRow = node("tr"), body = node("tbody");
  for (const title of headers) { const th = node("th", title); th.scope = "col"; headRow.append(th); }
  head.append(headRow);
  for (const values of rows) {
    const row = node("tr");
    values.forEach((value, i) => { const cell = node(i === 0 ? "th" : "td", String(value)); if (!i) cell.scope = "row"; row.append(cell); });
    body.append(row);
  }
  table.append(caption, head, body); wrap.append(table); panel.append(wrap); return panel;
}
function errorCell(stats) {
  return `${percent(errorRate(stats))} · ${n(stats.outcomes.error + stats.outcomes.timeout)}/${n(errorDenominator(stats))}`;
}
function coverage(stats) { return `${n(stats.calls - stats.outcomes.unknown)}/${n(stats.calls)}`; }
function topErrors(stats) {
  return Object.entries(stats.errors).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key, count]) => `${label(key)} (${n(count)})`).join(" · ") || "—";
}
function card(title, value, detail) {
  const result = node("article", undefined, "metric-card"); result.append(node("span", title), node("strong", value), node("small", detail)); return result;
}

const viewStates = new WeakMap();
function selection(container, scopedSessions) {
  let state = viewStates.get(container);
  if (!state) { state = { provider: "all", scopes: [] }; viewStates.set(container, state); }
  let scope = state.scopes.find((s) => s.sessions.length === scopedSessions.length && s.sessions.every((v, i) => v === scopedSessions[i]));
  if (!scope) {
    scope = { sessions: scopedSessions.slice(), providers: new Map() };
    // Bounded scope cache: keep common repository/date round trips, release older snapshots.
    state.scopes.unshift(scope); state.scopes.length = Math.min(state.scopes.length, 3);
  }
  let selected = scope.providers.get(state.provider);
  if (!selected) {
    const sessions = state.provider === "all" ? scopedSessions : scopedSessions.filter((s) => s.provider === state.provider);
    selected = { summary: summarizeReliability(sessions), comparisons: summarizeReliabilityComparisons(sessions), argumentCalls: 0, fileCalls: 0, unmatchedResults: 0 };
    for (const s of sessions) {
      selected.argumentCalls += s.reliability?.coverage.argumentCalls || 0;
      selected.fileCalls += s.reliability?.coverage.fileCalls || 0;
      selected.unmatchedResults += s.reliability?.coverage.unmatchedResults || 0;
    }
    scope.providers.set(state.provider, selected);
  }
  return { state, ...selected };
}
export function renderReliability(container, scopedSessions) {
  const { state, summary, comparisons, argumentCalls, fileCalls, unmatchedResults } = selection(container, scopedSessions);
  container.replaceChildren();
  const totals = summary.totals, verification = summary.verification;
  const header = node("header", undefined, "view-header");
  const title = node("div"); title.append(node("p", "TOOL EVIDENCE", "kicker"));
  const h2 = node("h2", "Reliability"); h2.id = "reliability-title"; title.append(h2, node("p", "Where tool calls fail, slow down, or repeat. Every comparison keeps its coverage visible."));
  const filter = node("label", "Agent ", "reliability-provider");
  const select = node("select"); select.setAttribute("aria-label", "Reliability agent");
  for (const [value, text] of [["all", "All agents"], ["claude", "Claude"], ["codex", "Codex"], ["cursor", "Cursor"]]) { const option = node("option", text); option.value = value; select.append(option); }
  select.value = state.provider; select.addEventListener("change", () => { state.provider = select.value; renderReliability(container, scopedSessions); container.querySelector("select").focus(); });
  filter.append(select); header.append(title, filter); container.append(header);
  const metrics = node("div", undefined, "metric-grid compact-metrics");
  metrics.append(
    card("Observed outcomes", coverage(totals), `${summary.coveredSessions}/${summary.sessions} sessions supported · ${n(totals.outcomes.unknown)} unknown results`),
    card("Tool error rate", percent(errorRate(totals)), `${n(totals.outcomes.error + totals.outcomes.timeout)}/${n(errorDenominator(totals))} attempted calls · ${n(totals.outcomes.timeout)} timeouts`),
    card("Verification share", percent(verification.share), `${n(verification.checks)}/${n(verification.checks + verification.editCalls)} check + edit calls · ${n(verification.passed)} checks passed`),
    card("Unverified final edits", percent(guardedShare(verification.skippedSessions, verification.eligibleSessions)), `${verification.skippedSessions}/${verification.eligibleSessions} eligible edited sessions`),
  );
  container.append(metrics);
  const note = node("div", undefined, "reliability-notes");
  note.append(node("p", `Local content rules (P2): ${summary.contentRuleSessions}/${summary.coveredSessions} sessions. Hash-based flags: ${summary.flagSessions}/${summary.coveredSessions}. ${summary.contentRuleSessions ? "Only class labels and counts leave the parser." : "Enable --reliability-content-rules at launch for command, error-text and behavior rules."}`));
  note.append(node("p", "Error rates exclude denied, interrupted and unknown calls. Rates need 5 eligible observations. Latencies use reported durations only; ≈ marks merged bucket upper bounds (up to 10% + 1 ms)."));
  if (summary.truncatedSessions) note.append(node("p", `${summary.truncatedSessions} sessions have incomplete parsing or hit size safeguards. Their behavior flags and verification status are unavailable.`));
  if (unmatchedResults) note.append(node("p", `${n(unmatchedResults)} results have no matching call. Affected sessions cannot establish complete behavior or verification.`));
  if (!summary.coveredSessions) note.append(node("p", "Reliability evidence is available for Claude and Codex. Cursor reliability is not yet supported; missing evidence is never counted as a successful call."));
  container.append(note);

  const toolRows = (rows, classMode = false) => rows.map((row) => [classMode ? label(row.toolClass) : `${row.name} · ${label(row.toolClass)}`, n(row.calls), coverage(row), errorCell(row), `${row.outcomes.denied} / ${row.outcomes.interrupted}`, topErrors(row), `${latency(row.latency.p50Ms)} / ${latency(row.latency.p95Ms)}`, `${row.latency.samples}/${row.calls}`]);
  const headers = ["Tool / class", "Calls", "Known / calls", "Error % · errors / attempts", "Denied / interrupted", "Top error classes", "p50 / p95", "Timed / calls"];
  container.append(table("Tool outcomes", headers, toolRows(summary.tools.slice(0, 50)), `${summary.tools.length} tool/class groups. Showing the 50 most used; opaque code-mode wrappers stay separate from inner tools.`));
  const classes = node("details", undefined, "reliability-details"); classes.append(node("summary", "Compare normalized tool classes"), table("Tool classes", headers, toolRows(summary.classes, true))); container.append(classes);
  container.append(table("MCP servers", ["Server", "Calls", "Known / calls", "Error % · errors / attempts", "p95", "Timed / calls", "Connection failures"], summary.mcp.map((s) => [s.server, n(s.calls), coverage(s), errorCell(s), latency(s.latency.p95Ms), `${s.latency.samples}/${s.calls}`, n(s.connectionFailures)]), `${summary.mcp.length} servers seen in calls or failed-connection attachments. Connection failures are separate from call errors.`));

  const flagNames = { exact_repeat: "Exact repeats", repeated_failure: "Repeated failing calls", failed_edit_cascade: "Failed edit cascades", edit_thrash: "Edit thrash", reread_churn: "Re-read churn", search_loop: "Search loops" };
  const flags = node("article", undefined, "panel"); flags.append(node("h3", "Loop and churn signals"));
  flags.append(node("p", "Flags are prompts for inspection, not verdicts. Repetition can be intentional. Activity counters and passing checks do not prove success, quality, or value.", "chart-note"));
  const flagGrid = node("dl", undefined, "reliability-flags");
  for (const [key, title] of Object.entries(flagNames)) { const item = node("div"); item.append(node("dt", title), node("dd", summary.flagSessions ? n(summary.flags[key]) : "N/A")); flagGrid.append(item); }
  flags.append(flagGrid, node("p", `Episodes across ${summary.flagSessions} eligible sessions. Matching evidence: ${argumentCalls}/${totals.calls} calls with argument hashes; ${fileCalls}/${totals.calls} with file hashes (hashes stay inside the parser). First edit: ${verification.stepsToFirstEdit === null ? "N/A" : verification.stepsToFirstEdit.toFixed(1)} preceding calls on average across ${verification.firstEditSessions} main transcripts; mean observed time ${latency(verification.msToFirstEdit)} across ${verification.timedEditSessions} timed transcripts.`, "chart-note"));
  flags.append(node("p", "Verification requires a completed test/build that started after the final edit completed. Overlapping executions, missing starts/results, partial streams and active sessions can make status unavailable. A failed check still counts as an attempted verification.", "chart-note"));
  container.append(flags);

  const comparisonHeaders = ["Scope", "Covered / sessions", "Known / calls", "Error % · errors / attempts", "p95 · timed / calls", "Unverified / eligible"];
  function comparison(s) {
    return [s.name, `${s.coveredSessions}/${s.sessions}`, coverage(s.totals), errorCell(s.totals), `${latency(s.totals.latency.p95Ms)} · ${s.totals.latency.samples}/${s.totals.calls}`, `${s.verification.skippedSessions}/${s.verification.eligibleSessions}`];
  }
  container.append(table("By agent", comparisonHeaders, comparisons.providers.map(comparison), "Compare within the same repository and workload. Provider coverage and tool mix differ; these are not agent quality rankings."));
  const repositoryPanel = node("div");
  let shownRepositories = 50;
  function repositories() {
    repositoryPanel.replaceChildren();
    repositoryPanel.append(table("By repository", comparisonHeaders, comparisons.repositories.slice(0, shownRepositories).map(comparison), `Showing ${Math.min(shownRepositories, comparisons.repositories.length)} of ${comparisons.repositories.length} repositories.`));
    if (shownRepositories < comparisons.repositories.length) {
      const more = node("button", "Show more repositories");
      more.addEventListener("click", () => { shownRepositories += 50; repositories(); repositoryPanel.querySelector("button")?.focus(); });
      repositoryPanel.append(more);
    }
  }
  repositories(); container.append(repositoryPanel);
  const mixes = [
    ["Permission modes", summary.permissions.modes], ["Approval policies", summary.permissions.approvalPolicies], ["Sandbox modes", summary.permissions.sandboxes], ["API error events", summary.apiErrors],
  ].flatMap(([group, mix]) => Object.entries(mix).map(([key, count]) => [group, key, n(count)]));
  container.append(table("Hooks and permission friction", ["Evidence", "Mode / class", "Observations"], mixes,
    `${n(summary.hooks.runs)} hook runs · ${n(summary.hooks.blocks)} blocking summaries · p95 ${latency(summary.hooks.latency.p95Ms)} (${summary.hooks.latency.samples}/${summary.hooks.runs} timed). ${n(summary.permissions.denials)} denied calls. Mode counts describe recorded observations, not time or approval prompts. Interrupts rise with expert steering; permission approvals carry little signal.`));
}
