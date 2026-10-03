import { DASH, dataTable, el, evidence, filterBar, kpi, note } from "../ui.js";

const number = (value) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const percent = (value) => value == null ? DASH : `${(value * 100).toFixed(1)}%`;
const when = (value) => value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC" : "Unknown time";
const within = (day, options) => day !== null && (!options.start || day >= options.start.slice(0, 10)) && (!options.end || day <= options.end.slice(0, 10));
const executionMatches = (value, execution) => execution === "all" || value === execution;
let profileKey = null, grouping = "repository", execution = "all", sessionKey = null, trendGroup = "all", expiryTimer = null;

export function clearLimitsCacheView(container) {
  clearTimeout(expiryTimer); expiryTimer = null; container.replaceChildren();
}

const cacheKeys = ["requests", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "pricedRequests", "pricedInputTokens", "actualInputUsd", "noCacheInputUsd", "netSavingsUsd", "cacheWriteUsd", "recacheWriteUsd", "breakRequests", "pricedBreakRequests", "reportedBreaks", "heuristicBreaks", "unknownTtlWriteRequests"];
const contextKeys = ["requests", "eligibleRequests", "reportedWindowRequests", "reviewedWindowRequests", "above40", "above60", "above80"];
const totals = () => ({ cache: Object.fromEntries(cacheKeys.map((key) => [key, 0])), context: { ...Object.fromEntries(contextKeys.map((key) => [key, 0])), peakFill: null } });
function add(target, bucket) {
  for (const key of cacheKeys) target.cache[key] += bucket.cache[key];
  for (const key of contextKeys) target.context[key] += bucket.context[key];
  if (bucket.context.peakFill !== null) target.context.peakFill = Math.max(target.context.peakFill ?? 0, bucket.context.peakFill);
}

/** Date filtering uses request-day buckets, never the session start date. Also used by regression tests. */
export function economicsForView(sessions, options) {
  const result = { ...totals(), groups: [], sessionRows: [], months: [], compactions: [], uncertainCompactions: false, untimedRequests: 0 };
  const groups = new Map(), months = new Map();
  for (const session of sessions) {
    if (options.repositoryId && session.repositoryId !== options.repositoryId || !session.limitsCache) continue;
    const boundaries = session.limitsCache.compactions.filter((c) => within(c.timestamp?.slice(0,10) ?? null, options) && executionMatches(c.executionKind, options.execution ?? "all"));
    result.compactions.push(...boundaries.map((c) => ({ ...c, sessionKey: session.sessionKey })));
    if (session.limitsCache.compactionCountExact === false) result.uncertainCompactions = true;
    const sessionTotal = { ...totals(), session };
    for (const bucket of session.limitsCache.buckets) {
      if (!executionMatches(bucket.executionKind, options.execution ?? "all")) continue;
      if (bucket.day === null) { result.untimedRequests += bucket.cache.requests; continue; }
      if (!within(bucket.day, options)) continue;
      add(result, bucket); add(sessionTotal, bucket);
      const id = options.grouping === "model" ? `${session.provider}:${bucket.model}` : options.grouping === "provider" ? session.provider : session.repositoryId;
      const label = options.grouping === "model" ? `${bucket.model} · ${session.provider}` : options.grouping === "provider" ? session.provider : session.repositoryName;
      const group = groups.get(id) ?? { ...totals(), id, label };
      add(group, bucket); groups.set(id, group);
      const month = bucket.day.slice(0, 7), monthKey = `${session.limitsCache.profileKey}:${month}`;
      const row = months.get(monthKey) ?? { profileKey: session.limitsCache.profileKey, month, value: 0, tokens: 0, priced: 0, days: new Set() };
      row.value += bucket.apiEquivalentUsd; row.tokens += bucket.observedTokens; row.priced += bucket.pricedTokens; row.days.add(bucket.day);
      months.set(monthKey, row);
    }
    if (sessionTotal.cache.requests) result.sessionRows.push(sessionTotal);
  }
  result.groups = [...groups.values()].sort((a,b) => b.cache.inputTokens - a.cache.inputTokens);
  result.sessionRows.sort((a,b) => (b.context.peakFill ?? -1) - (a.context.peakFill ?? -1));
  result.months = [...months.values()].sort((a,b) => b.month.localeCompare(a.month));
  return result;
}

