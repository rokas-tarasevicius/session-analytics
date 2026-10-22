import { decimal, dayLabel, deltaText, integer, percent as formatPercent, toolDayLabel } from "./format.js";
import { providerColor } from "./chart-colors.js";
import { barPercent } from "./chart-scale.js";
import { buildToolOrigins, buildToolsView, toolProfile } from "./tools-data.js";
import { providerMark } from "./providers.js";
import { DASH, coverageBadge, dataTable, el, evidence, kpi, note } from "./ui.js";

const percent = (share) => formatPercent(share, 1, 0);
const calls = (count) => `${integer(count)} ${count === 1 ? "call" : "calls"}`;
/** Tables and KPI notes share the same arrow and one-decimal change formatter. */
export function changeLabel(change) {
  return change === null || change === undefined ? DASH : deltaText(change);
}

function panel(title, id) {
  const result = el("article", null, "panel"), header = el("header"), heading = el("div");
  const name = el("h3", title);
  name.setAttribute("id", id); result.setAttribute("aria-labelledby", id);
  heading.append(name); header.append(heading); result.append(header);
  return { result, header };
}

function bar(value, maximum, label, color = null) {
  const track = el("div", null, "bar-track tools-bar"), fill = el("i");
  track.setAttribute("role", "img"); track.setAttribute("aria-label", label);
  fill.style.setProperty("width", `${barPercent(value, maximum)}%`);
  if (color) fill.style.setProperty("--series-color", color);
  track.append(fill);
  return track;
}

function breakdown(title, items, total) {
  const section = el("section", null, "tools-breakdown");
  section.append(el("h4", title));
  const list = el("div", null, "bar-list");
  for (const item of items) {
    const row = el("div", null, "bar-row"), label = el("div", null, "bar-label");
    label.append(el("span", item.name), el("strong", `${integer(item.calls)} · ${percent(item.calls / total)}`));
    row.append(label, bar(item.calls, total, `${item.name}: ${calls(item.calls)}, ${percent(item.calls / total)} of this tool’s calls`, item.provider ? providerColor(item.provider) : null));
    list.append(row);
  }
  section.append(list);
  return section;
}

function providerCell(providers) {
  const cell = el("span", null, "tools-cell tools-providers"), visible = el("span", null, "tools-provider-list");
  cell.dataset.label = "Provider";
  const description = providers.map(({ label, calls: count }) => `${label} ${calls(count)}`).join(", ");
  cell.setAttribute("title", description); visible.setAttribute("aria-hidden", "true");
  for (const { provider, label } of providers) {
    const item = el("span", null, "tools-provider"); item.append(providerMark(provider));
    if (providers.length <= 2) item.append(el("span", label));
    visible.append(item);
  }
  if (providers.length > 2) visible.append(el("span", `${providers.length} providers`));
  cell.append(visible, el("span", description, "sr-only"));
  return cell;
}

function labelledCell(label, text) {
  const cell = el("span", text, "tools-cell"); cell.dataset.label = label; return cell;
}

function originsPanel(sessions) {
  const data = buildToolOrigins(sessions), section = panel("MCP server usage", "tools-origins-title");
  section.result.classList.add("tools-origins");
  const reach = (count, share) => `${integer(count)} · ${percent(share)}`;
  const rows = [...data.groups, ...data.servers].map((row, index) => {
    const name = el("span", row.name, "tools-origin-name");
    if (index < data.groups.length) name.classList.add("tools-origin-group");
    return [name, labelledCell("Calls · share", reach(row.calls, row.callShare)),
      labelledCell("Sessions · reach", reach(row.sessions, row.sessionShare)),
      labelledCell("Repositories · reach", reach(row.repositories, row.repositoryShare))];
  });
  section.result.append(note("MCP-prefixed calls versus other tool names, followed by each observed MCP server."),
    dataTable(["Tool origin / server", "Calls · share", "Sessions · reach", "Repositories · reach"], rows,
      { rowHeader: true, className: "tools-origins-table", caption: "Tool origins and MCP servers in the current selection",
        empty: `${DASH} No selected sessions carry tool evidence.` }),
    note(`Shares use all recorded calls, ${integer(data.coverage.eligible)} eligible sessions and ${integer(data.eligibleRepositories)} repositories with tool evidence in this selection. Session and repository reach can overlap.`),
    note("MCP recognition uses mcp__<server>__<tool> names only. Other names may include MCP calls without that prefix. This shows usage, not server configuration or reliability."));
  return section.result;
}

