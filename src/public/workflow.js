import { createWorkflowScope } from "./workflow-scope.js";
import { DASH, dataTable, evidence, kpi, statList } from "./ui.js";

const numberFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const moneyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const number = (value) => value === null || value === undefined ? DASH : numberFormat.format(value);
const time = (value) => value === null || value === undefined ? DASH : value < 60_000 ? `${number(value / 1000)}s` : value < 3_600_000 ? `${number(value / 60_000)}m` : `${number(value / 3_600_000)}h`;
const money = (value) => moneyFormat.format(value);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const svgNode = (tag, attributes = {}, text) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
};
function panel(kicker, title, wide = false) {
  const section = el("article", null, `panel${wide ? " workflow-wide" : ""}`), header = el("header"), labels = el("div");
  labels.append(el("p", kicker, "kicker"), el("h2", title)); header.append(labels); section.append(header); return section;
}
function note(target, text) { target.append(evidence([text])); }
function caption(target, text) { target.append(el("p", text, "chart-note")); }
function stats(target, values) { target.append(statList(values)); }
function table(target, headings, rows, empty = "No observations in this scope.") {
  target.append(dataTable(headings.map((title, index) => index === 0 ? { text: title, align: "left" } : title), rows.map((values) => values.map((value) => Array.isArray(value) ? { text: value[0], detail: value[1] } : value)), { empty, className: "workflow-scroll" }));
}

function concurrencyPanel(w) {
  const section = panel("PARALLEL WORK", "Concurrent sessions, day by day", true), c = w.concurrency;
  caption(section, `${c.eligibleSessions} sessions with activity spans · select a day to inspect its timeline.`);
  if (!c.daily.length) { section.append(el("p", "No positive activity spans in this scope.", "empty-line")); return section; }
  const first = Date.parse(c.daily[0].day), last = Date.parse(c.daily.at(-1).day), days = Math.round((last - first) / 86_400_000) + 1;
  const chart = svgNode("svg", { viewBox: "0 0 1100 160", class: "workflow-chart", role: "group", "aria-label": "Daily peak concurrently active sessions. Select a day for detail." });
  const axis = 128, x = (date) => 45 + ((Date.parse(date) - first) / 86_400_000 + .5) / days * 1020, barWidth = Math.min(50, 1020 / days * .7);
  chart.append(svgNode("line", { x1: 40, y1: axis, x2: 1070, y2: axis, class: "workflow-axis" }));
  chart.append(svgNode("text", { x: 0, y: 22 }, `${c.peak}`), svgNode("text", { x: 18, y: axis }, "0"));
  const detail = el("div", null, "workflow-day");
  const select = (date) => {
    for (const group of chart.querySelectorAll("[data-day]")) group.setAttribute("aria-pressed", String(group.dataset.day === date));
    detail.replaceChildren(el("h3", `${date} · active-session timeline · UTC`));
    const start = Date.parse(date), end = start + 86_400_000;
    const spans = c.timeline.filter((s) => Date.parse(s.start) < end && Date.parse(s.end) > start);
    const graph = svgNode("svg", { viewBox: "0 0 1100 130", class: "workflow-chart", role: "img", "aria-label": `${date}: peak ${c.daily.find((d) => d.day === date).peak} concurrently active sessions` });
    const px = (at) => 45 + (at - start) / 86_400_000 * 1020, py = (count) => 95 - count / Math.max(1, c.peak) * 75;
    graph.append(svgNode("line", { x1: 45, y1: 95, x2: 1065, y2: 95, class: "workflow-axis" }));
    for (const s of spans) {
      const a = Math.max(start, Date.parse(s.start)), b = Math.min(end, Date.parse(s.end));
      const rect = svgNode("rect", { x: px(a), y: py(s.sessions), width: Math.max(.5, px(b) - px(a)), height: 95 - py(s.sessions), class: "workflow-area" });
      rect.append(svgNode("title", {}, `${new Date(a).toISOString().slice(11, 19)}–${new Date(b).toISOString().slice(11, 19)} UTC: ${s.sessions} sessions`)); graph.append(rect);
    }
    for (const hour of [0, 6, 12, 18, 24]) graph.append(svgNode("text", { x: px(start + hour * 3_600_000), y: 118, "text-anchor": "middle" }, `${String(hour).padStart(2, "0")}:00`));
    const graphScroll = el("div", null, "workflow-plot-scroll"); graphScroll.append(graph); detail.append(graphScroll);
    const daily = c.daily.find((d) => d.day === date);
    caption(detail, `Peak ${daily.peak} · ${time(daily.activeSessionMilliseconds)} summed session activity / ${time(daily.wallClockActiveMilliseconds)} wall-clock activity.`);
  };
  for (const item of c.daily) {
    const height = item.peak / c.peak * 100;
    const group = svgNode("g", { tabindex: 0, role: "button", "data-day": item.day, "aria-label": `${item.day}, peak ${item.peak} sessions`, "aria-pressed": "false" });
    group.append(svgNode("rect", { x: x(item.day) - barWidth / 2, y: axis - height, width: barWidth, height, class: "workflow-bar" }), svgNode("title", {}, `${item.day} · peak ${item.peak}`));
    group.addEventListener("click", () => select(item.day));
    group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(item.day); } });
    chart.append(group);
  }
  for (const date of new Set([c.daily[0].day, c.daily[Math.floor(c.daily.length / 2)].day, c.daily.at(-1).day])) chart.append(svgNode("text", { x: x(date), y: 153, "text-anchor": "middle" }, date.slice(5)));
  const chartScroll = el("div", null, "workflow-plot-scroll"); chartScroll.append(chart); section.append(chartScroll, detail); select(c.daily.at(-1).day);
  section.append(evidence(["Activity is estimated from consecutive work events at most 5 minutes apart. Long idle gaps do not inflate concurrency. These are session counts, not CPU utilization or simultaneous model requests.", "Claude child transcripts stay inside their parent; Codex child threads are separate sessions."]));
  return section;
}