function node(tag, text, className) { return el(tag, text ?? null, className); }
function panel(title, kicker, meta = null) {
  const result = node("article", null, "panel lc-panel"), header = node("header"), titleBox = node("div");
  if (kicker) titleBox.append(node("p", kicker, "kicker"));
  titleBox.append(node("h2", title)); header.append(titleBox);
  if (meta) header.append(node("span", meta, "panel-meta"));
  result.append(header); return result;
}
function table(headers, rows, empty) {
  return dataTable(headers.map((label, index) => index === 0 ? { text: label, align: "left" } : label), rows, { empty });
}
function select(id, label, choices, selected, onChange) {
  const wrapper = node("label", null, "field"), element = node("select"); element.id = id;
  wrapper.append(node("span", label, "field-label"), element);
  for (const [value, text] of choices) element.append(new Option(text, value));
  element.value = selected;
  element.addEventListener("change", () => { onChange(element.value); document.getElementById(id)?.focus(); });
  return wrapper;
}
function svgNode(tag, attrs, text) {
  const result = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) result.setAttribute(key, String(value));
  if (text != null) result.textContent = text;
  return result;
}
function chart(points, label, gapMinutes = null) {
  if (!points.length) return note("No numeric observations in this selection.", "empty-line");
  const width = 1100, height = 180, left = 44, right = 14, top = 12, bottom = 26;
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label, class: "lc-chart" });
  svg.append(svgNode("title", {}, label));
  const minimum = Math.min(...points.map((p) => p.x)), maximum = Math.max(...points.map((p) => p.x));
  const ymax = Math.max(1, ...points.map((p) => p.y));
  const x = (value) => left + (value - minimum) / (maximum - minimum || 1) * (width - left - right);
  const y = (value) => top + (1 - value / ymax) * (height - top - bottom);
  for (const value of [0, 0.4, 0.6, 0.8, 1]) {
    svg.append(svgNode("line", { x1: left, x2: width - right, y1: y(value), y2: y(value), class: "lc-gridline" }));
    svg.append(svgNode("text", { x: left - 8, y: y(value) + 4, "text-anchor": "end", class: "lc-axis" }, `${Math.round(value * 100)}%`));
  }
  let previous = null;
  for (const point of points) {
    if (previous && (gapMinutes === null || point.x - previous.x <= gapMinutes * 60_000)) svg.append(svgNode("line", { x1: x(previous.x), y1: y(previous.y), x2: x(point.x), y2: y(point.y), class: "lc-line" }));
    const dot = svgNode("circle", { cx: x(point.x), cy: y(point.y), r: points.length > 400 ? 1 : points.length > 100 ? 1.5 : 3, class: point.y >= 0.9 ? "lc-dot lc-high" : "lc-dot" });
    dot.append(svgNode("title", {}, point.label)); svg.append(dot); previous = point;
  }
  svg.append(svgNode("text", { x: left, y: height - 8, class: "lc-axis" }, points[0].axis));
  svg.append(svgNode("text", { x: width - right, y: height - 8, "text-anchor": "end", class: "lc-axis" }, points.at(-1).axis));
  return svg;
}
const hitRatio = (cache, policy) => cache.requests >= policy.minimumRequests && cache.inputTokens >= policy.minimumInputTokens ? cache.cacheReadTokens / cache.inputTokens : null;

