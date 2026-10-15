// Subscription view: which accounts can still be used and until when, what to do next, and what the allowances are worth.
// Rendering only; every number comes from subscription-data.js.

import { dayMonth, integer, money, weekdayDate, weekdayTime, wholeMoney, zonedHourKey } from "./format.js";
import { providerColor } from "./chart-colors.js";
import { providerMark } from "./providers.js";
import { chartWidth, dataTable, el, redrawOnResize, DASH } from "./ui.js";
import {
  DAY, HOUR, calibrationMinimum, compareUrgency, extraUsageOff, formatDuration, limitMachines, limitStatus, meterPace, providerNames,
  recommendations, subscriptionModel, valuedMachines, visibleMeters, zonedDayStart,
} from "./subscription-data.js";
import { planFor, plansReviewedAt, subscriptionPlans } from "./subscription-plans.js";
import { machineAge } from "./machines.js";

/** Explanatory paragraphs wrap freely; one-line `.chart-note` captions are reserved for short labels. */
const note = (text, className = "subscription-note") => el("p", text, className);
/** Plan and payer overrides are kept per account key in this browser. */
const planKey = (account) => `session-analytics.subscription-plan.${account}`;
const payerKey = (account) => `session-analytics.subscription-payer.${account}`;
const readSetting = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeSetting = (key, value) => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* Optional. */ } };
/** Disclosure states and inspected chart items by key: a refresh or a plan change never collapses or resets them. */
const opened = new Map();
const inspected = new Map();
let patterns = 0;

const sourceLabels = {
  "codex-account": "Codex account (banked resets)",
  "codex-session": "Codex session records",
  "claude-sdk-log": "Claude Agent SDK events (host logs)",
  "claude-statusline": "Claude Code status line",
};
const toneLabels = { act: "Act now", watch: "Watch", setup: "Setup", good: "Going well" };

function svg(tag, attributes = {}, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Times in the viewer's zone: today's as "14:20", this week's as "Fri 04:00", later ones as "6 Nov". */
function formatters(timeZone, now) {
  const clock = (seconds) => weekdayTime(seconds, timeZone);
  const today = dayMonth(now, timeZone);
  return {
    zone: timeZone,
    time: clock,
    when: (seconds) => dayMonth(seconds, timeZone) === today && Math.abs(seconds - now) < DAY ? clock(seconds).slice(-5)
      : Math.abs(seconds - now) < 6.5 * DAY ? clock(seconds) : dayMonth(seconds, timeZone),
    date: (seconds) => dayMonth(seconds, timeZone),
    day: (seconds) => weekdayDate(seconds, timeZone),
    relative: (seconds) => seconds >= now ? `in ${formatDuration(seconds - now)}` : `${formatDuration(now - seconds)} ago`,
  };
}

const usd = (value) => value === null || value === undefined ? DASH : value >= 10_000 ? `$${Math.round(value / 100) / 10}k` : wholeMoney(value);
/** Multiples keep one decimal below 10×, so 2.5× never reads as 3×. */
const times = (value) => `${value < 10 ? value.toFixed(1) : Math.round(value)}×`;
const percentText = (value) => `${Math.round(value)}%`;
const leftOf = (live) => Math.max(0, 100 - Math.min(100, live.used));
const rate = (value) => `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}%/h`;
const shortPlan = (plan) => plan.label.replace(/^Claude /, "").replace(/ \(seat type unknown\)$/, " seat");
const plural = (count, word) => `${integer(count)} ${word}${count === 1 ? "" : "s"}`;
const names = (list) => list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0] ?? "";

function disclosure(key, summary, { open = false, className = "" } = {}) {
  const details = el("details", null, className);
  details.open = opened.get(key) ?? open;
  const head = el("summary");
  head.dataset.focusKey = `details:${key}`;
  head.append(...(Array.isArray(summary) ? summary : [summary]).map((part) => typeof part === "string" ? el("span", part) : part));
  details.append(head);
  details.addEventListener("toggle", () => opened.set(key, details.open));
  return details;
}

/**
 * A readout under a chart: pointer and arrow keys move between items and the text is announced politely. The inspected
 * item is remembered by `key`, so a refresh keeps it.
 */
function inspectable(svgNode, key, items, identity, describe, position) {
  const readout = el("div", null, "subscription-readout");
  readout.setAttribute("aria-live", "polite");
  svgNode.setAttribute("data-focus-key", `chart:${key}`);
  if (!items.length) return readout;
  const remembered = items.findIndex((item) => identity(item) === inspected.get(key));
  let selected = remembered >= 0 ? remembered : items.length - 1;
  const marker = position.marker;
  const show = (index, remember = true) => {
    selected = Math.max(0, Math.min(items.length - 1, index));
    const item = items[selected];
    if (remember) inspected.set(key, identity(item));
    readout.replaceChildren(...describe(item).map((line, i) => el(i === 0 ? "strong" : "span", line)));
    if (marker) { const x = position.x(item); marker.setAttribute("x1", x); marker.setAttribute("x2", x); marker.setAttribute("visibility", "visible"); }
  };
  svgNode.setAttribute("tabindex", "0");
  svgNode.addEventListener("keydown", (event) => {
    const target = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: items.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault(); show(target);
  });
  svgNode.addEventListener("focus", () => show(selected, false));
  const pointer = (event) => {
    const bounds = svgNode.getBoundingClientRect();
    const width = Number(svgNode.getAttribute("data-width"));
    const x = (event.clientX - bounds.left) * width / bounds.width;
    let best = 0, distance = Infinity;
    items.forEach((item, index) => { const gap = Math.abs(position.x(item) - x); if (gap < distance) { distance = gap; best = index; } });
    show(best);
  };
  svgNode.addEventListener("pointermove", pointer); svgNode.addEventListener("click", pointer);
  show(selected, false);
  return readout;
}

/** Bullet meter: fill = used, hatched extension = projection to the reset, tick = even pace. Stale meters are muted, without pace. */
function track(live, className = "meter-track") {
  const bar = el("div", null, className);
  bar.setAttribute("role", "img");
  if (!live?.cycle) return bar;
  const used = Math.min(100, live.used), fresh = !live.stale && live.state !== "unreported";
  if (!fresh) bar.dataset.stale = "true";
  const fill = el("i", null, "meter-fill"); fill.style.width = `${used}%`;
  bar.append(fill);
  if (fresh && live.state === "active" && live.projected !== null && live.projected !== undefined && live.projected > live.used) {
    const projection = el("i", null, "meter-projection");
    projection.style.left = `${used}%`;
    projection.style.width = `${Math.max(0, Math.min(100, live.projected) - used)}%`;
    bar.append(projection);
  }
  if (fresh && live.state === "active" && live.elapsed !== undefined) {
    const pace = el("i", null, "meter-pace"); pace.style.left = `${live.elapsed * 100}%`; bar.append(pace);
  }
  return bar;
}

const isSession = (live) => live.meter.windowMinutes === 300;

/** When a meter resets, absolute and relative; idle meters say how their next window starts. */
function resetText(live, fmt) {
  if (!live) return "No reading yet";
  if (live.cycle) return `Resets ${fmt.when(live.cycle.resetsAt)} · ${fmt.relative(live.cycle.resetsAt)}`;
  if (live.nextResetAt) return `Resets ${fmt.when(live.nextResetAt)} · ${fmt.relative(live.nextResetAt)}`;
  if (!live.confirmedIdle) return "No reading since the last reset";
  return isSession(live) ? "No window open · your next message starts one" : "Starts with your next request";
}

/** No open cycle: either the provider said the window has not started, or nothing was read here since the last reset. */
function idleSentence(live, fmt) {
  if (live.confirmedIdle) return live.nextResetAt ? `Not used since the last reset. Next reset ${fmt.when(live.nextResetAt)}.` : resetText(live, fmt);
  const since = live.lastResetAt ? ` since the reset ${fmt.when(live.lastResetAt)}` : " since the last reset";
  const next = live.nextResetAt ? ` Next reset ${fmt.when(live.nextResetAt)}, on its fixed weekly schedule.` : "";
  return fmt.read.length > 1 ? `No reading on ${names(fmt.read)}${since}; other machines and the web still move this meter.${next}`
    : `No reading on this machine${since}; other machines and the web still move this meter.${next}`;
}