function heatPanel(w) {
  const section = panel("TIME PATTERNS", "When agents are active", true), header = section.querySelector("header"), switches = el("div", null, "segmented");
  const scroll = el("div", null, "workflow-plot-scroll"), heat = el("div", null, "heat-grid workflow-heat"), info = el("p", "Focus or hover a cell for its value.", "workflow-heat-info");
  info.setAttribute("role", "status"); scroll.append(heat);
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const draw = (metric) => {
    for (const button of switches.children) button.setAttribute("aria-pressed", String(button.dataset.metric === metric));
    heat.replaceChildren(el("span", "UTC", "heat-row-label"));
    for (let hour = 0; hour < 24; hour += 1) heat.append(el("span", hour % 4 === 0 ? String(hour).padStart(2, "0") : ""));
    const field = metric === "active" ? "activeMilliseconds" : "apiEquivalentUsd", maximum = Math.max(1, ...w.patterns.cells.map((c) => c[field]));
    for (const weekday of [1, 2, 3, 4, 5, 6, 0]) {
      heat.append(el("span", weekdays[weekday], "heat-row-label"));
      for (let hour = 0; hour < 24; hour += 1) {
        const cell = w.patterns.cells[weekday * 24 + hour], value = cell[field], button = el("button", null, "heat-cell");
        button.type = "button"; button.dataset.level = value ? String(Math.max(1, Math.ceil(Math.log1p(value) / Math.log1p(maximum) * 7))) : "0";
        const label = `${weekdays[weekday]} ${String(hour).padStart(2, "0")}:00 UTC · ${metric === "active" ? `${time(value)} session activity` : `${money(value)} API-equivalent value`}`;
        button.setAttribute("aria-label", label); button.title = label;
        for (const event of ["focus", "pointerenter", "click"]) button.addEventListener(event, () => { info.textContent = label; });
        heat.append(button);
      }
    }
    info.textContent = metric === "active" ? "Summed session activity, split at each UTC hour. Overlapping sessions add together." : `Timestamped primary-transcript requests: ${w.patterns.timestampedPricedRequests}/${w.patterns.pricedRequests}. API-equivalent value is not an invoice; Cursor and unpriced requests are excluded.`;
  };
  for (const [metric, title] of [["active", "Active time"], ["value", "Usage value"]]) {
    const button = el("button", title); button.type = "button"; button.dataset.metric = metric; button.setAttribute("aria-pressed", "false"); button.addEventListener("click", () => draw(metric)); switches.append(button);
  }
  header.append(switches); section.append(scroll, info);
  const streaks = el("div", null, "workflow-streaks");
  for (const [value, label] of [[w.patterns.activeDays, "active days"], [w.patterns.longestStreakDays, "days · longest streak"], [w.patterns.currentStreakDays, `days · current at ${w.patterns.asOfDay}`]]) {
    const item = el("span"); item.append(el("strong", value), document.createTextNode(` ${label}`)); streaks.append(item);
  }
  section.append(streaks); draw("active"); return section;
}

