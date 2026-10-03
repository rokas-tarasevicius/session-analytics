const $ = (selector) => document.querySelector(selector);
const elements = {
  activityHeatmap: $("#activity-heatmap"), activityRepositories: $("#activity-repositories"),
  activityTooltip: $("#activity-tooltip"), announcer: $("#chart-announcer"),
  cache: $("#metric-cache"), compactions: $("#metric-compactions"), dailySpend: $("#daily-spend"), dailyLegend: $("#daily-legend"),
  commandButton: $("#command-button"), commandInput: $("#command-input"), commandList: $("#command-list"),
  costApiTotal: $("#cost-api-total"), costCoverage: $("#cost-coverage"),
  costProviderTotal: $("#cost-provider-total"), costUpperTotal: $("#cost-upper-total"),
  dateRange: $("#date-range"), density: $("#density-switch"),
  distributionCompactions: $("#distribution-compactions"), distributionCost: $("#distribution-cost"),
  distributionDuration: $("#distribution-duration"), distributionKey: $("#distribution-key"),
  distributionRepositoryOptions: $("#distribution-repository-options"), distributionTools: $("#distribution-tools"),
  error: $("#error-banner"),
  generated: $("#generated-at"), help: $("#help-overlay"), helpButton: $("#help-button"), helpClose: $("#help-close"),
  input: $("#metric-input"), live: $("#metric-live"), main: $("#main"),
  modelSpend: $("#model-spend"), output: $("#metric-output"),
  modelsByProvider: $("#models-by-provider"), modelMetricSwitch: $("#model-metric-switch"),
  pageTitle: $("#page-title"), palette: $("#command-palette"),
  providerCostComponents: $("#provider-cost-components"),
  providerDonut: $("#provider-donut"), providerLegend: $("#provider-legend"),
  rateCardDate: $("#rate-card-date"), rateCardLinks: $("#rate-card-links"), refresh: $("#refresh-button"),
  repositories: $("#metric-repositories"), repositorySubagentSpend: $("#repository-subagent-spend"),
  repositoryCostComponents: $("#repository-cost-components"),
  repositoryFilter: $("#repository-filter"), repositoryList: $("#repository-list"), repositoryNote: $("#metric-repository-note"),
  repositoryNavCount: $("#repo-nav-count"),
  repositoryRows: $("#repository-rows"), repositorySpend: $("#repository-spend"),
  repositoryTokens: $("#repository-tokens"), scope: $("#scope-description"),
  scopeChip: $("#scope-chip"), scopeChipLabel: $("#scope-chip-label"),
  sessionNote: $("#metric-session-note"), sessions: $("#metric-sessions"),
  spend: $("#metric-spend"), spendNote: $("#metric-spend-note"),
  skillsByRepository: $("#skills-by-repository"), skillsDetail: $("#skills-detail"),
  skillsDetailTitle: $("#skills-detail-title"), skillsKey: $("#skills-key"),
  sync: $("#sync-context"), syncLabel: $("#sync-label"),
  theme: $("#theme-switch"), themeLabel: $("#theme-label"), toolCalls: $("#tool-calls"),
  toolsByRepository: $("#tools-by-repository"), toolsDetail: $("#tools-detail"),
  toolsDetailTitle: $("#tools-detail-title"), toolsKey: $("#tools-key"),
  tools: $("#metric-tools"), version: $("#snapshot-version"), warning: $("#warning-banner"), warningList: $("#warning-list"),
  windowEnd: $("#window-end"), windowSegment: $("#window-segment"), windowStart: $("#window-start"),
};
const providerFilters = [...document.querySelectorAll("[data-provider-filter]")];
const viewButtons = [...document.querySelectorAll("[data-view-button]")];
const viewPanels = [...document.querySelectorAll("[data-view-panel]")];
const windowButtons = [...elements.windowSegment.querySelectorAll("[data-window-preset]")];
const sortButtons = [...document.querySelectorAll("th .sort[data-sort]")];

const viewOrder = ["summary", "distributions", "activity", "costs", "models", "tools", "skills"];
const viewLabels = { activity: "Activity", costs: "Costs", distributions: "Distributions", models: "Models", skills: "Skills", summary: "Summary", tools: "Tools" };
const viewChords = { a: "activity", c: "costs", d: "distributions", k: "skills", m: "models", s: "summary", t: "tools" };
const providerLabels = { claude: "Claude", codex: "Codex", cursor: "Cursor" };
const providerOrder = ["codex", "claude", "cursor"];
const windowPresets = ["7", "30", "90", "all", "custom"];
const windowLabels = { 7: "Last 7 days", 30: "Last 30 days", 90: "Last 90 days", all: "All observed time", custom: "Custom range" };
const seriesSlots = 6;

let snapshot = null;
let modelMetric = "value";
let toolsDetailRepositoryId = null;
let skillsDetailRepositoryId = null;
let windowPreset = "all";
let tableSort = { direction: "descending", key: "value" };
const distributionRepositories = new Set();
const hoverListeners = new Set();
const compact = new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" });
const integer = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const currency = new Intl.NumberFormat("en-US", { currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2, style: "currency" });
const money = (value) => currency.format(value || 0);
const percent = (value) => value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function shortMoney(value) {
  const amount = value || 0;
  if (amount >= 1000) return `$${compact.format(amount)}`;
  if (amount >= 100) return `$${amount.toFixed(0)}`;
  return `$${amount.toFixed(amount >= 10 ? 1 : 2).replace(/\.0$/, "")}`;
}

function duration(milliseconds) {
  if (!milliseconds) return "—";
  const hours = milliseconds / 3_600_000;
  if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.max(1, Math.round(milliseconds / 60_000))}m`;
}

function dateTime(value) {
  if (!value) return "Unknown time";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

const shortDate = (day) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(`${day}T00:00:00`));

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined && value !== null) element.textContent = value;
  if (className) element.className = className;
  return element;
}

function svgNode(tag, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function icon(name, className) {
  const svg = svgNode("svg", { "aria-hidden": "true" });
  if (className) svg.setAttribute("class", className);
  const use = svgNode("use"); use.setAttribute("href", `#i-${name}`); svg.append(use);
  return svg;
}

function clear(element) { element.replaceChildren(); }

function emptyState(container, message, title = null) {
  const box = node("div", null, "empty-state");
  box.append(icon("distributions"));
  if (title) box.append(node("strong", title));
  box.append(node("span", message));
  container.append(box);
}

function selectedRepository() {
  const id = elements.repositoryFilter.value;
  return id === "all" ? null : snapshot.repositories.find(({ repository }) => repository.id === id) || null;
}

const tokenFields = ["cacheWrite1hInputTokens", "cacheWrite5mInputTokens", "cacheWriteInputTokens", "cachedInputTokens", "inputTokens", "nonReasoningOutputTokens", "outputTokens", "reasoningOutputTokens", "uncachedInputTokens"];
const costFields = ["cacheWriteUsd", "cachedInputUsd", "inputUsd", "outputUsd", "totalUsd", "upperEstimateUsd"];

function selectedWindow() {
  return {
    start: elements.windowStart.value ? `${elements.windowStart.value}T00:00:00.000Z` : null,
    end: elements.windowEnd.value ? `${elements.windowEnd.value}T23:59:59.999Z` : null,
  };
}

function sessionsInRange(sessions, startDay, endDay) {
  const start = startDay ? `${startDay}T00:00:00.000Z` : null, end = endDay ? `${endDay}T23:59:59.999Z` : null;
  return sessions.filter(({ createdAt }) => (!start || createdAt >= start) && (!end || createdAt <= end));
}

function sessionsInWindow(sessions) {
  const { start, end } = selectedWindow();
  return sessions.filter(({ createdAt }) => (!start || createdAt >= start) && (!end || createdAt <= end));
}

