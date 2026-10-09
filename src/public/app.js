import { modelColor, providerColor } from "./chart-colors.js";
import { renderLegend } from "./chart-legend.js";
import { barPercent, scaleMaximum, stackPercents } from "./chart-scale.js";
import { renderHistoryCoverage } from "./history-coverage.js";
import {
  costByModel, costTotals, coverageWarnings, dailyCountSeries, daysBetween, deltaDescription, downsample,
  groupByRepository, heatLevel, isTextEntryTarget, mergeModels, namedTotals, percent, presentProviders, previousPeriod, providerLabels,
  providerOrder, providerShortcutTarget, rankPaletteItems, repositoryKey, resolveCustomWindow, sessionsInRange, shortMoney, singleFlight,
  sortRepositories, sparklineSummary, spendDays, summarize, tickScale, validDay, windowStartFor,
} from "./view-model.js";
import { parseUrlState, serializeUrlState } from "./url-state.js";
import { providerMark, renderProviderEvidence, dailySpendByProvider, metricEligible, metricCoverage, coveredValue } from "./providers.js";

import { renderPricingPanel } from "./pricing.js";
import { renderToolsView } from "./tools.js";
import { toolsDays } from "./tools-data.js";
import { renderVelocity, renderSummaryVelocity } from "./velocity.js";
import { buildVelocity, comparePeriods, ledgerCells, localDay, periodFromVelocity, sessionStartWindow } from "./velocity-data.js";
import { normalizeTimestamp, utcDayBounds } from "./timestamps.js";
import { scanWarnings } from "./evidence.js";
import { filterSnapshot, selectSessions } from "./export-data.js";
import { installExportMenu, openExportMenu } from "./export-menu.js";
import { renderSharedSnapshot } from "./shared-view.js";
import { DASH, coverageBadge, setValue, valueWithCoverage } from "./ui.js";

const $ = (selector) => document.querySelector(selector);
const readPreference = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writePreference = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Storage is optional. */ } };
const elements = {
  activityHeatmap: $("#activity-heatmap"), activityProviderFilters: $("#activity-provider-filters"),
  activityRepositories: $("#activity-repositories"), activityTooltip: $("#activity-tooltip"), announcer: $("#chart-announcer"),
  cache: $("#metric-cache"), compactions: $("#metric-compactions"), dailySpend: $("#daily-spend"),
  commandButton: $("#command-button"), commandInput: $("#command-input"), commandList: $("#command-list"),
  costApiTotal: $("#cost-api-total"), costCoverage: $("#cost-coverage"),
  costProviderTotal: $("#cost-provider-total"), costUpperTotal: $("#cost-upper-total"),
  costApiCoverage: $("#cost-api-total-coverage"), costUpperCoverage: $("#cost-upper-total-coverage"), costProviderCoverage: $("#cost-provider-total-coverage"),
  coverageButton: $("#coverage-button"), coverageClose: $("#coverage-close"), coverageDialog: $("#coverage-dialog"), coverageDot: $("#coverage-dot"), coverageLabel: $("#coverage-label"), coverageSummary: $("#coverage-summary"),
  spendCoverage: $("#metric-spend-coverage"), inputCoverage: $("#metric-input-coverage"), outputCoverage: $("#metric-output-coverage"), toolsCoverage: $("#metric-tools-coverage"), compactionsCoverage: $("#metric-compactions-coverage"),
  dateRange: $("#date-range"), density: $("#density-switch"),
  error: $("#error-banner"), errorMessage: $("#error-message"), errorRetry: $("#error-retry"),
  generated: $("#generated-at"), help: $("#help-overlay"), helpButton: $("#help-button"), helpClose: $("#help-close"),
  input: $("#metric-input"), live: $("#metric-live"), main: $("#main"),
  modelSpend: $("#model-spend"), output: $("#metric-output"),
  liveNote: $("#metric-live-note"), retentionNote: $("#retention-note"),
  pageTitle: $("#page-title"), palette: $("#command-palette"),
  providerCostModels: $("#provider-cost-models"), costModels: $("#cost-models"),
  providerDonut: $("#provider-donut"), providerLegend: $("#provider-legend"),
  rateCardDate: $("#rate-card-date"), rateCardLinks: $("#rate-card-links"), refresh: $("#refresh-button"),
  repositories: $("#metric-repositories"), repositorySubagentSpend: $("#repository-subagent-spend"),
  repositoryFilter: $("#repository-filter"), repositoryList: $("#repository-list"), repositoryNote: $("#metric-repository-note"),
  repositoryNav: $(".repo-nav"), repositoryNavCount: $("#repo-nav-count"),
  repositoryRows: $("#repository-rows"), repositorySpend: $("#repository-spend"),
  repositoryTokens: $("#repository-tokens"), scope: $("#scope-description"),
  scopeChip: $("#scope-chip"), scopeChipLabel: $("#scope-chip-label"),
  sessionNote: $("#metric-session-note"), sessions: $("#metric-sessions"),
  shortcutsToggle: $("#shortcuts-toggle"),
  spend: $("#metric-spend"), spendNote: $("#metric-spend-note"),
  sync: $("#sync-context"), syncLabel: $("#sync-label"),
  theme: $("#theme-switch"), themeLabel: $("#theme-label"), toolCalls: $("#tool-calls"),
  toolsView: $("#tools-view"), toolsProviderFilters: $("#tools-provider-filters"),
  tools: $("#metric-tools"), viewStatus: $("#view-status"), warning: $("#warning-banner"), warningList: $("#warning-list"),
  windowEnd: $("#window-end"), windowNote: $("#window-note"), windowSegment: $("#window-segment"), windowStart: $("#window-start"),
  wordmark: $(".wordmark"),
};
const providerFilters = [...document.querySelectorAll("[data-provider-filter]")];
for (const input of providerFilters) input.closest(".chip").style.setProperty("--chip-color", providerColor(input.dataset.providerFilter));
const viewButtons = [...document.querySelectorAll("[data-view-button]")];
const viewPanels = [...document.querySelectorAll("[data-view-panel]")];
const windowButtons = [...elements.windowSegment.querySelectorAll("[data-window-preset]")];
const sortButtons = [...document.querySelectorAll("th .sort[data-sort]")];