/** A machine whose limits in use are its last good ones rather than read now, with their age (`aged`) or marked stale. */
function limitsLabel(key, scope, aged = false) {
  const machine = scope.machines.get(key), label = machine?.label ?? key;
  if (!machine || machine.state === "ok") return label;
  return aged ? `${label} (last good limits, ${machineAge(machine.readAt, scope.now * 1000) ?? "an earlier read"})` : `${label} (stale)`;
}

/** The machines whose limits report an account, by label; null when limits are this machine's alone. */
function reportedBy(item, scope) {
  if (!scope.limits || !item.identified) return null;
  return item.account.machines?.length ? `Reported by ${names(item.account.machines.map(({ key }) => limitsLabel(key, scope)))}` : "No machine read now is logged into it; shown from saved history";
}

/** Machines whose limits are in but whose sessions are not, in a sentence. */
const sessionless = (scope) => `${names(scope.sessionless)}'s sessions were not read: ${scope.sessionless.length === 1 ? "its" : "their"} usage moves these meters, but ${scope.sessionless.length === 1 ? "its" : "their"} value is not counted`;

/** One sentence per meter, in plain words. */
function meterSentence(live, fmt, now) {
  if (live.state === "retired") return { text: "The provider no longer reports this meter." };
  if (!live.cycle) return { text: idleSentence(live, fmt) };
  const reset = `resets ${fmt.when(live.cycle.resetsAt)} (${fmt.relative(live.cycle.resetsAt)})`;
  const restarted = live.segment?.before ? ` Restarted in place ${fmt.when(live.segment.start)}.` : "";
  const used = `${percentText(live.used)} used`;
  if (live.state === "unreported") return { text: `${used} at the last report, ${fmt.when(live.observedAt)}. The provider no longer reports this meter.` };
  if (live.levelsOnly) return { text: `${used}; ${reset}. What this meter limits is not documented, so it is shown as a level only, without a projection.` };
  if (live.state === "overage") return { text: `Past the included allowance, on paid extra usage; ${reset}.${restarted}`, tone: "warn" };
  if (live.state === "capped") return { text: `Limit reached ${fmt.when(live.capAt)}; ${reset}.${restarted}`, tone: "danger" };
  if (live.capsEarly) return { text: `${used}. At this pace it runs out ${fmt.when(live.capAt)}, ${formatDuration(live.cycle.resetsAt - live.capAt)} before it ${reset}.${restarted}`, tone: "warn" };
  if (live.burnAt) return { text: `${used} in ${formatDuration(now - live.segment.start)}: at this pace it runs out ${fmt.when(live.burnAt)}, ${formatDuration(live.cycle.resetsAt - live.burnAt)} before it ${reset}. Too early in the window for a projection.${restarted}`, tone: "warn" };
  if (live.mayBeUsedUp) return { text: `${used} at ${fmt.when(live.observedAt)}. The pace before that reaches 100% by now, so it may already be used up; ${reset}.`, tone: "warn" };
  if (live.stale) return { text: `${used} at the last reading, ${fmt.when(live.observedAt)} (${formatDuration(now - live.observedAt)} ago); ${reset}.${restarted}` };
  if (live.projected === null || live.projected === undefined) return { text: `${used}; ${live.tooEarly ? "too early in the window to project" : "levels only, no projection"}; ${reset}.${restarted}` };
  return { text: `${used}; on pace to close near ${percentText(Math.min(100, live.projected))}; ${reset}.${restarted}` };
}

function meterRow(live, fmt, now) {
  const row = el("div", null, "meter-row");
  const head = el("div", null, "meter-head");
  // A level the provider stopped reporting, or that is old, is not live capacity: it is muted, and an unreported one says when it was seen.
  const value = live.state === "unreported" ? `last seen ${fmt.when(live.observedAt)}` : live.cycle ? `${percentText(leftOf(live))} left` : live.confirmedIdle ? "100% left" : DASH;
  if (live.state === "unreported" || live.stale || (!live.cycle && !live.confirmedIdle)) row.dataset.stale = "true";
  head.append(el("span", live.meter.label.replace(" · all models", ""), "meter-name"), el("span", value, "meter-value"));
  const bar = track(live);
  const { text, tone } = meterSentence(live, fmt, now);
  const status = el("p", text, "meter-status");
  if (tone) status.dataset.tone = tone;
  bar.setAttribute("aria-label", `${live.meter.label}: ${text}`);
  row.append(head, bar, status);
  return row;
}

function statusText(status, fmt, now) {
  const session = status.meter === "session";
  return {
    capped: () => `${session ? "5-hour limit capped" : "Capped"} until ${fmt.when(status.until)}`,
    overage: () => "Using extra usage",
    "runs-out": () => `${session ? "5-hour limit runs" : "Runs"} out ${fmt.when(status.at)} · ${formatDuration(status.early)} early`,
    "early-burn": () => session ? `5-hour limit runs out ${fmt.when(status.at)} at this pace`
      : `${percentText(status.used)} used in ${formatDuration(now - status.since)} · runs out ${fmt.when(status.at)} at this pace`,
    "may-be-used-up": () => "May be used up",
    stale: () => `Last seen ${formatDuration(now - status.since)} ago`,
    "too-early": () => "Too early to tell",
    "on-track": () => "On track",
    idle: () => status.confirmed ? "Not used this week" : "No reading this week",
    "levels-only": () => "Levels only",
  }[status.kind]();
}

/** One row per account: weekly and 5-hour bars, % left, the reset and one status. */
function limitRow(item, status, fmt, now, scope) {
  const row = el("li", null, "limit-row");
  row.dataset.tone = status.tone;
  row.style.setProperty("--meter-color", providerColor(item.provider));
  const { weekly, session } = visibleMeters(item);
  const name = el("div", null, "limit-account"), title = el("span", null, "limit-account-name"), machines = reportedBy(item, scope);
  title.append(el("strong", item.label));
  if (machines) title.append(el("small", machines.replace(/^Reported by /, ""), "limit-machines"));
  name.append(providerMark(item.provider), title);
  const bars = el("div", null, "limit-bars");
  // A weekly cap blocks the account whatever its 5-hour window says; extra usage does not.
  const blocked = weekly?.cycle && weekly.state === "capped" ? weekly.cycle.resetsAt : null;
  const line = (live, label, thin) => {
    const meter = el("div", null, `limit-meter${thin ? " thin" : ""}`);
    const bar = track(live, `meter-track${thin ? " thin" : ""}`);
    if (thin && blocked !== null) bar.dataset.stale = "true";
    bar.setAttribute("aria-label", `${label}: ${live?.cycle ? `${percentText(live.used)} used, ${percentText(leftOf(live))} left` : live?.confirmedIdle ? "not started" : "no reading since the last reset"}. ${resetText(live, fmt)}.`);
    meter.append(el("span", label, "limit-meter-name"), bar);
    return meter;
  };
  bars.append(line(weekly, "Weekly", false));
  if (session) {
    bars.append(line(session, "5-hour", true));
    bars.append(el("p", blocked !== null ? `5-hour: blocked by the weekly cap until ${fmt.when(blocked)}`
      : session.cycle ? `5-hour: ${percentText(leftOf(session))} left · resets ${fmt.when(session.cycle.resetsAt)}` : session.confirmedIdle ? "5-hour: no window open" : "5-hour: no reading since the last window", "limit-session"));
  }
  // Nothing local says what Claude's weekly meter including extra usage limits; near full on extra usage, it is worth a look.
  const overageMeter = weekly?.state === "overage" ? item.live.find((live) => live.levelsOnly && live.cycle && live.state !== "unreported" && live.used >= 90) : null;
  if (overageMeter) bars.append(el("p", `${overageMeter.meter.label}: ${percentText(overageMeter.used)} used; what happens at 100% is not documented`, "limit-session"));
  const left = el("div", null, "limit-left");
  left.append(el("strong", weekly?.cycle ? percentText(leftOf(weekly)) : weekly?.confirmedIdle ? "100%" : DASH), el("span", "left this week"));
  if (weekly?.stale || weekly?.state === "unreported" || (weekly && !weekly.cycle && !weekly.confirmedIdle)) left.dataset.stale = "true";
  const chip = el("span", statusText(status, fmt, now), "status-chip");
  chip.dataset.tone = status.tone;
  // On wide screens the reset and the status are grid columns; narrower, they share one wrapping line.
  const when = el("div", null, "limit-when");
  when.append(el("p", resetText(weekly, fmt), "limit-reset"), chip);
  row.append(name, bars, left, when);
  return row;
}

