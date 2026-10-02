const element = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
};
const date = (value) => value ? new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Not cached";
const assumptionLabels = {
  "anthropic-cache-1h-2x": "1-hour cache write: 2× input",
  "codex-cache-write-upper-1.25x": "Cache-write upper estimate: 1.25× input",
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
  if (!status) { container.append(element("p", "Pricing source details are unavailable for this snapshot.")); return; }
  const mode = status.policy === "reviewed-only" ? "Pinned reviewed card" : status.offline ? "Offline · cached prices" : "Public price updates enabled";
  container.append(element("p", `${mode}. Reviewed card effective ${rateCard.effectiveDate}.`, "chart-note"));
  if (status.stale || status.warnings.length) {
    const warning = element("aside", undefined, "warning-banner");
    warning.setAttribute("role", "status");
    warning.append(element("strong", status.stale ? "Pricing evidence needs a refresh" : "Pricing evidence has warnings"));
    warning.append(element("p", status.stale
      ? `A source is missing or older than ${status.refreshAfterDays} days. Cached and reviewed rates remain usable.`
      : "Some fetched rates were rejected or changed substantially. Inspect rates diff for details."));
    if (status.warnings.length) warning.append(element("p", status.warnings.map((code) => warningLabels[code] ?? "Pricing evidence is incomplete.").join(" ")));
    container.append(warning);
  }
  const cards = element("div", undefined, "metric-grid compact-metrics");
  for (const source of status.policy === "reviewed-only" ? [] : status.sources) {
    const card = element("article", undefined, "metric-card");
    card.append(element("span", source.source), element("strong", source.ageDays === null ? "No cache" : `${source.ageDays.toFixed(1)}d`));
    card.append(element("small", `${source.models} models · ${source.stale ? "stale or missing" : "current"}`));
    card.append(element("small", date(source.fetchedAt)));
    const link = element("a", "Public price list ↗");
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
      const existing = models.get(usage.model) ?? { priced: true, provenance: new Map() };
      existing.priced &&= usage.priced;
      for (const provenance of usage.pricing ?? []) existing.provenance.set(JSON.stringify(provenance), provenance);
      models.set(usage.model, existing);
    }
  }
  const coverage = element("article", undefined, "metric-card");
  coverage.append(element("span", "Selected token coverage"), element("strong", tokens ? `${(100 * pricedTokens / tokens).toFixed(1)}%` : "N/A"),
    element("small", `${pricedTokens.toLocaleString("en-GB")} / ${tokens.toLocaleString("en-GB")} observed tokens`),
    element("small", "Claude + Codex; provider-reported values excluded"));
  cards.append(coverage); container.append(cards);
  container.append(element("p", "API-equivalent value is not an invoice. Each request uses the newest snapshot at or before its timestamp. Earlier requests use the oldest available evidence, labeled below.", "chart-note"));
  container.append(element("p", status.policy === "reviewed-only" ? "The selected reviewed card is pinned. Public pricing sources are bypassed."
    : status.offline ? "Offline mode prevents public pricing requests. Run rates update with offline mode disabled when you want fresh evidence."
    : "The dashboard checks for stale prices after startup. Refresh snapshot after that update to apply it, or run session-analytics rates update.", "chart-note"));
  const panel = element("article", undefined, "panel detail-panel");
  panel.append(element("h3", "Rates used by selected models"));
  if (!models.size) {
    panel.append(element("p", "No API-priced model usage in this selection. Provider-reported values do not use a rate card.", "chart-note"));
    container.append(panel); return;
  }
  const wrap = element("div", undefined, "table-wrap"), table = element("table");
  const caption = element("caption", "Model prices and historical evidence for the current filters");
  const head = element("thead"), heading = element("tr");
  for (const title of ["Model", "Source / kind", "Snapshot", "Selection", "Assumptions"]) {
    const cell = element("th", title); cell.scope = "col"; heading.append(cell);
  }
  head.append(heading); table.append(caption, head);
  const body = element("tbody");
  for (const [model, usage] of [...models.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const entries = [...usage.provenance.values()];
    if (!usage.priced || !entries.length) entries.push(null);
    for (const provenance of entries) {
      const row = element("tr");
      const selection = !provenance ? "Unpriced" : provenance.temporal === "oldest" ? "Oldest available (later than request)"
        : provenance.temporal === "undated" ? "Latest; request time unavailable" : "At or before request";
      for (const value of [model, provenance ? `${provenance.source} / ${provenance.kind}` : "No matching rate",
        provenance ? date(provenance.snapshotDate) : "—", selection,
        provenance?.assumptions.map((code) => assumptionLabels[code] ?? "Derived cache rate").join("; ") || "None"]) row.append(element("td", value));
      body.append(row);
    }
  }
  table.append(body); wrap.append(table); panel.append(wrap); container.append(panel);
}
