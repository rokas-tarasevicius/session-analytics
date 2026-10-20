import { compact, dateLabel, dateRange, dateTime, dayLabel, disjunction, fullDate, integer, money, timeLabel } from "./format.js";
import { modelColor, providerColor } from "./chart-colors.js";
import { renderLegend } from "./chart-legend.js";
import { axisTickIndexes, barPercent, scaleMaximum, stackPercents } from "./chart-scale.js";
import { renderHistoryCoverage } from "./history-coverage.js";
import {
  activityGrid, coverageWarnings, dailyCountSeries, daysBetween, deltaDescription, downsample,
  groupByRepository, heatLegend, heatLevel, isTextEntryTarget, ledgerAvailability, ledgerMoney, namedTotals, percent, presentProviders, previousPeriod, pricedPercent, pricedShare, providerLabels,
  providerOrder, providerShortcutTarget, rankPaletteItems, repositoryDisplaySnapshot, repositoryKey, resolveCustomWindow, sessionStartDay, sessionsInRange, shortMoney, singleFlight,
  sortRepositories, sparklineSummary, summarize, tickScale, unknownStartsInRange, validDay, windowStartFor,
} from "./view-model.js";
import { parseUrlState, serializeUrlState } from "./url-state.js";
import { providerMark, renderProviderEvidence, metricCoverage } from "./providers.js";

import { renderPricingPanel } from "./pricing.js";
import { renderToolsView } from "./tools.js";
import { renderSubscription, subscriptionRefreshMilliseconds } from "./subscription.js";
import { sessionMachines, valuedMachines, zonedDayStart } from "./subscription-data.js";
import { toolsDays } from "./tools-data.js";
import { renderVelocity, velocityProviders } from "./velocity.js";
import { buildVelocity, comparePeriods, ledgerCells, localDay, periodFromVelocity, shiftDay } from "./velocity-data.js";
import { normalizeTimestamp } from "./timestamps.js";
import { duplicateMachineWarning, scanWarnings } from "./evidence.js";
import { localMachine, machineAge, machineNote, machineReasons, machineTally, machineView, machineWarnings, sessionMachine } from "./machines.js";
import { filterSnapshot, selectSessions } from "./export-data.js";
import { installExportMenu, openExportMenu } from "./export-menu.js";
import { sharedHiddenSelectors, renderSharedSnapshot } from "./shared-view.js";
import { DASH, coverageBadge, setValue, valueWithCoverage, chartWidth, redrawOnResize } from "./ui.js";

const $ = (selector) => document.querySelector(selector);
const readPreference = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writePreference = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Storage is optional. */ } };
const elements = {
  activityHeatmap: $("#activity-heatmap"), activityProviderFilters: $("#activity-provider-filters"),
  activityRepositories: $("#activity-repositories"), activityTooltip: $("#activity-tooltip"), announcer: $("#chart-announcer"),
  cache: $("#metric-cache"), compactions: $("#metric-compactions"), dailySpend: $("#daily-spend"),
  commandButton: $("#command-button"), commandInput: $("#command-input"), commandList: $("#command-list"),
  costApiTotal: $("#cost-api-total"), costApiNote: $("#cost-api-note"), costCoverage: $("#cost-coverage"), costCoverageNote: $("#cost-coverage-note"),
  costProviderTotal: $("#cost-provider-total"), costReconciliation: $("#cost-reconciliation"), costTotal: $("#cost-total"), costTotalCoverage: $("#cost-total-coverage"),
  costApiCoverage: $("#cost-api-total-coverage"), costProviderCoverage: $("#cost-provider-total-coverage"),
  coverageButton: $("#coverage-button"), coverageClose: $("#coverage-close"), coverageDialog: $("#coverage-dialog"), coverageDot: $("#coverage-dot"), coverageLabel: $("#coverage-label"), coverageSummary: $("#coverage-summary"),
  spendCoverage: $("#metric-spend-coverage"), inputCoverage: $("#metric-input-coverage"), outputCoverage: $("#metric-output-coverage"), toolsCoverage: $("#metric-tools-coverage"), compactionsCoverage: $("#metric-compactions-coverage"),
  dateRange: $("#date-range"), density: $("#density-switch"),
  error: $("#error-banner"), errorMessage: $("#error-message"), errorRetry: $("#error-retry"), errorTitle: $("#error-title"),
  generated: $("#generated-at"), help: $("#help-overlay"), helpButton: $("#help-button"), helpClose: $("#help-close"),
  machineChips: $("#machine-chips"), machineDetails: $("#machine-details"), machineSpend: $("#machine-spend"), machineSpendPanel: $("#machine-spend-panel"),
  machineStrip: $("#machine-strip"), machineStripMeta: $("#machine-strip-meta"), machinesClose: $("#machines-close"), machinesDialog: $("#machines-dialog"),
  machinesRead: $("#machines-read"), machinesRows: $("#machines-rows"), machinesSummary: $("#machines-summary"),
  input: $("#metric-input"), main: $("#main"),
  modelSpend: $("#model-spend"), output: $("#metric-output"),
  coverageUsageNote: $("#coverage-usage-note"), coverageSessionNote: $("#coverage-session-note"), coverageLiveNote: $("#coverage-live-note"), coverageCostNote: $("#coverage-cost-note"), coverageMachinesNote: $("#coverage-machines-note"), coverageMachinesLink: $("#coverage-machines-link"), retentionNote: $("#retention-note"),
  pageTitle: $("#page-title"), palette: $("#command-palette"),
  providerCostModels: $("#provider-cost-models"), costModels: $("#cost-models"),
  providerDonut: $("#provider-donut"), providerLegend: $("#provider-legend"),
  rateCardDate: $("#rate-card-date"), rateCardLinks: $("#rate-card-links"), refresh: $("#refresh-button"),
  repositorySubagentSpend: $("#repository-subagent-spend"),
  repositoryFilter: $("#repository-filter"), repositoryList: $("#repository-list"),
  repositoryNav: $(".repo-nav"), repositoryNavCount: $("#repo-nav-count"),
  repositoryRows: $("#repository-rows"), repositorySpend: $("#repository-spend"),
  repositoryTokens: $("#repository-tokens"), scope: $("#scope-description"),
  scopeChip: $("#scope-chip"), scopeChipLabel: $("#scope-chip-label"),
  sessionNote: $("#metric-session-note"), sessions: $("#metric-sessions"),
  shortcutsToggle: $("#shortcuts-toggle"),
  spend: $("#metric-spend"), spendNote: $("#metric-spend-note"),
  sync: $("#sync-context"), syncLabel: $("#sync-label"), syncShort: $("#sync-short"),
  theme: $("#theme-switch"), themeLabel: $("#theme-label"), toolCalls: $("#tool-calls"),
  toolsView: $("#tools-view"), toolsProviderFilters: $("#tools-provider-filters"),
  tools: $("#metric-tools"), viewStatus: $("#view-status"), warning: $("#warning-banner"), warningList: $("#warning-list"),
  windowEnd: $("#window-end"), windowNote: $("#window-note"), windowSegment: $("#window-segment"), windowSelect: $("#window-select"), windowStart: $("#window-start"),
  wordmark: $(".wordmark"),
};
for (const provider of providerOrder) {
  const label = node("label", null, "chip"); label.dataset.provider = provider;
  label.style.setProperty("--chip-color", providerColor(provider));
  const input = node("input"); input.type = "checkbox"; input.checked = true;
  input.dataset.providerFilter = provider;
  input.setAttribute("aria-label", `${provider === "unsupported" ? "Unsupported provider" : providerLabels[provider]} daily usage`);
  if (provider === "unsupported") { label.hidden = true; label.dataset.unsupportedProvider = "true"; }
  label.append(input, providerMark(provider), node("span", providerLabels[provider]));
  $("#daily-provider-filters").append(label);
}
const providerFilters = [...document.querySelectorAll("[data-provider-filter]")];
const viewButtons = [...document.querySelectorAll("[data-view-button]")];
const viewPanels = [...document.querySelectorAll("[data-view-panel]")];
const windowButtons = [...elements.windowSegment.querySelectorAll("[data-window-preset]")];
const sortButtons = [...document.querySelectorAll("th .sort[data-sort]")];

const viewOrder = ["summary", "velocity", "costs", "pricing", "subscription", "tools", "activity"];
const viewLabels = { summary: "Summary", velocity: "Velocity", costs: "Costs", pricing: "Pricing", subscription: "Subscription", tools: "Tools", activity: "Activity" };
// Retired view names that old links and saved preferences may still carry.
const viewAliases = { models: "costs" };
const viewChords = { s: "summary", v: "velocity", c: "costs", p: "pricing", u: "subscription", t: "tools", a: "activity" };
const providerScopedViews = ["activity", "tools", "velocity"];
const shortProviderLabels = { copilot: "Copilot", gemini: "Gemini", opencode: "OpenCode", unsupported: "Other" };
const windowPresets = ["7", "30", "90", "all", "custom"];
const windowLabels = { 7: "Last 7 days", 30: "Last 30 days", 90: "Last 90 days", all: "All observed time", custom: "Custom range" };

let snapshot = null;
// The snapshot as served; `snapshot` is it narrowed to the machines switched on in the Machines strip.
let fullSnapshot = null;
const hiddenMachines = new Set();
let machinePoll = null;
let sharedSnapshot = null;
let sessionsByRepository = new Map();
// Providers present in the snapshot: every provider chip row lists these, and `p 1`… counts through them.
let providerCache = { source: null, providers: [] };
function snapshotProviders() {
  if (providerCache.source !== snapshot) providerCache = { source: snapshot, providers: Array.isArray(snapshot?.sessions) ? presentProviders(snapshot.sessions) : [] };
  return providerCache.providers;
}
// The initial analysis failed and there is no snapshot to show.
let loadFailed = false;
// The selected window has no sessions and no dated activity, so the view shows an empty state instead.
let windowEmpty = false;
// The last custom range applied; an empty or half-typed date input falls back to it.
let appliedWindow = { start: null, end: null };
// URL state is written only after the first snapshot has applied the URL's own parameters, and not while
// Back/Forward restores state from it.
let urlReady = false;
let restoringUrl = false;
let toolsSelectedName = null;
let toolsExpanded = false;
let windowPreset = "30";
let tableExpansion = { key: null, showEmpty: false };
let tableSort = { direction: "descending", key: "value" };
let shortcutsEnabled = true;
let navCache = { key: null };
let navDirty = false;
// Per-view provider filters are independent of each other and of the daily chart toggles (master semantics).
const viewProviderFilters = {
  activity: new Set(providerOrder),
  tools: new Set(providerOrder),
  velocity: new Set(providerOrder),
};
const hoverListeners = new Set();
const navHoverListeners = new Set();
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wideLayout = window.matchMedia("(min-width: 1121px)");

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

/** KPI values stay bare numbers; coverage lives in the fraction slot, and an unavailable value is an em dash with a visible reason. */
function renderMetricValue(element, value, coverage, format, what = "evidence", slot = null) {
  setValue(element, value, coverage, format, { slot, what });
}

function icon(name, className) {
  const svg = svgNode("svg", { "aria-hidden": "true" });
  if (className) svg.setAttribute("class", className);
  const use = svgNode("use"); use.setAttribute("href", `#i-${name}`); svg.append(use);
  return svg;
}

function snapshotTimeZone() { return snapshot?.velocity?.timeZone || "UTC"; }

function velocityContext() {
  return { start: elements.windowStart.value || elements.windowStart.min, end: elements.windowEnd.value || elements.windowEnd.max, timeZone: snapshotTimeZone(), generatedAt: snapshot.generatedAt };
}

/** Session-start selection: start dates in the snapshot timezone, the calendar the activity ledger uses. */
function selectedWindow() {
  if (windowPreset === "all") return { start: null, end: null };
  return { startDay: elements.windowStart.value || null, endDay: elements.windowEnd.value || null, timeZone: snapshotTimeZone() };
}

function clear(element) { element.replaceChildren(); }

function emptyState(container, message, title = null) {
  const box = node("div", null, "empty-state");
  box.append(icon("summary"));
  if (title) box.append(node("strong", title));
  box.append(node("span", message));
  container.append(box);
  return box;
}

/** Captures the focused control's key before a re-render and restores focus to its replacement afterwards. */
function rememberFocus() {
  const active = document.activeElement;
  // Charts are SVG elements: any element with a focus key counts, not only HTML ones.
  const key = active?.dataset?.focusKey ?? null;
  if (!key) return () => {};
  return () => {
    const current = document.activeElement;
    if (current && current !== document.body && current.isConnected) return;
    document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  };
}

function selectedRepository() {
  const id = elements.repositoryFilter.value;
  return id === "all" ? null : snapshot.repositories.find(({ repository }) => repository.id === id) || null;
}

function repositorySessions(id) { return sessionsByRepository.get(id) || []; }

function sessionsInWindow(sessions) {
  return selectSessions(sessions, selectedWindow());
}

function windowDays() { return daysBetween(elements.windowStart.value || elements.windowStart.min, elements.windowEnd.value || elements.windowEnd.max); }
function historicalSnapshot({ transcript }) {
  return transcript.sourceDeleted || transcript.warnings.includes("Source availability could not be checked; showing the last indexed facts.");
}

const noEvidence = () => ({ known: 0, eligible: 0, unsupported: 0, complete: true });

/** `usage` is the repository's activity-ledger value for the window, the figure the Summary KPI sums; `summary` covers sessions started in it. */
function repositoryAggregate(item, sessions, usage = null) {
  return { repository: item.repository, summary: summarize(sessions), topTools: namedTotals(sessions, "tools"), usage: usage ?? { value: 0, evidence: noEvidence(), available: false }, warnings: [...new Set([...scanWarnings(item.warnings || []), ...coverageWarnings(sessions)])] };
}

function activeProviders() {
  // Chips for providers absent from the snapshot are hidden; they never count as a selection.
  return providerFilters.filter((input) => input.checked && !input.closest(".chip").hidden).map(({ dataset }) => dataset.providerFilter);
}

function sessionsForProviders(sessions, scope) {
  const selected = viewProviderFilters[scope];
  return sessions.filter(({ provider }) => selected.has(provider));
}

function activeView() {
  const selected = selectedRepository();
  const scopeSessions = selected ? repositorySessions(selected.repository.id) : snapshot.sessions;
  const windowSessions = sessionsInWindow(scopeSessions);
  const window = selectedWindow();
  const undatedStarts = unknownStartsInRange(scopeSessions, window.startDay, window.endDay, snapshotTimeZone());
  const sourceRepositories = selected ? [selected] : snapshot.repositories;
  // One ledger pass grouped by repository serves the usage-value KPI, its sparkline, the repository bars and the fleet
  // table, so the table's rows add up to the KPI.
  const context = velocityContext();
  const activity = buildVelocity(scopeSessions, { start: context.start, end: context.end, group: "repository", metric: "value" });
  const usage = new Map(activity.allSeries.map(({ id, total, evidence }) => [id, { value: total, evidence, available: true }]));
  const repositories = sourceRepositories.map((item) => {
    const sessions = repositorySessions(item.repository.id);
    // A repository with no activity ledger at all has an unavailable value, not $0.
    return repositoryAggregate(item, sessionsInWindow(sessions), usage.get(item.repository.id) ?? { value: 0, evidence: noEvidence(), available: sessions.some((session) => session.velocity) });
  });
  const sessions = windowSessions;
  const summary = summarize(sessions);
  return {
    undatedStarts, activity,
    dailySessions: scopeSessions, repositories, scopeSessions, sessions, topTools: namedTotals(sessions, "tools"),
    warnings: machineWarnings(fullSnapshot?.machines, [...new Set([...scanWarnings([...snapshot.warnings, ...snapshot.repositories.flatMap((r) => r.warnings)]), ...snapshot.warnings.filter((warning) => warning === duplicateMachineWarning), ...coverageWarnings(sessions)])]),
    summary: { ...summary, repositories: repositories.length, repositoriesWithSessions: repositories.filter(({ summary: item }) => item.sessions > 0).length, retainedSessions: sessions.filter(({ transcript }) => transcript.sourceDeleted).length, historicalWorkingSnapshots: sessions.filter((s) => s.transcript.snapshotWhileWorking && historicalSnapshot(s)).length, workingSnapshots: sessions.filter((s) => s.transcript.snapshotWhileWorking && !historicalSnapshot(s)).length },
  };
}

