import { dateLabel, dateTime } from "./format.js";
import { providerColor } from "./chart-colors.js";
import { ageLabel, contextRows, integer, money, pricingCardView, pricingModelCards, rateRows, sharePercent } from "./pricing-data.js";
import { providerLabels, providerMark } from "./providers.js";
import { DASH, dataTable, el, evidence, kpi, note } from "./ui.js";

// Provenance dates may be calendar dates (schema: date or date-time); a calendar date stays a calendar label.
const date = (value, timeZone) => !value ? "Not cached" : /^\d{4}-\d{2}-\d{2}$/.test(value) ? dateLabel(value) : dateTime(value, timeZone);
const humanDate = (value) => Number.isFinite(Date.parse(value))
  ? dateLabel(new Date(value).toISOString().slice(0, 10)) : value;
const assumptions = (provenance) => provenance?.assumptions.map((code) => assumptionLabels[code] ?? "Derived cache rate").join("; ") || "None";
const dialogId = "pricing-model-dialog";
const panels = new WeakMap();
let showUnused = false;
const assumptionLabels = {
  "anthropic-cache-1h-2x": "1-hour cache write: estimated at 2× input",
  "codex-cache-write-upper-1.25x": "Cache-write upper estimate: 1.25× input",
  "cache-write-upper-multiplier": "Cache-write upper estimate: configured input multiplier",
  "cache-read-at-input": "Cache read: estimated at input rate",
  "cache-write-5m-at-input": "5-minute cache write: estimated at input rate",
  "cache-write-5m-multiplier": "5-minute cache write: estimated with input multiplier",
  "cache-write-1h-at-5m": "1-hour cache write: estimated at 5-minute rate (input-rate fallback if unavailable)",
  "cache-write-ttl-5m": "Cache-write TTL unavailable: estimated as 5 minutes",
  "context-cache-read-at-base": "Context-tier cache read: estimated at base-context rate",
  "context-cache-write-5m-at-base": "Context-tier 5-minute write: estimated at base-context rate",
  "context-cache-write-1h-at-base": "Context-tier 1-hour write: estimated at base-context rate",
};
const warningLabels = {
  "cache-unavailable": "The pricing cache could not be read.",
  "invalid-snapshot": "A damaged cached snapshot was skipped.",
  "large-price-change": "The latest source comparison contains a large price change.",
  "rejected-models": "Some source entries failed price validation.",
};

function providerHeading(provider) {
  const heading = el("span", null, "pricing-provider");
  heading.append(providerMark(provider), el("span", providerLabels[provider] ?? "Unknown provider"));
  return heading;
}

function definitionList(rows) {
  const list = el("dl");
  for (const [label, value] of rows) {
    const row = el("div"); row.append(el("dt", label), el("dd", value)); list.append(row);
  }
  return list;
}

function detailSection(title, ...children) {
  const section = el("section"); section.append(el("h3", title), ...children); return section;
}