function summarize(sessions) {
  const totals = { inputTokens: 0, outputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
  let pricedTokens = 0, observedTokens = 0;
  const summary = { analyzedSessions: 0, apiEquivalentSpendUsd: 0, cacheReadRatio: null, compactions: 0, estimatedSpendUsd: 0, estimatedUpperSpendUsd: 0, missingTranscripts: 0, outputTokens: 0, pricedTokenCoverage: null, providerReportedSpendUsd: 0, sessions: sessions.length, subagentSessions: 0, subagentSpendUsd: 0, toolCalls: 0, topLevelSessions: 0, topLevelSpendUsd: 0, totalInputTokens: 0, unpricedSessions: 0 };
  for (const session of sessions) {
    summary.analyzedSessions += session.transcript.status === "ok" ? 1 : 0;
    summary.missingTranscripts += session.transcript.status === "missing" ? 1 : 0;
    summary.compactions += session.metrics.compactions; summary.toolCalls += session.metrics.toolCalls;
    summary.estimatedSpendUsd += session.cost.totalUsd; summary.estimatedUpperSpendUsd += session.cost.upperEstimateUsd;
    summary.apiEquivalentSpendUsd += session.costBasis === "api-list-price-equivalent" ? session.cost.totalUsd : 0;
    summary.providerReportedSpendUsd += session.costBasis === "provider-reported" ? session.cost.totalUsd : 0;
    summary.subagentSessions += session.executionKind === "subagent" || session.executionKind === "mixed" ? 1 : 0;
    summary.topLevelSessions += session.executionKind === "top-level" || session.executionKind === "mixed" ? 1 : 0;
    summary.subagentSpendUsd += session.costByExecution?.subagentUsd || 0;
    summary.topLevelSpendUsd += session.costByExecution?.topLevelUsd || 0;
    summary.totalInputTokens += session.tokens.inputTokens; summary.outputTokens += session.tokens.outputTokens;
    summary.unpricedSessions += session.costComplete ? 0 : 1;
    for (const key of Object.keys(totals)) totals[key] += session.tokens[key] || 0;
    const count = session.tokens.inputTokens + session.tokens.outputTokens;
    if (session.pricedTokenCoverage !== null) {
      observedTokens += count; pricedTokens += count * session.pricedTokenCoverage;
    }
  }
  const cacheDenominator = totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheWriteInputTokens;
  summary.cacheReadRatio = cacheDenominator ? totals.cachedInputTokens / cacheDenominator : null;
  summary.pricedTokenCoverage = observedTokens ? pricedTokens / observedTokens : null;
  return summary;
}

function mergeModels(sessions) {
  const models = new Map();
  for (const session of sessions) for (const source of session.models) {
    const key = `${session.provider}:${source.model}`;
    const target = models.get(key) || { model: source.model, provider: session.provider, calls: 0, priced: true };
    for (const key of [...tokenFields, ...costFields, "calls"]) target[key] = (target[key] || 0) + (source[key] || 0);
    target.priced = target.priced && source.priced; models.set(key, target);
  }
  return [...models.values()].sort((left, right) => right.totalUsd - left.totalUsd);
}

function namedTotals(sessions, field) {
  const totals = new Map();
  for (const session of sessions) for (const [name, value] of Object.entries(session[field])) totals.set(name, (totals.get(name) || 0) + value);
  return [...totals].map(([name, value]) => ({ name, value })).sort((left, right) => right.value - left.value);
}

function spendDays(sessions) { return namedTotals(sessions, "spendByDay").sort((left, right) => left.name.localeCompare(right.name)); }

function coverageWarnings(sessions) {
  const missing = sessions.filter(({ transcript }) => transcript.status === "missing");
  const legacy = missing.filter(({ transcript }) => transcript.warnings.includes("Conductor has no provider session ID.")).length;
  const unmatched = missing.length - legacy, unpriced = sessions.filter(({ costComplete }) => !costComplete).length;
  const warnings = [];
  if (legacy) warnings.push(`${legacy} legacy session${legacy === 1 ? "" : "s"} cannot be correlated because Conductor recorded no provider session ID.`);
  if (unmatched) warnings.push(`${unmatched} session${unmatched === 1 ? "" : "s"} have a provider ID but no validated local transcript.`);
  if (unpriced) warnings.push(`${unpriced} session${unpriced === 1 ? "" : "s"} include models without a rate card.`);
  return warnings;
}

function repositoryAggregate(item, sessions) {
  return { repository: item.repository, spendByDay: spendDays(sessions), spendByModel: mergeModels(sessions), summary: summarize(sessions), topTools: namedTotals(sessions, "tools"), warnings: coverageWarnings(sessions) };
}

function activeProviders() {
  return providerFilters.filter(({ checked }) => checked).map(({ dataset }) => dataset.providerFilter);
}

function sessionsForProviders(sessions) {
  const selected = new Set(activeProviders());
  return sessions.filter(({ provider }) => selected.has(provider));
}

function activeView() {
  const selected = selectedRepository();
  const repositorySessions = selected ? snapshot.sessions.filter(({ repositoryId }) => repositoryId === selected.repository.id) : snapshot.sessions;
  const scopeSessions = sessionsForProviders(repositorySessions);
  const windowSessions = sessionsInWindow(scopeSessions);
  const sourceRepositories = selected ? [selected] : snapshot.repositories;
  const repositories = sourceRepositories.map((item) => repositoryAggregate(item, windowSessions.filter(({ repositoryId }) => repositoryId === item.repository.id)));
  const sessions = windowSessions;
  const summary = summarize(sessions);
  return {
    dailySessions: scopeSessions, repositories, scopeSessions, sessions, spendByDay: spendDays(sessions), spendByModel: mergeModels(sessions), topTools: namedTotals(sessions, "tools"), warnings: coverageWarnings(sessions),
    summary: { ...summary, repositories: repositories.length, repositoriesWithSessions: repositories.filter(({ summary: item }) => item.sessions > 0).length, workingSnapshots: sessions.filter(({ transcript }) => transcript.snapshotWhileWorking).length },
  };
}

function selectRepository(id, { scroll = true } = {}) {
  elements.repositoryFilter.value = id;
  renderView();
  if (scroll) elements.main.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

function windowDays() {
  const days = [];
  if (!elements.windowStart.value || !elements.windowEnd.value) return days;
  const first = new Date(`${elements.windowStart.value}T00:00:00Z`), last = new Date(`${elements.windowEnd.value}T00:00:00Z`);
  for (let day = first, count = 0; day <= last && count < 3660; day = new Date(day.valueOf() + 86_400_000), count += 1) days.push(day.toISOString().slice(0, 10));
  return days;
}

function dailySpendSeries(sessions, days) {
  const index = new Map(days.map((day, position) => [day, position]));
  const values = days.map(() => 0);
  for (const session of sessions) for (const [day, value] of Object.entries(session.spendByDay)) {
    const position = index.get(day);
    if (position !== undefined) values[position] += value;
  }
  return values;
}

function dailyCountSeries(sessions, days, accessor) {
  const index = new Map(days.map((day, position) => [day, position]));
  const values = days.map(() => 0);
  for (const session of sessions) {
    const position = index.get(session.createdAt.slice(0, 10));
    if (position !== undefined) values[position] += accessor(session);
  }
  return values;
}

// --------------------------------------------------------------------- bars

function renderBars(container, items, formatter, limit = 9, onSelect = null) {
  clear(container);
  const visible = items.slice(0, limit);
  const maximum = Math.max(1, ...visible.map(({ value }) => value));
  if (!visible.length) { emptyState(container, "No activity in this view."); return; }
  for (const item of visible) {
    const row = node(onSelect ? "button" : "div", null, `bar-row${onSelect ? " repository-link" : ""}`);
    if (onSelect) {
      row.type = "button";
      row.setAttribute("aria-label", `Open metrics for ${item.name}`);
      row.addEventListener("click", () => onSelect(item));
    }
    const label = node("div", null, "bar-label");
    label.append(node("span", item.name), node("strong", formatter(item.value)));
    const track = node("div", null, "bar-track");
    const fill = node("i");
    if (item.provider) fill.dataset.provider = item.provider;
    fill.style.width = `${Math.max(1.5, (item.value / maximum) * 100)}%`;
    track.append(fill); row.append(label, track); container.append(row);
  }
}

// --------------------------------------------------------------------- sparklines & hover sync

function syncHover(day) {
  for (const listener of hoverListeners) listener(day);
}

function renderSparkline(svg, values, days, { width = 84, height = 30 } = {}) {
  clear(svg);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const maximum = Math.max(0.000001, ...values);
  const count = values.length;
  if (count === 0) return;
  const points = values.map((value, index) => ({
    x: count === 1 ? width / 2 : (index / (count - 1)) * width,
    y: height - 2 - (value / maximum) * (height - 5),
  }));
  const line = points.map(({ x, y }, index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  svg.append(svgNode("path", { class: "area", d: `${line} L${points.at(-1).x.toFixed(1)},${height} L${points[0].x.toFixed(1)},${height} Z` }));
  svg.append(svgNode("path", { class: "line", d: line }));
  const last = points.at(-1);
  svg.append(svgNode("circle", { cx: last.x.toFixed(1), cy: last.y.toFixed(1), r: 2 }));
  const marker = svgNode("line", { class: "sync", y1: 0, y2: height, x1: 0, x2: 0 }); marker.style.display = "none";
  const dot = svgNode("circle", { class: "sync", r: 2.5, cx: 0, cy: 0 }); dot.style.display = "none";
  svg.append(marker, dot);
  hoverListeners.add((day) => {
    const index = day === null ? -1 : days.indexOf(day);
    const visible = index >= 0 && points[index];
    marker.style.display = visible ? "" : "none"; dot.style.display = visible ? "" : "none";
    if (!visible) return;
    marker.setAttribute("x1", points[index].x.toFixed(1)); marker.setAttribute("x2", points[index].x.toFixed(1));
    dot.setAttribute("cx", points[index].x.toFixed(1)); dot.setAttribute("cy", points[index].y.toFixed(1));
  });
}

// --------------------------------------------------------------------- crosshair + tooltip

function attachCrosshair(container, svg, { xs, plotTop, plotBottom, plotLeft, plotRight, title, rows, onIndex = null, label }) {
  const viewBox = svg.viewBox.baseVal;
  const crosshair = svgNode("line", { class: "crosshair", y1: plotTop, y2: plotBottom, x1: 0, x2: 0 });
  crosshair.style.display = "none";
  const hit = svgNode("rect", { class: "hit-layer", x: plotLeft, y: plotTop - 6, width: plotRight - plotLeft, height: plotBottom - plotTop + 12 });
  svg.append(crosshair, hit);
  const tooltip = node("div", null, "chart-tooltip"); tooltip.hidden = true;
  container.append(tooltip);
  svg.tabIndex = 0;
  svg.setAttribute("aria-label", `${label}. Use the arrow keys to read each point.`);
  let current = null;
  const show = (index) => {
    if (index === null || index === undefined || !xs[index] && xs[index] !== 0) return hide();
    current = index;
    crosshair.style.display = ""; crosshair.setAttribute("x1", xs[index]); crosshair.setAttribute("x2", xs[index]);
    clear(tooltip); tooltip.hidden = false;
    tooltip.append(node("div", title(index), "tip-title"));
    for (const row of rows(index)) {
      const line = node("div", null, `tip-row${row.dim ? " dim" : ""}`);
      const key = node("i"); key.style.setProperty("--key-color", row.color);
      line.append(key, node("span", row.label), node("strong", row.value)); tooltip.append(line);
    }
    const rect = container.getBoundingClientRect();
    const x = (xs[index] / viewBox.width) * rect.width;
    const half = tooltip.offsetWidth / 2 + 4;
    tooltip.style.left = `${Math.min(rect.width - half, Math.max(half, x))}px`;
    tooltip.style.top = "0px";
    if (onIndex) onIndex(index);
    elements.announcer.textContent = `${title(index)}: ${rows(index).map((row) => `${row.label} ${row.value}`).join(", ")}`;
  };
  const hide = () => {
    current = null; crosshair.style.display = "none"; tooltip.hidden = true;
    if (onIndex) onIndex(null);
  };
  const nearest = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * viewBox.width;
    let best = 0;
    for (let index = 1; index < xs.length; index += 1) if (Math.abs(xs[index] - x) < Math.abs(xs[best] - x)) best = index;
    return best;
  };
  hit.addEventListener("pointermove", (event) => show(nearest(event.clientX)));
  hit.addEventListener("pointerleave", hide);
  svg.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (event.key === "Escape") { hide(); return; }
    if (event.key === "Home") { event.preventDefault(); show(0); return; }
    if (event.key === "End") { event.preventDefault(); show(xs.length - 1); return; }
    if (!step) return;
    event.preventDefault();
    show(Math.min(xs.length - 1, Math.max(0, (current ?? (step > 0 ? -1 : xs.length)) + step)));
  });
  svg.addEventListener("blur", hide);
}

// --------------------------------------------------------------------- views

function switchView(name) {
  for (const button of viewButtons) {
    if (button.dataset.viewButton === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const panel of viewPanels) panel.hidden = panel.dataset.viewPanel !== name;
  elements.pageTitle.textContent = viewLabels[name] || "Summary";
  document.title = `${viewLabels[name] || "Summary"} · Session Analytics`;
  localStorage.setItem("session-analytics-view", name);
  if (snapshot) renderView();
}

function currentViewName() {
  return viewButtons.find((button) => button.getAttribute("aria-current") === "page")?.dataset.viewButton || "summary";
}

function stepView(offset) {
  const index = viewOrder.indexOf(currentViewName());
  switchView(viewOrder[(index + offset + viewOrder.length) % viewOrder.length]);
}

function seriesColor(index) { return `var(--series-${(index % seriesSlots) + 1})`; }

function repositoryColor(id) {
  const selectedIndex = [...distributionRepositories].indexOf(id);
  const index = selectedIndex >= 0
    ? selectedIndex
    : Math.max(0, snapshot.repositories.findIndex(({ repository }) => repository.id === id));
  return seriesColor(index);
}

function ensureDistributionRepositories() {
  if (distributionRepositories.size > 0) return;
  const selected = selectedRepository();
  if (selected) distributionRepositories.add(selected.repository.id);
  const counts = snapshot.repositories.map((item) => ({
    id: item.repository.id,
    sessions: snapshot.sessions.filter(({ repositoryId }) => repositoryId === item.repository.id).length,
  })).sort((left, right) => right.sessions - left.sessions);
  for (const { id, sessions } of counts) {
    if (sessions > 0 && distributionRepositories.size < 3) distributionRepositories.add(id);
  }
}

function renderDistributionRepositoryOptions() {
  ensureDistributionRepositories(); clear(elements.distributionRepositoryOptions);
  const sessionCounts = new Map();
  for (const { repositoryId } of snapshot.sessions) sessionCounts.set(repositoryId, (sessionCounts.get(repositoryId) || 0) + 1);
  const repositories = snapshot.repositories.filter(({ repository }) => sessionCounts.has(repository.id)).sort((left, right) => {
    const selectedOrder = Number(distributionRepositories.has(right.repository.id)) - Number(distributionRepositories.has(left.repository.id));
    if (selectedOrder !== 0) return selectedOrder;
    const activityOrder = (sessionCounts.get(right.repository.id) || 0) - (sessionCounts.get(left.repository.id) || 0);
    return activityOrder || left.repository.name.localeCompare(right.repository.name);
  });
  for (const { repository } of repositories) {
    const label = node("label", null, "compare-option");
    label.style.setProperty("--series-color", repositoryColor(repository.id));
    const input = node("input"); input.type = "checkbox"; input.checked = distributionRepositories.has(repository.id);
    input.disabled = !input.checked && distributionRepositories.size >= seriesSlots;
    input.addEventListener("change", () => {
      if (input.checked) distributionRepositories.add(repository.id);
      else distributionRepositories.delete(repository.id);
      renderDistributions();
    });
    label.append(input, document.createTextNode(`${repository.name} · ${integer.format(sessionCounts.get(repository.id) || 0)}`)); elements.distributionRepositoryOptions.append(label);
  }
}

function addSvgText(svg, value, x, y, anchor = "start") {
  const label = svgNode("text", { x, y, class: "axis-label", "text-anchor": anchor });
  label.textContent = value; svg.append(label);
}

function renderDistributionChart(container, series, accessor, formatter, logarithmic = false, label = "distribution") {
  clear(container);
  const valuesBySeries = series.map((item) => ({
    ...item,
    values: item.sessions.map(accessor).filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0),
  }));
  const allValues = valuesBySeries.flatMap(({ values }) => values);
  if (allValues.length === 0) { emptyState(container, "No eligible sessions in this comparison."); return; }
  const bins = 10, maximum = Math.max(1, ...allValues), width = 680, height = 230;
  const left = 42, right = 14, top = 14, bottom = 32, plotWidth = width - left - right, plotHeight = height - top - bottom;
  const position = logarithmic ? (value) => Math.log1p(value) : (value) => value;
  const valueAtPosition = logarithmic ? (value) => Math.expm1(value) : (value) => value;
  const maximumPosition = Math.max(1, position(maximum));
  const distributions = valuesBySeries.map((item) => {
    const counts = Array.from({ length: bins }, () => 0);
    for (const value of item.values) counts[Math.min(bins - 1, Math.floor((position(value) / maximumPosition) * bins))] += 1;
    return { ...item, shares: counts.map((count) => item.values.length ? count / item.values.length : 0) };
  });
  const yMaximum = Math.max(.01, ...distributions.flatMap(({ shares }) => shares));
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  for (let index = 0; index < 3; index += 1) {
    const y = top + (index / 2) * plotHeight;
    svg.append(svgNode("line", { x1: left, x2: width - right, y1: y, y2: y, class: "distribution-grid" }));
    addSvgText(svg, `${Math.round(yMaximum * (1 - index / 2) * 100)}%`, left - 8, y + 4, "end");
  }
  svg.append(svgNode("line", { x1: left, x2: width - right, y1: top + plotHeight, y2: top + plotHeight, class: "distribution-axis" }));
  for (const index of [0, Math.floor((bins - 1) / 2), bins - 1]) {
    const x = left + (index / (bins - 1)) * plotWidth;
    addSvgText(svg, formatter(valueAtPosition((index / (bins - 1)) * maximumPosition)), x, height - 8, index === 0 ? "start" : index === bins - 1 ? "end" : "middle");
  }
  const xs = Array.from({ length: bins }, (_, index) => left + (index / (bins - 1)) * plotWidth);
  const seriesPoints = distributions.map((item) => ({ item, color: repositoryColor(item.id), points: item.shares.map((share, index) => ({ x: xs[index], y: top + (1 - share / yMaximum) * plotHeight })) }));
  for (const { color, points } of seriesPoints) {
    const polyline = svgNode("polyline", { points: points.map(({ x, y }) => `${x},${y}`).join(" "), class: "distribution-line" });
    polyline.style.setProperty("--series-color", color); svg.append(polyline);
  }
  for (const { color, points } of seriesPoints) for (const point of points) {
    const dot = svgNode("circle", { cx: point.x, cy: point.y, r: 3.5, class: "distribution-dot" });
    dot.style.setProperty("--series-color", color); svg.append(dot);
  }
  container.append(svg);
  attachCrosshair(container, svg, {
    xs, plotTop: top, plotBottom: top + plotHeight, plotLeft: left, plotRight: width - right, label: `Normalized repository ${label} distribution`,
    title: (index) => `${formatter(valueAtPosition((index / bins) * maximumPosition))} – ${formatter(valueAtPosition(((index + 1) / bins) * maximumPosition))}`,
    rows: (index) => seriesPoints.map(({ item, color }) => ({ label: item.name, color, value: `${(item.shares[index] * 100).toFixed(1)}%` })),
  });
}

function renderDistributions() {
  renderDistributionRepositoryOptions(); clear(elements.distributionKey);
  const windowSessions = sessionsInWindow(sessionsForProviders(snapshot.sessions));
  const series = snapshot.repositories.filter(({ repository }) => distributionRepositories.has(repository.id)).map(({ repository }) => ({
    id: repository.id,
    name: repository.name,
    sessions: windowSessions.filter(({ repositoryId }) => repositoryId === repository.id),
  }));
  for (const item of series) {
    const key = node("span"); const swatch = node("i"); swatch.style.setProperty("--series-color", repositoryColor(item.id));
    key.append(swatch, document.createTextNode(`${item.name} · ${item.sessions.length}`)); elements.distributionKey.append(key);
  }
  renderDistributionChart(elements.distributionDuration, series, ({ metrics }) => metrics.durationMilliseconds / 60_000, (value) => `${Math.round(value)}m`, true, "duration");
  renderDistributionChart(elements.distributionCost, series, (session) => session.costBasis === "api-list-price-equivalent" ? session.cost.totalUsd : null, (value) => money(value), true, "usage value");
  renderDistributionChart(elements.distributionTools, series, ({ metrics }) => metrics.toolCalls, (value) => integer.format(value), true, "tool call");
  renderDistributionChart(elements.distributionCompactions, series, ({ metrics }) => metrics.compactions, (value) => integer.format(value), false, "compaction");
}

function renderActivity(view) {
  elements.activityTooltip.hidden = true;
  const sessions = view.sessions;
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const session of sessions) {
    const date = new Date(session.createdAt); if (Number.isNaN(date.valueOf())) continue;
    grid[(date.getDay() + 6) % 7][date.getHours()] += 1;
  }
  const maximum = Math.max(1, ...grid.flat()); clear(elements.activityHeatmap);
  elements.activityHeatmap.setAttribute("role", "group");
  elements.activityHeatmap.setAttribute("aria-label", `Session starts by local weekday and hour for ${integer.format(sessions.length)} selected sessions.`);
  elements.activityHeatmap.append(node("span", "", "heat-hour"));
  for (let hour = 0; hour < 24; hour += 1) elements.activityHeatmap.append(node("span", hour % 4 === 0 ? String(hour).padStart(2, "0") : "", "heat-hour"));
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  for (let day = 0; day < 7; day += 1) {
    elements.activityHeatmap.append(node("span", days[day].slice(0, 3), "heat-label"));
    for (let hour = 0; hour < 24; hour += 1) {
      const value = grid[day][hour], cell = node("span", null, "heat-cell");
      const hourLabel = `${String(hour).padStart(2, "0")}:00–${String(hour).padStart(2, "0")}:59`;
      cell.dataset.level = value === 0 ? "0" : String(Math.max(1, Math.ceil((Math.log1p(value) / Math.log1p(maximum)) * 7)));
      cell.dataset.day = String(day);
      cell.dataset.hour = String(hour);
      cell.dataset.value = String(value);
      cell.tabIndex = day === 0 && hour === 0 ? 0 : -1;
      cell.setAttribute("role", "img");
      cell.setAttribute("aria-label", `${integer.format(value)} session${value === 1 ? "" : "s"}, ${days[day]}, ${hourLabel}`);
      const showTooltip = () => {
        clear(elements.activityTooltip);
        elements.activityTooltip.append(
          node("strong", integer.format(value)),
          node("span", `${value === 1 ? "session" : "sessions"} · ${days[day]} · ${hourLabel}`),
        );
        elements.activityTooltip.hidden = false;
        elements.activityTooltip.dataset.side = "above";
        const cellRect = cell.getBoundingClientRect(), tooltipRect = elements.activityTooltip.getBoundingClientRect();
        let top = cellRect.top - tooltipRect.height - 10;
        if (top < 8) {
          top = cellRect.bottom + 10;
          elements.activityTooltip.dataset.side = "below";
        }
        const left = Math.min(window.innerWidth - tooltipRect.width - 8, Math.max(8, cellRect.left + cellRect.width / 2 - tooltipRect.width / 2));
        elements.activityTooltip.style.left = `${left}px`;
        elements.activityTooltip.style.top = `${top}px`;
        elements.activityTooltip.style.setProperty("--tooltip-arrow-left", `${Math.min(tooltipRect.width - 10, Math.max(10, cellRect.left + cellRect.width / 2 - left))}px`);
      };
      const hideTooltip = () => { elements.activityTooltip.hidden = true; };
      cell.addEventListener("pointerenter", showTooltip);
      cell.addEventListener("pointerleave", hideTooltip);
      cell.addEventListener("focus", showTooltip);
      cell.addEventListener("blur", hideTooltip);
      cell.addEventListener("keydown", (event) => {
        const movement = { ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0] }[event.key];
        if (!movement) return;
        const nextDay = day + movement[0], nextHour = hour + movement[1];
        const target = elements.activityHeatmap.querySelector(`[data-day="${nextDay}"][data-hour="${nextHour}"]`);
        if (!target) return;
        event.preventDefault(); cell.tabIndex = -1; target.tabIndex = 0; target.focus();
      });
      elements.activityHeatmap.append(cell);
    }
  }
  const repositories = view.repositories.map(({ repository }) => ({
    name: repository.name,
    value: sessions.filter(({ repositoryId }) => repositoryId === repository.id).length,
  })).filter(({ value }) => value > 0).sort((left, right) => right.value - left.value);
  renderBars(elements.activityRepositories, repositories, (value) => integer.format(value), 12);
}