function selectRepository(id, { scroll = true } = {}) {
  if (!snapshot) return;
  if (![...elements.repositoryFilter.options].some((option) => option.value === id)) return;
  elements.repositoryFilter.value = id;
  renderView();
  syncUrl();
  if (scroll) elements.main.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

/** A `?repo=` value names a repository by its opaque ID or, for older links, by its display name. */
function repositoryFromParameter(value) {
  if (!value || !snapshot?.repositories) return null;
  return snapshot.repositories.find(({ repository }) => repository.id === value) ?? snapshot.repositories.find(({ repository }) => (repository.sourceName ?? repository.name) === value) ?? null;
}

// --------------------------------------------------------------------- URL state

function currentUrlState() {
  const repo = elements.repositoryFilter.value;
  const scope = providerScope(), present = snapshotProviders();
  const selected = scope ? present.filter((provider) => providerShown(scope, provider)) : present;
  return { view: currentViewName(), window: windowPreset, start: elements.windowStart.value, end: elements.windowEnd.value, repo: repo && repo !== "all" ? repo : null,
    providers: selected.length < present.length ? selected : null };
}

/** URL provider filters apply to the recorded view; other views keep their independent selections. */
function restoreUrlProviders(state) {
  const view = state.view ?? currentViewName(), selected = new Set(state.providers ?? providerOrder);
  if (view === "summary") for (const input of providerFilters) input.checked = selected.has(input.dataset.providerFilter);
  else if (viewProviderFilters[view]) viewProviderFilters[view] = selected;
}

/** Records the current view, window and repository in the address bar: a new history entry, or `replace`. */
function syncUrl(mode = "push") {
  if (!urlReady || restoringUrl || !mode || !window.history || !snapshot || snapshot.kind === "shared") return;
  const search = serializeUrlState(currentUrlState(), window.location.search);
  if (search === window.location.search) return;
  const url = `${window.location.pathname}${search}${window.location.hash}`;
  if (mode === "replace") window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}

/** Back and Forward restore the view, window and repository that the URL records, without adding history. */
function restoreUrlState() {
  if (!snapshot || snapshot.kind === "shared" || !urlReady) return;
  const state = parseUrlState(window.location.search, { views: viewOrder, presets: windowPresets, aliases: viewAliases });
  restoringUrl = true;
  try {
    restoreUrlProviders({ ...state, view: state.view ?? "summary" });
    elements.repositoryFilter.value = repositoryFromParameter(state.repo)?.repository.id ?? "all";
    if (state.window === "custom") applyCustomRange(state.start, state.end, { render: false });
    else applyWindowPreset(state.window ?? "30", { render: false });
    switchView(state.view ?? "summary");
  } finally {
    restoringUrl = false;
  }
}

/** Shows only the active view's panel, or none when there is no snapshot or the window is empty. */
function showActivePanel() {
  const name = currentViewName();
  const blocked = Boolean(sharedSnapshot) || (!snapshot && loadFailed) || (windowEmpty && name !== "pricing");
  for (const panel of viewPanels) panel.hidden = blocked || panel.dataset.viewPanel !== name;
}

// --------------------------------------------------------------------- bars

function renderBars(container, items, formatter, limit = 9, onSelect = null) {
  clear(container);
  const visible = items.slice(0, limit);
  const maximum = scaleMaximum(visible.map(({ value }) => value));
  if (!visible.length) { emptyState(container, "No activity in this view."); return; }
  for (const item of visible) {
    const row = node(onSelect ? "button" : "div", null, `bar-row${onSelect ? " repository-link" : ""}`);
    if (onSelect) {
      row.type = "button";
      row.dataset.focusKey = `bar:${container.id}:${item.id ?? item.name}`;
      const valueText = item.coverage && item.coverage.eligible === 0 ? "not available" : formatter(item.value);
      const coverageText = item.coverage && item.coverage.eligible < item.coverage.selected && item.coverage.selected > 0
        ? `, ${item.coverage.eligible} of ${item.coverage.selected} selected sessions provide ${item.what || "evidence"}` : "";
      row.setAttribute("aria-label", `${item.name}, ${valueText}${coverageText}. Focus this repository`);
      row.addEventListener("click", () => onSelect(item));
    }
    const label = node("div", null, "bar-label");
    if (snapshot?.repositories?.find(({ repository }) => repository.id === item.id)?.repository.duplicateName) label.title = "another checkout with the same name";
    label.append(node("span", item.name), item.coverage ? valueWithCoverage(item.value, item.coverage, formatter, item.what || "evidence") : node("strong", formatter(item.value)));
    const track = node("div", null, "bar-track");
    const fill = node("i");
    fill.setAttribute("data-series", item.id ?? (item.provider ? `${item.provider}:${item.model ?? item.name}` : item.name));
    fill.style.setProperty("--series-color", item.model ? modelColor(item.provider, item.model) : item.provider ? providerColor(item.provider) : "var(--chart-neutral)");
    fill.style.width = `${barPercent(item.value, maximum)}%`;
    if (!item.coverage || item.coverage.eligible) track.append(fill); row.append(label, track); container.append(row);
  }
}

// --------------------------------------------------------------------- sparklines & hover sync

function syncHover(day) {
  for (const listener of hoverListeners) listener(day);
  for (const listener of navHoverListeners) listener(day);
}

function renderSparkline(svg, rawValues, days, { width = 84, height = 30, label = null, format = null, listeners = hoverListeners } = {}) {
  clear(svg);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  if (label && format) {
    svg.removeAttribute("aria-hidden");
    svg.setAttribute("role", "img");
    const summary = sparklineSummary(label, rawValues, days, format);
    svg.setAttribute("aria-label", summary);
    const title = svgNode("title"); title.textContent = summary; svg.append(title);
  }
  // Downsample to the drawn resolution: one point per device pixel is all a sparkline can show.
  const { indexFor, values } = downsample(rawValues, width);
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
  listeners.add((day) => {
    const index = indexFor(day === null ? -1 : days.indexOf(day));
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
  svg.append(crosshair); svg.prepend(hit);
  const tooltip = node("div", null, "chart-tooltip"); tooltip.hidden = true;
  container.append(tooltip);
  svg.tabIndex = 0;
  svg.setAttribute("aria-label", `${label}. Use the arrow keys to read each point; Escape dismisses the readout.`);
  let current = null;
  const show = (index) => {
    if (index === null || index === undefined || xs[index] === undefined) return hide();
    if (index === current) return;
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
    if (current === null && tooltip.hidden) return;
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
  svg.addEventListener("pointermove", (event) => show(nearest(event.clientX)));
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // Consume Escape only when a readout is open so the global scope shortcut does not also run.
      if (current !== null) { event.preventDefault(); event.stopPropagation(); hide(); }
      return;
    }
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (event.key === "Home") { event.preventDefault(); show(0); return; }
    if (event.key === "End") { event.preventDefault(); show(xs.length - 1); return; }
    if (!step) return;
    event.preventDefault();
    show(Math.min(xs.length - 1, Math.max(0, (current ?? (step > 0 ? -1 : xs.length)) + step)));
  });
  svg.addEventListener("blur", hide);
}

// --------------------------------------------------------------------- views

function switchView(name, { history: mode = "push" } = {}) {
  if (sharedSnapshot) return;
  const changed = currentViewName() !== name;
  for (const button of viewButtons) {
    if (button.dataset.viewButton === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  showActivePanel();
  elements.activityTooltip.hidden = true;
  elements.pageTitle.textContent = viewLabels[name] || "Summary";
  document.title = `${viewLabels[name] || "Summary"} · Session Analytics`;
  writePreference("session-analytics-view", name);
  // A new view starts at its top. The jump is instant, so it never animates (reduced motion included).
  if (changed && snapshot) window.scrollTo?.({ top: 0, left: 0, behavior: "instant" });
  if (snapshot) renderView();
  else if (!loadFailed) { scheduleLimits(name === "subscription"); if (name === "subscription") renderSubscriptionView(); }
  syncUrl(mode);
}

function currentViewName() {
  return viewButtons.find((button) => button.getAttribute("aria-current") === "page")?.dataset.viewButton || "summary";
}

function stepView(offset) {
  const index = viewOrder.indexOf(currentViewName());
  switchView(viewOrder[(index + offset + viewOrder.length) % viewOrder.length]);
}

function renderViewProviderFilters(container, scope) {
  clear(container);
  for (const provider of snapshotProviders()) {
    const label = node("label", null, "chip"); label.dataset.provider = provider; label.style.setProperty("--chip-color", providerColor(provider));
    const input = node("input"); input.type = "checkbox"; input.checked = viewProviderFilters[scope].has(provider);
    input.dataset.focusKey = `filter:${scope}:${provider}`;
    input.setAttribute("aria-label", `${providerLabels[provider]} sessions`);
    const logo = providerMark(provider);
    input.addEventListener("change", () => {
      if (input.checked) viewProviderFilters[scope].add(provider);
      else viewProviderFilters[scope].delete(provider);
      renderActiveAnalyticsView(activeView());
      syncUrl();
    });
    label.append(input, logo, node("span", providerLabels[provider])); container.append(label);
  }
}

function addSvgText(svg, value, x, y, anchor = "start") {
  const label = svgNode("text", { x, y, class: "axis-label", "text-anchor": anchor });
  label.textContent = value; svg.append(label);
}

function renderActivity(view) {
  renderViewProviderFilters(elements.activityProviderFilters, "activity");
  elements.activityTooltip.hidden = true;
  const eligible = sessionsForProviders(view.sessions, "activity");
  const { grid, counted, maximum } = activityGrid(eligible, snapshotTimeZone());
  $("#activity-evidence").textContent = `${counted}/${eligible.length} sessions have provider start timestamps. Unknown starts and file modification dates are excluded.`;
  const status = document.querySelector?.("#activity-status");
  const heatmapPanel = document.querySelector?.("#activity-heatmap-panel"), repositoriesPanel = document.querySelector?.("#activity-repositories-panel");
  if (status) {
    clear(status);
    let empty = renderProviderEmptyState(status, "activity", eligible.length, view.sessions.length);
    if (!empty && eligible.length && !counted) {
      emptyState(status, `None of the ${integer(eligible.length)} selected sessions has a provider start timestamp; unknown starts and file modification times are not plotted.`, "No known session starts");
      empty = true;
    }
    status.hidden = !empty;
    if (heatmapPanel) heatmapPanel.hidden = empty;
    if (repositoriesPanel) repositoriesPanel.hidden = empty;
    if (empty) { clear(elements.activityHeatmap); clear(elements.activityRepositories); return; }
  }
  const key = document.querySelector?.("#activity-heatmap-key");
  if (key) {
    clear(key);
    key.append(node("span", "Session starts per hour", "heatmap-key-label"), node("span", "0"));
    for (const { level, min, max } of heatLegend(maximum)) {
      const swatch = node("i"); swatch.dataset.level = String(level);
      swatch.setAttribute("title", min === max ? `${integer(min)} ${min === 1 ? "session" : "sessions"}` : `${integer(min)}–${integer(max)} sessions`);
      swatch.setAttribute("aria-hidden", "true"); key.append(swatch);
    }
    key.append(node("span", integer(maximum)), node("span", `Colour scale from 0 to ${integer(maximum)} session starts per weekday-hour cell; darker means more.`, "sr-only"));
  }
  clear(elements.activityHeatmap);
  elements.activityHeatmap.setAttribute("role", "group");
  elements.activityHeatmap.setAttribute("aria-label", `Session starts by local weekday and hour for ${integer(counted)} selected sessions.`);
  elements.activityHeatmap.append(node("span", "", "heat-hour"));
  for (let hour = 0; hour < 24; hour += 1) elements.activityHeatmap.append(node("span", String(hour).padStart(2, "0"), `heat-hour${hour % 4 ? " heat-hour-minor" : ""}`));
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  for (let day = 0; day < 7; day += 1) {
    elements.activityHeatmap.append(node("span", days[day].slice(0, 3), "heat-label"));
    for (let hour = 0; hour < 24; hour += 1) {
      const value = grid[day][hour], cell = node("span", null, "heat-cell");
      const hourLabel = `${String(hour).padStart(2, "0")}:00–${String(hour).padStart(2, "0")}:59`;
      cell.dataset.level = String(heatLevel(value, maximum));
      cell.dataset.day = String(day);
      cell.dataset.hour = String(hour);
      cell.dataset.value = String(value);
      cell.dataset.focusKey = `heat:${day}:${hour}`;
      cell.setAttribute("tabindex", day === 0 && hour === 0 ? "0" : "-1");
      cell.setAttribute("role", "img");
      cell.setAttribute("aria-label", `${integer(value)} session${value === 1 ? "" : "s"}, ${days[day]}, ${hourLabel}`);
      const showTooltip = () => {
        clear(elements.activityTooltip);
        elements.activityTooltip.append(
          node("strong", integer(value)),
          node("span", `${value === 1 ? "session" : "sessions"} · ${days[day]} · ${hourLabel}`),
        );
        elements.activityTooltip.hidden = false;
        elements.activityTooltip.dataset.side = "above";
        const cellRect = cell.getBoundingClientRect?.(), tooltipRect = elements.activityTooltip.getBoundingClientRect?.();
        if (!cellRect || !tooltipRect) return;
        let top = cellRect.top - tooltipRect.height - 10;
        if (top < 8) {
          top = cellRect.bottom + 10;
          elements.activityTooltip.dataset.side = "below";
        }
        const left = Math.min((globalThis.innerWidth ?? globalThis.window?.innerWidth ?? 1440) - tooltipRect.width - 8, Math.max(8, cellRect.left + cellRect.width / 2 - tooltipRect.width / 2));
        elements.activityTooltip.style.setProperty("left", `${left}px`);
        elements.activityTooltip.style.setProperty("top", `${top}px`);
        elements.activityTooltip.style.setProperty("--tooltip-arrow-left", `${Math.min(tooltipRect.width - 10, Math.max(10, cellRect.left + cellRect.width / 2 - left))}px`);
      };
      const hideTooltip = () => { elements.activityTooltip.hidden = true; };
      cell.addEventListener("pointerenter", showTooltip);
      cell.addEventListener("pointerleave", hideTooltip);
      cell.addEventListener("focus", showTooltip);
      cell.addEventListener("blur", hideTooltip);
      cell.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !elements.activityTooltip.hidden) { event.preventDefault(); event.stopPropagation(); hideTooltip(); return; }
        const mobile = globalThis.matchMedia?.("(max-width: 760px)")?.matches;
        const movement = (mobile
          ? { ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1] }
          : { ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0] })[event.key];
        if (!movement) return;
        const nextDay = day + movement[0], nextHour = hour + movement[1];
        const target = elements.activityHeatmap.querySelector?.(`[data-day="${nextDay}"][data-hour="${nextHour}"]`);
        if (!target) return;
        event.preventDefault(); cell.setAttribute("tabindex", "-1"); target.setAttribute("tabindex", "0"); target.focus?.();
      });
      elements.activityHeatmap.append(cell);
    }
  }
  const sessions = eligible.filter((s) => s.transcript?.startTimeKnown !== false && s.evidence?.timing !== "file-mtime" && normalizeTimestamp(s.createdAt) !== null);
  const repositories = view.repositories.map(({ repository }) => ({
    id: repository.id, name: repository.name,
    value: sessions.filter(({ repositoryId }) => repositoryId === repository.id).length,
  })).filter(({ value }) => value > 0).sort((left, right) => right.value - left.value);
  renderBars(elements.activityRepositories, repositories, (value) => integer(value), 12);
}