function limitsNow(entries, fmt, now, generatedAt, scope) {
  const section = el("section", null, "panel limits-now");
  section.setAttribute("aria-labelledby", "limits-now-title");
  const header = el("header");
  const title = el("h3", "Limits now"); title.id = "limits-now-title";
  const aged = [...scope.machines.keys()].filter((key) => scope.counted.has(key)).map((key) => limitsLabel(key, scope, true)).join(" + ");
  const from = scope.limits ? ` · ${scope.sessionless.length ? `meters from ${aged}, value from ${scope.value.join(" + ")} (${names(scope.sessionless)}: sessions not read)` : `meters and value from ${aged}`}`
    + `${scope.pending.length ? `; reading ${names(scope.pending)}` : ""}${scope.unread.length ? `; ${names(scope.unread)} not read` : ""}` : "";
  header.append(title, el("span", `Read ${generatedAt ? fmt.when(generatedAt) : "now"} · refreshes every 2 minutes · times in ${fmt.zone}${from}`, "panel-meta"));
  section.append(header);
  const list = el("ol", null, "limit-rows");
  for (const { item, status } of entries) list.append(limitRow(item, status, fmt, now, scope));
  section.append(list);
  return section;
}

/** At most three suggestions, one line each; the reasoning opens under "Why?". */
function nextActions(advice) {
  const section = el("section", null, "panel subscription-next");
  section.setAttribute("aria-labelledby", "subscription-next-title");
  const title = el("h3", "Next"); title.id = "subscription-next-title";
  section.append(title);
  // Open state and focus follow the suggestion, not its rank, which changes between refreshes.
  const seen = new Map();
  const keyOf = (entry) => {
    const key = `why:${entry.kind}:${entry.provider ?? ""}:${entry.account ?? ""}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count > 1 ? `${key}:${count}` : key;
  };
  const item = (entry) => {
    const row = el("li", null, "next-item");
    row.dataset.tone = entry.tone;
    const details = disclosure(keyOf(entry), [el("span", toneLabels[entry.tone], "next-tone"), ...(entry.provider ? [providerMark(entry.provider)] : []), el("span", entry.title, "next-title"), el("span", "Why?", "next-why")]);
    details.append(el("p", entry.detail));
    row.append(details);
    return row;
  };
  if (!advice.length) { section.append(note("Nothing needs attention: no account is on course to run out early or to leave much of its week unused.")); return section; }
  const list = el("ol", null, "next-list");
  for (const entry of advice.slice(0, 3)) list.append(item(entry));
  section.append(list);
  if (advice.length > 3) {
    const more = disclosure("next-more", `${advice.length - 3} more suggestion${advice.length === 4 ? "" : "s"}`, { className: "next-more" });
    const rest = el("ol", null, "next-list");
    for (const entry of advice.slice(3)) rest.append(item(entry));
    more.append(rest);
    section.append(more);
  }
  return section;
}

const segmentOf = (cycle, sample) => cycle.segments.find((segment) => segment.samples.includes(sample)) ?? cycle.segments[0];

/** Current weekly cycle: each segment its own line, an in-place reset marked where it happened, the projection from now. */
function burnChart(container, item, fmt, now) {
  const live = item.weekly;
  container.replaceChildren();
  if (!live?.cycle) { container.append(note(live ? idleSentence(live, fmt) : "No weekly cycle open: your next request starts one.")); return; }
  const cycle = live.cycle, width = chartWidth(container, 520, 260), height = 168, left = 36, right = 12, top = 12, bottom = 24;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const x = (t) => left + (t - cycle.start) / Math.max(1, cycle.resetsAt - cycle.start) * plotWidth;
  const y = (value) => top + (1 - Math.min(100, value) / 100) * plotHeight;
  const color = providerColor(item.provider);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, "data-width": width, role: "group", class: "subscription-chart", "aria-label": `${item.label}, current week: ${percentText(live.used)} used, ${Math.round((live.elapsed ?? 0) * 100)}% of the time to the reset gone. Use Left and Right to inspect readings.` });
  for (const tick of [0, 50, 100]) {
    root.append(svg("line", { x1: left, x2: width - right, y1: y(tick), y2: y(tick), class: tick === 100 ? "limit-line" : "grid-line" }));
    root.append(svg("text", { x: left - 6, y: y(tick) + 4, "text-anchor": "end", class: "axis-label" }, `${tick}%`));
  }
  // Day ticks at local midnights in the display zone, so a reading sits over the day it was taken.
  const step = plotWidth < 300 ? 3 : plotWidth < 420 ? 2 : 1;
  const midnights = [];
  for (let t = cycle.start; t <= cycle.resetsAt + DAY; t += DAY / 2) {
    const midnight = zonedDayStart(zonedHourKey(t, fmt.zone).split("|")[0], fmt.zone);
    if (midnight >= cycle.start && midnight <= cycle.resetsAt && midnight !== midnights.at(-1)) midnights.push(midnight);
  }
  midnights.forEach((t, index) => {
    if (index % step) return;
    root.append(svg("line", { x1: x(t), x2: x(t), y1: top + plotHeight, y2: top + plotHeight + 3, class: "grid-line" }));
    root.append(svg("text", { x: Math.max(left, Math.min(width - right, x(t))), y: height - 6, "text-anchor": x(t) - left < 20 ? "start" : width - right - x(t) < 20 ? "end" : "middle", class: "axis-label" }, fmt.day(t)));
  });
  const segment = live.segment;
  if (!live.stale) root.append(svg("line", { x1: x(segment.start), y1: y(0), x2: x(cycle.resetsAt), y2: y(100), class: "pace-line" }));
  for (const part of cycle.segments) {
    const shown = part.samples.filter((sample) => sample.t <= now);
    if (part.before) {
      root.append(svg("line", { x1: x(part.start), x2: x(part.start), y1: top, y2: top + plotHeight, class: "reset-marker" }));
      root.append(svg("text", { x: x(part.start) + 4, y: top + 10, class: "axis-label reset-label" }, "reset"));
    }
    if (shown.length) root.append(svg("path", { d: shown.map((sample, index) => `${index ? "L" : "M"}${x(sample.t).toFixed(1)},${y(sample.used).toFixed(1)}`).join(" "), class: "used-line", stroke: color }));
  }
  const points = cycle.samples.filter((sample) => sample.t <= now);
  const last = points.at(-1);
  if (live.state === "active" && !live.stale && live.projected !== null && live.projected !== undefined && last) {
    const endT = live.capsEarly ? live.capAt : cycle.resetsAt;
    root.append(svg("path", { d: `M${x(now)},${y(live.used)} L${x(endT)},${y(live.capsEarly ? 100 : live.projected)}`, class: "projection-line", stroke: color }));
  }
  if (last) root.append(svg("circle", { cx: x(last.t), cy: y(last.used), r: 3.5, fill: color, class: "end-dot" }));
  root.append(svg("line", { x1: x(now), x2: x(now), y1: top, y2: top + plotHeight, class: "now-line" }));
  const marker = svg("line", { x1: 0, x2: 0, y1: top, y2: top + plotHeight, class: "inspect-line", visibility: "hidden" });
  root.append(marker);
  const readout = inspectable(root, `burn:${item.key}`, points, (sample) => sample.t, (sample) => {
    const part = segmentOf(cycle, sample);
    return [
      `${fmt.time(sample.t)} · ${percentText(sample.used)} used`,
      `Even pace by then: ${Math.round(Math.min(1, Math.max(0, (sample.t - part.start) / (cycle.resetsAt - part.start))) * 100)}%`,
      sample.status === "rejected" ? "Requests refused on this meter" : sample.status === "overage" ? "On paid extra usage" : "",
    ].filter(Boolean);
  }, { x: (sample) => x(sample.t), marker });
  const key = el("p", null, "chart-key");
  key.append(el("span", "Used", "key-used"), el("span", "Projection", "key-projection"), el("span", "Even pace", "key-pace"), el("span", "Now", "key-now"));
  if (cycle.segments.length > 1) key.append(el("span", "In-place reset", "key-reset"));
  key.style.setProperty("--meter-color", color);
  const pace = meterPace(live, now);
  const paceText = live.stale || live.state !== "active" || !pace ? null
    : `Pace ≈ ${rate(pace.segment)}${cycle.segments.length > 1 ? ` since the reset ${fmt.when(segment.start)}, ${rate(pace.cycle)} across the week` : " this week"}${pace.budget !== null ? `; up to ${rate(pace.budget)} lasts until the reset.` : "."}`;
  container.append(root, key, readout);
  if (paceText) container.append(note(paceText, "subscription-note chart-pace"));
}

function planControl(item, onChange) {
  const label = el("label", null, "plan-chip");
  label.append(el("span", `Plan for ${item.label}`, "sr-only"));
  const select = el("select");
  select.dataset.focusKey = `plan:${item.key}`;
  const option = (value, text) => { const choice = el("option", text); choice.value = value; select.append(choice); };
  const detected = planFor(item.provider, item.account.plan);
  option("", detected ? `${shortPlan(detected)} · detected` : "Plan not detected");
  for (const plan of subscriptionPlans[item.provider]) option(plan.id, `${shortPlan(plan)}${plan.monthlyUsd !== null ? ` · $${plan.monthlyUsd}/mo` : ""}${plan.payer === "organization" ? " · employer seat" : ""}`);
  option("none", "Exclude from value totals");
  select.value = readSetting(planKey(item.key)) ?? "";
  select.addEventListener("change", () => { writeSetting(planKey(item.key), select.value); onChange?.(); });
  label.append(select);
  return label;
}

/** Banked resets, credits, extra usage and recent resets of one account. */
function accountFacts(item, fmt, now, codexAccount) {
  const list = el("dl", null, "subscription-facts account-facts");
  const fact = (term, value, detail) => { const row = el("div"); row.append(el("dt", term), el("dd", value)); if (detail) row.append(el("small", detail)); list.append(row); };
  const banked = item.resets;
  if (item.provider === "codex" && !banked.known && codexAccount !== "ok") fact("Banked resets", DASH, codexAccount === "off" ? "Not read (turned off or offline)" : "The Codex app-server did not answer");
  else if (banked.known || banked.available) {
    const next = banked.credits.find((credit) => credit.expiresAt !== null);
    fact("Banked resets", String(banked.available), banked.available
      ? `${next ? `Next expires ${fmt.when(next.expiresAt)} (${fmt.relative(next.expiresAt)})` : "No expiry reported"}${banked.nowValue(banked.credits[0]) !== null ? ` · redeeming now restores ≈ ${usd(banked.nowValue(banked.credits[0]))}` : ""}`
      : "None available");
  }
  const credits = item.account.codex?.credits;
  if (credits) fact("Credit balance", credits.unlimited ? "Unlimited" : credits.balance !== null ? integer(Math.round(credits.balance)) : DASH, "Codex credits, used after the included allowance runs out");
  const extra = item.account.extraUsage;
  if (extra) {
    const label = { enabled: "On", "in-use": "In use", disabled: "Off", unknown: "Unknown" }[extra.extraUsage];
    fact("Extra usage", label, extra.extraUsage === "disabled" ? `${extraUsageOff(item)}: a cap means waiting for the reset` : "Billed at API rates past a limit");
  }
  const inPlace = (reset) => ({ term: reset.cause === "credit" ? "Banked reset redeemed" : "Restarted in place", at: reset.at, restored: reset.restored, restoredUsd: reset.restoredUsd });
  const resets = item.history.flatMap((cycle) => [
    ...cycle.inPlace.map(inPlace),
    ...(cycle.endedEarly ? [{ term: cycle.cause === "credit" ? "Banked reset redeemed" : "Reset early", at: cycle.end, restored: cycle.restored, restoredUsd: cycle.restoredUsd }] : []),
  ]).concat(item.restarts.map(inPlace)).filter((reset) => reset.at >= now - 30 * DAY).sort((left, right) => left.at - right.at).slice(-2);
  for (const reset of resets) {
    fact(reset.term, fmt.date(reset.at), reset.restored !== null ? `Gave back ${percentText(reset.restored)} of a week${reset.restoredUsd !== null ? ` (≈ ${usd(reset.restoredUsd)})` : ""}` : "The level before it was not observed");
  }
  return list.childElementCount ? list : null;
}

function accountCard(item, status, fmt, now, { onPlanChange, codexAccount, later, scope }) {
  const card = el("article", null, "panel subscription-card");
  card.style.setProperty("--meter-color", providerColor(item.provider));
  card.dataset.account = item.key;
  if (item.excluded) card.dataset.excluded = "true";
  const header = el("header", null, "subscription-card-header");
  const title = el("h3"); title.append(providerMark(item.provider), el("span", item.label));
  header.append(title);
  if (item.identified) header.append(planControl(item, onPlanChange));
  card.append(header);
  const machines = reportedBy(item, scope);
  if (machines) card.append(el("p", machines, "subscription-card-machines"));
  if (item.excluded) card.append(note("Excluded from value totals. Its limits still show here; choose a plan above to include it again."));
  if (!item.identified) card.append(note(item.account.attribution === "weekly-phase"
    ? "Readings whose session was not found in any profile, grouped by weekly reset time. Shown as reported, without pace, value or advice."
    : "Readings that could not be tied to an account. Shown as reported, without pace, value or advice."));
  const { weekly, session, extra } = visibleMeters(item);
  const meters = el("div", null, "meter-list");
  for (const live of [weekly, session]) if (live) meters.append(meterRow(live, fmt, now));
  if (!weekly && !session && !extra.length) meters.append(note("No limit readings yet."));
  card.append(meters);
  if (extra.length) {
    const scoped = extra.every((live) => live.meter.meter.includes(".") || /_(opus|sonnet)$/.test(live.meter.meter));
    const more = disclosure(`limits:${item.key}`, `${scoped ? "Model-specific limits" : "Other limits"} · ${extra.length}`, { className: "more-limits" });
    const list = el("div", null, "meter-list");
    for (const live of extra) list.append(meterRow(live, fmt, now));
    more.append(list);
    card.append(more);
  }
  if (!item.identified) return card;
  if (weekly) {
    const chart = el("div", null, "burn-chart");
    card.append(el("h4", "This week"), chart);
    later.push(() => { burnChart(chart, item, fmt, now); redrawOnResize(chart, () => burnChart(chart, item, fmt, now)); });
  }
  const facts = accountFacts(item, fmt, now, codexAccount);
  if (facts) card.append(facts);
  return card;
}

/** Labels of the machines whose limits report the account and were read. */
const accountMachines = (item, scope) => (item.account.machines ?? []).filter(({ key }) => scope.valued.has(key)).map(({ key }) => scope.machines.get(key)?.label ?? key);

const valueScope = (item, scope) => scope.limits ? ({
  profiles: `${plural(item.value.sessions, "session")} in these dates, in this account's profiles on ${names(accountMachines(item, scope))}`,
  provider: `${plural(item.value.sessions, `${providerNames[item.provider]} session`)} on ${names(accountMachines(item, scope))} in these dates; the only ${providerNames[item.provider]} account there`,
  none: "no sessions matched, so its value is unknown",
})[item.value.basis] : ({
  profiles: `${plural(item.value.sessions, "session")} in these dates, in this account's profiles${scope.others.length ? ` on ${scope.label}` : ""}`,
  provider: `${scope.label}'s ${plural(item.value.sessions, `${providerNames[item.provider]} session`)} in these dates; the only ${providerNames[item.provider]} account`,
  none: "no sessions matched, so its value is unknown",
})[item.value.basis];

