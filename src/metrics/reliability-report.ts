import { errorDenominator, errorRate, summarizeReliability, summarizeReliabilityComparisons } from "../public/reliability-data.js";
import type { SessionAnalytics } from "../types.ts";
import type { ReliabilityStats } from "./reliability-types.ts";

const integer = (value: number): string => value.toLocaleString("en");
const ms = (value: number | null): string => value === null ? "N/A" : `~${integer(Math.round(value))}ms`;
function errors(stats: ReliabilityStats): string {
  const n = stats.outcomes.error + stats.outcomes.timeout, d = errorDenominator(stats), rate = errorRate(stats);
  return `${rate === null ? "N/A (<5 attempts)" : `${(rate * 100).toFixed(1)}%`} [${n}/${d}]`;
}
export function reliabilityReport(sessions: SessionAnalytics[]): string {
  const value = summarizeReliability(sessions), totals = value.totals;
  const comparisons = summarizeReliabilityComparisons(sessions);
  const known = totals.calls - totals.outcomes.unknown;
  const lines = [
    "", "Reliability · observed tool evidence",
    `Coverage: ${value.coveredSessions}/${value.sessions} sessions; outcomes ${known}/${totals.calls} calls; timing ${totals.latency.samples}/${totals.calls} calls. Cursor: unavailable.`,
    `Errors: ${errors(totals)}; denied ${totals.outcomes.denied}; interrupted ${totals.outcomes.interrupted}; timeouts ${totals.outcomes.timeout}.`,
    `Local content rules (P2): ${value.contentRuleSessions}/${value.coveredSessions} sessions; hash-based flags ${value.flagSessions}/${value.coveredSessions}.`,
    "Tool / class                         Calls   Errors [failed/attempted]    p50 / p95 [timed/calls]",
  ];
  for (const tool of value.tools.slice(0, 20)) {
    const top = Object.entries(tool.errors).sort((a, b) => b[1]! - a[1]!).slice(0, 3).map(([kind, n]) => `${kind}:${n}`).join(", ");
    lines.push(`${`${tool.name} / ${tool.toolClass}`.padEnd(36)} ${String(tool.calls).padStart(5)}   ${errors(tool)}   ${ms(tool.latency.p50Ms)} / ${ms(tool.latency.p95Ms)} [${tool.latency.samples}/${tool.calls}]${top ? ` · ${top}` : ""}`);
  }
  lines.push("Normalized tool classes (calls, errors, p50/p95)");
  for (const group of value.classes) lines.push(`  ${group.toolClass}: ${group.calls} calls; ${errors(group)}; ${ms(group.latency.p50Ms)} / ${ms(group.latency.p95Ms)} [${group.latency.samples}/${group.calls} timed]`);
  lines.push("MCP servers (calls, errors, p95, connection failures)");
  if (!value.mcp.length) lines.push("  No MCP server evidence.");
  for (const server of value.mcp) lines.push(`  ${server.server}: ${server.calls} calls; ${errors(server)}; ${ms(server.latency.p95Ms)} [${server.latency.samples}/${server.calls} timed]; ${server.connectionFailures} connection failures`);
  lines.push(`Flags: ${value.flagSessions ? Object.entries(value.flags).map(([key, n]) => `${key} ${n}`).join("; ") : "N/A (enable --reliability-content-rules for local detectors)"}.`);
  const v = value.verification;
  lines.push(`Verification share: ${v.share === null ? "N/A" : `${(v.share * 100).toFixed(1)}%`} [${v.checks}/${v.checks + v.editCalls} check + edit calls]; checks passed ${v.passed}, failed ${v.failed}.`);
  lines.push(`Verification skips: ${v.skippedSessions}/${v.eligibleSessions} eligible edited sessions; first edit mean ${v.stepsToFirstEdit === null ? "N/A" : v.stepsToFirstEdit.toFixed(1)} preceding calls [${v.firstEditSessions} sessions].`);
  lines.push(`Time to first edit mean: ${ms(v.msToFirstEdit)} [${v.timedEditSessions} timed main transcripts]. Argument matching: ${sessions.reduce((n, s) => n + (s.reliability?.coverage.argumentCalls ?? 0), 0)}/${totals.calls} calls; file matching: ${sessions.reduce((n, s) => n + (s.reliability?.coverage.fileCalls ?? 0), 0)}/${totals.calls} calls.`);
  lines.push(`Hooks: ${value.hooks.runs} runs; ${value.hooks.blocks} blocking summaries; p95 ${ms(value.hooks.latency.p95Ms)} [${value.hooks.latency.samples}/${value.hooks.runs} timed].`);
  for (const [label, mix] of [["Permission modes", value.permissions.modes], ["Approval policies", value.permissions.approvalPolicies], ["Sandboxes", value.permissions.sandboxes], ["API error events", value.apiErrors]] as const) lines.push(`${label}: ${Object.entries(mix).map(([key, n]) => `${key} ${n}`).join(", ") || "unavailable"}.`);
  lines.push("By agent (outcome coverage; errors)");
  for (const summary of comparisons.providers) {
    lines.push(`  ${summary.name}: ${summary.coveredSessions}/${summary.sessions} sessions; ${summary.totals.calls - summary.totals.outcomes.unknown}/${summary.totals.calls} calls; ${errors(summary.totals)}`);
  }
  lines.push("By repository (outcome coverage; errors)");
  for (const summary of comparisons.repositories) {
    lines.push(`  ${summary.name}: ${summary.totals.calls - summary.totals.outcomes.unknown}/${summary.totals.calls} calls; ${errors(summary.totals)}`);
  }
  if (value.truncatedSessions) lines.push(`Partial evidence: ${value.truncatedSessions} sessions hit parsing or size safeguards; flags and verification are unavailable there.`);
  const unmatched = sessions.reduce((n, s) => n + (s.reliability?.coverage.unmatchedResults ?? 0), 0);
  if (unmatched) lines.push(`Unmatched results: ${unmatched}; affected sessions cannot establish complete behavior or verification.`);
  lines.push("Following verification requires a completed check that started after the final edit completed; overlap or missing sequence evidence can make status unavailable.");
  lines.push("Flags are prompts for inspection, not verdicts. Interrupts and permission choices do not establish failure. Activity and passing checks do not prove quality or value.");
  lines.push("Latency uses observed durations only; percentiles are merged bucket upper bounds (up to 10% + 1ms). Error rates exclude denials, interruptions and unknown results; fewer than 5 attempts is N/A.");
  return `${lines.join("\n")}\n`;
}