const unattributedColor = "repeating-linear-gradient(45deg, var(--muted) 0 4px, var(--surface-3) 4px 6px)";

/** "95% priced" badge for a ledger value whose eligible tokens are not all priced; null when complete or N/A. */
function pricedBadge(evidence, tag = "small") {
  const share = pricedShare(evidence);
  if (share === null || share >= 1) return null;
  const badge = node(tag, `${Math.floor(Math.round(share * 1000) / 10)}% priced`, "coverage");
  badge.title = `${pricedPercent(evidence)} of eligible tokens have a price (${integer(evidence.known)} of ${integer(evidence.eligible)})`;
  badge.setAttribute("aria-label", badge.title);
  return badge;
}

/** Wholly unpriced usage has no measured value, unlike a priced zero-rate model. */
function ledgerAmount(value, evidence) {
  return value === 0 && evidence.eligible > 0 && evidence.known === 0 ? DASH : money(value);
}

/** A ledger value with its priced-share badge: the dashboard's one usage-value presentation. */
function ledgerValue(value, evidence, tag = "strong") {
  const holder = node(tag); holder.append(node("span", ledgerAmount(value, evidence)));
  if (ledgerAmount(value, evidence) === DASH) holder.setAttribute("aria-label", "No usage value: unpriced");
  const badge = pricedBadge(evidence);
  if (badge) holder.append(badge);
  return holder;
}

/** Provider stacks, high to low, then the window total: the rows add up to the total line. */
function renderCostRows(container, ledger) {
  clear(container); const list = node("div", null, "cost-stack-list");
  const maximum = scaleMaximum(ledger.providers.map(({ total }) => total));
  for (const group of ledger.providers) {
    const row = node("div", null, "cost-stack-row"); row.append(node("strong", providerLabels[group.provider] ?? "Unknown provider"));
    const rail = node("div", null, "cost-rail"), stack = node("div", null, "cost-stack");
    const parts = group.models.filter(({ value }) => value > 0).map(({ model, value }) => ({ name: model, value, color: modelColor(group.provider, model), id: `${group.provider}:${model}` }));
    if (group.unattributed > 0) parts.push({ name: "No model evidence", value: group.unattributed, color: unattributedColor, id: `${group.provider}:unattributed` });
    const widths = stackPercents(parts.map(({ value }) => value), maximum);
    const detail = parts.map(({ name, value }) => `${name}: ${money(value)} (${percent(group.total ? value / group.total : 0)} of provider)`);
    stack.setAttribute("role", "img");
    stack.setAttribute("aria-label", `${providerLabels[group.provider] ?? "Unknown provider"}: ${ledgerAmount(group.total, group.evidence)}. ${detail.join(", ")}`);
    stack.title = detail.join("\n");
    for (const [index, part] of parts.entries()) {
      const bar = node("i"); bar.setAttribute("data-series", part.id);
      bar.style.width = `${widths[index]}%`; bar.style.background = part.color; stack.append(bar);
    }
    rail.append(stack); row.append(rail, ledgerValue(group.total, group.evidence)); list.append(row);
  }
  if (list.childElementCount === 0) emptyState(list, "No priced activity in this view.");
  else {
    const total = node("div", null, "cost-stack-row cost-stack-total");
    total.append(node("strong", "Total"), node("div"), ledgerValue(ledger.total, ledger.evidence));
    list.append(total);
  }
  container.append(list);
}

const tokenClasses = [["Input", 1], ["cache read", 3], ["cache write", 4], ["output", 5]];

function renderModelCosts(container, ledger) {
  clear(container); const list = node("div", null, "cost-model-list");
  const rows = ledger.models.filter(({ model }) => model !== "<unknown>");
  for (const provider of ledger.providers) if (provider.unattributed > 0.000001) rows.push({ provider: provider.provider, model: "No model evidence", value: provider.unattributed, api: 0, reported: 0, share: ledger.total ? provider.unattributed / ledger.total : 0, evidence: noEvidence(), unattributed: true });
  rows.sort((left, right) => right.value - left.value || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model));
  const maximum = scaleMaximum(rows.map(({ value }) => value));
  for (const model of rows) {
    const row = node("div", null, "cost-model-row"), label = node("div", null, "cost-model-label");
    const provider = node("small", providerLabels[model.provider] ?? "Unknown provider"); provider.style.setProperty("--provider-color", providerColor(model.provider));
    label.append(node("span", model.model), provider);
    const share = pricedShare(model.evidence);
    const meta = model.unattributed ? "Provider value without model evidence" : [
      `${integer(model.sessions)} session${model.sessions === 1 ? "" : "s"}`,
      model.callsEligible > 0 ? `${integer(model.calls)} calls` : `${DASH} calls`,
      model.sums[1] + model.sums[5] > 0 ? `${compact(model.sums[1])} in / ${compact(model.sums[5])} out tokens` : "no model token evidence",
      share === null || share >= 1 ? null : model.value > 0 ? "partly unpriced" : "unpriced",
    ].filter(Boolean).join(" · ");
    const basis = model.api > 0 && model.reported > 0 ? `${money(model.api)} API-equivalent + ${money(model.reported)} provider-reported. ` : model.reported > 0 ? "Provider-reported. " : "";
    const detail = model.unattributed ? meta : `${tokenClasses.map(([name, index]) => `${name} ${compact(model.sums[index])}`).join(", ")} tokens`;
    const amount = ledgerAmount(model.value, model.evidence), valueShare = amount === DASH ? DASH : percent(model.share);
    row.title = `${model.model} · ${providerLabels[model.provider] ?? "Unknown provider"}: ${amount} (${valueShare} of total). ${basis}${meta}. ${detail}`;
    const track = node("div", null, "cost-model-track"), fill = node("i");
    track.setAttribute("role", "img"); track.setAttribute("aria-label", row.title);
    fill.style.width = `${barPercent(model.value, maximum)}%`; fill.style.background = model.unattributed ? unattributedColor : modelColor(model.provider, model.model);
    fill.setAttribute("data-series", `${model.provider}:${model.unattributed ? "unattributed" : model.model}`); track.append(fill);
    row.append(label, track, ledgerValue(model.value, model.evidence), node("span", valueShare, "cost-model-share"), node("small", meta, "cost-model-meta muted")); list.append(row);
  }
  if (list.childElementCount === 0) emptyState(list, "No priced activity in this view.");
  container.append(list);
}

/** Excluded value disclosed beside a window total; it is all-time for the scope and never added to a date window. */
function ledgerExclusions(ledger) {
  return [
    ledger.undated > 0 ? `${money(ledger.undated)} undated` : null,
    ledger.unledgered.sessions ? `${money(ledger.unledgered.value)} in ${ledger.unledgered.sessions} older-snapshot session${ledger.unledgered.sessions === 1 ? "" : "s"} without activity dates (refresh to include)` : null,
  ].filter(Boolean);
}

/** Costs reads the same activity ledger as the Summary KPI and Velocity for the window: totals, providers and models agree. */
function renderCosts(view) {
  const range = velocityContext(), ledger = ledgerMoney(view.scopeSessions, range);
  const unavailable = ledgerAvailability(view.scopeSessions).eligible === 0;
  const reason = { reason: "No session in this selection has activity dates" };
  setValue(elements.costTotal, ledger.total, unavailable ? { eligible: 0, selected: view.scopeSessions.length } : null, (value) => ledgerAmount(value, ledger.evidence), { ...reason, slot: elements.costTotalCoverage });
  setValue(elements.costApiTotal, ledger.api, unavailable ? { eligible: 0, selected: view.scopeSessions.length } : null, (value) => ledgerAmount(value, ledger.evidence), { ...reason, slot: elements.costApiCoverage });
  setValue(elements.costProviderTotal, ledger.reported, unavailable ? { eligible: 0, selected: view.scopeSessions.length } : null, money, { ...reason, slot: elements.costProviderCoverage });
  for (const [slot, badge] of [[elements.costTotalCoverage, pricedBadge(ledger.evidence)], [elements.costApiCoverage, null], [elements.costProviderCoverage, null]]) { if (badge && !unavailable) slot.append(badge); }
  elements.costApiNote.textContent = ledger.upper > ledger.api + 0.005 ? `Cache-write upper estimate ${money(ledger.upper)}` : "Rate-card priced usage";
  elements.costCoverage.textContent = pricedPercent(ledger.evidence) === "N/A" ? DASH : pricedPercent(ledger.evidence);
  elements.costCoverageNote.textContent = ledger.evidence.eligible > 0 ? `${compact(ledger.evidence.known)} of ${compact(ledger.evidence.eligible)} eligible tokens priced` : "No eligible tokens in this window";
  const excluded = ledgerExclusions(ledger);
  elements.coverageCostNote.hidden = false;
  elements.coverageCostNote.textContent = `${ledgerAmount(ledger.total, ledger.evidence)} usage value = ${ledgerAmount(ledger.api, ledger.evidence)} API-equivalent + ${money(ledger.reported)} provider-reported · by activity date, ${dateRange(range.start, range.end)} (${range.timeZone})${ledger.sessionDated > 0 ? `, including ${money(ledger.sessionDated)} session-dated` : ""} · the same ledger as Summary and Velocity.${excluded.length ? ` Not in any date window (all time): ${excluded.join(" and ")}.` : ""}${ledger.missingSessions ? ` ${ledger.missingSessions} session${ledger.missingSessions === 1 ? "" : "s"} need a refresh.` : ""}`;
  elements.costReconciliation.textContent = `${ledgerAmount(ledger.total, ledger.evidence)} usage value = ${ledgerAmount(ledger.api, ledger.evidence)} API-equivalent + ${money(ledger.reported)} reported`;
  renderCostRows(elements.providerCostModels, ledger);
  renderModelCosts(elements.costModels, ledger);
}

function renderTools(view) {
  const sessions = sessionsForProviders(view.sessions, "tools");
  clear(elements.toolsView);
  if (renderProviderEmptyState(elements.toolsView, "tools", sessions.length, view.sessions.length)) return;
  const previous = windowPreset === "all" ? null : previousPeriod({ end: elements.windowEnd.value, min: elements.windowStart.min, start: elements.windowStart.value });
  const previousSessions = previous ? sessionsForProviders(sessionsInRange(view.scopeSessions, previous.startDay, previous.endDay, snapshotTimeZone()), "tools") : null;
  const days = windowPreset === "all" ? toolsDays(sessions, snapshotTimeZone()) : windowDays();
  toolsSelectedName = renderToolsView(elements.toolsView, {
    sessions, previousSessions, days, timeZone: snapshotTimeZone(), selectedTool: toolsSelectedName, expanded: toolsExpanded, repositories: view.repositories,
    announce: (text) => { elements.announcer.textContent = text; },
    onSelect: (name) => { toolsSelectedName = name; renderActiveAnalyticsView(view); },
    onToggle: () => { toolsExpanded = !toolsExpanded; renderActiveAnalyticsView(view); },
  });
}

function clearInactiveAnalyticsViews(activeName) {
  const containers = {
    activity: [elements.activityProviderFilters, elements.activityHeatmap, elements.activityRepositories],
    costs: [elements.providerCostModels, elements.costModels],
    tools: [elements.toolsProviderFilters, elements.toolsView],
  };
  for (const [name, elementsForView] of Object.entries(containers)) {
    if (name === activeName) continue;
    for (const element of elementsForView) {
      clear(element);
    }
  }
  // The heatmap tooltip lives outside the Activity panel, so it is reset explicitly whenever Activity is not active.
  if (activeName !== "activity") elements.activityTooltip.hidden = true;
}

