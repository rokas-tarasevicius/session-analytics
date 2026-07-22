const $ = (selector) => document.querySelector(selector);
const elements = {
  cache: $("#metric-cache"), compactions: $("#metric-compactions"), dailySpend: $("#daily-spend"),
  error: $("#error-banner"),
  generated: $("#generated-at"), heroCopy: $("#hero-copy"), input: $("#metric-input"),
  live: $("#metric-live"), modelSpend: $("#model-spend"), output: $("#metric-output"),
  providerDonut: $("#provider-donut"), providerLegend: $("#provider-legend"),
  rateCardDate: $("#rate-card-date"), rateCardLinks: $("#rate-card-links"), refresh: $("#refresh-button"),
  repositories: $("#metric-repositories"), repositorySubagentSpend: $("#repository-subagent-spend"),
  repositoryFilter: $("#repository-filter"), repositoryNote: $("#metric-repository-note"),
  repositoryRows: $("#repository-rows"), repositorySpend: $("#repository-spend"),
  repositoryTokens: $("#repository-tokens"), scope: $("#scope-description"),
  sessionNote: $("#metric-session-note"), sessions: $("#metric-sessions"),
  spend: $("#metric-spend"), spendNote: $("#metric-spend-note"),
  sync: $("#sync-context"), syncLabel: $("#sync-label"),
  theme: $("#theme-switch"), themeLabel: $("#theme-label"), toolCalls: $("#tool-calls"),
  tools: $("#metric-tools"), warning: $("#warning-banner"), warningList: $("#warning-list"),
  windowEnd: $("#window-end"), windowPreset: $("#window-preset"), windowStart: $("#window-start"),
};
const providerFilters = [...document.querySelectorAll("[data-provider-filter]")];

let snapshot = null;
const compact = new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" });
const integer = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const currency = new Intl.NumberFormat("en-US", { currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2, style: "currency" });
const money = (value) => currency.format(value || 0);
const percent = (value) => value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;

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
  document.querySelector(".metric-grid").scrollIntoView({ behavior: "smooth", block: "start" });
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
    elements.dailySpend.append(node("p", message, "muted")); return;
  }
  const width = 900, height = 270, left = 96, right = 22, top = 18, bottom = 46;
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
  const addText = (value, x, y, className, anchor = "start") => {
    const label = document.createElementNS(svg.namespaceURI, "text");
    label.setAttribute("x", String(x)); label.setAttribute("y", String(y));
    label.setAttribute("class", className); label.setAttribute("text-anchor", anchor);
    label.textContent = value; svg.append(label);
  };
  for (let index = 0; index < 5; index += 1) {
    const y = top + (index / 4) * plotHeight;
    const value = axisMaximum * (1 - index / 4);
    const line = document.createElementNS(svg.namespaceURI, "line");
    line.setAttribute("x1", String(left)); line.setAttribute("x2", String(width - right));
    line.setAttribute("y1", String(y)); line.setAttribute("y2", String(y)); line.setAttribute("class", "grid-line"); svg.append(line);
    addText(money(value), left - 10, y + 4, "axis-label", "end");
  }
  const tickIndexes = [...new Set([0, Math.round((items.length - 1) / 4), Math.round((items.length - 1) / 2), Math.round(((items.length - 1) * 3) / 4), items.length - 1])];
  for (const index of tickIndexes) {
    const x = items.length === 1 ? left + plotWidth / 2 : left + (index / (items.length - 1)) * plotWidth;
    const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(`${items[index].name}T00:00:00`));
    addText(date, x, height - 16, "axis-label", index === 0 ? "start" : index === items.length - 1 ? "end" : "middle");
  }
  for (const provider of providers) {
    const points = items.map((item, index) => ({
      item,
      x: items.length === 1 ? left + plotWidth / 2 : left + (index / (items.length - 1)) * plotWidth,
      y: top + (1 - item[provider] / axisMaximum) * plotHeight,
    }));
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("points", points.map(({ x, y }) => `${x},${y}`).join(" "));
    line.setAttribute("class", `trend-line ${provider}`); svg.append(line);
    for (const point of points) {
      // Zero-value dates stay in the polyline so missing calendar days are
      // represented, but they do not become hundreds of redundant controls.
      if (point.item[provider] <= 0) continue;
      const group = document.createElementNS(svg.namespaceURI, "g");
      group.setAttribute("class", `chart-point ${provider}`); group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", `${providerLabels[provider]}, ${point.item.name}, ${money(point.item[provider])}`);
      const dot = document.createElementNS(svg.namespaceURI, "circle");
      dot.setAttribute("cx", String(point.x)); dot.setAttribute("cy", String(point.y)); dot.setAttribute("r", "4"); dot.setAttribute("class", "trend-dot");
      const hit = document.createElementNS(svg.namespaceURI, "circle");
      hit.setAttribute("cx", String(point.x)); hit.setAttribute("cy", String(point.y)); hit.setAttribute("r", "13"); hit.setAttribute("class", "trend-hit");
      group.append(dot, hit); svg.append(group);
      const show = () => {
        group.classList.add("active"); tooltip.hidden = false;
        tooltip.textContent = `${providerLabels[provider]} · ${point.item.name} · ${money(point.item[provider])}`;
        tooltip.style.left = `${Math.min(82, Math.max(12, (point.x / width) * 100))}%`;
        tooltip.style.top = `${Math.max(8, (point.y / height) * 100 - 8)}%`;
      };
      const hide = () => { group.classList.remove("active"); tooltip.hidden = true; };
      group.addEventListener("pointerenter", show); group.addEventListener("pointerleave", hide);
      group.addEventListener("focus", show); group.addEventListener("blur", hide); group.addEventListener("click", show);
    }
  }
  elements.dailySpend.append(svg, tooltip);
}