export function renderLimitsCache(container, snapshot, options) {
  clearLimitsCacheView(container);
  const analytics = snapshot.limitsCache;
  if (!analytics) { container.append(note("Limits and cache evidence is unavailable in this snapshot.", "empty-line")); return; }
  const rerender = () => renderLimitsCache(container, snapshot, options);
  const policy = analytics.policy;
  const intro = node("header", null, "view-header");
  const title = node("div"); title.append(node("p", "Headroom · input economics", "kicker"), node("h2", "Limits & cache"), node("p", "Account-wide quota headroom, then cache and context economics for the selected requests."));
  intro.append(title); container.append(intro);
  const account = panel("Account-wide headroom", "Latest local observations");
  if (analytics.profiles.length) {
    if (!analytics.profiles.some((p) => p.key === profileKey)) profileKey = analytics.profiles.find((p) => p.windows.length)?.key ?? analytics.profiles[0].key;
    account.querySelector("header").append(select("lc-profile", "Profile", analytics.profiles.map((p) => [p.key, p.label]), profileKey, (value) => { profileKey = value; rerender(); }));
    const profile = analytics.profiles.find((p) => p.key === profileKey);
    const cards = node("div", null, "lc-limit-grid");
    const now = Date.now(); let nextExpiry = Infinity;
    for (const window of profile.windows) {
      const observed = Date.parse((window.latestNumeric ?? window.latest).timestamp);
      const expires = window.headroomExpiresAt ? Date.parse(window.headroomExpiresAt) : observed + policy.freshnessMinutes * 60_000;
      const stale = window.stale || now < observed || now >= expires;
      if (!stale) nextExpiry = Math.min(nextExpiry, expires);
      const card = node("section", null, "lc-window");
      card.append(node("h3", `${window.label}${window.windowMinutes ? ` · ${number(window.windowMinutes / 60)}h window` : ""}`));
      card.append(node("strong", percent(stale || window.headroomPercent === null ? null : window.headroomPercent / 100), "lc-headroom"));
      card.append(node("p", stale ? "Headroom unavailable · stale snapshot" : window.headroomPercent === null ? "Headroom unavailable · no compatible numeric evidence" : "Headroom at last observation", "lc-muted"));
      card.append(chart(window.timeline.filter((p) => p.usedPercent !== null).map((p) => ({ x: Date.parse(p.timestamp), y: p.usedPercent / 100,
        label: `${when(p.timestamp)} · ${p.usedPercent}% used`, axis: p.timestamp.slice(0, 10) })), `${window.label}: percent of quota used`, policy.maximumObservationGapMinutes));
      card.append(node("p", `${percent(window.shareAbove90)} of ${number(window.observedMinutes)} observed minutes at ≥90% usage · ${number(window.observations)} snapshots`, "lc-muted"));
      card.append(evidence([
        window.latestNumeric ? `Numeric observation ${when(window.latestNumeric.timestamp)} · expires ${when(window.headroomExpiresAt)}.` : null,
        `Latest evidence ${when(window.latest.timestamp)} · reset ${when(window.latest.resetsAt)}${window.latest.status ? ` · ${window.latest.status.replaceAll("_", " ")}` : ""}.`,
        stale || window.timeToLimitMinutes === null ? "Time-to-limit projection unavailable." : `Projected limit in ${number(window.timeToLimitMinutes)} minutes from the last observation, if that pace continues.`,
        window.timelineSampled || window.historyLimited ? `${window.timelineSampled ? "Chart sampled; statistics use retained observations. " : ""}${window.historyLimited ? "History limited to the latest 20,000 snapshots." : ""}` : null,
      ]));
      cards.append(card);
    }
    if (!profile.windows.length) cards.append(note("No quota snapshots recorded for this profile. Missing evidence is not zero usage.", "empty-line"));
    account.append(cards);
    if (Number.isFinite(nextExpiry)) expiryTimer = setTimeout(() => { if (!container.hidden) rerender(); }, Math.max(1, nextExpiry - now + 1));
    if (profile.limitHits.length) account.append(table(["Recent limit events (UTC)", "Observed event"], profile.limitHits.slice(-5).reverse().map((hit) => [when(hit.timestamp), hit.kind]), "No observed limit events."));
    account.append(evidence([
      "Quota is shared across repositories. This section shows the latest snapshot and full observed history; repository and date filters apply to the request metrics below. Profiles may share an account; their quotas are never added together.",
      `${profile.limitHitCount} limit events · ${profile.sessionsWithLimitErrors} sessions with 429 or usage-limit errors${profile.planType ? ` · observed plan: ${profile.planType} (${when(profile.planObservedAt)})` : ""}. A limit event is not evidence of a failed task.`,
      `Headroom expires after ${policy.freshnessMinutes} minutes or at reset. Exposure uses gaps of at most ${policy.maximumObservationGapMinutes} minutes; quiet gaps are unknown. At least 3 snapshots and 5 observed minutes are required for exposure ratios.`,
      profile.credits ? `Credit observation (${when(profile.credits.observedAt)}): ${profile.credits.unlimited === true ? "unlimited" : profile.credits.balance === null ? "balance unavailable" : `${number(profile.credits.balance)} provider credit units`}. Credit units are not converted to dollars.` : null,
    ]));
  } else account.append(note("No supported rate-limit evidence found. Existing session analytics remain available.", "empty-line"));
  container.append(account);

  const controls = filterBar(select("lc-group", "Compare cache by", [["repository", "Repository"], ["model", "Model"], ["provider", "Agent provider"]], grouping, (value) => { grouping = value; rerender(); }),
    select("lc-execution", "Execution", [["all", "All execution"], ["top-level", "Top-level"], ["subagent", "Sub-agents"]], execution, (value) => { execution = value; rerender(); }));
  container.append(controls);
  const view = economicsForView(snapshot.sessions, { ...options, grouping, execution });
  const cache = view.cache, context = view.context;
  const metrics = node("div", null, "kpi-grid");
  metrics.append(kpi({ label: "Input served from cache", value: hitRatio(cache, policy) === null ? null : percent(hitRatio(cache, policy)), reason: "Below the minimum request or token count", note: `${number(cache.cacheReadTokens)} / ${number(cache.inputTokens)} input tokens · ${number(cache.requests)} requests` }),
    kpi({ label: "Net input savings", value: cache.pricedRequests ? money(cache.netSavingsUsd) : null, reason: "No priced requests in this selection", coverage: { eligible: cache.pricedRequests, selected: cache.requests }, what: "priced requests", note: `${number(cache.pricedInputTokens)} / ${number(cache.inputTokens)} input tokens priced · writes included`, accent: true }),
    kpi({ label: "Writes after break flags", value: cache.pricedBreakRequests ? money(cache.recacheWriteUsd) : null, reason: "No priced break-flagged requests", note: `${cache.pricedBreakRequests}/${cache.breakRequests} flagged requests priced · ${cache.reportedBreaks} reported, ${cache.heuristicBreaks} heuristic` }),
    kpi({ label: "Peak request context", value: context.peakFill === null ? null : percent(context.peakFill), reason: "No requests with known context windows", note: `${number(context.eligibleRequests)} / ${number(context.requests)} requests with known windows` }));
  container.append(metrics);
  container.append(evidence(["Cache and context use request dates in the selected range, including requests from sessions that began earlier. API-equivalent amounts are not invoices; Cursor has no request-level cache or context evidence."]));

  const cachePanel = panel("Cache economics", "No-cache comparison");
  if (!view.groups.some((g) => g.id === trendGroup)) trendGroup = "all";
  if (view.groups.length) cachePanel.querySelector("header").append(select("lc-trend", "Trend for", [["all", "All selected requests"], ...view.groups.map((g) => [g.id, g.label])], trendGroup, (value) => { trendGroup = value; rerender(); }));
  cachePanel.append(table([grouping === "repository" ? "Repository" : grouping === "model" ? "Model" : "Agent", "Cache reads / input", "Hit share", "Net savings", "Pricing coverage", "Break flags"],
    view.groups.map((g) => [g.label, `${number(g.cache.cacheReadTokens)} / ${number(g.cache.inputTokens)}`, percent(hitRatio(g.cache, policy)), g.cache.pricedRequests ? money(g.cache.netSavingsUsd) : DASH,
      `${g.cache.pricedRequests}/${g.cache.requests} requests · ${percent(g.cache.inputTokens ? g.cache.pricedInputTokens / g.cache.inputTokens : null)}`, String(g.cache.breakRequests)]), "No request-level cache evidence in this selection."));
  const days = new Map();
  for (const row of view.sessionRows) for (const bucket of row.session.limitsCache.buckets) {
    if (!within(bucket.day, options) || !executionMatches(bucket.executionKind, execution)) continue;
    const group = grouping === "model" ? `${row.session.provider}:${bucket.model}` : grouping === "provider" ? row.session.provider : row.session.repositoryId;
    if (trendGroup !== "all" && trendGroup !== group) continue;
    const target = days.get(bucket.day) ?? { ...totals(), day: bucket.day }; add(target, bucket); days.set(bucket.day, target);
  }
  const daily = [...days.values()].sort((a,b) => a.day.localeCompare(b.day));
  cachePanel.append(chart(daily.filter((p) => hitRatio(p.cache, policy) !== null).map((p) => ({ x: Date.parse(p.day), y: hitRatio(p.cache, policy),
    label: `${p.day} · ${percent(hitRatio(p.cache, policy))} · ${number(p.cache.cacheReadTokens)} / ${number(p.cache.inputTokens)} input`, axis: p.day })), `Daily cache-read share: ${view.groups.find((g) => g.id === trendGroup)?.label ?? "all selected requests"}`, 1440));
  cachePanel.append(evidence([`Savings price the same input as uncached and subtract observed input/read/write value: ${money(cache.noCacheInputUsd)} − ${money(cache.actualInputUsd)} for priced requests. Negative savings are possible. Break flags describe correlation, not proven causes or avoidable waste. ${cache.unknownTtlWriteRequests} write requests lack explicit TTL evidence.`]));
  container.append(cachePanel);

  const contextPanel = panel("Context pressure", "Request input including cache");
  contextPanel.append(table(["Threshold", "Requests above threshold", "Share of eligible requests"], [40,60,80].map((threshold) => [
    `>${threshold}%`, `${number(context[`above${threshold}`])} / ${number(context.eligibleRequests)}`,
    percent(context.eligibleRequests >= policy.minimumRequests ? context[`above${threshold}`] / context.eligibleRequests : null)]), "No context evidence."));
  if (view.sessionRows.length) {
    if (!view.sessionRows.some((row) => row.session.sessionKey === sessionKey)) sessionKey = view.sessionRows[0].session.sessionKey;
    contextPanel.append(filterBar(select("lc-session", "Inspect a session", view.sessionRows.map((row) => [row.session.sessionKey, `Session ${row.session.sessionKey} · ${row.session.provider} · peak ${percent(row.context.peakFill)}`]), sessionKey, (value) => { sessionKey = value; rerender(); })));
    const row = view.sessionRows.find((row) => row.session.sessionKey === sessionKey);
    const points = row.session.limitsCache.context.curve.filter((p) => within(p.timestamp?.slice(0,10) ?? null, options) && executionMatches(p.executionKind, execution));
    contextPanel.append(chart(points.map((p) => ({ x: p.request, y: p.fill, label: `Request ${p.request} · ${when(p.timestamp)} · ${number(p.inputTokens)} / ${number(p.windowTokens)} tokens`, axis: `Request ${p.request}` })), "Request context fill across the selected session"));
  }
  const compactions = view.compactions.sort((a,b) => b.timestamp.localeCompare(a.timestamp));
  contextPanel.append(table(["Recent compactions (UTC)", "Session", "Pre → post tokens", "Turns since previous"], compactions.slice(0, 8).map((c) => [when(c.timestamp), c.sessionKey,
    `${c.preTokens === null ? DASH : number(c.preTokens)} → ${c.postTokens === null ? DASH : number(c.postTokens)}`, c.turnsSincePrevious === null ? `${DASH} first or uncertain boundary` : String(c.turnsSincePrevious)]), "No dated compaction boundaries in this selection."));
  contextPanel.append(evidence([
    `${context.reportedWindowRequests} recorded windows · ${context.reviewedWindowRequests} reviewed Claude model capacities. Model capacity can differ from a harness's configured budget. High fill is an indicator, not a quality verdict; output capacity is not subtracted.`,
    view.sessionRows.find((row) => row.session.sessionKey === sessionKey)?.session.limitsCache.context.curveSampled ? "Curve detail is sampled within a 20,000-point snapshot budget and 240-point session cap. Allocations of at least 3 retain peaks and endpoints; smaller allocations prioritize peaks. Threshold statistics use all requests." : null,
    view.uncertainCompactions ? "Some compaction counts are uncertain: boundary identity or timestamp evidence is incomplete." : null,
    "Pre/post sizes are shown only when recorded. Turn intervals count human turns within the same execution stream. Detail lists may be sampled; missing boundaries and tool-result messages do not become turns.",
  ]));
  container.append(contextPanel);

  const breaksPanel = panel("Recent cache-break evidence", "Provider reasons & heuristic flags");
  const breaks = view.sessionRows.flatMap(({ session }) => session.limitsCache.cacheBreaks.filter((b) => within(b.timestamp?.slice(0,10) ?? null, options) && executionMatches(b.executionKind, execution))).sort((a,b) => b.timestamp.localeCompare(a.timestamp));
  breaksPanel.append(table(["Observed (UTC)", "Model / execution", "Provider reason", "Heuristic flags", "Write value"], breaks.slice(0, 8).map((b) => [when(b.timestamp), `${b.model} · ${b.executionKind}`, b.reportedReason ?? "Not recorded", b.heuristics.join(", ") || "None", b.writeUsd === null ? DASH : money(b.writeUsd)]), "No cache-break evidence in this selection."));
  breaksPanel.append(evidence(["Idle-gap flags use an explicitly recorded 5-minute or 1-hour write TTL; mixed writes use the longer TTL. Hits refresh the inferred expiry. Model-switch and compaction flags require a subsequent cache write. The same write is charged once even when flags overlap; recent details may be sampled."]));
  container.append(breaksPanel);

  const plans = panel("Subscription comparison", "Observed value / configured monthly price");
  plans.append(table(["Profile / month", "API-equivalent value", "Monthly plan", "Value / price", "Coverage"], view.months.map((row) => {
    const configured = analytics.subscriptions.find((p) => p.profileKey === row.profileKey && p.month === row.month);
    const price = configured?.monthlyPriceUsd ?? null;
    const ratio = price > 0 && row.tokens > 0 && row.priced === row.tokens && row.days.size >= 3 ? row.value / price : null;
    const profile = analytics.profiles.find((p) => p.key === row.profileKey);
    return [`${profile?.label ?? "Profile"} · ${row.month}${row.month === snapshot.generatedAt.slice(0, 7) ? " · to date" : ""}`, money(row.value), price === null ? "Not configured" : money(price), ratio === null ? DASH : `${ratio.toFixed(2)}×`, `${row.days.size} active days · ${percent(row.tokens ? row.priced / row.tokens : null)} priced (${number(row.priced)}/${number(row.tokens)} tokens)`];
  }), "No dated API-equivalent usage in this selection."));
  plans.append(evidence([
    "The numerator follows the selected repositories, dates and execution; the denominator is the full configured monthly USD price. No price is inferred from plan type, no extrapolation is made, and observed history may be incomplete. Ratios need 3 active days and full pricing coverage. This does not measure money saved or work delivered.",
    !analytics.subscriptions.some((row) => row.monthlyPriceUsd !== null) ? "Add optional plan prices and display labels in data-dir config.json (limitsCache.profiles). Refresh after editing. Prices are never guessed." : null,
    view.untimedRequests ? `${view.untimedRequests} requests have no valid timestamp and are excluded from date-filtered views.` : null,
    ...analytics.warnings,
  ]));
  container.append(plans);
}