// Limit meters come from their own endpoint: they are account-wide, cheap to re-harvest, and refresh while the view is open.
let limits = null;
let limitsTimer = null;
let limitsPoll = null;
async function loadLimitsNow(refresh = false) {
  try {
    const response = await fetch(`/api/limits${refresh ? "?refresh=1" : ""}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    limits = await response.json();
  } catch {
    limits ??= { schemaVersion: 2, dataSource: "live", persisted: false, plans: { claude: null, codex: null }, sources: [], observations: [], accounts: [], meters: [], resetCreditHistory: [], unavailable: true };
  }
  // Meters need no sessions, so they render as soon as they arrive, before the session scan finishes.
  if (!sharedSnapshot && !loadFailed && currentViewName() === "subscription") { renderSubscriptionView(); renderStripMeta(); }
  // Another machine's limits arrive after this machine's: ask again in 2 s while one is still reading.
  if (limitsPoll !== null) { clearTimeout(limitsPoll); limitsPoll = null; }
  if (limits.machines?.some(({ state }) => state === "reading") && limitsTimer !== null && typeof setTimeout === "function") limitsPoll = setTimeout(() => void loadLimits(false), 2000);
}
let limitsPending = null;
let limitsRefreshing = false;
/** Share reads, but queue a forced refresh when a passive read is already in flight. */
function loadLimits(refresh = false) {
  if (limitsPending) return refresh && !limitsRefreshing ? limitsPending.then(() => loadLimits(true)) : limitsPending;
  limitsRefreshing = refresh;
  limitsPending = loadLimitsNow(refresh).finally(() => { limitsPending = null; });
  return limitsPending;
}

function scheduleLimits(active) {
  if (!active) { if (limitsTimer !== null) clearInterval(limitsTimer); limitsTimer = null; if (limitsPoll !== null) clearTimeout(limitsPoll); limitsPoll = null; return; }
  if (!limits) void loadLimits(false);
  if (typeof setInterval === "function") limitsTimer ??= setInterval(() => { if (document.visibilityState !== "hidden") void loadLimits(false); }, subscriptionRefreshMilliseconds);
}

/**
 * Subscription is account-wide: it reads every session, ignoring the repository focus and the Machines strip, over the
 * selected dates. Value counts the sessions of every machine whose limits and sessions were both read, and the view names
 * the machines it leaves out. Before the snapshot arrives it shows the meters alone. Each refresh keeps focus, open
 * disclosures and the scroll position.
 */
function renderSubscriptionView() {
  const restoreFocus = rememberFocus();
  const scroll = window.scrollY;
  const all = fullSnapshot ?? snapshot, context = all ? velocityContext() : null, machines = all?.machines ?? [];
  renderSubscription($("#subscription-view"), {
    limits, sessions: all ? all.sessions : null, timeZone: context?.timeZone ?? "UTC",
    range: context ? { from: zonedDayStart(context.start, context.timeZone), to: zonedDayStart(shiftDay(context.end, 1), context.timeZone) } : null,
    scope: {
      label: machines.find(({ key }) => key === localMachine)?.label ?? "this machine",
      others: machines.filter(({ key, state, readAt }) => key !== localMachine && state !== "failed" && readAt).map(({ label }) => label),
      sessions: sessionMachines(all),
    },
    onPlanChange: () => renderSubscriptionView(),
  });
  if (typeof scroll === "number" && window.scrollY !== scroll) window.scrollTo?.({ top: scroll, left: 0, behavior: "instant" });
  restoreFocus();
}

function renderActiveAnalyticsView(view) {
  const restoreFocus = rememberFocus();
  resetExportMenu();
  const name = currentViewName(); clearInactiveAnalyticsViews(name);
  if (name === "activity") renderActivity(view);
  if (name === "velocity") renderVelocity($("#velocity-view"), view.dailySessions, { ...velocityContext(), providers: snapshotProviders(), selectedProviders: [...viewProviderFilters.velocity],
    onProvidersChange: (providers) => { viewProviderFilters.velocity = new Set(providers); syncUrl(); } });
  if (name === "costs") renderCosts(view);
  if (name === "subscription") renderSubscriptionView();
  scheduleLimits(name === "subscription");
  if (name === "pricing") renderPricingPanel($("#pricing-panel"), snapshot.rateCard, view.scopeSessions, velocityContext(), { onRefresh: () => load(true) });
  if (name === "tools") {
    renderViewProviderFilters(elements.toolsProviderFilters, "tools");
    renderTools(view);
  }
  restoreFocus();
}

function dailyProviderSpend(sessions) {
  const days = new Map(daysBetween(elements.windowStart.value, elements.windowEnd.value).map((name) => [name, { name, ...Object.fromEntries(providerOrder.map((provider) => [provider, 0])) }]));
  for (const session of sessions) {
    if (!providerOrder.includes(session.provider)) continue;
    // The cells buildVelocity sums: in-window days with a known dimension.
    for (const [day, , dimension, values] of ledgerCells(session.velocity)) {
      const row = days.get(day);
      if (row && session.velocity.dimensions[dimension]) row[session.provider] += values[0];
    }
  }
  return [...days.values()];
}

function renderLine(items) {
  redrawOnResize(elements.dailySpend, () => renderLine(items));
  clear(elements.dailySpend);
  const selectedProviders = activeProviders();
  const totals = Object.fromEntries(selectedProviders.map((provider) => [provider, items.reduce((sum, item) => sum + item[provider], 0)]));
  const providers = selectedProviders.filter((provider) => totals[provider] > 0).sort((a, b) => totals[b] - totals[a]);
  if (!items.length || !selectedProviders.length || !providers.length) {
    const message = !selectedProviders.length
      ? "Choose at least one provider."
      : selectedProviders.length === 1 && selectedProviders[0] === "cursor"
        ? "Cursor database values have no per-request cost times; they remain in the usage summaries."
        : "No daily priced activity in this view.";
    emptyState(elements.dailySpend, message, "Nothing to plot"); syncHover(null); return;
  }
  const activeDays = items.filter((item) => providers.some((provider) => item[provider] > 0));
  if (activeDays.length <= 2) {
    const legend = node("div");
    renderLegend(legend, providers.map((provider) => ({ id: provider, label: providerLabels[provider], color: providerColor(provider), value: totals[provider], valueLabel: money(totals[provider]), mark: "line" })), { target: elements.dailySpend, layout: "list" });
    const dates = activeDays.map(({ name }) => dayLabel(name)).join(" and ");
    const actions = node("div", null, "status-actions");
    const button = statusAction("Show 30d", () => applyWindowPreset("30"));
    button.dataset.focusKey = "daily:show-30d";
    actions.append(button);
    elements.dailySpend.append(legend, node("p", `Only ${dates} ${activeDays.length === 1 ? "has" : "have"} activity · widen the window for a trend`, "chart-note"), actions);
    syncHover(null);
    return;
  }
  const width = chartWidth(elements.dailySpend, 900), height = window.matchMedia("(min-width: 1400px)").matches ? 600 : width < 560 ? 220 : 272, left = 52, right = 14, top = 14, bottom = 34;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = Math.max(0.001, ...items.flatMap((item) => providers.map((provider) => item[provider])));
  const { axisMaximum } = tickScale(maximum);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  for (let index = 0; index < 5; index += 1) {
    const y = top + (index / 4) * plotHeight;
    const value = axisMaximum * (1 - index / 4);
    svg.append(svgNode("line", { x1: left, x2: width - right, y1: y, y2: y, class: "grid-line" }));
    addSvgText(svg, shortMoney(value), left - 10, y + 4, "end");
  }
  const xAt = (index) => items.length === 1 ? left + plotWidth / 2 : left + (index / (items.length - 1)) * plotWidth;
  const tickRoom = Math.floor(plotWidth / (Math.max(...items.map(({ name }) => dayLabel(name).length)) * 7 + 16)) + 1;
  const tickIndexes = axisTickIndexes(items.length, tickRoom);
  for (const index of tickIndexes) addSvgText(svg, dayLabel(items[index].name), xAt(index), height - 12, index === 0 ? "start" : index === items.length - 1 ? "end" : "middle");
  const xs = items.map((_, index) => xAt(index));
  const baseline = top + plotHeight;
  const dots = {};
  for (const provider of providers) {
    const points = items.map((item, index) => ({ x: xs[index], y: top + (1 - item[provider] / axisMaximum) * plotHeight }));
    const encoding = { "data-series": provider };
    // The dashboard CSP forbids inline style attributes, so colour goes through CSSOM.
    const mark = (tag, attributes) => { const element = svgNode(tag, attributes); element.style.setProperty("--series-color", providerColor(provider)); return element; };
    const path = points.map(({ x, y }, index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    if (items.length > 1) svg.append(mark("path", { ...encoding, class: "trend-area", d: `${path} L${points.at(-1).x.toFixed(1)},${baseline} L${points[0].x.toFixed(1)},${baseline} Z` }));
    svg.append(mark("path", { ...encoding, class: "trend-line", d: path }));
    // A one- or two-day window has no visible line length, so the data points themselves are drawn.
    if (items.length <= 2) for (const point of points) svg.append(mark("circle", { ...encoding, class: "trend-point", cx: point.x.toFixed(1), cy: point.y.toFixed(1), r: 4.5 }));
    const dot = mark("circle", { ...encoding, class: "hover-dot", r: 4, cx: 0, cy: 0 }); dot.style.display = "none";
    dots[provider] = { dot, points }; svg.append(dot);
  }
  elements.dailySpend.append(svg);
  attachCrosshair(elements.dailySpend, svg, {
    xs, plotTop: top, plotBottom: baseline, plotLeft: left, plotRight: width - right, label: "Daily usage value in US dollars by provider",
    title: (index) => fullDate(items[index].name),
    rows: (index) => providers.map((provider) => ({ label: providerLabels[provider], color: providerColor(provider), value: money(items[index][provider]), dim: items[index][provider] <= 0 })),
    onIndex: (index) => {
      for (const provider of providers) {
        const { dot, points } = dots[provider];
        dot.style.display = index === null ? "none" : "";
        if (index !== null) { dot.setAttribute("cx", points[index].x.toFixed(1)); dot.setAttribute("cy", points[index].y.toFixed(1)); }
      }
      syncHover(index === null ? null : items[index].name);
    },
  });
  const legend = node("div");
  renderLegend(legend, providers.map((provider) => ({ id: provider, label: providerLabels[provider], color: providerColor(provider), value: totals[provider], valueLabel: money(totals[provider]), mark: "line" })), { target: svg, layout: "list" });
  elements.dailySpend.append(legend);
}

function arcPath(cx, cy, outer, inner, startAngle, endAngle) {
  const polar = (radius, angle) => [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const [sx, sy] = polar(outer, startAngle), [ex, ey] = polar(outer, endAngle);
  const [isx, isy] = polar(inner, endAngle), [iex, iey] = polar(inner, startAngle);
  return `M${sx.toFixed(2)},${sy.toFixed(2)} A${outer},${outer} 0 ${largeArc} 1 ${ex.toFixed(2)},${ey.toFixed(2)} L${isx.toFixed(2)},${isy.toFixed(2)} A${inner},${inner} 0 ${largeArc} 0 ${iex.toFixed(2)},${iey.toFixed(2)} Z`;
}

function renderDonut(sessions) {
  const counts = Object.fromEntries(providerOrder.map((provider) => [provider, 0]));
  for (const session of sessions) counts[session.provider] = (counts[session.provider] || 0) + 1;
  const total = sessions.length;
  const providers = Object.keys(counts).filter((provider) => counts[provider] > 0).sort((a, b) => counts[b] - counts[a]);
  clear(elements.providerDonut);
  elements.providerDonut.dataset.presentation = providers.length === 1 ? "text" : "chart";
  elements.providerLegend.hidden = providers.length === 1;
  if (providers.length === 1) {
    clear(elements.providerLegend);
    elements.providerDonut.append(node("p", `${integer(total)} session${total === 1 ? "" : "s"} · ${providerLabels[providers[0]]}`));
    return;
  }
  const svg = svgNode("svg", { viewBox: "0 0 120 120", role: "img", "aria-label": `${integer(total)} sessions by provider` });
  let angle = -Math.PI / 2;
  for (const provider of providers) {
    const sweep = counts[provider] / total * Math.PI * 2;
    const segments = sweep >= Math.PI * 2 - 0.0001 ? [[angle, angle + Math.PI], [angle + Math.PI, angle + Math.PI * 2]] : [[angle, angle + sweep]];
    for (const [start, end] of segments) svg.append(svgNode("path", { "data-series": provider, fill: providerColor(provider), d: arcPath(60, 60, 58, 40, start, end) }));
    angle += sweep;
  }
  if (total === 0) svg.append(svgNode("circle", { cx: 60, cy: 60, r: 49, fill: "none", stroke: "var(--surface-3)", "stroke-width": 18 }));
  const center = node("div", null, "donut-center");
  center.append(node("strong", integer(total)), node("span", total === 1 ? "session" : "sessions"));
  elements.providerDonut.append(svg, center);
  renderLegend(elements.providerLegend, providers.map((provider) => ({
    id: provider, label: shortProviderLabels[provider] ?? providerLabels[provider] ?? "Unknown", color: providerColor(provider),
    value: counts[provider], valueLabel: integer(counts[provider]), share: counts[provider] / total, mark: "logo", icon: providerMark(provider),
  })), { target: elements.providerDonut, layout: "list" });
}

function tableCell(primary, secondary, className) {
  const cell = node("td"); cell.append(node("span", primary, className));
  if (secondary) cell.append(node("small", secondary)); return cell;
}

function renderRepositoryTable(repositories) {
  const restoreFocus = rememberFocus();
  clear(elements.repositoryRows);
  const selected = selectedRepository();
  const context = velocityContext();
  const key = `${snapshot.generatedAt}|${context.start}|${context.end}|${elements.repositoryFilter.value}`;
  if (tableExpansion.key !== key) tableExpansion = { key, showEmpty: false };
  const quiet = selected ? [] : repositories.filter(({ summary }) => summary.sessions === 0);
  const visible = selected || tableExpansion.showEmpty ? repositories : repositories.filter(({ summary }) => summary.sessions > 0);
  const sorted = sortRepositories(visible, tableSort.key, tableSort.direction);
  $("#comparison-title").textContent = selected ? `${selected.repository.name} vs fleet` : "Repositories";
  const hint = $("#repository-table-hint");
  clear(hint);
  if (selected) {
    const button = statusAction("Clear focus", () => selectRepository("all", { scroll: false }));
    button.dataset.focusKey = "table:clear-focus";
    hint.append(node("span", `Showing ${selected.repository.name} · `), button);
    const ledger = ledgerMoney(snapshot.sessions, context);
    sorted.push({ repository: { id: null, name: "All repositories" }, summary: summarize(sessionsInWindow(snapshot.sessions)), usage: { value: ledger.total, evidence: ledger.evidence, available: ledgerAvailability(snapshot.sessions).eligible > 0 } });
  } else hint.textContent = "Click a column to sort · click a row to focus";
  const footer = $("#repository-footer");
  clear(footer);
  if (quiet.length && !tableExpansion.showEmpty) {
    const row = node("tr"), cell = node("td", null, "empty-line"); cell.colSpan = 8;
    const button = statusAction("Show them", () => {
      tableExpansion.showEmpty = true;
      renderRepositoryTable(repositories);
      elements.repositoryRows.querySelector("button.row-link")?.focus({ preventScroll: true });
    });
    button.dataset.focusKey = "table:show-empty";
    cell.append(node("span", `${integer(quiet.length)} repositor${quiet.length === 1 ? "y" : "ies"} without sessions · `), button);
    row.append(cell); footer.append(row);
  }
  for (const button of sortButtons) {
    const header = button.closest("th");
    if (button.dataset.sort === tableSort.key) header.setAttribute("aria-sort", tableSort.direction);
    else header.removeAttribute("aria-sort");
  }
  const selectedId = elements.repositoryFilter.value;
  for (const item of sorted) {
    const row = node("tr"); const summary = item.summary;
    const comparator = item.repository.id === null;
    const repositoryDetails = comparator ? item.repository.name : `${item.repository.name} · ID ${repositoryKey(item.repository.id)}`;
    if (comparator) row.className = "fleet-total";
    row.setAttribute("aria-label", `${repositoryDetails} · ${summary.sessions} session${summary.sessions === 1 ? "" : "s"} · ${executionBreakdown(summary)}`);
    if (!comparator) row.dataset.rowLink = "true";
    const repositoryButton = node(comparator ? "span" : "button", item.repository.name, comparator ? "" : "row-link"); repositoryButton.type = "button";
    repositoryButton.title = repositoryDetails;
    if (item.repository.duplicateName) repositoryButton.title += " · another checkout with the same name"; repositoryButton.setAttribute("aria-label", repositoryDetails);
    repositoryButton.dataset.focusKey = `table:${item.repository.id}`;
    if (item.repository.id === selectedId) { row.setAttribute("aria-current", "true"); repositoryButton.setAttribute("aria-current", "true"); }
    if (!comparator) {
      repositoryButton.addEventListener("click", () => selectRepository(item.repository.id));
      row.addEventListener("click", (event) => { if (event.target.closest?.("button")) return; selectRepository(item.repository.id); });
    }
    const repositoryCell = node("td"); repositoryCell.append(repositoryButton);
    const sessionsCell = tableCell(String(summary.sessions)); sessionsCell.title = executionBreakdown(summary);
    sessionsCell.setAttribute("aria-label", `${summary.sessions} · ${sessionsCell.title}`);
    const covered = (value, coverage, format, what) => { const cell = node("td"); cell.append(valueWithCoverage(value, coverage, format, what, "span")); return cell; };
    // Usage value and Priced read the window's activity ledger (the KPI's rows); the other columns cover sessions started in the window.
    const value = node("td");
    if (item.usage.available === false) { const dash = node("span", DASH, "unavailable"); dash.title = "No session in this repository has activity dates"; value.append(dash); }
    else value.append(node("span", money(item.usage.value)));
    row.append(repositoryCell, sessionsCell, value, covered(summary.totalInputTokens, summary.coverage.tokens, (v) => compact(v), "token evidence"), covered(summary.outputTokens, summary.coverage.tokens, (v) => compact(v), "token evidence"), covered(summary.toolCalls, summary.coverage.tools, (v) => compact(v), "tool evidence"), covered(summary.cacheReadRatio, summary.coverage.tokens, percent, "token evidence"), tableCell(pricedShare(item.usage.evidence) === null ? DASH : pricedPercent(item.usage.evidence), `${summary.analyzedSessions}/${summary.sessions} parsed`));
    elements.repositoryRows.append(row);
  }
  if (sorted.length === 0) {
    const row = node("tr"); const cell = node("td"); cell.colSpan = 8; emptyState(cell, "No repositories with sessions in this window."); row.append(cell); elements.repositoryRows.append(row);
  }
  restoreFocus();
}

function renderWarnings(warnings) {
  clear(elements.warningList); elements.warning.hidden = !warnings.length;
  warnings.forEach((warning) => elements.warningList.append(node("li", warning)));
  elements.coverageLabel.textContent = warnings.length ? `Coverage · ${integer(warnings.length)}` : "Coverage";
  elements.coverageDot.hidden = !warnings.length;
  elements.coverageButton.setAttribute("aria-label", `Coverage: ${integer(warnings.length)} notes`);
}

/** Selection explanations live in Coverage; chart and KPI notes stay short. */
function renderCoverageSummary(view) {
  elements.coverageCostNote.hidden = true;
  const summary = view.summary, activity = view.activity, context = velocityContext();
  const excluded = [`${money(activity.undated[0])} undated`, ...(activity.unledgered.sessions ? [`${money(activity.unledgered.value)} in ${activity.unledgered.sessions} older-snapshot session${activity.unledgered.sessions === 1 ? "" : "s"} without activity dates (refresh to include)`] : [])];
  elements.coverageUsageNote.textContent = `By activity date (${context.timeZone})${activity.sessionDated[0] > 0 ? ` · includes ${money(activity.sessionDated[0])} session-dated (${activity.sessionDatedSessions} session${activity.sessionDatedSessions === 1 ? "" : "s"} without request times, dated by last activity)` : ""} · excludes, across all time, ${excluded.join(" and ")}${activity.missingSessions ? ` · ${activity.missingSessions} session${activity.missingSessions === 1 ? "" : "s"} need a refresh` : ""} · not an invoice`;
  if (summary.retainedSessions) elements.coverageUsageNote.textContent += " · retained history uses last-ingest prices";
  elements.coverageLiveNote.textContent = `${integer(summary.workingSnapshots)} live snapshots from present sources; totals may still move.${summary.historicalWorkingSnapshots ? ` ${integer(summary.historicalWorkingSnapshots)} historical working observations excluded.` : ""}`;
  elements.coverageSessionNote.textContent = `${executionBreakdown(summary)}${view.undatedStarts ? ` · ${view.undatedStarts} unknown starts${windowPreset === "all" ? " included" : " excluded"}` : ""}`;

  const sessions = view.sessions.length;
  if (!sessions) { elements.coverageSummary.textContent = "No sessions in this selection. Widen the window or clear the repository focus."; return; }
  const part = (metric, what) => { const { eligible } = metricCoverage(view.sessions, metric); return `${eligible} ${what}`; };
  elements.coverageSummary.textContent = `${sessions} selected session${sessions === 1 ? "" : "s"} across ${view.summary.repositoriesWithSessions} repositor${view.summary.repositoriesWithSessions === 1 ? "y" : "ies"}: ${part("tokens", "carry token evidence")}, ${part("tools", "tool evidence")}, ${part("cost", "priced or reported value")}. Every number is a lower bound from local evidence; badges on the dashboard show the eligible share behind each figure.`;
}

function openCoverage() { closePalette(); closeMachines(); if (elements.help.open) elements.help.close(); if (!elements.coverageDialog.open) elements.coverageDialog.showModal(); }
function closeCoverage() { if (elements.coverageDialog.open) elements.coverageDialog.close(); }
function openMachines() { closePalette(); closeCoverage(); if (elements.help.open) elements.help.close(); if (!elements.machinesDialog.open) elements.machinesDialog.showModal(); }
function closeMachines() { if (elements.machinesDialog.open) elements.machinesDialog.close(); }

// --------------------------------------------------------------------- machines

/** Keep the compact status meaningful while preserving the full snapshot description. */
function describeSyncStatus() {
  const label = elements.syncLabel.textContent;
  elements.sync.setAttribute("aria-label", label); elements.sync.title = label;
  elements.syncShort.textContent = { live: "Ready", reading: "Reading…", loading: "Reading…", warn: "Check", error: "Stale" }[elements.sync.dataset.state] ?? "Check";
  if (elements.sync.dataset.state === "error" && !snapshot && !sharedSnapshot) elements.syncShort.textContent = "Failed";
}

/** The sync label once a snapshot is shown: which machines it covers, which are missing, and the live sessions. */
function showReady(view) {
  const machines = fullSnapshot?.machines ?? [], { ok, total, failed, stale, reading } = machineTally(machines);
  const named = (...states) => machines.filter(({ state }) => states.includes(state)).map(({ label }) => label).join(", ");
  const working = view?.summary.workingSnapshots ?? 0;
  const live = working ? ` · ${integer(working)} session${working === 1 ? "" : "s"} in progress` : "";
  elements.sync.dataset.state = failed || stale ? "warn" : reading ? "reading" : "live";
  elements.syncLabel.textContent = total < 2 ? `Local snapshot ready${live}`
    : `${ok} of ${total} machines ready${reading ? ` · reading ${named("reading")}` : ""}${failed ? ` · ${named("failed")} not read` : ""}${stale ? ` · ${named("stale")} stale` : ""}${live}`;
  describeSyncStatus();
}

/** Narrow every view to the machines switched on; history coverage needs them all. */
function applyMachines() {
  const machines = fullSnapshot.machines ?? [];
  for (const key of [...hiddenMachines]) if (!machines.some((machine) => machine.key === key)) hiddenMachines.delete(key);
  snapshot = machineView(repositoryDisplaySnapshot(fullSnapshot), new Set(machines.map(({ key }) => key).filter((key) => !hiddenMachines.has(key))));
  sessionsByRepository = groupByRepository(snapshot.sessions); navCache = { key: null };
  for (const input of providerFilters) input.closest(".chip").hidden = !snapshotProviders().includes(input.dataset.providerFilter);
  populateRepositories();
}

function setMachine(key, on) {
  if (on) hiddenMachines.delete(key); else hiddenMachines.add(key);
  applyMachines(); renderMachines(); renderView();
  syncUrl("replace");
}

/** The strip's note: the snapshot's time, or on Subscription, which machines it counts whatever the strip shows. */
function renderStripMeta() {
  if (!fullSnapshot || (fullSnapshot.machines?.length ?? 0) < 2) return;
  // A machine whose sessions are not in the snapshot moves the meters but adds no value, so it is not counted here.
  const counted = valuedMachines(limits, sessionMachines(fullSnapshot)), read = limits?.machines?.filter(({ key }) => counted?.has(key)).map(({ label }) => label) ?? [];
  elements.machineStripMeta.textContent = currentViewName() !== "subscription" ? `snapshot ${timeLabel(fullSnapshot.generatedAt, snapshotTimeZone())}`
    : read.length > 1 ? `Subscription counts ${read.join(" + ")}` : "Subscription counts this machine only";
}

/** Where Coverage sends a person whose agents also run on a server or VM. */
const combineMachinesGuide = "https://github.com/rokas-tarasevicius/session-analytics/blob/master/docs/interop.md#combine-machines";

/**
 * The Machines strip and its dialog. A machine with sessions to show is a chip that filters every view;
 * one without is a button to its reason and fix. Shown only when the snapshot combines machines.
 */
function renderMachines() {
  const machines = fullSnapshot?.machines ?? [], restoreFocus = rememberFocus();
  elements.machineStrip.hidden = machines.length < 2;
  // With this machine alone, Coverage says once where other machines are added. The page itself names no outside address.
  elements.coverageMachinesNote.hidden = !fullSnapshot || machines.length > 1;
  elements.coverageMachinesLink.setAttribute("href", combineMachinesGuide);
  clear(elements.machineChips); clear(elements.machinesRows);
  if (machines.length < 2) return;
  const timeZone = snapshotTimeZone();
  for (const machine of machines) {
    const note = machineNote(machine), counted = machine.state !== "failed" && Boolean(machine.readAt);
    const chip = node(counted ? "label" : "button", null, "chip machine-chip");
    chip.dataset.state = machine.state;
    if (counted) {
      const input = node("input"); input.type = "checkbox"; input.checked = !hiddenMachines.has(machine.key);
      input.dataset.focusKey = `machine:${machine.key}`;
      chip.setAttribute("title", `${integer(machine.sessions)} sessions read from ${machine.label}, all time`);
      input.setAttribute("aria-label", `${machine.label}: ${integer(machine.sessions)} sessions, all time${note ? `, ${note}` : ""}`);
      input.addEventListener("change", () => setMachine(machine.key, input.checked));
      chip.append(input, node("span", machine.label), node("small", integer(machine.sessions)));
    } else {
      chip.type = "button"; chip.dataset.focusKey = `machine:${machine.key}`;
      chip.setAttribute("aria-label", `${machine.label}: ${note}. Show machine details`);
      chip.addEventListener("click", openMachines);
      chip.append(node("span", machine.label));
    }
    if (note) chip.append(node("small", note, "machine-note"));
    elements.machineChips.append(chip);
  }
  renderStripMeta();
  const { ok, total } = machineTally(machines);
  elements.machinesSummary.textContent = `${ok} of ${total} machines read now. Switch a machine off in the strip to see the others alone; every view, export and total follows, except Subscription, which counts every machine whose limits and sessions were read.`;
  elements.machinesRead.hidden = !machines.some(({ state }) => state === "failed" || state === "stale");
  elements.machinesRead.disabled = false; elements.machinesRead.textContent = "Read them again";
  for (const machine of machines) {
    const row = node("tr"), cell = (value, left = false) => { const item = node("td", value); if (left) item.className = "align-left"; return item; };
    const state = machine.state === "ok" ? (machine.reason ? machineReasons[machine.reason] ?? machine.reason : "read") : machineNote(machine);
    row.append(cell(machine.label, true), cell(state, true), cell(machine.readAt ? integer(machine.sessions) : DASH), cell(machine.readAt ? integer(machine.repositories) : DASH),
      cell(machine.readAt ? `${timeLabel(machine.readAt, timeZone)} · ${machineAge(machine.readAt)}` : DASH, true),
      cell(machine.durationMs === null ? DASH : `${(machine.durationMs / 1000).toFixed(1)} s`), cell(machine.version ?? DASH, true));
    elements.machinesRows.append(row);
    if (!machine.fix) continue;
    const fix = node("tr", null, "machine-fix"), text = node("td", null, "align-left"); text.colSpan = 7;
    text.append(node("span", "Fix: "), node("code", machine.fix)); fix.append(text); elements.machinesRows.append(fix);
  }
  restoreFocus();
}

/** Usage value per machine for the window, so "how much of this is the server?" has an answer. */
function renderMachineSpend(view, context) {
  const machines = fullSnapshot?.machines ?? [];
  elements.machineSpendPanel.hidden = machines.length < 2;
  if (machines.length < 2) return;
  // A machine without a snapshot has no value to show, not a value of zero.
  renderBars(elements.machineSpend, machines.filter(({ key, state, readAt }) => !hiddenMachines.has(key) && state !== "failed" && readAt).map((machine) => {
    const own = (session) => sessionMachine(session, machines) === machine.key, started = view.sessions.filter(own).length;
    return { id: `machine:${machine.key}`, name: `${machine.label} · ${integer(started)} session${started === 1 ? "" : "s"}`, value: buildVelocity(view.scopeSessions.filter(own), { start: context.start, end: context.end, metric: "value" }).totals[0] };
  }).sort((left, right) => right.value - left.value), money, machines.length);
}

/**
 * While a machine is still reading, ask the server every 2 s; once one answers, fetch the snapshot that includes it.
 * A fetch that fails starts the polling again, so one error does not leave a machine shown as reading.
 */
function watchMachines(reading = (fullSnapshot?.machines ?? []).filter(({ state }) => state === "reading").map(({ key }) => key)) {
  if (machinePoll !== null) { clearInterval(machinePoll); machinePoll = null; }
  if (!reading.length || typeof setInterval !== "function") return;
  machinePoll = setInterval(() => void (async () => {
    const response = await fetch("/api/machines");
    if (!response.ok) return;
    const { machines } = await response.json();
    if (!machines.some(({ key, state }) => reading.includes(key) && state !== "reading")) return;
    clearInterval(machinePoll); machinePoll = null;
    if (!(await quietLoad())) watchMachines(reading);
  })().catch(() => { /* The next poll asks again. */ }), 2000);
}

/** Read the machines that failed again, without scanning this one: after fixing one, this takes seconds, not a full refresh. */
async function readMachinesAgain() {
  elements.machinesRead.disabled = true; elements.machinesRead.textContent = "Reading…";
  try {
    const response = await fetch("/api/machines?read=1");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { machines } = await response.json();
    // A dashboard showing a saved snapshot file reads no machine.
    if (!machines.length) { elements.machinesRead.hidden = true; return; }
    const reading = machines.filter(({ state }) => state === "reading").map(({ key }) => key);
    if (reading.length) { watchMachines(reading); return; }
  } catch { /* The button comes back; Refresh reads everything. */ }
  elements.machinesRead.disabled = false; elements.machinesRead.textContent = "Read them again";
}

function renderRateCards(rateCard) {
  clear(elements.rateCardLinks);
  const groups = new Map();
  for (const item of rateCard.models) {
    if (!/^https?:\/\//i.test(item.source ?? "")) continue;
    const source = item.provenance?.source ?? "reviewed";
    const urls = groups.get(source) ?? new Map();
    urls.set(item.source, item.model); groups.set(source, urls);
  }
  const link = (url, label) => { const anchor = node("a", label); anchor.href = url; anchor.target = "_blank"; anchor.rel = "noreferrer"; return anchor; };
  for (const [source, urls] of groups) {
    if (urls.size === 1) { elements.rateCardLinks.append(link([...urls.keys()][0], `${source} rates ↗`)); continue; }
    const details = node("details", null, "rate-links");
    details.append(node("summary", `${source} rates · ${urls.size} sources`));
    const list = node("div");
    for (const [url, model] of urls) list.append(link(url, `${model} ↗`));
    details.append(list); elements.rateCardLinks.append(details);
  }
}

function populateRepositories() {
  const previous = elements.repositoryFilter.value;
  clear(elements.repositoryFilter); elements.repositoryFilter.append(new Option("All repositories", "all"));
  for (const item of snapshot.repositories) elements.repositoryFilter.append(new Option(item.repository.name, item.repository.id));
  elements.repositoryFilter.value = [...elements.repositoryFilter.options].some((option) => option.value === previous) ? previous : "all";
}

/**
 * Sidebar repository list. Values and sparklines depend only on the snapshot and the window, so they are cached and
 * the DOM is reused across view and scope changes (only aria-pressed moves). Hidden (icon-rail) layouts skip the work.
 */
function renderRepositoryNav() {
  if (!wideLayout.matches) { navDirty = true; return; }
  navDirty = false;
  const start = elements.windowStart.value || elements.windowStart.min, end = elements.windowEnd.value || elements.windowEnd.max;
  const key = `${snapshot.generatedAt}|${start}|${end}`;
  if (navCache.key !== key) {
    const days = daysBetween(start, end);
    const activity = buildVelocity(snapshot.sessions, { start, end, group: "repository", metric: "value" });
    const byRepository = new Map(activity.allSeries.map((series) => [series.id, series]));
    const rows = snapshot.repositories.map((item) => {
      const series = byRepository.get(item.repository.id);
      return { id: item.repository.id, name: item.repository.name, duplicateName: item.repository.duplicateName, series: series?.values ?? days.map(() => 0), value: series?.total ?? 0 };
    }).sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
    navCache = { days, key, rows, total: activity.totals[0] };
    const scrollTop = elements.repositoryList.scrollTop;
    navHoverListeners.clear();
    clear(elements.repositoryList);
    const allRow = node("button", null, "repo-row all-row"); allRow.type = "button";
    allRow.dataset.repository = "all"; allRow.dataset.focusKey = "repo:all";
    allRow.append(icon("summary"), node("span", "All repositories", "repo-name"), node("span", shortMoney(navCache.total), "repo-value"));
    allRow.addEventListener("click", () => selectRepository("all", { scroll: false }));
    elements.repositoryList.append(allRow);
    for (const row of rows) {
      const button = node("button", null, "repo-row"); button.type = "button";
      if (row.duplicateName) button.title = "another checkout with the same name";
      button.dataset.repository = row.id; button.dataset.focusKey = `repo:${row.id}`;
      const spark = svgNode("svg", { class: "spark" });
      renderSparkline(spark, row.series, days, { format: money, height: 16, label: `${row.name} daily usage value`, listeners: navHoverListeners, width: 44 });
      button.append(node("span", row.name, "repo-name"), spark, node("span", shortMoney(row.value), "repo-value"));
      button.addEventListener("click", () => selectRepository(button.getAttribute("aria-pressed") === "true" ? "all" : row.id, { scroll: false }));
      elements.repositoryList.append(button);
    }
    elements.repositoryList.scrollTop = scrollTop;
    elements.repositoryNavCount.textContent = String(rows.length);
  }
  const selectedId = elements.repositoryFilter.value;
  const values = new Map([["all", navCache.total], ...navCache.rows.map((row) => [row.id, row.value])]);
  const names = new Map([["all", "All repositories"], ...navCache.rows.map((row) => [row.id, row.name])]);
  for (const button of elements.repositoryList.querySelectorAll("[data-repository]")) {
    const id = button.dataset.repository, active = id === selectedId;
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", `${id === "all" ? "" : active ? "Clear focus on " : "Focus "}${names.get(id)}, ${money(values.get(id))} in the selected window`);
  }
}

wideLayout.addEventListener("change", () => { if (snapshot && navDirty) renderRepositoryNav(); });

function windowCaption() {
  if (elements.windowStart.value === elements.windowStart.min && elements.windowEnd.value === elements.windowEnd.max) return "all observed dates";
  return dateRange(elements.windowStart.value, elements.windowEnd.value);
}

function renderSharedView(view) {
  if (!["loading", "error"].includes(elements.sync.dataset.state)) showReady(view);
  const retained = view?.summary?.retainedSessions ?? 0;
  elements.retentionNote.hidden = !retained;
  elements.retentionNote.textContent = `${retained} source-deleted sessions retain facts and prices from their last successful ingest. Historical working status does not establish current activity.`;
  const selected = selectedRepository();
  // One calendar (the snapshot timezone) and one dating rule everywhere: value by activity date, counts by session start.
  const name = currentViewName(), timeZone = snapshotTimeZone();
  const population = name === "velocity" ? `Activity observed during ${windowCaption()} (${timeZone}).`
    : name === "summary" ? `Usage value by activity date; sessions, tokens and tools for sessions started during ${windowCaption()} (${timeZone}).`
    : name === "costs" || name === "pricing" ? `Usage value by activity date during ${windowCaption()} (${timeZone}).`
    : `Sessions started during ${windowCaption()} (${timeZone}); whole-session totals.`;
  if (name === "summary" && selected) {
    elements.scope.textContent = `${selected.repository.name} · ${integer(view.sessions.length)} session${view.sessions.length === 1 ? "" : "s"} · ${dateRange(elements.windowStart.value, elements.windowEnd.value)} (${timeZone})`;
  } else if (name === "summary" && view.sessions.length === 1 && soleContributor(view, view.sessions[0])) {
    const session = view.sessions[0];
    elements.scope.textContent = `1 session · ${dateLabel(sessionStartDay(session, timeZone) ?? elements.windowStart.value)} · ${session.repositoryName} · ${providerLabels[session.provider]} · ${ledgerAvailability(view.scopeSessions).eligible ? money(view.activity.totals[0]) : DASH}`;
  } else {
    elements.scope.textContent = `${selected ? `Focused on ${selected.repository.name}.` : `${integer(view.summary.repositories)} repositor${view.summary.repositories === 1 ? "y" : "ies"} · ${integer(view.summary.repositoriesWithSessions)} with sessions.`} ${population}`;
  }
  elements.scopeChip.hidden = !selected;
  elements.scopeChipLabel.textContent = selected ? selected.repository.name : "";
  elements.scopeChip.setAttribute("aria-label", selected ? `${selected.repository.name}: clear repository focus` : "Clear repository focus");
  renderRepositoryNav();
}

function renderDelta(element, delta) {
  element.hidden = !delta;
  if (!delta) return;
  element.dataset.direction = delta.direction;
  element.textContent = delta.text;
  element.setAttribute("aria-label", delta.label);
}

/** The usage-value delta follows the same guarded period comparison as Velocity. */
function spendDelta(comparison, length) {
  if (!comparison || (comparison.status !== "change" && comparison.status !== "new")) return null;
  const delta = deltaDescription(comparison.current.value, comparison.status === "new" ? 0 : comparison.previous.value, length);
  return delta && comparison.partial ? { ...delta, text: `${delta.text} · partial`, label: `${delta.label}, partially priced` } : delta;
}

/** Top-level, sub-agent, mixed and unknown sessions: each session counted once, so the parts add up to the total. */
function executionBreakdown(summary) {
  const mixed = summary.mixedSessions ?? 0, unknown = summary.unknownExecutionSessions ?? 0;
  return [`${summary.topLevelSessions - mixed} top-level`, `${summary.subagentSessions - mixed} sub-agent`, mixed ? `${mixed} mixed` : null, unknown ? `${unknown} execution unknown` : null].filter(Boolean).join(" · ");
}

/** Window ledger value recorded by sub-agent executions (explicit evidence only, so a lower bound). */
/** The compact one-session caption applies only when that session is the window's sole activity contributor; sessions started earlier can add value. */
function soleContributor(view, session) {
  const context = velocityContext();
  return view.activity.contributingSessions === buildVelocity([session], { start: context.start, end: context.end, metric: "value" }).contributingSessions;
}

function subagentValue(sessions, { start, end }) {
  return buildVelocity(sessions, { start, end, group: "execution", metric: "value" }).allSeries.find(({ id }) => id === "subagent")?.total ?? 0;
}

function renderSummary(view) {
  // History coverage spans every machine, whichever are switched on.
  renderHistoryCoverage($("#history-coverage"), (fullSnapshot ?? snapshot).historyCoverage, (fullSnapshot ?? snapshot).sessions, fullSnapshot?.machines);
  const summary = view.summary;
  const days = windowDays();
  const context = velocityContext();
  // The ledger pass grouped by repository (activeView) serves the KPI, its sparkline, the repository bars and the fleet table.
  const activity = view.activity;
  // Deltas compare against the equal-length period immediately before the window, only when that period is fully observed.
  const previous = windowPreset === "all" ? null : previousPeriod({ end: context.end, min: elements.windowStart.min, start: context.start });
  const previousSummary = previous ? summarize(sessionsInRange(view.scopeSessions, previous.startDay, previous.endDay, context.timeZone)) : null;
  const previousActivity = previous ? buildVelocity(view.scopeSessions, { start: previous.startDay, end: previous.endDay, metric: "value" }) : null;
  const spendComparison = previousActivity ? comparePeriods(periodFromVelocity(activity), periodFromVelocity(previousActivity), "value", { missingSessions: activity.missingSessions }) : null;
  const unavailable = ledgerAvailability(view.scopeSessions).eligible === 0;
  clear(elements.spendCoverage);
  setValue(elements.spend, activity.totals[0], unavailable ? { eligible: 0, selected: view.scopeSessions.length } : null, money, { reason: "No session in this selection has activity dates", slot: elements.spendCoverage });
  if (!unavailable && activity.missingSessions) {
    const badge = node("small", "partial", "coverage");
    badge.title = `${activity.missingSessions} session${activity.missingSessions === 1 ? "" : "s"} need a refresh to collect activity dates`;
    badge.setAttribute("aria-label", badge.title); elements.spendCoverage.append(badge);
  } else if (!unavailable) { const badge = pricedBadge(activity.evidence); if (badge) elements.spendCoverage.append(badge); }
  elements.spendNote.textContent = "Activity-dated. Not an invoice.";
  elements.sessions.textContent = `${summary.analyzedSessions}/${summary.sessions}`;
  elements.sessionNote.textContent = "By session start";
  renderMetricValue(elements.input, summary.totalInputTokens, summary.coverage.tokens, (v) => compact(v), "token evidence", elements.inputCoverage);
  elements.cache.textContent = summary.coverage.tokens.eligible && summary.cacheReadRatio !== null ? `${percent(summary.cacheReadRatio)} cached` : "Cache share unavailable";
  renderMetricValue(elements.output, summary.outputTokens, summary.coverage.tokens, (v) => compact(v), "token evidence", elements.outputCoverage); renderMetricValue(elements.tools, summary.toolCalls, summary.coverage.tools, (v) => compact(v), "tool evidence", elements.toolsCoverage); renderMetricValue(elements.compactions, summary.compactions, summary.coverage.compactions, (v) => integer(v), "compaction evidence", elements.compactionsCoverage);
  const count = (accessor) => dailyCountSeries(view.sessions, days, accessor, context.timeZone);
  const metrics = [
    ["spend", `Usage value by activity date (${context.timeZone}), including session-dated value; undated value excluded`, money, activity.totals[0], previousActivity?.totals[0], activity.daily.map(({ total }) => total)],
    ["sessions", "Sessions started per day", integer, summary.sessions, previousSummary?.sessions, count(() => 1)],
    ["input", "Request input processed per session-start day", compact, summary.totalInputTokens, previousSummary?.totalInputTokens, count(({ tokens }) => tokens.inputTokens)],
    ["output", "Output tokens per session-start day", compact, summary.outputTokens, previousSummary?.outputTokens, count(({ tokens }) => tokens.outputTokens)],
    ["tools", "Effective tool calls per session-start day", integer, summary.toolCalls, previousSummary?.toolCalls, count(({ metrics: item }) => item.toolCalls)],
    ["compactions", "Compactions per session-start day", integer, summary.compactions, previousSummary?.compactions, count(({ metrics: item }) => item.compactions)],
  ];
  for (const [name, label, format, current, before, series] of metrics) {
    renderDelta($(`#metric-${name}-delta`), name === "spend" ? spendDelta(spendComparison, previous?.length) : previousSummary ? deltaDescription(current, before, previous.length) : null);
    renderSparkline($(`#metric-${name}-spark`), series, days, { format, label });
  }
  renderLine(dailyProviderSpend(view.dailySessions)); renderDonut(view.sessions); renderMachineSpend(view, context);
  const selected = selectedRepository();
  const ledger = ledgerMoney(view.scopeSessions, context);
  $("#repository-spend-title").textContent = selected ? "Usage value by provider" : "Usage value by repository";
  $("#repository-tokens-title").textContent = selected ? "Request input by provider" : "Request input processed by repository";
  if (selected) {
    renderBars(elements.repositorySpend, ledger.providers.map(({ provider, total }) => ({ name: providerLabels[provider], value: total })), money, providerOrder.length);
    const providers = presentProviders(view.sessions).map((provider) => {
      const summary = summarize(view.sessions.filter((session) => session.provider === provider));
      return { name: providerLabels[provider], value: summary.totalInputTokens, coverage: summary.coverage.tokens, what: "token evidence" };
    }).sort((a, b) => b.value - a.value);
    renderBars(elements.repositoryTokens, providers, compact, providerOrder.length);
  } else {
    const active = view.repositories.filter((item) => item.summary.sessions > 0 || activity.allSeries.some(({ id }) => id === item.repository.id));
    const quiet = view.repositories.length - active.length;
    renderBars(elements.repositorySpend, active.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.usage.value })).sort((a, b) => b.value - a.value), money, 12, ({ id }) => selectRepository(id));
    renderBars(elements.repositoryTokens, active.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.totalInputTokens, coverage: item.summary.coverage.tokens, what: "token evidence" })).sort((a, b) => b.value - a.value), compact, 12, ({ id }) => selectRepository(id));
    if (quiet) for (const container of [elements.repositorySpend, elements.repositoryTokens]) container.append(node("p", `${integer(quiet)} repositor${quiet === 1 ? "y" : "ies"} had no activity in this window`, "empty-line"));
  }
  // Model mix: the same ledger, one row per model and provider ("model · Provider"), as on Costs.
  // The bars add up to the KPI: past eight rows the remainder is one "Other" row.
  const mix = ledger.models.filter(({ value }) => value > 0).map(({ id, model, provider, label, value }) => ({ id, name: label, model, value, provider }));
  const rest = mix.slice(7);
  renderBars(elements.modelSpend, mix.length > 8 ? [...mix.slice(0, 7), { id: "other", name: `Other (${rest.length} models)`, value: rest.reduce((total, { value }) => total + value, 0) }] : mix, money, 8);
  renderBars(elements.toolCalls, view.topTools, (value) => integer(value), 10);
  if (!summary.coverage.tools.eligible) { clear(elements.toolCalls); elements.toolCalls.append(node("p", `${DASH} No tool evidence in ${summary.coverage.tools.selected} selected sessions`, "empty-line")); }
  // Explicit sub-agent value: ledger cells whose execution kind is "subagent", per repository and window.
  const subagentNote = $("#subagent-note");
  subagentNote.hidden = !selected;
  elements.repositorySubagentSpend.hidden = Boolean(selected);
  const subagentWindow = context.start === context.end ? `on ${dateLabel(context.start)}` : `during ${dateRange(context.start, context.end)}`;
  if (selected) {
    clear(elements.repositorySubagentSpend);
    // Sub-agent sessions without an activity ledger have no measurable value: show a dash, never a measured zero.
    const pool = view.scopeSessions.filter(({ executionKind }) => executionKind === "subagent" || executionKind === "mixed");
    const count = `${integer(summary.subagentSessions)} sub-agent session${summary.subagentSessions === 1 ? "" : "s"}`;
    subagentNote.textContent = !summary.subagentSessions ? `No sub-agent sessions ${subagentWindow}.`
      : !ledgerAvailability(pool).eligible ? `Sub-agent value ${DASH} · ${count} · no activity dates`
      : `Sub-agent value ${money(subagentValue(view.scopeSessions, context))} · ${count}`;
  } else {
    const items = view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: subagentValue(repositorySessions(item.repository.id), context) })).filter(({ value }) => value > 0).sort((a, b) => b.value - a.value);
    if (items.length) renderBars(elements.repositorySubagentSpend, items, money, 10, ({ id }) => selectRepository(id));
    else {
      clear(elements.repositorySubagentSpend);
      const message = summary.subagentSessions ? `No dated sub-agent value ${subagentWindow}.` : `No sub-agent sessions ${subagentWindow}.`;
      emptyState(elements.repositorySubagentSpend, message);
    }
  }
  renderRepositoryTable(view.repositories); renderWarnings(view.warnings);
}