function costTotals(sessions) {
  const result = { cached: 0, input: 0, output: 0, reported: 0, total: 0, upper: 0, write: 0 };
  for (const session of sessions) {
    if (session.costBasis === "provider-reported") result.reported += session.cost.totalUsd;
    if (session.costBasis !== "api-list-price-equivalent") continue;
    result.cached += session.cost.cachedInputUsd; result.input += session.cost.inputUsd;
    result.output += session.cost.outputUsd; result.write += session.cost.cacheWriteUsd;
    result.total += session.cost.totalUsd; result.upper += session.cost.upperEstimateUsd;
  }
  return result;
}

const componentLabels = { cached: "Cache read", input: "Input", output: "Output", reported: "Provider-reported", write: "Cache write" };

function renderCostRows(container, groups) {
  clear(container); const list = node("div", null, "cost-stack-list");
  for (const group of groups) {
    const total = group.cost.total + group.cost.reported;
    if (total <= 0) continue;
    const row = node("div", null, "cost-stack-row"); row.append(node("strong", group.name));
    const stack = node("div", null, "cost-stack");
    const components = group.cost.reported > 0 && group.cost.total === 0
      ? [["reported", group.cost.reported]]
      : [["input", group.cost.input], ["cached", group.cost.cached], ["write", group.cost.write], ["output", group.cost.output]];
    const parts = components.filter(([, value]) => value > 0);
    stack.setAttribute("role", "img");
    stack.setAttribute("aria-label", parts.map(([name, value]) => `${componentLabels[name]} ${money(value)}`).join(", "));
    stack.title = parts.map(([name, value]) => `${componentLabels[name]}: ${money(value)} (${((value / total) * 100).toFixed(1)}%)`).join("\n");
    for (const [name, value] of parts) {
      const bar = node("i"); bar.dataset.component = name; bar.style.width = `${(value / total) * 100}%`; stack.append(bar);
    }
    row.append(stack, node("strong", money(total))); list.append(row);
  }
  if (list.childElementCount === 0) emptyState(list, "No priced activity in this view.");
  container.append(list);
  const legend = node("div", null, "cost-legend");
  for (const name of ["input", "cached", "write", "output", "reported"]) {
    const item = node("span"); const swatch = node("i"); swatch.dataset.component = name; item.append(swatch, document.createTextNode(componentLabels[name])); legend.append(item);
  }
  container.append(legend);
}

