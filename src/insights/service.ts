import type { MachineAnalytics, SessionAnalytics } from "../types.ts";
import type { Insight, InsightContext, InsightsReport } from "./types.ts";
import { buildInsights } from "./engine.ts";

export interface InsightFilter { repositoryId?: string; from?: string; through?: string }

export function filterInsightSessions(snapshot: MachineAnalytics, filter: InsightFilter): SessionAnalytics[] {
  for (const value of [filter.from, filter.through]) {
    if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) throw new Error("Invalid insights date window.");
  }
  if (filter.from && filter.through && filter.from > filter.through) throw new Error("Invalid insights date window.");
  if (filter.repositoryId && !snapshot.repositories.some((r) => r.repository.id === filter.repositoryId)) throw new Error("Invalid insights repository selection.");
  const from = filter.from ? Date.parse(`${filter.from}T00:00:00Z`) : -Infinity;
  const until = filter.through ? Date.parse(`${filter.through}T00:00:00Z`) + 86_400_000 : Infinity;
  return snapshot.sessions.filter((session) => {
    const start = Date.parse(session.createdAt);
    return (!filter.repositoryId || session.repositoryId === filter.repositoryId) &&
      ((!filter.from && !filter.through) || (Number.isFinite(start) && start >= from && start < until));
  });
}

export function insightsForSnapshot(snapshot: MachineAnalytics, context: InsightContext, filter: InsightFilter = {}): InsightsReport {
  const result = buildInsights(filterInsightSessions(snapshot, filter), context, snapshot.generatedAt);
  const invalidStarts = snapshot.sessions.filter((s) => (!filter.repositoryId || s.repositoryId === filter.repositoryId) && !Number.isFinite(Date.parse(s.createdAt))).length;
  if (invalidStarts) result.warnings.push(`${invalidStarts} sessions have invalid or missing start timestamps; ${filter.from || filter.through ? "excluded by the UTC date filter" : "retained without a date filter and excluded from time patterns"}.`);
  return result;
}

const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 3 });
const amount = (impact: Insight["estimatedImpact"]) => impact.value === null ? "unavailable" : `${number(impact.value)} ${impact.unit}`;
const evidenceText = (e: Insight["evidence"][number]) => `${e.label}: ${number(e.value)}${e.unit === "USD" || e.unit === "tokens" ? ` ${e.unit}` : ""}${e.denominator !== null ? ` / ${number(e.denominator)} ${e.denominatorLabel}` : ""}${e.unit === "ratio" && e.denominator ? ` (${(e.value / e.denominator * 100).toFixed(1)}%)` : e.unit === "multiple" && e.denominator ? ` (${(e.value / e.denominator).toFixed(1)}×)` : ""}`;

/** Narrow findings only after evaluating peers and denominators. */
export function selectInsightRule(report: InsightsReport, rule: string | undefined): InsightsReport {
  if (!rule) return report;
  if (!report.coverage.some((row) => row.rule === rule)) throw new Error("Invalid insights rule.");
  return { ...report, groups: report.groups.filter((group) => group.rule === rule), items: report.items.filter((item) => item.rule === rule), coverage: report.coverage.filter((row) => row.rule === rule) };
}

export function formatInsights(report: InsightsReport, allScopes = false): string {
  const lines = ["Measured insights · content-free · grouped rules", `Generated: ${report.generatedAt} · rate card ${report.rateCardEffectiveDate}`, "API-equivalent value is not an invoice. Rules overlap; do not sum group estimates.", `${report.groups.length} distinct insights · ${report.items.length} scope findings`, ""];
  const byId = new Map(report.items.map((item) => [item.id, item]));
  for (const [index, group] of report.groups.entries()) {
    lines.push(`${index + 1}. ${group.title} [${group.rule}; ${group.scopeKind}; ${group.confidence} confidence]`,
      `  ${group.estimatedImpact.label}: ${amount(group.estimatedImpact)}.`,
      `  Affected: ${group.affected.repositories}/${group.coverage.totalRepositories} repositories; ${group.affected.sessions}/${group.coverage.totalSessions} sessions. Rule evidence: ${group.coverage.eligibleSessions}/${group.coverage.totalSessions} eligible sessions.`,
      `  Quantified scopes: ${group.impactCoverage.quantifiedItems}/${group.impactCoverage.totalItems}.`);
    const items = group.itemIds.map((id) => byId.get(id)!);
    for (const item of allScopes ? items : items.slice(0, 3)) {
      const scope = [item.scope.repositoryId, item.scope.sessionKey, item.scope.provider].filter(Boolean).join(" · ") || "machine";
      lines.push(`    ${scope} · ${amount(item.estimatedImpact)} · ${item.confidence} confidence · ${item.coverage.eligibleSessions}/${item.coverage.totalSessions} eligible sessions`);
      if (item.pricing) lines.push(`      ${item.pricing.strategy}: ${item.pricing.transitions.map((move) => `${move.sourceModel} → ${move.targetModel}`).join("; ")}`);
      if (item.names.length && !item.pricing) lines.push(`      Names: ${item.names.join(", ")}`);
      if (allScopes) {
        for (const e of item.evidence) lines.push(`      ${evidenceText(e)}`);
        lines.push(`      Estimate: ${item.estimatedImpact.label}.`, `      Note: ${item.guardrail}`);
      } else if (item.evidence[0]) lines.push(`      ${evidenceText(item.evidence[0])}`);
    }
    if (!allScopes && items.length > 3) lines.push(`    … ${items.length - 3} more scopes. Use --rule ${group.rule} --all-scopes, or --repo-id KEY.`);
    for (const note of group.guardrails) lines.push(`  Note: ${note}`);
    lines.push(`  Action: ${group.suggestedAction}`, "");
  }
  if (!report.groups.length) lines.push("No signals met the thresholds. This is not an assessment of quality or success.", "");
  if (!allScopes) lines.push("Use --rule RULE --all-scopes for every ranked scope, denominator and guardrail; --json returns groups and items.", "");
  lines.push("Rule coverage (eligible/selected sessions)");
  for (const row of report.coverage) lines.push(`  ${row.rule}: ${row.status}; ${row.eligibleSessions}/${row.totalSessions}; ${row.groups} groups / ${row.findings} scope findings`);
  lines.push(...report.warnings.map((warning) => `Note: ${warning}`));
  return `${lines.join("\n")}\n`;
}