/** True when nothing in the selection started or was active during the window. */
function windowHasNoActivity(view) {
  if (view.sessions.length) return false;
  const { start, end } = velocityContext();
  return !view.scopeSessions.some((session) => ledgerCells(session.velocity).some(([day]) => day >= start && day <= end));
}

function statusAction(label, run) {
  const button = node("button", label, "button"); button.type = "button";
  button.addEventListener("click", run);
  return button;
}

/** Provider-filter emptiness is separate from the shared date-window status. */
function renderProviderEmptyState(container, scope, eligibleCount, windowCount) {
  const providers = snapshotProviders(), selected = providers.filter((provider) => viewProviderFilters[scope].has(provider));
  if (selected.length && eligibleCount) return false;
  const names = disjunction(selected.map((provider) => providerLabels[provider] ?? provider));
  const message = !selected.length ? `Every provider is switched off for this view, so there are no ${scope === "tools" ? "tool calls" : "session starts"} to show.`
    : `None of the ${integer(windowCount)} sessions in this window came from ${names}.`;
  const box = emptyState(container, message, selected.length ? "No sessions from the selected providers" : "No providers selected");
  if (!selected.length || selected.length < providers.length) {
    const actions = node("div", null, "status-actions");
    const button = statusAction("Select all providers", () => {
      viewProviderFilters[scope] = new Set(snapshotProviders());
      renderActiveAnalyticsView(activeView());
      syncUrl();
      // The button is gone after the re-render: keep keyboard focus in the view, on its first provider chip.
      document.querySelector?.(`[data-focus-key="filter:${scope}:${snapshotProviders()[0]}"]`)?.focus?.({ preventScroll: true });
    });
    button.dataset.focusKey = `${scope}:select-all-providers`;
    actions.append(button); box.append(actions);
  }
  return true;
}