function mixPanel(w) {
  const section = panel("ADOPTION OVER TIME", "Model, effort & client mix", true), select = el("select"), content = el("div");
  select.setAttribute("aria-label", "Workflow mix dimension");
  const field = el("label", null, "field"); field.append(el("span", "Dimension", "field-label"), select);
  for (const [value, label] of [["cliVersion", "CLI version"], ["model", "Model"], ["effort", "Reasoning effort"], ["entrypoint", "Entrypoint"], ["originator", "Originator"]]) select.append(new Option(label, value));
  const draw = () => {
    content.replaceChildren();
    const rows = new Map();
    for (const sample of w.mix.filter((s) => s.dimension === select.value)) {
      const key = `${sample.provider}:${sample.name}`, row = rows.get(key) || { name: sample.name, provider: sample.provider, first: sample.day, last: sample.day, count: 0 };
      row.first = row.first < sample.day ? row.first : sample.day; row.last = row.last > sample.day ? row.last : sample.day; row.count += sample.sessions; rows.set(key, row);
    }
    table(content, ["Observed identifier", "Provider", "First → last seen", "Session-days"], [...rows.values()].sort((a, b) => b.count - a.count).map((r) => [r.name, r.provider, `${r.first} → ${r.last}`, number(r.count)]));
    const details = el("details", null, "evidence"), grid = el("div", null, "evidence-body"); details.append(el("summary", "Daily mix observations"));
    let built = false;
    details.addEventListener("toggle", () => {
      if (!details.open || built) return;
      built = true;
      table(grid, ["UTC date", "Provider", "Identifier", "Sessions observed"], w.mix.filter((s) => s.dimension === select.value).slice().reverse().map((s) => [s.day, s.provider, s.name, number(s.sessions)]));
    });
    details.append(grid); content.append(details);
  };
  select.addEventListener("change", draw); section.querySelector("header").append(field); section.append(content);
  note(section, "Counts are distinct session-day observations, not time or token shares. A session can use several models or versions. Unknown labels are omitted; retained metadata transitions define coverage."); draw(); return section;
}

function inventoryPanels(w) {
  const commands = panel("SHORTCUTS", "Observed slash commands");
  table(commands, ["Command name", "Uses"], w.commands.map((s) => [s.name, number(s.count)]), "No registered slash commands in the matched history.");
  note(commands, `${w.commandHistorySessions} sessions with readable Claude history · ${w.inventory.historyFilesRead} files read, ${w.inventory.historyFilesUnavailable} absent/unreadable. ${w.unrecognizedCommands || 0} unrecognized slash-prefixed entries counted without their text. Names require built-in or discovered command/skill registry evidence. Arguments are discarded.`);
  const skills = panel("SKILL INVENTORY", "Installed, without an observed invocation");
  const unused = w.installedSkills.filter((s) => !s.observedInvocations), tags = el("div", null, "workflow-inventory");
  for (const item of unused) tags.append(el("span", `${item.name} · ${item.provider}${item.repositoryId ? " · repository" : ""}`, "workflow-tag"));
  if (!unused.length) tags.append(el("p", w.installedSkills.length ? "Every discovered skill has an observed invocation in this scope." : "No installed skills discovered in the scoped directories.", "empty-line"));
  skills.append(tags);
  note(skills, `${unused.length}/${w.installedSkills.length} provider-and-scope installations without an observed invocation. ${w.inventory.directoriesRead} directories read; ${w.inventory.directoriesUnavailable} absent/unreadable. This is a coverage gap, not a recommendation to remove a skill. Codex invocation evidence is a lower bound; project and profile inventories can overlap.`);
  return [commands, skills];
}

