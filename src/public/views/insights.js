import { readDecisions, saveDecision } from "./insights-state.js";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const node = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
};
let requestNumber = 0;
let cached = null;
let hiddenVisible = false;
let memoryDecisions = null;
let persistenceMessage = "";
const browserStorage = () => { try { return window.localStorage; } catch { return null; } };

function formatEvidence(item) {
  const value = item.unit === "USD" ? currency.format(item.value) : number.format(item.value);
  if (item.denominator !== null) {
    const share = item.unit === "ratio" && item.denominator > 0 ? `${number.format(item.value / item.denominator * 100)}% · ` : item.unit === "multiple" && item.denominator > 0 ? `${number.format(item.value / item.denominator)}× · ` : "";
    return `${share}${value} / ${number.format(item.denominator)} ${item.denominatorLabel}`;
  }
  return `${value}${item.unit === "tokens" ? " tokens" : item.unit === "hour" ? ":00" : ""}`;
}

function paint(root, report, options) {
  root.replaceChildren();
  const stored = readDecisions(browserStorage());
  const decisions = memoryDecisions ?? stored;
  // Snoozes expire without requiring the browser to reload its stored data.
  for (const [id, until] of Object.entries(decisions)) if (typeof until === "number" && until <= Date.now()) delete decisions[id];
  const hiddenCount = report.cards.filter((card) => decisions[card.id]).length;
  const visible = report.cards.filter((card) => hiddenVisible || !decisions[card.id]);
  const toolbar = node("div", undefined, "insights-toolbar");
  const status = node("p", `${report.cards.length - hiddenCount} visible · ${hiddenCount} dismissed or snoozed · ${report.coverage[0]?.totalSessions ?? 0} selected sessions`, "muted");
  status.setAttribute("role", "status");
  const showHidden = node("button", hiddenVisible ? "Hide dismissed / snoozed" : "Show dismissed / snoozed", "button");
  showHidden.type = "button"; showHidden.setAttribute("aria-pressed", String(hiddenVisible));
  showHidden.addEventListener("click", () => { hiddenVisible = !hiddenVisible; paint(root, report, options); root.querySelector(".insights-toolbar button")?.focus(); });
  toolbar.append(status, showHidden); root.append(toolbar);
  root.append(node("p", "Sorted by estimated USD, then token exposure, then unquantified signals. Cards can overlap; do not add estimates together. Repository and date filters recompute the evidence and baselines.", "insights-note"));
  if (persistenceMessage) { const note = node("p", persistenceMessage, "insights-note"); note.setAttribute("role", "status"); root.append(note); }
  if (!visible.length) root.append(node("p", hiddenCount ? "All current cards are dismissed or snoozed. Use the button above to restore them." : "No signals meet the thresholds in this selection. Check rule coverage below; an empty view is not a verdict on quality or success.", "insights-empty"));
  const grid = node("div", undefined, "insights-grid");
  for (const card of visible) {
    const article = node("article", undefined, "insight-card"); article.dataset.insightId = card.id;
    if (decisions[card.id]) article.classList.add("insight-muted");
    const repository = options.repositories.find((item) => item.repository.id === card.scope.repositoryId)?.repository.name;
    const eyebrow = [repository || "Selected history", card.scope.provider, card.scope.sessionKey ? `Session ${card.scope.sessionKey}` : null].filter(Boolean).join(" · ");
    article.append(node("p", eyebrow, "insight-scope"));
    const title = node("h2", card.title); title.id = card.id; article.setAttribute("aria-labelledby", title.id); article.append(title);
    const amount = card.estimatedImpact.value === null ? "Not quantified" : card.estimatedImpact.unit === "USD" ? currency.format(card.estimatedImpact.value) : `${number.format(card.estimatedImpact.value)} tokens`;
    article.append(node("strong", amount, "insight-impact"), node("p", card.estimatedImpact.label, "insight-impact-label"));
    const evidence = node("dl", undefined, "insight-evidence");
    for (const item of card.evidence) { const row = node("div"); row.append(node("dt", item.label), node("dd", formatEvidence(item))); evidence.append(row); }
    article.append(evidence, node("p", `${card.confidence[0].toUpperCase()}${card.confidence.slice(1)} confidence · ${card.coverage.eligibleSessions} / ${card.coverage.totalSessions} selected sessions eligible`, "insight-coverage"));
    if (card.names.length) article.append(node("p", card.names.join(" · "), "insight-names"));
    article.append(node("p", card.guardrail, "insight-guardrail"));
    const action = node("div", undefined, "insight-action"); action.append(node("strong", "Suggested action"), node("p", card.suggestedAction)); article.append(action);
    const controls = node("div", undefined, "insight-controls");
    const actions = decisions[card.id] ? [["restore", "Restore"]] : [["snooze", "Snooze 7 days"], ["dismiss", "Dismiss"]];
    for (const [name, label] of actions) {
      const button = node("button", label, "button"); button.type = "button";
      button.setAttribute("aria-label", `${label}: ${card.title}`);
      button.addEventListener("click", () => {
        const result = saveDecision(browserStorage(), decisions, card.id, name);
        memoryDecisions = result.decisions;
        persistenceMessage = result.persisted ? "" : "Browser storage is unavailable; this choice lasts for the current page only.";
        paint(root, report, options);
        const focusTarget = root.querySelector(`[data-insight-id="${card.id}"] button`) || root.querySelector(".insights-toolbar button");
        focusTarget?.focus();
      }); controls.append(button);
    }
    if (typeof decisions[card.id] === "number") controls.append(node("span", `Snoozed until ${new Date(decisions[card.id]).toLocaleDateString()}`, "muted"));
    article.append(controls); grid.append(article);
  }
  root.append(grid);
  const details = node("details", undefined, "insights-coverage");
  details.append(node("summary", "Rule coverage and thresholds"));
  const table = node("table"); const head = node("tr");
  for (const text of ["Rule", "Status", "Eligible / selected", "Cards"]) { const th = node("th", text); th.scope = "col"; head.append(th); }
  const thead = node("thead"); thead.append(head); table.append(thead);
  const body = node("tbody");
  for (const row of report.coverage) { const tr = node("tr"); for (const text of [row.rule, row.status, `${row.eligibleSessions} / ${row.totalSessions}`, String(row.findings)]) tr.append(node("td", text)); body.append(tr); }
  table.append(body); details.append(table);
  details.append(node("p", "Unavailable means required evidence is absent. Insufficient means evidence exists but the activity guard has not been met. Confidence describes the interpretation, not task quality."));
  const thresholds = node("dl", undefined, "insight-evidence");
  for (const [name, value] of Object.entries(report.thresholds)) { const row = node("div"); row.append(node("dt", name), node("dd", number.format(value))); thresholds.append(row); }
  details.append(thresholds); root.append(details);
  for (const warning of report.warnings) root.append(node("p", warning, "insights-note"));
  root.append(node("p", "Content review is separate and off by default. The review command previews sizes and redactions; only an explicit --send-content flag invokes your agent CLI. Nothing on this page sends transcript content.", "insights-note"));
}

export async function renderInsights(root, options) {
  const current = ++requestNumber;
  const query = new URLSearchParams();
  if (options.repositoryId) query.set("repo-id", options.repositoryId);
  if (options.from) query.set("from", options.from);
  if (options.through) query.set("through", options.through);
  const key = `${options.generatedAt}:${query}`;
  if (cached?.key === key) { root.setAttribute("aria-busy", "false"); paint(root, cached.report, options); return; }
  root.setAttribute("aria-busy", "true"); root.replaceChildren(node("p", "Evaluating local evidence…", "insights-empty"));
  try {
    const response = await fetch(`/api/insights?${query}`);
    if (!response.ok) throw new Error("unavailable");
    const report = await response.json();
    if (current !== requestNumber) return;
    cached = { key, report }; paint(root, report, options);
  } catch {
    if (current !== requestNumber) return;
    const error = node("p", "Insights could not be loaded. Check configuration and filters, then retry.", "insights-empty"); error.setAttribute("role", "alert");
    const retry = node("button", "Retry insights", "button"); retry.type = "button"; retry.addEventListener("click", () => void renderInsights(root, options)); root.replaceChildren(error, retry);
  } finally { if (current === requestNumber) root.setAttribute("aria-busy", "false"); }
}
