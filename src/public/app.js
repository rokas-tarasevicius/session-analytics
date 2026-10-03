import { compact, integer, ledeParts, longDate, median, money, nextChartIndex, niceMaximum, peakDay, percent, plural, share, shortDate, spelled, windowPhrase } from "./lib.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  activityHeatmap: $("#activity-heatmap"), activityNote: $("#activity-note"), activityProviderFilters: $("#activity-provider-filters"),
  activityRepositories: $("#activity-repositories"),
  activityTooltip: $("#activity-tooltip"),
  cache: $("#metric-cache"), compactions: $("#metric-compactions"), dailySpend: $("#daily-spend"),
  dailyStatus: $("#daily-status"), dailyTable: $("#daily-table-wrap"),
  costApiTotal: $("#cost-api-total"), costCoverage: $("#cost-coverage"),
  costProviderTotal: $("#cost-provider-total"), costUpperTotal: $("#cost-upper-total"),
  distributionCompactions: $("#distribution-compactions"), distributionCost: $("#distribution-cost"),
  distributionDuration: $("#distribution-duration"), distributionKey: $("#distribution-key"), distributionMatrix: $("#distribution-matrix"),
  distributionRepositoryOptions: $("#distribution-repository-options"), distributionTools: $("#distribution-tools"),
  error: $("#error-banner"),
  generated: $("#generated-at"), input: $("#metric-input"), lede: $("#lede"),
  live: $("#metric-live"), main: $("main"), modelSpend: $("#model-spend"), output: $("#metric-output"),
  modelsByProvider: $("#models-by-provider"), modelMetricSwitch: $("#model-metric-switch"),
  providerCostComponents: $("#provider-cost-components"),
  providerShare: $("#provider-share"), providerLegend: $("#provider-legend"),
  rateCardDate: $("#rate-card-date"), rateCardLinks: $("#rate-card-links"), refresh: $("#refresh-button"),
  repositories: $("#metric-repositories"), repositorySubagentSpend: $("#repository-subagent-spend"),
  repositoryCostComponents: $("#repository-cost-components"),
  repositoryFilter: $("#repository-filter"), repositoryNote: $("#metric-repository-note"),
  repositoryRows: $("#repository-rows"), repositorySpend: $("#repository-spend"), repositoryTotal: $("#repository-total"),
  repositoryTokens: $("#repository-tokens"), scope: $("#scope-description"),
  sessionNote: $("#metric-session-note"), sessions: $("#metric-sessions"),
  spend: $("#metric-spend"), spendNote: $("#metric-spend-note"),
  skillsByRepository: $("#skills-by-repository"), skillsDetail: $("#skills-detail"),
  skillsDetailTitle: $("#skills-detail-title"),
  skillsProviderFilters: $("#skills-provider-filters"),
  sync: $("#sync-context"), syncLabel: $("#sync-label"),
  theme: $("#theme-switch"), themeLabel: $("#theme-label"), toolCalls: $("#tool-calls"),
  toolsByRepository: $("#tools-by-repository"), toolsDetail: $("#tools-detail"),
  toolsDetailTitle: $("#tools-detail-title"),
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
let pendingRepositoryName = null;
let distributionsTouched = false;
/** State of the current daily chart; its listeners are bound once, below. */
let dailyChart = null;
const distributionRepositories = new Set();
const maximumComparedRepositories = 6;
const viewProviderFilters = {
  activity: new Set(["codex", "claude", "cursor"]),
  skills: new Set(["codex", "claude", "cursor"]),
  tools: new Set(["codex", "claude", "cursor"]),
};
const providerOrder = ["claude", "codex", "cursor"];
const providerLabels = { claude: "Claude", codex: "Codex", cursor: "Cursor" };
const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

function svgNode(tag, attributes = {}, className = null) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  if (className) element.setAttribute("class", className);
  return element;
}

function svgText(parent, value, x, y, className, anchor = "start") {
  const label = svgNode("text", { x, y, "text-anchor": anchor }, className);
  label.textContent = value; parent.append(label); return label;
}

function clear(element) { element.replaceChildren(); }

function groupBy(sessions, key) {
  const groups = new Map();
  for (const session of sessions) {
    const value = session[key];
    const group = groups.get(value);
    if (group) group.push(session); else groups.set(value, [session]);
  }
  return groups;
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
  return { repository: item.repository, sessions, spendByDay: spendDays(sessions), spendByModel: mergeModels(sessions), summary: summarize(sessions), topTools: namedTotals(sessions, "tools"), warnings: coverageWarnings(sessions) };
}

function activeView() {
  const selected = selectedRepository();
  const scopeSessions = selected ? snapshot.sessions.filter(({ repositoryId }) => repositoryId === selected.repository.id) : snapshot.sessions;
  const windowSessions = sessionsInWindow(scopeSessions);
  const byRepository = groupBy(windowSessions, "repositoryId");
  const sourceRepositories = selected ? [selected] : snapshot.repositories;
  const repositories = sourceRepositories.map((item) => repositoryAggregate(item, byRepository.get(item.repository.id) || []));
  const sessions = windowSessions;
  const summary = summarize(sessions);
  return {
    byRepository, dailySessions: scopeSessions, repositories, sessions, spendByDay: spendDays(sessions), spendByModel: mergeModels(sessions), topTools: namedTotals(sessions, "tools"), warnings: coverageWarnings(sessions),
    summary: { ...summary, repositories: repositories.length, repositoriesWithSessions: repositories.filter(({ summary: item }) => item.sessions > 0).length, workingSnapshots: sessions.filter(({ transcript }) => transcript.snapshotWhileWorking).length },
  };
}