function providerSplit(profile) {
  if (profile.byProvider.length !== 1) return breakdown("By provider", profile.byProvider.map((row) => ({ name: row.label, calls: row.calls, provider: row.provider })), profile.calls);
  const section = el("section", null, "tools-breakdown"), sentence = el("p", null, "tools-provider-sentence");
  const provider = profile.byProvider[0];
  sentence.append(providerMark(provider.provider), el("span", `All ${integer(profile.calls)} calls came from ${provider.label}.`));
  section.append(el("h4", "By provider"), sentence); return section;
}

function trend(profile, timeZone = "UTC") {
  const section = el("section", null, "tools-trend");
  section.append(el("h4", "Calls by session-start day"));
  const days = profile.byDay;
  const exclusions = [];
  if (profile.outsideDaysCalls) exclusions.push(note(`${integer(profile.outsideDaysCalls)} calls outside plotted days`, "chart-note"));
  if (profile.undatedCalls) exclusions.push(note(`${integer(profile.undatedCalls)} undated calls excluded`));
  if (!days.length || !days.some((row) => row.coverage.eligible > 0)) {
    section.append(note(`${DASH} ${days.length ? "No tool evidence on known session-start days in this range." : "No known session-start days in this selection."}`, "empty-line"), ...exclusions);
    return section;
  }
  const peak = days.reduce((best, row) => row.calls > best.calls ? row : best, days[0]);
  const total = days.reduce((sum, row) => sum + row.calls, 0);
  const missing = days.filter((row) => row.coverage.selected > 0 && !row.coverage.eligible).length;
  const suffix = `${peak.calls ? `peak ${integer(peak.calls)} on ${peak.day}` : "no dated calls in this range"} · baseline 0 · ${timeZone}`;
  const description = `${profile.name}: ${integer(total)} calls plotted from ${days[0].day} to ${days.at(-1).day}. ${suffix}.${missing ? ` ${missing} days have session starts but no tool evidence; these are unavailable, not zero.` : ""}`;
  const plot = el("div", null, "tools-trend-plot"), labels = el("div", null, "tools-trend-labels");
  labels.setAttribute("aria-hidden", "true"); labels.append(el("span", integer(peak.calls)), el("span", "0"));
  const scroll = el("div", null, "tools-trend-scroll"), chart = el("div", null, "tools-columns");
  const tooltip = el("div", null, "tools-tooltip"); tooltip.setAttribute("role", "tooltip"); tooltip.hidden = true;
  chart.setAttribute("role", "group"); chart.setAttribute("aria-label", description);
  chart.style.setProperty("grid-template-columns", `repeat(${days.length}, minmax(2px, 1fr))`);
  chart.style.setProperty("min-width", `${days.length * 3}px`);
  const columns = [];
  for (const [index, row] of days.entries()) {
    const column = el("div", null, "tools-column"), fill = el("i");
    const unavailable = row.coverage.selected > 0 && !row.coverage.eligible;
    column.setAttribute("role", "img");
    column.setAttribute("aria-label", `${row.day}: ${unavailable ? `${DASH} no tool evidence` : calls(row.calls)}${row.coverage.selected ? ` (${row.coverage.eligible}/${row.coverage.selected} sessions carry tool evidence)` : " (no session starts)"}`);
    column.setAttribute("tabindex", index === days.length - 1 ? "0" : "-1");
    const showTooltip = () => {
      tooltip.replaceChildren(el("strong", toolDayLabel(row.day)),
        el("span", unavailable ? `${DASH} no tool evidence` : calls(row.calls)),
        el("span", row.coverage.selected ? `${row.coverage.eligible} of ${row.coverage.selected} sessions carry tool evidence` : "No session starts"));
      tooltip.hidden = false; tooltip.dataset.side = "above";
      const cellRect = column.getBoundingClientRect?.(), bounds = section.getBoundingClientRect?.(), tip = tooltip.getBoundingClientRect?.();
      if (!cellRect || !bounds || !tip) return;
      const panelTop = section.closest?.("#tools-profile")?.getBoundingClientRect?.()?.top ?? 0;
      const topbarBottom = document.querySelector?.(".topbar")?.getBoundingClientRect?.()?.bottom ?? 0;
      let top = cellRect.top - tip.height - 10;
      if (top < Math.max(8, panelTop, topbarBottom)) { top = cellRect.bottom + 10; tooltip.dataset.side = "below"; }
      const left = Math.max(0, Math.min(bounds.width - tip.width, cellRect.left - bounds.left + cellRect.width / 2 - tip.width / 2));
      tooltip.style.setProperty("left", `${left}px`); tooltip.style.setProperty("top", `${top - bounds.top}px`);
    };
    const hideTooltip = () => { tooltip.hidden = true; };
    column.addEventListener("pointerenter", showTooltip); column.addEventListener("pointerleave", hideTooltip);
    column.addEventListener("focus", () => {
      for (const item of columns) item.setAttribute("tabindex", item === column ? "0" : "-1");
      showTooltip();
    });
    column.addEventListener("blur", hideTooltip);
    column.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hideTooltip(); return; }
      const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: days.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      const next = columns[Math.max(0, Math.min(days.length - 1, target))];
      column.setAttribute("tabindex", "-1"); next.setAttribute("tabindex", "0"); next.focus?.();
    });
    fill.style.setProperty("height", `${peak.calls ? row.calls / peak.calls * 100 : 0}%`);
    fill.setAttribute("aria-hidden", "true"); column.append(fill); chart.append(column); columns.push(column);
  }
  scroll.append(chart); plot.append(labels, scroll); section.append(plot, tooltip);
  const axis = el("div", null, "tools-trend-axis");
  axis.append(el("span", dayLabel(days[0].day)), el("span", dayLabel(days.at(-1).day))); section.append(axis);
  section.append(note(`${integer(total)} calls plotted · baseline 0 · ${timeZone}`));
  if (missing) section.append(note(`${integer(missing)} days without tool evidence (${DASH})`));
  section.append(...exclusions);
  return section;
}