const viewOrder = ["summary", "velocity", "costs", "pricing", "tools", "activity"];
const viewLabels = { summary: "Summary", velocity: "Velocity", costs: "Costs", pricing: "Pricing", tools: "Tools", activity: "Activity" };
// Retired view names that old links and saved preferences may still carry.
const viewAliases = { models: "costs" };
const viewChords = { s: "summary", v: "velocity", c: "costs", p: "pricing", t: "tools", a: "activity" };
const providerScopedViews = ["activity", "tools", "velocity"];
const shortProviderLabels = { copilot: "Copilot", gemini: "Gemini", opencode: "OpenCode", unsupported: "Other" };
const windowPresets = ["7", "30", "90", "all", "custom"];
const windowLabels = { 7: "Last 7 days", 30: "Last 30 days", 90: "Last 90 days", all: "All observed time", custom: "Custom range" };

let snapshot = null;
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
let tableSort = { direction: "descending", key: "value" };
let shortcutsEnabled = true;
let navCache = { key: null };
let navDirty = false;
// Per-view provider filters are independent of each other and of the daily chart toggles (master semantics).
const viewProviderFilters = {
  activity: new Set(providerOrder),
  tools: new Set(providerOrder),
};
const hoverListeners = new Set();
const navHoverListeners = new Set();
const compact = new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" });
const integer = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const currency = new Intl.NumberFormat("en-US", { currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2, style: "currency" });
const money = (value) => currency.format(value || 0);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wideLayout = window.matchMedia("(min-width: 1121px)");

function dateTime(value) {
  if (!value) return "Unknown time";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(normalizeTimestamp(value)));
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

/** KPI values stay bare numbers; coverage lives in the badge slot and the tooltip, an unavailable value is an em dash with its reason. */
function renderMetricValue(element, value, coverage, format, what = "evidence", slot = null) {
  setValue(element, value, coverage, format, { slot, what });
}

function icon(name, className) {
  const svg = svgNode("svg", { "aria-hidden": "true" });
  if (className) svg.setAttribute("class", className);
  const use = svgNode("use"); use.setAttribute("href", `#i-${name}`); svg.append(use);
  return svg;
}

function velocityContext() {
  return { start: elements.windowStart.value || elements.windowStart.min, end: elements.windowEnd.value || elements.windowEnd.max, timeZone: snapshot?.velocity?.timeZone || "UTC", generatedAt: snapshot.generatedAt };
}

