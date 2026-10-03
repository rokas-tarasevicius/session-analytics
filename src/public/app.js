import { donutGradient, donutStops, layoutEndLabels, nearestIndex, positionAt, sharePercent } from "/chart-geometry.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  activityHeatmap: $("#activity-heatmap"), activityProviderFilters: $("#activity-provider-filters"),
  activityRepositories: $("#activity-repositories"),
  activityTooltip: $("#activity-tooltip"),
  cache: $("#metric-cache"), compactions: $("#metric-compactions"), dailySpend: $("#daily-spend"),
  costApiTotal: $("#cost-api-total"), costCoverage: $("#cost-coverage"),
  costProviderTotal: $("#cost-provider-total"), costUpperTotal: $("#cost-upper-total"),
  distributionCompactions: $("#distribution-compactions"), distributionCost: $("#distribution-cost"),
  distributionDuration: $("#distribution-duration"), distributionKey: $("#distribution-key"),
  distributionRepositoryOptions: $("#distribution-repository-options"), distributionTools: $("#distribution-tools"),
  error: $("#error-banner"),
  generated: $("#generated-at"), input: $("#metric-input"),
  live: $("#metric-live"), liveSignal: $("#live-signal"), main: $("main"), modelSpend: $("#model-spend"), output: $("#metric-output"),
  modelsByProvider: $("#models-by-provider"), modelMetricSwitch: $("#model-metric-switch"),
  providerCostComponents: $("#provider-cost-components"),
  providerDonut: $("#provider-donut"), providerLegend: $("#provider-legend"),
  rateCardDate: $("#rate-card-date"), rateCardLinks: $("#rate-card-links"), refresh: $("#refresh-button"),
  repositories: $("#metric-repositories"), repositorySubagentSpend: $("#repository-subagent-spend"),
  repositoryCostComponents: $("#repository-cost-components"),
  repositoryFilter: $("#repository-filter"), repositoryNote: $("#metric-repository-note"),
  repositoryRows: $("#repository-rows"), repositorySpend: $("#repository-spend"),
  repositoryTokens: $("#repository-tokens"), scope: $("#scope-description"),
  sessionNote: $("#metric-session-note"), sessions: $("#metric-sessions"),
  spend: $("#metric-spend"), spendNote: $("#metric-spend-note"),
  skillsByRepository: $("#skills-by-repository"), skillsDetail: $("#skills-detail"),
  skillsDetailTitle: $("#skills-detail-title"), skillsKey: $("#skills-key"),
  skillsProviderFilters: $("#skills-provider-filters"),
  sync: $("#sync-context"), syncLabel: $("#sync-label"),
  theme: $("#theme-switch"), themeLabel: $("#theme-label"), toolCalls: $("#tool-calls"),
  toolsByRepository: $("#tools-by-repository"), toolsDetail: $("#tools-detail"),
  toolsDetailTitle: $("#tools-detail-title"), toolsKey: $("#tools-key"),
  toolsProviderFilters: $("#tools-provider-filters"),
  tools: $("#metric-tools"), warning: $("#warning-banner"), warningList: $("#warning-list"),
  windowEnd: $("#window-end"), windowPreset: $("#window-preset"), windowStart: $("#window-start"),
};
const providerFilters = [...document.querySelectorAll("[data-provider-filter]")];
const viewButtons = [...document.querySelectorAll("[data-view-button]")];
const viewPanels = [...document.querySelectorAll("[data-view-panel]")];

let snapshot = null;
let modelMetric = "value";
let toolsDetailRepositoryId = null;
let skillsDetailRepositoryId = null;
const distributionRepositories = new Set();
const viewProviderFilters = {
  activity: new Set(["codex", "claude", "cursor"]),
  skills: new Set(["codex", "claude", "cursor"]),
  tools: new Set(["codex", "claude", "cursor"]),
};
// Series slots are CSS custom properties so light and dark modes step the same hues separately
// (each mode's set is validated for colour-vision separation in styles.css).
const seriesColors = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];
// Optional one-shot URL hooks (`?view=costs&theme=dark&repository=<name>`) for deep links and screenshots.
const urlParameters = new URLSearchParams(window.location.search);
let pendingRepository = urlParameters.get("repository");
const compact = new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" });
const integer = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const currency = new Intl.NumberFormat("en-US", { currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2, style: "currency" });
const money = (value) => currency.format(value || 0);
const percent = (value) => value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;

function dateTime(value) {
  if (!value) return "Unknown time";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined && value !== null) element.textContent = value;
  if (className) element.className = className;
  return element;
}

function clear(element) { element.replaceChildren(); }

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

function activeView() {
  const selected = selectedRepository();
  const scopeSessions = selected ? snapshot.sessions.filter(({ repositoryId }) => repositoryId === selected.repository.id) : snapshot.sessions;
  const windowSessions = sessionsInWindow(scopeSessions);
  const sourceRepositories = selected ? [selected] : snapshot.repositories;
  const repositories = sourceRepositories.map((item) => repositoryAggregate(item, windowSessions.filter(({ repositoryId }) => repositoryId === item.repository.id)));
  const sessions = windowSessions;
  const summary = summarize(sessions);
  return {
    dailySessions: scopeSessions, repositories, sessions, spendByDay: spendDays(sessions), spendByModel: mergeModels(sessions), topTools: namedTotals(sessions, "tools"), warnings: coverageWarnings(sessions),
    summary: { ...summary, repositories: repositories.length, repositoriesWithSessions: repositories.filter(({ summary: item }) => item.sessions > 0).length, workingSnapshots: sessions.filter(({ transcript }) => transcript.snapshotWhileWorking).length },
  };
}