function renderDonut(sessions) {
  const counts = { codex: 0, claude: 0, cursor: 0 };
  for (const session of sessions) counts[session.provider] = (counts[session.provider] || 0) + 1;
  const total = sessions.length || 1, codex = (counts.codex / total) * 100, claude = codex + (counts.claude / total) * 100;
  elements.providerDonut.style.background = `conic-gradient(var(--codex) 0 ${codex}%, var(--claude) ${codex}% ${claude}%, var(--cursor) ${claude}% 100%)`;
  elements.providerDonut.dataset.label = String(sessions.length);
  clear(elements.providerLegend);
  [["Codex", counts.codex, "codex"], ["Claude", counts.claude, "claude"], ["Cursor", counts.cursor, "cursor"]].forEach(([label, value, provider]) => {
    const row = node("div", null, "legend-row"); const logo = node("img"); logo.src = `/brands/${provider}.svg`; logo.alt = "";
    row.append(logo, node("span", label), node("strong", String(value))); elements.providerLegend.append(row);
  });
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

function renderRepositoryTable(repositories) {
  clear(elements.repositoryRows);
  for (const item of [...repositories].sort((a, b) => b.summary.estimatedSpendUsd - a.summary.estimatedSpendUsd)) {
    const row = node("tr"); const summary = item.summary;
    row.tabIndex = 0; row.setAttribute("role", "link"); row.setAttribute("aria-label", `Open metrics for ${item.repository.name}`);
    row.addEventListener("click", () => selectRepository(item.repository.id));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectRepository(item.repository.id); } });
    row.append(tableCell(item.repository.name, `ID ${repositoryKey(item.repository.id)}`), tableCell(String(summary.sessions), `${summary.topLevelSessions} top-level · ${summary.subagentSessions} sub-agent`), tableCell(money(summary.estimatedSpendUsd), `${money(summary.subagentSpendUsd)} sub-agent`, "money"), tableCell(compact.format(summary.totalInputTokens)), tableCell(compact.format(summary.outputTokens)), tableCell(compact.format(summary.toolCalls)), tableCell(percent(summary.cacheReadRatio)), tableCell(percent(summary.pricedTokenCoverage), summary.missingTranscripts ? `${summary.missingTranscripts} missing` : "complete"));
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