function selectedWindow() {
  if (windowPreset === "all") return { start: null, end: null };
  return utcDayBounds(elements.windowStart.value, elements.windowEnd.value);
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
  const key = active instanceof HTMLElement ? active.dataset.focusKey : null;
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

function repositoryAggregate(item, sessions) {
  return { repository: item.repository, spendByDay: spendDays(sessions), spendByModel: mergeModels(sessions), summary: summarize(sessions), topTools: namedTotals(sessions, "tools"), warnings: [...new Set([...scanWarnings(item.warnings || []), ...coverageWarnings(sessions)])] };
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
  const undatedStarts = scopeSessions.filter((session) => session.transcript.startTimeKnown === false || session.evidence?.timing === "file-mtime" || !localDay(session.createdAt, "UTC")).length;
  const sourceRepositories = selected ? [selected] : snapshot.repositories;
  const repositories = sourceRepositories.map((item) => repositoryAggregate(item, sessionsInWindow(repositorySessions(item.repository.id))));
  const sessions = windowSessions;
  const summary = summarize(sessions);
  return {
    undatedStarts,
    dailySessions: scopeSessions, repositories, scopeSessions, sessions, spendByDay: spendDays(sessions), spendByModel: mergeModels(sessions), topTools: namedTotals(sessions, "tools"), warnings: [...new Set([...scanWarnings([...snapshot.warnings, ...snapshot.repositories.flatMap((r) => r.warnings)]), ...coverageWarnings(sessions)])],
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
  return snapshot.repositories.find(({ repository }) => repository.id === value) ?? snapshot.repositories.find(({ repository }) => repository.name === value) ?? null;
}

// --------------------------------------------------------------------- URL state

function currentUrlState() {
  const repo = elements.repositoryFilter.value;
  return { view: currentViewName(), window: windowPreset, start: elements.windowStart.value, end: elements.windowEnd.value, repo: repo && repo !== "all" ? repo : null };
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
  const blocked = (!snapshot && loadFailed) || (windowEmpty && name !== "pricing");
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
  const sessions = eligible.filter((s) => s.transcript?.startTimeKnown !== false && s.evidence?.timing !== "file-mtime" && normalizeTimestamp(s.createdAt) !== null);
  $("#activity-evidence").textContent = `${sessions.length}/${eligible.length} sessions have provider start timestamps. Unknown starts and file modification dates are excluded.`;
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const session of sessions) {
    const date = new Date(normalizeTimestamp(session.createdAt)); if (Number.isNaN(date.valueOf())) continue;
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
      cell.dataset.level = String(heatLevel(value, maximum));
      cell.dataset.day = String(day);
      cell.dataset.hour = String(hour);
      cell.dataset.value = String(value);
      cell.dataset.focusKey = `heat:${day}:${hour}`;
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
        if (event.key === "Escape" && !elements.activityTooltip.hidden) { event.preventDefault(); event.stopPropagation(); hideTooltip(); return; }
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

const componentLabels = { input: "Input", cached: "Cache read", write: "Cache write", output: "Output" };
const unattributedColor = "repeating-linear-gradient(45deg, var(--muted) 0 4px, var(--surface-3) 4px 6px)";

function renderCostRows(container, providers) {
  clear(container); const list = node("div", null, "cost-stack-list");
  const maximum = scaleMaximum(providers.map(({ total }) => total));
  for (const group of providers) {
    const row = node("div", null, "cost-stack-row"); row.append(node("strong", providerLabels[group.provider]));
    const rail = node("div", null, "cost-rail"), stack = node("div", null, "cost-stack");
    const parts = group.models.filter(({ value }) => value > 0).map(({ model, value }) => ({ name: model, value, color: modelColor(group.provider, model), id: `${group.provider}:${model}` }));
    if (group.unattributed > 0) parts.push({ name: "No model evidence", value: group.unattributed, color: unattributedColor, id: `${group.provider}:unattributed` });
    const widths = stackPercents(parts.map(({ value }) => value), maximum);
    const detail = parts.map(({ name, value }) => `${name}: ${money(value)} (${percent(group.total ? value / group.total : 0)} of provider)`);
    stack.setAttribute("role", "img");
    stack.setAttribute("aria-label", `${providerLabels[group.provider]}: ${money(group.total)}. ${detail.join(", ")}`);
    stack.title = detail.join("\n");
    for (const [index, part] of parts.entries()) {
      const bar = node("i"); bar.setAttribute("data-series", part.id);
      bar.style.width = `${widths[index]}%`; bar.style.background = part.color; stack.append(bar);
    }
    rail.append(stack); row.append(rail, valueWithCoverage(group.total, group.coverage, money, "priced value")); list.append(row);
  }
  if (list.childElementCount === 0) emptyState(list, "No priced activity in this view.");
  container.append(list);
}

function renderModelCosts(container, data) {
  clear(container); const list = node("div", null, "cost-model-list");
  const rows = data.models.map((model) => ({ ...model, coverage: { eligible: model.eligible, selected: model.selected } }));
  for (const provider of data.providers) if (provider.unattributed > 0.000001) rows.push({ provider: provider.provider, model: "No model evidence", value: provider.unattributed, share: data.total ? provider.unattributed / data.total : 0, coverage: provider.coverage, unattributed: true });
  rows.sort((left, right) => right.value - left.value || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model));
  const maximum = scaleMaximum(rows.map(({ value }) => value));
  for (const model of rows) {
    const row = node("div", null, "cost-model-row"), label = node("div", null, "cost-model-label");
    const provider = node("small", providerLabels[model.provider]); provider.style.setProperty("--provider-color", providerColor(model.provider));
    label.append(node("span", model.model), provider);
    const meta = model.unattributed ? "Provider value without model evidence" : [
      `${integer.format(model.sessions)} session${model.sessions === 1 ? "" : "s"}`,
      model.evidence.calls && model.calls > 0 ? `${integer.format(model.calls)} calls` : null,
      model.evidence.tokens && model.inputTokens + model.outputTokens > 0 ? `${compact.format(model.inputTokens)} in / ${compact.format(model.outputTokens)} out tokens` : "no model token evidence",
      model.priced ? null : model.value > 0 ? "partly unpriced" : "unpriced",
    ].filter(Boolean).join(" · ");
    const detail = model.unattributed ? meta : Object.entries(componentLabels).map(([key, name]) => `${name}: ${money(model.components[key])}`).join(", ");
    row.title = `${model.model} · ${providerLabels[model.provider]}: ${money(model.value)} (${percent(model.share)} of total). ${meta}. ${detail}`;
    const track = node("div", null, "cost-model-track"), fill = node("i");
    track.setAttribute("role", "img"); track.setAttribute("aria-label", row.title);
    fill.style.width = `${barPercent(model.value, maximum)}%`; fill.style.background = model.unattributed ? unattributedColor : modelColor(model.provider, model.model);
    fill.setAttribute("data-series", `${model.provider}:${model.unattributed ? "unattributed" : model.model}`); track.append(fill);
    row.append(label, track, valueWithCoverage(model.value, model.coverage, money, "priced value"), node("span", percent(model.share), "cost-model-share"), node("small", meta, "cost-model-meta muted")); list.append(row);
  }
  if (list.childElementCount === 0) emptyState(list, "No priced activity in this view.");
  container.append(list);
}

function renderCosts(view) {
  const cost = costTotals(view.sessions), data = costByModel(view.sessions);
  renderMetricValue(elements.costApiTotal, cost.total, metricCoverage(view.sessions, "apiCost"), money, "API-priced value", elements.costApiCoverage); renderMetricValue(elements.costUpperTotal, cost.upper, metricCoverage(view.sessions, "apiCost"), money, "API-priced value", elements.costUpperCoverage);
  renderMetricValue(elements.costProviderTotal, cost.reported, metricCoverage(view.sessions, "reportedCost"), money, "provider-reported value", elements.costProviderCoverage); elements.costCoverage.textContent = view.summary.pricedTokenCoverage === null ? DASH : percent(view.summary.pricedTokenCoverage);
  renderCostRows(elements.providerCostModels, data.providers);
  renderModelCosts(elements.costModels, data);
}

function renderTools(view) {
  const sessions = sessionsForProviders(view.sessions, "tools");
  const previous = windowPreset === "all" ? null : previousPeriod({ end: elements.windowEnd.value, min: elements.windowStart.min, start: elements.windowStart.value });
  const previousSessions = previous ? sessionsForProviders(sessionsInRange(view.scopeSessions, previous.startDay, previous.endDay), "tools") : null;
  const days = windowPreset === "all" ? toolsDays(sessions) : windowDays();
  toolsSelectedName = renderToolsView(elements.toolsView, {
    sessions, previousSessions, days, selectedTool: toolsSelectedName, expanded: toolsExpanded, repositories: view.repositories,
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

function renderActiveAnalyticsView(view) {
  const restoreFocus = rememberFocus();
  resetExportMenu();
  const name = currentViewName(); clearInactiveAnalyticsViews(name);
  if (name === "activity") renderActivity(view);
  if (name === "velocity") renderVelocity($("#velocity-view"), view.dailySessions, { ...velocityContext(), providers: snapshotProviders() });
  if (name === "costs") renderCosts(view);
  if (name === "pricing") renderPricingPanel($("#pricing-panel"), snapshot.rateCard, view.sessions);
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
    for (const [day, , , values] of ledgerCells(session.velocity)) {
      const row = days.get(day);
      if (row) row[session.provider] += values[0];
    }
  }
  return [...days.values()];
}

function renderLine(items) {
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
  const width = 900, height = 272, left = 52, right = 14, top = 14, bottom = 34;
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
  const tickIndexes = [...new Set([0, Math.round((items.length - 1) / 4), Math.round((items.length - 1) / 2), Math.round(((items.length - 1) * 3) / 4), items.length - 1])];
  for (const index of tickIndexes) addSvgText(svg, shortDate(items[index].name), xAt(index), height - 12, index === 0 ? "start" : index === items.length - 1 ? "end" : "middle");
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
    xs, plotTop: top, plotBottom: baseline, plotLeft: left, plotRight: width - right, label: "Daily priced usage value in US dollars by provider",
    title: (index) => new Intl.DateTimeFormat("en-GB", { dateStyle: "full" }).format(new Date(`${items[index].name}T00:00:00`)),
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
  renderLegend(legend, providers.map((provider) => ({ id: provider, label: providerLabels[provider], color: providerColor(provider), value: totals[provider], valueLabel: money(totals[provider]), mark: "line" })), { target: svg });
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
  const svg = svgNode("svg", { viewBox: "0 0 120 120", role: "img", "aria-label": `${integer.format(total)} sessions by provider` });
  let angle = -Math.PI / 2;
  for (const provider of providers) {
    const sweep = counts[provider] / total * Math.PI * 2;
    const segments = sweep >= Math.PI * 2 - 0.0001 ? [[angle, angle + Math.PI], [angle + Math.PI, angle + Math.PI * 2]] : [[angle, angle + sweep]];
    for (const [start, end] of segments) svg.append(svgNode("path", { "data-series": provider, fill: providerColor(provider), d: arcPath(60, 60, 58, 40, start, end) }));
    angle += sweep;
  }
  if (total === 0) svg.append(svgNode("circle", { cx: 60, cy: 60, r: 49, fill: "none", stroke: "var(--surface-3)", "stroke-width": 18 }));
  const center = node("div", null, "donut-center");
  center.append(node("strong", integer.format(total)), node("span", total === 1 ? "session" : "sessions"));
  elements.providerDonut.append(svg, center);
  renderLegend(elements.providerLegend, providers.map((provider) => ({
    id: provider, label: shortProviderLabels[provider] ?? providerLabels[provider] ?? "Unknown", color: providerColor(provider),
    value: counts[provider], valueLabel: integer.format(counts[provider]), share: counts[provider] / total, mark: "logo", icon: providerMark(provider),
  })), { target: elements.providerDonut, layout: "list" });
}

function tableCell(primary, secondary, className) {
  const cell = node("td"); cell.append(node("span", primary, className));
  if (secondary) cell.append(node("small", secondary)); return cell;
}

function renderRepositoryTable(repositories) {
  const restoreFocus = rememberFocus();
  clear(elements.repositoryRows);
  const sorted = sortRepositories(repositories, tableSort.key, tableSort.direction);
  for (const button of sortButtons) {
    const header = button.closest("th");
    if (button.dataset.sort === tableSort.key) header.setAttribute("aria-sort", tableSort.direction);
    else header.removeAttribute("aria-sort");
  }
  const maximumValue = Math.max(0.000001, ...repositories.map((item) => item.summary.estimatedSpendUsd));
  const selectedId = elements.repositoryFilter.value;
  for (const item of sorted) {
    const row = node("tr"); const summary = item.summary;
    row.dataset.rowLink = "true";
    const repositoryButton = node("button", item.repository.name, "row-link"); repositoryButton.type = "button";
    repositoryButton.dataset.focusKey = `table:${item.repository.id}`;
    if (item.repository.id === selectedId) { row.setAttribute("aria-current", "true"); repositoryButton.setAttribute("aria-current", "true"); }
    repositoryButton.addEventListener("click", () => selectRepository(item.repository.id));
    row.addEventListener("click", (event) => { if (event.target.closest?.("button")) return; selectRepository(item.repository.id); });
    const repositoryCell = node("td"); repositoryCell.append(repositoryButton, node("small", `ID ${repositoryKey(item.repository.id)}`));
    const covered = (value, coverage, format, what) => { const cell = node("td"); cell.append(valueWithCoverage(value, coverage, format, what, "span")); return cell; };
    row.append(repositoryCell, tableCell(String(summary.sessions), `${summary.topLevelSessions} top-level · ${summary.subagentSessions} sub-agent`), covered(summary.estimatedSpendUsd, summary.coverage.cost, money, "priced value"), covered(summary.totalInputTokens, summary.coverage.tokens, (v) => compact.format(v), "token evidence"), covered(summary.outputTokens, summary.coverage.tokens, (v) => compact.format(v), "token evidence"), covered(summary.toolCalls, summary.coverage.tools, (v) => compact.format(v), "tool evidence"), covered(summary.cacheReadRatio, summary.coverage.tokens, percent, "token evidence"), tableCell(summary.pricedTokenCoverage === null ? DASH : percent(summary.pricedTokenCoverage), `${summary.analyzedSessions}/${summary.sessions} parsed`));
    elements.repositoryRows.append(row);
  }
  if (sorted.length === 0) {
    const row = node("tr"); const cell = node("td"); cell.colSpan = 8; emptyState(cell, "No repositories in this view."); row.append(cell); elements.repositoryRows.append(row);
  }
  restoreFocus();
}

function renderWarnings(warnings) {
  clear(elements.warningList); elements.warning.hidden = !warnings.length;
  warnings.forEach((warning) => elements.warningList.append(node("li", warning)));
  elements.coverageLabel.textContent = warnings.length ? `Coverage · ${warnings.length}` : "Coverage";
  elements.coverageDot.hidden = !warnings.length;
  if (warnings.length) elements.coverageButton.setAttribute("aria-label", `Coverage · ${warnings.length} note${warnings.length === 1 ? "" : "s"}`);
  else elements.coverageButton.removeAttribute("aria-label");
}

/** One sentence for the coverage dialog: what the current selection can establish. */
function renderCoverageSummary(view) {
  const sessions = view.sessions.length;
  if (!sessions) { elements.coverageSummary.textContent = "No sessions in this selection. Widen the window or clear the repository focus."; return; }
  const part = (metric, what) => { const { eligible } = metricCoverage(view.sessions, metric); return `${eligible} ${what}`; };
  elements.coverageSummary.textContent = `${sessions} selected session${sessions === 1 ? "" : "s"} across ${view.summary.repositoriesWithSessions} repositor${view.summary.repositoriesWithSessions === 1 ? "y" : "ies"}: ${part("tokens", "carry token evidence")}, ${part("tools", "tool evidence")}, ${part("cost", "priced or reported value")}. Every number is a lower bound from local evidence; badges on the dashboard show the eligible share behind each figure.`;
}

function openCoverage() { closePalette(); if (elements.help.open) elements.help.close(); if (!elements.coverageDialog.open) elements.coverageDialog.showModal(); }
function closeCoverage() { if (elements.coverageDialog.open) elements.coverageDialog.close(); }

function renderRateCards(rateCard) {
  clear(elements.rateCardLinks);
  const groups = new Map();
  for (const item of rateCard.models) {
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
  if ([...elements.repositoryFilter.options].some((option) => option.value === previous)) elements.repositoryFilter.value = previous;
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
      return { id: item.repository.id, name: item.repository.name, series: series?.values ?? days.map(() => 0), value: series?.total ?? 0 };
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
  return `${elements.windowStart.value} through ${elements.windowEnd.value}`;
}

function renderSharedView(view) {
  const retained = view?.summary?.retainedSessions ?? 0;
  elements.retentionNote.hidden = !retained;
  elements.retentionNote.textContent = `${retained} source-deleted sessions retain facts and prices from their last successful ingest. Historical working status does not establish current activity.`;
  const selected = selectedRepository();
  const population = currentViewName() === "velocity" ? `Activity observed during ${windowCaption()} (${snapshot.velocity?.timeZone || "UTC"}).`
    : currentViewName() === "summary" ? `Usage value by activity date (${snapshot.velocity?.timeZone || "UTC"}); other totals for sessions started during ${windowCaption()} (UTC).`
    : `Sessions started during ${windowCaption()} (UTC); whole-session totals.`;
  elements.scope.textContent = `${selected ? `Focused on ${selected.repository.name}.` : "Every repository evidenced by local agent history."} ${population}`;
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

function renderSummary(view) {
  renderHistoryCoverage($("#history-coverage"), snapshot.historyCoverage, snapshot.sessions);
  const summary = view.summary;
  const days = windowDays();
  const context = velocityContext();
  // One ledger pass grouped by repository serves the KPI, its sparkline and the repository bars.
  const activity = buildVelocity(view.scopeSessions, { start: context.start, end: context.end, group: "repository", metric: "value" });
  // Deltas compare against the equal-length period immediately before the window, only when that period is fully observed.
  const previous = windowPreset === "all" ? null : previousPeriod({ end: context.end, min: elements.windowStart.min, start: context.start });
  const previousSummary = previous ? summarize(sessionsInRange(view.scopeSessions, previous.startDay, previous.endDay)) : null;
  const previousActivity = previous ? buildVelocity(view.scopeSessions, { start: previous.startDay, end: previous.endDay, metric: "value" }) : null;
  const spendComparison = previousActivity ? comparePeriods(periodFromVelocity(activity), periodFromVelocity(previousActivity), "value", { missingSessions: activity.missingSessions }) : null;
  const unavailable = !view.scopeSessions.some((session) => session.velocity);
  setValue(elements.spend, activity.totals[0], unavailable ? { eligible: 0, selected: view.scopeSessions.length } : null, money, { reason: "No session in this selection has activity dates" });
  clear(elements.spendCoverage);
  const pricedShare = activity.evidence.eligible > 0 ? activity.evidence.known / activity.evidence.eligible : 1;
  if (!unavailable && (pricedShare < 1 || activity.missingSessions)) {
    const badge = node("small", activity.missingSessions ? "partial" : `${Math.floor(100 * pricedShare)}% priced`, "coverage");
    badge.title = activity.missingSessions ? `${activity.missingSessions} session${activity.missingSessions === 1 ? "" : "s"} need a refresh to collect activity dates` : "Share of dated tokens with a price";
    badge.setAttribute("aria-label", badge.title); elements.spendCoverage.append(badge);
  }
  const excluded = [`${money(activity.undated[0])} undated`, ...(activity.unledgered.sessions ? [`${money(activity.unledgered.value)} in ${activity.unledgered.sessions} older-snapshot session${activity.unledgered.sessions === 1 ? "" : "s"} without activity dates (refresh to include)`] : [])];
  elements.spendNote.textContent = `By activity date (${context.timeZone})${activity.sessionDated[0] > 0 ? ` · includes ${money(activity.sessionDated[0])} session-dated (${activity.sessionDatedSessions} session${activity.sessionDatedSessions === 1 ? "" : "s"} without request times, dated by last activity)` : ""} · excludes, across all time, ${excluded.join(" and ")}${activity.missingSessions ? ` · ${activity.missingSessions} session${activity.missingSessions === 1 ? "" : "s"} need a refresh` : ""} · not an invoice`;
  if (summary.retainedSessions) elements.spendNote.textContent += " · retained history uses last-ingest prices";
  elements.liveNote.textContent = summary.historicalWorkingSnapshots ? `${summary.historicalWorkingSnapshots} historical working observations excluded` : "Present sources; totals may still move";
  elements.repositories.textContent = String(summary.repositories); elements.repositoryNote.textContent = `${summary.repositoriesWithSessions} with sessions`;
  elements.sessions.textContent = `${summary.analyzedSessions}/${summary.sessions}`; elements.sessionNote.textContent = `${summary.topLevelSessions} top-level · ${summary.subagentSessions} sub-agent${view.undatedStarts ? ` · ${view.undatedStarts} unknown starts${windowPreset === "all" ? " included" : " excluded"}` : ""}`;
  renderMetricValue(elements.input, summary.totalInputTokens, summary.coverage.tokens, (v) => compact.format(v), "token evidence", elements.inputCoverage);
  elements.cache.textContent = summary.coverage.tokens.eligible && summary.cacheReadRatio !== null ? `${percent(summary.cacheReadRatio)} cached · repeated context included` : "Cache share unavailable · repeated context included";
  renderMetricValue(elements.output, summary.outputTokens, summary.coverage.tokens, (v) => compact.format(v), "token evidence", elements.outputCoverage); renderMetricValue(elements.tools, summary.toolCalls, summary.coverage.tools, (v) => compact.format(v), "tool evidence", elements.toolsCoverage); renderMetricValue(elements.compactions, summary.compactions, summary.coverage.compactions, (v) => integer.format(v), "compaction evidence", elements.compactionsCoverage); elements.live.textContent = integer.format(summary.workingSnapshots);
  const metrics = [
    ["spend", `Usage value by activity date (${context.timeZone}), including session-dated value; undated value excluded`, money, activity.totals[0], previousActivity?.totals[0], activity.daily.map(({ total }) => total)],
    ["sessions", "Sessions started per day", integer.format, summary.sessions, previousSummary?.sessions, dailyCountSeries(view.sessions, days, () => 1)],
    ["input", "Request input processed per session-start day", compact.format, summary.totalInputTokens, previousSummary?.totalInputTokens, dailyCountSeries(view.sessions, days, ({ tokens }) => tokens.inputTokens)],
    ["output", "Output tokens per session-start day", compact.format, summary.outputTokens, previousSummary?.outputTokens, dailyCountSeries(view.sessions, days, ({ tokens }) => tokens.outputTokens)],
    ["tools", "Effective tool calls per session-start day", integer.format, summary.toolCalls, previousSummary?.toolCalls, dailyCountSeries(view.sessions, days, ({ metrics: item }) => item.toolCalls)],
    ["compactions", "Compactions per session-start day", integer.format, summary.compactions, previousSummary?.compactions, dailyCountSeries(view.sessions, days, ({ metrics: item }) => item.compactions)],
  ];
  for (const [name, label, format, current, before, series] of metrics) {
    renderDelta($(`#metric-${name}-delta`), name === "spend" ? spendDelta(spendComparison, previous?.length) : previousSummary ? deltaDescription(current, before, previous.length) : null);
    renderSparkline($(`#metric-${name}-spark`), series, days, { format, label });
  }
  renderLine(dailyProviderSpend(view.dailySessions)); renderDonut(view.sessions);
  const repositoryValue = new Map(activity.allSeries.map(({ id, total }) => [id, total]));
  renderBars(elements.repositorySpend, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: repositoryValue.get(item.repository.id) ?? 0 })).sort((a, b) => b.value - a.value), money, 12, ({ id }) => selectRepository(id));
  renderBars(elements.repositoryTokens, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.totalInputTokens, coverage: item.summary.coverage.tokens, what: "token evidence" })).sort((a, b) => b.value - a.value), (value) => compact.format(value), 12, ({ id }) => selectRepository(id));
  renderBars(elements.modelSpend, view.spendByModel.map(({ model, provider, totalUsd, eligible, selected }) => ({ name: model, model, value: totalUsd, provider, coverage: { eligible: eligible.value, selected }, what: "priced value" })), money, 8);
  renderBars(elements.toolCalls, view.topTools, (value) => integer.format(value), 10);
  if (!summary.coverage.tools.eligible) { clear(elements.toolCalls); elements.toolCalls.append(node("p", `${DASH} No tool evidence in ${summary.coverage.tools.selected} selected sessions`, "empty-line")); }
  renderBars(elements.repositorySubagentSpend, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.subagentSpendUsd })).filter(({ value }) => value > 0).sort((a, b) => b.value - a.value), money, 10, ({ id }) => selectRepository(id));
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