/** The view-level status in place of the panels: no snapshot, or nothing in the selected window. */
function renderViewStatus(view) {
  const target = elements.viewStatus;
  if (!target) return;
  clear(target);
  if (!snapshot && loadFailed) {
    emptyState(target, "The local analysis did not finish, so there is nothing to show yet. Use Retry above, or check the terminal running the dashboard.", "No snapshot");
    target.hidden = false;
    return;
  }
  if (!view || !windowEmpty) { target.hidden = true; return; }
  const selected = selectedRepository();
  const scope = selected ? ` for ${selected.repository.name}` : "";
  const message = !snapshot.sessions.length ? "No local agent sessions were found in this snapshot."
    : windowPreset === "all" ? `No sessions${scope} in the observed history.`
      : `No sessions${scope} started or were active during ${windowCaption()}.`;
  const box = emptyState(target, message, "Nothing in this window");
  const actions = node("div", null, "status-actions");
  if (windowPreset !== "all" && snapshot.sessions.length) actions.append(statusAction("Show all time", () => applyWindowPreset("all")));
  if (selected) actions.append(statusAction("Clear repository focus", () => selectRepository("all", { scroll: false })));
  if (actions.childElementCount) box.append(actions);
  target.hidden = false;
}

function renderView() {
  const restoreFocus = rememberFocus();
  hoverListeners.clear();
  resetExportMenu();
  const view = activeView();
  windowEmpty = windowHasNoActivity(view);
  showActivePanel();
  renderViewStatus(view);
  renderWarnings(view.warnings);
  renderSharedView(view);
  renderStripMeta();
  renderProviderEvidence($("#provider-evidence-rows"), view.sessions);
  renderCoverageSummary(view);
  if (windowEmpty && currentViewName() !== "pricing") {
    clearInactiveAnalyticsViews(null);
  } else if (currentViewName() === "summary") {
    clearInactiveAnalyticsViews("summary");
    renderSummary(view);
  } else {
    renderActiveAnalyticsView(view);
  }
  restoreFocus();
}