function renderView() {
  const view = activeView(); const selected = selectedRepository(); const summary = view.summary;
  elements.heroCopy.textContent = selected ? `${selected.repository.name} · ${summary.sessions} sessions · ${percent(summary.pricedTokenCoverage)} priced token coverage` : `${summary.repositories} repositories · ${summary.sessions} sessions · ${percent(summary.pricedTokenCoverage)} priced token coverage`;
  elements.scope.textContent = `${selected ? `Focused on ${selected.repository.name}.` : "Every repository evidenced by local agent history."} Sessions started during ${windowCaption()}.`;
  elements.spend.textContent = money(summary.estimatedSpendUsd); elements.spendNote.textContent = `${money(summary.apiEquivalentSpendUsd)} API-equivalent · ${money(summary.providerReportedSpendUsd)} provider-reported · not an invoice`;
  elements.repositories.textContent = String(summary.repositories); elements.repositoryNote.textContent = `${summary.repositoriesWithSessions} with sessions`;
  elements.sessions.textContent = `${summary.analyzedSessions}/${summary.sessions}`; elements.sessionNote.textContent = `${summary.topLevelSessions} top-level · ${summary.subagentSessions} sub-agent`;
  elements.input.textContent = compact.format(summary.totalInputTokens); elements.cache.textContent = `${percent(summary.cacheReadRatio)} cached · repeated context included`;
  elements.output.textContent = compact.format(summary.outputTokens); elements.tools.textContent = compact.format(summary.toolCalls); elements.compactions.textContent = integer.format(summary.compactions); elements.live.textContent = integer.format(summary.workingSnapshots);
  renderLine(dailyProviderSpend(view.dailySessions)); renderDonut(view.sessions);
  renderBars(elements.repositorySpend, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.estimatedSpendUsd })).sort((a, b) => b.value - a.value), money, 12, ({ id }) => selectRepository(id));
  renderBars(elements.repositoryTokens, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.totalInputTokens })).sort((a, b) => b.value - a.value), (value) => compact.format(value), 12, ({ id }) => selectRepository(id));
  renderBars(elements.modelSpend, view.spendByModel.map(({ model, provider, totalUsd }) => ({ name: model, value: totalUsd, provider })), money, 8);
  renderBars(elements.toolCalls, view.topTools, (value) => integer.format(value), 10);
  renderBars(elements.repositorySubagentSpend, view.repositories.map((item) => ({ id: item.repository.id, name: item.repository.name, value: item.summary.subagentSpendUsd })).filter(({ value }) => value > 0).sort((a, b) => b.value - a.value), money, 10, ({ id }) => selectRepository(id));
  renderRepositoryTable(view.repositories); renderWarnings(view.warnings);
}

function render(data) {
  snapshot = data; elements.generated.textContent = dateTime(data.generatedAt); elements.rateCardDate.textContent = `Rate card effective ${data.rateCard.effectiveDate}`;
  populateRepositories(); configureWindow(); renderRateCards(data.rateCard); renderView();
}

async function load(refresh = false) {
  elements.error.hidden = true; elements.sync.dataset.state = "loading"; elements.syncLabel.textContent = refresh ? "Refreshing local snapshot" : "Mapping local sessions"; elements.refresh.disabled = true;
  try { const response = await fetch(`/api/analytics${refresh ? "?refresh=1" : ""}`); const body = await response.json(); if (!response.ok) throw new Error(body.error || `Analysis failed with ${response.status}.`); render(body); elements.sync.dataset.state = "live"; elements.syncLabel.textContent = "Local snapshot ready"; }
  catch (error) { elements.sync.dataset.state = "error"; elements.syncLabel.textContent = "Analysis failed"; elements.error.textContent = error instanceof Error ? error.message : "Unknown analysis failure."; elements.error.hidden = false; }
  finally { elements.refresh.disabled = false; }
}

function setTheme(theme) { document.documentElement.dataset.theme = theme; elements.themeLabel.textContent = theme === "dark" ? "Light" : "Dark"; localStorage.setItem("session-atlas-theme", theme); }
elements.refresh.addEventListener("click", () => load(true));
elements.repositoryFilter.addEventListener("change", renderView);
elements.windowPreset.addEventListener("change", applyWindowPreset);
elements.windowStart.addEventListener("change", () => applyCustomWindow("start"));
elements.windowEnd.addEventListener("change", () => applyCustomWindow("end"));
for (const filter of providerFilters) filter.addEventListener("change", () => snapshot && renderView());
elements.theme.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
setTheme(localStorage.getItem("session-atlas-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")); void load(false);