const workflowScope = createWorkflowScope();
let lastView = null, lastSnapshot = null, generation = 0;
export function clearWorkflow() { generation += 1; }
export async function renderWorkflow(view, snapshot) {
  const request = ++generation;
  lastView = view; lastSnapshot = snapshot;
  const filter = document.querySelector("#workflow-provider"), container = document.querySelector("#workflow-content");
  if (!filter.dataset.bound) { filter.dataset.bound = "true"; filter.addEventListener("change", () => renderWorkflow(lastView, lastSnapshot)); }
  const selected = view.sessions.filter((s) => filter.value === "all" || s.provider === filter.value);
  let w;
  try {
    const result = workflowScope.get(snapshot, view.sessions, view.repositories.map((r) => r.repository.id), filter.value);
    if (result instanceof Promise) {
      const pending = el("p", "Calculating workflow for this scope…", "workflow-empty"); pending.setAttribute("role", "status");
      container.replaceChildren(pending); container.setAttribute("aria-busy", "true");
      w = await result;
    } else w = result;
  } catch {
    if (request !== generation) return;
    container.replaceChildren(el("p", "Workflow calculation is unavailable. Select the full scope or reload to retry.", "workflow-empty"));
    container.setAttribute("aria-busy", "false"); return;
  }
  if (request !== generation) return;
  const a = w.autonomy, c = w.concurrency;
  container.setAttribute("aria-busy", "false");
  container.replaceChildren();
  container.append(el("p", `${w.coverage.supportedSessions}/${w.coverage.sessions} sessions supported · ${w.coverage.timedSessions} with timing · ${w.coverage.partialSessions} partial · ${w.coverage.humanSessions} with human-turn evidence. Scope follows session start dates; a selected session’s full history is included.`, "evidence-line"));
  if (!w.coverage.supportedSessions) {
    container.append(el("p", selected.length ? "Workflow timing is unavailable for these sessions. Cursor’s local store does not provide the lifecycle evidence needed for these estimates. Choose Claude, Codex, or a wider scope." : "No sessions in this scope. Choose a wider date window or another repository.", "workflow-empty"));
    const grid = el("div", null, "workflow-grid"); grid.append(...inventoryPanels(w)); container.append(grid); return;
  }
  const metrics = el("div", null, "kpi-grid compact-metrics workflow-metrics");
  metrics.append(
    kpi({ label: "Tools per human turn · p50", value: a.toolRuns.p50 === null || a.toolRuns.p50 === undefined ? null : number(a.toolRuns.p50), reason: "No observed tool runs", note: `${a.toolRuns.samples} observed runs · max ${number(a.toolRuns.max)}`, accent: true }),
    kpi({ label: "Turn wall time · p95", value: a.turnWallTime.p95 === null || a.turnWallTime.p95 === undefined ? null : time(a.turnWallTime.p95), reason: "No timed turns", note: `${a.turnWallTime.samples} turns · p50 ${time(a.turnWallTime.p50)}` }),
    kpi({ label: "Effective parallelism", value: c.effectiveParallelism === null ? null : `${c.effectiveParallelism.toFixed(2)}×`, reason: "Needs at least 1 minute of wall time", note: `${time(c.activeSessionMilliseconds)} / ${time(c.wallClockActiveMilliseconds)} session / wall activity` }),
    kpi({ label: "Peak concurrent sessions", value: number(c.peak), note: `${c.eligibleSessions} sessions with positive activity spans` }),
  );
  container.append(metrics);
  const grid = el("div", null, "workflow-grid"); grid.append(concurrencyPanel(w));
  const autonomy = panel("AUTONOMY & TIME", "Between human decisions");
  stats(autonomy, [["Human turns", `${number(a.humanTurns)} / ${w.coverage.humanSessions} sessions`], ["Mean turns per session", a.turnsPerSession === null ? `${DASH} minimum 5 sessions` : number(a.turnsPerSession)], ["Estimated agent activity", time(w.time.activeMilliseconds)], ["Estimated human waiting", time(w.time.waitingForHumanMilliseconds)], ["Idle / unclassified span", time(w.time.unclassifiedMilliseconds)]]);
  note(autonomy, `${a.recordedTurnDurations} provider duration samples + ${a.inferredTurnDurations} event-derived turn spans. Incomplete transcripts contribute observed counters and independent provider durations only; boundary estimates are suppressed. Activity joins gaps ≤5m. Human waiting needs a terminal marker followed by a human and is capped at 30m. Permission waiting is unavailable. Tool runs include zero-tool turns and the final run; child-agent inputs are excluded.`);
  const steering = panel("STEERING", "Interruptions & planning"), i = w.interruptions;
  stats(steering, [["Codex interrupted / replaced / other", `${i.interrupted} / ${i.replaced} / ${i.other}`], ["Claude interrupt markers · P2", i.claudeMarkers === null ? "Not enabled" : `${i.claudeMarkers} · ${w.coverage.contentRuleSessions} sessions`], ["Sub-agent interruptions", number(i.subagentInterrupted)], ["Mid-turn human inputs", number(w.steering.midTurnHumanTurns)], ["Plan-mode entries / Plan items", `${w.steering.planEntries} / ${w.steering.planItems}`], ["Interruptions per human turn", i.perHumanTurn === null ? `${DASH} minimum 5 turns` : i.perHumanTurn.toFixed(2)]]);
  note(steering, `${i.eligibleHumanTurns} eligible turns in ${i.eligibleSessions} sessions, minimum 5 turns. Interrupts can rise with expertise; they are not a failure signal. Plan entries are observations, not plan rejections.`);
  const queue = el("details", null, "evidence"); queue.append(el("summary", "Queue operations and reason classes")); const queueBody = el("div", null, "evidence-body"); stats(queueBody, Object.entries(w.steering.queueOperations).map(([name, count]) => [name, number(count)])); queueBody.append(el("p", Object.entries(w.steering.queueReasons).map(([name, count]) => `${name}: ${count}`).join(" · ") || "No queue reasons recorded.")); queue.append(queueBody); steering.append(queue);
  grid.append(autonomy, steering, heatPanel(w));
  const repos = panel("BY REPOSITORY", "Where parallel work happens");
  const names = new Map(view.repositories.map((r) => [r.repository.id, r.repository.name]));
  table(repos, ["Repository", "Peak", "Parallelism", "Session / wall activity"], w.repositories.slice().sort((a, b) => b.peak - a.peak).map((r) => [[names.get(r.repositoryId) || "Repository", `${r.sessions} supported sessions`], number(r.peak), r.effectiveParallelism?.toFixed(2) ?? DASH, `${time(r.activeSessionMilliseconds)} / ${time(r.wallClockActiveMilliseconds)}`]));
  note(repos, "Each repository has its own wall-clock union. Summing repository wall time would double-count cross-repository concurrency.");
  const shapes = panel("SESSION SHAPE", "Archetypes & open ends");
  stats(shapes, Object.entries(w.archetypes).map(([name, count]) => [name, number(count)]));
  note(shapes, `Abandonment heuristic: ${w.abandonment.flagged}/${w.abandonment.eligible} eligible sessions flagged; ${w.abandonment.ongoing} ongoing; ${w.abandonment.insufficientEvidence} with insufficient evidence. Requires a human, ≥3 tools, an open ending and ≥24h inactivity. This is a flag, not an outcome.`);
  shapes.append(evidence(["Quick: <10m active, ≤2 human turns, ≤10 tools. Deep: ≥1h active, ≥10 turns, or ≥80 tools. Marathon: ≥4h active, ≥30 turns, or ≥300 tools. Otherwise standard. Marathon takes precedence; no positive activity means unavailable. Session length needs a baseline for the same repository and task."], { title: "Archetype thresholds" }));
  grid.append(repos, shapes, mixPanel(w));
  const changes = panel("DESCRIPTIVE COMPARISONS", "Before & after a model or CLI change", true);
  caption(changes, `${w.comparisons.filter((c) => c.status === "eligible").length}/${w.comparisons.length} transitions eligible.`);
  const comparisons = w.comparisons.slice().sort((a, b) => Number(b.status === "eligible") - Number(a.status === "eligible") || b.changedAt.localeCompare(a.changedAt));
  table(changes, ["Transition", "Comparable context", "Before / after sessions", "Turn p50", "Evidence"], comparisons.map((r) => [[`${r.before} → ${r.after}`, `${r.changedAt.slice(0, 10)} · ${r.dimension}`], [names.get(r.repositoryId) || "Repository", `${r.provider} · ${r.archetype} · ${r.effort} · ${r.entrypoint} · ${r.heldConstant}`], `${r.beforeSessions} / ${r.afterSessions}`, `${time(r.beforeTurnP50)} → ${time(r.afterTurnP50)}`, r.status === "eligible" ? r.turnTimeChange === null ? `${DASH} tiny baseline` : `${r.turnTimeChange >= 0 ? "+" : ""}${(r.turnTimeChange * 100).toFixed(0)}% · descriptive` : r.status === "small-cohort" ? "Below minimum" : "Overlapping eras"]), "No stable version transitions with turn timing in this scope. Mixed-model sessions and unknown metadata are excluded.");
  note(changes, "Same repository, provider, archetype, effort, entrypoint and duration evidence; the other model/CLI dimension stays fixed. Each side needs ≥5 sessions with terminal endings within 28 days of the change. Interleaved versions are ineligible. Task difficulty is unknown; a slower turn does not establish a regression.");
  grid.append(changes);
  grid.append(...inventoryPanels(w)); container.append(grid);
  container.append(evidence(["Activity counters describe recorded work. They do not prove success, quality, causation, human time saved or value delivered. Claude parent interaction metrics exclude its child transcripts; existing accounting totals still include them."], { title: "Reading these numbers" }));
}
