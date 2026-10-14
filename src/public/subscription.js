// Subscription view: how much of each paid allowance turns into usage, from provider-reported limit meters.
// Rendering only; every number comes from subscription-data.js.

import { dayMonth, integer, money, percent, weekdayDate, weekdayTime, wholeMoney } from "./format.js";
import { providerColor } from "./chart-colors.js";
import { providerMark } from "./providers.js";
import { chartWidth, el, redrawOnResize, DASH } from "./ui.js";
import {
  DAY, calibrationMinimum, formatDuration, providerNames, recommendations, subscriptionModel,
} from "./subscription-data.js";
import { plansReviewedAt, subscriptionPlans } from "./subscription-plans.js";

/** Explanatory paragraphs wrap freely; one-line `.chart-note` captions are reserved for short labels. */
const note = (text, className = "subscription-note") => el("p", text, className);
/** Plan overrides are kept per account key in this browser. */
const planKey = (account) => `session-analytics.subscription-plan.${account}`;
const readPlan = (account) => { try { return localStorage.getItem(planKey(account)); } catch { return null; } };
const writePlan = (account, value) => { try { if (value) localStorage.setItem(planKey(account), value); else localStorage.removeItem(planKey(account)); } catch { /* Optional. */ } };

const sourceLabels = {
  "codex-account": "Codex account (banked resets)",
  "codex-session": "Codex session records",
  "claude-sdk-log": "Claude Agent SDK events (host logs)",
  "claude-statusline": "Claude Code status line",
};

