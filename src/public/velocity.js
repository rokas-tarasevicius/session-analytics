import { compact, dateRange, dayLabel, decimal as number, money, moneyAxis, monthLabel, percent } from "./format.js";
import { categoryColor, categorySlotCount, modelColor, providerColor, providerKey } from "./chart-colors.js";
import { renderLegend } from "./chart-legend.js";
import { providerIds, providerLabels } from "./providers.js";
import { DASH, chartWidth, redrawOnResize, dataTable, el, evidence, filterBar, kpi, selectField } from "./ui.js";
import { ledgerAvailability } from "./view-model.js";
import { agentLabels, averagePrice, buildVelocity, comparisonEvidenceFloor, comparisonSpan, localDay, metricDefinitions, shiftDay, topMovers, velocityIndicators } from "./velocity-data.js";

const element = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
};
const svgElement = (tag, attributes, text) => {
  const result = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, String(value));
  if (text !== undefined) result.textContent = text;
  return result;
};
export function formatMetric(value, metric, short = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  if (metric === "value") return short ? moneyAxis(value) : money(value, Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 6 : 2);
  return (short ? compact : number)(value);
}
const deltaLabel = (value) => value === null ? "N/A" : `${value > 0 ? "+" : ""}${percent(value, 1, 0)}`;
/** KPI text for a comparison status; null renders as an em dash with the comparison's reason. */
export const comparisonValue = (item) => item.status === "change" ? Math.abs(item.delta) < 0.0005 ? "▬ 0%" : `${item.delta > 0 ? "▲" : "▼"} ${percent(Math.abs(item.delta), 1, 0)}` : item.status === "new" ? "New" : item.status === "idle" ? "No activity" : null;
export const span = ({ start, end }) => dateRange(start, end);
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** "Mon–Thu": Monday through the weekday of `day` (a calendar date). */
const weekdaysThrough = (day) => {
  const last = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  return last === 0 ? weekdays[0] : `${weekdays[0]}–${weekdays[last]}`;
};
/**
 * Card labels: the period that just finished (Monday, the 1st), a past window's end, or to date. The week card names
 * its weekdays so it cannot be read as the Summary's "last 7 days" comparison.
 */