function renderCosts(view) {
  const cost = costTotals(view.sessions);
  elements.costApiTotal.textContent = money(cost.total); elements.costUpperTotal.textContent = money(cost.upper);
  elements.costProviderTotal.textContent = money(cost.reported); elements.costCoverage.textContent = percent(view.summary.pricedTokenCoverage);
  renderCostRows(elements.providerCostComponents, providerOrder.map((provider) => ({
    name: providerLabels[provider], cost: costTotals(view.sessions.filter((session) => session.provider === provider)),
  })));
  renderCostRows(elements.repositoryCostComponents, view.repositories.map(({ repository }) => ({
    name: repository.name, cost: costTotals(view.sessions.filter(({ repositoryId }) => repositoryId === repository.id)),
  })).sort((left, right) => (right.cost.total + right.cost.reported) - (left.cost.total + left.cost.reported)).slice(0, 12));
}

function renderModels(view) {
  clear(elements.modelsByProvider); const sessions = view.sessions;
  const models = mergeModels(sessions);
  const sessionsPerModel = new Map();
  for (const session of sessions) for (const model of session.models) {
    const key = `${session.provider}:${model.model}`; sessionsPerModel.set(key, (sessionsPerModel.get(key) || 0) + 1);
  }
  const metric = {
    calls: { format: (value) => `${integer.format(value)} calls`, value: (model) => model.calls },
    input: { format: (value) => `${compact.format(value)} tokens`, value: (model) => model.inputTokens },
    output: { format: (value) => `${compact.format(value)} tokens`, value: (model) => model.outputTokens },
    value: { format: money, value: (model) => model.totalUsd },
  }[modelMetric];
  for (const provider of providerOrder) {
    const providerModels = models.filter((model) => model.provider === provider);
    if (providerModels.length === 0) continue;
    const group = node("section", null, "provider-model-group"); group.style.setProperty("--provider-color", `var(--${provider})`);
    const header = node("header"); const title = node("div");
    title.append(node("h2", providerLabels[provider]), node("div", `${sessions.filter((session) => session.provider === provider).length} sessions`));
    header.append(title, node("span", provider === "cursor" ? "Provider-reported value" : "API-equivalent value", "pill")); group.append(header);
    const maximum = Math.max(1, ...providerModels.map(metric.value));
    for (const model of providerModels.sort((left, right) => metric.value(right) - metric.value(left))) {
      const row = node("div", null, "model-row"); row.append(node("span", model.model));
      const track = node("div", null, "model-track"), fill = node("i"); fill.style.width = `${Math.max(1, (metric.value(model) / maximum) * 100)}%`; track.append(fill);
      const suffix = `${metric.format(metric.value(model))} · ${sessionsPerModel.get(`${provider}:${model.model}`) || 0} sessions${provider === "cursor" || model.priced ? "" : " · unpriced"}`;
      row.append(track, node("strong", suffix)); group.append(row);
    }
    elements.modelsByProvider.append(group);
  }
  if (elements.modelsByProvider.childElementCount === 0) emptyState(elements.modelsByProvider, "No model activity in this view.");
}

function evidenceLabel(sessions) {
  const evidence = new Set(sessions.map(({ skillEvidence }) => skillEvidence));
  if (evidence.has("explicit") && evidence.has("inferred")) return "Explicit + lower bound";
  if (evidence.has("explicit")) return "Explicit";
  if (evidence.has("inferred")) return "Lower bound";
  return "N/A";
}