function svg(tag, attributes = {}, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatters(timeZone) {
  return {
    time: (seconds) => weekdayTime(seconds, timeZone),
    date: (seconds) => dayMonth(seconds, timeZone),
    day: (seconds) => weekdayDate(seconds, timeZone),
  };
}

const usd = (value) => value === null || value === undefined ? DASH : value >= 10_000 ? `$${Math.round(value / 100) / 10}k` : wholeMoney(value);
const pct = (value, digits = 0) => value === null || value === undefined ? DASH : `${Math.round(value * 10 ** digits) / 10 ** digits}%`;

function kpi(label, value, noteText, { accent = false, title = null } = {}) {
  const article = el("article", null, accent ? "kpi accent" : "kpi");
  const name = el("span", label, "kpi-label"); if (title) name.title = title;
  article.append(name, el("strong", value), el("small", noteText, "kpi-note"));
  return article;
}

/** A readout under a chart: pointer and arrow keys move between items; the text is announced politely. */
function inspectable(svgNode, items, describe, position) {
  const readout = el("div", null, "subscription-readout");
  readout.setAttribute("aria-live", "polite");
  if (!items.length) return readout;
  let selected = items.length - 1;
  const marker = position.marker;
  const show = (index) => {
    selected = Math.max(0, Math.min(items.length - 1, index));
    const item = items[selected];
    readout.replaceChildren(...describe(item).map((line, i) => el(i === 0 ? "strong" : "span", line)));
    if (marker) { const x = position.x(item); marker.setAttribute("x1", x); marker.setAttribute("x2", x); marker.setAttribute("visibility", "visible"); }
  };
  svgNode.setAttribute("tabindex", "0");
  svgNode.addEventListener("keydown", (event) => {
    const target = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: items.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault(); show(target);
  });
  svgNode.addEventListener("focus", () => show(selected));
  const pointer = (event) => {
    const bounds = svgNode.getBoundingClientRect();
    const width = Number(svgNode.getAttribute("data-width"));
    const x = (event.clientX - bounds.left) * width / bounds.width;
    let best = 0, distance = Infinity;
    items.forEach((item, index) => { const gap = Math.abs(position.x(item) - x); if (gap < distance) { distance = gap; best = index; } });
    show(best);
  };
  svgNode.addEventListener("pointermove", pointer); svgNode.addEventListener("click", pointer);
  show(selected);
  return readout;
}

/** Bullet meter: fill = used, tick = even pace to the reset, hatched extension = projection at reset. */
function meterRow(live, fmt, now) {
  const row = el("div", null, "meter-row");
  const color = providerColor(live.meter.provider);
  const head = el("div", null, "meter-head");
  head.append(el("span", live.meter.label, "meter-name"));
  const value = el("span", live.cycle ? `${Math.round(live.used)}%` : DASH, "meter-value");
  head.append(value);
  const track = el("div", null, "meter-track");
  track.setAttribute("role", "img");
  track.style.setProperty("--meter-color", color);
  if (live.cycle) {
    const fill = el("i", null, "meter-fill"); fill.style.width = `${Math.min(100, live.used)}%`;
    track.append(fill);
    if (live.state === "active" && live.projected !== null && live.projected !== undefined && live.projected > live.used) {
      const projection = el("i", null, "meter-projection");
      projection.style.left = `${Math.min(100, live.used)}%`;
      projection.style.width = `${Math.max(0, Math.min(100, live.projected) - Math.min(100, live.used))}%`;
      track.append(projection);
    }
    if (live.elapsed !== undefined && !live.stale) {
      const pace = el("i", null, "meter-pace"); pace.style.left = `${live.elapsed * 100}%`; track.append(pace);
    }
  }
  const status = el("p", null, "meter-status");
  let sentence;
  if (live.state === "retired") sentence = "The provider no longer reports this meter.";
  else if (!live.cycle) sentence = live.nextResetAt ? `No reading since the last reset. This limit resets on a fixed weekly schedule: next ${fmt.time(live.nextResetAt)}.` : "No active window. The next request starts one.";
  else if (live.state === "unreported") sentence = `${Math.round(live.used)}% at the last report (${fmt.time(live.observedAt)}). The provider no longer reports this meter.`;
  else {
    const reset = `Resets ${fmt.time(live.cycle.resetsAt)}, in ${formatDuration(live.cycle.resetsAt - now)}.`;
    const restarted = live.segment?.before ? ` Restarted in place ${fmt.time(live.segment.start)}.` : "";
    if (live.state === "overage") { sentence = `Past the included allowance, on paid extra usage. ${reset}`; status.dataset.tone = "warn"; }
    else if (live.state === "capped") { sentence = `Limit reached ${fmt.time(live.capAt)}. ${reset}`; status.dataset.tone = "danger"; }
    else if (live.capsEarly) { sentence = `At this pace it runs out ${fmt.time(live.capAt)}, ${formatDuration(live.cycle.resetsAt - live.capAt)} early. ${reset}`; status.dataset.tone = "warn"; }
    else if (live.mayBeUsedUp) { sentence = `May already be used up: the pace before the last reading reaches 100% by now. ${reset}`; status.dataset.tone = "warn"; }
    else if (live.stale) sentence = reset;
    else if (live.projected === null || live.projected === undefined) sentence = `${live.tooEarly ? "Too early in the window to project" : "No projection for readings without an account"}. ${reset}`;
    else sentence = `On pace to close near ${Math.round(Math.min(100, live.projected))}%. ${reset}`;
    sentence += restarted;
    if (live.stale) sentence += ` Last reading ${formatDuration(now - live.observedAt)} ago.`;
  }
  status.textContent = sentence;
  track.setAttribute("aria-label", `${live.meter.label}: ${sentence}`);
  row.append(head, track, status);
  return row;
}

const segmentOf = (cycle, sample) => cycle.segments.find((segment) => segment.samples.includes(sample)) ?? cycle.segments[0];

/** Current weekly cycle: used % against time, with the even-pace diagonal from the current segment and the projection to reset. */
function burnChart(container, item, fmt, now) {
  const live = item.weekly;
  container.replaceChildren();
  if (!live?.cycle) { container.append(note(live?.nextResetAt ? `No reading since the last weekly reset. The next one is ${fmt.time(live.nextResetAt)}.` : "No active weekly cycle. Your next request starts one.")); return; }
  const cycle = live.cycle, width = chartWidth(container, 520, 260), height = 180, left = 36, right = 12, top = 10, bottom = 26;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const x = (t) => left + (t - cycle.start) / Math.max(1, cycle.resetsAt - cycle.start) * plotWidth;
  const y = (value) => top + (1 - Math.min(100, value) / 100) * plotHeight;
  const color = providerColor(item.provider);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, "data-width": width, role: "group", class: "subscription-chart", "aria-label": `${item.label} weekly cycle: ${Math.round(live.used)}% used, ${Math.round((live.elapsed ?? 0) * 100)}% of the time to the reset elapsed. Use Left and Right to inspect readings.` });
  for (const tick of [0, 50, 100]) {
    root.append(svg("line", { x1: left, x2: width - right, y1: y(tick), y2: y(tick), class: tick === 100 ? "limit-line" : "grid-line" }));
    root.append(svg("text", { x: left - 6, y: y(tick) + 4, "text-anchor": "end", class: "axis-label" }, `${tick}%`));
  }
  for (let day = 0; day <= 7; day += 1) {
    const t = cycle.start + day * DAY;
    if (t > cycle.resetsAt) break;
    if (day % (plotWidth < 360 ? 2 : 1) === 0) root.append(svg("text", { x: x(t), y: height - 8, "text-anchor": day === 0 ? "start" : day === 7 ? "end" : "middle", class: "axis-label" }, fmt.day(t)));
  }
  const segment = live.segment;
  root.append(svg("line", { x1: x(segment.start), y1: y(0), x2: x(cycle.resetsAt), y2: y(100), class: "pace-line" }));
  // Each segment is its own line: an in-place reset is a marked restart, not a cliff.
  for (const part of cycle.segments) {
    const shown = part.samples.filter((sample) => sample.t <= now);
    if (shown.length) root.append(svg("path", { d: shown.map((sample, index) => `${index ? "L" : "M"}${x(sample.t).toFixed(1)},${y(sample.used).toFixed(1)}`).join(" "), class: "used-line", stroke: color }));
    if (part.before) {
      root.append(svg("line", { x1: x(part.start), x2: x(part.start), y1: top, y2: top + plotHeight, class: "grid-line" }));
      root.append(svg("text", { x: x(part.start) + 3, y: top + 10, class: "axis-label" }, "reset"));
    }
  }
  const points = cycle.samples.filter((sample) => sample.t <= now);
  if (live.state === "active" && live.projected !== null && live.projected !== undefined && points.length) {
    const last = points[points.length - 1];
    const endT = live.capsEarly ? live.capAt : cycle.resetsAt;
    // The projection starts now: time since the last reading counts at the cycle's pace.
    root.append(svg("path", { d: `M${x(now)},${y(live.used)} L${x(endT)},${y(live.capsEarly ? 100 : live.projected)}`, class: "projection-line", stroke: color }));
    root.append(svg("circle", { cx: x(last.t), cy: y(last.used), r: 4, fill: color, class: "end-dot" }));
  }
  root.append(svg("line", { x1: x(now), x2: x(now), y1: top, y2: top + plotHeight, class: "now-line" }));
  const marker = svg("line", { x1: 0, x2: 0, y1: top, y2: top + plotHeight, class: "inspect-line", visibility: "hidden" });
  root.append(marker);
  const readout = inspectable(root, points, (sample) => [
    `${fmt.time(sample.t)} · ${Math.round(sample.used)}% used`,
    `Even pace: ${Math.round(Math.min(1, Math.max(0, (sample.t - segmentOf(cycle, sample).start) / (cycle.resetsAt - segmentOf(cycle, sample).start))) * 100)}%`,
    sample.status === "rejected" ? "Requests refused on this meter" : "",
  ].filter(Boolean), { x: (sample) => x(sample.t), marker });
  const key = el("p", null, "chart-key");
  key.append(el("span", "Used", "key-used"), el("span", "Projection", "key-projection"), el("span", "Even pace", "key-pace"), el("span", "Now", "key-now"));
  key.style.setProperty("--meter-color", color);
  container.append(root, key, readout);
}