/**
 * Says inline how a custom range was adjusted: a short visible word beside the dates, with the full sentence in the
 * tooltip and for screen readers. Hidden when nothing changed.
 */
function showWindowNote(adjusted) {
  const target = elements.windowNote;
  if (!target) return;
  const notes = adjusted.map((reason) => reason === "clamped"
    ? `Adjusted to the observed history, ${elements.windowStart.min} to ${elements.windowEnd.max}.`
    : windowNoteText[reason]).filter(Boolean);
  clear(target);
  target.hidden = !notes.length;
  if (!notes.length) { target.removeAttribute("title"); return; }
  const sentence = notes.join(" ");
  const label = node("span", adjusted.includes("swapped") && adjusted.length === 1 ? "Swapped" : adjusted.includes("swapped") ? "Swapped · adjusted" : "Adjusted");
  label.setAttribute("aria-hidden", "true");
  target.append(label, node("span", sentence, "sr-only"));
  target.setAttribute("title", sentence);
}

function observedRange() {
  const dates = snapshot.sessions.flatMap(({ createdAt, transcript, evidence, spendByDay, velocity }) => [
    ...(transcript?.startTimeKnown !== false && evidence?.timing !== "file-mtime" && normalizeTimestamp(createdAt) ? [normalizeTimestamp(createdAt).slice(0, 10)] : []), ...Object.keys(spendByDay),
    ...ledgerCells(velocity).map(([day]) => day)]).filter(Boolean).sort();
  const minimum = dates[0] || new Date().toISOString().slice(0, 10);
  // UTC session-start dates can run a day ahead of the snapshot's local date; never end a window in the future.
  const today = localDay(snapshot.generatedAt, snapshot.velocity?.timeZone || "UTC");
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
  if (scope === "velocity") return Boolean(velocityChip(provider)?.checked);
  return viewProviderFilters[scope].has(provider);
}