function renderNamedDistribution({ view, field, keyContainer, tableContainer, detailContainer, detailTitle, skillMode = false }) {
  const sessions = view.sessions;
  const names = namedTotals(sessions, field).slice(0, seriesSlots);
  clear(tableContainer); clear(keyContainer);
  const header = node("div", null, "distribution-row header-row");
  header.append(node("span", "Repository"), node("span", "Distribution"), node("span", field === "skills" ? "Observed" : "Calls"), node("span", skillMode ? "Coverage" : "Top")); tableContainer.append(header);
  const rows = view.repositories.map(({ repository }) => {
    const repositorySessions = sessions.filter(({ repositoryId }) => repositoryId === repository.id);
    const totals = new Map(namedTotals(repositorySessions, field).map(({ name, value }) => [name, value]));
    return { repository, sessions: repositorySessions, total: [...totals.values()].reduce((sum, value) => sum + value, 0), totals };
  }).filter(({ total }) => total > 0).sort((left, right) => right.total - left.total);
  let selectedId = field === "skills" ? skillsDetailRepositoryId : toolsDetailRepositoryId;
  if (!rows.some(({ repository }) => repository.id === selectedId)) selectedId = rows[0]?.repository.id ?? null;
  if (field === "skills") skillsDetailRepositoryId = selectedId; else toolsDetailRepositoryId = selectedId;
  for (const item of rows) {
    const row = node("div", null, "distribution-row"); const open = node("button", item.repository.name);
    if (item.repository.id === selectedId) row.setAttribute("aria-current", "true");
    open.type = "button"; open.setAttribute("aria-label", `Show ${field} for ${item.repository.name}`); open.addEventListener("click", () => {
      if (field === "skills") skillsDetailRepositoryId = item.repository.id; else toolsDetailRepositoryId = item.repository.id;
      renderActiveAnalyticsView(view);
    }); row.append(open);
    const stack = node("div", null, "distribution-stack");
    const parts = [];
    for (const [index, { name }] of names.entries()) {
      const value = item.totals.get(name) || 0; if (value === 0) continue;
      const fill = node("i"); fill.style.setProperty("--series-color", seriesColor(index)); fill.style.width = `${(value / item.total) * 100}%`; stack.append(fill);
      parts.push(`${name} ${integer.format(value)}`);
    }
    const represented = names.reduce((sum, { name }) => sum + (item.totals.get(name) || 0), 0);
    if (represented < item.total) {
      const other = node("i"); other.dataset.other = "true"; other.style.width = `${((item.total - represented) / item.total) * 100}%`; stack.append(other);
      parts.push(`Other ${integer.format(item.total - represented)}`);
    }
    stack.title = parts.join("\n"); stack.setAttribute("role", "img"); stack.setAttribute("aria-label", parts.join(", "));
    const top = [...item.totals.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "—";
    row.append(stack, node("strong", integer.format(item.total)), node("span", skillMode ? evidenceLabel(item.sessions) : top)); tableContainer.append(row);
  }
  if (rows.length === 0) { clear(tableContainer); emptyState(tableContainer, skillMode ? "No observed skill invocations in this view." : "No tool activity in this view."); }
  for (const [index, { name }] of names.entries()) {
    const item = node("span"); const swatch = node("i"); swatch.style.setProperty("--series-color", seriesColor(index)); item.append(swatch, document.createTextNode(name)); keyContainer.append(item);
  }
  if (rows.some((item) => names.reduce((sum, { name }) => sum + (item.totals.get(name) || 0), 0) < item.total)) {
    const item = node("span"); const swatch = node("i"); swatch.className = "other-swatch"; item.append(swatch, document.createTextNode("Other")); keyContainer.append(item);
  }
  const selectedRow = rows.find(({ repository }) => repository.id === selectedId);
  detailTitle.textContent = selectedRow?.repository.name || "No repository selected";
  renderBars(detailContainer, selectedRow ? namedTotals(selectedRow.sessions, field) : [], (value) => integer.format(value), 10);
}

function clearInactiveAnalyticsViews(activeName) {
  const containers = {
    activity: [elements.activityHeatmap, elements.activityRepositories],
    costs: [elements.providerCostComponents, elements.repositoryCostComponents],
    distributions: [elements.distributionRepositoryOptions, elements.distributionKey, elements.distributionDuration, elements.distributionCost, elements.distributionTools, elements.distributionCompactions],
    models: [elements.modelsByProvider],
    skills: [elements.skillsByRepository, elements.skillsKey, elements.skillsDetail],
    tools: [elements.toolsByRepository, elements.toolsKey, elements.toolsDetail],
  };
  for (const [name, elementsForView] of Object.entries(containers)) {
    if (name === activeName) continue;
    for (const element of elementsForView) clear(element);
  }
}

function renderActiveAnalyticsView(view) {
  const name = currentViewName(); clearInactiveAnalyticsViews(name);
  if (name === "distributions") renderDistributions();
  if (name === "activity") renderActivity(view);
  if (name === "costs") renderCosts(view);
  if (name === "models") renderModels(view);
  if (name === "tools") renderNamedDistribution({ view, field: "tools", keyContainer: elements.toolsKey, tableContainer: elements.toolsByRepository, detailContainer: elements.toolsDetail, detailTitle: elements.toolsDetailTitle });
  if (name === "skills") renderNamedDistribution({ view, field: "skills", keyContainer: elements.skillsKey, tableContainer: elements.skillsByRepository, detailContainer: elements.skillsDetail, detailTitle: elements.skillsDetailTitle, skillMode: true });
}

function dailyProviderSpend(sessions) {
  const days = new Map();
  for (const name of windowDays()) days.set(name, { name, codex: 0, claude: 0, cursor: 0 });
  for (const session of sessions) {
    for (const [day, value] of Object.entries(session.spendByDay)) {
      if (day < elements.windowStart.value || day > elements.windowEnd.value) continue;
      const current = days.get(day) || { name: day, codex: 0, claude: 0, cursor: 0 };
      current[session.provider] += value;
      days.set(day, current);
    }
  }
  return [...days.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function renderLine(items) {
  clear(elements.dailySpend); clear(elements.dailyLegend);
  const selectedProviders = activeProviders();
  const providers = selectedProviders.filter((provider) => items.some((item) => item[provider] > 0));
  if (!items.length || !selectedProviders.length || !providers.length) {
    const message = !selectedProviders.length
      ? "Choose at least one provider."
      : selectedProviders.length === 1 && selectedProviders[0] === "cursor"
        ? "Cursor has no trustworthy daily cost timestamps in the local store; its provider-reported total remains in the usage-value summaries."
        : "No daily priced activity in this view.";
    emptyState(elements.dailySpend, message, "Nothing to plot"); syncHover(null); return;
  }
  const width = 900, height = 272, left = 52, right = 14, top = 14, bottom = 34;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = Math.max(0.001, ...items.flatMap((item) => providers.map((provider) => item[provider])));
  const roughTick = maximum / 4;
  const tickMagnitude = 10 ** Math.floor(Math.log10(roughTick));
  const tick = Math.ceil(roughTick / tickMagnitude) * tickMagnitude;
  const axisMaximum = tick * 4;
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  for (let index = 0; index < 5; index += 1) {
    const y = top + (index / 4) * plotHeight;
    const value = axisMaximum * (1 - index / 4);
    svg.append(svgNode("line", { x1: left, x2: width - right, y1: y, y2: y, class: "grid-line" }));
    addSvgText(svg, shortMoney(value), left - 10, y + 4, "end");
  }
  const xAt = (index) => items.length === 1 ? left + plotWidth / 2 : left + (index / (items.length - 1)) * plotWidth;
  const tickIndexes = [...new Set([0, Math.round((items.length - 1) / 4), Math.round((items.length - 1) / 2), Math.round(((items.length - 1) * 3) / 4), items.length - 1])];
  for (const index of tickIndexes) addSvgText(svg, shortDate(items[index].name), xAt(index), height - 12, index === 0 ? "start" : index === items.length - 1 ? "end" : "middle");
  const xs = items.map((_, index) => xAt(index));
  const baseline = top + plotHeight;
  const dots = {};
  for (const provider of providers) {
    const points = items.map((item, index) => ({ x: xs[index], y: top + (1 - item[provider] / axisMaximum) * plotHeight }));
    const path = points.map(({ x, y }, index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    svg.append(svgNode("path", { class: `trend-area ${provider}`, d: `${path} L${points.at(-1).x.toFixed(1)},${baseline} L${points[0].x.toFixed(1)},${baseline} Z` }));
    svg.append(svgNode("path", { class: `trend-line ${provider}`, d: path }));
    const dot = svgNode("circle", { class: `hover-dot ${provider}`, r: 4, cx: 0, cy: 0 }); dot.style.display = "none";
    dots[provider] = { dot, points }; svg.append(dot);
    const key = node("span"); const swatch = node("i"); swatch.style.setProperty("--key-color", `var(--${provider})`);
    key.append(swatch, document.createTextNode(providerLabels[provider])); elements.dailyLegend.append(key);
  }
  elements.dailySpend.append(svg);
  attachCrosshair(elements.dailySpend, svg, {
    xs, plotTop: top, plotBottom: baseline, plotLeft: left, plotRight: width - right, label: "Daily priced usage value in US dollars by provider",
    title: (index) => new Intl.DateTimeFormat("en-GB", { dateStyle: "full" }).format(new Date(`${items[index].name}T00:00:00`)),
    rows: (index) => providers.map((provider) => ({ label: providerLabels[provider], color: `var(--${provider})`, value: money(items[index][provider]), dim: items[index][provider] <= 0 })),
    onIndex: (index) => {
      for (const provider of providers) {
        const { dot, points } = dots[provider];
        dot.style.display = index === null ? "none" : "";
        if (index !== null) { dot.setAttribute("cx", points[index].x.toFixed(1)); dot.setAttribute("cy", points[index].y.toFixed(1)); }
      }
      syncHover(index === null ? null : items[index].name);
    },
  });
}

function arcPath(cx, cy, outer, inner, startAngle, endAngle) {
  const polar = (radius, angle) => [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const [sx, sy] = polar(outer, startAngle), [ex, ey] = polar(outer, endAngle);
  const [isx, isy] = polar(inner, endAngle), [iex, iey] = polar(inner, startAngle);
  return `M${sx.toFixed(2)},${sy.toFixed(2)} A${outer},${outer} 0 ${largeArc} 1 ${ex.toFixed(2)},${ey.toFixed(2)} L${isx.toFixed(2)},${isy.toFixed(2)} A${inner},${inner} 0 ${largeArc} 0 ${iex.toFixed(2)},${iey.toFixed(2)} Z`;
}

function renderDonut(sessions) {
  const counts = { codex: 0, claude: 0, cursor: 0 };
  for (const session of sessions) counts[session.provider] = (counts[session.provider] || 0) + 1;
  const total = sessions.length;
  clear(elements.providerDonut); clear(elements.providerLegend); delete elements.providerDonut.dataset.hover;
  const svg = svgNode("svg", { viewBox: "0 0 120 120", role: "img", "aria-label": `${integer.format(total)} sessions by provider` });
  const paths = {};
  let angle = -Math.PI / 2;
  for (const provider of providerOrder) {
    const share = total ? counts[provider] / total : 0;
    if (share <= 0) continue;
    const sweep = share * Math.PI * 2;
    const segments = sweep >= Math.PI * 2 - 0.0001 ? [[angle, angle + Math.PI], [angle + Math.PI, angle + Math.PI * 2]] : [[angle, angle + sweep]];
    for (const [start, end] of segments) {
      const path = svgNode("path", { class: provider, d: arcPath(60, 60, 58, 40, start, end) });
      paths[provider] = [...(paths[provider] || []), path]; svg.append(path);
    }
    angle += sweep;
  }
  if (total === 0) svg.append(svgNode("circle", { cx: 60, cy: 60, r: 49, fill: "none", stroke: "var(--surface-3)", "stroke-width": 18 }));
  const center = node("div", null, "donut-center");
  center.append(node("strong", integer.format(total)), node("span", total === 1 ? "session" : "sessions"));
  elements.providerDonut.append(svg, center);
  for (const provider of providerOrder) {
    const value = counts[provider];
    const row = node("div", null, "legend-row"); const logo = node("img"); logo.src = `/brands/${provider}.svg`; logo.alt = "";
    const swatch = node("i"); swatch.style.setProperty("--key-color", `var(--${provider})`);
    row.append(logo, node("span", providerLabels[provider]), node("strong", integer.format(value)), node("small", total ? percent(value / total) : "—"));
    row.addEventListener("pointerenter", () => { elements.providerDonut.dataset.hover = provider; for (const path of paths[provider] || []) path.classList.add("active"); });
    row.addEventListener("pointerleave", () => { delete elements.providerDonut.dataset.hover; for (const path of paths[provider] || []) path.classList.remove("active"); });
    elements.providerLegend.append(row);
  }
}

function tableCell(primary, secondary, className) {
  const cell = node("td"); cell.append(node("span", primary, className));
  if (secondary) cell.append(node("small", secondary)); return cell;
}

function repositoryKey(id) {
  return id.startsWith("discovered-") ? id.slice(-8) : id.slice(0, 8);
}

function cacheRatio(value) {
  const tokens = value.tokens || value;
  const denominator = tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheWriteInputTokens;
  return denominator ? tokens.cachedInputTokens / denominator : 0;
}

const tableAccessors = {
  cache: (item) => item.summary.cacheReadRatio ?? -1,
  coverage: (item) => item.summary.pricedTokenCoverage ?? -1,
  input: (item) => item.summary.totalInputTokens,
  name: (item) => item.repository.name.toLowerCase(),
  output: (item) => item.summary.outputTokens,
  sessions: (item) => item.summary.sessions,
  tools: (item) => item.summary.toolCalls,
  value: (item) => item.summary.estimatedSpendUsd,
};

function renderRepositoryTable(repositories) {
  clear(elements.repositoryRows);
  const accessor = tableAccessors[tableSort.key] || tableAccessors.value;
  const direction = tableSort.direction === "ascending" ? 1 : -1;
  const sorted = [...repositories].sort((a, b) => {
    const left = accessor(a), right = accessor(b);
    const order = typeof left === "string" ? left.localeCompare(right) : left - right;
    return order !== 0 ? order * direction : a.repository.name.localeCompare(b.repository.name);
  });
  for (const button of sortButtons) {
    const header = button.closest("th");
    if (button.dataset.sort === tableSort.key) header.setAttribute("aria-sort", tableSort.direction);
    else header.removeAttribute("aria-sort");
  }
  const maximumValue = Math.max(0.000001, ...repositories.map((item) => item.summary.estimatedSpendUsd));
  const selectedId = elements.repositoryFilter.value;
  for (const item of sorted) {
    const row = node("tr"); const summary = item.summary;
    row.tabIndex = 0; row.setAttribute("role", "link"); row.setAttribute("aria-label", `Open metrics for ${item.repository.name}`);
    if (item.repository.id === selectedId) row.setAttribute("aria-current", "true");
    row.addEventListener("click", () => selectRepository(item.repository.id));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectRepository(item.repository.id); } });
    const valueCell = node("td"); const bar = node("div", null, "cell-bar"); const track = node("div", null, "bar-track"); const fill = node("i");
    fill.style.width = `${Math.max(1, (summary.estimatedSpendUsd / maximumValue) * 100)}%`; track.append(fill);
    bar.append(track, node("strong", money(summary.estimatedSpendUsd), "money")); valueCell.append(bar, node("small", `${money(summary.subagentSpendUsd)} sub-agent`));
    row.append(tableCell(item.repository.name, `ID ${repositoryKey(item.repository.id)}`), tableCell(String(summary.sessions), `${summary.topLevelSessions} top-level · ${summary.subagentSessions} sub-agent`), valueCell, tableCell(compact.format(summary.totalInputTokens)), tableCell(compact.format(summary.outputTokens)), tableCell(compact.format(summary.toolCalls)), tableCell(percent(summary.cacheReadRatio)), tableCell(percent(summary.pricedTokenCoverage), summary.missingTranscripts ? `${summary.missingTranscripts} missing` : "complete"));
    elements.repositoryRows.append(row);
  }
  if (sorted.length === 0) {
    const row = node("tr"); const cell = node("td"); cell.colSpan = 8; emptyState(cell, "No repositories in this view."); row.append(cell); elements.repositoryRows.append(row);
  }
}

function renderWarnings(warnings) {
  clear(elements.warningList); elements.warning.hidden = !warnings.length;
  warnings.forEach((warning) => elements.warningList.append(node("li", warning)));
}

function renderRateCards(rateCard) {
  clear(elements.rateCardLinks);
  for (const item of rateCard.models) { const link = node("a", `${item.model} rate ↗`); link.href = item.source; link.target = "_blank"; link.rel = "noreferrer"; elements.rateCardLinks.append(link); }
}

function populateRepositories() {
  const previous = elements.repositoryFilter.value;
  clear(elements.repositoryFilter); elements.repositoryFilter.append(new Option("All repositories", "all"));
  for (const item of snapshot.repositories) elements.repositoryFilter.append(new Option(item.repository.name, item.repository.id));
  if ([...elements.repositoryFilter.options].some((option) => option.value === previous)) elements.repositoryFilter.value = previous;
}

function renderRepositoryNav(view) {
  clear(elements.repositoryList);
  const days = windowDays();
  const selectedId = elements.repositoryFilter.value;
  const windowSessions = sessionsInWindow(sessionsForProviders(snapshot.sessions));
  const total = summarize(windowSessions).estimatedSpendUsd;
  const allRow = node("button", null, "repo-row all-row"); allRow.type = "button";
  allRow.setAttribute("aria-pressed", String(selectedId === "all"));
  allRow.setAttribute("aria-label", `All repositories, ${money(total)} in the selected window`);
  allRow.append(icon("summary"), node("span", "All repositories", "repo-name"), node("span", shortMoney(total), "repo-value"));
  allRow.addEventListener("click", () => selectRepository("all", { scroll: false }));
  elements.repositoryList.append(allRow);
  const rows = snapshot.repositories.map((item) => {
    const sessions = windowSessions.filter(({ repositoryId }) => repositoryId === item.repository.id);
    return { item, sessions, value: summarize(sessions).estimatedSpendUsd };
  }).sort((left, right) => right.value - left.value || left.item.repository.name.localeCompare(right.item.repository.name));
  elements.repositoryNavCount.textContent = String(rows.length);
  for (const { item, sessions, value } of rows) {
    const row = node("button", null, "repo-row"); row.type = "button";
    const active = item.repository.id === selectedId;
    row.setAttribute("aria-pressed", String(active));
    row.setAttribute("aria-label", `${active ? "Clear focus on" : "Focus"} ${item.repository.name}, ${money(value)} in the selected window`);
    const spark = svgNode("svg", { class: "spark", "aria-hidden": "true" });
    renderSparkline(spark, dailySpendSeries(sessions, days), days, { width: 44, height: 16 });
    row.append(node("span", item.repository.name, "repo-name"), spark, node("span", shortMoney(value), "repo-value"));
    row.addEventListener("click", () => selectRepository(active ? "all" : item.repository.id, { scroll: false }));
    elements.repositoryList.append(row);
  }
}

function windowLength() {
  if (!elements.windowStart.value || !elements.windowEnd.value) return 0;
  return Math.round((new Date(`${elements.windowEnd.value}T00:00:00Z`) - new Date(`${elements.windowStart.value}T00:00:00Z`)) / 86_400_000) + 1;
}

function previousPeriodSessions(sessions) {
  const length = windowLength();
  if (windowPreset === "all" || length <= 0 || !elements.windowStart.min) return null;
  const end = new Date(`${elements.windowStart.value}T00:00:00Z`); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - length + 1);
  const endDay = end.toISOString().slice(0, 10), startDay = start.toISOString().slice(0, 10);
  if (endDay < elements.windowStart.min) return null;
  return { length, sessions: sessionsInRange(sessions, startDay, endDay) };
}

function renderDelta(element, current, previous, length) {
  if (previous === null || previous === undefined) { element.hidden = true; return; }
  if (previous === 0 && current === 0) { element.hidden = true; return; }
  element.hidden = false;
  const label = `vs previous ${length}d`;
  if (previous === 0) { element.dataset.direction = "up"; element.textContent = `new · ${label}`; element.setAttribute("aria-label", `No activity in the previous ${length} days`); return; }
  const change = (current - previous) / previous;
  const direction = Math.abs(change) < 0.0005 ? "flat" : change > 0 ? "up" : "down";
  element.dataset.direction = direction;
  element.textContent = `${direction === "up" ? "▲" : direction === "down" ? "▼" : "▬"} ${Math.abs(change * 100).toFixed(1)}% ${label}`;
  element.setAttribute("aria-label", `${direction === "up" ? "Up" : direction === "down" ? "Down" : "Unchanged"} ${Math.abs(change * 100).toFixed(1)} percent versus the previous ${length} days`);
}

function windowCaption() {
  if (elements.windowStart.value === elements.windowStart.min && elements.windowEnd.value === elements.windowEnd.max) return "all observed dates";
  return `${elements.windowStart.value} through ${elements.windowEnd.value}`;
}

function renderSharedView(view) {
  const selected = selectedRepository();
  const providers = activeProviders();
  const providerCaption = providers.length === providerOrder.length ? "" : providers.length === 0 ? " No providers selected." : ` Providers: ${providers.map((provider) => providerLabels[provider]).join(", ")}.`;
  elements.scope.textContent = `${selected ? `Focused on ${selected.repository.name}.` : "Every repository evidenced by local agent history."} Sessions started during ${windowCaption()}.${providerCaption}`;
  elements.scopeChip.hidden = !selected;
  elements.scopeChipLabel.textContent = selected ? selected.repository.name : "";
  renderRepositoryNav(view);
}

function renderSummary(view) {
  const summary = view.summary;
  const days = windowDays();
  const previous = previousPeriodSessions(view.scopeSessions);
  const previousSummary = previous ? summarize(previous.sessions) : null;
  elements.spend.textContent = money(summary.estimatedSpendUsd); elements.spendNote.textContent = `${money(summary.apiEquivalentSpendUsd)} API-equivalent · ${money(summary.providerReportedSpendUsd)} provider-reported · not an invoice`;
  elements.repositories.textContent = String(summary.repositories); elements.repositoryNote.textContent = `${summary.repositoriesWithSessions} with sessions`;
  elements.sessions.textContent = `${summary.analyzedSessions}/${summary.sessions}`; elements.sessionNote.textContent = `${summary.topLevelSessions} top-level · ${summary.subagentSessions} sub-agent`;
  elements.input.textContent = compact.format(summary.totalInputTokens); elements.cache.textContent = `${percent(summary.cacheReadRatio)} cached · repeated context included`;
  elements.output.textContent = compact.format(summary.outputTokens); elements.tools.textContent = compact.format(summary.toolCalls); elements.compactions.textContent = integer.format(summary.compactions); elements.live.textContent = integer.format(summary.workingSnapshots);
  const metrics = [
    ["spend", summary.estimatedSpendUsd, previousSummary?.estimatedSpendUsd, dailySpendSeries(view.sessions, days)],
    ["sessions", summary.sessions, previousSummary?.sessions, dailyCountSeries(view.sessions, days, () => 1)],
    ["input", summary.totalInputTokens, previousSummary?.totalInputTokens, dailyCountSeries(view.sessions, days, ({ tokens }) => tokens.inputTokens)],
    ["output", summary.outputTokens, previousSummary?.outputTokens, dailyCountSeries(view.sessions, days, ({ tokens }) => tokens.outputTokens)],
    ["tools", summary.toolCalls, previousSummary?.toolCalls, dailyCountSeries(view.sessions, days, ({ metrics: item }) => item.toolCalls)],
    ["compactions", summary.compactions, previousSummary?.compactions, dailyCountSeries(view.sessions, days, ({ metrics: item }) => item.compactions)],
  ];
  for (const [name, current, before, series] of metrics) {
    renderDelta($(`#metric-${name}-delta`), current, previousSummary ? before : null, previous?.length);
    renderSparkline($(`#metric-${name}-spark`), series, days);
  }
  renderLine(dailyProviderSpend(view.dailySessions)); renderDonut(view.sessions);
  renderBars(elements.repositorySpend, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.estimatedSpendUsd })).sort((a, b) => b.value - a.value), money, 12, ({ id }) => selectRepository(id));
  renderBars(elements.repositoryTokens, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.totalInputTokens })).sort((a, b) => b.value - a.value), (value) => compact.format(value), 12, ({ id }) => selectRepository(id));
  renderBars(elements.modelSpend, view.spendByModel.map(({ model, provider, totalUsd }) => ({ name: model, value: totalUsd, provider })), money, 8);
  renderBars(elements.toolCalls, view.topTools, (value) => integer.format(value), 10);
  renderBars(elements.repositorySubagentSpend, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.subagentSpendUsd })).filter(({ value }) => value > 0).sort((a, b) => b.value - a.value), money, 10, ({ id }) => selectRepository(id));
  renderRepositoryTable(view.repositories); renderWarnings(view.warnings);
}

