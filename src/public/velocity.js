import { allocateSlots, categoryColor, categorySlotCount, modelSlots, providerColor, providerKey, slotColor } from "./chart-colors.js";
import { axisTicks, formatAxisMoney, linearTicks } from "./chart-scale.js";
import { renderLegend } from "./chart-legend.js";
import { providerIds, providerLabels } from "./providers.js";
import { DASH, chartWidth, redrawOnResize, dataTable, el, evidence, filterBar, kpi, selectField } from "./ui.js";
import { agentLabels, averagePrice, buildVelocity, comparisonEvidenceFloor, comparisonSpan, localDay, metricDefinitions, moverBaseline, topMovers, velocityIndicators } from "./velocity-data.js";

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
const number = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export function formatMetric(value, metric, short = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  if (metric === "value") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 6 : 2 }).format(value);
  return (short ? compact : number).format(value);
}
/** KPI text for a comparison status; null renders as an em dash with the comparison's reason. */
export const comparisonValue = (item) => item.status === "change" ? Math.abs(item.delta) < 0.0005 ? "▬ 0%" : `${item.delta > 0 ? "▲" : "▼"} ${number.format(Math.abs(item.delta) * 100)}%` : item.status === "new" ? "New" : item.status === "idle" ? "No activity" : null;
const periodDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
export function span({ start, end }) {
  const first = periodDate.format(new Date(`${start}T12:00:00Z`));
  if (start === end) return first;
  return `${first}–${start.slice(0, 7) === end.slice(0, 7) ? Number(end.slice(-2)) : periodDate.format(new Date(`${end}T12:00:00Z`))}`;
}
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
  const ratio = evidence.eligible > 0 ? `${number.format(evidence.known)}/${number.format(evidence.eligible)} ${evidenceLabels[metric]} (${number.format(100 * evidence.known / evidence.eligible)}%)` : "N/A · no eligible tokens";
  return `${ratio}${evidence.unsupported ? `; ${number.format(evidence.unsupported)} without an applicable breakdown` : ""}`;
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
function seriesEncodings(series, group, stacked) {
  const visible = series.filter(({ id }) => !neutralCategories.has(id.trim().toLowerCase()));
  const slots = group === "model" ? modelSlots(visible.map(({ id }) => {
    const split = id.indexOf(":");
    return { id, provider: id.slice(0, split), model: id.slice(split + 1) };
  })) : group === "agent" ? allocateSlots(visible.map(({ id }) => ({
    id, provider: providerKey(id.split("-")[0]), preferred: (agentSlots.get(id) ?? 0) % 4, order: Object.keys(agentLabels).indexOf(id),
  }))) : null;
  return series.map(({ id }, index) => {
    if (neutralCategories.has(id.trim().toLowerCase())) return { color: providerColor("unknown"), pattern: "solid" };
    if (group === "provider") return { color: providerColor(id), pattern: "solid" };
    if (slots) {
      const slot = slots.get(id);
      return { color: slotColor(slot.provider, slot.slot), pattern: slot.overflow ? stacked ? "diagonal" : "marker" : "solid" };
    }
    const fixed = categorySlots.get(group), slot = fixed ? fixed.get(id.trim().toLowerCase()) : index;
    return slot === undefined ? { color: providerColor("unknown"), pattern: "solid" }
      : { color: categoryColor(slot), pattern: slot >= categorySlotCount ? stacked ? "diagonal" : "marker" : "solid" };
  });
}
const caption = (key, granularity) => {
  if (granularity === "hour") return `${key}:00–${key}:59`;
  const date = new Date(`${granularity === "month" ? `${key}-01` : key}T12:00:00Z`);
  const options = granularity === "month" ? { month: "long", year: "numeric" }
    : { ...(granularity === "day" ? { weekday: "short" } : {}), month: "short", day: "numeric", year: "numeric" };
  return `${granularity === "week" ? "Week of " : ""}${new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date)}`;
};
const colorKey = (color, dashed = false) => {
  const key = element("i", undefined, dashed ? "is-dashed" : undefined); key.setAttribute("aria-hidden", "true"); key.style.setProperty("--key-color", color); return key;
};

