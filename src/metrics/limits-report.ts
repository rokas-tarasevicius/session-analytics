import type { MachineAnalytics } from "../types.ts";
import { emptyCache, emptyContext } from "./cache-context.ts";
import { MIN_INPUT_TOKENS, MIN_REQUESTS } from "./limits-utils.ts";

const percent = (value: number | null) => value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const number = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export function limitsCacheReport(snapshot: MachineAnalytics): string {
  const analytics = snapshot.limitsCache;
  if (!analytics) return "";
  const lines = ["", "Limits & cache", "Account-wide limits · observations, not a live quota check"];
  for (const profile of analytics.profiles) {
    lines.push(`${profile.label}: ${profile.limitHitCount} observed limit events; ${profile.sessionsWithLimitErrors} sessions with request-limit errors`);
    for (const window of profile.windows) {
      const headroom = window.headroomPercent === null ? `N/A${window.stale ? " (stale)" : " (no numeric evidence)"}` : `${window.headroomPercent.toFixed(1)}%`;
      lines.push(`  ${window.label}${window.windowMinutes ? ` · ${window.windowMinutes}m window` : ""}: headroom ${headroom}; numeric observation ${window.latestNumeric?.timestamp ?? "unavailable"}; expires ${window.headroomExpiresAt ?? "unknown"}; latest evidence ${window.latest.timestamp}; reset ${window.latest.resetsAt ?? "unknown"}`);
      lines.push(`    ≥90%: ${percent(window.shareAbove90)} of ${window.observedMinutes.toFixed(1)} observed minutes (${window.observations} snapshots); projected time to limit ${window.timeToLimitMinutes === null ? "N/A" : `${window.timeToLimitMinutes.toFixed(1)}m from last snapshot`}`);
      if (window.historyLimited) lines.push("    History limited to the latest 20,000 observations.");
    }
    if (!profile.windows.length) lines.push("  No quota snapshots available.");
  }
  if (!analytics.profiles.length) lines.push("No supported quota evidence available.");
  const cache = emptyCache(), context = emptyContext();
  for (const session of snapshot.sessions) {
    const economics = session.limitsCache;
    if (!economics) continue;
    for (const key of Object.keys(cache) as Array<keyof typeof cache>) cache[key] += economics.cache[key];
    for (const key of Object.keys(context) as Array<keyof typeof context>) {
      if (key === "peakFill") {
        if (economics.context.peakFill !== null) context.peakFill = Math.max(context.peakFill ?? 0, economics.context.peakFill);
      } else context[key] += economics.context[key];
    }
  }
  const hitRatio = cache.requests >= MIN_REQUESTS && cache.inputTokens >= MIN_INPUT_TOKENS ? cache.cacheReadTokens / cache.inputTokens : null;
  lines.push(`Cache reads: ${percent(hitRatio)} · ${number(cache.cacheReadTokens)}/${number(cache.inputTokens)} input tokens, ${cache.requests} requests`);
  lines.push(`No-cache comparison: ${cache.pricedRequests ? money(cache.netSavingsUsd) : "N/A"} net input savings · ${cache.pricedRequests}/${cache.requests} requests priced; writes included, negative savings possible`);
  lines.push(`Cache-break flags: ${cache.breakRequests} requests (${cache.reportedBreaks} provider-reported, ${cache.heuristicBreaks} heuristic; may overlap); ${cache.pricedBreakRequests || !cache.breakRequests ? money(cache.recacheWriteUsd) : "N/A"} write value on flagged requests (${cache.pricedBreakRequests}/${cache.breakRequests} priced)`);
  lines.push(`Context: peak ${percent(context.peakFill)}; >40/60/80%: ${[context.above40, context.above60, context.above80].map((value) => percent(context.eligibleRequests >= MIN_REQUESTS ? value / context.eligibleRequests : null)).join(" / ")} · ${context.eligibleRequests}/${context.requests} requests with known windows`);
  lines.push(`  ${context.reportedWindowRequests} recorded windows, ${context.reviewedWindowRequests} reviewed model capacities (harness budgets may differ). Flags do not establish cause or quality.`);
  const compactions = snapshot.sessions.flatMap((s) => s.limitsCache?.compactions ?? []);
  if (snapshot.sessions.some((s) => s.limitsCache?.compactionCountExact === false)) lines.push("Some compaction counts are uncertain: boundary identity or timestamp evidence is incomplete.");
  lines.push(`Compaction detail: ${compactions.filter((c) => c.preTokens !== null && c.postTokens !== null).length}/${compactions.length} retained boundaries with pre/post sizes; ${compactions.filter((c) => c.turnsSincePrevious !== null).length} with turn intervals`);
  lines.push("Subscription comparison · API-equivalent value, not an invoice or money saved");
  for (const row of analytics.subscriptions) {
    const label = analytics.profiles.find((p) => p.key === row.profileKey)?.label ?? "Profile";
    lines.push(`  ${label} ${row.month}: ${money(row.apiEquivalentUsd)} / ${row.monthlyPriceUsd === null ? "plan price not configured" : `${money(row.monthlyPriceUsd)} monthly plan`}; ${row.leverage === null ? "N/A" : `${row.leverage.toFixed(2)}×`}; ${percent(row.pricingCoverage)} priced (${number(row.pricedTokens)}/${number(row.observedTokens)} tokens), ${row.activeDays} active days${row.partialMonth ? ", month in progress" : ""}${row.scope === "selected-repository" ? ", selected repository only" : ""}`);
  }
  if (!analytics.subscriptions.some((row) => row.monthlyPriceUsd !== null)) lines.push("  Set limitsCache.profiles in data-dir config.json to compare against your own monthly USD plan prices.");
  lines.push("Observed history can be incomplete. No monthly extrapolation; ratios require minimum activity.");
  for (const warning of analytics.warnings) lines.push(`  ${warning}`);
  return `${lines.join("\n")}\n`;
}