function renderView() {
  hoverListeners.clear();
  const view = activeView();
  renderSharedView(view);
  if (currentViewName() === "summary") {
    clearInactiveAnalyticsViews("summary");
    renderSummary(view);
  } else {
    renderActiveAnalyticsView(view);
  }
}

// --------------------------------------------------------------------- window controls

function setWindowPreset(preset) {
  windowPreset = windowPresets.includes(preset) ? preset : "all";
  for (const button of windowButtons) button.setAttribute("aria-pressed", String(button.dataset.windowPreset === windowPreset));
  elements.dateRange.hidden = windowPreset !== "custom";
}

function configureWindow() {
  const dates = snapshot.sessions.flatMap(({ createdAt, spendByDay }) => [createdAt.slice(0, 10), ...Object.keys(spendByDay)]).sort();
  const minimum = dates[0] || new Date().toISOString().slice(0, 10), maximum = dates.at(-1) || minimum;
  for (const input of [elements.windowStart, elements.windowEnd]) { input.min = minimum; input.max = maximum; }
  if (windowPreset === "custom" && elements.windowStart.value && elements.windowEnd.value) {
    elements.windowStart.value = elements.windowStart.value < minimum ? minimum : elements.windowStart.value;
    elements.windowEnd.value = elements.windowEnd.value > maximum ? maximum : elements.windowEnd.value;
    return;
  }
  applyWindowPreset(windowPreset, { render: false });
}