function selectRepository(id) {
  elements.repositoryFilter.value = id;
  renderView();
  document.querySelector(".hero").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

function renderBars(container, items, formatter, limit = 9, onSelect = null) {
  clear(container);
  const visible = items.slice(0, limit);
  const maximum = Math.max(1, ...visible.map(({ value }) => value));
  if (!visible.length) { container.append(node("p", "No activity in this view.", "empty-state")); return; }
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

function switchView(name) {
  for (const button of viewButtons) {
    if (button.dataset.viewButton === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const panel of viewPanels) panel.hidden = panel.dataset.viewPanel !== name;
  localStorage.setItem("session-analytics-view", name);
  if (snapshot) renderView();
}

function currentViewName() {
  return viewButtons.find((button) => button.getAttribute("aria-current") === "page")?.dataset.viewButton || "summary";
}

function repositoryColor(id) {
  const selectedIndex = [...distributionRepositories].indexOf(id);
  const index = selectedIndex >= 0
    ? selectedIndex
    : Math.max(0, snapshot.repositories.findIndex(({ repository }) => repository.id === id));
  return seriesColors[index % seriesColors.length];
}

function sessionsForProviders(sessions, scope) {
  const selected = viewProviderFilters[scope];
  return sessions.filter(({ provider }) => selected.has(provider));
}

// Re-rendered controls keep keyboard focus: remember the focused control's key before a container is
// rebuilt and move focus back to the rebuilt control with the same key.
function focusedKey(container, attribute) {
  const active = document.activeElement;
  return active && container.contains(active) ? active.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null : null;
}

function restoreFocus(container, attribute, key) {
  if (key === null) return;
  const host = container.querySelector(`[${attribute}="${CSS.escape(key)}"]`);
  (host?.matches("button, input") ? host : host?.querySelector("input, button"))?.focus();
}

function renderViewProviderFilters(container, scope) {
  const focused = focusedKey(container, "data-provider"); clear(container);
  for (const provider of ["codex", "claude", "cursor"]) {
    const label = node("label", null, "provider-toggle"); label.dataset.provider = provider;
    const input = node("input"); input.type = "checkbox"; input.checked = viewProviderFilters[scope].has(provider);
    const logo = node("img"); logo.src = `/brands/${provider}.svg`; logo.alt = "";
    input.addEventListener("change", () => {
      if (input.checked) viewProviderFilters[scope].add(provider);
      else viewProviderFilters[scope].delete(provider);
      renderActiveAnalyticsView(activeView());
    });
    label.append(input, logo, document.createTextNode(providerLabels[provider])); container.append(label);
  }
  restoreFocus(container, "data-provider", focused);
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
  ensureDistributionRepositories();
  const focused = focusedKey(elements.distributionRepositoryOptions, "data-repository"); clear(elements.distributionRepositoryOptions);
  const sessionCounts = new Map();
  for (const { repositoryId } of snapshot.sessions) sessionCounts.set(repositoryId, (sessionCounts.get(repositoryId) || 0) + 1);
  const repositories = snapshot.repositories.filter(({ repository }) => sessionCounts.has(repository.id)).sort((left, right) => {
    const selectedOrder = Number(distributionRepositories.has(right.repository.id)) - Number(distributionRepositories.has(left.repository.id));
    if (selectedOrder !== 0) return selectedOrder;
    const activityOrder = (sessionCounts.get(right.repository.id) || 0) - (sessionCounts.get(left.repository.id) || 0);
    return activityOrder || left.repository.name.localeCompare(right.repository.name);
  });
  for (const { repository } of repositories) {
    const label = node("label", null, "compare-option"); label.dataset.repository = repository.id;
    label.style.setProperty("--series-color", repositoryColor(repository.id));
    const input = node("input"); input.type = "checkbox"; input.checked = distributionRepositories.has(repository.id);
    input.disabled = !input.checked && distributionRepositories.size >= seriesColors.length;
    input.addEventListener("change", () => {
      if (input.checked) distributionRepositories.add(repository.id);
      else distributionRepositories.delete(repository.id);
      renderDistributions();
    });
    label.append(input, document.createTextNode(`${repository.name} · ${integer.format(sessionCounts.get(repository.id) || 0)}`)); elements.distributionRepositoryOptions.append(label);
  }
  restoreFocus(elements.distributionRepositoryOptions, "data-repository", focused);
}

function svgElement(svg, tag, attributes) {
  const element = document.createElementNS(svg.namespaceURI, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function addSvgText(svg, value, x, y, anchor = "start", className = "axis-label") {
  const label = svgElement(svg, "text", { x, y, class: className, "text-anchor": anchor });
  label.textContent = value; svg.append(label); return label;
}

function renderDistributionChart(container, series, accessor, formatter, logarithmic = false) {
  clear(container);
  const valuesBySeries = series.map((item) => ({
    ...item,
    values: item.sessions.map(accessor).filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0),
  }));
  const allValues = valuesBySeries.flatMap(({ values }) => values);
  if (allValues.length === 0) { container.append(node("p", "No eligible sessions in this comparison.", "empty-state")); return; }
  const bins = 10, maximum = Math.max(1, ...allValues), width = 680, height = 245;
  const left = 42, right = 12, top = 14, bottom = 34, plotWidth = width - left - right, plotHeight = height - top - bottom;
  const position = logarithmic ? (value) => Math.log1p(value) : (value) => value;
  const valueAtPosition = logarithmic ? (value) => Math.expm1(value) : (value) => value;
  const maximumPosition = Math.max(1, position(maximum));
  const distributions = valuesBySeries.map((item) => {
    const counts = Array.from({ length: bins }, () => 0);
    for (const value of item.values) counts[Math.min(bins - 1, Math.floor((position(value) / maximumPosition) * bins))] += 1;
    return { ...item, shares: counts.map((count) => item.values.length ? count / item.values.length : 0) };
  });
  const yMaximum = Math.max(.01, ...distributions.flatMap(({ shares }) => shares));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Normalized repository distribution chart");
  for (let index = 0; index < 3; index += 1) {
    const y = top + (index / 2) * plotHeight;
    const line = document.createElementNS(svg.namespaceURI, "line");
    line.setAttribute("x1", String(left)); line.setAttribute("x2", String(width - right));
    line.setAttribute("y1", String(y)); line.setAttribute("y2", String(y)); line.setAttribute("class", "distribution-grid"); svg.append(line);
    addSvgText(svg, `${Math.round(yMaximum * (1 - index / 2) * 100)}%`, left - 7, y + 4, "end");
  }
  const axis = document.createElementNS(svg.namespaceURI, "line");
  axis.setAttribute("x1", String(left)); axis.setAttribute("x2", String(width - right));
  axis.setAttribute("y1", String(top + plotHeight)); axis.setAttribute("y2", String(top + plotHeight)); axis.setAttribute("class", "distribution-axis"); svg.append(axis);
  for (const index of [0, Math.floor((bins - 1) / 2), bins - 1]) {
    const x = left + (index / (bins - 1)) * plotWidth;
    addSvgText(svg, formatter(valueAtPosition((index / (bins - 1)) * maximumPosition)), x, height - 10, index === 0 ? "start" : index === bins - 1 ? "end" : "middle");
  }
  for (const item of distributions) {
    const color = repositoryColor(item.id);
    const points = item.shares.map((share, index) => ({
      x: left + (index / (bins - 1)) * plotWidth,
      y: top + (1 - share / yMaximum) * plotHeight,
    }));
    const polyline = document.createElementNS(svg.namespaceURI, "polyline");
    polyline.setAttribute("points", points.map(({ x, y }) => `${x},${y}`).join(" "));
    polyline.setAttribute("class", "distribution-line"); polyline.style.setProperty("--series-color", color); svg.append(polyline);
    for (const point of points) {
      const dot = document.createElementNS(svg.namespaceURI, "circle");
      dot.setAttribute("cx", String(point.x)); dot.setAttribute("cy", String(point.y)); dot.setAttribute("r", "2.5");
      dot.setAttribute("class", "distribution-dot"); dot.style.setProperty("--series-color", color); svg.append(dot);
    }
  }
  container.append(svg);
}

function renderDistributions() {
  renderDistributionRepositoryOptions(); clear(elements.distributionKey);
  const windowSessions = sessionsInWindow(snapshot.sessions);
  const series = snapshot.repositories.filter(({ repository }) => distributionRepositories.has(repository.id)).map(({ repository }) => ({
    id: repository.id,
    name: repository.name,
    sessions: windowSessions.filter(({ repositoryId }) => repositoryId === repository.id),
  }));
  for (const item of series) {
    const key = node("span"); const swatch = node("i"); swatch.style.setProperty("--series-color", repositoryColor(item.id));
    key.append(swatch, document.createTextNode(`${item.name} · ${item.sessions.length}`)); elements.distributionKey.append(key);
  }
  renderDistributionChart(elements.distributionDuration, series, ({ metrics }) => metrics.durationMilliseconds / 60_000, (value) => `${Math.round(value)}m`, true);
  renderDistributionChart(elements.distributionCost, series, (session) => session.costBasis === "api-list-price-equivalent" ? session.cost.totalUsd : null, (value) => money(value), true);
  renderDistributionChart(elements.distributionTools, series, ({ metrics }) => metrics.toolCalls, (value) => integer.format(value), true);
  renderDistributionChart(elements.distributionCompactions, series, ({ metrics }) => metrics.compactions, (value) => integer.format(value));
}

function renderActivity(view) {
  renderViewProviderFilters(elements.activityProviderFilters, "activity");
  elements.activityTooltip.hidden = true;
  const sessions = sessionsForProviders(view.sessions, "activity");
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
    elements.activityHeatmap.append(node("span", days[day], "heat-label"));
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
        if (event.key === "Escape") { hideTooltip(); return; }
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
    for (const [name, value] of components) {
      if (value <= 0) continue; const bar = node("i"); bar.dataset.component = name; bar.style.width = `${(value / total) * 100}%`; stack.append(bar);
    }
    row.append(stack, node("strong", money(total))); list.append(row);
  }
  if (list.childElementCount === 0) list.append(node("p", "No priced activity in this view.", "empty-state"));
  container.append(list);
  const legend = node("div", null, "cost-legend");
  for (const [name, label] of [["input", "Input"], ["cached", "Cache read"], ["write", "Cache write"], ["output", "Output"], ["reported", "Provider-reported"]]) {
    const item = node("span"); const swatch = node("i"); swatch.dataset.component = name; item.append(swatch, document.createTextNode(label)); legend.append(item);
  }
  container.append(legend);
}

function renderCosts(view) {
  const cost = costTotals(view.sessions);
  elements.costApiTotal.textContent = money(cost.total); elements.costUpperTotal.textContent = money(cost.upper);
  elements.costProviderTotal.textContent = money(cost.reported); elements.costCoverage.textContent = percent(view.summary.pricedTokenCoverage);
  renderCostRows(elements.providerCostComponents, ["codex", "claude", "cursor"].map((provider) => ({
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
  for (const provider of ["codex", "claude", "cursor"]) {
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
  if (elements.modelsByProvider.childElementCount === 0) elements.modelsByProvider.append(node("p", "No model activity in this view.", "empty-state"));
}

function evidenceLabel(sessions) {
  const evidence = new Set(sessions.map(({ skillEvidence }) => skillEvidence));
  if (evidence.has("explicit") && evidence.has("inferred")) return "Explicit + lower bound";
  if (evidence.has("explicit")) return "Explicit";
  if (evidence.has("inferred")) return "Lower bound";
  return "N/A";
}

function renderNamedDistribution({ view, field, keyContainer, tableContainer, detailContainer, detailTitle, providerScope, skillMode = false }) {
  const sessions = sessionsForProviders(view.sessions, providerScope);
  const names = namedTotals(sessions, field).slice(0, 6);
  const focused = focusedKey(tableContainer, "data-repository");
  clear(tableContainer); clear(keyContainer);
  const header = node("div", null, "distribution-row header-row");
  header.append(node("span", "Repository"), node("span", "Distribution"), node("span", field === "skills" ? "Observed" : "Calls"), node("span", skillMode ? "Coverage" : "Top")); tableContainer.append(header);
  const rows = view.repositories.map(({ repository }) => {
    const repositorySessions = sessions.filter(({ repositoryId }) => repositoryId === repository.id);
    const totals = new Map(namedTotals(repositorySessions, field).map(({ name, value }) => [name, value]));
    return { repository, sessions: repositorySessions, total: [...totals.values()].reduce((sum, value) => sum + value, 0), totals };
  }).filter(({ total }) => total > 0).sort((left, right) => right.total - left.total);
  for (const item of rows) {
    const row = node("div", null, "distribution-row"); const open = node("button", item.repository.name);
    open.type = "button"; open.dataset.repository = item.repository.id; open.addEventListener("click", () => {
      if (field === "skills") skillsDetailRepositoryId = item.repository.id; else toolsDetailRepositoryId = item.repository.id;
      renderActiveAnalyticsView(view);
    }); row.append(open);
    const stack = node("div", null, "distribution-stack");
    for (const [index, { name }] of names.entries()) {
      const value = item.totals.get(name) || 0; if (value === 0) continue;
      const fill = node("i"); fill.style.setProperty("--series-color", seriesColors[index]); fill.style.width = `${(value / item.total) * 100}%`; stack.append(fill);
    }
    const represented = names.reduce((sum, { name }) => sum + (item.totals.get(name) || 0), 0);
    if (represented < item.total) {
      const other = node("i"); other.dataset.other = "true"; other.style.width = `${((item.total - represented) / item.total) * 100}%`; stack.append(other);
    }
    const top = [...item.totals.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "—";
    row.append(stack, node("strong", integer.format(item.total)), node("span", skillMode ? evidenceLabel(item.sessions) : top)); tableContainer.append(row);
  }
  if (rows.length === 0) tableContainer.append(node("p", skillMode ? "No observed skill invocations in this view." : "No tool activity in this view.", "empty-state"));
  restoreFocus(tableContainer, "data-repository", focused);
  for (const [index, { name }] of names.entries()) {
    const item = node("span"); const swatch = node("i"); swatch.style.setProperty("--series-color", seriesColors[index]); item.append(swatch, document.createTextNode(name)); keyContainer.append(item);
  }
  if (rows.some((item) => names.reduce((sum, { name }) => sum + (item.totals.get(name) || 0), 0) < item.total)) {
    const item = node("span"); const swatch = node("i"); swatch.className = "other-swatch"; item.append(swatch, document.createTextNode("Other")); keyContainer.append(item);
  }
  let selectedId = field === "skills" ? skillsDetailRepositoryId : toolsDetailRepositoryId;
  if (!rows.some(({ repository }) => repository.id === selectedId)) selectedId = rows[0]?.repository.id ?? null;
  if (field === "skills") skillsDetailRepositoryId = selectedId; else toolsDetailRepositoryId = selectedId;
  const selectedRow = rows.find(({ repository }) => repository.id === selectedId);
  detailTitle.textContent = selectedRow?.repository.name || "No repository selected";
  renderBars(detailContainer, selectedRow ? namedTotals(selectedRow.sessions, field) : [], (value) => integer.format(value), 10);
}

function clearInactiveAnalyticsViews(activeName) {
  const containers = {
    activity: [elements.activityProviderFilters, elements.activityHeatmap, elements.activityRepositories],
    costs: [elements.providerCostComponents, elements.repositoryCostComponents],
    distributions: [elements.distributionRepositoryOptions, elements.distributionKey, elements.distributionDuration, elements.distributionCost, elements.distributionTools, elements.distributionCompactions],
    models: [elements.modelsByProvider],
    skills: [elements.skillsProviderFilters, elements.skillsByRepository, elements.skillsKey, elements.skillsDetail],
    tools: [elements.toolsProviderFilters, elements.toolsByRepository, elements.toolsKey, elements.toolsDetail],
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
  if (name === "tools") {
    renderViewProviderFilters(elements.toolsProviderFilters, "tools");
    renderNamedDistribution({ view, field: "tools", keyContainer: elements.toolsKey, tableContainer: elements.toolsByRepository, detailContainer: elements.toolsDetail, detailTitle: elements.toolsDetailTitle, providerScope: "tools" });
  }
  if (name === "skills") {
    renderViewProviderFilters(elements.skillsProviderFilters, "skills");
    renderNamedDistribution({ view, field: "skills", keyContainer: elements.skillsKey, tableContainer: elements.skillsByRepository, detailContainer: elements.skillsDetail, detailTitle: elements.skillsDetailTitle, providerScope: "skills", skillMode: true });
  }
}

function dailyProviderSpend(sessions) {
  const days = new Map();
  const first = new Date(`${elements.windowStart.value}T00:00:00Z`), last = new Date(`${elements.windowEnd.value}T00:00:00Z`);
  for (let day = first, count = 0; day <= last && count < 3660; day = new Date(day.valueOf() + 86_400_000), count += 1) {
    const name = day.toISOString().slice(0, 10);
    days.set(name, { name, codex: 0, claude: 0, cursor: 0 });
  }
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

function activeProviders() {
  return providerFilters.filter(({ checked }) => checked).map(({ dataset }) => dataset.providerFilter);
}

const providerLabels = { claude: "Claude", codex: "Codex", cursor: "Cursor" };

const dayFormatter = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const dayLabel = (name) => dayFormatter.format(new Date(`${name}T00:00:00`));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function renderLine(items) {
  clear(elements.dailySpend);
  const selectedProviders = activeProviders();
  const providers = selectedProviders.filter((provider) => items.some((item) => item[provider] > 0));
  if (!items.length || !selectedProviders.length || !providers.length) {
    const message = !selectedProviders.length
      ? "Choose at least one provider."
      : selectedProviders.length === 1 && selectedProviders[0] === "cursor"
        ? "Cursor has no trustworthy daily cost timestamps in the local store; its provider-reported total remains in the usage-value summaries."
        : "No daily priced activity in this view.";
    elements.dailySpend.append(node("p", message, "empty-state")); return;
  }
  const width = 900, height = 270, left = 64, right = 62, top = 16, bottom = 40;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = Math.max(0.001, ...items.flatMap((item) => providers.map((provider) => item[provider])));
  const roughTick = maximum / 4;
  const tickMagnitude = 10 ** Math.floor(Math.log10(roughTick));
  const tick = Math.ceil(roughTick / tickMagnitude) * tickMagnitude;
  const axisMaximum = tick * 4;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Daily priced usage value in US dollars by provider");
  const tooltip = node("div", null, "chart-tooltip"); tooltip.hidden = true;
  const xAt = (index) => positionAt(index, left, plotWidth, items.length);
  const yAt = (value) => top + (1 - value / axisMaximum) * plotHeight;
  for (let index = 0; index < 5; index += 1) {
    const value = axisMaximum * (1 - index / 4), y = yAt(value);
    svg.append(svgElement(svg, "line", { x1: left, x2: width - right, y1: y, y2: y, class: "grid-line" }));
    addSvgText(svg, Number.isInteger(value) ? `$${integer.format(value)}` : money(value), left - 10, y + 4, "end");
  }
  const tickIndexes = [...new Set([0, Math.round((items.length - 1) / 4), Math.round((items.length - 1) / 2), Math.round(((items.length - 1) * 3) / 4), items.length - 1])];
  for (const index of tickIndexes) addSvgText(svg, dayLabel(items[index].name), xAt(index), height - 14, index === 0 ? "start" : index === items.length - 1 ? "end" : "middle");
  const crosshair = svgElement(svg, "line", { x1: left, x2: left, y1: top, y2: top + plotHeight, class: "crosshair" });
  svg.append(crosshair);
  const series = providers.map((provider) => ({
    provider,
    points: items.map((item, index) => ({ index, value: item[provider], x: xAt(index), y: yAt(item[provider]) })),
  }));
  for (const { provider, points } of series) {
    svg.append(svgElement(svg, "polyline", { points: points.map(({ x, y }) => `${x},${y}`).join(" "), class: `trend-line ${provider}` }));
  }
  // Direct labels at the line ends stand in for a legend. They are laid out inside the plot with a minimum
  // spacing, and a label that had to leave its line end gets a short leader line back to it.
  const labels = layoutEndLabels(series.map(({ points }) => points.at(-1).y), top + 6, top + plotHeight, 14);
  series.forEach(({ provider, points }, position) => {
    const end = points.at(-1), { y, moved } = labels[position];
    if (moved) svg.append(svgElement(svg, "line", { x1: end.x + 4, y1: end.y, x2: width - right + 6, y2: y, class: "leader-line" }));
    addSvgText(svg, providerLabels[provider], width - right + 10, y + 4, "start", `series-label ${provider}`);
  });
  // The tooltip lists every provider for one day; its nodes are built once and updated in place.
  const tooltipDate = node("strong"); tooltip.append(tooltipDate);
  const tooltipValues = providers.map((provider) => {
    const row = node("div"), key = node("i"), value = node("b"); key.style.background = `var(--tip-${provider})`;
    row.append(key, value, node("span", providerLabels[provider])); tooltip.append(row); return value;
  });
  const pointGroups = new Map();
  let activeIndex = -1, activeGroups = [], focusedIndex = -1, frame = 0;
  const place = (x, y) => {
    const matrix = svg.getScreenCTM(); if (!matrix) return;
    const screen = new DOMPoint(x, y).matrixTransform(matrix), bounds = elements.dailySpend.getBoundingClientRect();
    tooltip.style.left = `${Math.min(bounds.width - 90, Math.max(90, screen.x - bounds.left))}px`;
    tooltip.style.top = `${screen.y - bounds.top}px`;
  };
  const hide = () => {
    for (const group of activeGroups) group.classList.remove("active");
    activeGroups = []; activeIndex = -1; crosshair.classList.remove("active"); tooltip.hidden = true;
  };
  const showAt = (index) => {
    if (index === activeIndex) return;
    for (const group of activeGroups) group.classList.remove("active");
    activeGroups = pointGroups.get(index) || []; activeIndex = index;
    for (const group of activeGroups) group.classList.add("active");
    const x = xAt(index);
    crosshair.setAttribute("x1", String(x)); crosshair.setAttribute("x2", String(x)); crosshair.classList.add("active");
    tooltipDate.textContent = dayLabel(items[index].name);
    providers.forEach((provider, position) => { tooltipValues[position].textContent = money(items[index][provider]); });
    tooltip.hidden = false;
    place(x, Math.min(...providers.map((provider) => yAt(items[index][provider]))));
  };
  for (const { provider, points } of series) for (const point of points) {
    // Zero-value dates stay in the polyline so missing calendar days are represented, but they do not
    // become hundreds of redundant controls. A single-day window keeps its markers visible at rest.
    if (point.value <= 0) continue;
    const group = svgElement(svg, "g", { class: `chart-point ${provider}${items.length === 1 ? " pinned" : ""}`, tabindex: "0", role: "button", "aria-label": `${providerLabels[provider]}, ${items[point.index].name}, ${money(point.value)}` });
    group.append(svgElement(svg, "circle", { cx: point.x, cy: point.y, r: "3.5", class: "trend-dot" }));
    group.addEventListener("focus", () => { focusedIndex = point.index; showAt(point.index); });
    group.addEventListener("blur", () => { focusedIndex = -1; hide(); });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); hide(); showAt(point.index); }
      else if (event.key === "Escape") hide();
    });
    svg.append(group);
    if (!pointGroups.has(point.index)) pointGroups.set(point.index, []);
    pointGroups.get(point.index).push(group);
  }
  // The crosshair finds the X. Pointer coordinates go through the SVG's screen matrix, so scaling and
  // letterboxing cannot shift the chosen day; moves are coalesced to one update per frame and only re-render
  // when the day changes; a tap or click opens the readout without a preceding move; a focused point keeps
  // its readout when the pointer leaves.
  const overlay = svgElement(svg, "rect", { x: left, y: top, width: plotWidth, height: plotHeight, class: "chart-overlay" });
  const indexAt = (event) => {
    const matrix = svg.getScreenCTM(); if (!matrix) return 0;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return nearestIndex(point.x, left, plotWidth, items.length);
  };
  overlay.addEventListener("pointermove", (event) => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; showAt(indexAt(event)); });
  });
  overlay.addEventListener("pointerdown", (event) => showAt(indexAt(event)));
  overlay.addEventListener("pointerleave", () => {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    hide();
    if (focusedIndex >= 0) showAt(focusedIndex);
  });
  svg.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); });
  svg.append(overlay);
  elements.dailySpend.append(svg, tooltip);
}

function renderDonut(sessions) {
  const counts = { codex: 0, claude: 0, cursor: 0 };
  for (const session of sessions) counts[session.provider] = (counts[session.provider] || 0) + 1;
  const total = sessions.length || 1;
  // Adjacent slices are separated by a sliver of the surface colour rather than a stroke; the sliver is
  // capped per slice so a small nonzero share keeps a painted arc.
  const stops = donutStops(["codex", "claude", "cursor"].map((provider) => ({ name: provider, share: (counts[provider] / total) * 100 })));
  elements.providerDonut.style.background = stops.length ? donutGradient(stops) : "var(--surface-2)";
  elements.providerDonut.dataset.label = String(sessions.length);
  clear(elements.providerLegend);
  [["Codex", counts.codex, "codex"], ["Claude", counts.claude, "claude"], ["Cursor", counts.cursor, "cursor"]].forEach(([label, value, provider]) => {
    const row = node("div", null, "legend-row"); row.dataset.provider = provider;
    const logo = node("img"); logo.src = `/brands/${provider}.svg`; logo.alt = "";
    row.append(logo, node("span", label), node("strong", integer.format(value)), node("small", sessions.length ? sharePercent(value, sessions.length) : "—"));
    elements.providerLegend.append(row);
  });
}

function tableCell(primary, secondary, className, numeric = false, secondaryClassName = null) {
  const cell = node("td", null, numeric ? "num" : null); cell.append(node("span", primary, className));
  if (secondary) cell.append(node("small", secondary, secondaryClassName)); return cell;
}

function repositoryKey(id) {
  return id.startsWith("discovered-") ? id.slice(-8) : id.slice(0, 8);
}

function cacheRatio(value) {
  const tokens = value.tokens || value;
  const denominator = tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheWriteInputTokens;
  return denominator ? tokens.cachedInputTokens / denominator : 0;
}

function renderRepositoryTable(repositories) {
  clear(elements.repositoryRows);
  for (const item of [...repositories].sort((a, b) => b.summary.estimatedSpendUsd - a.summary.estimatedSpendUsd)) {
    const row = node("tr"); const summary = item.summary;
    row.tabIndex = 0; row.setAttribute("role", "link"); row.setAttribute("aria-label", `Open metrics for ${item.repository.name}`);
    row.addEventListener("click", () => selectRepository(item.repository.id));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectRepository(item.repository.id); } });
    row.append(
      tableCell(item.repository.name, `ID ${repositoryKey(item.repository.id)}`),
      tableCell(String(summary.sessions), `${summary.topLevelSessions} top-level · ${summary.subagentSessions} sub-agent`, null, true),
      tableCell(money(summary.estimatedSpendUsd), `${money(summary.subagentSpendUsd)} sub-agent`, "money", true, "child-span"),
      tableCell(compact.format(summary.totalInputTokens), null, null, true),
      tableCell(compact.format(summary.outputTokens), null, null, true),
      tableCell(compact.format(summary.toolCalls), null, null, true),
      tableCell(percent(summary.cacheReadRatio), null, summary.cacheReadRatio === null ? null : "cache", true),
      tableCell(percent(summary.pricedTokenCoverage), summary.missingTranscripts ? `${summary.missingTranscripts} missing` : "complete", null, true, summary.missingTranscripts ? "status-warning" : "status-ok"),
    );
    elements.repositoryRows.append(row);
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
  clear(elements.repositoryFilter); elements.repositoryFilter.append(new Option("All repositories", "all"));
  for (const item of snapshot.repositories) elements.repositoryFilter.append(new Option(item.repository.name, item.repository.id));
}