// --------------------------------------------------------------------- window controls

function setWindowPreset(preset) {
  windowPreset = windowPresets.includes(preset) ? preset : "30";
  elements.windowSelect.value = windowPreset;
  for (const button of windowButtons) button.setAttribute("aria-pressed", String(button.dataset.windowPreset === windowPreset));
  elements.dateRange.hidden = windowPreset !== "custom";
  if (windowPreset !== "custom") showWindowNote([]);
}

function setWindowInputs(start, end) {
  elements.windowStart.value = start; elements.windowEnd.value = end;
  appliedWindow = { start, end };
}

const windowNoteText = {
  "invalid-start": "Start date was not a valid date, so the previous one is kept.",
  "invalid-end": "End date was not a valid date, so the previous one is kept.",
  swapped: "Start was after end, so the dates were swapped.",
};

/** Says inline how a custom range was adjusted; hidden when nothing changed. */
function showWindowNote(adjusted) {
  const target = elements.windowNote;
  if (!target) return;
  const notes = adjusted.map((reason) => reason === "clamped"
    ? `Clamped to history · ${dateRange(elements.windowStart.min, elements.windowEnd.max)}.`
    : windowNoteText[reason]).filter(Boolean);
  target.textContent = notes.join(" ");
  target.hidden = !notes.length;
  target.removeAttribute("title");
}

function observedRange() {
  // Start and activity dates in the snapshot timezone; legacy UTC `spendByDay` only for sessions without a ledger.
  const timeZone = snapshotTimeZone();
  const dates = snapshot.sessions.flatMap((session) => [sessionStartDay(session, timeZone),
    ...(session.velocity ? ledgerCells(session.velocity).map(([day]) => day) : Object.keys(session.spendByDay ?? {}))]).filter(Boolean).sort();
  const today = localDay(normalizeTimestamp(snapshot.generatedAt), timeZone);
  const minimum = dates[0] || today || new Date().toISOString().slice(0, 10);
  // Never end a window after the snapshot's local date.
  const maximum = dates.at(-1) || minimum;
  return { maximum: today && maximum > today && minimum <= today ? today : maximum, minimum };
}

function configureWindow() {
  const { maximum, minimum } = observedRange();
  for (const input of [elements.windowStart, elements.windowEnd]) { input.min = minimum; input.max = maximum; }
  if (windowPreset === "custom") {
    // A refreshed snapshot, or a URL range, may fall outside the observed history: keep it inside and ordered.
    applyCustomRange(elements.windowStart.value, elements.windowEnd.value, { render: false });
    return;
  }
  applyWindowPreset(windowPreset, { render: false });
}

function applyWindowPreset(preset, { render = true, history: mode = "push" } = {}) {
  setWindowPreset(preset);
  if (!snapshot) return;
  if (windowPreset !== "custom") {
    setWindowInputs(windowStartFor(windowPreset, elements.windowStart.min, elements.windowEnd.max), elements.windowEnd.max);
  } else if (!validDay(elements.windowStart.value) || !validDay(elements.windowEnd.value)) {
    setWindowInputs(elements.windowStart.min, elements.windowEnd.max);
  }
  if (render) { renderView(); syncUrl(mode); }
}

/** Applies a custom range: invalid bounds keep their previous value, a reversed range swaps, and dates are clamped. */
function applyCustomRange(start, end, { render = true } = {}) {
  setWindowPreset("custom");
  if (!snapshot) return;
  const resolved = resolveCustomWindow({ start, end, previousStart: appliedWindow.start, previousEnd: appliedWindow.end, min: elements.windowStart.min, max: elements.windowEnd.max });
  setWindowInputs(resolved.start, resolved.end);
  showWindowNote(resolved.adjusted);
  if (render) { renderView(); syncUrl("replace"); }
}

/** A date input change. An emptied or half-typed date is left alone while it is edited and restored on blur. */
function applyCustomWindow() {
  setWindowPreset("custom");
  if (!snapshot) return;
  if (!validDay(elements.windowStart.value) || !validDay(elements.windowEnd.value)) return;
  applyCustomRange(elements.windowStart.value, elements.windowEnd.value);
}

function restoreWindowInputs() {
  if (!snapshot || windowPreset !== "custom") return;
  if (validDay(elements.windowStart.value) && validDay(elements.windowEnd.value)) return;
  applyCustomRange(elements.windowStart.value, elements.windowEnd.value);
}

// --------------------------------------------------------------------- appearance & preferences

// Explicit choices are remembered; the system theme, the default density and one-visit `?theme=`/`?density=`
// URL parameters are applied without being saved.
function setTheme(theme, { persist = true } = {}) {
  document.documentElement.dataset.theme = theme;
  elements.themeLabel.textContent = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  elements.theme.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  if (persist) writePreference("session-analytics-theme", theme);
}

function closeExportMenu() { if (typeof resetExportMenu === "function") resetExportMenu(); }

function toggleTheme() { closeExportMenu(); setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); }

function setDensity(density, { persist = true } = {}) {
  const value = density === "comfortable" ? "comfortable" : "compact";
  document.documentElement.dataset.density = value;
  elements.density.setAttribute("aria-pressed", String(value === "comfortable"));
  if (persist) writePreference("session-analytics-density", value);
}

function toggleDensity() { closeExportMenu(); setDensity(document.documentElement.dataset.density === "comfortable" ? "compact" : "comfortable"); }

/** Single-character shortcuts can be switched off (WCAG 2.1.4); modifier shortcuts and buttons keep working. */
function setShortcuts(enabled, { persist = true } = {}) {
  shortcutsEnabled = Boolean(enabled);
  document.documentElement.dataset.shortcuts = shortcutsEnabled ? "on" : "off";
  elements.shortcutsToggle.checked = shortcutsEnabled;
  // Tooltips only mention a key while that key works.
  for (const control of document.querySelectorAll("[data-shortcut]")) {
    const label = control.dataset.tooltip || control.getAttribute("title") || "";
    control.dataset.tooltip = label;
    control.setAttribute("title", shortcutsEnabled ? `${label} (${control.dataset.shortcut})` : label);
  }
  if (persist) writePreference("session-analytics-shortcuts", shortcutsEnabled ? "on" : "off");
}

/** Provider toggles are scoped: the daily chart on Summary, or the active view's own chips on Velocity, Tools and Activity. */
function providerScope() {
  const view = currentViewName();
  if (view === "summary") return "chart";
  return providerScopedViews.includes(view) ? view : null;
}

function velocityChip(provider) {
  return document.querySelector(`#velocity-view .provider-key [data-provider="${provider}"] input`);
}

function providerShown(scope, provider) {
  if (scope === "chart") return Boolean(providerFilters.find(({ dataset }) => dataset.providerFilter === provider)?.checked);
  if (scope === "velocity") return viewProviderFilters.velocity.has(provider);
  return viewProviderFilters[scope].has(provider);
}

function toggleProvider(provider) {
  closeExportMenu();
  if (!snapshot || !snapshotProviders().includes(provider)) return;
  const scope = providerScope();
  if (scope === "chart") {
    const input = providerFilters.find(({ dataset }) => dataset.providerFilter === provider);
    if (!input) return;
    input.checked = !input.checked;
    renderLine(dailyProviderSpend(activeView().dailySessions));
  } else if (scope === "velocity") {
    // The Velocity chips own their selection; a click runs their own change handler.
    velocityChip(provider)?.click();
  } else if (scope) {
    if (viewProviderFilters[scope].has(provider)) viewProviderFilters[scope].delete(provider);
    else viewProviderFilters[scope].add(provider);
    renderActiveAnalyticsView(activeView());
  }
  syncUrl();
}

// --------------------------------------------------------------------- command palette

let paletteActive = 0;
let paletteOptions = [];
let paletteItemsShown = [];

function paletteItems() {
  const items = [];
  const selectedId = elements.repositoryFilter.value;
  for (const name of sharedSnapshot ? [] : viewOrder) {
    const chord = Object.entries(viewChords).find(([, view]) => view === name)?.[0] || "";
    items.push({ group: "Views", icon: name, label: `Go to ${viewLabels[name]}`, hint: shortcutsEnabled ? `g ${chord}` : "", keywords: `view ${name}`, state: currentViewName() === name, run: () => switchView(name) });
  }
  if (snapshot) {
    items.push({ group: "Repositories", icon: "repo", label: "All repositories", keywords: "repo clear focus everything", state: selectedId === "all", run: () => selectRepository("all") });
    for (const item of snapshot.repositories) {
      items.push({ group: "Repositories", icon: "repo", label: `Focus ${item.repository.name}`, title: item.repository.duplicateName ? "another checkout with the same name" : null, keywords: `repo repository ${item.repository.name}`, state: selectedId === item.repository.id, run: () => selectRepository(item.repository.id) });
    }
    const scope = providerScope();
    if (scope) {
      const where = scope === "chart" ? "in the daily chart" : `in ${viewLabels[scope]}`;
      for (const [index, provider] of snapshotProviders().entries()) {
        const on = providerShown(scope, provider);
        items.push({ group: "Providers", icon: "models", label: `${on ? "Hide" : "Show"} ${providerLabels[provider]} ${where}`, hint: shortcutsEnabled && index < 9 ? `p ${index + 1}` : "", keywords: `provider toggle ${provider} filter`, state: on, run: () => toggleProvider(provider) });
      }
    }
    for (const preset of ["7", "30", "90", "all"]) {
      items.push({ group: "Time window", icon: "activity", label: windowLabels[preset], hint: shortcutsEnabled ? String(["7", "30", "90", "all"].indexOf(preset) + 1) : "", keywords: `window days range ${preset}`, state: windowPreset === preset, run: () => applyWindowPreset(preset) });
    }
    items.push({ group: "Time window", icon: "activity", label: "Custom range", keywords: "window custom dates", state: windowPreset === "custom", run: () => { applyWindowPreset("custom"); elements.windowStart.focus(); } });
  }
  const dark = document.documentElement.dataset.theme === "dark";
  items.push({ group: "Display", icon: dark ? "sun" : "moon", label: `Switch to ${dark ? "light" : "dark"} theme`, hint: shortcutsEnabled ? "t" : "", keywords: "theme dark light mode appearance", run: toggleTheme });
  const comfortable = document.documentElement.dataset.density === "comfortable";
  items.push({ group: "Display", icon: "density", label: `Switch to ${comfortable ? "compact" : "comfortable"} density`, hint: shortcutsEnabled ? "d" : "", keywords: "density spacing compact comfortable", run: toggleDensity });
  items.push({ group: "Keyboard", icon: "help", label: `${shortcutsEnabled ? "Disable" : "Enable"} single-key shortcuts`, keywords: "keyboard shortcuts keys toggle character", state: shortcutsEnabled, run: () => setShortcuts(!shortcutsEnabled) });
  items.push({ group: "Keyboard", icon: "help", label: "Keyboard shortcuts", hint: shortcutsEnabled ? "?" : "", keywords: "help keys shortcuts", run: openHelp });
  items.push({ group: "Snapshot", icon: "coverage", label: "Data coverage", hint: shortcutsEnabled ? "e" : "", keywords: "coverage evidence warnings notes denominators guardrails", run: openCoverage });
  if ((fullSnapshot?.machines?.length ?? 0) > 1) items.push({ group: "Snapshot", icon: "coverage", label: "Machine details", keywords: "machines remote ssh server status stale failed fix", run: openMachines });
  items.push({ group: "Snapshot", icon: "refresh", label: "Refresh snapshot", hint: shortcutsEnabled ? "r" : "", keywords: "reload rescan refresh", run: () => load(true) });
  items.push({ group: "Snapshot", icon: "export", label: "Export view…", keywords: "export download save csv json snapshot", run: () => openExportMenu() });
  return items;
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
  paletteItemsShown = rankPaletteItems(paletteItems(), query);
  let group = null, position = 0;
  for (const item of paletteItemsShown) {
    if (item.group !== group) { group = item.group; elements.commandList.append(node("div", group, "palette-group")); }
    const option = node("div", null, "palette-option");
    if (item.title) option.title = item.title;
    option.id = `command-option-${position}`; option.setAttribute("role", "option"); option.setAttribute("aria-selected", "false");
    option.append(icon(item.icon), node("span", item.label, "option-label"));
    if (item.state !== undefined) { const state = node("i", null, "option-state"); state.dataset.on = String(item.state); option.append(state); }
    if (item.hint) option.append(node("span", item.hint, "option-hint"));
    const index = position;
    option.addEventListener("pointermove", () => { if (paletteActive !== index) setPaletteActive(index); });
    option.addEventListener("click", () => runPaletteItem(item));
    elements.commandList.append(option); paletteOptions.push(option); position += 1;
  }
  if (!paletteItemsShown.length) elements.commandList.append(node("div", "No matching command.", "palette-empty"));
  setPaletteActive(0);
  syncPaletteExpanded();
}

function runPaletteItem(item) {
  closePalette();
  item.run();
}

function openPalette() {
  if (elements.help.open) elements.help.close();
  closeCoverage();
  if (elements.palette.open) return;
  elements.commandInput.value = "";
  renderPalette("");
  elements.palette.showModal();
  setPaletteActive(0);
  syncPaletteExpanded();
  elements.commandInput.focus();
}

function syncPaletteExpanded() {
  elements.commandInput.setAttribute("aria-expanded", String(elements.palette.open && paletteOptions.length > 0));
  if (!elements.palette.open) elements.commandInput.removeAttribute("aria-activedescendant");
}

function closePalette() { if (elements.palette.open) elements.palette.close(); syncPaletteExpanded(); }

function togglePalette() { if (elements.palette.open) closePalette(); else openPalette(); }

