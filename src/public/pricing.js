import { projectModelId } from "./model-id.js";
import { DASH, dataTable, el, evidence, kpi, note } from "./ui.js";

const date = (value) => value ? new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Not cached";
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

/** Prices shown here are the evidence used by the selected sessions, including mixed historical rates. */
export function renderPricingPanel(container, rateCard, sessions) {
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
  const apiSessions = sessions.filter(({ costBasis }) => costBasis === "api-list-price-equivalent");
  const models = new Map();
  let tokens = 0, pricedTokens = 0;
  for (const session of apiSessions) {
    for (const usage of session.models) {
      const count = usage.pricingCoverage?.eligibleTokens ?? usage.inputTokens + usage.outputTokens;
      tokens += count; pricedTokens += usage.pricingCoverage?.pricedTokens ?? (usage.priced ? count : 0);
      const model = projectModelId(usage.model);
      const existing = models.get(model) ?? { priced: true, provenance: new Map() };
      existing.priced &&= usage.priced;
      for (const provenance of usage.pricing ?? []) existing.provenance.set(JSON.stringify(provenance), provenance);
      models.set(model, existing);
    }
  }
  cards.append(kpi({ label: "Selected token coverage", value: tokens ? `${(100 * pricedTokens / tokens).toFixed(1)}%` : null, reason: tokens ? null : "No API-priced tokens in this selection", note: tokens ? `${pricedTokens.toLocaleString("en-GB")} / ${tokens.toLocaleString("en-GB")} observed tokens` : "Provider-reported values do not use a rate card", accent: true }));
  cards.append(kpi({ label: "Price policy", value: status.policy === "reviewed-only" ? "Pinned" : status.offline ? "Offline" : "Live", note: `${mode} · reviewed card effective ${rateCard.effectiveDate}` }));
  container.append(cards);
  container.append(evidence([
    "API-equivalent value is not an invoice. Each request uses the newest snapshot at or before its timestamp; earlier requests use the oldest available evidence, labelled below.",
    "Coverage counts explicit token-class rates; substituted cache rates are excluded. Provider-reported values are excluded.",
    status.policy === "reviewed-only" ? "The selected reviewed card is pinned. Public pricing sources are bypassed."
      : status.offline ? "Offline mode prevents public pricing requests. Run rates update with offline mode disabled when you want fresh evidence."
      : "The dashboard checks for stale prices after startup. Refresh snapshot after that update to apply it, or run session-analytics rates update.",
  ]));
  const panel = el("article", null, "panel detail-panel");
  const header = el("header"), block = el("div");
  block.append(el("p", "Rates used by selected models", "kicker"), el("h3", "Model prices and historical evidence for the current filters"));
  header.append(block); panel.append(header);
  if (!models.size) {
    panel.append(note("No API-priced model usage in this selection. Provider-reported values do not use a rate card.", "empty-line"));
    container.append(panel); return;
  }
  const rows = [];
  for (const [model, usage] of [...models.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const entries = [...usage.provenance.values()];
    if (!usage.priced || !entries.length) entries.push(null);
    for (const provenance of entries) {
      const selection = !provenance ? "Incomplete token-class coverage" : provenance.temporal === "oldest" ? "Oldest available (later than request)"
        : provenance.temporal === "undated" ? "Latest; request time unavailable" : "At or before request";
      rows.push([model, provenance ? `${provenance.source} / ${provenance.kind}` : entries.length > 1 ? "Some tokens use estimated or unavailable rates" : "No matching rate",
        provenance ? date(provenance.snapshotDate) : DASH, selection,
        provenance?.assumptions.map((code) => assumptionLabels[code] ?? "Derived cache rate").join("; ") || "None"]);
    }
  }
  panel.append(dataTable([{ text: "Model", align: "left" }, { text: "Source / kind", align: "left" }, { text: "Snapshot", align: "left" }, { text: "Selection", align: "left" }, { text: "Assumptions", align: "left" }], rows, { className: "pricing-rates" }));
  container.append(panel);
}