/** Closing level of each weekly reset, one row per account. The live cycle is drawn hollow at its projected level. */
function resetsChart(container, items, fmt, now) {
  container.replaceChildren();
  const rows = items.filter((item) => item.weeklyMeter);
  if (!rows.length) { container.append(note("No weekly meter readings yet.")); return; }
  for (const item of rows) {
    const cycles = [...item.history.slice(-12).map((cycle) => ({ ...cycle, live: false }))];
    if (item.weekly?.cycle) cycles.push({ resetsAt: item.weekly.cycle.resetsAt, peak: Math.min(100, item.weekly.used), projected: Math.min(100, item.weekly.projected ?? item.weekly.used), live: true, capped: item.weekly.state === "capped" || item.weekly.capsEarly });
    const block = el("div", null, "resets-row");
    const label = el("p", null, "resets-label"); label.append(providerMark(item.provider), el("span", item.label));
    block.append(label);
    const width = chartWidth(container, 520, 260), height = 132, left = 36, right = 8, top = 8, bottom = 22;
    const slots = Math.max(cycles.length, 6), band = (width - left - right) / slots, barWidth = Math.min(28, band * 0.6);
    const y = (value) => top + (1 - value / 100) * (height - top - bottom);
    const bx = (index) => left + band * (slots - cycles.length + index) + band / 2;
    const color = providerColor(item.provider);
    const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, "data-width": width, role: "group", class: "subscription-chart", "aria-label": `${item.label} weekly resets: closing utilization per cycle. Use Left and Right to inspect.` });
    for (const tick of [0, 50, 100]) {
      root.append(svg("line", { x1: left, x2: width - right, y1: y(tick), y2: y(tick), class: tick === 100 ? "limit-line" : "grid-line" }));
      root.append(svg("text", { x: left - 6, y: y(tick) + 4, "text-anchor": "end", class: "axis-label" }, `${tick}%`));
    }
    cycles.forEach((cycle, index) => {
      const cx = bx(index), level = cycle.live ? cycle.projected : cycle.peak;
      if (cycle.live) {
        root.append(svg("rect", { x: cx - barWidth / 2, y: y(level), width: barWidth, height: Math.max(1, y(0) - y(level)), rx: 3, class: "bar-projected", stroke: color }));
        root.append(svg("rect", { x: cx - barWidth / 2, y: y(cycle.peak), width: barWidth, height: Math.max(1, y(0) - y(cycle.peak)), rx: 3, fill: color, "fill-opacity": 0.55 }));
      } else {
        root.append(svg("rect", { x: cx - barWidth / 2, y: y(cycle.peak), width: barWidth, height: Math.max(1, y(0) - y(cycle.peak)), rx: 3, fill: cycle.endedEarly || cycle.lowerBound ? "var(--neutral-mark)" : color }));
      }
      if (cycle.capped) root.append(svg("circle", { cx, cy: y(100) - 5, r: 3, class: "capped-dot" }));
      if (index === cycles.length - 1 || index % Math.ceil(cycles.length / 6) === 0) root.append(svg("text", { x: cx, y: height - 6, "text-anchor": "middle", class: "axis-label" }, fmt.date(cycle.resetsAt)));
    });
    const marker = svg("line", { x1: 0, x2: 0, y1: top, y2: y(0), class: "inspect-line", visibility: "hidden" });
    root.append(marker);
    const readout = inspectable(root, cycles, (cycle) => cycle.live ? [
      `Current cycle · resets ${fmt.time(cycle.resetsAt)}`,
      `${Math.round(cycle.peak)}% used so far; on pace for ${Math.round(cycle.projected)}%${cycle.capped ? " (runs out before the reset)" : ""}`,
    ] : [
      `Reset ${fmt.time(cycle.resetsAt)} · closed at ${cycle.lowerBound ? "at least " : ""}${Math.round(cycle.peak)}%`,
      cycle.endedEarly
        ? cycle.restored !== null ? `${cycle.cause === "credit" ? "Banked reset redeemed" : "Reset early"} at ${Math.round(cycle.restored)}% used: restored ${Math.round(cycle.restored)}% of a week${cycle.restoredUsd !== null ? ` (≈ ${usd(cycle.restoredUsd)})` : ""}` : "Reset early; the level at the reset was not observed"
        : cycle.expired !== null ? `${Math.round(cycle.expired)}% expired unused${cycle.expiredUsd !== null ? ` (≈ ${usd(cycle.expiredUsd)} API value)` : ""}` : "The last reading came long before the reset, so the unused share is unknown",
      ...cycle.inPlace.map((reset) => `${reset.cause === "credit" ? "Banked reset redeemed" : "Provider reset"} in place ${fmt.time(reset.at)}${reset.restored !== null ? `, restoring ${Math.round(reset.restored)}%${reset.restoredUsd !== null ? ` (≈ ${usd(reset.restoredUsd)})` : ""}` : ""}`),
      cycle.capped ? `Capped for ${formatDuration(cycle.lockedSeconds)} before the reset` : "",
    ].filter(Boolean), { x: (cycle) => bx(cycles.indexOf(cycle)), marker });
    block.append(root, readout);
    container.append(block);
  }
  container.append(note("Bars show each weekly meter's highest reading before it reset. The hollow bar is the current cycle at its projected close. A dot marks a cycle that hit its limit. Grey bars are cycles that reset early, from a reset credit or a provider-wide reset, or whose closing level was not observed."));
}