function openHelp() { closePalette(); closeCoverage(); closeMachines(); if (!elements.help.open) elements.help.showModal(); }

function closeHelp() { if (elements.help.open) elements.help.close(); }

elements.palette.addEventListener("close", syncPaletteExpanded);
elements.commandInput.addEventListener("input", () => renderPalette(elements.commandInput.value));
elements.commandInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); setPaletteActive(paletteActive + 1); }
  else if (event.key === "ArrowUp") { event.preventDefault(); setPaletteActive(paletteActive - 1); }
  else if (event.key === "Home") { event.preventDefault(); setPaletteActive(0); }
  else if (event.key === "End") { event.preventDefault(); setPaletteActive(paletteOptions.length - 1); }
  else if (event.key === "Enter") {
    event.preventDefault();
    const item = paletteItemsShown[paletteActive];
    if (item) runPaletteItem(item);
  }
});
for (const dialog of [elements.palette, elements.help, elements.coverageDialog, elements.machinesDialog]) {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
}
elements.coverageButton.addEventListener("click", openCoverage);
elements.coverageClose.addEventListener("click", closeCoverage);
elements.machineDetails.addEventListener("click", openMachines);
elements.machinesRead.addEventListener("click", () => void readMachinesAgain());
elements.machinesClose.addEventListener("click", closeMachines);
elements.commandButton.addEventListener("click", openPalette);
elements.helpButton.addEventListener("click", openHelp);
elements.helpClose.addEventListener("click", closeHelp);
elements.shortcutsToggle.addEventListener("change", () => setShortcuts(elements.shortcutsToggle.checked));

// --------------------------------------------------------------------- keyboard shortcuts

let pendingChord = null;
let chordTimer = 0;

function armChord(key) {
  pendingChord = key;
  window.clearTimeout(chordTimer);
  chordTimer = window.setTimeout(() => { pendingChord = null; }, 1500);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { pendingChord = null; window.clearTimeout(chordTimer); }
  if (event.defaultPrevented) return;
  const key = event.key;
  if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === "k") { event.preventDefault(); togglePalette(); return; }
  if (elements.palette.open || elements.help.open || elements.coverageDialog.open || elements.machinesDialog.open) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // Only text entry swallows shortcuts; a focused checkbox, radio or button still lets them through.
  if (isTextEntryTarget(event.target)) return;
  if (key === "Escape") {
    if (snapshot && elements.repositoryFilter.value !== "all") selectRepository("all", { scroll: false });
    return;
  }
  if (!shortcutsEnabled) return;
  if (pendingChord) {
    const chord = pendingChord; pendingChord = null; window.clearTimeout(chordTimer);
    if (chord === "g" && viewChords[key]) { event.preventDefault(); switchView(viewChords[key]); }
    if (chord === "p") {
      const provider = providerScope() ? providerShortcutTarget(key, snapshotProviders()) : null;
      if (provider) { event.preventDefault(); toggleProvider(provider); }
    }
    return;
  }
  if (key === "g" || key === "p") { armChord(key); return; }
  const presets = { 1: "7", 2: "30", 3: "90", 4: "all" };
  if (presets[key]) { applyWindowPreset(presets[key]); return; }
  if (key === "?") { event.preventDefault(); openHelp(); return; }
  if (key === "e") { openCoverage(); return; }
  if (key === "/") { event.preventDefault(); openPalette(); return; }
  if (key === "t") { toggleTheme(); return; }
  if (key === "d") { toggleDensity(); return; }
  if (key === "r") { load(true); return; }
  if (key === "[") { stepView(-1); return; }
  if (key === "]") stepView(1);
});

// --------------------------------------------------------------------- loading

const urlParameters = new URLSearchParams(window.location.search);

function describeLoadError(error) {
  const message = error instanceof Error && error.message ? error.message.replace(/\.$/, "") : "Failed to fetch";
  const status = /^HTTP (\d{3})$/.exec(message);
  if (!status) return `The local server did not answer (${message}).`;
  // The server's reason is a fixed, content-free sentence, such as the worker's heap limit.
  const reason = typeof error.reason === "string" && error.reason ? ` ${error.reason.replace(/\.?$/, ".")}` : "";
  return `The analysis failed (HTTP ${status[1]}).${reason}`;
}

/**
 * The snapshot, asked for again every few seconds while the server is still analyzing: a first scan or one after an
 * upgrade can take minutes, longer than a browser keeps one request open. Only the first request asks for a new scan.
 */
async function fetchAnalytics(refresh) {
  for (let query = refresh ? "?refresh=1&wait=10" : "?wait=10"; ; query = "?wait=10") {
    const response = await fetch(`/api/analytics${query}`);
    if (response.status === 202) continue;
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.reason = await response.json().then((body) => body?.error, () => null);
      throw error;
    }
    return await response.json();
  }
}

function showError(message, title = "Analysis failed", tone = "danger") {
  elements.error.dataset.tone = tone;
  elements.errorTitle.textContent = title;
  elements.errorMessage.textContent = message;
  elements.errorRetry.hidden = false;
  elements.error.hidden = false;
}

function hideError() {
  elements.error.hidden = true;
  elements.errorMessage.textContent = "";
}

/** After a failed refresh the previous snapshot stays on screen, marked stale with its own generation time. */
function markStale(stale) {
  if (!snapshot) return;
  elements.generated.textContent = stale ? `${dateTime(snapshot.generatedAt, snapshotTimeZone())} · stale` : dateTime(snapshot.generatedAt, snapshotTimeZone());
  if (stale) {
    elements.generated.dataset.stale = "true";
    elements.generated.removeAttribute("title");
  } else {
    delete elements.generated.dataset.stale;
    elements.generated.removeAttribute("title");
  }
}

/** Runs once, after the first snapshot has applied the URL's repository: from then on the URL follows the state. */
function finishUrlStartup() {
  if (urlReady) return;
  urlReady = true;
  syncUrl("replace");
  if (initialUrl.open === "palette") openPalette();
  if (initialUrl.open === "help") openHelp();
}

function render(data) {
  resetExportMenu();
  if (data.kind === "shared") { snapshot = null; fullSnapshot = null; sharedSnapshot = data; loadFailed = false; renderMachines(); renderSharedSnapshot(data); delete elements.main.dataset.state; return; }
  $("#shared-snapshot").hidden = true;
  for (const selector of sharedHiddenSelectors) $(selector).hidden = false;
  elements.wordmark.href = "?view=summary"; elements.wordmark.setAttribute("aria-label", "Session Analytics, Summary");
  $(".skip-link").href = "#main";
  // The window spans every machine, so switching one off keeps it.
  fullSnapshot = data; snapshot = data; sharedSnapshot = null; loadFailed = false;
  configureWindow(); applyMachines(); renderMachines();
  markStale(false); elements.rateCardDate.textContent = `Rate card effective ${dateLabel(data.rateCard.effectiveDate.slice(0, 10))}`;
  if (!urlReady) {
    restoreUrlProviders(initialUrl);
    const match = repositoryFromParameter(initialUrl.repo);
    if (match) elements.repositoryFilter.value = match.repository.id;
  }
  renderRateCards(data.rateCard);
  delete elements.main.dataset.state;
  renderView();
  finishUrlStartup();
  syncUrl("replace");
  watchMachines();
  // Limits name other machines' profiles as this snapshot does, so a new snapshot gets them again.
  if (limits?.machines && currentViewName() === "subscription") void loadLimits(false);
}

/** Fetch the snapshot a machine just completed, without the loading state or an error banner; false when it failed. */
async function loadQuietly() {
  const previous = fullSnapshot ?? snapshot ?? sharedSnapshot;
  try {
    const data = await fetchAnalytics(false);
    // A newer render owns the snapshot and its machine polling. A delayed read must not roll either back.
    if ((fullSnapshot ?? snapshot ?? sharedSnapshot) !== previous) return true;
    render(data); showReady(snapshot ? activeView() : null);
    return true;
  } catch { return false; /* The snapshot on screen stays. */ }
}
// Its own flight, so a Refresh clicked meanwhile is not folded into it.
const quietLoad = singleFlight(loadQuietly);

async function loadSnapshot(refresh = false) {
  const previous = snapshot ?? sharedSnapshot;
  resetExportMenu();
  hideError();
  elements.sync.dataset.state = "loading"; elements.syncLabel.textContent = previous || refresh ? "Refreshing…" : "Mapping local sessions"; elements.refresh.disabled = true;
  describeSyncStatus();
  elements.main.dataset.state = previous ? "refreshing" : "loading";
  if (!previous) {
    loadFailed = false; renderViewStatus(null); showActivePanel();
    elements.generated.textContent = "Building snapshot…";
    if (!elements.repositoryList.childElementCount) for (let index = 0; index < 5; index += 1) elements.repositoryList.append(node("div", null, "repo-skeleton"));
  }
  try {
    render(await fetchAnalytics(refresh && previous));
    showReady(snapshot ? activeView() : null);
  } catch (error) {
    elements.sync.dataset.state = "error";
    delete elements.main.dataset.state;
    if (previous) {
      // Keep the last good snapshot on screen and say how old it is.
      elements.syncLabel.textContent = snapshot ? `Stale · ${timeLabel(snapshot.generatedAt, snapshotTimeZone())}` : "Stale shared snapshot";
      markStale(true);
      const retained = snapshot ? `You are looking at the snapshot from ${dateTime(snapshot.generatedAt, snapshotTimeZone())}.` : "You are looking at the previous shared snapshot.";
      showError(`${describeLoadError(error)} ${retained}`, "Couldn't refresh", "warn");
    } else {
      elements.syncLabel.textContent = "Analysis failed";
      loadFailed = true;
      clear(elements.repositoryList);
      elements.generated.textContent = "No snapshot";
      showError(`The local analysis did not finish. ${describeLoadError(error)} Retry, or check the terminal running the dashboard.`, "No snapshot yet");
      showActivePanel(); renderViewStatus(null);
    }
  } finally {
    describeSyncStatus();
    elements.refresh.disabled = false;
  }
}

/** One analysis request at a time: the refresh button, `r`, the palette and Retry share an in-flight load. */
const load = singleFlight(loadSnapshot);

elements.refresh.addEventListener("click", () => { load(true); if (currentViewName() === "subscription") void loadLimits(true); });
elements.errorRetry.addEventListener("click", () => load(true));
elements.repositoryFilter.addEventListener("change", () => { if (snapshot) { renderView(); syncUrl(); } });
elements.scopeChip.addEventListener("click", () => selectRepository("all", { scroll: false }));
elements.wordmark.addEventListener("click", (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (sharedSnapshot) return;
  event.preventDefault();
  switchView("summary");
});
for (const button of windowButtons) button.addEventListener("click", () => { applyWindowPreset(button.dataset.windowPreset); if (button.dataset.windowPreset === "custom") elements.windowStart.focus(); });
elements.windowSelect.addEventListener("change", () => { applyWindowPreset(elements.windowSelect.value); if (elements.windowSelect.value === "custom") elements.windowStart.focus(); });
for (const input of [elements.windowStart, elements.windowEnd]) {
  input.addEventListener("change", applyCustomWindow);
  input.addEventListener("blur", restoreWindowInputs);
}
for (const filter of providerFilters) filter.addEventListener("change", () => { if (snapshot) { renderLine(dailyProviderSpend(activeView().dailySessions)); syncUrl(); } });
for (const button of viewButtons) button.addEventListener("click", () => switchView(button.dataset.viewButton));
for (const button of sortButtons) button.addEventListener("click", () => {
  const key = button.dataset.sort;
  if (tableSort.key === key) tableSort = { key, direction: tableSort.direction === "descending" ? "ascending" : "descending" };
  else tableSort = { key, direction: key === "name" ? "ascending" : "descending" };
  if (snapshot) renderRepositoryTable(activeView().repositories);
});
elements.theme.addEventListener("click", toggleTheme);
elements.density.addEventListener("click", toggleDensity);
window.addEventListener("popstate", restoreUrlState);

const macLike = /Mac|iPhone|iPad/.test(navigator.platform);
for (const key of document.querySelectorAll(".key-command")) key.textContent = macLike ? "⌘" : "Ctrl ";
const initialUrl = parseUrlState(urlParameters.toString(), { views: viewOrder, presets: windowPresets, aliases: viewAliases });
const storedPreference = readPreference("session-analytics-view");
const storedView = initialUrl.view ?? viewAliases[storedPreference] ?? storedPreference;
/** The active view's provider filter, which exports honour: Summary's daily-chart chips, Velocity's chips, Activity and Tools filters; null means all. */
function exportProviders(view) {
  if (view === "summary") return activeProviders();
  if (view === "velocity") return velocityProviders($("#velocity-view"));
  return viewProviderFilters[view] ? [...viewProviderFilters[view]] : null;
}

/**
 * The export preview. JSON, sessions, models and tools cover whole sessions started in the window; daily.csv is the
 * activity ledger for the window, the same cells (and total) as the dashboard's usage value. The current snapshot stays
 * exportable while a refresh runs; only a first load has nothing to export.
 */
function exportSelection() {
  if (sharedSnapshot) return sharedSnapshot;
  if (!snapshot) return null;
  const repositoryId = selectedRepository()?.repository.id ?? null, providers = exportProviders(currentViewName());
  const snapshotProviders = new Set(snapshot.sessions.map(({ provider }) => provider)), machines = fullSnapshot?.machines ?? [];
  const scope = (repositoryId ? repositorySessions(repositoryId) : snapshot.sessions).filter(({ provider }) => !providers || providers.includes(provider));
  const { start, end, timeZone } = velocityContext();
  const total = buildVelocity(scope, { start, end, group: "provider", metric: "value" }).totals[0];
  const selected = providers ? providers.filter((provider) => snapshotProviders.has(provider)).length : snapshotProviders.size;
  const exportSnapshot = fullSnapshot ? machineView(fullSnapshot, new Set((fullSnapshot.machines ?? []).map(({ key }) => key).filter((key) => !hiddenMachines.has(key)))) : snapshot;
  return {
    snapshot: filterSnapshot(exportSnapshot, { repositoryId, ...selectedWindow(), providers }),
    ledger: { sessions: scope, start, end },
    basis: `Daily value CSV: ${money(total)} usage value by activity date, ${start} to ${end} (${timeZone}), the same ledger as the dashboard. JSON, sessions, models and tools CSVs: whole sessions started in the window. Tools CSV counts only eligible tool evidence, as in the Tools view.${selected < snapshotProviders.size ? ` ${selected} of ${snapshotProviders.size} providers.` : ""}${machines.length > 1 && hiddenMachines.size ? ` ${machines.length - hiddenMachines.size} of ${machines.length} machines.` : ""}`,
  };
}
const resetExportMenu = installExportMenu(exportSelection, {
  unavailableMessage: () => loadFailed && !snapshot && !sharedSnapshot ? "Nothing to export: the analysis failed. Use Retry in the banner." : "The snapshot is still loading.",
});
switchView(viewPanels.some(({ dataset }) => dataset.viewPanel === storedView) ? storedView : "summary", { history: false });
// theme-boot.js already applied these before the first paint; app.js repeats the choice and owns the controls.
// A URL value lasts for this visit only, and nothing is saved until the person changes it.
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
setTheme(initialUrl.theme ?? (readPreference("session-analytics-theme") || systemTheme), { persist: false });
setDensity(initialUrl.density ?? (readPreference("session-analytics-density") || "compact"), { persist: false });
setShortcuts((readPreference("session-analytics-shortcuts") || "on") !== "off", { persist: false });
setWindowPreset(initialUrl.window ?? "30");
if (initialUrl.window === "custom") { elements.windowStart.value = initialUrl.start ?? ""; elements.windowEnd.value = initialUrl.end ?? ""; }
void load(false);