function toggleProvider(provider) {
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
}

// --------------------------------------------------------------------- command palette

let paletteActive = 0;
let paletteOptions = [];
let paletteItemsShown = [];

function paletteItems() {
  const items = [];
  const selectedId = elements.repositoryFilter.value;
  for (const name of viewOrder) {
    const chord = Object.entries(viewChords).find(([, view]) => view === name)?.[0] || "";
    items.push({ group: "Views", icon: name, label: `Go to ${viewLabels[name]}`, hint: shortcutsEnabled ? `g ${chord}` : "", keywords: `view ${name}`, state: currentViewName() === name, run: () => switchView(name) });
  }
  if (snapshot) {
    items.push({ group: "Repositories", icon: "repo", label: "All repositories", keywords: "repo clear focus everything", state: selectedId === "all", run: () => selectRepository("all") });
    for (const item of snapshot.repositories) {
      items.push({ group: "Repositories", icon: "repo", label: `Focus ${item.repository.name}`, keywords: `repo repository ${item.repository.name}`, state: selectedId === item.repository.id, run: () => selectRepository(item.repository.id) });
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
  items.push({ group: "Appearance", icon: dark ? "sun" : "moon", label: `Switch to ${dark ? "light" : "dark"} theme`, hint: shortcutsEnabled ? "t" : "", keywords: "theme dark light mode appearance", run: toggleTheme });
  const comfortable = document.documentElement.dataset.density === "comfortable";
  items.push({ group: "Appearance", icon: "density", label: `Switch to ${comfortable ? "compact" : "comfortable"} density`, hint: shortcutsEnabled ? "d" : "", keywords: "density spacing compact comfortable", run: toggleDensity });
  items.push({ group: "Keyboard", icon: "help", label: `${shortcutsEnabled ? "Disable" : "Enable"} single-key shortcuts`, keywords: "keyboard shortcuts keys toggle character", state: shortcutsEnabled, run: () => setShortcuts(!shortcutsEnabled) });
  items.push({ group: "Keyboard", icon: "help", label: "Keyboard shortcuts", hint: shortcutsEnabled ? "?" : "", keywords: "help keys shortcuts", run: openHelp });
  items.push({ group: "Snapshot", icon: "coverage", label: "Evidence & coverage", hint: shortcutsEnabled ? "e" : "", keywords: "coverage evidence warnings notes denominators guardrails", run: openCoverage });
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
  elements.commandInput.focus();
}

function closePalette() { if (elements.palette.open) elements.palette.close(); }

function togglePalette() { if (elements.palette.open) closePalette(); else openPalette(); }

function openHelp() { closePalette(); closeCoverage(); if (!elements.help.open) elements.help.showModal(); }

function closeHelp() { if (elements.help.open) elements.help.close(); }

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
for (const dialog of [elements.palette, elements.help, elements.coverageDialog]) {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
}
elements.coverageButton.addEventListener("click", openCoverage);
elements.coverageClose.addEventListener("click", closeCoverage);
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
  if (event.defaultPrevented) return;
  const key = event.key;
  if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === "k") { event.preventDefault(); togglePalette(); return; }
  if (elements.palette.open || elements.help.open || elements.coverageDialog.open) return;
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

function showError(message) {
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
  if (!snapshot || snapshot.kind === "shared") return;
  elements.generated.textContent = stale ? `${dateTime(snapshot.generatedAt)} · stale` : dateTime(snapshot.generatedAt);
  if (stale) {
    elements.generated.dataset.stale = "true";
    elements.generated.title = "The latest refresh failed; these figures come from this earlier snapshot.";
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
  if (data.kind === "shared") { snapshot = data; loadFailed = false; renderSharedSnapshot(data); delete elements.main.dataset.state; return; }
  $("#shared-snapshot").hidden = true;
  $(".topbar-controls").hidden = false; $(".view-nav").hidden = false;
  $(".repo-nav").hidden = false;
  $(".skip-link").href = "#main";
  snapshot = data; loadFailed = false; sessionsByRepository = groupByRepository(data.sessions);
  for (const input of providerFilters) input.closest(".chip").hidden = !snapshotProviders().includes(input.dataset.providerFilter);
  markStale(false); elements.rateCardDate.textContent = `Rate card effective ${data.rateCard.effectiveDate}`;
  populateRepositories();
  if (!urlReady) {
    const match = repositoryFromParameter(initialUrl.repo);
    if (match) elements.repositoryFilter.value = match.repository.id;
  }
  configureWindow(); renderRateCards(data.rateCard);
  delete elements.main.dataset.state;
  renderView();
  finishUrlStartup();
}

async function loadSnapshot(refresh = false) {
  resetExportMenu();
  const previous = snapshot;
  hideError();
  elements.sync.dataset.state = "loading"; elements.syncLabel.textContent = previous ? "Refreshing local snapshot" : "Mapping local sessions"; elements.refresh.disabled = true;
  elements.main.dataset.state = previous ? "refreshing" : "loading";
  if (!previous) {
    loadFailed = false; renderViewStatus(null); showActivePanel();
    elements.generated.textContent = "Building snapshot…";
    if (!elements.repositoryList.childElementCount) for (let index = 0; index < 5; index += 1) elements.repositoryList.append(node("div", null, "repo-skeleton"));
  }
  try {
    const response = await fetch(`/api/analytics${refresh && previous ? "?refresh=1" : ""}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Analysis failed with ${response.status}.`);
    render(body);
    elements.sync.dataset.state = "live"; elements.syncLabel.textContent = "Local snapshot ready";
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Unknown analysis failure.";
    elements.sync.dataset.state = "error";
    delete elements.main.dataset.state;
    if (snapshot) {
      // Keep the last good snapshot on screen and say how old it is.
      elements.syncLabel.textContent = "Refresh failed";
      markStale(true);
      showError(`Refresh failed: ${message} Showing the snapshot from ${dateTime(snapshot.generatedAt)}.`);
    } else {
      elements.syncLabel.textContent = "Analysis failed";
      loadFailed = true;
      clear(elements.repositoryList);
      elements.generated.textContent = "No snapshot";
      showError(message);
      showActivePanel(); renderViewStatus(null);
    }
  } finally {
    elements.refresh.disabled = false;
  }
}

/** One analysis request at a time: the refresh button, `r`, the palette and Retry share an in-flight load. */
const load = singleFlight(loadSnapshot);

elements.refresh.addEventListener("click", () => load(true));
elements.errorRetry.addEventListener("click", () => load(true));
elements.repositoryFilter.addEventListener("change", () => { if (snapshot) { renderView(); syncUrl(); } });
elements.scopeChip.addEventListener("click", () => selectRepository("all", { scroll: false }));
elements.wordmark.addEventListener("click", (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  switchView("summary");
});
for (const button of windowButtons) button.addEventListener("click", () => { applyWindowPreset(button.dataset.windowPreset); if (button.dataset.windowPreset === "custom") elements.windowStart.focus(); });
for (const input of [elements.windowStart, elements.windowEnd]) {
  input.addEventListener("change", applyCustomWindow);
  input.addEventListener("blur", restoreWindowInputs);
}
for (const filter of providerFilters) filter.addEventListener("change", () => { if (snapshot) renderLine(dailyProviderSpend(activeView().dailySessions)); });
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
const resetExportMenu = installExportMenu(() => {
  if (elements.sync.dataset.state === "loading") return null;
  if (!snapshot || snapshot.kind === "shared") return snapshot;
  const view = currentViewName();
  const { start, end } = selectedWindow();
  const providers = viewProviderFilters[view] ? [...viewProviderFilters[view]] : null;
  return filterSnapshot(snapshot, { repositoryId: selectedRepository()?.repository.id, start, end, providers });
}, {
  unavailableMessage: () => loadFailed && !snapshot ? "Nothing to export: the analysis failed. Use Retry in the banner." : "The snapshot is still loading.",
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
