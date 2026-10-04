const money = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
const count = (n) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

export function renderHistoryCoverage(container, history, sessions = []) {
  if (!container) return;
  container.replaceChildren(); container.hidden = !history;
  if (!history) return;
  const header = node("header", undefined, "section-header"), title = node("div");
  title.append(node("p", "Evidence · machine-wide · all months", "kicker"), node("h2", "History coverage"));
  header.append(title); container.append(header);
  container.append(node("p", "Session evidence and unattributed history stay separate. This machine-wide panel is independent of repository and date filters. API-equivalent value is not an invoice.", "chart-note"));
  const wrap = node("div", undefined, "table-wrap"), table = node("table"), head = node("thead"), headings = node("tr"), body = node("tbody");
  for (const text of ["UTC month", "Dated session evidence", "Unattributed estimate", "Remainder counters priced", "Possible overlap reserved"]) headings.append(node("th", text));
  head.append(headings);
  for (const month of [...history.months].reverse()) {
    const row = node("tr");
    for (const value of [month.month, month.sessionsWithDatedValue ? `${money(month.sessionEvidenceUsd)} · ${month.sessionsWithDatedValue} sessions` : "N/A", !month.statisticsCells || month.unattributedTokens && !month.pricedUnattributedTokens ? "N/A" : money(month.unattributedEstimateUsd),
      month.statisticsCells ? `${count(month.pricedUnattributedTokens)} / ${count(month.unattributedTokens)}` : "Unavailable", `${count(month.possibleOverlapTokens)} tokens`]) row.append(node("td", value));
    body.append(row);
  }
  table.append(head, body); wrap.append(table); container.append(wrap);
  const available = history.profiles.filter((p) => p.status === "available").length;
  container.append(node("p", `${available}/${history.profiles.length} Claude profiles have comparable statistics. ${money(history.undatedSessionValueUsd)} of session value has no request day, including result-only summaries. Missing statistics are unavailable, not zero usage.`, "chart-note"));
  const details = node("details"), summary = node("summary", "Method, retention and profile coverage"); details.append(summary);
  details.append(node("p", "We subtract same-profile stream counters from provider totals per UTC day and model, with a zero floor. Unknown-profile Conductor usage reserves possible overlap once across profiles. The remainder is priced using each model’s lifetime token proportions, ordinary rates and default cache-write TTL. Historical mix and request sizes are unknown. Claude v5 statistics repeat input across streamed blocks; remaining counters can overstate missing billable tokens. These estimates are not added to session or repository totals.", "chart-note"));
  details.append(node("p", "Provider retention can remove older transcripts while aggregate statistics survive. The earliest present transcript date is an evidence boundary, not proof of when work began.", "chart-note"));
  for (const profile of history.profiles) {
    details.append(node("p", `Claude profile ${profile.ordinal} · ${profile.status} statistics${profile.statisticsThrough ? ` through ${profile.statisticsThrough}` : ""} · earliest present transcript ${profile.firstTranscriptDay ?? "unavailable"} · earliest statistics ${profile.firstStatisticsDay ?? "unavailable"}`, "chart-note"));
    if (profile.sessionsWithoutStatisticsCounters) details.append(node("p", `${profile.sessionsWithoutStatisticsCounters} indexed sessions lack stream counters; gaps may include known streamed blocks.`, "chart-note"));
    for (const month of profile.months) for (const model of month.models) details.append(node("p", `${month.month} · ${model.model}: ${count(model.sessionStatisticsTokens)} / ${count(model.providerTokens)} session / provider stream counters (${count(model.sessionTokens)} deduplicated session tokens) over ${model.statisticsDays} reported days; ${count(model.unattributedTokens)} unattributed after overlap reservation.`, "chart-note"));
  }
  const comparisons = sessions.flatMap((session) => session.conductor?.reconciliation ? [session.conductor.reconciliation] : []);
  if (comparisons.length) details.append(node("p", `Conductor receipt comparison: ${comparisons.filter((r) => r.status === "agrees").length}/${comparisons.length} recovered sessions agree within max($0.01, 1%); ${comparisons.filter((r) => r.status === "differs").length} differ, ${comparisons.filter((r) => r.status === "partial").length} partial, ${comparisons.filter((r) => r.status === "unavailable").length} unavailable. Agreement does not prove complete retained history.`, "chart-note"));
  container.append(details);
}