/** Returns the resolved selection so the app can keep it across provider, scope, and window changes. */
export function renderToolsView(container, { sessions, previousSessions = null, days, timeZone = "UTC", selectedTool = null,
  expanded = false, onSelect = () => {}, onToggle = () => {}, announce = () => {}, repositories = [] }) {
  container.replaceChildren();
  const layout = el("div", null, "tools-layout"); container.append(layout);
  const data = buildToolsView(sessions, { previousSessions });
  const selected = data.tools.find((tool) => tool.name === selectedTool) ?? data.tools[0] ?? null;
  const available = data.coverage.eligible > 0, top = data.tools[0];
  const reason = "No selected sessions carry tool evidence";
  const cards = el("div", null, "kpi-grid compact-metrics tools-metrics");
  cards.append(
    kpi({ label: "Tool calls", value: available ? integer(data.totalCalls) : null, reason,
      coverage: data.coverage, what: "tool evidence",
      note: !available ? null : data.smallBaseline ? `Small baseline (${calls(data.previousCalls)})` : data.change === null ? "Effective calls in this selection" : deltaText(data.change, days.length) }),
    kpi({ label: "Distinct tools", value: available ? integer(data.distinctTools) : null, reason, note: "Structured tool-call names" }),
    kpi({ label: "Calls per session", value: available ? decimal(data.callsPerSession) : null, reason, note: "Per eligible session" }),
    kpi({ label: "Most used tool", value: top?.name ?? null, reason: available ? "No recorded tool calls" : reason,
      note: top ? `${percent(top.share)} of calls` : null }),
  );
  layout.append(cards);
  layout.append(originsPanel(sessions));

  const ranking = panel("Top tools", "tools-ranking-title");
  const badge = coverageBadge(data.coverage, "tool evidence");
  if (badge) ranking.header.append(badge);
  const rows = (expanded ? data.tools : data.tools.slice(0, 12)).map((tool) => {
    const button = el("button", null, "tools-select");
    for (const part of tool.name.split(/(?<=[_.-])/)) {
      button.append(document.createTextNode(part));
      if (/[_.-]$/.test(part)) button.append(el("wbr"));
    }
    button.title = tool.name;
    button.setAttribute("type", "button"); button.dataset.focusKey = `tools:tool:${tool.name}`;
    button.setAttribute("aria-pressed", String(tool.name === selected.name));
    button.setAttribute("aria-controls", "tools-profile");
    button.setAttribute("aria-label", `Show tool profile for ${tool.name} (${tool.providers.map(({ label }) => label).join(", ")})`);
    button.addEventListener("click", () => {
      onSelect(tool.name);
      announce(`Showing profile for ${tool.name}: ${calls(tool.calls)}, ${percent(tool.share)} of calls`);
      const profile = document.getElementById?.("tools-profile"), rect = profile?.getBoundingClientRect?.();
      const topbar = document.querySelector?.(".topbar")?.getBoundingClientRect?.();
      const height = globalThis.innerHeight ?? globalThis.window?.innerHeight;
      if (rect && height && (rect.top < (topbar?.bottom ?? 52) || rect.top > height * 0.85)) {
        profile.scrollIntoView?.({ block: "start", behavior: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth" });
      }
    });
    const callsBar = el("div", null, "tools-calls");
    callsBar.append(el("span", integer(tool.calls)), bar(tool.calls, top.calls, `${tool.name}: ${calls(tool.calls)}; scale 0 to ${integer(top.calls)}`));
    const callsCell = labelledCell("Calls", null); callsCell.append(callsBar);
    const change = labelledCell("Change", null); change.append(el("span", changeLabel(tool.change), tool.change === "new" ? "tools-change-word" : null));
    if (tool.smallBaseline) {
      change.append(el("small", "small baseline", "tools-change-detail"));
      change.setAttribute("title", `Previous window: ${calls(tool.previousCalls)}, below the 5-call minimum for a percentage`);
    }
    return [button, providerCell(tool.providers), callsCell, labelledCell("Share", percent(tool.share)), labelledCell("Sessions", integer(tool.sessions)), labelledCell("Repositories", integer(tool.repositories)), change];
  });
  ranking.result.append(dataTable(["Tool", { text: "Provider", align: "left" }, "Calls", "Share", "Sessions", "Repositories", "Change"], rows,
    { rowHeader: true, className: "tools-ranking", caption: "Tools ranked by effective calls in the selected window",
      empty: available ? "No recorded tool calls in the selected sessions." : `${DASH} ${reason}.` }));
  if (data.tools.length > 12) {
    const toggle = el("button", expanded ? "Show fewer" : `Show all ${integer(data.tools.length)} tools`, "button tools-toggle");
    toggle.setAttribute("type", "button"); toggle.dataset.focusKey = "tools:toggle";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.addEventListener("click", onToggle); ranking.result.append(toggle);
  }
  layout.append(ranking.result);

  const profilePanel = panel(selected?.name ?? DASH, "tools-profile-title");
  profilePanel.result.setAttribute("id", "tools-profile");
  if (selected) {
    const repositoryNames = new Map(repositories.map(({ repository }) => [repository.id, repository.name]));
    const profile = toolProfile(sessions, selected.name, { days, repositoryNames, timeZone });
    const stats = el("dl", null, "tools-profile-stats");
    for (const [label, value] of [["Calls", integer(profile.calls)], ["Share of calls", percent(profile.share)],
      ["Sessions using it", integer(profile.sessions)], ["Repositories", integer(profile.repositories)],
      ["Per session using it", decimal(profile.callsPerSession)]]) {
      const stat = el("div"); stat.append(el("dt", label), el("dd", value)); stats.append(stat);
    }
    profilePanel.result.append(stats, trend(profile, timeZone));
    const splits = el("div", null, "tools-splits"), repositoryRows = profile.byRepository.slice(0, 8);
    if (profile.byRepository.length > 8) repositoryRows.push({ name: "Other", calls: profile.byRepository.slice(8).reduce((sum, row) => sum + row.calls, 0) });
    splits.append(providerSplit(profile), breakdown("By repository", repositoryRows, profile.calls));
    profilePanel.result.append(splits);
  } else profilePanel.result.append(note(available ? "A profile appears when there are recorded tool calls." : `${DASH} ${reason}.`, "empty-line"));
  layout.append(profilePanel.result, evidence([
    `${data.coverage.eligible} of ${data.coverage.selected} selected sessions carry tool evidence. Sessions without tool evidence are excluded from counts and averages; unavailable values are ${DASH}, not zero.`,
    "Tool names come from structured tool-call records only; arguments and results remain excluded. Calls per session uses eligible sessions, including observed zero-call sessions. A tool’s profile average uses only sessions using that tool.",
    `Day attribution uses the session start day (${timeZone}), not the time of each call. Unknown starts are excluded from the chart. All observed time shows at most the latest 366 calendar days; totals include the full selection.`,
    "Tool calls carry no cost or duration of their own in local history; session value is not divided across tools.",
    `Change is (current calls − previous calls) / previous calls for the preceding equal-length, fully observed window, using the same repository scope and provider filters. “new” means calls now and zero before. ${DASH} means no comparable window, no tool evidence in one window, or a previous baseline below 5 calls. An observed window with no sessions has zero calls.`,
    data.previousCoverage ? `Previous window: ${data.previousCoverage.eligible} of ${data.previousCoverage.selected} sessions carry tool evidence. Changes compare recorded totals, not coverage-adjusted estimates; differences in coverage can affect them.` : "No previous-window comparison is available for this selection.",
  ]));
  return selected?.name ?? null;
}
