import { readDecisions, saveDecision } from "./insights-state.js";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const node = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
};
const amount = (impact) => impact.value === null ? "Not quantified" : impact.unit === "USD" ? currency.format(impact.value) : `${number.format(impact.value)} tokens`;
const pageSize = 10;
let requestNumber = 0, cached = null, hiddenVisible = false, memoryDecisions = null, persistenceMessage = "";
let visibleLimit = pageSize, selectionKey = null, ruleFilter = "";
const scopeStates = new Map();
const browserStorage = () => { try { return window.localStorage; } catch { return null; } };

function formatEvidence(item) {
  const value = item.unit === "USD" ? currency.format(item.value) : number.format(item.value);
  if (item.denominator !== null) {
    const share = item.unit === "ratio" && item.denominator > 0 ? `${number.format(item.value / item.denominator * 100)}% · ` : item.unit === "multiple" && item.denominator > 0 ? `${number.format(item.value / item.denominator)}× · ` : "";
    return `${share}${value} / ${number.format(item.denominator)} ${item.denominatorLabel}`;
  }
  return `${value}${item.unit === "tokens" ? " tokens" : item.unit === "hour" ? ":00" : ""}`;
}

function evidenceList(items) {
  const list = node("dl", undefined, "insight-evidence");
  for (const item of items) { const row = node("div"); row.append(node("dt", item.label), node("dd", formatEvidence(item))); list.append(row); }
  return list;
}

function decisionControls(id, label, level, decisions, change) {
  const controls = node("div", undefined, "insight-controls");
  const actions = decisions[id] ? [["restore", `Restore ${level}`]] : [["snooze", `Snooze ${level} 7 days`], ["dismiss", `Dismiss ${level}`]];
  for (const [action, text] of actions) {
    const button = node("button", text, "button"); button.type = "button";
    button.setAttribute("aria-label", `${text}: ${label}`);
    button.addEventListener("click", () => change(id, action)); controls.append(button);
  }
  if (typeof decisions[id] === "number") controls.append(node("span", `Snoozed until ${new Date(decisions[id]).toLocaleDateString()}`, "muted"));
  return controls;
}

function reviewCommand(item) {
  if (item.scope.kind !== "session" || !/^[a-f0-9]{12}$/.test(item.scope.sessionKey) || !["claude", "codex"].includes(item.scope.provider)) return null;
  const command = node("input", undefined, "insight-review-command");
  command.type = "text"; command.readOnly = true;
  command.value = `session-analytics review --session ${item.scope.sessionKey} --via ${item.scope.provider}`;
  command.setAttribute("aria-label", `Review dry-run command for session ${item.scope.sessionKey}`);
  command.addEventListener("focus", () => command.select());
  const label = node("label", "Review dry-run · select and copy", "insight-review-label"); label.append(command);
  return label;
}