function configureWindow() {
  const dates = snapshot.sessions.flatMap(({ createdAt, spendByDay }) => [createdAt.slice(0, 10), ...Object.keys(spendByDay)]).sort();
  const minimum = dates[0] || new Date().toISOString().slice(0, 10), maximum = dates.at(-1) || minimum;
  for (const input of [elements.windowStart, elements.windowEnd]) { input.min = minimum; input.max = maximum; }
  elements.windowStart.value = minimum; elements.windowEnd.value = maximum; elements.windowPreset.value = "all";
}

function applyWindowPreset() {
  const preset = elements.windowPreset.value;
  if (preset === "all") elements.windowStart.value = elements.windowStart.min;
  else if (preset !== "custom") {
    const start = new Date(`${elements.windowEnd.max}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - Number(preset) + 1);
    elements.windowStart.value = start.toISOString().slice(0, 10) < elements.windowStart.min ? elements.windowStart.min : start.toISOString().slice(0, 10);
  }
  if (preset !== "custom") elements.windowEnd.value = elements.windowEnd.max;
  renderView();
}

function applyCustomWindow(changed) {
  elements.windowPreset.value = "custom";
  if (elements.windowStart.value > elements.windowEnd.value) {
    if (changed === "start") elements.windowEnd.value = elements.windowStart.value;
    else elements.windowStart.value = elements.windowEnd.value;
  }
  renderView();
}

function windowCaption() {
  if (elements.windowStart.value === elements.windowStart.min && elements.windowEnd.value === elements.windowEnd.max) return "all observed dates";
  return `${elements.windowStart.value} through ${elements.windowEnd.value}`;
}

function renderSharedView(view) {
  const selected = selectedRepository();
  elements.main.dataset.scope = selected ? "repository" : "all";
  elements.scope.textContent = `${selected ? `Focused on ${selected.repository.name}.` : "Every repository evidenced by local agent history."} Sessions started during ${windowCaption()}.`;
  // Coverage notes live in the shared scope area and follow the current filters on every view.
  renderWarnings(view.warnings);
}

function renderSummary(view) {
  const summary = view.summary;
  elements.spend.textContent = money(summary.estimatedSpendUsd); elements.spendNote.textContent = `${money(summary.apiEquivalentSpendUsd)} API-equivalent · ${money(summary.providerReportedSpendUsd)} provider-reported · not an invoice`;
  elements.repositories.textContent = String(summary.repositories); elements.repositoryNote.textContent = `${summary.repositoriesWithSessions} with sessions`;
  elements.sessions.textContent = `${summary.analyzedSessions}/${summary.sessions}`; elements.sessionNote.textContent = `${summary.topLevelSessions} top-level · ${summary.subagentSessions} sub-agent`;
  elements.input.textContent = compact.format(summary.totalInputTokens); elements.cache.textContent = `${percent(summary.cacheReadRatio)} cached · repeated context included`;
  elements.output.textContent = compact.format(summary.outputTokens); elements.tools.textContent = compact.format(summary.toolCalls); elements.compactions.textContent = integer.format(summary.compactions); elements.live.textContent = integer.format(summary.workingSnapshots);
  elements.liveSignal.dataset.live = summary.workingSnapshots > 0 ? "active" : "idle";
  renderLine(dailyProviderSpend(view.dailySessions)); renderDonut(view.sessions);
  renderBars(elements.repositorySpend, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.estimatedSpendUsd })).sort((a, b) => b.value - a.value), money, 12, ({ id }) => selectRepository(id));
  renderBars(elements.repositoryTokens, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.totalInputTokens })).sort((a, b) => b.value - a.value), (value) => compact.format(value), 12, ({ id }) => selectRepository(id));
  renderBars(elements.modelSpend, view.spendByModel.map(({ model, provider, totalUsd }) => ({ name: model, value: totalUsd, provider })), money, 8);
  renderBars(elements.toolCalls, view.topTools, (value) => integer.format(value), 10);
  renderBars(elements.repositorySubagentSpend, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.subagentSpendUsd })).filter(({ value }) => value > 0).sort((a, b) => b.value - a.value), money, 10, ({ id }) => selectRepository(id));
  renderRepositoryTable(view.repositories);
}

function renderView() {
  const view = activeView();
  renderSharedView(view);
  if (currentViewName() === "summary") {
    clearInactiveAnalyticsViews("summary");
    renderSummary(view);
  } else {
    renderActiveAnalyticsView(view);
  }
}

function render(data) {
  snapshot = data; elements.generated.textContent = dateTime(data.generatedAt); elements.rateCardDate.textContent = `Rate card effective ${data.rateCard.effectiveDate}`;
  populateRepositories();
  if (pendingRepository) {
    const match = snapshot.repositories.find(({ repository }) => repository.name === pendingRepository);
    if (match) elements.repositoryFilter.value = match.repository.id;
    pendingRepository = null;
  }
  configureWindow(); renderRateCards(data.rateCard); ensureDistributionRepositories(); renderView();
}

async function load(refresh = false) {
  elements.error.hidden = true; elements.sync.dataset.state = "loading"; elements.syncLabel.textContent = refresh ? "Refreshing local snapshot" : "Mapping local sessions"; elements.refresh.disabled = true;
  // The previous render stays fully readable while a refresh runs; progress shows in the live status and a
  // sweep under the top bar, so there is no skeleton flash, layout jump, or dimmed text.
  document.body.dataset.state = "loading"; elements.main.setAttribute("aria-busy", "true");
  try { const response = await fetch(`/api/analytics${refresh ? "?refresh=1" : ""}`); const body = await response.json(); if (!response.ok) throw new Error(body.error || `Analysis failed with ${response.status}.`); render(body); elements.sync.dataset.state = "live"; elements.syncLabel.textContent = "Local snapshot ready"; document.body.dataset.state = "live"; }
  catch (error) { elements.sync.dataset.state = "error"; elements.syncLabel.textContent = "Analysis failed"; elements.error.textContent = error instanceof Error ? error.message : "Unknown analysis failure."; elements.error.hidden = false; document.body.dataset.state = "error"; }
  finally { elements.refresh.disabled = false; elements.main.setAttribute("aria-busy", "false"); }
}

function setTheme(theme) { document.documentElement.dataset.theme = theme; elements.themeLabel.textContent = theme === "dark" ? "Light" : "Dark"; localStorage.setItem("session-analytics-theme", theme); }
elements.refresh.addEventListener("click", () => load(true));
elements.repositoryFilter.addEventListener("change", renderView);
elements.windowPreset.addEventListener("change", applyWindowPreset);
elements.windowStart.addEventListener("change", () => applyCustomWindow("start"));
elements.windowEnd.addEventListener("change", () => applyCustomWindow("end"));
for (const filter of providerFilters) filter.addEventListener("change", () => snapshot && renderView());
for (const button of viewButtons) button.addEventListener("click", () => switchView(button.dataset.viewButton));
for (const button of elements.modelMetricSwitch.querySelectorAll("[data-model-metric]")) {
  button.addEventListener("click", () => {
    modelMetric = button.dataset.modelMetric;
    for (const peer of elements.modelMetricSwitch.querySelectorAll("[data-model-metric]")) peer.setAttribute("aria-pressed", String(peer === button));
    if (snapshot) renderModels(activeView());
  });
}
elements.theme.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
const requestedView = urlParameters.get("view"), requestedTheme = urlParameters.get("theme");
const storedView = viewPanels.some(({ dataset }) => dataset.viewPanel === requestedView) ? requestedView : localStorage.getItem("session-analytics-view");
switchView(viewPanels.some(({ dataset }) => dataset.viewPanel === storedView) ? storedView : "summary");
setTheme(requestedTheme === "dark" || requestedTheme === "light" ? requestedTheme : localStorage.getItem("session-analytics-theme") || "light"); void load(false);