/** The plan and who pays for it; a listed price can be marked as paid by you or by an employer. */
function payerControl(item, onChange) {
  const plan = item.economics.plan;
  if (!plan) return { text: item.excluded ? "Excluded" : "No plan", detail: item.excluded ? "left out of the totals" : "choose one on the card" };
  if (plan.monthlyUsd === null) return { text: shortPlan(plan), detail: plan.payer === "organization" ? "employer pays · no list price" : "no list price" };
  const cell = el("div", null, "plan-cell");
  const select = el("select");
  select.dataset.focusKey = `payer:${item.key}`;
  select.setAttribute("aria-label", `Who pays for ${item.label}`);
  for (const [value, text] of [["individual", "You pay"], ["organization", "Employer pays"]]) { const choice = el("option", text); choice.value = value; select.append(choice); }
  select.value = item.economics.payer ?? plan.payer;
  select.addEventListener("change", () => { writeSetting(payerKey(item.key), select.value === plan.payer ? null : select.value); onChange?.(); });
  cell.append(el("span", `${shortPlan(plan)} · $${plan.monthlyUsd}/mo`), select);
  return cell;
}

/** Whether an account's counted period starts at its first meter reading rather than at the start of the selected dates. */
const firstReadingStart = (item) => item.period.firstReading !== null && item.period.from <= item.period.firstReading + 60;