function scopeTable(group, items, options, decisions, change) {
  const state = scopeStates.get(group.id) ?? { open: false, query: "", limit: pageSize, evidence: new Set() };
  scopeStates.set(group.id, state);
  const disclosure = node("details", undefined, "insight-scopes"); disclosure.open = state.open;
  const summary = node("summary", `Explore ${items.length} affected scopes and evidence`); disclosure.append(summary);
  let loaded = false;
  const repositoryName = (item) => options.repositories.find((r) => r.repository.id === item.scope.repositoryId)?.repository.name || item.scope.repositoryId || "Selected history";
  function load() {
    if (loaded) return;
    loaded = true;
    for (const text of group.guardrails) disclosure.append(node("p", text, "insight-guardrail"));
    const label = node("label", "Filter scopes by repository, session key, provider or model", "insight-filter-label");
    const search = node("input", undefined, "insight-scope-filter"); search.type = "search"; search.value = state.query;
    search.setAttribute("aria-label", `Filter affected scopes: ${group.title}`); label.append(search); disclosure.append(label);
    const content = node("div"); disclosure.append(content);
    const renderRows = () => {
      content.replaceChildren();
      const query = state.query.trim().toLowerCase();
      const matches = items.filter((item) => (hiddenVisible || !decisions[item.id]) && [repositoryName(item), item.scope.repositoryId, item.scope.sessionKey, item.scope.provider, ...item.names, ...(item.session?.models || []), ...(item.pricing?.transitions.flatMap((move) => [move.sourceModel, move.targetModel]) || [])].filter(Boolean).join(" ").toLowerCase().includes(query));
      const ranked = hiddenVisible ? [...matches.filter((item) => decisions[item.id]), ...matches.filter((item) => !decisions[item.id])] : matches;
      const status = node("p", `Showing ${Math.min(state.limit, ranked.length)} of ${ranked.length} matching scopes · ${items.length} total. Filtering and hiding rows do not change the summary or peer baselines.`, "insights-note"); status.setAttribute("role", "status"); content.append(status);
      if (!ranked.length) { content.append(node("p", "No matching visible scopes. Clear the filter or show dismissed / snoozed scopes.", "insights-note")); return; }
      const wrap = node("div", undefined, "insight-table-scroll"); wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", `Ranked scopes: ${group.title}`);
      const table = node("table", undefined, "insight-scope-table");
      table.append(node("caption", "Ranked by estimated impact within this rule"));
      const head = node("tr");
      for (const text of ["Scope", "Estimated impact", "Evidence", "Confidence and choices"]) { const cell = node("th", text); cell.scope = "col"; head.append(cell); }
      const thead = node("thead"); thead.append(head); table.append(thead);
      const body = node("tbody");
      for (const item of ranked.slice(0, state.limit)) {
        const row = node("tr"); row.dataset.insightId = item.id; row.tabIndex = -1;
        if (decisions[item.id]) row.classList.add("insight-muted");
        const scope = node("th"); scope.scope = "row";
        scope.append(node("strong", repositoryName(item)), node("p", [item.scope.provider, item.scope.sessionKey ? `Session ${item.scope.sessionKey}` : item.scope.kind].filter(Boolean).join(" · "), "insight-scope"));
        if (item.session) scope.append(node("p", `${item.session.startedAt || "Start unavailable"} · ${item.session.models.join(" · ") || "Model unavailable"}`, "insight-session-context"));
        if (item.scope.repositoryId && options.onSelectRepository && item.scope.repositoryId !== options.repositoryId) {
          const drill = node("button", "Filter to repository", "button"); drill.type = "button";
          drill.setAttribute("aria-label", `Filter to repository: ${repositoryName(item)}`);
          drill.addEventListener("click", () => options.onSelectRepository(item.scope.repositoryId)); scope.append(drill);
        }
        const value = node("td"); value.append(node("strong", amount(item.estimatedImpact)), node("p", item.estimatedImpact.label, "insight-impact-label"));
        const evidence = node("td");
        if (item.evidence[0]) evidence.append(node("p", `${item.evidence[0].label}: ${formatEvidence(item.evidence[0])}`));
        if (item.pricing) evidence.append(node("p", `${item.pricing.strategy}: ${item.pricing.transitions.map((move) => `${move.sourceModel} → ${move.targetModel}`).join("; ")}`, "insight-names"));
        const detail = node("details", undefined, "insight-details"); detail.open = state.evidence.has(item.id);
        detail.append(node("summary", "Full evidence and guardrails"), evidenceList(item.evidence), node("p", `${item.coverage.eligibleSessions} / ${item.coverage.totalSessions} selected sessions eligible (peers for session comparisons).`, "insight-coverage"));
        if (item.names.length && !item.pricing) detail.append(node("p", item.names.join(" · "), "insight-names"));
        detail.append(node("p", item.guardrail, "insight-guardrail"), node("p", item.suggestedAction));
        const command = reviewCommand(item); if (command) detail.append(command);
        detail.addEventListener("toggle", () => { if (detail.open) state.evidence.add(item.id); else state.evidence.delete(item.id); });
        evidence.append(detail);
        const choices = node("td"); choices.append(node("p", `${item.confidence} confidence`), decisionControls(item.id, [repositoryName(item), item.scope.sessionKey, item.scope.provider].filter(Boolean).join(" · "), "scope", decisions, change));
        row.append(scope, value, evidence, choices); body.append(row);
      }
      table.append(body); wrap.append(table); content.append(wrap);
      if (state.limit < ranked.length) {
        const more = node("button", `Show ${Math.min(pageSize, ranked.length - state.limit)} more scopes`, "button insights-load-more"); more.type = "button";
        more.addEventListener("click", () => { const next = ranked[state.limit].id; state.limit += pageSize; renderRows(); content.querySelector(`[data-insight-id="${next}"]`)?.focus(); }); content.append(more);
      }
    };
    search.addEventListener("input", () => { state.query = search.value; state.limit = pageSize; renderRows(); });
    renderRows();
  }
  disclosure.addEventListener("toggle", () => { state.open = disclosure.open; if (state.open) load(); });
  if (state.open) load();
  return disclosure;
}