export function comparisonLabels(indicators, today) {
  const through = indicators.end < today ? ` through ${span({ start: indicators.completeThrough, end: indicators.completeThrough })}` : "";
  const days = weekdaysThrough(indicators.completeThrough);
  return {
    week: indicators.week.rolledBack ? "Last week vs week before" : through ? `Week${through} (${days}) vs same days prior week` : `Week to date (${days}) vs same days last week`,
    month: indicators.month.rolledBack ? "Last month vs month before" : through ? `Month${through} vs prior` : "Month to date vs prior",
  };
}
const evidenceLabels = { value: "priced tokens", reasoning: "output with reasoning detail", uncached: "input with cache-read detail", cacheRead: "input with cache-read detail", cacheWrite: "input with cache-write detail" };
function evidenceText(evidence, metric) {
  if (!evidenceLabels[metric]) return "Recorded counters";
  const ratio = evidence.eligible > 0 ? `${number(evidence.known)}/${number(evidence.eligible)} ${evidenceLabels[metric]} (${number(100 * evidence.known / evidence.eligible)}%)` : "N/A · no eligible tokens";
  return `${ratio}${evidence.unsupported ? `; ${number(evidence.unsupported)} without an applicable breakdown` : ""}`;
}
// Slots belong to identity within each provider, never spend rank or visible position.
const agentSlots = new Map(Object.keys(agentLabels).map((id) => [id, Object.keys(agentLabels).filter((key) => key.split("-")[0] === id.split("-")[0]).indexOf(id)]));
// Fixed vocabularies keep both colour and texture when dates, filters or rank change.
const categorySlots = new Map([
  ["execution", new Map([["top-level", 0], ["subagent", 1]])],
  ["effort", new Map(["low", "medium", "high", "xhigh", "minimal", "none", "max", "ultra"].map((id, slot) => [id, slot]))],
]);
const neutralCategories = new Set(["other", "unknown", "<unknown>", "not recorded", "unknown execution"]);
let chartSequence = 0;
/** The bucket last inspected in each chart container, so a resize redraw keeps the reader's place. */
const inspectedKeys = new WeakMap();
function seriesEncoding(series, index, group) {
  if (series.id === "other") return { color: providerColor("unknown"), pattern: "solid", dash: "none" };
  if (group === "provider") return { color: providerColor(series.id), pattern: "solid", dash: "none" };
  if (group === "model") {
    const split = series.id.indexOf(":");
    return { color: modelColor(series.id.slice(0, split), series.id.slice(split + 1)), pattern: "solid", dash: "none" };
  }
  if (group === "agent") {
    const slot = agentSlots.get(series.id) ?? 0, provider = providerKey(series.id.split("-")[0]);
    return { color: `var(--provider-${provider}-${[1, 0, 2, 3][slot % 4]})`, pattern: slot >= 4 ? "diagonal" : "solid", dash: slot >= 4 ? "6 3" : "none" };
  }
  const id = series.id.trim().toLowerCase();
  const fixedSlots = categorySlots.get(group);
  const slot = fixedSlots ? fixedSlots.get(id) : index;
  if (neutralCategories.has(id) || slot === undefined) return { color: providerColor("unknown"), pattern: "solid", dash: "none" };
  const repeated = slot >= categorySlotCount;
  return { color: categoryColor(slot), pattern: repeated ? "diagonal" : "solid", dash: repeated ? "6 3" : "none" };
}
const caption = (key, granularity) => granularity === "hour" ? `${key}:00` : granularity === "week" ? `Week of ${dayLabel(key)}` : granularity === "month" ? monthLabel(key) : dayLabel(key);