/**
 * The dates value is counted over: from each account's first reading or the start of the range, whichever is later (shared
 * by provider when it can be), to the end of the range, or now.
 */
function periodText(items, fmt, now) {
  if (!items.length) return "No account has readings in these dates";
  const end = Math.max(...items.map((item) => item.period.to));
  // The range ends at the start of the day after it.
  const until = end >= now - HOUR ? "to now" : `to ${fmt.date(end - 1)}`;
  const starts = new Set(items.map((item) => fmt.date(item.period.from)));
  if (starts.size === 1) return `${[...starts][0]} ${until}`;
  const byProvider = ["claude", "codex"].map((provider) => [provider, items.filter((item) => item.provider === provider)]);
  const dates = (list) => new Set(list.map((item) => fmt.date(item.period.from)));
  // A provider's start is its first reading only when every account of it starts there, not at the start of the dates.
  return byProvider.every(([, list]) => dates(list).size <= 1)
    ? `${byProvider.filter(([, list]) => list.length).map(([provider, list]) => `${providerNames[provider]} since ${[...dates(list)][0]}${list.every(firstReadingStart) ? " (first reading)" : ""}`).join(", ")}, ${until}`
    : `Since each account's first reading or the start of these dates (see Since below), ${until}`;
}

/** Value per account and totals that compare like with like; secondary, so it starts open only on wide screens. */
function worthSection(model, items, fmt, now, { pending, onPlanChange, wide, scope }) {
  const section = el("section", null, "panel subscription-worth");
  const details = disclosure("worth", [el("h3", "What it's worth"), el("span", "API-equivalent value of each allowance, from your own sessions", "panel-meta")], { open: wide, className: "section-disclosure" });
  section.append(details);
  if (pending) { details.append(note("Calibrating from history… Value appears when the session scan finishes; the limits above are already live.")); return section; }
  const accounts = items.filter((item) => item.identified);
  if (!accounts.length) { details.append(note("No account to value yet.")); return section; }
  const { totals } = model, elsewhere = model.elsewhere.claude + model.elsewhere.codex;
  const totalsList = el("dl", null, "worth-totals");
  const total = (term, value, detail) => { const row = el("div"); row.append(el("dt", term), el("dd", value), el("small", detail)); totalsList.append(row); };
  const counted = accounts.filter((item) => !item.excluded && item.economics.extracted !== null && item.period.days > 0);
  const pricedNames = counted.filter((item) => item.economics.price !== null && item.economics.monthlyPrice > 0).map((item) => item.label);
  total("Value used", usd(totals.extracted), [
    `${periodText(counted, fmt, now)}, matched to accounts`,
    totals.capacityUsed !== null ? `${percentText(totals.capacityUsed * 100)} of one full week every week${totals.capacityUsed > 1 ? " (early resets and extra usage add more)" : ""}` : "",
    totals.beforeReadings >= 1 ? `${usd(totals.beforeReadings)} before the first meter readings is not counted` : "",
    totals.unattributed ? `${usd(totals.unattributed)} more matched no account` : "",
    scope.sessionless.length ? sessionless(scope) : "",
    elsewhere < 1 ? "" : scope.limits ? `${usd(elsewhere)} on ${names([...scope.unread, ...scope.pending]) || "other machines"} is not counted: ${scope.unread.length + scope.pending.length === 1 ? "its" : "their"} limits ${scope.unread.length ? "could not be read" : "are still being read"}`
      : `${usd(elsewhere)} on ${names(scope.others) || "other machines"} is not counted: limits are read on ${scope.label} only`,
  ].filter(Boolean).join("; "));
  total("Value multiple", totals.priced.multiple !== null ? times(totals.priced.multiple) : DASH,
    totals.priced.multiple !== null ? `${usd(totals.priced.extracted)} for ${usd(totals.priced.price)} of plan price: ${pricedNames.join(", ")}` : "Needs a plan you pay for with matched value");
  // Like the value multiple: the headline is the plans you pay for, compared with their price; other seats are beside it.
  const others = totals.otherMonthlyPotential !== null ? `${usd(totals.otherMonthlyPotential)} on employer-paid or unpriced seats` : "";
  const banked = totals.banked ? `banked resets add up to ${usd(totals.banked)}` : "";
  total("A month of full use", usd(totals.monthlyPotential ?? totals.otherMonthlyPotential),
    totals.monthlyPotential !== null ? [`On plans you pay for: ${times(totals.potentialMultiple)} their ${usd(totals.monthlyPrice)} a month`, others && `plus ${others}`, banked].filter(Boolean).join("; ")
      : totals.otherMonthlyPotential !== null ? [`On employer-paid or unpriced seats; no plan you pay for is calibrated`, banked].filter(Boolean).join("; ")
      : "Needs two weekly cycles with matched sessions");
  total("Typical week closes at", totals.resetsUsed !== null ? percentText(totals.resetsUsed) : DASH, totals.resetsUsed !== null ? "Observed weekly closes, plus this week's projection" : "Needs a weekly reset whose close was observed");
  details.append(totalsList);
  const rows = accounts.map((item) => {
    const { economics: value, calibration, period } = item;
    const empty = period.days <= 0;
    return [
      { text: item.label, detail: empty ? `First reading ${period.firstReading !== null ? fmt.date(period.firstReading) : "not yet"} · no days in these dates` : `Since ${fmt.date(period.from)}${firstReadingStart(item) ? " (first reading)" : ""} · ${Math.round(period.days * 10) / 10} days${item.excluded ? " · excluded" : ""}` },
      payerControl(item, onPlanChange),
      calibration.perPercent !== null ? { text: money(calibration.perPercent), detail: `median of ${plural(calibration.cycles, "cycle")}` }
        : { text: DASH, detail: `needs ${calibrationMinimum} cycles (${calibration.cycles} so far)` },
      { text: usd(value.weeklyCapacity), detail: value.weeklyCapacity !== null ? "a full week" : "" },
      empty ? { text: DASH, detail: "no meter readings in these dates" }
        : value.extracted !== null ? { text: usd(value.extracted), detail: valueScope(item, scope) } : { text: "Unknown", detail: valueScope(item, scope) },
      value.multiple !== null ? { text: times(value.multiple), detail: `for ${usd(value.price)} of plan price` }
        : { text: DASH, detail: empty ? "no meter readings in these dates" : value.payer === "organization" ? "employer pays: value only" : value.monthlyPrice === 0 ? "free plan" : value.plan?.monthlyUsd === null ? "no list price" : value.plan ? "no matched value" : "choose a plan" },
    ];
  });
  details.append(dataTable([
    { text: "Account", align: "left" }, { text: "Plan", align: "left" }, "Per 1% of the week", "Weekly capacity", "Value used", "Value multiple",
  ], rows, { rowHeader: true, className: "worth-table", caption: "Value per account" }));
  const aside = [
    totals.organization.extracted ? `${usd(totals.organization.extracted)} on employer-paid seats` : "",
    totals.unpriced.extracted ? `${usd(totals.unpriced.extracted)} on plans without a price` : "",
  ].filter(Boolean);
  const excluded = items.filter((item) => item.excluded).map((item) => item.label);
  details.append(note([
    "The value multiple divides only the value of plans you pay for by their price, prorated from each account's first reading to now.",
    aside.length ? `Not in the multiple: ${aside.join(" and ")}.` : "",
    excluded.length ? `Excluded from totals: ${excluded.join(", ")}.` : "",
    "Value before an account's first meter reading is not counted, because no price or capacity can be prorated over it.",
  ].filter(Boolean).join(" ")));
  return section;
}