function paint(root, report, options) {
  root.replaceChildren();
  const decisions = memoryDecisions ?? readDecisions(browserStorage());
  for (const [id, until] of Object.entries(decisions)) if (typeof until === "number" && until <= Date.now()) delete decisions[id];
  const byId = new Map(report.items.map((item) => [item.id, item]));
  const selected = report.groups.filter((group) => !ruleFilter || group.rule === ruleFilter);
  const hiddenGroup = (group) => decisions[group.ruleDecisionId] || group.itemIds.every((id) => decisions[id]);
  const hiddenRules = new Set(selected.filter((group) => decisions[group.ruleDecisionId]).map((group) => group.rule)).size;
  const hiddenScopes = report.items.filter((item) => (!ruleFilter || item.rule === ruleFilter) && decisions[item.id]).length;
  const visible = hiddenVisible ? [...selected.filter(hiddenGroup), ...selected.filter((group) => !hiddenGroup(group))] : selected.filter((group) => !hiddenGroup(group));
  const toolbar = node("div", undefined, "insights-toolbar");
  const status = node("p", `Showing ${Math.min(visibleLimit, visible.length)} of ${visible.length} distinct insights · ${hiddenRules} rules / ${hiddenScopes} scopes dismissed or snoozed`, "muted"); status.setAttribute("role", "status");
  const filterLabel = node("label", "Rule", "insight-filter-label");
  const filter = node("select"); filter.setAttribute("aria-label", "Filter insight rules");
  const all = node("option", "All rules"); all.value = ""; filter.append(all);
  for (const row of report.coverage) { const option = node("option", row.rule); option.value = row.rule; filter.append(option); }
  filter.value = ruleFilter;
  filter.addEventListener("change", () => { ruleFilter = filter.value; visibleLimit = pageSize; paint(root, report, options); root.querySelector("select")?.focus(); }); filterLabel.append(filter);
  const showHidden = node("button", hiddenVisible ? "Hide dismissed / snoozed" : "Show dismissed / snoozed", "button"); showHidden.type = "button"; showHidden.setAttribute("aria-pressed", String(hiddenVisible));
  showHidden.addEventListener("click", () => { hiddenVisible = !hiddenVisible; visibleLimit = pageSize; for (const state of scopeStates.values()) state.limit = pageSize; paint(root, report, options); root.querySelector(".insights-toolbar button")?.focus(); });
  toolbar.append(status, filterLabel, showHidden); root.append(toolbar);
  root.append(node("p", "One card per rule and scope level. Ranked by estimated USD, then token exposure, then unquantified signals. Rules can overlap; do not add their totals. Repository/date filters recompute evidence and peer baselines.", "insights-note"));
  if (persistenceMessage) { const note = node("p", persistenceMessage, "insights-note"); note.setAttribute("role", "status"); root.append(note); }
  if (!visible.length) root.append(node("p", hiddenRules || hiddenScopes ? "All matching insights are hidden. Show dismissed / snoozed to restore rules or scopes." : "No signals meet the thresholds in this selection. Check rule coverage below; this is not a verdict on quality or success.", "insights-empty"));
  const list = node("div", undefined, "insights-list");
  for (const group of visible.slice(0, visibleLimit)) {
    const article = node("article", undefined, "insight-card"); article.dataset.insightId = group.id; article.tabIndex = -1;
    if (decisions[group.ruleDecisionId]) article.classList.add("insight-muted");
    const title = node("h2", group.title); title.id = group.id; article.setAttribute("aria-labelledby", title.id);
    const heading = node("div", undefined, "insight-heading");
    const description = node("div"); description.append(node("p", `${report.groups.indexOf(group) + 1} · ${group.rule} · ${group.scopeKind} scopes`, "insight-scope"), title);
    heading.append(description, node("strong", amount(group.estimatedImpact), "insight-impact")); article.append(heading);
    article.append(node("p", group.estimatedImpact.label, "insight-impact-label"));
    const evidenceScope = group.rule.startsWith("unused-") ? "Evidence from" : "Affected";
    article.append(node("p", `${evidenceScope}: ${group.affected.repositories} / ${group.coverage.totalRepositories} repositories · ${group.affected.sessions} / ${group.coverage.totalSessions} selected sessions. ${group.confidence} confidence (lowest among scopes).`, "insight-counts"));
    article.append(node("p", `Rule evidence: ${group.coverage.eligibleSessions} / ${group.coverage.totalSessions} sessions eligible · ${group.impactCoverage.quantifiedItems} / ${group.impactCoverage.totalItems} scopes quantified. API-equivalent value is not an invoice.`, "insight-coverage"));
    const hidden = group.itemIds.filter((id) => decisions[id]).length;
    if (hidden) article.append(node("p", `${hidden} scopes dismissed or snoozed; this summary includes their evidence.`, "insights-note"));
    const change = (id, action) => {
      const result = saveDecision(browserStorage(), decisions, id, action); memoryDecisions = result.decisions;
      persistenceMessage = result.persisted ? "" : "Browser storage is unavailable; this choice lasts for the current page only.";
      paint(root, report, options);
      (root.querySelector(`[data-insight-id="${id}"] button`) || root.querySelector(`[data-insight-id="${group.id}"] summary`) || root.querySelector(".insights-toolbar button"))?.focus();
    };
    article.append(scopeTable(group, group.itemIds.map((id) => byId.get(id)), options, decisions, change));
    const action = node("p", group.suggestedAction, "insight-action"); article.append(action);
    article.append(decisionControls(group.ruleDecisionId, group.title, "rule", decisions, change)); list.append(article);
  }
  root.append(list);
  if (visibleLimit < visible.length) {
    const more = node("button", `Show ${Math.min(pageSize, visible.length - visibleLimit)} more insights`, "button insights-load-more"); more.type = "button";
    more.addEventListener("click", () => { const next = visible[visibleLimit].id; visibleLimit += pageSize; paint(root, report, options); root.querySelector(`[data-insight-id="${next}"]`)?.focus(); }); root.append(more);
  }
  const details = node("details", undefined, "insights-coverage"); details.append(node("summary", "Rule coverage and thresholds"));
  const table = node("table"), head = node("tr");
  for (const text of ["Rule", "Status", "Eligible / selected", "Groups / scopes"]) { const cell = node("th", text); cell.scope = "col"; head.append(cell); }
  const thead = node("thead"); thead.append(head); table.append(thead);
  const body = node("tbody");
  for (const row of report.coverage) { const tr = node("tr"); for (const text of [row.rule, row.status, `${row.eligibleSessions} / ${row.totalSessions}`, `${row.groups} / ${row.findings}`]) tr.append(node("td", text)); body.append(tr); }
  table.append(body); details.append(table);
  for (const row of report.evidenceCoverage || []) if (row.sessions) details.append(node("p", `${row.reason}: ${row.sessions} / ${row.totalSessions} selected sessions`));
  details.append(node("p", "Unavailable means required evidence is absent. Insufficient means the activity guard has not been met. Confidence describes the interpretation, not task quality."));
  details.append(evidenceList(Object.entries(report.thresholds).map(([label, value]) => ({ label, value, unit: "count", denominator: null })))); root.append(details);
  for (const warning of report.warnings) root.append(node("p", warning, "insights-note"));
  root.append(node("p", "Content review is separate and off by default. Session evidence includes copyable review dry-run commands. Only an explicit --send-content flag invokes your agent CLI; this page sends no transcript content.", "insights-note"));
}