function selectRepository(id) {
  elements.repositoryFilter.value = id;
  renderView();
  document.querySelector(".front-page").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

function renderBars(container, items, formatter, limit = 9, onSelect = null) {
  clear(container);
  const visible = items.slice(0, limit);
  const maximum = Math.max(1, ...visible.map(({ value }) => value));
  if (!visible.length) { container.append(node("p", "No activity in this view.", "muted")); return; }
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

function switchView(name, persist = true) {
  for (const button of viewButtons) {
    if (button.dataset.viewButton === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const panel of viewPanels) panel.hidden = panel.dataset.viewPanel !== name;
  if (persist) localStorage.setItem("session-analytics-view", name);
  if (snapshot) renderView();
}

function currentViewName() {
  return viewButtons.find((button) => button.getAttribute("aria-current") === "page")?.dataset.viewButton || "summary";
}

function sessionsForProviders(sessions, scope) {
  const selected = viewProviderFilters[scope];
  return sessions.filter(({ provider }) => selected.has(provider));
}

function providerLogo(provider) {
  const logo = node("img"); logo.src = `/brands/${provider}.svg`; logo.alt = ""; return logo;
}

/** Builds the per-view provider toggles once per visit and syncs them in place afterwards, so focus survives a change. */
function renderViewProviderFilters(container, scope) {
  const existing = [...container.querySelectorAll("input")];
  if (existing.length === providerOrder.length) {
    for (const input of existing) input.checked = viewProviderFilters[scope].has(input.dataset.provider);
    return;
  }
  clear(container);
  for (const provider of providerOrder) {
    const label = node("label", null, "provider-toggle");
    const input = node("input"); input.type = "checkbox"; input.checked = viewProviderFilters[scope].has(provider); input.dataset.provider = provider;
    input.addEventListener("change", () => {
      if (input.checked) viewProviderFilters[scope].add(provider);
      else viewProviderFilters[scope].delete(provider);
      renderActiveAnalyticsView(activeView());
    });
    label.append(input, providerLogo(provider), document.createTextNode(providerLabels[provider])); container.append(label);
  }
}

function ensureDistributionRepositories() {
  if (distributionRepositories.size > 0 || distributionsTouched) return;
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

/** Compare options keep a stable order and are updated in place, so toggling one never loses keyboard focus. */
function renderDistributionRepositoryOptions() {
  ensureDistributionRepositories();
  const sessionCounts = new Map();
  for (const { repositoryId } of snapshot.sessions) sessionCounts.set(repositoryId, (sessionCounts.get(repositoryId) || 0) + 1);
  const repositories = snapshot.repositories.filter(({ repository }) => sessionCounts.has(repository.id)).sort((left, right) =>
    (sessionCounts.get(right.repository.id) || 0) - (sessionCounts.get(left.repository.id) || 0) || left.repository.name.localeCompare(right.repository.name));
  const options = [...elements.distributionRepositoryOptions.querySelectorAll("label")];
  const reusable = options.length === repositories.length && options.every((option, index) => option.dataset.repository === repositories[index].repository.id);
  if (!reusable) {
    clear(elements.distributionRepositoryOptions);
    for (const { repository } of repositories) {
      const label = node("label", null, "compare-option"); label.dataset.repository = repository.id;
      const input = node("input"); input.type = "checkbox";
      input.addEventListener("change", () => {
        distributionsTouched = true;
        if (input.checked) distributionRepositories.add(repository.id);
        else distributionRepositories.delete(repository.id);
        renderDistributions();
      });
      label.append(input, node("b"), document.createTextNode(`${repository.name} · ${integer.format(sessionCounts.get(repository.id) || 0)}`)); elements.distributionRepositoryOptions.append(label);
    }
  }
  for (const label of elements.distributionRepositoryOptions.querySelectorAll("label")) {
    const input = label.querySelector("input"), position = [...distributionRepositories].indexOf(label.dataset.repository);
    input.checked = position >= 0;
    input.disabled = position < 0 && distributionRepositories.size >= maximumComparedRepositories;
    label.querySelector("b").textContent = position >= 0 ? String(position + 1).padStart(2, "0") : "··";
  }
}

function renderDistributionChart(container, series, accessor, formatter, logarithmic = false) {
  clear(container);
  const valuesBySeries = series.map((item) => ({
    ...item,
    values: item.sessions.map(accessor).filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0),
  }));
  const allValues = valuesBySeries.flatMap(({ values }) => values);
  if (allValues.length === 0) { container.append(node("p", "No eligible sessions in this comparison.", "muted")); return; }
  const bins = 10, maximum = Math.max(1, ...allValues), width = 220, height = 112;
  const left = 2, right = 2, top = 20, bottom = 20, plotWidth = width - left - right, plotHeight = height - top - bottom;
  const position = logarithmic ? (value) => Math.log1p(value) : (value) => value;
  const valueAtPosition = logarithmic ? (value) => Math.expm1(value) : (value) => value;
  const maximumPosition = Math.max(1, position(maximum));
  const distributions = valuesBySeries.map((item) => {
    const counts = Array.from({ length: bins }, () => 0);
    for (const value of item.values) counts[Math.min(bins - 1, Math.floor((position(value) / maximumPosition) * bins))] += 1;
    return { ...item, counts, median: median(item.values), shares: counts.map((count) => item.values.length ? count / item.values.length : 0) };
  });
  const yMaximum = Math.max(.01, ...distributions.flatMap(({ shares }) => shares));
  const binEdge = (index) => valueAtPosition((index / bins) * maximumPosition);
  for (const item of distributions) {
    const cell = node("div", null, "distribution-cell");
    const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${item.name}: ${integer.format(item.values.length)} sessions, median ${item.median === null ? "unavailable" : formatter(item.median)}` });
    svg.append(svgNode("line", { x1: left, x2: width - right, y1: top, y2: top }, "distribution-grid"));
    svg.append(svgNode("line", { x1: left, x2: width - right, y1: top + plotHeight, y2: top + plotHeight }, "distribution-axis"));
    svgText(svg, share(yMaximum), left, top - 6, "axis-label");
    const slot = plotWidth / bins;
    for (const [index, value] of item.shares.entries()) {
      const barHeight = Math.max(value > 0 ? 1.5 : 0, (value / yMaximum) * plotHeight);
      const bar = svgNode("rect", { x: left + index * slot + 1, y: top + plotHeight - barHeight, width: Math.max(1, slot - 2), height: barHeight }, "distribution-bar");
      const title = svgNode("title");
      title.textContent = `${share(value)} of sessions (${integer.format(item.counts[index])}) · ${formatter(binEdge(index))} to ${formatter(binEdge(index + 1))}`;
      bar.append(title); svg.append(bar);
    }
    if (item.median !== null && item.values.length > 0) {
      const x = left + (position(item.median) / maximumPosition) * plotWidth;
      svg.append(svgNode("line", { x1: x, x2: x, y1: top - 2, y2: top + plotHeight }, "distribution-median"));
      const rightSide = x < width * .62;
      svgText(svg, `median ${formatter(item.median)}`, rightSide ? Math.max(x + 5, left + 34) : x - 5, top - 6, "distribution-median-label", rightSide ? "start" : "end");
    }
    for (const index of [0, Math.floor(bins / 2), bins]) {
      const x = left + (index / bins) * plotWidth;
      svgText(svg, formatter(binEdge(index)), index === 0 ? left : index === bins ? width - right : x, height - 5, "axis-label", index === 0 ? "start" : index === bins ? "end" : "middle");
    }
    cell.append(svg); container.append(cell);
  }
}

function renderDistributions() {
  renderDistributionRepositoryOptions(); clear(elements.distributionKey);
  const windowSessions = sessionsInWindow(snapshot.sessions);
  const series = [...distributionRepositories].map((id) => snapshot.repositories.find(({ repository }) => repository.id === id)).filter(Boolean).map(({ repository }) => ({
    id: repository.id,
    name: repository.name,
    sessions: windowSessions.filter(({ repositoryId }) => repositoryId === repository.id),
  }));
  elements.distributionMatrix.style.setProperty("--columns", String(Math.max(1, series.length)));
  for (const [index, item] of series.entries()) {
    const column = node("div");
    column.append(node("h3", item.name), node("small", `${String(index + 1).padStart(2, "0")} · ${integer.format(item.sessions.length)} ${plural(item.sessions.length, "session")} in window`));
    elements.distributionKey.append(column);
  }
  if (!series.length) elements.distributionKey.append(node("small", "Choose at least one repository above."));
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
  let workingHours = 0;
  for (const session of sessions) {
    const date = new Date(session.createdAt); if (Number.isNaN(date.valueOf())) continue;
    const day = (date.getDay() + 6) % 7, hour = date.getHours();
    grid[day][hour] += 1;
    if (day < 5 && hour >= 9 && hour < 18) workingHours += 1;
  }
  const maximum = Math.max(1, ...grid.flat()); clear(elements.activityHeatmap);
  elements.activityHeatmap.setAttribute("role", "group");
  elements.activityHeatmap.setAttribute("aria-label", `Session starts by local weekday and hour for ${integer.format(sessions.length)} selected sessions.`);
  elements.activityHeatmap.append(node("span", "", "heat-hour"));
  for (let hour = 0; hour < 24; hour += 1) elements.activityHeatmap.append(node("span", hour % 4 === 0 ? String(hour).padStart(2, "0") : "", "heat-hour"));
  const sumHead = node("span", "Σ", "heat-sum head"); sumHead.setAttribute("aria-label", "Weekday total"); elements.activityHeatmap.append(sumHead);
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  let peak = { value: 0, day: 0, hour: 0 };
  const hideTooltip = () => { elements.activityTooltip.hidden = true; };
  for (let day = 0; day < 7; day += 1) {
    elements.activityHeatmap.append(node("span", days[day], "heat-label"));
    for (let hour = 0; hour < 24; hour += 1) {
      const value = grid[day][hour], cell = node("span", null, "heat-cell");
      const hourLabel = `${String(hour).padStart(2, "0")}:00–${String(hour).padStart(2, "0")}:59`;
      cell.dataset.level = value === 0 ? "0" : String(Math.max(1, Math.ceil((Math.log1p(value) / Math.log1p(maximum)) * 7)));
      cell.dataset.day = String(day);
      cell.dataset.hour = String(hour);
      cell.dataset.value = String(value);
      if (value > peak.value) peak = { value, day, hour, cell };
      cell.tabIndex = day === 0 && hour === 0 ? 0 : -1;
      cell.setAttribute("role", "img");
      cell.setAttribute("aria-label", `${integer.format(value)} session${value === 1 ? "" : "s"}, ${days[day]}, ${hourLabel}`);
      const showTooltip = () => {
        clear(elements.activityTooltip);
        elements.activityTooltip.append(
          node("strong", integer.format(value)),
          node("span", `${value === 1 ? "session" : "sessions"} · ${days[day].slice(0, 3)} · ${hourLabel}`),
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
    const rowTotal = grid[day].reduce((sum, value) => sum + value, 0);
    elements.activityHeatmap.append(node("span", rowTotal ? integer.format(rowTotal) : "0", "heat-sum"));
  }
  clear(elements.activityNote);
  if (sessions.length === 0) {
    elements.activityNote.append(document.createTextNode("No session starts in this window."));
  } else {
    peak.cell.dataset.peak = "true";
    elements.activityNote.append(
      document.createTextNode("Busiest hour: "),
      node("b", `${days[peak.day]} ${String(peak.hour).padStart(2, "0")}:00`),
      document.createTextNode(` with ${integer.format(peak.value)} ${plural(peak.value, "start")}; ${share(workingHours / sessions.length)} of starts fall on weekdays between 09:00 and 18:00.`),
    );
  }
  const byRepository = groupBy(sessions, "repositoryId");
  const repositories = view.repositories.map(({ repository }) => ({
    name: repository.name,
    value: (byRepository.get(repository.id) || []).length,
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

const costComponents = [["input", "Input"], ["output", "Output"], ["cached", "Cache read"], ["write", "Cache write"], ["reported", "Provider-reported"]];

function costStack(cost) {
  const total = cost.total + cost.reported;
  const stack = node("div", null, "cost-stack"); stack.setAttribute("role", "img");
  const described = [];
  for (const [name, label] of costComponents) {
    const value = cost[name];
    if (value <= 0) continue;
    const bar = node("i"); bar.dataset.component = name; bar.style.width = `${(value / total) * 100}%`;
    bar.title = `${label} · ${money(value)} · ${share(value / total)}`; stack.append(bar);
    described.push(`${label} ${share(value / total)}`);
  }
  stack.setAttribute("aria-label", `Composition: ${described.join(", ")}`);
  return stack;
}

function componentCell(value, total) {
  const cell = node("td", null, "component");
  if (value > 0) { cell.append(node("span", money(value)), node("small", share(value / total))); }
  else cell.append(node("span", "—", "muted"));
  return cell;
}

function renderCostRows(container, groups, basisFor) {
  clear(container);
  const rows = groups.filter((group) => group.cost.total + group.cost.reported > 0);
  if (!rows.length) { container.append(node("p", "No priced activity in this view.", "muted")); return; }
  const wrap = node("div", null, "table-wrap"), table = node("table", null, "ledger"), head = node("thead"), headRow = node("tr");
  headRow.append(node("th", ""), node("th", "Composition"));
  for (const [, label] of costComponents) headRow.append(node("th", label, "component"));
  headRow.append(node("th", "Total"));
  head.append(headRow); table.append(head);
  const body = node("tbody");
  const totals = { cached: 0, input: 0, output: 0, reported: 0, total: 0, write: 0 };
  for (const group of rows) {
    const total = group.cost.total + group.cost.reported;
    const row = node("tr"), name = node("td");
    name.append(node("span", group.name), node("small", basisFor(group)));
    const stackCell = node("td", null, "stack-cell"); stackCell.append(costStack(group.cost));
    row.append(name, stackCell);
    for (const [key] of costComponents) row.append(componentCell(group.cost[key], total));
    row.append(node("td", money(total), "total"));
    body.append(row);
    for (const key of Object.keys(totals)) totals[key] += group.cost[key];
  }
  table.append(body);
  if (rows.length > 1) {
    const foot = node("tfoot"), footRow = node("tr"), label = node("td"); label.append(node("span", "All listed"));
    const grand = totals.total + totals.reported;
    const stackCell = node("td", null, "stack-cell"); stackCell.append(costStack(totals));
    footRow.append(label, stackCell);
    for (const [key] of costComponents) footRow.append(componentCell(totals[key], grand));
    footRow.append(node("td", money(grand), "total")); foot.append(footRow); table.append(foot);
  }
  wrap.append(table); container.append(wrap);
  const legend = node("div", null, "cost-legend");
  for (const [name, label] of costComponents) {
    const item = node("span"); const swatch = node("i"); swatch.dataset.component = name; item.append(swatch, document.createTextNode(label)); legend.append(item);
  }
  container.append(legend);
}

function renderCosts(view) {
  const cost = costTotals(view.sessions);
  elements.costApiTotal.textContent = money(cost.total); elements.costUpperTotal.textContent = money(cost.upper);
  elements.costProviderTotal.textContent = money(cost.reported); elements.costCoverage.textContent = percent(view.summary.pricedTokenCoverage);
  const byProvider = groupBy(view.sessions, "provider");
  renderCostRows(elements.providerCostComponents, providerOrder.map((provider) => ({
    name: providerLabels[provider], provider, cost: costTotals(byProvider.get(provider) || []),
  })), ({ provider }) => provider === "cursor" ? "Provider-reported" : "API-equivalent");
  renderCostRows(elements.repositoryCostComponents, view.repositories.map(({ repository }) => ({
    name: repository.name, cost: costTotals(view.byRepository.get(repository.id) || []),
  })).sort((left, right) => (right.cost.total + right.cost.reported) - (left.cost.total + left.cost.reported)).slice(0, 12), ({ cost: item }) => item.reported > 0 && item.total > 0 ? "Mixed basis" : item.reported > 0 ? "Provider-reported" : "API-equivalent");
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
  const byProvider = groupBy(sessions, "provider");
  for (const provider of providerOrder) {
    const providerModels = models.filter((model) => model.provider === provider);
    if (providerModels.length === 0) continue;
    const group = node("section", null, "provider-model-group"); group.style.setProperty("--provider-color", `var(--${provider})`);
    const header = node("header"); const title = node("div"); const heading = node("h2");
    heading.append(providerLogo(provider), document.createTextNode(providerLabels[provider]));
    const providerSessions = (byProvider.get(provider) || []).length;
    title.append(heading, node("div", `${integer.format(providerSessions)} ${plural(providerSessions, "session")} · ${providerModels.length} ${plural(providerModels.length, "model")}`));
    header.append(title, node("span", provider === "cursor" ? "Provider-reported value" : "API-equivalent value", "pill")); group.append(header);
    const providerTotal = providerModels.reduce((sum, model) => sum + metric.value(model), 0);
    const maximum = Math.max(1, ...providerModels.map(metric.value));
    for (const model of providerModels.sort((left, right) => metric.value(right) - metric.value(left))) {
      const row = node("div", null, "model-row"); row.append(node("span", model.model));
      const track = node("div", null, "model-track"), fill = node("i"); fill.style.width = `${Math.max(1, (metric.value(model) / maximum) * 100)}%`; track.append(fill);
      const modelSessions = sessionsPerModel.get(`${provider}:${model.model}`) || 0;
      row.append(track, node("strong", metric.format(metric.value(model))), node("em", `${providerTotal ? share(metric.value(model) / providerTotal) : "—"} of ${providerLabels[provider]} · ${integer.format(modelSessions)} ${plural(modelSessions, "session")}${provider === "cursor" || model.priced ? "" : " · unpriced"}`)); group.append(row);
    }
    elements.modelsByProvider.append(group);
  }
  if (elements.modelsByProvider.childElementCount === 0) elements.modelsByProvider.append(node("p", "No model activity in this view.", "muted"));
}

function evidenceLabel(sessions) {
  const evidence = new Set(sessions.map(({ skillEvidence }) => skillEvidence));
  if (evidence.has("explicit") && evidence.has("inferred")) return "Explicit + lower bound";
  if (evidence.has("explicit")) return "Explicit";
  if (evidence.has("inferred")) return "Lower bound";
  return "N/A";
}

function renderNamedDistribution({ view, field, tableContainer, detailContainer, detailTitle, providerScope, skillMode = false }) {
  const sessions = sessionsForProviders(view.sessions, providerScope);
  const names = namedTotals(sessions, field).slice(0, 6);
  const focused = document.activeElement?.dataset?.repository && tableContainer.contains(document.activeElement) ? document.activeElement.dataset.repository : null;
  clear(tableContainer);
  const byRepository = groupBy(sessions, "repositoryId");
  const rows = view.repositories.map(({ repository }) => {
    const repositorySessions = byRepository.get(repository.id) || [];
    const totals = new Map(namedTotals(repositorySessions, field).map(({ name, value }) => [name, value]));
    return { repository, sessions: repositorySessions, total: [...totals.values()].reduce((sum, value) => sum + value, 0), totals };
  }).filter(({ total }) => total > 0).sort((left, right) => right.total - left.total);
  let selectedId = field === "skills" ? skillsDetailRepositoryId : toolsDetailRepositoryId;
  if (!rows.some(({ repository }) => repository.id === selectedId)) selectedId = rows[0]?.repository.id ?? null;
  if (field === "skills") skillsDetailRepositoryId = selectedId; else toolsDetailRepositoryId = selectedId;
  if (rows.length === 0) {
    tableContainer.append(node("p", skillMode ? "No observed skill invocations in this view." : "No tool activity in this view.", "muted"));
  } else {
    const hasOther = rows.some((item) => names.reduce((sum, { name }) => sum + (item.totals.get(name) || 0), 0) < item.total);
    const table = node("table", null, "share-matrix"), head = node("thead"), headRow = node("tr");
    headRow.append(node("th", "Repository"));
    for (const { name } of names) { const cell = node("th", null, "name-head"); cell.append(node("b", name)); cell.title = name; headRow.append(cell); }
    if (hasOther) { const cell = node("th", null, "name-head"); cell.append(node("b", "Other")); headRow.append(cell); }
    headRow.append(node("th", field === "skills" ? "Observed" : "Calls"), node("th", skillMode ? "Coverage" : "Top"));
    head.append(headRow); table.append(head);
    const body = node("tbody");
    for (const item of rows) {
      const row = node("tr"); row.setAttribute("aria-selected", String(item.repository.id === selectedId));
      const nameCell = node("td", null, "name"); const open = node("button", item.repository.name);
      open.type = "button"; open.dataset.repository = item.repository.id;
      open.setAttribute("aria-label", `Show ${skillMode ? "skills" : "tools"} for ${item.repository.name}`);
      open.addEventListener("click", () => {
        if (field === "skills") skillsDetailRepositoryId = item.repository.id; else toolsDetailRepositoryId = item.repository.id;
        renderActiveAnalyticsView(view);
      }); nameCell.append(open); row.append(nameCell);
      const represented = names.reduce((sum, { name }) => sum + (item.totals.get(name) || 0), 0);
      const values = names.map(({ name }) => item.totals.get(name) || 0);
      if (hasOther) values.push(item.total - represented);
      for (const value of values) {
        const cell = node("td", null, "cell"), ratio = value / item.total, text = node("span", share(ratio));
        text.style.setProperty("--share", String(ratio)); if (value === 0) text.dataset.zero = "true";
        text.title = `${integer.format(value)} of ${integer.format(item.total)}`; cell.append(text); row.append(cell);
      }
      const top = [...item.totals.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "—";
      row.append(node("td", integer.format(item.total), "total"), node("td", skillMode ? evidenceLabel(item.sessions) : top, "meta")); body.append(row);
    }
    table.append(body); tableContainer.append(table);
    if (focused) tableContainer.querySelector(`button[data-repository="${focused}"]`)?.focus();
  }
  const selectedRow = rows.find(({ repository }) => repository.id === selectedId);
  detailTitle.textContent = selectedRow?.repository.name || "No repository selected";
  renderBars(detailContainer, selectedRow ? namedTotals(selectedRow.sessions, field) : [], (value) => integer.format(value), 10);
}

function clearInactiveAnalyticsViews(activeName) {
  const containers = {
    activity: [elements.activityProviderFilters, elements.activityHeatmap, elements.activityRepositories, elements.activityNote],
    costs: [elements.providerCostComponents, elements.repositoryCostComponents],
    distributions: [elements.distributionRepositoryOptions, elements.distributionKey, elements.distributionDuration, elements.distributionCost, elements.distributionTools, elements.distributionCompactions],
    models: [elements.modelsByProvider],
    skills: [elements.skillsProviderFilters, elements.skillsByRepository, elements.skillsDetail],
    tools: [elements.toolsProviderFilters, elements.toolsByRepository, elements.toolsDetail],
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
    renderNamedDistribution({ view, field: "tools", tableContainer: elements.toolsByRepository, detailContainer: elements.toolsDetail, detailTitle: elements.toolsDetailTitle, providerScope: "tools" });
  }
  if (name === "skills") {
    renderViewProviderFilters(elements.skillsProviderFilters, "skills");
    renderNamedDistribution({ view, field: "skills", tableContainer: elements.skillsByRepository, detailContainer: elements.skillsDetail, detailTitle: elements.skillsDetailTitle, providerScope: "skills", skillMode: true });
  }
}

/** Daily value per provider for every calendar day in the window; the same series feeds the chart, the table and the lede. */
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

function renderDailyTable(items, providers) {
  clear(elements.dailyTable);
  const table = node("table", null, "daily-values"), head = node("thead"), headRow = node("tr");
  headRow.append(node("th", "Day"));
  for (const provider of providers) headRow.append(node("th", providerLabels[provider]));
  headRow.append(node("th", "Total")); head.append(headRow); table.append(head);
  const body = node("tbody");
  for (const item of items) {
    const row = node("tr"); row.append(node("td", longDate(item.name)));
    for (const provider of providers) row.append(node("td", money(item[provider])));
    row.append(node("td", money(providers.reduce((sum, provider) => sum + item[provider], 0)))); body.append(row);
  }
  table.append(body); elements.dailyTable.append(table);
}

function renderLine(items) {
  clear(elements.dailySpend); clear(elements.dailyTable); elements.dailyStatus.textContent = "";
  elements.dailySpend.removeAttribute("tabindex"); elements.dailySpend.removeAttribute("role"); elements.dailySpend.removeAttribute("aria-label"); elements.dailySpend.removeAttribute("aria-describedby");
  dailyChart = null;
  const selectedProviders = activeProviders();
  const providers = providerOrder.filter((provider) => selectedProviders.includes(provider) && items.some((item) => item[provider] > 0));
  if (!items.length || !selectedProviders.length || !providers.length) {
    const message = !selectedProviders.length
      ? "Choose at least one provider."
      : selectedProviders.length === 1 && selectedProviders[0] === "cursor"
        ? "Cursor has no trustworthy daily cost timestamps in the local store; its provider-reported total remains in the usage-value summaries."
        : "No daily priced activity in this view.";
    elements.dailySpend.append(node("p", message, "muted")); return;
  }
  const width = 900, left = 58, right = 118, top = 6, panelHeight = 104, panelGap = 22, bottom = 26;
  const plotWidth = width - left - right;
  const height = top + providers.length * (panelHeight + panelGap) - panelGap + bottom;
  const axisMaximum = niceMaximum(Math.max(...items.flatMap((item) => providers.map((provider) => item[provider]))));
  const x = (index) => items.length === 1 ? left + plotWidth / 2 : left + (index / (items.length - 1)) * plotWidth;
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  const tooltip = node("div", null, "chart-tooltip"); tooltip.hidden = true;
  const panels = [], descriptions = [];
  for (const [index, provider] of providers.entries()) {
    const panelTop = top + index * (panelHeight + panelGap), plotTop = panelTop + 22, plotBottom = panelTop + panelHeight;
    const y = (value) => plotBottom - (value / axisMaximum) * (plotBottom - plotTop);
    const group = svgNode("g", { "data-provider": provider }, "mult");
    group.append(svgNode("line", { x1: left, x2: width - right, y1: plotTop, y2: plotTop }, "grid-line"));
    group.append(svgNode("line", { x1: left, x2: width - right, y1: plotBottom, y2: plotBottom }, "baseline"));
    svgText(group, money(axisMaximum), left - 8, plotTop + 4, "axis-label", "end");
    svgText(group, "$0", left - 8, plotBottom + 4, "axis-label", "end");
    const values = items.map((item) => item[provider]);
    const total = values.reduce((sum, value) => sum + value, 0), average = total / values.length;
    const points = values.map((value, position) => ({ x: x(position), y: y(value) }));
    group.append(svgNode("path", { d: `M${points[0].x},${plotBottom} ${points.map(({ x: px, y: py }) => `L${px},${py}`).join(" ")} L${points.at(-1).x},${plotBottom} Z` }, "mult-area"));
    group.append(svgNode("polyline", { points: points.map(({ x: px, y: py }) => `${px},${py}`).join(" ") }, "mult-line"));
    group.append(svgNode("line", { x1: left, x2: width - right, y1: y(average), y2: y(average) }, "mult-avg"));
    svgText(group, `avg ${money(average)}/day`, width - right + 8, y(average) + 4, "mult-avg-label");
    svgText(group, providerLabels[provider], left, panelTop + 12, "mult-title");
    svgText(group, `${money(total)} in window`, width - right, panelTop + 12, "mult-total", "end");
    const peakIndex = values.indexOf(Math.max(...values));
    let description = `${providerLabels[provider]}: ${money(total)} in the window, average ${money(average)} per day`;
    if (values[peakIndex] > 0) {
      const peak = points[peakIndex];
      group.append(svgNode("circle", { cx: peak.x, cy: peak.y, r: 4 }, "mult-peak"));
      const anchor = peak.x < left + 90 ? "start" : peak.x > width - right - 90 ? "end" : "middle";
      const label = svgNode("text", { x: peak.x, y: Math.max(plotTop + 2, peak.y - 10), "text-anchor": anchor }, "mult-peak-label");
      const value = svgNode("tspan", {}, "v"); value.textContent = money(values[peakIndex]);
      label.append(document.createTextNode(`busiest day ${shortDate(items[peakIndex].name)} · `), value); group.append(label);
      description += `, busiest day ${longDate(items[peakIndex].name)} at ${money(values[peakIndex])}`;
    }
    descriptions.push(description);
    panels.push({ provider, values, y, group, dot: null });
    svg.append(group);
  }
  svg.setAttribute("aria-label", `Daily priced usage value, one panel per provider on a shared scale. ${descriptions.join(". ")}.`);
  const axisY = height - 8;
  const tickIndexes = [...new Set([0, Math.round((items.length - 1) / 4), Math.round((items.length - 1) / 2), Math.round(((items.length - 1) * 3) / 4), items.length - 1])];
  for (const index of tickIndexes) svgText(svg, shortDate(items[index].name), x(index), axisY, "axis-label", index === 0 ? "start" : index === items.length - 1 ? "end" : "middle");
  const crosshair = svgNode("g", { visibility: "hidden" });
  const crosshairLine = svgNode("line", { x1: 0, x2: 0, y1: top, y2: height - bottom + 6 }, "crosshair"); crosshair.append(crosshairLine);
  for (const panel of panels) { panel.dot = svgNode("circle", { cx: 0, cy: 0, r: 4 }, "crosshair-dot"); panel.dot.setAttribute("data-provider", panel.provider); panel.group.append(panel.dot); panel.dot.setAttribute("visibility", "hidden"); }
  const hit = svgNode("rect", { x: left - 6, y: top, width: plotWidth + 12, height: height - top - bottom + 6 }, "hit-layer");
  svg.append(crosshair, hit);
  const chart = { activeIndex: -1, length: items.length };
  chart.showIndex = (index) => {
    chart.activeIndex = Math.max(0, Math.min(items.length - 1, index));
    const px = x(chart.activeIndex);
    crosshairLine.setAttribute("x1", String(px)); crosshairLine.setAttribute("x2", String(px)); crosshair.setAttribute("visibility", "visible");
    clear(tooltip); tooltip.append(node("p", longDate(items[chart.activeIndex].name), "tooltip-date"));
    const readout = [];
    for (const panel of panels) {
      panel.dot.setAttribute("cx", String(px)); panel.dot.setAttribute("cy", String(panel.y(panel.values[chart.activeIndex]))); panel.dot.setAttribute("visibility", "visible");
      const row = node("div", null, "tooltip-row"); row.style.setProperty("--series", `var(--${panel.provider})`);
      row.append(node("i"), node("span", providerLabels[panel.provider]), node("strong", money(panel.values[chart.activeIndex]))); tooltip.append(row);
      readout.push(`${providerLabels[panel.provider]} ${money(panel.values[chart.activeIndex])}`);
    }
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(84, Math.max(16, (px / width) * 100))}%`;
    tooltip.style.top = `${((top + 26) / height) * 100}%`;
    elements.dailyStatus.textContent = `${longDate(items[chart.activeIndex].name)}: ${readout.join(", ")}`;
  };
  chart.hide = () => { chart.activeIndex = -1; crosshair.setAttribute("visibility", "hidden"); tooltip.hidden = true; for (const panel of panels) panel.dot.setAttribute("visibility", "hidden"); };
  const indexAt = (event) => {
    const rect = svg.getBoundingClientRect();
    const ratio = ((event.clientX - rect.left) / rect.width) * width;
    return items.length === 1 ? 0 : Math.round(((ratio - left) / plotWidth) * (items.length - 1));
  };
  hit.addEventListener("pointermove", (event) => chart.showIndex(indexAt(event)));
  hit.addEventListener("pointerleave", chart.hide);
  dailyChart = chart;
  elements.dailySpend.tabIndex = 0;
  elements.dailySpend.setAttribute("role", "group");
  elements.dailySpend.setAttribute("aria-label", `Daily priced usage value for ${providers.map((provider) => providerLabels[provider]).join(" and ")}. Left and right arrows read the values day by day; Home and End jump to the first and last day; Escape clears the reading. The same values follow as a table.`);
  elements.dailySpend.setAttribute("aria-describedby", "daily-status");
  elements.dailySpend.append(svg, tooltip);
  renderDailyTable(items, providers);
}

// The daily chart's keyboard handlers are bound once here; each render only
// swaps the `dailyChart` state, so rerenders never accumulate listeners.
elements.dailySpend.addEventListener("keydown", (event) => {
  if (!dailyChart) return;
  const next = nextChartIndex(event.key, dailyChart.activeIndex, dailyChart.length);
  if (next === null) return;
  event.preventDefault();
  if (next === "hide") dailyChart.hide(); else dailyChart.showIndex(next);
});
elements.dailySpend.addEventListener("focus", () => { if (dailyChart && dailyChart.activeIndex < 0) dailyChart.showIndex(dailyChart.length - 1); });
elements.dailySpend.addEventListener("blur", () => dailyChart?.hide());

function renderProviderShare(sessions) {
  const counts = { codex: 0, claude: 0, cursor: 0 };
  for (const session of sessions) counts[session.provider] = (counts[session.provider] || 0) + 1;
  const total = sessions.length;
  clear(elements.providerShare); clear(elements.providerLegend);
  const bar = node("div", null, "share-bar"); bar.setAttribute("role", "img"); bar.setAttribute("aria-label", `Session share: ${providerOrder.map((provider) => `${providerLabels[provider]} ${integer.format(counts[provider])}`).join(", ")}`);
  for (const provider of providerOrder) {
    if (!counts[provider]) continue;
    const segment = node("i"); segment.dataset.provider = provider; segment.style.width = `${(counts[provider] / total) * 100}%`; bar.append(segment);
  }
  const figure = node("div", null, "share-figure"); figure.append(document.createTextNode(integer.format(total)), node("small", `${plural(total, "session")} in window`));
  elements.providerShare.append(figure, bar);
  for (const provider of providerOrder) {
    const row = node("div", null, "legend-row"); row.dataset.provider = provider;
    row.append(node("i"), providerLogo(provider), node("span", providerLabels[provider]), node("strong", integer.format(counts[provider])), node("em", total ? share(counts[provider] / total) : "—"));
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

function renderRepositoryTable(repositories, summary) {
  clear(elements.repositoryRows); clear(elements.repositoryTotal);
  const sorted = [...repositories].sort((a, b) => b.summary.estimatedSpendUsd - a.summary.estimatedSpendUsd);
  for (const item of sorted) {
    const row = node("tr"); const line = item.summary;
    const nameCell = node("td"); const open = node("button", item.repository.name, "row-link");
    open.type = "button"; open.setAttribute("aria-label", `Open metrics for ${item.repository.name}`);
    open.addEventListener("click", (event) => { event.stopPropagation(); selectRepository(item.repository.id); });
    nameCell.append(open, node("small", `ID ${repositoryKey(item.repository.id)}`));
    row.addEventListener("click", () => selectRepository(item.repository.id));
    row.append(nameCell, tableCell(integer.format(line.sessions), `${line.topLevelSessions} top-level · ${line.subagentSessions} sub-agent`), tableCell(money(line.estimatedSpendUsd), `${money(line.subagentSpendUsd)} sub-agent`, "money"), tableCell(compact.format(line.totalInputTokens)), tableCell(compact.format(line.outputTokens)), tableCell(compact.format(line.toolCalls)), tableCell(percent(line.cacheReadRatio)), tableCell(percent(line.pricedTokenCoverage), line.missingTranscripts ? `${line.missingTranscripts} missing` : "complete"));
    elements.repositoryRows.append(row);
  }
  if (sorted.length > 1) {
    const row = node("tr");
    row.append(tableCell(`All ${spelled(sorted.length)} repositories`), tableCell(integer.format(summary.sessions), `${summary.topLevelSessions} top-level · ${summary.subagentSessions} sub-agent`), tableCell(money(summary.estimatedSpendUsd), `${money(summary.subagentSpendUsd)} sub-agent`, "money"), tableCell(compact.format(summary.totalInputTokens)), tableCell(compact.format(summary.outputTokens)), tableCell(compact.format(summary.toolCalls)), tableCell(percent(summary.cacheReadRatio)), tableCell(percent(summary.pricedTokenCoverage), summary.missingTranscripts ? `${summary.missingTranscripts} missing` : "complete"));
    elements.repositoryTotal.append(row);
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

function currentWindowPhrase() {
  return windowPhrase({ start: elements.windowStart.value, end: elements.windowEnd.value, min: elements.windowStart.min, max: elements.windowEnd.max, preset: elements.windowPreset.value });
}

function renderSharedView(view) {
  const selected = selectedRepository(); const summary = view.summary;
  elements.scope.textContent = `${selected ? `Focused on ${selected.repository.name}.` : `${summary.repositories === 1 ? "One repository" : `All ${spelled(summary.repositories)} repositories`} evidenced by local agent history.`} Sessions started during ${windowCaption()}.`;
}

function renderLede(view, dailyItems) {
  const selected = selectedRepository();
  const valueByProvider = { claude: 0, codex: 0, cursor: 0 };
  for (const session of view.sessions) valueByProvider[session.provider] += session.cost.totalUsd;
  const busiest = !selected && view.repositories.length > 1 ? [...view.repositories].sort((left, right) => right.summary.sessions - left.summary.sessions)[0] : null;
  const parts = ledeParts({
    summary: view.summary,
    selectedName: selected?.repository.name ?? null,
    phrase: currentWindowPhrase(),
    valueByProvider,
    providerLabels,
    busiest: busiest && busiest.summary.sessions > 0 ? { name: busiest.repository.name, sessions: busiest.summary.sessions } : null,
    peak: peakDay(dailyItems, providerOrder),
  });
  clear(elements.lede);
  for (const part of parts) elements.lede.append(part.text !== undefined ? document.createTextNode(part.text) : node("strong", part.strong, part.className));
}

function renderSummary(view) {
  const summary = view.summary;
  const dailyItems = dailyProviderSpend(view.dailySessions);
  renderLede(view, dailyItems);
  elements.spend.textContent = money(summary.estimatedSpendUsd); elements.spendNote.textContent = `${money(summary.apiEquivalentSpendUsd)} API-equivalent · ${money(summary.providerReportedSpendUsd)} provider-reported · not an invoice`;
  elements.repositories.textContent = String(summary.repositories); elements.repositoryNote.textContent = `${summary.repositoriesWithSessions} with sessions in window`;
  elements.sessions.textContent = `${summary.analyzedSessions}/${summary.sessions}`; elements.sessionNote.textContent = `${summary.topLevelSessions} top-level · ${summary.subagentSessions} sub-agent`;
  elements.input.textContent = compact.format(summary.totalInputTokens); elements.cache.textContent = `${percent(summary.cacheReadRatio)} cached · repeated context included`;
  elements.output.textContent = compact.format(summary.outputTokens); elements.tools.textContent = compact.format(summary.toolCalls); elements.compactions.textContent = integer.format(summary.compactions); elements.live.textContent = integer.format(summary.workingSnapshots);
  renderLine(dailyItems); renderProviderShare(view.sessions);
  renderBars(elements.repositorySpend, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.estimatedSpendUsd })).sort((a, b) => b.value - a.value), money, 12, ({ id }) => selectRepository(id));
  renderBars(elements.repositoryTokens, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.totalInputTokens })).sort((a, b) => b.value - a.value), (value) => compact.format(value), 12, ({ id }) => selectRepository(id));
  renderBars(elements.modelSpend, view.spendByModel.map(({ model, provider, totalUsd }) => ({ name: model, value: totalUsd, provider })), money, 8);
  renderBars(elements.toolCalls, view.topTools, (value) => integer.format(value), 10);
  renderBars(elements.repositorySubagentSpend, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.subagentSpendUsd })).filter(({ value }) => value > 0).sort((a, b) => b.value - a.value), money, 10, ({ id }) => selectRepository(id));
  renderRepositoryTable(view.repositories, summary); renderWarnings(view.warnings);
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
  // A refresh keeps the reader's repository and window when they still apply to the new snapshot.
  const previous = snapshot ? { repository: elements.repositoryFilter.value, preset: elements.windowPreset.value, start: elements.windowStart.value, end: elements.windowEnd.value } : null;
  snapshot = data; elements.generated.textContent = `Snapshot ${dateTime(data.generatedAt)}`; elements.rateCardDate.textContent = `Rate card ${data.rateCard.effectiveDate}`;
  populateRepositories(); configureWindow(); renderRateCards(data.rateCard);
  if (previous) {
    if ([...elements.repositoryFilter.options].some(({ value }) => value === previous.repository)) elements.repositoryFilter.value = previous.repository;
    if (previous.preset === "custom" && previous.start >= elements.windowStart.min && previous.end <= elements.windowEnd.max) {
      elements.windowPreset.value = "custom"; elements.windowStart.value = previous.start; elements.windowEnd.value = previous.end;
    } else if (previous.preset !== "all" && previous.preset !== "custom") {
      elements.windowPreset.value = previous.preset; applyWindowPreset(); return;
    }
  }
  ensureDistributionRepositories();
  if (pendingRepositoryName) {
    const option = [...elements.repositoryFilter.options].find(({ textContent }) => textContent === pendingRepositoryName);
    if (option) elements.repositoryFilter.value = option.value;
    pendingRepositoryName = null;
  }
  renderView();
}