function applyWindowPreset(preset, { render = true } = {}) {
  setWindowPreset(preset);
  if (windowPreset === "all") elements.windowStart.value = elements.windowStart.min;
  else if (windowPreset !== "custom") {
    const start = new Date(`${elements.windowEnd.max}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - Number(windowPreset) + 1);
    elements.windowStart.value = start.toISOString().slice(0, 10) < elements.windowStart.min ? elements.windowStart.min : start.toISOString().slice(0, 10);
  }
  if (windowPreset !== "custom") elements.windowEnd.value = elements.windowEnd.max;
  if (windowPreset === "custom" && !elements.windowStart.value) { elements.windowStart.value = elements.windowStart.min; elements.windowEnd.value = elements.windowEnd.max; }
  if (render && snapshot) renderView();
}

function applyCustomWindow(changed) {
  setWindowPreset("custom");
  if (elements.windowStart.value > elements.windowEnd.value) {
    if (changed === "start") elements.windowEnd.value = elements.windowStart.value;
    else elements.windowStart.value = elements.windowEnd.value;
  }
  if (snapshot) renderView();
}

// --------------------------------------------------------------------- appearance

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  elements.themeLabel.textContent = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  elements.theme.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  localStorage.setItem("session-analytics-theme", theme);
}

function toggleTheme() { setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); }

function setDensity(density) {
  const value = density === "comfortable" ? "comfortable" : "compact";
  document.documentElement.dataset.density = value;
  elements.density.setAttribute("aria-pressed", String(value === "comfortable"));
  elements.density.setAttribute("aria-label", value === "comfortable" ? "Switch to compact density" : "Switch to comfortable density");
  localStorage.setItem("session-analytics-density", value);
}

function toggleDensity() { setDensity(document.documentElement.dataset.density === "comfortable" ? "compact" : "comfortable"); }

function toggleProvider(provider) {
  const input = providerFilters.find(({ dataset }) => dataset.providerFilter === provider);
  if (!input) return;
  input.checked = !input.checked;
  if (snapshot) renderView();
}

// --------------------------------------------------------------------- command palette

let paletteActive = 0;
let paletteOptions = [];

function paletteItems() {
  const items = [];
  const selectedId = elements.repositoryFilter.value;
  for (const name of viewOrder) {
    const chord = Object.entries(viewChords).find(([, view]) => view === name)?.[0] || "";
    items.push({ group: "Views", icon: name, label: `Go to ${viewLabels[name]}`, hint: `g ${chord}`, keywords: `view ${name}`, state: currentViewName() === name, run: () => switchView(name) });
  }
  items.push({ group: "Repositories", icon: "repo", label: "All repositories", keywords: "repo clear focus everything", state: selectedId === "all", run: () => selectRepository("all") });
  for (const item of snapshot?.repositories ?? []) {
    items.push({ group: "Repositories", icon: "repo", label: `Focus ${item.repository.name}`, keywords: `repo repository ${item.repository.name}`, state: selectedId === item.repository.id, run: () => selectRepository(item.repository.id) });
  }
  for (const provider of providerOrder) {
    const input = providerFilters.find(({ dataset }) => dataset.providerFilter === provider);
    items.push({ group: "Providers", icon: "models", label: `${input?.checked ? "Hide" : "Show"} ${providerLabels[provider]}`, hint: `p ${providerOrder.indexOf(provider) + 1}`, keywords: `provider toggle ${provider} filter`, state: Boolean(input?.checked), run: () => toggleProvider(provider) });
  }
  for (const preset of ["7", "30", "90", "all"]) {
    items.push({ group: "Time window", icon: "activity", label: windowLabels[preset], hint: String(["7", "30", "90", "all"].indexOf(preset) + 1), keywords: `window days range ${preset}`, state: windowPreset === preset, run: () => applyWindowPreset(preset) });
  }
  items.push({ group: "Time window", icon: "activity", label: "Custom range", keywords: "window custom dates", state: windowPreset === "custom", run: () => { applyWindowPreset("custom"); elements.windowStart.focus(); } });
  const dark = document.documentElement.dataset.theme === "dark";
  items.push({ group: "Appearance", icon: dark ? "sun" : "moon", label: `Switch to ${dark ? "light" : "dark"} theme`, hint: "t", keywords: "theme dark light mode appearance", run: toggleTheme });
  const comfortable = document.documentElement.dataset.density === "comfortable";
  items.push({ group: "Appearance", icon: "density", label: `Switch to ${comfortable ? "compact" : "comfortable"} density`, hint: "d", keywords: "density spacing compact comfortable", run: toggleDensity });
  items.push({ group: "Snapshot", icon: "refresh", label: "Refresh snapshot", hint: "r", keywords: "reload rescan refresh", run: () => load(true) });
  items.push({ group: "Snapshot", icon: "help", label: "Keyboard shortcuts", hint: "?", keywords: "help keys shortcuts", run: openHelp });
  return items;
}

function matches(item, query) {
  if (!query) return true;
  const haystack = `${item.label} ${item.keywords || ""} ${item.group}`.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => {
    if (haystack.includes(term)) return true;
    let position = 0;
    for (const character of term) {
      position = haystack.indexOf(character, position);
      if (position < 0) return false;
      position += 1;
    }
    return true;
  });
}

function setPaletteActive(index) {
  if (!paletteOptions.length) { elements.commandInput.removeAttribute("aria-activedescendant"); return; }
  paletteActive = (index + paletteOptions.length) % paletteOptions.length;
  paletteOptions.forEach((option, position) => option.setAttribute("aria-selected", String(position === paletteActive)));
  const active = paletteOptions[paletteActive];
  elements.commandInput.setAttribute("aria-activedescendant", active.id);
  active.scrollIntoView({ block: "nearest" });
}

function renderPalette(query) {
  clear(elements.commandList); paletteOptions = [];
  const items = paletteItems().filter((item) => matches(item, query));
  let group = null, position = 0;
  for (const item of items) {
    if (item.group !== group) { group = item.group; elements.commandList.append(node("div", group, "palette-group")); }
    const option = node("div", null, "palette-option");
    option.id = `command-option-${position}`; option.setAttribute("role", "option"); option.setAttribute("aria-selected", "false");
    option.append(icon(item.icon), node("span", item.label, "option-label"));
    if (item.state !== undefined) { const state = node("i", null, "option-state"); state.dataset.on = String(item.state); option.append(state); }
    if (item.hint) option.append(node("span", item.hint, "option-hint"));
    const index = position;
    option.addEventListener("pointermove", () => { if (paletteActive !== index) setPaletteActive(index); });
    option.addEventListener("click", () => runPaletteItem(item));
    elements.commandList.append(option); paletteOptions.push(option); position += 1;
  }
  elements.commandList.dataset.items = JSON.stringify(items.map((item) => item.label));
  elements.commandList._items = items;
  if (!items.length) elements.commandList.append(node("div", "No matching command.", "palette-empty"));
  setPaletteActive(0);
}

function runPaletteItem(item) {
  closePalette();
  item.run();
}

function openPalette() {
  if (elements.help.open) elements.help.close();
  if (elements.palette.open) return;
  elements.commandInput.value = "";
  renderPalette("");
  elements.palette.showModal();
  elements.commandInput.focus();
}

function closePalette() { if (elements.palette.open) elements.palette.close(); }

function togglePalette() { if (elements.palette.open) closePalette(); else openPalette(); }

function openHelp() { closePalette(); if (!elements.help.open) elements.help.showModal(); }

function closeHelp() { if (elements.help.open) elements.help.close(); }

elements.commandInput.addEventListener("input", () => renderPalette(elements.commandInput.value));
elements.commandInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); setPaletteActive(paletteActive + 1); }
  else if (event.key === "ArrowUp") { event.preventDefault(); setPaletteActive(paletteActive - 1); }
  else if (event.key === "Home") { event.preventDefault(); setPaletteActive(0); }
  else if (event.key === "End") { event.preventDefault(); setPaletteActive(paletteOptions.length - 1); }
  else if (event.key === "Enter") {
    event.preventDefault();
    const item = elements.commandList._items?.[paletteActive];
    if (item) runPaletteItem(item);
  }
});
for (const dialog of [elements.palette, elements.help]) {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
}
elements.commandButton.addEventListener("click", openPalette);
elements.helpButton.addEventListener("click", openHelp);
elements.helpClose.addEventListener("click", closeHelp);

// --------------------------------------------------------------------- keyboard shortcuts

let pendingChord = null;
let chordTimer = 0;

function armChord(key) {
  pendingChord = key;
  window.clearTimeout(chordTimer);
  chordTimer = window.setTimeout(() => { pendingChord = null; }, 1500);
}

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  const key = event.key;
  if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === "k") { event.preventDefault(); togglePalette(); return; }
  if (elements.palette.open || elements.help.open) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.matches("input, select, textarea, [contenteditable]")) return;
  if (pendingChord) {
    const chord = pendingChord; pendingChord = null; window.clearTimeout(chordTimer);
    if (chord === "g" && viewChords[key]) { event.preventDefault(); switchView(viewChords[key]); }
    if (chord === "p" && ["1", "2", "3"].includes(key)) { event.preventDefault(); toggleProvider(providerOrder[Number(key) - 1]); }
    return;
  }
  if (key === "g" || key === "p") { armChord(key); return; }
  const presets = { 1: "7", 2: "30", 3: "90", 4: "all" };
  if (presets[key]) { applyWindowPreset(presets[key]); return; }
  if (key === "?") { event.preventDefault(); openHelp(); return; }
  if (key === "/") { event.preventDefault(); openPalette(); return; }
  if (key === "t") { toggleTheme(); return; }
  if (key === "d") { toggleDensity(); return; }
  if (key === "r") { if (!elements.refresh.disabled) load(true); return; }
  if (key === "[") { stepView(-1); return; }
  if (key === "]") { stepView(1); return; }
  if (key === "Escape" && snapshot && elements.repositoryFilter.value !== "all") selectRepository("all", { scroll: false });
});

// --------------------------------------------------------------------- loading

const urlParameters = new URLSearchParams(window.location.search);

function applyUrlAfterRender() {
  const repo = urlParameters.get("repo");
  if (repo) {
    const match = snapshot.repositories.find(({ repository }) => repository.name === repo || repository.id === repo);
    if (match) { elements.repositoryFilter.value = match.repository.id; renderView(); }
  }
  const open = urlParameters.get("open");
  if (open === "palette") openPalette();
  if (open === "help") openHelp();
  urlParameters.delete("repo"); urlParameters.delete("open");
}

function render(data) {
  snapshot = data; elements.generated.textContent = dateTime(data.generatedAt); elements.rateCardDate.textContent = `Rate card effective ${data.rateCard.effectiveDate}`;
  populateRepositories(); configureWindow(); renderRateCards(data.rateCard); ensureDistributionRepositories();
  delete elements.main.dataset.state;
  renderView();
  applyUrlAfterRender();
}

async function load(refresh = false) {
  elements.error.hidden = true; elements.sync.dataset.state = "loading"; elements.syncLabel.textContent = refresh ? "Refreshing local snapshot" : "Mapping local sessions"; elements.refresh.disabled = true;
  elements.main.dataset.state = snapshot ? "refreshing" : "loading";
  if (!snapshot && !elements.repositoryList.childElementCount) for (let index = 0; index < 5; index += 1) elements.repositoryList.append(node("div", null, "repo-skeleton"));
  try { const response = await fetch(`/api/analytics${refresh ? "?refresh=1" : ""}`); const body = await response.json(); if (!response.ok) throw new Error(body.error || `Analysis failed with ${response.status}.`); render(body); elements.sync.dataset.state = "live"; elements.syncLabel.textContent = "Local snapshot ready"; }
  catch (error) { elements.sync.dataset.state = "error"; elements.syncLabel.textContent = "Analysis failed"; elements.error.textContent = error instanceof Error ? error.message : "Unknown analysis failure."; elements.error.hidden = false; delete elements.main.dataset.state; if (!snapshot) clear(elements.repositoryList); }
  finally { elements.refresh.disabled = false; }
}

elements.refresh.addEventListener("click", () => load(true));
elements.repositoryFilter.addEventListener("change", renderView);
elements.scopeChip.addEventListener("click", () => selectRepository("all", { scroll: false }));
for (const button of windowButtons) button.addEventListener("click", () => { applyWindowPreset(button.dataset.windowPreset); if (button.dataset.windowPreset === "custom") elements.windowStart.focus(); });
elements.windowStart.addEventListener("change", () => applyCustomWindow("start"));
elements.windowEnd.addEventListener("change", () => applyCustomWindow("end"));
for (const filter of providerFilters) filter.addEventListener("change", () => snapshot && renderView());
for (const button of viewButtons) button.addEventListener("click", () => switchView(button.dataset.viewButton));
for (const button of sortButtons) button.addEventListener("click", () => {
  const key = button.dataset.sort;
  if (tableSort.key === key) tableSort = { key, direction: tableSort.direction === "descending" ? "ascending" : "descending" };
  else tableSort = { key, direction: key === "name" ? "ascending" : "descending" };
  if (snapshot) renderRepositoryTable(activeView().repositories);
});
for (const button of elements.modelMetricSwitch.querySelectorAll("[data-model-metric]")) {
  button.addEventListener("click", () => {
    modelMetric = button.dataset.modelMetric;
    for (const peer of elements.modelMetricSwitch.querySelectorAll("[data-model-metric]")) peer.setAttribute("aria-pressed", String(peer === button));
    if (snapshot) renderModels(activeView());
  });
}
elements.theme.addEventListener("click", toggleTheme);
elements.density.addEventListener("click", toggleDensity);

const macLike = /Mac|iPhone|iPad/.test(navigator.platform);
for (const key of document.querySelectorAll(".key-command")) key.textContent = macLike ? "⌘" : "Ctrl ";
const urlView = urlParameters.get("view");
const storedView = urlView && viewOrder.includes(urlView) ? urlView : localStorage.getItem("session-analytics-view");
switchView(viewPanels.some(({ dataset }) => dataset.viewPanel === storedView) ? storedView : "summary");
const urlTheme = urlParameters.get("theme");
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
setTheme(["dark", "light"].includes(urlTheme) ? urlTheme : localStorage.getItem("session-analytics-theme") || systemTheme);
const urlDensity = urlParameters.get("density");
setDensity(["compact", "comfortable"].includes(urlDensity) ? urlDensity : localStorage.getItem("session-analytics-density") || "compact");
const urlWindow = urlParameters.get("window");
setWindowPreset(windowPresets.includes(urlWindow) ? urlWindow : "all");
void load(false);