/** Current public rates and the historical evidence actually used by the selected sessions. */
export function renderModelDetails(target, card, rateCard, timeZone = "UTC") {
  target.replaceChildren();
  target.style?.setProperty?.("--card-accent", providerColor(card.provider));
  const header = el("header"), heading = el("div"), title = el("h2", card.model, "pricing-model");
  title.setAttribute("id", "pricing-model-title");
  title.setAttribute("tabindex", "-1"); title.setAttribute("autofocus", "");
  heading.append(providerHeading(card.provider), title);
  const close = el("button", null, "icon-button");
  close.setAttribute("type", "button"); close.setAttribute("aria-label", "Close");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  svg.setAttribute("aria-hidden", "true"); use.setAttribute("href", "#i-close"); svg.append(use); close.append(svg);
  close.addEventListener?.("click", () => target.close?.());
  header.append(heading, close);
  const body = el("div", null, "pricing-dialog-body");
  body.append(detailSection("Current rates (USD per 1M tokens)", card.rate
    ? definitionList(rateRows(card.rate).map(([label, value]) => [label, money(value, 4)])) : note("No matching rate")));
  const tiers = contextRows(card.rate);
  if (tiers.length) body.append(detailSection("Long-context pricing", dataTable([
    { text: "Context", align: "left" }, "Input / 1M", "Output / 1M",
  ], tiers.map(([label, input, output]) => [label, money(input, 4), money(output, 4)]))));
  const current = card.current;
  const source = detailSection("Current rate source", current ? definitionList([
    ["Source", current.source],
    ["Kind", { reviewed: "Reviewed override (pinned)", fallback: "Bundled reviewed card (fallback)", api: "Public API price list" }[current.kind]],
    ["Snapshot", date(current.snapshotDate, timeZone)],
    ["Match", current.match === "alias" ? `Alias match · ${current.rateModel}` : "Exact match"],
    ["Assumptions", assumptions(current)],
  ]) : note("No current rate source available"));
  if (/^https?:\/\//i.test(card.source ?? "")) {
    const link = el("a", "Rate source ↗"); link.href = card.source; link.target = "_blank"; link.rel = "noreferrer";
    source.append(link);
  }
  source.append(note(`Reviewed card effective ${rateCard.effectiveDate}`)); body.append(source);
  if (card.used) {
    const usage = card.usage;
    const values = [["Usage value", money(usage.valueUsd)]];
    if (usage.upperEstimateUsd !== usage.valueUsd) values.push(["Upper estimate", money(usage.upperEstimateUsd)]);
    values.push(["Observed tokens", integer(usage.tokens)],
      ["Pricing coverage", `${integer(usage.pricedTokens)} / ${integer(usage.tokens)} observed tokens (${usage.coverage === null ? DASH : sharePercent(usage.coverage)})`],
      ["Calls", usage.callsEligible > 0 && usage.calls != null ? integer(usage.calls) : DASH], ["Sessions", integer(usage.sessions)],
      ["Input tokens", integer(usage.inputTokens)], ["Cached input tokens", integer(usage.cachedInputTokens)],
      ["Cache write tokens", integer(usage.cacheWriteInputTokens)], ["Output tokens", integer(usage.outputTokens)]);
    body.append(detailSection("In this selection", definitionList(values)));
    const entries = [...card.provenance];
    if (!card.priced || (usage.coverage !== null && usage.coverage < 1)) entries.push(null);
    const rows = entries.map((provenance) => [
      provenance ? `${provenance.source} / ${provenance.kind}` : card.provenance.length ? "Some tokens use estimated or unavailable rates" : "No matching rate",
      provenance ? date(provenance.snapshotDate, timeZone) : DASH,
      !provenance ? "Incomplete token-class coverage" : provenance.temporal === "oldest" ? "Oldest available (later than request)"
        : provenance.temporal === "undated" ? "Latest; request time unavailable" : "At or before request",
      assumptions(provenance),
    ]);
    body.append(detailSection("Rates applied to this usage", dataTable(
      ["Source / kind", "Snapshot", "Selection", "Assumptions"].map((text) => ({ text, align: "left" })), rows)));
  } else body.append(note("Not used in this selection"));
  target.append(header, body);
}

function panelState(container) {
  if (panels.has(container)) return panels.get(container);
  const content = el("div", null, "pricing-content");
  let dialog = document.getElementById?.(dialogId);
  container.replaceChildren(content);
  if (!dialog) {
    dialog = el("dialog", null, "help pricing-dialog"); dialog.setAttribute("id", dialogId);
    dialog.setAttribute("aria-labelledby", "pricing-model-title"); container.append(dialog);
  }
  const state = { content, dialog, buttons: new Map(), openerKey: null };
  dialog.addEventListener?.("close", () => state.buttons.get(state.openerKey)?.focus?.({ preventScroll: true }));
  dialog.addEventListener?.("click", (event) => { if (event.target === dialog) dialog.close?.(); });
  // Keep dashboard shortcuts from acting behind the modal; native Escape and Tab still work.
  dialog.addEventListener?.("keydown", (event) => event.stopPropagation());
  panels.set(container, state); return state;
}

