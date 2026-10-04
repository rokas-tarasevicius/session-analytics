import type { MachineAnalytics } from "../types.ts";

const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const count = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

export function historyReport(snapshot: MachineAnalytics): string {
  const history = snapshot.historyCoverage;
  if (!history) return "";
  const lines = ["", "History coverage · machine-wide, UTC months", "Session evidence and unattributed estimates are separate. API-equivalent value is not an invoice."];
  for (const month of history.months) {
    const estimate = !month.statisticsCells || month.unattributedTokens && !month.pricedUnattributedTokens ? "N/A" : money(month.unattributedEstimateUsd);
    const evidence = month.sessionsWithDatedValue ? money(month.sessionEvidenceUsd) : "N/A";
    lines.push(`${month.month}  ${evidence} dated session evidence (${month.sessionsWithDatedValue} sessions)  ${estimate} unattributed estimate  (${count(month.pricedUnattributedTokens)}/${count(month.unattributedTokens)} remainder counters priced; ${month.statisticsCells} reported day/model cells; ${count(month.possibleOverlapTokens)} possible overlap reserved)`);
  }
  if (history.undatedSessionValueUsd > 0) lines.push(`Undated session value: ${money(history.undatedSessionValueUsd)}. This includes result-only summaries and is excluded from monthly evidence.`);
  lines.push("Statistics gaps use max(0, provider minus same-profile stream counters) per UTC day/model. Unknown-profile Conductor usage reserves overlap once across profiles. Estimates use lifetime model token proportions, ordinary rates and default cache-write TTL; request sizes and historical mix are unknown. Claude v5 statistics repeat input across streamed blocks; remaining counters can overstate missing billable tokens. Estimates are not added to repository or session totals.");
  for (const profile of history.profiles) {
    lines.push(`Claude profile ${profile.ordinal}: statistics ${profile.status}${profile.statisticsThrough ? ` through ${profile.statisticsThrough}` : ""}; earliest present transcript ${profile.firstTranscriptDay ?? "unavailable"}; earliest statistics ${profile.firstStatisticsDay ?? "unavailable"}.`);
    if (profile.sessionsWithoutStatisticsCounters) lines.push(`  ${profile.sessionsWithoutStatisticsCounters} indexed sessions lack stream counters; gaps may include known streamed blocks.`);
    for (const month of profile.months) for (const model of month.models) lines.push(`  ${month.month} ${model.model}: ${count(model.sessionStatisticsTokens)}/${count(model.providerTokens)} session/provider stream counters (${count(model.sessionTokens)} deduplicated session tokens) over ${model.statisticsDays} reported days; ${count(model.unattributedTokens)} unattributed after overlap reservation.`);
  }
  lines.push("Provider transcript retention can remove older history while statistics survive. A first observed date is not proof that earlier work never happened. Missing or unsupported statistics are unavailable, not zero usage.");
  const recovered = snapshot.sessions.flatMap((s) => s.conductor?.reconciliation ? [s.conductor.reconciliation] : []);
  if (recovered.length) lines.push(`Conductor receipt comparison: ${recovered.filter((r) => r.status === "agrees").length}/${recovered.length} recovered sessions agree within max($0.01, 1%); ${recovered.filter((r) => r.status === "differs").length} differ, ${recovered.filter((r) => r.status === "partial").length} partial, ${recovered.filter((r) => r.status === "unavailable").length} unavailable. Agreement does not establish complete history.`);
  return lines.join("\n") + "\n";
}
