import type { MachineAnalytics, SessionAnalytics } from "../types.ts";
import type { InsightContext, InsightsReport } from "./types.ts";
import { buildInsights } from "./engine.ts";

export interface InsightFilter { repositoryId?: string; from?: string; through?: string }

export function filterInsightSessions(snapshot: MachineAnalytics, filter: InsightFilter): SessionAnalytics[] {
  for (const value of [filter.from, filter.through]) {
    if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) throw new Error("Invalid insights date window.");
  }
  if (filter.from && filter.through && filter.from > filter.through) throw new Error("Invalid insights date window.");
  if (filter.repositoryId && !snapshot.repositories.some((r) => r.repository.id === filter.repositoryId)) throw new Error("Invalid insights repository selection.");
  return snapshot.sessions.filter((session) => {
    const day = session.createdAt.slice(0, 10);
    return (!filter.repositoryId || session.repositoryId === filter.repositoryId) && (!filter.from || day >= filter.from) && (!filter.through || day <= filter.through);
  });
}

export function insightsForSnapshot(snapshot: MachineAnalytics, context: InsightContext, filter: InsightFilter = {}): InsightsReport {
  return buildInsights(filterInsightSessions(snapshot, filter), context, snapshot.generatedAt);
}

export function formatInsights(report: InsightsReport): string {
  const lines = ["Measured insights · content-free", `Generated: ${report.generatedAt} · rate card ${report.rateCardEffectiveDate}`, "API-equivalent value is not an invoice. Estimates overlap; do not sum them.", ""];
  for (const card of report.cards) {
    const scope = card.scope.sessionKey ?? card.scope.repositoryId ?? "machine";
    lines.push(`${card.title} [${card.confidence} confidence; ${scope}${card.scope.provider ? `; ${card.scope.provider}` : ""}]`);
    for (const e of card.evidence) lines.push(`  ${e.label}: ${e.value.toLocaleString("en-US", { maximumFractionDigits: 3 })}${e.unit === "USD" || e.unit === "tokens" ? ` ${e.unit}` : ""}${e.denominator !== null ? ` / ${e.denominator.toLocaleString("en-US", { maximumFractionDigits: 3 })} ${e.denominatorLabel}` : ""}${e.unit === "ratio" && e.denominator ? ` (${(e.value / e.denominator * 100).toFixed(1)}%)` : e.unit === "multiple" && e.denominator ? ` (${(e.value / e.denominator).toFixed(1)}×)` : ""}`);
    lines.push(`  Coverage: ${card.coverage.eligibleSessions}/${card.coverage.totalSessions} selected sessions.`, `  ${card.estimatedImpact.label}: ${card.estimatedImpact.value === null ? "unavailable" : `${card.estimatedImpact.value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${card.estimatedImpact.unit}`}.`);
    if (card.names.length) lines.push(`  Names: ${card.names.join(", ")}`);
    lines.push(`  Note: ${card.guardrail}`, `  Action: ${card.suggestedAction}`, "");
  }
  if (!report.cards.length) lines.push("No cards met the thresholds. This is not an assessment of quality or success.", "");
  lines.push("Rule coverage (eligible/selected sessions)");
  for (const row of report.coverage) lines.push(`  ${row.rule}: ${row.status}; ${row.eligibleSessions}/${row.totalSessions}; ${row.findings} cards`);
  lines.push(...report.warnings.map((warning) => `Note: ${warning}`));
  return `${lines.join("\n")}\n`;
}