export async function renderInsights(root, options) {
  const current = ++requestNumber;
  const query = new URLSearchParams();
  if (options.repositoryId) query.set("repo-id", options.repositoryId);
  if (options.from) query.set("from", options.from);
  if (options.through) query.set("through", options.through);
  const key = `${options.generatedAt}:${query}`;
  if (selectionKey !== key) { selectionKey = key; visibleLimit = pageSize; scopeStates.clear(); }
  if (cached?.key === key) { root.setAttribute("aria-busy", "false"); paint(root, cached.report, options); return; }
  root.setAttribute("aria-busy", "true"); root.replaceChildren(node("p", "Evaluating local evidence…", "insights-empty"));
  try {
    const response = await fetch(`/api/insights?${query}`);
    if (!response.ok) throw new Error("unavailable");
    const report = await response.json();
    if (current !== requestNumber) return;
    if (report.schemaVersion !== 2) throw new Error("unsupported report");
    cached = { key, report }; paint(root, report, options);
  } catch {
    if (current !== requestNumber) return;
    const error = node("p", "Insights could not be loaded. Check configuration and filters, then retry.", "insights-empty"); error.setAttribute("role", "alert");
    const retry = node("button", "Retry insights", "button"); retry.type = "button"; retry.addEventListener("click", () => void renderInsights(root, options)); root.replaceChildren(error, retry);
  } finally { if (current === requestNumber) root.setAttribute("aria-busy", "false"); }
}