/** Five-hour windows over the last seven days: width = window, height = peak, red base = time locked out. */
function windowsChart(container, items, fmt, now) {
  container.replaceChildren();
  const rows = items.filter((item) => item.windows?.windows.length);
  if (!rows.length) { container.append(note("No 5-hour window readings in the last 7 days. ChatGPT Pro has no 5-hour limit; Claude windows appear once meters are recorded.")); return; }
  for (const item of rows) {
    const { windows, from, to } = item.windows;
    const width = chartWidth(container, 1040, 300), height = 120, left = 36, right = 8, top = 8, bottom = 22;
    const x = (t) => left + (Math.max(from, Math.min(to, t)) - from) / (to - from) * (width - left - right);
    const y = (value) => top + (1 - value / 100) * (height - top - bottom);
    const color = providerColor(item.provider);
    const block = el("div", null, "resets-row");
    const label = el("p", null, "resets-label"); label.append(providerMark(item.provider), el("span", `${item.label} · ${windows.length} window${windows.length === 1 ? "" : "s"}, ${item.windows.capped} capped, ${formatDuration(item.windows.lockedSeconds)} locked out`));
    block.append(label);
    const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, "data-width": width, role: "group", class: "subscription-chart", "aria-label": `${item.label} 5-hour windows in the last 7 days. Use Left and Right to inspect each window.` });
    for (const tick of [0, 100]) {
      root.append(svg("line", { x1: left, x2: width - right, y1: y(tick), y2: y(tick), class: tick === 100 ? "limit-line" : "grid-line" }));
      root.append(svg("text", { x: left - 6, y: y(tick) + 4, "text-anchor": "end", class: "axis-label" }, `${tick}%`));
    }
    for (let t = Math.ceil(from / DAY) * DAY; t < to; t += DAY) root.append(svg("text", { x: x(t), y: height - 6, "text-anchor": "middle", class: "axis-label" }, fmt.day(t)));
    for (const window of windows) {
      const x0 = x(window.start) + 1, x1 = x(Math.min(window.end, now)) - 1;
      root.append(svg("rect", { x: x0, y: y(window.peak), width: Math.max(2, x1 - x0), height: Math.max(1, y(0) - y(window.peak)), rx: 2, fill: color, "fill-opacity": window.active ? 0.5 : 0.85 }));
      if (window.cappedAt !== null) root.append(svg("rect", { x: x(window.cappedAt), y: y(0) + 2, width: Math.max(2, x(Math.min(window.end, now)) - x(window.cappedAt)), height: 4, rx: 2, class: "locked-band" }));
    }
    const marker = svg("line", { x1: 0, x2: 0, y1: top, y2: y(0), class: "inspect-line", visibility: "hidden" });
    root.append(marker);
    const readout = inspectable(root, windows, (window) => [
      `${fmt.time(window.start)} – ${fmt.time(window.resetsAt)}${window.active ? " · active" : ""}`,
      `Peak ${Math.round(window.peak)}%`,
      window.cappedAt !== null ? `Limit reached ${fmt.time(window.cappedAt)}; locked out ${formatDuration(window.lockedSeconds)}` : "",
    ].filter(Boolean), { x: (window) => (x(window.start) + x(Math.min(window.end, now))) / 2, marker });
    block.append(root, readout);
    container.append(block);
  }
  container.append(note("A 5-hour window starts with your first message after the previous one ends. Gaps between bars are hours with no window open. The red base marks time spent locked out after reaching the limit."));
}