/** A diagonal hatch in the account's colour: early resets, never grey (grey is Codex's own colour). */
function hatch(root, color) {
  const id = `subscription-hatch-${patterns += 1}`;
  const defs = svg("defs"), pattern = svg("pattern", { id, width: 5, height: 5, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  pattern.append(svg("rect", { width: 5, height: 5, fill: color, "fill-opacity": 0.16 }), svg("line", { x1: 1, y1: 0, x2: 1, y2: 5, stroke: color, "stroke-width": 2 }));
  defs.append(pattern); root.append(defs);
  return `url(#${id})`;
}

/** Weekly closes of every account on one time axis: filled when closed, hatched when reset early, outlined when the close was not observed. */
function closesChart(container, rows, fmt, now) {
  container.replaceChildren();
  if (!rows.length) { container.append(note("No weekly meter readings yet.")); return; }
  const cycles = rows.map((item) => [
    ...item.history.slice(-12).map((cycle) => ({ ...cycle, at: cycle.endedEarly ? cycle.end : cycle.resetsAt, live: false, item })),
    ...(item.weekly?.cycle ? [{ at: item.weekly.cycle.resetsAt, resetsAt: item.weekly.cycle.resetsAt, peak: Math.min(100, item.weekly.used), projected: Math.min(100, item.weekly.projected ?? item.weekly.used), live: true,
      capped: item.weekly.state === "capped" || item.weekly.capsEarly, cappedNow: item.weekly.state === "capped", capAt: item.weekly.capAt, endedEarly: false, lowerBound: false, inPlace: item.restarts, item,
      // Past the allowance on paid extra usage, as the card says: since the first reading on it in this segment.
      overageSince: item.weekly.state === "overage" ? item.weekly.segment.samples.find((sample) => sample.status === "overage")?.t ?? item.weekly.observedAt : null }] : []),
  ]);
  const all = cycles.flat();
  if (!all.length) { container.append(note("No weekly resets observed yet.")); return; }
  const width = chartWidth(container, 1040, 280), left = 36, right = 14;
  const from = Math.min(...all.map((cycle) => cycle.at)) - 4 * DAY, to = Math.max(...all.map((cycle) => cycle.at)) + 2 * DAY;
  const x = (t) => left + (t - from) / (to - from) * (width - left - right);
  const barWidth = Math.max(3, Math.min(14, (width - left - right) / ((to - from) / (7 * DAY)) * 0.3));
  rows.forEach((item, index) => {
    const lane = cycles[index];
    const lastLane = index === rows.length - 1, height = lastLane ? 92 : 72, top = 8, base = 64;
    const y = (value) => top + (1 - value / 100) * (base - top);
    const color = providerColor(item.provider);
    const block = el("div", null, "history-lane");
    const label = el("p", null, "lane-label"); label.append(providerMark(item.provider), el("span", item.label));
    const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, "data-width": width, role: "group", class: "subscription-chart", "aria-label": `${item.label}: how full each weekly allowance was when it reset. Use Left and Right to inspect.` });
    const fillEarly = hatch(root, color);
    for (const tick of [0, 100]) {
      root.append(svg("line", { x1: left, x2: width - right, y1: y(tick), y2: y(tick), class: tick === 100 ? "limit-line" : "grid-line" }));
      root.append(svg("text", { x: left - 6, y: y(tick) + 4, "text-anchor": "end", class: "axis-label" }, `${tick}%`));
    }
    for (const cycle of lane) {
      const cx = x(cycle.at), rect = (level, attributes) => svg("rect", { x: cx - barWidth / 2, y: y(level), width: barWidth, height: Math.max(1, y(0) - y(level)), rx: 2, ...attributes });
      if (cycle.live) {
        root.append(rect(cycle.projected, { class: "bar-projected", stroke: color }), rect(cycle.peak, { fill: color, "fill-opacity": 0.55 }));
      } else if (cycle.endedEarly) root.append(rect(cycle.peak, { fill: fillEarly, class: "bar-early", stroke: color }));
      else if (cycle.lowerBound) root.append(rect(cycle.peak, { class: "bar-unobserved", stroke: color }));
      else root.append(rect(cycle.peak, { fill: color }));
      if (cycle.capped) root.append(svg("circle", { cx, cy: y(100) - 5, r: 3, class: "capped-dot" }));
    }
    if (lastLane) {
      const step = Math.max(7 * DAY, Math.ceil((to - from) / DAY / Math.max(2, Math.floor((width - left - right) / 70))) * DAY);
      for (let t = from + 2 * DAY; t < to; t += step) root.append(svg("text", { x: x(t), y: height - 6, "text-anchor": "middle", class: "axis-label" }, fmt.date(t)));
    }
    root.append(svg("line", { x1: x(now), x2: x(now), y1: top, y2: y(0), class: "now-line" }));
    const marker = svg("line", { x1: 0, x2: 0, y1: top, y2: y(0), class: "inspect-line", visibility: "hidden" });
    root.append(marker);
    const readout = inspectable(root, `closes:${item.key}`, lane, (cycle) => `${cycle.live}|${cycle.resetsAt}`, (cycle) => cycle.live ? [
      `This week · resets ${fmt.when(cycle.resetsAt)}`,
      cycle.cappedNow ? `Used up since ${fmt.when(cycle.capAt)}` : cycle.overageSince !== null ? `Past the included allowance, on paid extra usage since ${fmt.when(cycle.overageSince)}` : `${percentText(cycle.peak)} used so far${cycle.projected > cycle.peak ? `; on pace for ${percentText(cycle.projected)}` : ""}${cycle.capped ? "; runs out before the reset" : ""}`,
    ] : [
      `${cycle.endedEarly ? `Reset early ${fmt.date(cycle.end)}` : `Reset ${fmt.date(cycle.resetsAt)}`} · closed at ${percentText(cycle.peak)}${cycle.lowerBound ? " or more" : ""}`,
      cycle.endedEarly
        ? cycle.restored !== null ? `${cycle.cause === "credit" ? "Banked reset redeemed" : "Reset before its schedule"}: gave back ${percentText(cycle.restored)} of a week${cycle.restoredUsd !== null ? ` (≈ ${usd(cycle.restoredUsd)})` : ""}` : "Reset before its schedule; the level at the reset was not observed"
        : cycle.expired !== null ? `${percentText(cycle.expired)} expired unused${cycle.expiredUsd !== null ? ` (≈ ${usd(cycle.expiredUsd)} of API value)` : ""}` : "The last reading came long before the reset, so how much went unused is unknown",
      ...cycle.inPlace.map((reset) => `${reset.cause === "credit" ? "Banked reset redeemed" : "Restarted in place"} ${fmt.when(reset.at)}${reset.restored !== null ? `, giving back ${percentText(reset.restored)}` : ""}`),
      cycle.capped ? `Hit the limit; locked out for ${formatDuration(cycle.lockedSeconds)}` : "",
    ].filter(Boolean), { x: (cycle) => x(cycle.at), marker });
    block.append(label, root, readout);
    container.append(block);
  });
  const key = el("p", null, "chart-key history-key");
  key.append(el("span", "Closed", "key-closed"), el("span", "Reset early", "key-early"), el("span", "Close not observed", "key-unobserved"), el("span", "This week, projected", "key-live"), el("span", "Hit the limit", "key-capped"));
  container.append(key);
}

