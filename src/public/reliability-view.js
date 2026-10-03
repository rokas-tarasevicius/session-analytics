import { errorDenominator, errorRate, guardedShare, summarizeReliability, summarizeReliabilityComparisons } from "./reliability-data.js";
import { DASH, dataTable, el, evidence, kpi, note, selectField } from "./ui.js";

const n = (value) => value.toLocaleString("en");
const percent = (value) => value === null ? DASH : `${(value * 100).toFixed(1)}%`;
const latency = (value) => value === null ? DASH : value < 1000 ? `≈${n(value)} ms` : `≈${(value / 1000).toFixed(1)} s`;
const label = (value) => value.replaceAll("_", " ");
function tablePanel(title, headers, rows, caption, { kicker = null } = {}) {
  const panel = el("article", null, "panel reliability-table-panel");
  const heading = el("header"), block = el("div");
  if (kicker) block.append(el("p", kicker, "kicker"));
  block.append(el("h3", title)); heading.append(block); panel.append(heading);
  if (!rows.length) { panel.append(note("No evidence in the selected scope.", "empty-line")); if (caption) panel.append(evidence([caption])); return panel; }
  const wrap = el("div", null, "reliability-table-scroll"); wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", title);
  const table = dataTable(headers.map((header, index) => index === 0 ? { text: header, align: "left" } : header), rows, { rowHeader: true, caption: title });
  wrap.append(table); panel.append(wrap);
  if (caption) panel.append(evidence([caption]));
  return panel;
}
function errorCell(stats) {
  return `${percent(errorRate(stats))} · ${n(stats.outcomes.error + stats.outcomes.timeout)}/${n(errorDenominator(stats))}`;
}
function coverage(stats) { return `${n(stats.calls - stats.outcomes.unknown)}/${n(stats.calls)}`; }
function topErrors(stats) {
  return Object.entries(stats.errors).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key, count]) => `${label(key)} (${n(count)})`).join(" · ") || DASH;
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
  const header = el("header", null, "view-header");
  const title = el("div"); title.append(el("p", "Tool evidence", "kicker"));
  const h2 = el("h2", "Reliability"); h2.id = "reliability-title"; title.append(h2, el("p", "Where tool calls fail, slow down, or repeat. Every comparison keeps its coverage visible."));
  const { select, wrapper } = selectField("reliability-agent", "Agent", [["all", "All agents"], ["claude", "Claude"], ["codex", "Codex"], ["cursor", "Cursor"]], state.provider, (value) => { state.provider = value; renderReliability(container, scopedSessions); container.querySelector("select").focus(); });
  wrapper.className = "field reliability-provider";
  header.append(title, wrapper); container.append(header);
  const covered = summary.coveredSessions > 0;
  const metrics = el("div", null, "kpi-grid compact-metrics");
  metrics.append(
    kpi({ label: "Observed outcomes", value: covered ? coverage(totals) : null, reason: covered ? null : "No supported sessions in this scope", coverage: { eligible: summary.coveredSessions, selected: summary.sessions }, what: "tool reliability evidence", note: `${summary.coveredSessions}/${summary.sessions} sessions supported · ${n(totals.outcomes.unknown)} unknown results`, accent: true }),
    kpi({ label: "Tool error rate", value: errorRate(totals) === null ? null : percent(errorRate(totals)), reason: "Fewer than 5 eligible attempts", note: `${n(totals.outcomes.error + totals.outcomes.timeout)}/${n(errorDenominator(totals))} attempted calls · ${n(totals.outcomes.timeout)} timeouts` }),
    kpi({ label: "Verification share", value: verification.share === null ? null : percent(verification.share), reason: "No check or edit calls observed", note: `${n(verification.checks)}/${n(verification.checks + verification.editCalls)} check + edit calls · ${n(verification.passed)} checks passed` }),
    kpi({ label: "Unverified final edits", value: guardedShare(verification.skippedSessions, verification.eligibleSessions) === null ? null : percent(guardedShare(verification.skippedSessions, verification.eligibleSessions)), reason: "Fewer than 5 eligible edited sessions", note: `${verification.skippedSessions}/${verification.eligibleSessions} eligible edited sessions` }),
  );
  container.append(metrics);
  const notes = [
    `Local content rules (P2): ${summary.contentRuleSessions}/${summary.coveredSessions} sessions. Hash-based flags: ${summary.flagSessions}/${summary.coveredSessions}. ${summary.contentRuleSessions ? "Only class labels and counts leave the parser." : "Enable --reliability-content-rules at launch for command, error-text and behavior rules."}`,
    "Error rates exclude denied, interrupted and unknown calls. Rates need 5 eligible observations. Latencies use reported durations only; ≈ marks merged bucket upper bounds (up to 10% + 1 ms).",
    summary.truncatedSessions ? `${summary.truncatedSessions} sessions have incomplete parsing or hit size safeguards. Their behavior flags and verification status are unavailable.` : null,
    unmatchedResults ? `${n(unmatchedResults)} results have no matching call. Affected sessions cannot establish complete behavior or verification.` : null,
    !summary.coveredSessions ? "Reliability evidence is available for Claude and Codex. Cursor reliability is not yet supported; missing evidence is never counted as a successful call." : null,
  ];
  container.append(evidence(notes, { open: !summary.coveredSessions }));

  const toolRows = (rows, classMode = false) => rows.map((row) => [classMode ? label(row.toolClass) : { text: row.name, detail: label(row.toolClass) }, n(row.calls), coverage(row), errorCell(row), `${row.outcomes.denied} / ${row.outcomes.interrupted}`, topErrors(row), `${latency(row.latency.p50Ms)} / ${latency(row.latency.p95Ms)}`, `${row.latency.samples}/${row.calls}`]);
  const headers = ["Tool / class", "Calls", "Known / calls", "Error % · errors / attempts", "Denied / interrupted", "Top error classes", "p50 / p95", "Timed / calls"];
  container.append(tablePanel("Tool outcomes", headers, toolRows(summary.tools.slice(0, 50)), `${summary.tools.length} tool/class groups. Showing the 50 most used; opaque code-mode wrappers stay separate from inner tools.`, { kicker: "Per tool" }));
  const classes = el("details", null, "evidence reliability-details"); classes.append(el("summary", "Compare normalized tool classes"));
  const classBody = el("div", null, "evidence-body"); classBody.append(tablePanel("Tool classes", headers, toolRows(summary.classes, true), null)); classes.append(classBody); container.append(classes);
  container.append(tablePanel("MCP servers", ["Server", "Calls", "Known / calls", "Error % · errors / attempts", "p95", "Timed / calls", "Connection failures"], summary.mcp.map((s) => [s.server, n(s.calls), coverage(s), errorCell(s), latency(s.latency.p95Ms), `${s.latency.samples}/${s.calls}`, n(s.connectionFailures)]), `${summary.mcp.length} servers seen in calls or failed-connection attachments. Connection failures are separate from call errors.`, { kicker: "Integrations" }));

  const flagNames = { exact_repeat: "Exact repeats", repeated_failure: "Repeated failing calls", failed_edit_cascade: "Failed edit cascades", edit_thrash: "Edit thrash", reread_churn: "Re-read churn", search_loop: "Search loops" };
  const flags = el("article", null, "panel");
  const flagHeader = el("header"), flagBlock = el("div");
  flagBlock.append(el("p", "Behavior flags", "kicker"), el("h3", "Loop and churn signals")); flagHeader.append(flagBlock);
  flagHeader.append(el("span", "Prompts for inspection, not verdicts", "panel-meta")); flags.append(flagHeader);
  const flagGrid = el("dl", null, "reliability-flags");
  for (const [key, title] of Object.entries(flagNames)) { const item = el("div"); item.append(el("dt", title), el("dd", summary.flagSessions ? n(summary.flags[key]) : DASH)); flagGrid.append(item); }
  flags.append(flagGrid, evidence([
    "Flags are prompts for inspection, not verdicts. Repetition can be intentional. Activity counters and passing checks do not prove success, quality, or value.",
    `Episodes across ${summary.flagSessions} eligible sessions. Matching evidence: ${argumentCalls}/${totals.calls} calls with argument hashes; ${fileCalls}/${totals.calls} with file hashes (hashes stay inside the parser). First edit: ${verification.stepsToFirstEdit === null ? DASH : verification.stepsToFirstEdit.toFixed(1)} preceding calls on average across ${verification.firstEditSessions} main transcripts; mean observed time ${latency(verification.msToFirstEdit)} across ${verification.timedEditSessions} timed transcripts.`,
    "Verification requires a completed test/build that started after the final edit completed. Overlapping executions, missing starts/results, partial streams and active sessions can make status unavailable. A failed check still counts as an attempted verification.",
  ]));
  container.append(flags);

  const comparisonHeaders = ["Scope", "Covered / sessions", "Known / calls", "Error % · errors / attempts", "p95 · timed / calls", "Unverified / eligible"];
  function comparison(s) {
    return [s.name, `${s.coveredSessions}/${s.sessions}`, coverage(s.totals), errorCell(s.totals), `${latency(s.totals.latency.p95Ms)} · ${s.totals.latency.samples}/${s.totals.calls}`, `${s.verification.skippedSessions}/${s.verification.eligibleSessions}`];
  }
  container.append(tablePanel("By agent", comparisonHeaders, comparisons.providers.map(comparison), "Compare within the same repository and workload. Provider coverage and tool mix differ; these are not agent quality rankings.", { kicker: "Comparison" }));
  const repositoryPanel = el("div");
  let shownRepositories = 50;
  function repositories() {
    repositoryPanel.replaceChildren();
    repositoryPanel.append(tablePanel("By repository", comparisonHeaders, comparisons.repositories.slice(0, shownRepositories).map(comparison), `Showing ${Math.min(shownRepositories, comparisons.repositories.length)} of ${comparisons.repositories.length} repositories.`, { kicker: "Comparison" }));
    if (shownRepositories < comparisons.repositories.length) {
      const more = el("button", "Show more repositories", "button reliability-more"); more.type = "button";
      more.addEventListener("click", () => { shownRepositories += 50; repositories(); repositoryPanel.querySelector("button")?.focus(); });
      repositoryPanel.append(more);
    }
  }
  repositories(); container.append(repositoryPanel);
  const mixes = [
    ["Permission modes", summary.permissions.modes], ["Approval policies", summary.permissions.approvalPolicies], ["Sandbox modes", summary.permissions.sandboxes], ["API error events", summary.apiErrors],
  ].flatMap(([group, mix]) => Object.entries(mix).map(([key, count]) => [group, key, n(count)]));
  container.append(tablePanel("Hooks and permission friction", ["Evidence", "Mode / class", "Observations"], mixes,
    `${n(summary.hooks.runs)} hook runs · ${n(summary.hooks.blocks)} blocking summaries · p95 ${latency(summary.hooks.latency.p95Ms)} (${summary.hooks.latency.samples}/${summary.hooks.runs} timed). ${n(summary.permissions.denials)} denied calls. Mode counts describe recorded observations, not time or approval prompts. Interrupts rise with expert steering; permission approvals carry little signal.`, { kicker: "Friction" }));
}
