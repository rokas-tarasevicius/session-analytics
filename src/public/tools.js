import { buildToolsView, toolProfile } from "./tools-data.js";
import { DASH, coverageBadge, dataTable, el, evidence, kpi, note } from "./ui.js";

const integer = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const percent = (share) => `${decimal.format(share * 100)}%`;
const changeLabel = (change) => change === null ? DASH : change === "new" ? "new"
  : `${change > 0 ? "+" : change < 0 ? "−" : ""}${integer.format(Math.abs(change) * 100)}%`;

function panel(kicker, title, id) {
  const result = el("article", null, "panel"), header = el("header"), heading = el("div");
  const name = el("h3", title);
  name.setAttribute("id", id); result.setAttribute("aria-labelledby", id);
  heading.append(el("p", kicker, "kicker"), name); header.append(heading); result.append(header);
  return { result, header };
}

function bar(value, maximum, label) {
  const track = el("div", null, "bar-track tools-bar"), fill = el("i");
  track.setAttribute("role", "img"); track.setAttribute("aria-label", label);
  fill.style.width = `${maximum > 0 ? value / maximum * 100 : 0}%`;
  track.append(fill);
  return track;
}

function breakdown(title, items, total) {
  const section = el("section", null, "tools-breakdown");
  section.append(el("h4", title));
  const list = el("div", null, "bar-list");
  for (const item of items) {
    const row = el("div", null, "bar-row"), label = el("div", null, "bar-label");
    label.append(el("span", item.name), el("strong", `${integer.format(item.calls)} · ${percent(item.calls / total)}`));
    row.append(label, bar(item.calls, total, `${item.name}: ${integer.format(item.calls)} calls, ${percent(item.calls / total)} of this tool’s calls`));
    list.append(row);
  }
  section.append(list);
  return section;
}

function trend(profile) {
  const section = el("section", null, "tools-trend");
  section.append(el("h4", "Calls by session-start day"));
  const days = profile.byDay;
  const exclusions = [];
  if (profile.outsideDaysCalls) exclusions.push(note(`${integer.format(profile.outsideDaysCalls)} calls fall outside the plotted days; totals above include them.`));
  if (profile.undatedCalls) exclusions.push(note(`${integer.format(profile.undatedCalls)} calls have no known session-start day and are excluded from the chart.`));
  if (!days.length || !days.some((row) => row.coverage.eligible > 0)) {
    section.append(note(`${DASH} ${days.length ? "No tool evidence on known session-start days in this range." : "No known session-start days in this selection."}`, "empty-line"), ...exclusions);
    return section;
  }
  const peak = days.reduce((best, row) => row.calls > best.calls ? row : best, days[0]);
  const total = days.reduce((sum, row) => sum + row.calls, 0);
  const missing = days.filter((row) => row.coverage.selected > 0 && !row.coverage.eligible).length;
  const description = `${profile.name}: ${integer.format(total)} calls plotted from ${days[0].day} to ${days.at(-1).day} (UTC). ${peak.calls ? `Peak ${integer.format(peak.calls)} on ${peak.day}.` : "No calls with an evidenced start day in this range."}${missing ? ` ${missing} days have session starts but no tool evidence; these are unavailable, not zero.` : ""}`;
  const scroll = el("div", null, "tools-trend-scroll"), chart = el("div", null, "tools-columns");
  chart.setAttribute("role", "img"); chart.setAttribute("aria-label", description);
  chart.style.setProperty("grid-template-columns", `repeat(${days.length}, minmax(2px, 1fr))`);
  chart.style.setProperty("min-width", `${Math.max(240, days.length * 3)}px`);
  for (const row of days) {
    const column = el("div", null, "tools-column"), fill = el("i");
    const unavailable = row.coverage.selected > 0 && !row.coverage.eligible;
    column.setAttribute("title", `${row.day}: ${unavailable ? `${DASH} no tool evidence` : `${integer.format(row.calls)} calls`}${row.coverage.selected ? ` (${row.coverage.eligible}/${row.coverage.selected} sessions carry tool evidence)` : " (no session starts)"}`);
    fill.style.setProperty("height", `${peak.calls ? row.calls / peak.calls * 100 : 0}%`);
    column.append(fill); chart.append(column);
  }
  scroll.append(chart); section.append(scroll);
  const axis = el("div", null, "tools-trend-axis");
  axis.append(el("span", days[0].day), el("span", days.at(-1).day)); section.append(axis);
  section.append(note(`${integer.format(total)} calls plotted · ${peak.calls ? `peak ${integer.format(peak.calls)} on ${peak.day}` : "no dated calls in this range"} · baseline 0 · UTC`));
  if (missing) section.append(note(`${missing} days have sessions without tool evidence; their counts are ${DASH}.`));
  section.append(...exclusions);
  return section;
}