/** Five-hour windows of the last seven days, one lane per account so windows of two accounts never stack. */
function windowsChart(container, rows, fmt, now) {
  container.replaceChildren();
  const lanes = rows.filter((item) => item.windows?.windows.length);
  if (!lanes.length) { container.append(note("No 5-hour windows in the last 7 days.")); return; }
  const from = now - 7 * DAY, to = now;
  const width = chartWidth(container, 1040, 280), left = 36, right = 14, plotWidth = width - left - right;
  const x = (t) => left + (Math.max(from, Math.min(to, t)) - from) / (to - from) * plotWidth;
  lanes.forEach((item, index) => {
    const lastLane = index === lanes.length - 1, top = 4, base = 40, height = lastLane ? 62 : 46;
    const y = (value) => base - (base - top) * Math.min(100, value) / 100;
    const color = providerColor(item.provider), { windows } = item.windows;
    const block = el("div", null, "history-lane");
    const label = el("p", null, "lane-label");
    label.append(providerMark(item.provider), el("span", item.label), el("small", `${plural(windows.length, "window")}${item.windows.capped ? `, ${item.windows.capped} capped, ${formatDuration(item.windows.lockedSeconds)} locked out` : ""}`));
    const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, "data-width": width, role: "group", class: "subscription-chart", "aria-label": `${item.label}: 5-hour windows in the last 7 days. Use Left and Right to inspect each window.` });
    for (const tick of [0, 100]) {
      root.append(svg("line", { x1: left, x2: width - right, y1: y(tick), y2: y(tick), class: tick === 100 ? "limit-line" : "grid-line" }));
      root.append(svg("text", { x: left - 6, y: y(tick) + 4, "text-anchor": "end", class: "axis-label" }, `${tick}%`));
    }
    const shown = windows.map((window) => ({ ...window, x0: x(window.start) + 0.5, x1: x(Math.min(window.end, now)) - 0.5 }));
    for (const window of shown) {
      root.append(svg("rect", { x: window.x0, y: y(window.peak), width: Math.max(2, window.x1 - window.x0), height: Math.max(1, y(0) - y(window.peak)), rx: 1.5, fill: color, "fill-opacity": window.active ? 0.5 : 0.85 }));
      for (const [from, until] of window.lockouts) root.append(svg("rect", { x: x(from), y: y(0) + 1.5, width: Math.max(2, x(until) - x(from)), height: 3, rx: 1.5, class: "locked-band" }));
    }
    if (lastLane) {
      // Day labels thin out on narrow screens so they never collide.
      const step = plotWidth < 300 ? 3 : plotWidth < 480 ? 2 : 1;
      let day = 0;
      for (let t = Math.ceil(from / DAY) * DAY; t < to; t += DAY, day += 1) if (day % step === 0) root.append(svg("text", { x: x(t), y: height - 6, "text-anchor": "middle", class: "axis-label" }, fmt.day(t)));
    }
    const marker = svg("line", { x1: 0, x2: 0, y1: top, y2: y(0), class: "inspect-line", visibility: "hidden" });
    root.append(marker);
    const readout = inspectable(root, `windows:${item.key}`, shown, (window) => window.start, (window) => [
      `${fmt.time(window.start)} – ${fmt.time(window.resetsAt)}${window.active ? " · open now" : ""}`,
      `Peak ${percentText(window.peak)}`,
      window.cappedAt !== null ? `Limit reached ${fmt.time(window.cappedAt)}; locked out ${formatDuration(window.lockedSeconds)}` : "",
    ].filter(Boolean), { x: (window) => (window.x0 + window.x1) / 2, marker });
    block.append(label, root, readout);
    container.append(block);
  });
  container.append(note("A 5-hour window opens with your first message after the previous one ends. Bar height is the window's peak; the red base is time locked out after reaching the limit."));
}

function historySection(items, fmt, now, later) {
  const section = el("section", null, "panel subscription-history");
  section.setAttribute("aria-labelledby", "subscription-history-title");
  const header = el("header");
  const title = el("h3", "History"); title.id = "subscription-history-title";
  header.append(title, el("span", "How full each weekly allowance was when it reset, and the 5-hour windows of the last week", "panel-meta"));
  const rows = items.filter((item) => item.identified && item.weeklyMeter);
  // Accounts without a 5-hour limit (Codex plans that dropped it) get no 5-hour section; an idle week still gets its note.
  const lanes = items.filter((item) => item.identified && item.sessionMeter);
  const closes = el("div", null, "chart-slot closes-chart"), windows = el("div", null, "chart-slot windows-chart");
  section.append(header, el("h4", "Weekly closes"), closes);
  if (lanes.length) section.append(el("h4", "5-hour windows · last 7 days"), windows);
  later.push(() => {
    closesChart(closes, rows, fmt, now); redrawOnResize(closes, () => closesChart(closes, rows, fmt, now));
    if (lanes.length) { windowsChart(windows, lanes, fmt, now); redrawOnResize(windows, () => windowsChart(windows, lanes, fmt, now)); }
  });
  return section;
}