function planSelect(item, onChange) {
  const label = el("label", null, "plan-select");
  label.append(el("span", "Plan", "sr-only"));
  const select = document.createElement("select");
  select.setAttribute("aria-label", `${item.label} plan`);
  const automatic = document.createElement("option");
  const detectedPlan = subscriptionPlans[item.provider].find((plan) => plan.id === item.account.plan);
  automatic.value = ""; automatic.textContent = detectedPlan ? `Detected: ${detectedPlan.label}` : "Plan not detected";
  select.append(automatic);
  for (const plan of subscriptionPlans[item.provider]) {
    const option = document.createElement("option");
    option.value = plan.id; option.textContent = `${plan.label}${plan.monthlyUsd !== null ? ` · $${plan.monthlyUsd}/mo` : ""}${plan.payer === "organization" ? " · paid by the organization" : ""}`;
    select.append(option);
  }
  const none = document.createElement("option"); none.value = "none"; none.textContent = "Exclude from value totals"; select.append(none);
  select.value = readPlan(item.key) ?? "";
  select.addEventListener("change", () => { writePlan(item.key, select.value); onChange(); });
  label.append(select);
  return label;
}

function resetsSection(item, fmt, now, codexAccount) {
  const section = el("section", null, "resets-section");
  section.append(el("h4", "Resets and credits"));
  const list = el("dl", null, "subscription-facts resets-facts");
  const fact = (term, value, detail) => { const row = el("div"); row.append(el("dt", term), el("dd", value)); if (detail) row.append(el("small", detail)); list.append(row); };
  const banked = item.resets;
  if (item.provider === "codex" && !banked.known && codexAccount !== "ok") {
    fact("Banked resets", DASH, codexAccount === "off" ? "Not read (turned off)" : "Codex app-server did not answer");
  } else if (banked.known || banked.available) {
    fact("Banked resets", String(banked.available), banked.upToUsd !== null && banked.available ? `Up to ${usd(banked.upToUsd)} if redeemed at 100%` : banked.available ? "" : "None available");
    for (const credit of banked.credits.slice(0, 4)) {
      const scope = credit.scope === "five_hour" ? "5-hour reset" : credit.scope === "seven_day" ? "Weekly reset" : "Full reset";
      const restore = banked.nowValue(credit);
      fact(scope, credit.expiresAt ? `expires ${fmt.date(credit.expiresAt)}` : "no expiry",
        `${credit.expiresAt ? `in ${formatDuration(credit.expiresAt - now)} · ` : ""}${restore !== null ? `restores ${usd(restore)} now` : ""}`);
    }
  }
  const credits = item.account.codex?.credits;
  if (credits) fact("Credit balance", credits.unlimited ? "Unlimited" : credits.balance !== null ? integer(Math.round(credits.balance)) : DASH, "Used after the included allowance runs out");
  const extra = item.account.extraUsage;
  if (extra) {
    const label = { enabled: "On", "in-use": "In use", disabled: "Off", unknown: "Unknown" }[extra.extraUsage];
    fact("Extra usage", label, extra.disabledReason ? extra.disabledReason.replace(/_/g, " ") : extra.extraUsage === "disabled" ? "" : "Billed at API rates past a limit");
  }
  const inPlace = (reset) => ({ term: "Restarted in place", at: reset.at, restored: reset.restored, restoredUsd: reset.restoredUsd });
  const early = item.history.flatMap((cycle) => [
    ...cycle.inPlace.map(inPlace),
    ...(cycle.endedEarly ? [{ term: cycle.cause === "credit" ? "Reset redeemed" : "Early reset", at: cycle.end, restored: cycle.restored, restoredUsd: cycle.restoredUsd }] : []),
  ]).concat(item.restarts.map(inPlace)).sort((left, right) => left.at - right.at).slice(-3);
  for (const reset of early) {
    fact(reset.term, `${fmt.date(reset.at)}${reset.restored !== null ? ` at ${Math.round(reset.restored)}%` : ""}`,
      reset.restored !== null ? `Restored ${Math.round(reset.restored)}% of a week${reset.restoredUsd !== null ? ` (≈ ${usd(reset.restoredUsd)})` : ""}` : "The level at the reset was not observed");
  }
  section.append(list);
  return section;
}