/** One focus stop, arrow-key inspection, and a text equivalent for every plotted bucket. */
export function renderVelocityChart(container, data, { rolling = false, compactView = false, keepInspected = false } = {}) {
  redrawOnResize(container, () => renderVelocityChart(container, data, { rolling, compactView, keepInspected: true }));
  container.replaceChildren(); container.classList.add("velocity-chart");
  if (!data.series.length) {
    container.append(element("p", data.missingSessions ? "Velocity is unavailable in this snapshot. Refresh to collect activity buckets." : "No observed activity for this metric in the selected dates and providers.", "empty-state"));
    return;
  }
  const width = chartWidth(container, 1040), height = compactView ? (width < 560 ? 240 : 290) : (width < 560 ? 260 : 330), right = 18, top = 22, bottom = 40;
  const plotHeight = height - top - bottom;
  const stacked = data.mode === "stacked";
  const overlay = rolling && data.granularity === "day" && data.mode !== "cumulative" && data.rolling.some((value) => value !== null);
  const totals = data.keys.map((_, i) => data.series.reduce((value, series) => value + series.values[i], 0));
  const maximum = [...(stacked ? [totals] : data.series.map((series) => series.values)), ...(overlay ? [data.rolling] : [])].reduce((largest, values) => values.reduce((max, value) => Math.max(max, value ?? 0), largest), 0.001);
  const magnitude = 10 ** Math.floor(Math.log10(maximum / 4));
  const axisMaximum = Math.ceil(maximum / 4 / magnitude) * magnitude * 4;
  // Axis text is drawn at CSS-pixel size (about 7 px per mono character), so narrow charts size the gutter and the number of
  // date ticks from the labels themselves rather than letting them clip or collide.
  const labelWidth = (text) => text.length * 7;
  const yLabels = [0, 1, 2, 3, 4].map((tick) => formatMetric(axisMaximum * tick / 4, data.metric, true));
  const left = width < 560 ? Math.max(64, Math.ceil(Math.max(...yLabels.map(labelWidth))) + 16) : 86;
  const plotWidth = width - left - right;
  const tickRoom = (captionOf) => Math.floor((plotWidth + 24) / (Math.max(...data.keys.map((key) => labelWidth(captionOf(key)))) + 24));
  const tickCaption = tickRoom((key) => caption(key, data.granularity)) >= 2 ? (key) => caption(key, data.granularity) : (key) => data.granularity === "hour" ? `${key}:00` : data.granularity === "month" ? monthLabel(key) : dayLabel(key);
  const room = tickRoom(tickCaption);
  const x = (index) => left + (data.keys.length === 1 ? plotWidth / 2 : index / (data.keys.length - 1) * plotWidth);
  const y = (value) => top + (1 - value / axisMaximum) * plotHeight;
  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, tabindex: 0, role: "group", "aria-label": `${metricDefinitions[data.metric].label}, ${data.granularity}, ${data.mode}. Use Left and Right arrows, Home and End to inspect each bucket.` });
  const chartId = ++chartSequence;
  const definitions = svgElement("defs", {});
  const encodings = data.series.map((series, index) => {
    const encoding = seriesEncoding(series, index, data.group);
    let fill = encoding.color;
    if (stacked && encoding.pattern === "diagonal") {
      const id = `velocity-pattern-${chartId}-${index}`;
      const pattern = svgElement("pattern", { id, patternUnits: "userSpaceOnUse", width: 8, height: 8 });
      pattern.append(svgElement("rect", { width: 8, height: 8, fill: encoding.color }), svgElement("path", { d: "M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6", stroke: "var(--surface)", "stroke-width": 2, "stroke-opacity": 0.75 }));
      definitions.append(pattern); fill = `url(#${id})`;
    }
    return { ...encoding, fill };
  });
  svg.append(definitions);
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = axisMaximum * tick / 4;
    svg.append(svgElement("line", { x1: left, x2: width - right, y1: y(value), y2: y(value), class: "grid-line" }));
    svg.append(svgElement("text", { x: left - 12, y: y(value) + 4, "text-anchor": "end", class: "axis-label" }, yLabels[tick]));
  }
  const fractions = room >= 5 ? [0, 0.25, 0.5, 0.75, 1] : room >= 3 ? [0, 0.5, 1] : room >= 2 ? [0, 1] : [1];
  const ticks = [...new Set(fractions.map((fraction) => Math.round(fraction * (data.keys.length - 1))))];
  for (const index of ticks) svg.append(svgElement("text", { x: x(index), y: height - 12, "text-anchor": index === 0 ? "start" : index === data.keys.length - 1 ? "end" : "middle", class: "axis-label" }, tickCaption(data.keys[index])));
  let floor = data.keys.map(() => 0);
  data.series.forEach((series, seriesIndex) => {
    const encoding = encodings[seriesIndex];
    const upper = series.values.map((value, i) => value + (stacked ? floor[i] : 0));
    const path = svgElement("path", { d: upper.map((value, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(value)}`).join(" ") + (stacked ? ` ${floor.map((_, i) => { const j = floor.length - i - 1; return `L${x(j)},${y(floor[j])}`; }).join(" ")} Z` : ""), class: stacked ? "velocity-area" : "velocity-line", stroke: encoding.color, fill: stacked ? encoding.fill : "none", "data-series": series.id, "data-pattern": encoding.pattern });
    if (!stacked) path.setAttribute("stroke-dasharray", encoding.dash);
    svg.append(path);
    if (upper.length === 1) svg.append(svgElement("circle", { cx: x(0), cy: y(upper[0]), r: 4, "data-series": series.id, stroke: encoding.color, "stroke-width": 2, fill: stacked ? encoding.fill : encoding.pattern === "solid" ? encoding.color : "var(--surface)" }));
    if (stacked) floor = upper;
  });
  if (overlay) {
    let penDown = false;
    const path = data.rolling.map((value, i) => { if (value === null) { penDown = false; return ""; } const point = `${penDown ? "L" : "M"}${x(i)},${y(value)}`; penDown = true; return point; }).join(" ");
    svg.append(svgElement("path", { d: path, class: "velocity-average" }));
  }
  const marker = svgElement("line", { x1: x(0), x2: x(0), y1: top, y2: height - bottom, class: "velocity-marker", visibility: "hidden" });
  svg.append(marker);
  const legend = element("div", undefined, "velocity-legend");
  renderLegend(legend, data.series.map((series, index) => ({
    id: series.id, label: series.label, color: encodings[index].color, value: series.total,
    valueLabel: formatMetric(series.total, data.metric, data.metric !== "value"), mark: stacked ? "rect" : "line",
    pattern: encodings[index].pattern === "solid" ? "solid" : stacked ? "diagonal" : "dashed",
  })), { target: svg });
  if (overlay) legend.append(element("span", "Dashed: total · rolling 7-day average", "velocity-average-key"));
  const inspection = element("div", undefined, "velocity-inspection");
  inspection.setAttribute("aria-live", "polite"); inspection.setAttribute("aria-atomic", "true");
  const remembered = keepInspected ? data.keys.indexOf(inspectedKeys.get(container)) : -1;
  let selected = remembered >= 0 ? remembered : data.keys.length - 1;
  const inspect = (index) => {
    selected = Math.max(0, Math.min(data.keys.length - 1, index));
    inspectedKeys.set(container, data.keys[selected]);
    marker.setAttribute("x1", String(x(selected))); marker.setAttribute("x2", String(x(selected))); marker.setAttribute("visibility", "visible");
    inspection.replaceChildren(element("strong", `${caption(data.keys[selected], data.granularity)} · ${data.mode === "cumulative" ? "cumulative " : ""}${formatMetric(totals[selected], data.metric)}`));
    for (const series of data.series) inspection.append(element("span", `${series.label}: ${formatMetric(series.values[selected], data.metric)}`));
    if (overlay) inspection.append(element("span", `7-day average: ${formatMetric(data.rolling[selected], data.metric)}`));
  };
  svg.addEventListener("keydown", (event) => {
    const target = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: data.keys.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault(); inspect(target);
  });
  svg.addEventListener("focus", () => inspect(selected));
  const pointer = (event) => {
    const bounds = svg.getBoundingClientRect();
    // Account for SVG letterboxing at narrow viewports.
    const scale = Math.min(bounds.width / width, bounds.height / height);
    const offset = (bounds.width - width * scale) / 2;
    inspect(Math.round(((event.clientX - bounds.left - offset) / scale - left) / plotWidth * (data.keys.length - 1)));
  };
  svg.addEventListener("pointermove", pointer); svg.addEventListener("click", pointer);
  container.append(svg, legend, inspection);
  inspect(selected);
}

function coverageText(data) {
  const values = data.totals;
  const ratio = (n, d, label) => `${label}: ${d > 0 ? `${number(n)} / ${number(d)} (${number(100 * n / d)}%)` : "N/A · no eligible tokens"}`;
  let detail = "";
  if (data.metric === "value") detail = ratio(values[10], data.coverage.priceTokens, "API pricing coverage, priced-source tokens");
  if (data.metric === "reasoning") detail = ratio(values[11], data.coverage.reasoningOutput, "Separate reasoning coverage, output tokens");
  if (data.metric === "cacheRead" || data.metric === "uncached") detail = ratio(values[12], data.coverage.cacheReadInput, "Cache-read split coverage, input tokens");
  if (data.metric === "cacheWrite") detail = ratio(values[13], data.coverage.cacheWriteInput, "Cache-write coverage, Claude, OpenCode and Cursor SDK input; others unavailable");
  const included = formatMetric(values[metricDefinitions[data.metric].index], data.metric);
  const undated = formatMetric(data.undated[metricDefinitions[data.metric].index], data.metric);
  const sessionDated = data.sessionDated[metricDefinitions[data.metric].index];
  return `${included} dated · ${number(data.contributingSessions)} sessions with dated evidence.${sessionDated > 0 ? ` Includes ${formatMetric(sessionDated, data.metric)} session-dated from ${data.sessionDatedSessions} session${data.sessionDatedSessions === 1 ? "" : "s"} whose source records no request times (placed on the session's last activity).` : ""} ${detail ? `${detail}. ` : ""}${undated} undated across this repository/provider scope, excluded from date filters and charts.${data.unledgered.sessions > 0 ? ` Across all time, ${data.unledgered.sessions} session${data.unledgered.sessions === 1 ? "" : "s"} from older snapshots without activity dates (${formatMetric(data.unledgered.value, "value")} whole-session value) are excluded; refresh to include them.` : ""}${data.missingSessions ? ` ${data.missingSessions} session${data.missingSessions === 1 ? "" : "s"} need a refresh to collect activity buckets.` : ""}`;
}
const controllers = new WeakMap();
function panelShell(title) {
  const article = el("article", null, "panel"), header = el("header"), block = el("div");
  const heading = el("h3", title);
  block.append(heading); header.append(block); article.append(header);
  return { article, heading, header };
}
export function renderVelocity(container, sessions, context) {
  let controller = controllers.get(container);
  if (!controller) {
    const group = selectField("velocity-group", "Group by", [["provider", "Provider"], ["agent", "Agent"], ["model", "Model"], ["repository", "Repository"], ["execution", "Execution kind"], ["effort", "Effort"]]);
    group.select.value = "model";
    const metric = selectField("velocity-metric", "Metric", Object.entries(metricDefinitions).map(([key, value]) => [key, value.label]));
    const granularity = selectField("velocity-granularity", "Granularity", [["day", "Day"], ["week", "Week · Monday start"], ["month", "Month"], ["hour", "Hour-of-day profile"]]);
    const mode = selectField("velocity-mode", "Chart", [["stacked", "Stacked area"], ["lines", "Lines"], ["cumulative", "Cumulative"]]);
    const rollingLabel = el("label", null, "check"), rolling = el("input");
    rolling.type = "checkbox"; rolling.checked = true; rollingLabel.append(rolling, el("span", "7-day average"));
    const filters = el("div", null, "provider-key"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Providers");
    // Chips list the providers present in the snapshot (context.providers), so the count reads "N of M" against them.
    const selectedProviders = new Set(providerIds);
    let chipProviders = [];
    const controls = filterBar(group.wrapper, metric.wrapper, granularity.wrapper, mode.wrapper, rollingLabel, filters);
    const lead = el("div", null, "kpi-grid compact-metrics velocity-lead");
    const totals = el("div", null, "kpi-grid compact-metrics velocity-totals");
    const comparisons = evidence([], { title: "How the comparisons are built" });
    const main = panelShell("Usage over time");
    const subtitle = el("span", null, "panel-meta"); main.header.append(subtitle);
    const chart = el("div"), coverage = evidence([], { title: "Evidence & limits" });
    main.article.append(chart, coverage);
    const projection = panelShell("Projection");
    const movers = panelShell("Top movers");
    container.append(lead, controls, main.article, totals, comparisons, projection.article, movers.article);
    controller = { sessions, context, update: null, selectedProviders };
    const update = () => {
      const current = controller.context;
      const scoped = controller.sessions.filter((session) => selectedProviders.has(session.provider));
      const options = { start: current.start, end: current.end, group: group.select.value, metric: metric.select.value, granularity: granularity.select.value, mode: mode.select.value };
      mode.select.querySelector('[value="cumulative"]').disabled = options.granularity === "hour";
      if (options.granularity === "hour" && options.mode === "cumulative") { options.mode = "lines"; mode.select.value = "lines"; }
      rolling.disabled = options.granularity !== "day" || options.mode === "cumulative";
      rollingLabel.title = rolling.disabled ? "A daily average is shown on non-cumulative daily charts." : "Seven calendar days, including inactive dates.";
      const today = localDay(current.generatedAt, current.timeZone);
      const comparison = comparisonSpan(current.end, today);
      // Long windows also need six dates before their first plotted day.
      const rollingStart = shiftDay(current.start, -6);
      if (rollingStart < comparison.start) comparison.start = rollingStart;
      const comparisonData = buildVelocity(scoped, { ...options, ...comparison, granularity: "day", mode: "lines" });
      const data = buildVelocity(scoped, { ...options, rollingHistory: comparisonData });
      const valueData = options.metric === "value" && options.granularity === "day" ? data : buildVelocity(scoped, { ...options, metric: "value", granularity: "day", mode: "lines" });
      const price = averagePrice(valueData);
      const availability = ledgerAvailability(scoped);
      const shownProviders = chipProviders.filter((provider) => selectedProviders.has(provider)).length;
      const usageCard = kpi({ label: "Usage value", value: availability.eligible ? formatMetric(price.total, "value") : null, reason: "No session in this selection has activity dates", coverage: availability, what: "activity dates", note: "Activity-dated. Not an invoice." });
      if (availability.eligible > 0 && availability.eligible < availability.selected) usageCard.querySelector(".coverage").prepend(el("span", "partial"));
      lead.replaceChildren(
        kpi({ label: "Average price", value: price.perActiveDay === null ? null : formatMetric(price.perActiveDay, "value"), reason: "No days with positive usage value", note: "Per active day", accent: true }),
        usageCard,
      );
      const indicators = velocityIndicators(comparisonData, today);
      main.heading.textContent = `${metricDefinitions[options.metric].label} by ${group.select.selectedOptions[0].textContent.toLowerCase()}`;
      const plottedTotal = el("span", formatMetric(data.totals[metricDefinitions[options.metric].index], options.metric)); plottedTotal.setAttribute("data-velocity-total", "");
      subtitle.replaceChildren(el("span", "Total "), plottedTotal, el("span", ` · ${dateRange(current.start, current.end)} · ${current.timeZone}`));
      renderVelocityChart(chart, data, { rolling: rolling.checked && !rolling.disabled });
      coverage.replaceChildren(el("summary", "Evidence & limits"), (() => { const body = el("div", null, "evidence-body"); for (const text of [
        options.granularity === "hour" ? "Totals for each local clock hour; repeated DST hours combine." : options.granularity === "week" || options.granularity === "month" ? "Boundary periods include only selected dates." : "Inactive calendar dates are included.",
        options.mode === "cumulative" ? "Accumulation restarts at the selected start date." : null,
        coverageText(data),
        `${price.days} calendar days · API-equivalent and provider-reported${valueData.evidence.complete ? "" : " · partially observed"}${shownProviders < chipProviders.length ? ` · ${shownProviders} of ${chipProviders.length} providers` : ""}. ${price.activeDays} active day${price.activeDays === 1 ? "" : "s"}; ${formatMetric(price.perCalendarDay, "value")} per calendar day.`,
        "Value is not an invoice; activity is not an outcome.",
      ].filter(Boolean)) body.append(el("p", text)); return body; })());
      const { week: weekLabel, month: monthLabel } = comparisonLabels(indicators, today);
      const cutoff = indicators.end < today ? `through the window end, ${indicators.completeThrough}` : "today excluded";
      const comparisonNote = (item, period) => `${span(item.current)} vs ${span(item.previous)}: Observed ${formatMetric(item.current.value, options.metric)} vs ${formatMetric(item.previous.value, options.metric)} · ${item.current.coveredDays}/${item.current.days} and ${item.previous.coveredDays}/${item.previous.days} calendar days covered. ${evidenceLabels[options.metric] ? `Evidence current: ${evidenceText(item.current.evidence, options.metric)}; prior: ${evidenceText(item.previous.evidence, options.metric)}. ` : ""}${item.status === "unavailable" ? `Not comparable: ${item.reason}.` : `${period === "week" ? `Same weekdays; ${cutoff}.` : `Same day numbers, clipped to the shorter month; ${cutoff}.`}${item.rolledBack ? " Rolled back to the period that just finished because today has not completed." : ""}${item.partial ? ` Metric evidence is incomplete on at least one side (${Math.round(comparisonEvidenceFloor * 100)}% or more is required); the change uses observed ${options.metric === "value" ? "priced value" : "counters"} only.` : ""}`}`;
      const shortNote = (item) => `${formatMetric(item.current.value, options.metric)} vs ${formatMetric(item.previous.value, options.metric)}${item.partial ? " · partial" : ""}`;
      totals.replaceChildren(
        kpi({ label: weekLabel, value: comparisonValue(indicators.week), reason: indicators.week.reason, note: shortNote(indicators.week) }),
        kpi({ label: monthLabel, value: comparisonValue(indicators.month), reason: indicators.month.reason, note: shortNote(indicators.month) }),
        kpi({ label: "Today / 14-day median", value: indicators.burn.ratio === null ? null : `${number(indicators.burn.ratio)}×`, reason: indicators.burn.reason, note: `${indicators.burn.days}/14 baseline days covered` }),
      );
      comparisons.replaceChildren(el("summary", "How the comparisons are built"), (() => { const body = el("div", null, "evidence-body"); for (const text of [
        `${weekLabel}: ${comparisonNote(indicators.week, "week")}`,
        `${monthLabel}: ${comparisonNote(indicators.month, "month")}`,
        `Today / 14-day median: ${formatMetric(indicators.burn.today, options.metric)} so far / ${formatMetric(indicators.burn.median, options.metric)} per full day. ${evidenceLabels[options.metric] ? `Evidence today: ${evidenceText(indicators.burn.todayEvidence, options.metric)}; baseline: ${evidenceText(indicators.burn.baselineEvidence, options.metric)}. ` : ""}Today is partial; this is not a same-hour comparison.`,
        "Activity counters do not prove quality or value delivered.",
      ]) body.append(el("p", text)); return body; })());
      const forecast = indicators.projection;
      projection.article.replaceChildren(projection.header);
      if (!forecast) {
        projection.heading.textContent = "Projection unavailable";
        projection.article.append(el("p", indicators.projectionReason, "empty-line"));
      } else {
        projection.heading.textContent = `Projected by ${forecast.monthEnd}`;
        projection.article.append(el("p", formatMetric(forecast.value, options.metric), "projected"));
        const band = svgElement("svg", { viewBox: "0 0 960 60", role: "img", "aria-label": `Scenario range ${formatMetric(forecast.low, options.metric)} to ${formatMetric(forecast.high, options.metric)}, median ${formatMetric(forecast.value, options.metric)}`, class: "velocity-band" });
        const scale = (value) => 24 + value / Math.max(forecast.high, 0.001) * 910;
        band.append(svgElement("line", { x1: 24, x2: 934, y1: 30, y2: 30, class: "velocity-band-base" }), svgElement("line", { x1: scale(forecast.low), x2: scale(forecast.high), y1: 30, y2: 30, class: "velocity-band-range" }), svgElement("circle", { cx: scale(forecast.value), cy: 30, r: 7, class: "velocity-band-point" }));
        projection.article.append(band, el("p", `${formatMetric(forecast.low, options.metric)}–${formatMetric(forecast.high, options.metric)} scenario range`, "chart-note"));
      }
      projection.article.append(evidence([
        forecast ? `${forecast.sampleDays} complete days sampled, ${forecast.activeDays} active · ${forecast.remainingDays} days to project.` : null,
        "Completed month-to-date plus remaining days at the trailing daily median, with today never below its observed value; the range uses the daily 10th–90th percentiles. This is a rate scenario, not a confidence interval. It assumes the recent workload continues, includes inactive days, and cannot predict changes in work. API-equivalent value is not an invoice.",
        evidenceLabels[options.metric] ? `Evidence month to date: ${evidenceText(indicators.projectionEvidence.observed, options.metric)}; sample: ${evidenceText(indicators.projectionEvidence.sample, options.metric)}.` : null,
        !forecast ? "Missing pricing or token detail, a small baseline or a clipped time window cannot support a projection." : null,
      ]));
      const movement = topMovers(scoped, options, today);
      movers.article.replaceChildren(movers.header);
      movers.heading.textContent = "Top movers";
      movers.article.append(el("p", "Last 7 completed days vs preceding 7", "chart-note"));
      if (!movement.available || !movement.rows.length) movers.article.append(el("p", !movement.available ? "Select at least 14 completed days of observed history with velocity data to compare movers." : "No measured increases among groups with complete evidence.", "empty-state"));
      else movers.article.append(dataTable([{ text: "Dimension", align: "left" }, { text: "Name", align: "left" }, "Previous 7 days", "Last 7 days", "Increase", "Change", { text: "Evidence · previous → current", align: "left" }], movement.rows.map((item) => [item.group, item.label, formatMetric(item.previous, options.metric), formatMetric(item.current, options.metric), `+${formatMetric(item.increase, options.metric)}`, item.delta === null ? `${DASH} small baseline` : deltaLabel(item.delta), `${evidenceText(item.previousEvidence, options.metric)} → ${evidenceText(item.currentEvidence, options.metric)}`]), { className: "velocity-movers" }));
      movers.article.append(evidence([`${dateRange(movement.start, movement.end)} vs ${dateRange(movement.previousStart, movement.previousEnd)} · ${metricDefinitions[options.metric].label}.`, movement.excludedGroups ? `${movement.excludedGroups} groups excluded because current or prior metric evidence is incomplete. A change in telemetry is not a measured change in workload.` : "Groups need complete current and prior metric evidence to appear. A change in telemetry is not a measured change in workload."]));
    };
    controller.update = update;
    controller.syncChips = (providers) => {
      if (providers.join() === chipProviders.join()) return;
      chipProviders = providers;
      filters.replaceChildren();
      for (const provider of providers) {
        const label = el("label", null, "chip"), input = el("input"); input.type = "checkbox"; input.checked = selectedProviders.has(provider);
        label.dataset.provider = provider; label.style.setProperty("--chip-color", providerColor(provider)); input.setAttribute("aria-label", `${providerLabels[provider]} sessions`);
        label.append(input, el("span", providerLabels[provider]));
        input.addEventListener("change", () => { if (input.checked) selectedProviders.add(provider); else selectedProviders.delete(provider); update(); }); filters.append(label);
      }
    };
    for (const input of [group.select, metric.select, granularity.select, mode.select, rolling]) input.addEventListener("change", update);
    controllers.set(container, controller);
  }
  controller.sessions = sessions; controller.context = context;
  controller.syncChips(context.providers ?? providerIds);
  controller.update();
}

/** The provider chips selected on a rendered Velocity view (exports honour them), or null before it first renders. */
export function velocityProviders(container) {
  const controller = controllers.get(container);
  return controller ? providerIds.filter((provider) => controller.selectedProviders.has(provider)) : null;
}

export function renderSummaryVelocity(container, sessions, context) {
  const data = buildVelocity(sessions, { start: context.start, end: context.end, group: "provider", metric: "value", mode: "lines" });
  renderVelocityChart(container, data, { compactView: true });
  container.append(element("p", "Activity-dated. Not an invoice.", "chart-note"), evidence([`${context.timeZone} · ${coverageText(data)}`]));
}