function sourcesSection(limits, items, fmt, scope) {
  const section = el("section", null, "panel subscription-sources");
  const details = disclosure("sources", [el("h3", "Sources and method"), el("span", "Where the readings come from and what they cover", "panel-meta")], { className: "section-disclosure" });
  section.append(details);
  const accounts = limits.accounts ?? [];
  const found = ["claude", "codex"].map((provider) => {
    const own = accounts.filter((account) => account.provider === provider && account.attribution !== "weekly-phase" && account.attribution !== "unattributed");
    const names = [...new Set(own.flatMap((account) => account.profileNames))];
    return own.length ? `${plural(own.length, `${providerNames[provider]} account`)}${names.length ? ` (profiles: ${names.join(", ")})` : ""}` : "";
  }).filter(Boolean);
  const unidentified = accounts.filter((account) => account.attribution === "weekly-phase" || account.attribution === "unattributed").length;
  details.append(note(`Accounts found: ${found.length ? found.join("; ") : "none"}${unidentified ? `; ${plural(unidentified, "group")} of readings without an account` : ""}. Times are shown in ${fmt.zone}.`));
  const unread = (scope.unread.length ? `; ${names(scope.unread)} could not be read, so ${scope.unread.length === 1 ? "its" : "their"} sessions are not counted` : "")
    + (scope.pending.length ? `; ${names(scope.pending)} ${scope.pending.length === 1 ? "is" : "are"} still being read` : "")
    + (scope.sessionless.length ? `; ${sessionless(scope)}` : "");
  const from = scope.sessionless.length ? `Meters come from ${names(scope.read)} and value from ${names(scope.value)}` : `Meters and value come from ${names(scope.read)}`;
  details.append(note(scope.limits
    ? `${scope.others.length ? `This dashboard reads ${names([scope.label, ...scope.others])}. ` : ""}${from}, each machine's limits read through its own harvest${unread}. Usage on the web, in the desktop apps and on machines not read moves the same meters, so value per 1% is a lower bound.`
    : scope.others.length
      ? `This dashboard reads ${names([scope.label, ...scope.others])}. Limits are read on ${scope.label} only, so value counts only its sessions; run \`session-analytics limits\` on the others for theirs. Usage there, on the web and in the desktop apps moves the same meters, so value per 1% is a lower bound.`
      : "Limits are read on this machine. Usage on other machines, the web and the desktop apps moves the same meters, so value per 1% is a lower bound."));
  details.append(dataTable([{ text: "Source", align: "left" }, { text: "Status", align: "left" }, "Last reading", "New readings"],
    (limits.sources ?? []).map((source) => [sourceLabels[source.source] ?? source.source,
      source.source === "codex-account" && limits.codexAccount === "off" ? "Turned off" : { ok: "Reading", empty: "Found, no readings yet", unavailable: "Not on this machine" }[source.status] ?? source.status,
      source.latest ? `${fmt.when(source.latest)} · ${fmt.relative(source.latest)}` : DASH, integer(source.read)]),
    { rowHeader: true, className: "sources-table", caption: scope.limits ? `Limit sources on ${scope.label}` : "Limit sources", empty: "No sources checked yet." }));
  const list = el("ul", null, "method-notes");
  for (const text of [
    `Meters are the provider's own usage percentages, copied from records already on ${scope.limits ? "each machine read" : "this machine"}. Nothing is requested from Anthropic; the Codex account read asks the local Codex app-server.`,
    `Readings are kept in a private ledger${limits.persisted ? "" : { off: " (off: --no-index)", unreadable: " (left untouched: written by another version or not replaceable)", unwritable: " (not saved this time)" }[limits.ledger] ?? ""} so reset history outlives provider log rotation. Run \`session-analytics limits --quiet\` every 20 minutes (cron or launchd) to keep it continuous.`,
    "For the interactive Claude Code CLI, set the status line command to `session-analytics limits statusline` in each profile's settings.json. It records the documented rate_limits field for that profile's account and prints the meters.",
    scope.limits ? "Value per 1% divides the API-equivalent value of an account's own sessions on every machine whose limits are read (matched through each machine's Claude profiles, or every Codex session on a machine with one Codex account) by the meter's reading."
      : "Value per 1% divides the API-equivalent value of an account's own sessions on this machine (matched through its Claude profiles, or every Codex session when there is one Codex account) by the meter's reading.",
    `Plan prices were reviewed on ${plansReviewedAt}. Team, Enterprise and Business seats are treated as paid by the employer: they show API value without a personal multiple unless you say you pay. Plan and payer choices stay in this browser.`,
  ]) list.append(el("li", text));
  details.append(list);
  if (!items.some((item) => item.identified)) details.append(note("No account has readings yet."));
  return section;
}

/** Source-aware empty state: what to set up so meters appear. */
function emptyState(limits) {
  const box = el("div", null, "empty-state subscription-empty");
  box.append(el("strong", "No limit readings yet"));
  const claude = (limits.sources ?? []).filter((source) => source.source.startsWith("claude")).some((source) => source.status === "ok");
  const codex = (limits.sources ?? []).some((source) => source.source.startsWith("codex") && source.status === "ok");
  box.append(el("span", [
    claude ? "" : "Claude: set `session-analytics limits statusline` as the Claude Code status line, or use a host that logs Agent SDK events, such as T3 Code.",
    codex ? "" : "Codex: readings appear after your next Codex session on this machine.",
  ].filter(Boolean).join(" ") || "Readings appear after your next Claude or Codex session."));
  return box;
}

/**
 * Render the Subscription view. Limits are account-wide, so `sessions` must be every session (a repository focus does not
 * apply); `null` while the session scan is still running, when the meters render and value waits. `timeZone` is the
 * snapshot's zone for value; times are shown in `displayTimeZone` (the viewer's). `range` is the selected dates in Unix
 * seconds. `scope` names this machine and the other machines the sessions come from, and holds the keys of the machines
 * whose sessions the snapshot holds (`sessions`, as `sessionMachines`; null while unknown). Only sessions from machines whose
 * limits were read (`limits.machines`, else this machine alone) count; a machine whose limits are in but whose sessions are
 * not is named as moving the meters without its value.
 */
export function renderSubscription(container, { limits, sessions = null, timeZone = "UTC", displayTimeZone = null, range = null, scope: given = { label: "this machine", others: [], sessions: null }, onPlanChange, now = Date.now() / 1000, wide = null }) {
  container.replaceChildren();
  if (!limits) { container.append(note("Reading limit meters…")); return; }
  if (limits.unavailable) { container.append(note("Limit meters could not be loaded. Check the terminal running the dashboard; the next refresh retries.", "empty-state")); return; }
  if (limits.dataSource === "snapshot") { container.append(note("Limit meters are live-only and are not part of saved snapshots. Run `session-analytics limits` on the machine that recorded this snapshot.", "empty-state")); return; }
  const counted = limitMachines(limits) ?? new Set(), valued = valuedMachines(limits, given.sessions ?? null) ?? new Set();
  const machines = new Map((limits.machines ?? []).map((machine) => [machine.key, machine]));
  const labelsOf = (keys) => [...machines.values()].filter(({ key }) => keys.has(key)).map(({ label }) => label);
  const read = labelsOf(counted);
  const waiting = [...machines.values()].filter(({ key, state }) => state === "reading" && !counted.has(key)).map(({ label }) => label);
  // Machines with sessions here whose limits are not in: their value is reported as not counted.
  const unread = limits.machines ? given.others.filter((label) => !read.includes(label) && !waiting.includes(label)) : [];
  // Machines whose limits are in but whose sessions are not: their usage moves the meters, but their value cannot be counted.
  const scope = {
    ...given, limits: Boolean(limits.machines), machines, counted, valued, read, value: labelsOf(valued), pending: waiting, unread, now,
    sessionless: labelsOf(new Set([...counted].filter((key) => !valued.has(key)))),
  };
  const fmt = { ...formatters(displayTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC", now), read };
  const accounts = limits.accounts ?? [];
  const plans = Object.fromEntries(accounts.map((account) => [account.key, readSetting(planKey(account.key))]));
  const payers = Object.fromEntries(accounts.map((account) => [account.key, readSetting(payerKey(account.key))]));
  const pending = sessions === null;
  const model = subscriptionModel({ limits, sessions: sessions ?? [], timeZone, now, range: range ?? { from: now, to: now }, plans, payers });
  const entries = model.accounts.filter((item) => item.meters.some((meter) => meter.cycles.length) || (item.identified && item.economics.extracted))
    .map((item) => ({ item, status: limitStatus(item, now) }))
    // Unidentified history without an open cycle stays out of the live view; Sources says it exists.
    .filter(({ item }) => item.identified || item.live.some((live) => live.cycle))
    .sort((left, right) => compareUrgency(left.status, right.status));
  if (!entries.length) { container.append(emptyState(limits)); container.append(sourcesSection(limits, [], fmt, scope)); return; }
  const items = entries.map(({ item }) => item);
  const generatedAt = Date.parse(limits.generatedAt) / 1000;
  const later = [];
  const advice = recommendations(items, { now, sources: limits.sources, persisted: limits.persisted, ledger: limits.ledger, codexAccount: limits.codexAccount ?? "off", formatTime: fmt.when });
  const cards = el("section", null, "subscription-cards");
  cards.setAttribute("aria-label", "Accounts");
  for (const { item, status } of entries) cards.append(accountCard(item, status, fmt, now, { onPlanChange, codexAccount: limits.codexAccount ?? "off", later, scope }));
  const open = wide ?? (typeof matchMedia === "function" ? matchMedia("(min-width: 761px)").matches : true);
  container.append(
    limitsNow(entries, fmt, now, Number.isFinite(generatedAt) ? generatedAt : null, scope),
    nextActions(advice),
    cards,
    worthSection(model, items, fmt, now, { pending, onPlanChange, wide: open, scope }),
    historySection(items, fmt, now, later),
    sourcesSection(limits, items, fmt, scope),
  );
  // Charts measure their slot, so they draw once the whole view is in place.
  for (const draw of later) draw();
}

export const subscriptionRefreshMilliseconds = 2 * 60 * 1000;