const valueScope = (item) => ({
  profiles: `Value from ${integer(item.value.sessions)} of this machine's sessions in this account's profiles.`,
  provider: `Value from this machine's ${integer(item.value.sessions)} ${providerNames[item.provider]} sessions: it is the only ${providerNames[item.provider]} account.`,
  none: "No sessions could be matched to this account, so its value is unknown.",
})[item.value.basis];

function accountCard(item, fmt, now, onChange, codexAccount) {
  const card = el("article", null, "panel subscription-card");
  card.style.setProperty("--meter-color", providerColor(item.provider));
  const header = el("header", null, "subscription-card-header");
  const title = el("h3"); title.append(providerMark(item.provider), el("span", item.label));
  header.append(title);
  if (item.identified) header.append(planSelect(item, onChange));
  card.append(header);
  if (!item.identified) card.append(note(item.account.attribution === "weekly-phase"
    ? "Readings whose session was not found in any profile, grouped by weekly reset time. They are shown as reported, without pace, value or advice."
    : "Readings that could not be tied to an account. They are shown as reported, without pace, value or advice."));
  const meters = el("div", null, "meter-list");
  const live = item.live.filter((entry) => entry.cycle || (entry.state !== "retired" && (entry.meter === item.weeklyMeter || entry.meter === item.sessionMeter)));
  if (!live.length) meters.append(note("No limit readings yet."));
  for (const entry of live) meters.append(meterRow(entry, fmt, now));
  card.append(meters);
  if (!item.identified) return card;
  card.append(resetsSection(item, fmt, now, codexAccount));
  const chart = el("div", null, "burn-chart chart-slot");
  card.append(el("h4", "Current weekly cycle"), chart);
  burnChart(chart, item, fmt, now);
  redrawOnResize(chart, () => burnChart(chart, item, fmt, now));
  const { economics: money_, calibration, period } = item;
  const facts = el("dl", null, "subscription-facts");
  const fact = (term, value, title) => { const row = el("div"); const dt = el("dt", term); if (title) dt.title = title; row.append(dt, el("dd", value)); facts.append(row); };
  fact("Value per 1% of the week", calibration.perPercent !== null ? money(calibration.perPercent) : DASH,
    `${calibration.perPercent !== null ? `Median of ${calibration.cycles} cycles, range ${money(calibration.low)}–${money(calibration.high)}` : `Not enough history: needs ${calibrationMinimum} weekly readings of at least 5% with this account's activity (${calibration.cycles} so far)`}${calibration.excluded ? `; ${calibration.excluded} cycle${calibration.excluded === 1 ? "" : "s"} left out because local value explains almost none of the meter's movement` : ""}. ${valueScope(item)}`);
  fact("Weekly capacity", usd(money_.weeklyCapacity), "API-equivalent value of 100% of one weekly allowance");
  if (item.sessionCalibration?.perPercent) fact("One full 5-hour window", usd(item.sessionCalibration.perPercent * 100), "API-equivalent value of 100% of a 5-hour window");
  fact("Monthly potential", usd(money_.monthlyPotential), "Weekly capacity × 4.35");
  fact(`Extracted · ${Math.round(period.days * 10) / 10} days`, usd(money_.extracted), period.firstReading !== null ? `Since ${fmt.date(period.from)}: the selected dates, from this account's first meter reading, up to now` : "No meter readings in the selected dates");
  fact("Value multiple", money_.multiple !== null ? `${money_.multiple.toFixed(1)}×` : DASH,
    money_.price !== null ? `${usd(money_.extracted)} of API value for ${usd(money_.price)} of subscription` : money_.payer === "organization" ? "Paid by the organization: API value only, no personal price" : "Choose a plan to compare");
  fact("Weekly resets used", item.utilization ? pct(item.utilization.mean) : DASH, item.utilization ? `Mean closing level of ${item.utilization.closed} observed cycle${item.utilization.closed === 1 ? "" : "s"}${item.utilization.includesProjection ? " plus the current projection" : ""}` : "Needs a weekly reset whose closing level was observed");
  card.append(facts);
  return card;
}