function modelGrid(cards, data, state, rateCard, unused = false, timeZone = "UTC") {
  const grid = el("ul", null, `pricing-grid${unused ? " pricing-grid-unused" : ""}`); grid.setAttribute("role", "list");
  for (const card of cards) {
    const item = el("li"), button = el("button", null, `pricing-card${card.used ? "" : " pricing-card-unused"}`);
    const view = pricingCardView(card, data), prices = el("span", null, "pricing-price");
    if (view.prices) {
      const separator = el("span", "·", "pricing-sep"); separator.setAttribute("aria-hidden", "true");
      prices.append(el("span", view.prices[0]), separator, el("span", view.prices[1]));
    } else prices.append(el("span", "No matching rate"));
    button.setAttribute("type", "button"); button.setAttribute("aria-haspopup", "dialog"); button.setAttribute("aria-controls", dialogId);
    button.dataset.focusKey = `pricing:model:${card.id}`;
    button.setAttribute("aria-label", view.ariaLabel);
    button.style?.setProperty?.("--card-accent", providerColor(card.provider));
    button.append(providerHeading(card.provider), el("span", card.model, "pricing-model"), prices);
    if (card.used) {
      button.append(el("strong", view.value, "pricing-value"),
        el("small", view.value === DASH ? `${view.caption} · ${view.detail}` : view.detail, "pricing-detail"));
      const share = el("span", null, "pricing-share"), label = el("span", null, "pricing-share-label");
      label.append(el("span", view.share.text, "pricing-share-value"), el("span", ` ${view.share.label}`));
      const track = el("span", null, "pricing-bar"), fill = el("span");
      track.setAttribute("role", "img"); track.setAttribute("aria-label", view.share.aria);
      fill.style?.setProperty?.("width", `${Math.max(0, Math.min(100, view.share.value * 100))}%`);
      track.append(fill); share.append(label, track);
      const badge = el("span", null, "pricing-badge-slot");
      if (view.badge) badge.append(el("small", view.badge, "pricing-badge"));
      else badge.setAttribute("aria-hidden", "true");
      button.append(share, badge);
    } else button.append(el("span", view.caption, "pricing-caption"));
    state.buttons.set(button.dataset.focusKey, button);
    button.addEventListener?.("click", () => {
      state.openerKey = button.dataset.focusKey;
      renderModelDetails(state.dialog, card, rateCard, timeZone); state.dialog.showModal?.();
    });
    item.append(button); grid.append(item);
  }
  return grid;
}

/**
 * Prices shown here are the evidence used by the selected sessions, including mixed historical rates. Card values and
 * coverage read the activity ledger over `window` (`{ start, end }` calendar dates), as Costs and the Summary KPI do.
 * `options.onRefresh` applies a refreshed snapshot when public price updates are enabled.
 */
