import { integer, money, percent } from "./format.js";
import { sharedEvidenceCaveat } from "./evidence.js";
const node = (tag, text, className) => {
  const element = document.createElement(tag); if (text !== undefined) element.textContent = text;
  if (className) element.className = className; return element;
};

export const sharedHiddenSelectors = [".topbar-controls", ".view-nav", ".repo-nav", ".scope-line", "#help-button"];

export function renderSharedSnapshot(snapshot) {
  for (const selector of sharedHiddenSelectors) document.querySelector(selector).hidden = true;
  const wordmark = document.querySelector(".wordmark");
  wordmark.href = "#shared-snapshot"; wordmark.setAttribute("aria-label", "Session Analytics, Shared snapshot");
  document.querySelector("#page-title").textContent = "Shared snapshot";
  for (const panel of document.querySelectorAll("[data-view-panel]")) panel.hidden = true;
  document.querySelector("#warning-banner").hidden = true;
  document.querySelector("#rate-card-links").replaceChildren();
  const panel = document.querySelector("#shared-snapshot"); panel.hidden = false; panel.replaceChildren();
  panel.append(node("p", "SHARED SNAPSHOT", "kicker"), node("h1", "Repository aggregates"));
  panel.append(node("p", `${integer(snapshot.summary.sessions)} sessions across ${snapshot.repositories.length} repositories from ${snapshot.sources.length} disjoint sources. Every source bucket met the minimum of ${snapshot.minimumSessions} sessions.`));
  panel.append(node("p", sharedEvidenceCaveat, "chart-note"));
  panel.append(node("p", "Only included repositories contribute to these totals. Session timestamps, names, model and tool breakdowns are unavailable. The threshold counts sessions, not people, and does not guarantee anonymity.", "chart-note"));
  const wrap = node("div", undefined, "table-scroll");
  const table = node("table"); table.setAttribute("aria-label", "Shared repository aggregates");
  const head = node("thead"), heading = node("tr");
  for (const title of ["Repository", "Sessions", "API-equivalent", "Provider-reported", "Input tokens", "Output tokens", "Pricing coverage"]) heading.append(node("th", title));
  head.append(heading); table.append(head);
  const body = node("tbody");
  for (const row of snapshot.repositories) {
    const tr = node("tr");
    for (const value of [row.repository, integer(row.sessions), money(row.apiEquivalentSpendUsd), money(row.providerReportedSpendUsd), integer(row.inputTokens), integer(row.outputTokens), row.priceableTokens ? `${percent(row.pricedTokens / row.priceableTokens)} (${integer(row.pricedTokens)} / ${integer(row.priceableTokens)} tokens)` : "N/A · no priceable tokens"]) tr.append(node("td", value));
    body.append(tr);
  }
  table.append(body); wrap.append(table); panel.append(wrap);
  if (!snapshot.repositories.length) panel.append(node("p", "No repository met the sharing threshold."));
  panel.append(node("p", "API-equivalent value is not an invoice. Activity counters do not prove quality, success, or value delivered.", "chart-note"));
  document.querySelector(".skip-link").href = "#shared-snapshot";
}