function rollingKey(data) {
  const averageKey = element("p", undefined, "velocity-average-key");
  if (data.rolling.some((value) => value !== null)) {
    const swatch = element("i", undefined, "chart-legend-swatch"); swatch.setAttribute("aria-hidden", "true");
    swatch.dataset.mark = "line"; swatch.dataset.pattern = "dashed"; swatch.style.setProperty("--series-color", "var(--text)");
    averageKey.append(swatch, element("span", `7-day average of the total${data.rollingPartial?.some(Boolean) ? data.metric === "value" ? " · faded where partly priced" : " · faded where metric evidence is partial" : ""}`));
  } else averageKey.textContent = `7-day average unavailable: ${data.missingSessions ? "refresh: some sessions have no activity ledger" : `it needs seven observed days with at least ${comparisonEvidenceFloor * 100}% ${data.metric === "value" ? "of tokens priced" : "metric evidence"}`}`;
  return averageKey;
}

/** One focus stop, arrow-key inspection, and a text equivalent for every plotted bucket. */
export function renderVelocityChart(container, data, { rolling = false, compactView = false, keepInspected = false } = {}) {
  redrawOnResize(container, () => renderVelocityChart(container, data, { rolling, compactView, keepInspected: true }));
  container.replaceChildren(); container.classList.add("velocity-chart");
  const overlay = rolling && data.granularity === "day" && data.mode !== "cumulative";
  if (!data.series.length) {
    container.append(element("p", data.missingSessions ? "Velocity is unavailable in this snapshot. Refresh to collect activity buckets." : "No observed activity for this metric in the selected dates and providers.", "empty-state"));
    if (overlay) container.append(rollingKey(data));
    return;
  }
  const width = chartWidth(container, 1040), height = compactView ? (width < 560 ? 240 : 290) : (width < 560 ? 260 : 330), right = 18, top = 22, bottom = 40;
  const plotHeight = height - top - bottom;
  const stacked = data.mode === "stacked";
  const totals = data.keys.map((_, i) => data.series.reduce((value, series) => value + series.values[i], 0));
  const maximum = [...(stacked ? [totals] : data.series.map((series) => series.values)), ...(overlay ? [data.rolling] : [])].reduce((largest, values) => values.reduce((max, value) => Math.max(max, value ?? 0), largest), 0.001);
  const { maximum: axisMaximum, step, ticks: yTicks } = linearTicks(maximum, { count: 4, whole: true });
  // Axis text is drawn at CSS-pixel size (about 7 px per mono character), so narrow charts size the gutter and the number of
  // date ticks from the labels themselves rather than letting them clip or collide.
  const labelWidth = (text) => text.length * 7;
  const yLabels = yTicks.map((tick) => data.metric === "value" ? formatAxisMoney(tick, step) : formatMetric(tick, data.metric, true));
  const left = width < 560 ? Math.max(64, Math.ceil(Math.max(...yLabels.map(labelWidth))) + 16) : 86;
  const plotWidth = width - left - right;
  const widest = Math.max(...axisTicks(data.keys, data.granularity, 12).map(({ label }) => labelWidth(label))) + 24;
  // At most seven date ticks: weekly steps on a 30-day window rather than every other day.
  const maxTicks = Math.max(2, Math.min(7, Math.floor((plotWidth + 24) / widest)));
  const x = (index) => left + (data.keys.length === 1 ? plotWidth / 2 : index / (data.keys.length - 1) * plotWidth);
  const y = (value) => top + (1 - value / axisMaximum) * plotHeight;
  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, tabindex: 0, role: "group", "aria-label": `${metricDefinitions[data.metric].label}, ${data.granularity}, ${data.mode}. Use Left and Right arrows, Home and End to inspect each bucket.` });
  const chartId = ++chartSequence;
  const definitions = svgElement("defs", {});
  const encodings = seriesEncodings(data.series, data.group, stacked).map((encoding, index) => {
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
  yTicks.forEach((value, index) => {
    svg.append(svgElement("line", { x1: left, x2: width - right, y1: y(value), y2: y(value), class: "grid-line" }));
    svg.append(svgElement("text", { x: left - 12, y: y(value) + 4, "text-anchor": "end", class: "axis-label" }, yLabels[index]));
  });
  for (const { index, label } of axisTicks(data.keys, data.granularity, maxTicks)) {
    const half = labelWidth(label) / 2;
    const anchor = x(index) - half < left ? "start" : x(index) + half > width ? "end" : "middle";
    svg.append(svgElement("text", { x: x(index), y: height - 12, "text-anchor": anchor, class: "axis-label" }, label));
  }
  let floor = data.keys.map(() => 0);
  data.series.forEach((series, seriesIndex) => {
    const encoding = encodings[seriesIndex];
    const upper = series.values.map((value, i) => value + (stacked ? floor[i] : 0));
    const path = svgElement("path", { d: upper.map((value, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(value)}`).join(" ") + (stacked ? ` ${floor.map((_, i) => { const j = floor.length - i - 1; return `L${x(j)},${y(floor[j])}`; }).join(" ")} Z` : ""), class: stacked ? "velocity-area" : "velocity-line", stroke: encoding.color, fill: stacked ? encoding.fill : "none", "data-series": series.id, "data-pattern": encoding.pattern });
    if (!stacked) path.setAttribute("stroke-dasharray", "none");
    svg.append(path);
    if (!stacked && encoding.pattern === "marker") {
      const stride = Math.ceil(upper.length / 16);
      upper.forEach((value, index) => {
        if (index % stride === 0 || index === upper.length - 1) svg.append(svgElement("circle", { cx: x(index), cy: y(value), r: 3, fill: "var(--surface)", stroke: encoding.color, "stroke-width": 2, "data-series": series.id }));
      });
    } else if (upper.length === 1) svg.append(svgElement("circle", { cx: x(0), cy: y(upper[0]), r: 4, "data-series": series.id, stroke: encoding.color, "stroke-width": 2, fill: stacked ? encoding.fill : encoding.pattern === "solid" ? encoding.color : "var(--surface)" }));
    if (stacked) floor = upper;
  });
  if (overlay) {
    // Separate paths keep both ends of a partial segment faded without fading neighbouring complete segments.
    const segments = [[], []], last = [-1, -1];
    for (let i = 1; i < data.rolling.length; i += 1) {
      if (data.rolling[i - 1] === null || data.rolling[i] === null) continue;
      const kind = data.rollingPartial?.[i - 1] || data.rollingPartial?.[i] ? 1 : 0;
      segments[kind].push(`${last[kind] === i - 1 ? "" : `M${x(i - 1)},${y(data.rolling[i - 1])} `}L${x(i)},${y(data.rolling[i])}`);
      last[kind] = i;
    }
    segments.forEach((paths, partial) => {
      if (paths.length) svg.append(svgElement("path", { d: paths.join(" "), class: `velocity-average${partial ? " velocity-average-partial" : ""}` }));
    });
  }
  const marker = svgElement("line", { x1: x(0), x2: x(0), y1: top, y2: height - bottom, class: "velocity-marker", visibility: "hidden" });
  svg.append(marker);
  const legend = element("div", undefined, "velocity-legend");
  renderLegend(legend, data.series.map((series, index) => ({
    id: series.id, label: series.label, color: encodings[index].color, value: series.total,
    valueLabel: formatMetric(series.total, data.metric, true), mark: stacked ? "rect" : "line",
    pattern: encodings[index].pattern,
  })), { target: svg });
  const tooltip = element("div", undefined, "chart-tooltip velocity-tooltip");
  tooltip.setAttribute("aria-hidden", "true"); tooltip.hidden = true;
  const inspection = element("div", undefined, "velocity-inspection");
  inspection.setAttribute("aria-live", "polite"); inspection.setAttribute("aria-atomic", "true");
  const remembered = keepInspected ? data.keys.indexOf(inspectedKeys.get(container)) : -1;
  let selected = remembered >= 0 ? remembered : data.keys.length - 1;
  const inspect = (index, showTooltip = true) => {
    selected = Math.max(0, Math.min(data.keys.length - 1, index));
    inspectedKeys.set(container, data.keys[selected]);
    marker.setAttribute("x1", String(x(selected))); marker.setAttribute("x2", String(x(selected))); marker.setAttribute("visibility", "visible");
    const title = `${caption(data.keys[selected], data.granularity)} · ${data.mode === "cumulative" ? "cumulative " : ""}${formatMetric(totals[selected], data.metric)}`;
    inspection.replaceChildren(element("strong", title));
    tooltip.replaceChildren(element("div", title, "tip-title"));
    const readout = element("dl", undefined, "velocity-readout");
    const rows = data.series.map((series, index) => ({ label: series.label, value: series.values[selected], color: encodings[index].color })).sort((a, b) => b.value - a.value);
    const addRow = (row, average = false) => {
      // Figures stay in the figure face; the "partial" note is a word, in the text face.
      const value = (tag, className) => {
        const node = element(tag, formatMetric(row.value, data.metric), className);
        if (average && data.rollingPartial?.[selected] && row.value !== null) node.append(element("span", " · partial", "velocity-partial-note"));
        return node;
      };
      const term = element("dt", undefined, row.value === 0 ? "muted" : "");
      term.append(colorKey(row.color, average), element("span", row.label));
      readout.append(term, value("dd", row.value === 0 ? "muted" : ""));
      if (row.value > 0 || (average && row.value !== null)) {
        const tip = element("div", undefined, "tip-row");
        tip.append(colorKey(row.color, average), element("span", row.label), value("strong")); tooltip.append(tip);
      }
    };
    rows.forEach((row) => addRow(row));
    if (!rows.some((row) => row.value > 0)) tooltip.append(element("div", "No activity", "tip-row"));
    if (overlay) addRow({ label: "7-day average", value: data.rolling[selected], color: "var(--text)" }, true);
    inspection.append(readout);
    if (showTooltip) {
      tooltip.hidden = false;
      const available = container.clientWidth || width, tipWidth = tooltip.offsetWidth || 0;
      const position = x(selected) + 12;
      tooltip.style.left = `${Math.max(0, position + tipWidth > available ? x(selected) - tipWidth - 12 : position)}px`;
      tooltip.style.top = `${top}px`;
    }
  };
  svg.addEventListener("keydown", (event) => {
    const target = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: data.keys.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault(); inspect(target);
  });
  // The tooltip follows the pointer or the keyboard; leaving the chart hides it, the readout keeps the selection.
  svg.addEventListener("focus", () => inspect(selected));
  svg.addEventListener("blur", () => { tooltip.hidden = true; });
  svg.addEventListener("pointerleave", () => { tooltip.hidden = true; });
  const pointer = (event) => {
    const bounds = svg.getBoundingClientRect();
    // Account for SVG letterboxing at narrow viewports.
    const scale = Math.min(bounds.width / width, bounds.height / height);
    const offset = (bounds.width - width * scale) / 2;
    inspect(Math.round(((event.clientX - bounds.left - offset) / scale - left) / plotWidth * (data.keys.length - 1)));
  };
  svg.addEventListener("pointermove", pointer); svg.addEventListener("click", pointer);
  container.append(svg, tooltip, legend);
  if (overlay) container.append(rollingKey(data));
  container.append(inspection);
  inspect(selected, false);
}

function coverageText(data) {
  const values = data.totals;
  const ratio = (n, d, label) => `${label}: ${d > 0 ? `${number.format(n)} / ${number.format(d)} (${number.format(100 * n / d)}%)` : "N/A · no eligible tokens"}`;
  let detail = "";
  if (data.metric === "value") detail = ratio(values[10], data.coverage.priceTokens, "API pricing coverage, priced-source tokens");
  if (data.metric === "reasoning") detail = ratio(values[11], data.coverage.reasoningOutput, "Separate reasoning coverage, output tokens");
  if (data.metric === "cacheRead" || data.metric === "uncached") detail = ratio(values[12], data.coverage.cacheReadInput, "Cache-read split coverage, input tokens");
  if (data.metric === "cacheWrite") detail = ratio(values[13], data.coverage.cacheWriteInput, "Cache-write coverage, Claude, OpenCode and Cursor SDK input; others unavailable");
  const included = formatMetric(values[metricDefinitions[data.metric].index], data.metric);
  const undated = formatMetric(data.undated[metricDefinitions[data.metric].index], data.metric);
  const sessionDated = data.sessionDated[metricDefinitions[data.metric].index];
  return `${included} dated · ${number.format(data.contributingSessions)} sessions with dated evidence.${sessionDated > 0 ? ` Includes ${formatMetric(sessionDated, data.metric)} session-dated from ${data.sessionDatedSessions} session${data.sessionDatedSessions === 1 ? "" : "s"} whose source records no request times (placed on the session's last activity).` : ""} ${detail ? `${detail}. ` : ""}${undated} undated across this repository/provider scope, excluded from date filters and charts.${data.unledgered.sessions > 0 ? ` Across all time, ${data.unledgered.sessions} session${data.unledgered.sessions === 1 ? "" : "s"} from older snapshots without activity dates (${formatMetric(data.unledgered.value, "value")} whole-session value) are excluded; refresh to include them.` : ""}${data.missingSessions ? ` ${data.missingSessions} session${data.missingSessions === 1 ? "" : "s"} need a refresh to collect activity buckets.` : ""}`;
}
const controllers = new WeakMap();
function panelShell(kicker, title) {
  const article = el("article", null, "panel"), header = el("header"), block = el("div");
  const heading = el("h3", title);
  if (kicker) block.append(el("p", kicker, "kicker"));
  block.append(heading); header.append(block); article.append(header);
  return { article, heading, header };
}
function partialTag(cause) {
  const tag = el("span", "partial", "velocity-partial"); tag.title = cause; return tag;
}
function comparisonCard(label, item, note) {
  // A tiny ratio (a few cents so far today) reads "<0.1×", never a rounded "0×".
  const value = "ratio" in item ? item.ratio === null ? null : item.ratio > 0 && item.ratio < 0.05 ? "<0.1×" : `${number.format(item.ratio)}×` : comparisonValue(item);
  const card = kpi({ label, value, reason: item.reason });
  if (item.partial && value !== null) {
    card.querySelector("strong").append(partialTag(item.cause));
    // The cause takes the coverage row under the value, so it never shares the note row.
    if (item.cause) card.append(el("small", item.cause, "kpi-coverage velocity-cause"));
  }
  if (note) card.append(el("small", note, "kpi-note"));
  return card;
}
const baselineText = (metric) => metric === "value" ? "$1" : `${number.format(moverBaseline(metric))} ${metricDefinitions[metric].unit}`;
function moverCells(item, metric) {
  const detail = `Evidence: ${evidenceText(item.previousEvidence, metric)} → ${evidenceText(item.currentEvidence, metric)}`;
  const name = el("span", item.label); name.title = detail;
  name.append(el("span", detail, "sr-only"));
  if (item.partial) name.append(partialTag(detail));
  const percentage = el("span", item.base === "new" ? "New" : item.base === "small" ? DASH : `${item.delta < 0 ? "▼" : "▲"} ${number.format(Math.abs(item.delta) * 100)}%`);
  if (item.base === "small") {
    percentage.title = `Base under ${baselineText(metric)}; value and token percentages also need three prior model calls`;
    percentage.append(el("span", `Base under ${baselineText(metric)}`, "sr-only"));
  }
  return [item.group, name, formatMetric(item.previous, metric), formatMetric(item.current, metric), `${item.change < 0 ? "−" : "+"}${formatMetric(Math.abs(item.change), metric)}`, percentage];
}
export function renderVelocity(container, sessions, context) {
  let controller = controllers.get(container);
  if (!controller) {
    const group = selectField("velocity-group", "Group by", [["provider", "Provider"], ["agent", "Agent"], ["model", "Model"], ["repository", "Repository"], ["execution", "Execution kind"], ["effort", "Effort"]]);
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
    const main = panelShell(null, "Usage over time");
    const subtitle = el("span", null, "panel-meta"); main.header.append(subtitle);
    const chart = el("div"), coverage = evidence([], { title: "Evidence & limits" });
    main.article.append(chart, coverage);
    const projection = panelShell("End-of-month scenario", "Projection");
    const movers = panelShell("Largest changes", "Top movers");
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
      const data = buildVelocity(scoped, options);
      const valueData = options.metric === "value" && options.granularity === "day" ? data : buildVelocity(scoped, { ...options, metric: "value", granularity: "day", mode: "lines" });
      const price = averagePrice(valueData);
      const shownProviders = chipProviders.filter((provider) => selectedProviders.has(provider)).length;
      lead.replaceChildren(
        kpi({ label: "Avg per day", value: price.perActiveDay === null ? null : formatMetric(price.perActiveDay, "value"), reason: "No days with positive usage value", note: `per active day · ${price.activeDays} of ${price.days} days active · ${formatMetric(price.perCalendarDay, "value")} per calendar day`, accent: true }),
        kpi({ label: "Usage value", value: formatMetric(price.total, "value"), note: `${price.days} calendar days · API-equivalent and provider-reported${valueData.evidence.complete ? "" : " · partially observed"}${shownProviders < chipProviders.length ? ` · ${shownProviders} of ${chipProviders.length} providers` : ""}` }),
      );
      const today = localDay(current.generatedAt, current.timeZone);
      const comparisonData = buildVelocity(scoped, { ...options, ...comparisonSpan(current.end, today), granularity: "day", mode: "lines" });
      const indicators = velocityIndicators(comparisonData, today);
      main.heading.textContent = `${metricDefinitions[options.metric].label} by ${group.select.selectedOptions[0].textContent.toLowerCase()}`;
      const plottedTotal = el("span", formatMetric(data.totals[metricDefinitions[options.metric].index], options.metric)); plottedTotal.setAttribute("data-velocity-total", "");
      subtitle.replaceChildren(el("span", "Total "), plottedTotal, el("span", ` · ${current.start} → ${current.end} · ${current.timeZone}`));
      renderVelocityChart(chart, data, { rolling: rolling.checked && !rolling.disabled });
      coverage.replaceChildren(el("summary", "Evidence & limits"), (() => { const body = el("div", null, "evidence-body"); for (const text of [
        options.granularity === "hour" ? "Totals for each local clock hour; repeated DST hours combine." : options.granularity === "week" || options.granularity === "month" ? "Boundary periods include only selected dates." : "Inactive calendar dates are included.",
        options.mode === "cumulative" ? "Accumulation restarts at the selected start date." : null,
        coverageText(data),
        "Value is not an invoice; activity is not an outcome.",
      ].filter(Boolean)) body.append(el("p", text)); return body; })());
      const { week: weekLabel, month: monthLabel } = comparisonLabels(indicators, today);
      const cutoff = indicators.end < today ? `through the window end, ${indicators.completeThrough}` : "today excluded";
      const comparisonNote = (item, period) => `Observed ${formatMetric(item.current.value, options.metric)} vs ${formatMetric(item.previous.value, options.metric)} · ${item.current.coveredDays}/${item.current.days} and ${item.previous.coveredDays}/${item.previous.days} calendar days covered. ${evidenceLabels[options.metric] ? `Evidence current: ${evidenceText(item.current.evidence, options.metric)}; prior: ${evidenceText(item.previous.evidence, options.metric)}. ` : ""}${item.status === "unavailable" ? `Not comparable: ${item.reason}.` : `${period === "week" ? `Same weekdays; ${cutoff}.` : `Same day numbers, clipped to the shorter month; ${cutoff}.`}${item.rolledBack ? " Rolled back to the period that just finished because today has not completed." : ""}${item.partial ? ` Metric evidence is incomplete on at least one side (${Math.round(comparisonEvidenceFloor * 100)}% or more is required); the change uses observed ${options.metric === "value" ? "priced value" : "counters"} only.${item.cause ? ` ${item.cause}.` : ""}` : ""}`}`;
      const shortNote = (item) => `${formatMetric(item.current.value, options.metric)} vs ${formatMetric(item.previous.value, options.metric)} · ${span(item.current)} vs ${span(item.previous)}`;
      totals.replaceChildren(
        comparisonCard(weekLabel, indicators.week, shortNote(indicators.week)),
        comparisonCard(monthLabel, indicators.month, shortNote(indicators.month)),
        comparisonCard("Today / 14-day median", indicators.burn, `${formatMetric(indicators.burn.today, options.metric)} so far / ${formatMetric(indicators.burn.median, options.metric)} per full day · ${indicators.burn.days}/14 days covered`),
      );
      comparisons.replaceChildren(el("summary", "How the comparisons are built"), (() => { const body = el("div", null, "evidence-body"); for (const text of [
        `${weekLabel}: ${comparisonNote(indicators.week, "week")}`,
        `${monthLabel}: ${comparisonNote(indicators.month, "month")}`,
        `Today / 14-day median: ${evidenceLabels[options.metric] ? `Evidence today: ${evidenceText(indicators.burn.todayEvidence, options.metric)}; baseline: ${evidenceText(indicators.burn.baselineEvidence, options.metric)}. ` : ""}Today is partial; this is not a same-hour comparison.`,
        `Comparisons require at least ${comparisonEvidenceFloor * 100}% metric evidence in each period.${indicators.burn.partial ? ` Today / 14-day median is partial: ${indicators.burn.cause}.` : ""} Activity counters do not prove quality or value delivered.`,
      ]) body.append(el("p", text)); return body; })());
      const forecast = indicators.projection;
      projection.article.replaceChildren(projection.header);
      if (!forecast) {
        projection.heading.textContent = "No month-end projection";
        projection.article.append(el("p", `${indicators.projectionReason}.`, "empty-line"));
      } else {
        projection.heading.textContent = `Projected by ${forecast.monthEnd}`;
        if (forecast.partial) projection.heading.append(partialTag(forecast.cause));
        projection.article.append(el("p", formatMetric(forecast.value, options.metric), "projected"));
        if (forecast.partial && forecast.cause) projection.article.append(el("p", forecast.cause, "velocity-cause"));
        const band = svgElement("svg", { viewBox: "0 0 960 60", role: "img", "aria-label": `Scenario range ${formatMetric(forecast.low, options.metric)} to ${formatMetric(forecast.high, options.metric)}, median ${formatMetric(forecast.value, options.metric)}`, class: "velocity-band" });
        const scale = (value) => 24 + value / Math.max(forecast.high, 0.001) * 910;
        band.append(svgElement("line", { x1: 24, x2: 934, y1: 30, y2: 30, class: "velocity-band-base" }), svgElement("line", { x1: scale(forecast.low), x2: scale(forecast.high), y1: 30, y2: 30, class: "velocity-band-range" }), svgElement("circle", { cx: scale(forecast.value), cy: 30, r: 7, class: "velocity-band-point" }));
        projection.article.append(band, el("p", `${formatMetric(forecast.low, options.metric)}–${formatMetric(forecast.high, options.metric)} scenario range · ${forecast.sampleDays} complete days sampled, ${forecast.activeDays} active · ${forecast.remainingDays} days to project.`, "chart-note"));
      }
      projection.article.append(evidence([
        `A projection needs seven completed days of observed history, three active days among them and at least ${comparisonEvidenceFloor * 100}% metric evidence this month and in the sampled days.`,
        "Completed month-to-date plus remaining days at the trailing daily median, with today never below its observed value; the range uses the daily 10th–90th percentiles. This is a rate scenario, not a confidence interval. It assumes the recent workload continues, includes inactive days, and cannot predict changes in work. API-equivalent value is not an invoice.",
        evidenceLabels[options.metric] ? `Evidence month to date: ${evidenceText(indicators.projectionEvidence.observed, options.metric)}; sample: ${evidenceText(indicators.projectionEvidence.sample, options.metric)}.` : null,
      ]));
      const movement = topMovers(scoped, options, today);
      movers.article.replaceChildren(movers.header);
      movers.heading.textContent = "Top movers";
      movers.article.append(el("p", `${span({ start: movement.start, end: movement.end })} vs ${span({ start: movement.previousStart, end: movement.previousEnd })} · last 7 completed days versus the 7 before · ${metricDefinitions[options.metric].label.toLowerCase()}.`, "chart-note"));
      if (!movement.available || !movement.rows.length) movers.article.append(el("p", !movement.available ? "Select at least 14 completed days of observed history with velocity data to compare movers." : "No measured changes among groups with enough evidence.", "empty-state"));
      else {
        const table = dataTable([{ text: "Dimension", align: "left" }, { text: "Name", align: "left" }, "Previous 7 days", "Last 7 days", "Change", "%"], movement.rows.map((item) => moverCells(item, options.metric)), { className: "velocity-movers" });
        for (const cell of table.querySelector("tbody").children) cell.children[1].title = cell.children[1].children[0].title;
        movers.article.append(table);
      }
      movers.article.append(evidence([
        `${movement.excludedGroups ? `${movement.excludedGroups} groups excluded because current or prior evidence is` : "Excluded groups are those"} below ${comparisonEvidenceFloor * 100}% metric evidence. A change in telemetry is not a measured change in workload.`,
        `Percentages need a prior value of at least ${baselineText(options.metric)}${["value", "input", "uncached", "cacheRead", "cacheWrite", "output", "reasoning"].includes(options.metric) ? " and three prior model calls" : ""}.`,
      ]));
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
