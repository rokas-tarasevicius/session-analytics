import { buildVelocity, localDay, metricDefinitions, topMovers, velocityIndicators } from "./velocity-data.js";

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
const deltaLabel = (value) => value === null ? "N/A" : `${value > 0 ? "+" : ""}${number.format(value * 100)}%`;
const color = (index) => `var(--velocity-${index % 8})`;
const caption = (key, granularity) => granularity === "hour" ? `${key}:00` : granularity === "week" ? `Week of ${key}` : key;

/** One focus stop, arrow-key inspection, and a text equivalent for every plotted bucket. */
export function renderVelocityChart(container, data, { rolling = false, compactView = false } = {}) {
  container.replaceChildren(); container.classList.add("velocity-chart");
  if (!data.series.length) {
    container.append(element("p", data.missingSessions ? "Velocity is unavailable in this snapshot. Refresh to collect activity buckets." : "No observed activity for this metric in the selected dates and providers.", "empty-state"));
    return;
  }
  const width = 1040, height = compactView ? 290 : 330, left = 86, right = 18, top = 22, bottom = 40;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const stacked = data.mode === "stacked";
  const overlay = rolling && data.granularity === "day" && data.mode !== "cumulative";
  const totals = data.keys.map((_, i) => data.series.reduce((value, series) => value + series.values[i], 0));
  const maximum = [...(stacked ? [totals] : data.series.map((series) => series.values)), ...(overlay ? [data.rolling] : [])].reduce((largest, values) => values.reduce((max, value) => Math.max(max, value ?? 0), largest), 0.001);
  const magnitude = 10 ** Math.floor(Math.log10(maximum / 4));
  const axisMaximum = Math.ceil(maximum / 4 / magnitude) * magnitude * 4;
  const x = (index) => left + (data.keys.length === 1 ? plotWidth / 2 : index / (data.keys.length - 1) * plotWidth);
  const y = (value) => top + (1 - value / axisMaximum) * plotHeight;
  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, tabindex: 0, role: "group", "aria-label": `${metricDefinitions[data.metric].label}, ${data.granularity}, ${data.mode}. Use Left and Right arrows, Home and End to inspect each bucket.` });
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = axisMaximum * tick / 4;
    svg.append(svgElement("line", { x1: left, x2: width - right, y1: y(value), y2: y(value), class: "grid-line" }));
    svg.append(svgElement("text", { x: left - 12, y: y(value) + 4, "text-anchor": "end", class: "axis-label" }, formatMetric(value, data.metric, true)));
  }
  const ticks = [...new Set([0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(fraction * (data.keys.length - 1))))];
  for (const index of ticks) svg.append(svgElement("text", { x: x(index), y: height - 12, "text-anchor": index === 0 ? "start" : index === data.keys.length - 1 ? "end" : "middle", class: "axis-label" }, caption(data.keys[index], data.granularity)));
  let floor = data.keys.map(() => 0);
  data.series.forEach((series, seriesIndex) => {
    const upper = series.values.map((value, i) => value + (stacked ? floor[i] : 0));
    const path = svgElement("path", { d: upper.map((value, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(value)}`).join(" ") + (stacked ? ` ${floor.map((_, i) => { const j = floor.length - i - 1; return `L${x(j)},${y(floor[j])}`; }).join(" ")} Z` : ""), class: stacked ? "velocity-area" : "velocity-line", stroke: color(seriesIndex), fill: stacked ? color(seriesIndex) : "none" });
    if (!stacked && seriesIndex >= 8) path.setAttribute("stroke-dasharray", "6 3");
    svg.append(path);
    if (upper.length === 1) svg.append(svgElement("circle", { cx: x(0), cy: y(upper[0]), r: 4, fill: color(seriesIndex) }));
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
  data.series.forEach((series, index) => {
    const item = element("span"), swatch = element("i"); swatch.style.backgroundColor = color(index);
    item.append(swatch, element("span", series.label), element("strong", formatMetric(series.total, data.metric, true)));
    legend.append(item);
  });
  if (overlay) legend.append(element("span", "Dashed: total · rolling 7-day average", "velocity-average-key"));
  const inspection = element("div", undefined, "velocity-inspection");
  inspection.setAttribute("aria-live", "polite"); inspection.setAttribute("aria-atomic", "true");
  let selected = data.keys.length - 1;
  const inspect = (index) => {
    selected = Math.max(0, Math.min(data.keys.length - 1, index));
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
  const ratio = (n, d, label) => `${label}: ${d > 0 ? `${number.format(n)} / ${number.format(d)} (${number.format(100 * n / d)}%)` : "N/A · no eligible tokens"}`;
  let detail = "";
  if (data.metric === "value") detail = ratio(values[10], data.coverage.priceTokens, "API pricing coverage, Claude/Codex tokens");
  if (data.metric === "reasoning") detail = ratio(values[11], data.coverage.reasoningOutput, "Separate reasoning coverage, Claude/Codex output");
  if (data.metric === "cacheRead" || data.metric === "uncached") detail = ratio(values[12], data.coverage.cacheReadInput, "Cache-read split coverage, Claude/Codex input");
  if (data.metric === "cacheWrite") detail = ratio(values[13], data.coverage.cacheWriteInput, "Cache-write coverage, Claude input; Codex/Cursor unavailable");
  const included = formatMetric(values[metricDefinitions[data.metric].index], data.metric);
  const undated = formatMetric(data.undated[metricDefinitions[data.metric].index], data.metric);
  return `${included} dated · ${number.format(data.contributingSessions)} sessions with dated evidence. ${detail ? `${detail}. ` : ""}${undated} undated across this repository/provider scope, excluded from date filters and charts.${data.missingSessions ? ` ${data.missingSessions} sessions lack velocity data.` : ""}`;
}
function card(title, value, note) {
  const article = element("article", undefined, "metric-card");
  article.append(element("span", title), element("strong", value), element("small", note));
  return article;
}
function selectControl(label, choices) {
  const wrapper = element("label"), select = element("select");
  select.setAttribute("aria-label", label);
  for (const [value, text] of choices) { const option = element("option", text); option.value = value; select.append(option); }
  wrapper.append(element("span", label), select); return { wrapper, select };
}
const controllers = new WeakMap();
export function renderVelocity(container, sessions, context) {
  let controller = controllers.get(container);
  if (!controller) {
    const controls = element("div", undefined, "velocity-controls");
    const group = selectControl("Group by", [["agent", "Agent"], ["provider", "Provider"], ["model", "Model"], ["repository", "Repository"], ["execution", "Execution kind"], ["effort", "Effort"]]);
    const metric = selectControl("Metric", Object.entries(metricDefinitions).map(([key, value]) => [key, value.label]));
    const granularity = selectControl("Granularity", [["day", "Day"], ["week", "Week · Monday start"], ["month", "Month"], ["hour", "Hour-of-day profile"]]);
    const mode = selectControl("Chart", [["stacked", "Stacked area"], ["lines", "Lines"], ["cumulative", "Cumulative"]]);
    const rollingLabel = element("label", undefined, "velocity-checkbox"), rolling = element("input");
    rolling.type = "checkbox"; rolling.checked = true; rollingLabel.append(rolling, document.createTextNode("7-day average"));
    controls.append(group.wrapper, metric.wrapper, granularity.wrapper, mode.wrapper, rollingLabel);
    const filters = element("fieldset", undefined, "velocity-providers"); filters.append(element("legend", "Providers"));
    const selectedProviders = new Set(["claude", "codex", "cursor"]);
    const totals = element("div", undefined, "metric-grid compact-metrics velocity-totals");
    const panel = element("article", undefined, "panel velocity-main-panel");
    const heading = element("h3"), subtitle = element("p", undefined, "chart-note"), chart = element("div"), coverage = element("p", undefined, "chart-note velocity-coverage");
    panel.append(heading, subtitle, chart, coverage);
    const projection = element("article", undefined, "panel velocity-projection");
    const movers = element("article", undefined, "panel velocity-movers");
    container.append(controls, filters, totals, panel, projection, movers);
    controller = { sessions, context, update: null };
    const update = () => {
      const current = controller.context;
      const scoped = controller.sessions.filter((session) => selectedProviders.has(session.provider));
      const options = { start: current.start, end: current.end, group: group.select.value, metric: metric.select.value, granularity: granularity.select.value, mode: mode.select.value };
      mode.select.querySelector('[value="cumulative"]').disabled = options.granularity === "hour";
      if (options.granularity === "hour" && options.mode === "cumulative") { options.mode = "lines"; mode.select.value = "lines"; }
      rolling.disabled = options.granularity !== "day" || options.mode === "cumulative";
      rollingLabel.title = rolling.disabled ? "A daily average is shown on non-cumulative daily charts." : "Seven calendar days, including inactive dates.";
      const data = buildVelocity(scoped, options);
      const today = localDay(current.generatedAt, current.timeZone);
      const indicators = velocityIndicators(data, today);
      heading.textContent = `${metricDefinitions[options.metric].label} by ${group.select.selectedOptions[0].textContent.toLowerCase()}`;
      subtitle.textContent = `${current.start} → ${current.end} · ${current.timeZone} · ${options.granularity === "hour" ? "Totals for each local clock hour; repeated DST hours combine." : options.granularity === "week" || options.granularity === "month" ? "Boundary periods include only selected dates." : "Inactive calendar dates are included."} ${options.mode === "cumulative" ? "Accumulation restarts at the selected start date." : ""}`;
      renderVelocityChart(chart, data, { rolling: rolling.checked && !rolling.disabled });
      coverage.textContent = coverageText(data);
      const comparisonNote = (item) => `${formatMetric(item.current.value, options.metric)} vs ${formatMetric(item.previous.value, options.metric)} · ${item.current.coveredDays}/${item.current.days} and ${item.previous.coveredDays}/${item.previous.days} calendar days covered. ${item.delta === null ? "N/A: incomplete window or small baseline." : "Same elapsed days; today excluded."}`;
      totals.replaceChildren(
        card("Selected period", formatMetric(data.totals[metricDefinitions[options.metric].index], options.metric), `${data.daily.length} calendar days · ${metricDefinitions[options.metric].unit}. Activity counters do not prove quality or value delivered.`),
        card("This week vs last", deltaLabel(indicators.week.delta), comparisonNote(indicators.week)),
        card("Month to date vs prior", deltaLabel(indicators.month.delta), comparisonNote(indicators.month)),
        card("Today / 14-day median", indicators.burn.ratio === null ? "N/A" : `${number.format(indicators.burn.ratio)}×`, `${formatMetric(indicators.burn.today, options.metric)} so far / ${formatMetric(indicators.burn.median, options.metric)} per full day · ${indicators.burn.days}/14 days covered. Today is partial; this is not a same-hour comparison.`),
      );
      projection.replaceChildren(element("p", "END-OF-MONTH SCENARIO", "kicker"));
      const forecast = indicators.projection;
      if (!forecast) {
        projection.append(element("h3", "More complete history needed"), element("p", "Select the month from its start, with at least 7 completed days and 3 active days. A small baseline or a clipped time window is not enough to project.", "chart-note"));
      } else {
        projection.append(element("h3", `${formatMetric(forecast.value, options.metric)} projected by ${forecast.monthEnd}`));
        const band = svgElement("svg", { viewBox: "0 0 960 60", role: "img", "aria-label": `Scenario range ${formatMetric(forecast.low, options.metric)} to ${formatMetric(forecast.high, options.metric)}, median ${formatMetric(forecast.value, options.metric)}`, class: "velocity-band" });
        const scale = (value) => 24 + value / Math.max(forecast.high, 0.001) * 910;
        band.append(svgElement("line", { x1: 24, x2: 934, y1: 30, y2: 30, class: "velocity-band-base" }), svgElement("line", { x1: scale(forecast.low), x2: scale(forecast.high), y1: 30, y2: 30, class: "velocity-band-range" }), svgElement("circle", { cx: scale(forecast.value), cy: 30, r: 7, class: "velocity-band-point" }));
        projection.append(band, element("p", `${formatMetric(forecast.low, options.metric)}–${formatMetric(forecast.high, options.metric)} scenario range · ${forecast.sampleDays} complete days sampled, ${forecast.activeDays} active · ${forecast.remainingDays} days to project.`, "chart-note"), element("p", "Completed month-to-date plus remaining days at the trailing daily median, with today never below its observed value; range uses the daily 10th–90th percentiles. This is a rate scenario, not a confidence interval. It assumes the recent workload continues, includes inactive days, and cannot predict changes in work. API-equivalent value is not an invoice.", "chart-note"));
      }
      const movement = topMovers(scoped, options, today);
      movers.replaceChildren(element("p", "LARGEST INCREASES", "kicker"), element("h3", "Top movers"), element("p", `${movement.start}–${movement.end} vs ${movement.previousStart}–${movement.previousEnd} · last 7 completed days versus preceding 7 · ${metricDefinitions[options.metric].label.toLowerCase()}.`, "chart-note"));
      if (!movement.available || !movement.rows.length) movers.append(element("p", !movement.available ? "Select at least 14 completed days of observed history to compare movers." : "No increases in this window.", "empty-state"));
      else {
        const wrap = element("div", undefined, "table-wrap"), table = element("table"), head = element("thead"), body = element("tbody"), row = element("tr");
        for (const title of ["Dimension", "Name", "Previous 7 days", "Last 7 days", "Increase", "Change"]) { const th = element("th", title); th.scope = "col"; row.append(th); }
        head.append(row);
        for (const item of movement.rows) {
          const row = element("tr");
          for (const value of [item.group, item.label, formatMetric(item.previous, options.metric), formatMetric(item.current, options.metric), `+${formatMetric(item.increase, options.metric)}`, item.delta === null ? "N/A · small baseline" : deltaLabel(item.delta)]) row.append(element("td", value));
          body.append(row);
        }
        table.append(head, body); wrap.append(table); movers.append(wrap);
      }
    };
    controller.update = update;
    for (const provider of ["claude", "codex", "cursor"]) {
      const label = element("label", undefined, "velocity-checkbox"), input = element("input"); input.type = "checkbox"; input.checked = true;
      label.append(input, document.createTextNode(provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : "Cursor"));
      input.addEventListener("change", () => { if (input.checked) selectedProviders.add(provider); else selectedProviders.delete(provider); update(); }); filters.append(label);
    }
    for (const input of [group.select, metric.select, granularity.select, mode.select, rolling]) input.addEventListener("change", update);
    controllers.set(container, controller);
  }
  controller.sessions = sessions; controller.context = context; controller.update();
}

export function renderSummaryVelocity(container, sessions, context) {
  const data = buildVelocity(sessions, { start: context.start, end: context.end, group: "agent", metric: "value", mode: "lines" });
  renderVelocityChart(container, data, { compactView: true });
  container.append(element("p", `${context.timeZone} · ${coverageText(data)}`, "chart-note"));
}
