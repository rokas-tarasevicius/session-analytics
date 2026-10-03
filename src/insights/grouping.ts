import { createHash } from "node:crypto";
import type { SessionAnalytics } from "../types.ts";
import type { Insight, InsightGroup, InsightRule } from "./types.ts";

const titles: Record<InsightRule, string> = {
  "session-outlier": "Sessions above their repository baselines",
  "cache-waste": "Low cache reuse across repositories",
  "model-pricing": "Model price scenarios",
  "compaction-heavy": "Repositories with frequent compaction",
  "subagent-share": "Sessions with unusually high delegation shares",
  "long-context": "Repositories with recurring large contexts",
  "unused-skills": "Installed skills without observed invocations",
  "unused-mcp": "Configured MCP servers without confirmed calls",
  "idle-cache": "Cache writes after gaps beyond the recorded TTL",
  "time-pattern": "Session starts cluster in one time window",
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);

/** USD, tokens and unavailable estimates are separate bands, never convertible scores. */
export function compareImpact(a: Pick<Insight, "estimatedImpact" | "id">, b: Pick<Insight, "estimatedImpact" | "id">): number {
  const band = (item: typeof a) => item.estimatedImpact.value === null ? 2 : item.estimatedImpact.unit === "USD" ? 0 : 1;
  return band(a) - band(b) || (b.estimatedImpact.value ?? 0) - (a.estimatedImpact.value ?? 0) || a.id.localeCompare(b.id);
}

/** Contributor identities remain internal. Only distinct counts and existing item IDs leave here. */
export function groupInsights(items: Insight[], selected: SessionAnalytics[], contributors: ReadonlyMap<string, SessionAnalytics[]>, eligible: ReadonlyMap<InsightRule, Set<string>>): InsightGroup[] {
  const buckets = new Map<string, Insight[]>();
  for (const item of items) {
    const key = `${item.rule}:${item.scope.kind}`, bucket = buckets.get(key) ?? [];
    bucket.push(item); buckets.set(key, bucket);
  }
  const totalRepositories = new Set(selected.map((s) => s.repositoryId)).size;
  return [...buckets.values()].map((bucket): InsightGroup => {
    bucket.sort(compareImpact);
    const first = bucket[0]!, repositories = new Set<string>(), sessions = new Set<string>();
    for (const item of bucket) for (const s of contributors.get(item.id) ?? []) {
      repositories.add(s.repositoryId); sessions.add(s.sessionKey);
    }
    const quantified = bucket.filter((item) => item.estimatedImpact.value !== null);
    // Every current rule uses one additive unit/basis and disjoint item scopes. Fail closed
    // if a future rule mixes units/bases rather than silently inventing a total.
    const reference = quantified[0]?.estimatedImpact ?? first.estimatedImpact;
    const comparable = quantified.every((item) => item.estimatedImpact.unit === reference.unit && item.estimatedImpact.basis === reference.basis);
    const value = comparable && quantified.length ? quantified.reduce((sum, item) => sum + item.estimatedImpact.value!, 0) : null;
    const strategies = new Set(bucket.map((item) => item.pricing?.strategy));
    const title = first.rule !== "model-pricing" ? titles[first.rule] : strategies.size === 1
      ? strategies.has("next-tier-down") ? "Next-tier-down model price scenarios" : "Configured-target model price scenarios"
      : "Model price scenarios (next tier down and configured targets)";
    return {
      id: `insight-group-${hash([first.rule, first.scope.kind])}`,
      ruleDecisionId: `insight-rule-${hash(first.rule)}`,
      rule: first.rule, scopeKind: first.scope.kind, title,
      itemIds: bucket.map((item) => item.id),
      affected: { repositories: repositories.size, sessions: sessions.size },
      coverage: { eligibleSessions: eligible.get(first.rule)?.size ?? 0, totalSessions: selected.length, totalRepositories },
      estimatedImpact: {
        value, unit: reference.unit, basis: value === null ? "unavailable" : reference.basis,
        label: value === null ? "Impact unavailable; see scope evidence" : `Total across ${quantified.length === bucket.length ? "affected" : "quantified"} scopes: ${reference.label}`,
      },
      impactCoverage: { quantifiedItems: quantified.length, totalItems: bucket.length },
      confidence: bucket.some((item) => item.confidence === "low") ? "low" : bucket.some((item) => item.confidence === "medium") ? "medium" : "high",
      guardrails: [...new Set(bucket.map((item) => item.guardrail))].sort(),
      suggestedAction: first.suggestedAction,
    };
  }).sort(compareImpact);
}