export function renderPricingPanel(container, rateCard, sessions, window = {}, options = {}) {
  const state = panelState(container);
  container = state.content; state.buttons.clear();
  container.replaceChildren();
  const status = rateCard.pricing;
  if (!status) { container.append(note("Pricing source details are unavailable for this snapshot.", "empty-line")); return; }
  const mode = status.policy === "reviewed-only" ? "Reviewed card only; public sources bypassed"
    : status.offline ? "Cached prices only; no public price requests" : "Checked after the dashboard starts";
  if (status.stale || status.warnings.length) {
    const warning = el("aside", null, "notice pricing-notice");
    warning.setAttribute("role", "status");
    const body = el("div");
    body.append(el("strong", status.stale ? "Pricing evidence needs a refresh" : "Pricing evidence has warnings"));
    body.append(el("p", status.stale
      ? `A source is missing or older than ${status.refreshAfterDays} days. Cached and reviewed rates remain usable.`
      : "Some fetched rates were rejected or changed substantially. Inspect rates diff for details."));
    body.append(el("p", status.policy === "reviewed-only" ? "The reviewed card is pinned; public pricing sources are bypassed."
      : status.offline ? "Offline mode prevents public price requests. Run session-analytics rates update with offline mode off, then refresh."
      : "Refresh snapshot to apply prices fetched in the background since the dashboard started, or run session-analytics rates update."));
    if (status.warnings.length) body.append(el("p", status.warnings.map((code) => warningLabels[code] ?? "Pricing evidence is incomplete.").join(" ")));
    warning.append(body);
    if (status.stale && !status.offline && status.policy !== "reviewed-only" && typeof options.onRefresh === "function") {
      const refresh = el("button", "Refresh snapshot", "button pricing-notice-action");
      refresh.setAttribute("type", "button"); refresh.dataset.focusKey = "pricing:refresh";
      refresh.addEventListener("click", () => options.onRefresh()); warning.append(refresh);
    }
    container.append(warning);
  }
  const cards = el("div", null, "kpi-grid compact-metrics");
  const data = pricingModelCards(rateCard, sessions, window), { tokens, pricedTokens } = data;
  cards.append(kpi({ label: "Pricing coverage", value: data.coverage === null ? null : sharePercent(data.coverage), reason: tokens ? null : "No eligible tokens in this selection", note: tokens ? `${integer(pricedTokens)} / ${integer(tokens)} eligible tokens priced` : "Provider-reported values do not use a rate card", accent: true }));
  for (const source of status.policy === "reviewed-only" ? [] : status.sources) {
    const age = ageLabel(source.ageDays);
    const card = kpi({ label: `${source.source} prices`, value: age === null ? null : `${age[0].toUpperCase()}${age.slice(1)} old`, reason: age === null ? "No cached snapshot" : null, note: `${integer(source.models)} models · ${source.stale ? "stale or missing" : "current"}` });
    card.className += " pricing-freshness";
    if (/^https?:\/\//i.test(source.url ?? "")) {
      const link = el("a", "Public price list ↗");
      link.href = source.url; link.target = "_blank"; link.rel = "noreferrer";
      card.append(link);
    }
    cards.append(card);
  }
  const updates = kpi({ label: "Price updates", value: status.policy === "reviewed-only" ? "Pinned" : status.offline ? "Offline" : "Automatic", note: `Reviewed card: ${humanDate(rateCard.effectiveDate)}` });
  updates.className += " pricing-updates"; cards.append(updates);
  container.append(cards);
  container.append(note(`${money(data.api)} API-equivalent · ${money(data.reported)} reported · ${money(data.total)} total`, "chart-note pricing-reconciliation"));
  container.append(evidence([
    `Cards add up to ${money(data.api)} API-equivalent value. With ${money(data.reported)} provider-reported value, which has no rate card, that is the ${money(data.total)} usage value for these dates on Summary and Costs.`,
    `${mode} · reviewed card effective ${humanDate(rateCard.effectiveDate)}.`,
    ...status.sources.map((source) => `${source.source}: ${integer(source.models)} models · ${source.stale ? "stale or missing" : "current"}${source.fetchedAt ? ` · fetched ${date(source.fetchedAt, window.timeZone ?? "UTC")}` : " · not cached"}.`),
    "API-equivalent value is not an invoice. Each request uses the newest snapshot at or before its timestamp; earlier requests use the oldest available evidence, labelled below.",
    "Coverage is the share of eligible ledger tokens with an explicit token-class rate for these dates, the same measure as Costs; substituted cache rates are excluded. Cursor database usage has no eligible tokens.",
    status.policy === "reviewed-only" ? "The selected reviewed card is pinned. Public pricing sources are bypassed."
      : status.offline ? "Offline mode prevents public pricing requests. Run rates update with offline mode disabled when you want fresh evidence."
      : "The dashboard checks for stale prices after startup. Refresh snapshot after that update to apply it, or run session-analytics rates update.",
    "Cards are per provider and model, ordered by usage value for these dates, then observed tokens. Provider-reported usage (for example Cursor) does not use a rate card and is not shown here.",
  ]));
  const panel = el("article", null, "panel detail-panel");
  const header = el("header"), block = el("div");
  block.append(el("h3", "Model prices"), note("API-equivalent value · activity-dated", "chart-note"));
  header.append(block); panel.append(header);
  if (!data.used.length) {
    panel.append(note("No API-priced model usage in this selection. Provider-reported values do not use a rate card.", "empty-line"));
  } else panel.append(modelGrid(data.used, data, state, rateCard, false, window.timeZone ?? "UTC"));
  const toggle = el("button", null, "button pricing-toggle"), unused = el("div", null, "pricing-unused");
  toggle.setAttribute("type", "button"); toggle.dataset.focusKey = "pricing:unused";
  toggle.setAttribute("aria-controls", "pricing-unused-models"); unused.setAttribute("id", "pricing-unused-models");
  const renderUnused = () => {
    toggle.textContent = showUnused ? "Hide unused models" : `Show ${integer(data.unused.length)} unused models`;
    toggle.setAttribute("aria-expanded", String(showUnused)); unused.hidden = !showUnused;
    for (const card of data.unused) state.buttons.delete(`pricing:model:${card.id}`);
    unused.replaceChildren(...(showUnused ? [modelGrid(data.unused, data, state, rateCard, true, window.timeZone ?? "UTC")] : []));
  };
  toggle.addEventListener?.("click", () => { showUnused = !showUnused; renderUnused(); });
  if (data.unused.length) { renderUnused(); panel.append(toggle, unused); }
  container.append(panel);
}
