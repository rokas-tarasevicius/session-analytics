import { providerColor } from "./chart-colors.js";
import { contextRows, pricingModelCards, rateRows } from "./pricing-data.js";
import { providerLabels, providerMark } from "./providers.js";
import { DASH, dataTable, el, evidence, kpi, note } from "./ui.js";

const date = (value) => value ? new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Not cached";
const integer = (value) => value.toLocaleString("en-GB");
// Coverage shares arrive rounded down to 0.1% (`pricedShare`); round away float noise before printing so 0.29 stays 29%.
const tenths = (share) => Math.round(share * 1000) / 10;
const sharePercent = (share, digits = 1) => digits ? `${tenths(share).toFixed(1)}%` : `${Math.floor(tenths(share))}%`;
const money = (value, decimals = 2) => `$${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: decimals })}`;
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
export function renderModelDetails(target, card, rateCard) {
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
    ["Snapshot", date(current.snapshotDate)],
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
      ["Calls", integer(usage.calls)], ["Sessions", integer(usage.sessions)],
      ["Input tokens", integer(usage.inputTokens)], ["Cached input tokens", integer(usage.cachedInputTokens)],
      ["Cache write tokens", integer(usage.cacheWriteInputTokens)], ["Output tokens", integer(usage.outputTokens)]);
    body.append(detailSection("In this selection", definitionList(values)));
    const entries = [...card.provenance];
    if (!card.priced || (usage.coverage !== null && usage.coverage < 1)) entries.push(null);
    const rows = entries.map((provenance) => [
      provenance ? `${provenance.source} / ${provenance.kind}` : card.provenance.length ? "Some tokens use estimated or unavailable rates" : "No matching rate",
      provenance ? date(provenance.snapshotDate) : DASH,
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

function modelGrid(cards, data, state, rateCard) {
  const grid = el("ul", null, "pricing-grid"); grid.setAttribute("role", "list");
  for (const card of cards) {
    const item = el("li"), button = el("button", null, `pricing-card${card.used ? "" : " pricing-card-unused"}`);
    const usage = card.usage, provider = providerLabels[card.provider] ?? "Unknown provider";
    const prices = card.rate ? `${money(card.rate.inputPerMillion, 4)} in · ${money(card.rate.outputPerMillion, 4)} out / 1M` : "No matching rate";
    button.setAttribute("type", "button"); button.setAttribute("aria-haspopup", "dialog"); button.setAttribute("aria-controls", dialogId);
    button.dataset.focusKey = `pricing:model:${card.id}`;
    button.setAttribute("aria-label", `${card.model}, ${provider}: ${!usage ? "Not used in this selection" : !usage.pricedTokens && !usage.valueUsd ? "no usage value (unpriced)" : `${money(usage.valueUsd)} API-equivalent value`}, ${card.rate
      ? `input ${money(card.rate.inputPerMillion, 4)} / output ${money(card.rate.outputPerMillion, 4)} per 1M tokens` : prices}. Show pricing details`);
    button.style?.setProperty?.("--card-accent", providerColor(card.provider));
    button.append(providerHeading(card.provider), el("span", card.model, "pricing-model"), el("span", prices, "pricing-price"));
    if (usage) {
      const unpriced = !usage.pricedTokens && !usage.valueUsd;
      button.append(el("strong", unpriced ? DASH : money(usage.valueUsd), "pricing-value"), el("span", unpriced ? "No usage value: unpriced" : "API-equivalent value · activity-dated", "pricing-caption"),
        el("small", `${integer(usage.tokens)} tokens · ${integer(usage.calls)} calls`, "pricing-caption"));
      const share = data.maxValue > 0 ? usage.valueUsd / data.maxValue : data.maxTokens > 0 ? usage.tokens / data.maxTokens : 0;
      const width = Math.max(0, Math.min(100, share * 100));
      const track = el("span", null, "pricing-bar"), fill = el("span");
      track.setAttribute("role", "img"); track.setAttribute("aria-label", `${Math.round(width)}% of the top model's ${data.maxValue > 0 ? "usage value" : "observed tokens"}`);
      fill.style?.setProperty?.("width", `${width}%`); track.append(fill); button.append(track);
      if (!card.priced || (usage.coverage !== null && usage.coverage < 1)) button.append(el("small",
        usage.coverage !== null && usage.coverage < 1 ? `${sharePercent(usage.coverage, 0)} of tokens priced` : "Incomplete rates", "pricing-badge"));
    } else button.append(el("small", "Not used in this selection", "pricing-caption"));
    state.buttons.set(button.dataset.focusKey, button);
    button.addEventListener?.("click", () => {
      state.openerKey = button.dataset.focusKey;
      renderModelDetails(state.dialog, card, rateCard); state.dialog.showModal?.();
    });
    item.append(button); grid.append(item);
  }
  return grid;
}

/**
 * Prices shown here are the evidence used by the selected sessions, including mixed historical rates. Card values and
 * coverage read the activity ledger over `window` (`{ start, end }` calendar dates), as Costs and the Summary KPI do.
 */
export function renderPricingPanel(container, rateCard, sessions, window = {}) {
  const state = panelState(container);
  container = state.content; state.buttons.clear();
  container.replaceChildren();
  const status = rateCard.pricing;
  if (!status) { container.append(note("Pricing source details are unavailable for this snapshot.", "empty-line")); return; }
  const mode = status.policy === "reviewed-only" ? "Pinned reviewed card" : status.offline ? "Offline · cached prices" : "Public price updates enabled";
  if (status.stale || status.warnings.length) {
    const warning = el("aside", null, "notice");
    warning.setAttribute("role", "status");
    const body = el("div");
    body.append(el("strong", status.stale ? "Pricing evidence needs a refresh" : "Pricing evidence has warnings"));
    body.append(el("p", status.stale
      ? `A source is missing or older than ${status.refreshAfterDays} days. Cached and reviewed rates remain usable.`
      : "Some fetched rates were rejected or changed substantially. Inspect rates diff for details."));
    if (status.warnings.length) body.append(el("p", status.warnings.map((code) => warningLabels[code] ?? "Pricing evidence is incomplete.").join(" ")));
    warning.append(body); container.append(warning);
  }
  const cards = el("div", null, "kpi-grid compact-metrics");
  for (const source of status.policy === "reviewed-only" ? [] : status.sources) {
    const card = kpi({ label: `${source.source} snapshot age`, value: source.ageDays === null ? null : `${source.ageDays.toFixed(1)}d`, reason: source.ageDays === null ? "No cached snapshot" : null, note: `${source.models} models · ${source.stale ? "stale or missing" : "current"} · ${date(source.fetchedAt)}` });
    const link = el("a", "Public price list ↗");
    link.href = source.url; link.target = "_blank"; link.rel = "noreferrer";
    card.append(link); cards.append(card);
  }
  const data = pricingModelCards(rateCard, sessions, window), { tokens, pricedTokens } = data;
  cards.append(kpi({ label: "Pricing coverage", value: data.coverage === null ? null : sharePercent(data.coverage), reason: tokens ? null : "No eligible tokens in this selection", note: tokens ? `${pricedTokens.toLocaleString("en-GB")} / ${tokens.toLocaleString("en-GB")} eligible tokens · activity-dated, as on Costs` : "Provider-reported values do not use a rate card", accent: true }));
  cards.append(kpi({ label: "Price policy", value: status.policy === "reviewed-only" ? "Pinned" : status.offline ? "Offline" : "Live", note: `${mode} · reviewed card effective ${rateCard.effectiveDate}` }));
  container.append(cards);
  container.append(evidence([
    `Cards add up to ${money(data.api)} API-equivalent value. With ${money(data.reported)} provider-reported value, which has no rate card, that is the ${money(data.total)} usage value for these dates on Summary and Costs.`,
    "API-equivalent value is not an invoice. Each request uses the newest snapshot at or before its timestamp; earlier requests use the oldest available evidence, labelled below.",
    "Coverage is the share of eligible ledger tokens with an explicit token-class rate for these dates, the same measure as Costs; substituted cache rates are excluded. Cursor database usage has no eligible tokens.",
    status.policy === "reviewed-only" ? "The selected reviewed card is pinned. Public pricing sources are bypassed."
      : status.offline ? "Offline mode prevents public pricing requests. Run rates update with offline mode disabled when you want fresh evidence."
      : "The dashboard checks for stale prices after startup. Refresh snapshot after that update to apply it, or run session-analytics rates update.",
    "Cards are per provider and model, ordered by usage value for these dates, then observed tokens. Provider-reported usage (for example Cursor) does not use a rate card and is not shown here.",
  ]));
  const panel = el("article", null, "panel detail-panel");
  const header = el("header"), block = el("div");
  block.append(el("p", "Rates used by selected models", "kicker"), el("h3", "Model prices"));
  header.append(block); panel.append(header);
  if (!data.used.length) {
    panel.append(note("No API-priced model usage in this selection. Provider-reported values do not use a rate card.", "empty-line"));
  } else panel.append(modelGrid(data.used, data, state, rateCard));
  const toggle = el("button", null, "button pricing-toggle"), unused = el("div", null, "pricing-unused");
  toggle.setAttribute("type", "button"); toggle.dataset.focusKey = "pricing:unused";
  toggle.setAttribute("aria-controls", "pricing-unused-models"); unused.setAttribute("id", "pricing-unused-models");
  const renderUnused = () => {
    toggle.textContent = showUnused ? "Hide unused models" : `Show ${integer(data.unused.length)} unused models`;
    toggle.setAttribute("aria-expanded", String(showUnused)); unused.hidden = !showUnused;
    for (const card of data.unused) state.buttons.delete(`pricing:model:${card.id}`);
    unused.replaceChildren(...(showUnused ? [modelGrid(data.unused, data, state, rateCard)] : []));
  };
  toggle.addEventListener?.("click", () => { showUnused = !showUnused; renderUnused(); });
  if (data.unused.length) { renderUnused(); panel.append(toggle, unused); }
  container.append(panel);
}