async function load(refresh = false) {
  elements.error.hidden = true; elements.sync.dataset.state = "loading"; elements.syncLabel.textContent = refresh ? "Refreshing the snapshot" : "Reading local history"; elements.refresh.disabled = true;
  elements.main.setAttribute("aria-busy", "true");
  try { const response = await fetch(`/api/analytics${refresh ? "?refresh=1" : ""}`); const body = await response.json(); if (!response.ok) throw new Error(body.error || `Analysis failed with ${response.status}.`); render(body); elements.sync.dataset.state = "live"; elements.syncLabel.textContent = "Local snapshot ready"; }
  catch (error) { elements.sync.dataset.state = "error"; elements.syncLabel.textContent = "Analysis failed"; elements.error.textContent = error instanceof Error ? error.message : "Unknown analysis failure."; elements.error.hidden = false; }
  finally { elements.refresh.disabled = false; elements.main.removeAttribute("aria-busy"); }
}

function setTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  elements.themeLabel.textContent = theme === "dark" ? "Day edition" : "Night edition";
  if (persist) localStorage.setItem("session-analytics-theme", theme);
}
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
// One-shot URL hooks (`?view=costs&theme=dark&repository=<name>`) make every view
// reproducible for screenshots and links; they are read once and never persisted.
const urlParameters = new URLSearchParams(window.location.search);
const requestedView = urlParameters.get("view"), requestedTheme = urlParameters.get("theme");
pendingRepositoryName = urlParameters.get("repository");
const storedView = localStorage.getItem("session-analytics-view");
const viewExists = (name) => viewPanels.some(({ dataset }) => dataset.viewPanel === name);
if (viewExists(requestedView)) switchView(requestedView, false);
else switchView(viewExists(storedView) ? storedView : "summary");
if (requestedTheme === "dark" || requestedTheme === "light") setTheme(requestedTheme, false);
else setTheme(localStorage.getItem("session-analytics-theme") || "light");
void load(false);