/** Returns the resolved selection so the app can keep it across provider, scope, and window changes. */
export function renderToolsView(container, { sessions, previousSessions = null, days, selectedTool = null,
  expanded = false, onSelect = () => {}, onToggle = () => {}, repositories = [] }) {
  container.replaceChildren();
  const data = buildToolsView(sessions, { previousSessions });
  const selected = data.tools.find((tool) => tool.name === selectedTool) ?? data.tools[0] ?? null;
  const available = data.coverage.eligible > 0, top = data.tools[0];
  const reason = "No selected sessions carry tool evidence";
  const cards = el("div", null, "kpi-grid compact-metrics tools-metrics");
  cards.append(
    kpi({ label: "Tool calls", value: available ? integer.format(data.totalCalls) : null, reason,
      coverage: data.coverage, what: "tool evidence",
      note: !available ? null : data.change === null ? "Effective calls in this selection" : `${changeLabel(data.change)} vs previous window` }),
    kpi({ label: "Distinct tools", value: available ? integer.format(data.distinctTools) : null, reason, note: "Structured tool-call names" }),
    kpi({ label: "Calls per session", value: available ? decimal.format(data.callsPerSession) : null, reason, note: "Across sessions with tool evidence" }),
    kpi({ label: "Most used tool", value: top?.name ?? null, reason: available ? "No recorded tool calls" : reason,
      note: top ? `${percent(top.share)} of calls` : null }),
  );
  container.append(cards);

  const ranking = panel("All tools", "Tool ranking", "tools-ranking-title");
  const badge = coverageBadge(data.coverage, "tool evidence");
  if (badge) ranking.header.append(badge);
  const rows = (expanded ? data.tools : data.tools.slice(0, 12)).map((tool) => {
    const button = el("button", tool.name, "tools-select");
    button.setAttribute("type", "button"); button.dataset.focusKey = `tools:tool:${tool.name}`;
    button.setAttribute("aria-pressed", String(tool.name === selected.name));
    button.setAttribute("aria-controls", "tools-profile");
    button.setAttribute("aria-label", `Show tool profile for ${tool.name}`);
    button.addEventListener("click", () => onSelect(tool.name));
    const calls = el("div", null, "tools-calls");
    calls.append(el("span", integer.format(tool.calls)), bar(tool.calls, top.calls, `${tool.name}: ${integer.format(tool.calls)} calls; scale 0 to ${integer.format(top.calls)}`));
    return [button, calls, percent(tool.share), integer.format(tool.sessions), integer.format(tool.repositories), changeLabel(tool.change)];
  });
  ranking.result.append(dataTable(["Tool", "Calls", "Share of calls", "Sessions", "Repositories", "Change"], rows,
    { rowHeader: true, className: "tools-ranking", minWidth: "700px", caption: "Tools ranked by effective calls in the selected window",
      empty: available ? "No recorded tool calls in the selected sessions." : `${DASH} ${reason}.` }));
  if (data.tools.length > 12) {
    const toggle = el("button", expanded ? "Show fewer" : `Show all ${integer.format(data.tools.length)} tools`, "button tools-toggle");
    toggle.setAttribute("type", "button"); toggle.dataset.focusKey = "tools:toggle";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.addEventListener("click", onToggle); ranking.result.append(toggle);
  }
  container.append(ranking.result);

  const profilePanel = panel("Tool profile", selected?.name ?? DASH, "tools-profile-title");
  profilePanel.result.setAttribute("id", "tools-profile");
  if (selected) {
    const repositoryNames = new Map(repositories.map(({ repository }) => [repository.id, repository.name]));
    const profile = toolProfile(sessions, selected.name, { days, repositoryNames });
    const stats = el("dl", null, "tools-profile-stats");
    for (const [label, value] of [["Calls", integer.format(profile.calls)], ["Share of calls", percent(profile.share)],
      ["Sessions using it", integer.format(profile.sessions)], ["Repositories", integer.format(profile.repositories)],
      ["Calls per session using it", decimal.format(profile.callsPerSession)]]) {
      const stat = el("div"); stat.append(el("dt", label), el("dd", value)); stats.append(stat);
    }
    profilePanel.result.append(stats, trend(profile));
    const splits = el("div", null, "tools-splits"), repositoryRows = profile.byRepository.slice(0, 8);
    if (profile.byRepository.length > 8) repositoryRows.push({ name: "Other", calls: profile.byRepository.slice(8).reduce((sum, row) => sum + row.calls, 0) });
    splits.append(breakdown("By provider", profile.byProvider.map((row) => ({ name: row.label, calls: row.calls })), profile.calls),
      breakdown("By repository", repositoryRows, profile.calls));
    profilePanel.result.append(splits);
  } else profilePanel.result.append(note(available ? "A profile appears when there are recorded tool calls." : `${DASH} ${reason}.`, "empty-line"));
  container.append(profilePanel.result, evidence([
    `${data.coverage.eligible} of ${data.coverage.selected} selected sessions carry tool evidence. Sessions without tool evidence are excluded from counts and averages; unavailable values are ${DASH}, not zero.`,
    "Tool names come from structured tool-call records only; arguments and results remain excluded. Calls per session uses eligible sessions, including observed zero-call sessions. A tool’s profile average uses only sessions using that tool.",
    "Day attribution uses the session start day (UTC), not the time of each call. Unknown starts are excluded from the chart. All observed time shows at most the latest 366 calendar days; totals include the full selection.",
    "Tool calls carry no cost or duration of their own in local history; session value is not divided across tools.",
    `Change is (current calls − previous calls) / previous calls for the preceding equal-length, fully observed window, using the same repository scope and provider filters. “new” means calls now and zero before. ${DASH} means no comparable window or no tool evidence in one window. An observed window with no sessions has zero calls.`,
    data.previousCoverage ? `Previous window: ${data.previousCoverage.eligible} of ${data.previousCoverage.selected} sessions carry tool evidence. Changes compare recorded totals, not coverage-adjusted estimates; differences in coverage can affect them.` : "No previous-window comparison is available for this selection.",
  ]));
  return selected?.name ?? null;
}