function recommendationList(items) {
  const list = el("ol", null, "recommendations");
  if (!items.length) { list.append(el("li", "Nothing to change: no meter is on course to run out early or leave much unused.", "recommendation")); return list; }
  const toneLabel = { act: "Act now", watch: "Opportunity", good: "Going well", setup: "Setup" };
  for (const item of items.slice(0, 8)) {
    const entry = el("li", null, "recommendation");
    entry.dataset.tone = item.tone;
    const head = el("div", null, "recommendation-head");
    head.append(el("span", toneLabel[item.tone], "recommendation-tone"));
    if (item.provider) head.append(providerMark(item.provider));
    head.append(el("strong", item.title));
    entry.append(head, el("p", item.detail));
    list.append(entry);
  }
  return list;
}

function sourcesPanel(limits, fmt) {
  const panel = el("article", null, "panel subscription-sources");
  panel.append(el("h3", "Sources and method"));
  const table = el("table", null, "data-table");
  const head = el("thead"), row = el("tr");
  for (const name of ["Source", "Status", "Latest reading", "Read this refresh"]) row.append(el("th", name));
  head.append(row); table.append(head);
  const body = el("tbody");
  for (const source of limits.sources) {
    const line = el("tr");
    line.append(el("td", sourceLabels[source.source] ?? source.source), el("td", source.status), el("td", source.latest ? fmt.time(source.latest) : DASH), el("td", String(source.read)));
    body.append(line);
  }
  table.append(body);
  const wrap = el("div", null, "table-wrap"); wrap.append(table);
  panel.append(wrap);
  const list = el("ul", null, "method-notes");
  for (const text of [
    "Meters are the provider's own usage percentages, copied from records already on this machine. Nothing is requested from Anthropic or OpenAI.",
    `Readings are kept in a private ledger${limits.persisted ? "" : " (off: --no-index)"} so reset history outlives provider log rotation. Run \`session-analytics limits --quiet\` every 20 minutes (cron or launchd) to keep it continuous.`,
    "For the interactive Claude Code CLI, set the status line command to `session-analytics limits statusline`. It records the documented rate_limits field and prints the meters.",
    "Value per percent divides the API-equivalent value of an account's own sessions in a window (matched through their Claude profile, or every Codex session when there is one Codex account) by the meter's reading. Usage on other machines, the web app or the desktop app also moves the meter, so capacity is a conservative lower bound and utilization an upper bound.",
    `Plan prices were reviewed on ${plansReviewedAt}. Team, Enterprise and Business seats are treated as paid by the organization: they show API value without a personal multiple. Override the detected plan on each card; the choice stays in this browser.`,
  ]) list.append(el("li", text));
  panel.append(list);
  return panel;
}

/**
 * Render the Subscription view. `sessions` must be every session: limits are account-wide, so a repository focus does not apply.
 * `range` is the selected dates in Unix seconds. `local` is null when every session is this machine's, else a test for this
 * machine's sessions: other machines' sessions never calibrate an account they cannot be matched to.
 */
export function renderSubscription(container, { limits, sessions, timeZone, range, rangeLabel, local = null, onPlanChange, now = Date.now() / 1000 }) {
  container.replaceChildren();
  if (!limits) { container.append(note("Loading limit meters…")); return; }
  if (limits.unavailable) { container.append(note("Limit meters could not be loaded. Check the terminal running the dashboard.", "empty-state")); return; }
  if (limits.dataSource === "snapshot") { container.append(note("Limit meters are live-only. They are not part of saved snapshots.", "empty-state")); return; }
  const fmt = formatters(timeZone);
  const plans = Object.fromEntries((limits.accounts ?? []).map((account) => [account.key, readPlan(account.key)]));
  const model = subscriptionModel({ limits, sessions, timeZone, now, range, plans, local });
  const items = model.accounts.filter((item) => item.meters.length || item.economics.extracted > 0);
  const { totals } = model;

  const hero = el("section", null, "kpi-grid subscription-kpis");
  hero.setAttribute("aria-label", "Subscription value");
  const priced = totals.priced, aside = [
    totals.organization.extracted ? `${usd(totals.organization.extracted)} on organization-paid seats` : "",
    totals.unpriced.extracted ? `${usd(totals.unpriced.extracted)} on plans without a price` : "",
  ].filter(Boolean).join(" and ");
  hero.append(
    kpi("Monthly potential", usd(totals.monthlyPotential), totals.monthlyPotential === null ? "Needs calibration" : `${totals.potentialMultiple !== null ? `${totals.potentialMultiple.toFixed(0)}× price` : "Full use of every reset"}${totals.banked ? ` · +${usd(totals.banked)} banked` : ""}`,
      { accent: true, title: `API-equivalent value of using 100% of each calibrated weekly allowance for a month. The price multiple counts only accounts you pay for that are calibrated.${totals.banked ? ` Banked resets add up to ${usd(totals.banked)} more if each is redeemed near 100%.` : ""}` }),
    kpi("Extracted", usd(totals.extracted), totals.unattributed ? `+ ${usd(totals.unattributed)} unmatched` : "Matched to accounts", { title: `API-equivalent value of the sessions matched to each account, ${rangeLabel}, from each account's first meter reading.${totals.unattributed ? ` Another ${usd(totals.unattributed)} came from sessions no account could claim.` : ""}` }),
    kpi("Capacity used", totals.capacityUsed !== null ? percent(totals.capacityUsed, 0) : DASH, totals.capacityUsed === null ? "Needs calibration" : totals.capacityUsed > 1 ? `${totals.capacityUsed.toFixed(1)}× the refill rate` : `of ${usd(totals.potential)} for these dates`,
      { title: `Extracted value of calibrated accounts ÷ their capacity for the same time (${usd(totals.potential)}). Over 100% means usage outpaces what the weekly limits refill, so limits will be hit.` }),
    kpi("Weekly resets used", totals.resetsUsed !== null ? pct(totals.resetsUsed) : DASH, "Mean observed close", { title: "Meter only: how full each weekly allowance was when it reset, with the live cycle's projection. Closes that were not observed are left out." }),
    kpi("Value multiple", priced.multiple !== null ? `${priced.multiple.toFixed(1)}×` : DASH, priced.multiple !== null ? `on ${usd(priced.price)} of plan price` : aside ? "No personal plan price" : "Choose plans to compare",
      { title: `${priced.multiple !== null ? `${usd(priced.extracted)} of API-equivalent value ÷ ${usd(priced.price)} of plan price` : "Value ÷ price"} over the accounts you pay for, prorated to ${rangeLabel}.${aside ? ` Not included: ${aside}.` : ""}` }),
  );
  container.append(hero);
  if (model.unattributed.remote) container.append(note("This snapshot combines other machines. Their sessions cannot be matched to these accounts yet, so value per 1% and Extracted use only sessions matched through a Claude profile on this machine, and Codex value is left out."));

  const advice = el("article", null, "panel subscription-advice");
  advice.append(el("h3", "How to get more out of it"));
  advice.append(recommendationList(recommendations(items, { now, sources: limits.sources, persisted: limits.persisted, codexAccount: limits.codexAccount ?? "off", formatTime: fmt.time })));
  container.append(advice);

  const cards = el("section", null, "subscription-cards");
  cards.setAttribute("aria-label", "Subscriptions");
  for (const item of items) cards.append(accountCard(item, fmt, now, onPlanChange, limits.codexAccount ?? "off"));
  if (!items.length) cards.append(note("No Claude or Codex limit readings or activity were found.", "empty-state"));
  container.append(cards);

  const resets = el("article", null, "panel");
  resets.append(el("h3", "Weekly resets: how much of each one you used"));
  const resetsBody = el("div", null, "chart-slot");
  resets.append(resetsBody);
  container.append(resets);
  const accounts = items.filter((item) => item.identified);
  resetsChart(resetsBody, accounts, fmt, now);

  const windows = el("article", null, "panel");
  windows.append(el("h3", "5-hour windows · last 7 days"));
  const windowsBody = el("div", null, "chart-slot");
  windows.append(windowsBody);
  container.append(windows);
  windowsChart(windowsBody, accounts, fmt, now);
  redrawOnResize(windowsBody, () => windowsChart(windowsBody, accounts, fmt, Date.now() / 1000));

  container.append(sourcesPanel(limits, fmt));
}

export const subscriptionRefreshMilliseconds = 2 * 60 * 1000;

