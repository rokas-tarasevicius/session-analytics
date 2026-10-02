import { createHash } from "node:crypto";
import { calculateCost } from "../analyzer.ts";
import type { SessionAnalytics, SessionProvider } from "../types.ts";
import { boundedName } from "./config.ts";
import { ruleIds } from "./types.ts";
import type { Insight, InsightContext, InsightRule, InsightsReport } from "./types.ts";

const sum = (sessions: SessionAnalytics[], value: (s: SessionAnalytics) => number): number => sessions.reduce((total, session) => total + value(session), 0);
function peerValues(sessions: SessionAnalytics[], value: (s: SessionAnalytics) => number): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const s of sessions) {
    const key = `${s.provider}:${s.executionKind}`, list = groups.get(key) ?? [];
    list.push(value(s)); groups.set(key, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a - b);
  return groups;
}

/** Leave one value out of a sorted cohort in O(log n); do not sort every session's peers. */
function peerMedian(sorted: number[], excluded: number): number {
  let low = 0, high = sorted.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (sorted[middle]! < excluded) low = middle + 1; else high = middle; }
  const length = sorted.length - 1, middle = Math.floor(length / 2);
  const at = (index: number) => sorted[index >= low ? index + 1 : index]!;
  return length % 2 ? at(middle) : (at(middle - 1) + at(middle)) / 2;
}
const evidence = (label: string, value: number, unit: Insight["evidence"][number]["unit"] = "count", denominator: number | null = null, denominatorLabel: string | null = null): Insight["evidence"][number] => ({ label, value, unit, denominator, denominatorLabel });
const ratio = (label: string, numerator: number, denominator: number, denominatorLabel: string) => evidence(label, numerator, "ratio", denominator, denominatorLabel);
const impact = (value: number | null, label: string, basis: Insight["estimatedImpact"]["basis"] = "associated-usage", unit: "USD" | "tokens" = "USD"): Insight["estimatedImpact"] => ({ value, unit, basis: value === null ? "unavailable" : basis, label });
const priced = (s: SessionAnalytics): boolean => s.costBasis === "api-list-price-equivalent" && s.costComplete && s.pricedTokenCoverage === 1 && s.metrics.modelCalls > 0;
const noInvoice = "API-equivalent value is not an invoice. ";

/** Content-free, deterministic rules. No I/O, transcript text or inferred outcomes. */
export function buildInsights(sessions: SessionAnalytics[], context: InsightContext, generatedAt: string): InsightsReport {
  const t = context.thresholds;
  const stable = sessions.filter((s) => s.transcript.status === "ok" && !s.transcript.snapshotWhileWorking);
  const cards: Insight[] = [];
  const eligible = new Map<InsightRule, Set<string>>(ruleIds.map((rule) => [rule, new Set()]));
  const enough = new Set<InsightRule>();
  const mark = (rule: InsightRule, items: SessionAnalytics[], sufficient: boolean): void => {
    for (const s of items) eligible.get(rule)!.add(s.sessionKey);
    if (sufficient) enough.add(rule);
  };
  const add = (rule: InsightRule, scope: Insight["scope"], peers: SessionAnalytics[] | number, total: number, detail: Omit<Insight, "id" | "rule" | "scope" | "coverage">): void => {
    if (context.disabledRules.includes(rule)) return;
    const key = JSON.stringify([rule, scope, detail.names]);
    cards.push({ id: `insight-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`, rule, scope, coverage: { eligibleSessions: typeof peers === "number" ? peers : peers.length, totalSessions: total }, ...detail });
  };
  const scope = (kind: Insight["scope"]["kind"], repositoryId: string | null = null, provider: SessionProvider | null = null, sessionKey: string | null = null): Insight["scope"] => ({ kind, repositoryId, sessionKey, provider });
  const groups = new Map<string, SessionAnalytics[]>();
  for (const session of stable) {
    const group = groups.get(session.repositoryId) ?? [];
    group.push(session); groups.set(session.repositoryId, group);
  }

  for (const [repositoryId, repo] of groups) {
    const total = sessions.filter((s) => s.repositoryId === repositoryId).length;
    for (const provider of ["claude", "codex"] as const) {
      const cohort = repo.filter((s) => s.provider === provider);
      const api = cohort.filter(priced);
      const costPeers = peerValues(api, (s) => s.cost.totalUsd);
      mark("session-outlier", api, api.some((s) => s.metrics.modelCalls >= t.minModelCalls && costPeers.get(`${s.provider}:${s.executionKind}`)!.length > t.minRepoSessions));
      // Match execution kind as well as repository/provider. Leave the candidate out of its baseline.
      for (const s of api) {
        const values = costPeers.get(`${s.provider}:${s.executionKind}`)!;
        const peers = values.length - 1;
        if (peers < t.minRepoSessions || s.metrics.modelCalls < t.minModelCalls) continue;
        const baseline = peerMedian(values, s.cost.totalUsd);
        if (baseline <= 0 || s.cost.totalUsd < t.minOutlierUsd || s.cost.totalUsd / baseline < t.outlierMultiplier) continue;
        add("session-outlier", scope("session", repositoryId, provider, s.sessionKey), peers, total, {
          title: "Session value above its repository baseline", confidence: "medium", names: [],
          evidence: [evidence("Session API-equivalent value", s.cost.totalUsd, "USD"), evidence("Median peer value", baseline, "USD"), evidence("Multiple of peer median", s.cost.totalUsd, "multiple", baseline, "USD peer median"), evidence("Baseline peer sessions", peers)],
          estimatedImpact: impact(s.cost.totalUsd - baseline, "Estimated value above the peer median; not recoverable savings"),
          guardrail: noInvoice + "Peers match repository, provider and execution kind, but task difficulty is unknown. Activity does not prove success, quality or waste.",
          suggestedAction: "Compare this session with a similar task in this repository before changing the workflow. Use the opt-in review dry-run for a closer look.",
        });
      }

      const cache = cohort.filter((s) => s.metrics.modelCalls > 0 && s.tokens.inputTokens > 0);
      const input = sum(cache, (s) => s.tokens.inputTokens), calls = sum(cache, (s) => s.metrics.modelCalls);
      const reads = sum(cache, (s) => s.tokens.cachedInputTokens), writes = sum(cache, (s) => s.tokens.cacheWriteInputTokens);
      mark("cache-waste", cache, input >= t.minInputTokens && calls >= t.minModelCalls);
      if (input >= t.minInputTokens && calls >= t.minModelCalls && reads / input < t.cacheReadShare && (provider === "codex" || writes / input >= t.cacheWriteShare)) {
        add("cache-waste", scope("repo", repositoryId, provider), cache, total, {
          title: provider === "claude" ? "Low cache reuse with heavy cache writes" : "Low observed cache reuse", confidence: "medium", names: [],
          evidence: [ratio("Cache-read share", reads, input, "processed input tokens"), ...(provider === "claude" ? [ratio("Cache-write share", writes, input, "processed input tokens")] : []), evidence("Observed model calls", calls)],
          estimatedImpact: impact(input - reads, "Estimated input exposure without cache reuse; not avoidable tokens", "associated-usage", "tokens"),
          guardrail: "New tasks and changed context can legitimately miss cache. Codex cache writes are unobserved. Repeated input is consumption, not unique text or proven waste.",
          suggestedAction: "Check whether stable instructions and tool sets can remain consistent across related requests; compare similar tasks before changing session boundaries.",
        });
      }

      const availableRates = Object.entries(context.rateCard.models).filter(([name, rate]) => boundedName(name) && rate.provider === provider && rate.inputPerMillion > 0 && rate.outputPerMillion > 0);
      const chosen = context.comparisonModels[provider];
      // Evaluate each positive priced target on the same eligible sessions. Targets with a
      // long-context threshold cannot be reconstructed from aggregate usage above that threshold.
      const comparisons = availableRates.filter(([name]) => !chosen || chosen === name).map(([name, rate]) => {
        const eligible = api.filter((s) => (!rate.longContext || s.metrics.maxInputTokensPerCall <= rate.longContext.thresholdInputTokens) && s.metrics.maxInputTokensPerCall > 0);
        const before = sum(eligible, (s) => s.cost.totalUsd);
        const after = sum(eligible, (s) => calculateCost(rate, s.tokens, 0).totalUsd);
        return { name, eligible, before, after, difference: before - after };
      }).sort((a, b) => b.difference - a.difference || a.name.localeCompare(b.name));
      const comparison = comparisons[0];
      mark("model-pricing", comparison?.eligible ?? [], Boolean(comparison && comparison.eligible.length >= t.minRepoSessions && sum(comparison.eligible, (s) => s.metrics.modelCalls) >= t.minModelCalls));
      if (comparison && comparison.eligible.length >= t.minRepoSessions && sum(comparison.eligible, (s) => s.metrics.modelCalls) >= t.minModelCalls && comparison.difference >= t.minDifferenceUsd) {
        add("model-pricing", scope("repo", repositoryId, provider), comparison.eligible, total, {
          title: "Same-token model price comparison", confidence: "high", names: [comparison.name],
          evidence: [evidence("Sessions in this scenario", comparison.eligible.length, "count", cohort.length, "provider sessions"), evidence("Current API-equivalent value", comparison.before, "USD"), evidence("Scenario API-equivalent value", comparison.after, "USD")],
          estimatedImpact: impact(comparison.difference, "Estimated same-token price difference", "scenario-difference"),
          guardrail: noInvoice + "Price arithmetic only: the target may use different tokens, tools or context limits and deliver different quality. No model capability or savings claim. Targets needing unknown per-request premiums are excluded.",
          suggestedAction: "Treat the comparison as a budget scenario. Evaluate the target on a representative task before changing models.",
        });
      }
    }

    const compact = repo.filter((s) => s.provider !== "cursor" && s.metrics.modelCalls > 0);
    const compactCalls = sum(compact, (s) => s.metrics.modelCalls), compactions = sum(compact, (s) => s.metrics.compactions);
    mark("compaction-heavy", compact, compact.length >= t.minRepoSessions && compactCalls >= t.minModelCalls);
    if (compact.length >= t.minRepoSessions && compactCalls >= t.minModelCalls && compactions >= t.minCompactions && compactions / compactCalls * 100 >= t.compactionsPer100Calls) {
      add("compaction-heavy", scope("repo", repositoryId), compact, total, {
        title: "Frequent compaction in this repository", confidence: "medium", names: [],
        evidence: [ratio("Compactions per model call", compactions, compactCalls, "model calls"), evidence("Sessions with compactions", compact.filter((s) => s.metrics.compactions > 0).length, "count", compact.length, "eligible sessions")],
        estimatedImpact: impact(sum(compact.filter((s) => s.metrics.compactions > 0), (s) => s.tokens.inputTokens), "Estimated input exposure in sessions with compaction; not compaction cost", "associated-usage", "tokens"),
        guardrail: "Compaction is normal context management. Counts do not show lost information, failure or a causal cost; long tasks naturally compact more.",
        suggestedAction: "Check whether a concise handoff or a task boundary would help preserve useful context. Compare against similar work in this repository.",
      });
    }

    const delegation = repo.filter((s) => priced(s) && s.cost.totalUsd > 0 && s.costByExecution.unknownUsd === 0 && s.executionKind !== "unknown");
    const delegationPeers = peerValues(delegation, (s) => s.costByExecution.subagentUsd / s.cost.totalUsd);
    mark("subagent-share", delegation, delegation.some((s) => s.metrics.modelCalls >= t.minModelCalls && delegationPeers.get(`${s.provider}:${s.executionKind}`)!.length > t.minRepoSessions));
    for (const s of delegation) {
      const values = delegationPeers.get(`${s.provider}:${s.executionKind}`)!;
      const peers = values.length - 1;
      if (peers < t.minRepoSessions || s.metrics.modelCalls < t.minModelCalls || s.cost.totalUsd < t.minOutlierUsd) continue;
      const share = s.costByExecution.subagentUsd / s.cost.totalUsd;
      const baseline = peerMedian(values, share);
      if (share < t.subagentShare || share - baseline < t.subagentDelta) continue;
      add("subagent-share", scope("session", repositoryId, s.provider, s.sessionKey), peers, total, {
        title: "Delegation share above repository peers", confidence: "medium", names: [],
        evidence: [ratio("Subagent value share", s.costByExecution.subagentUsd, s.cost.totalUsd, "session API-equivalent USD"), evidence("Median peer subagent share", baseline, "ratio", 1, "share of each peer's value"), evidence("Baseline peer sessions", peers)],
        estimatedImpact: impact(s.costByExecution.subagentUsd, "Estimated value associated with subagents; not savings"),
        guardrail: noInvoice + "Parallel work can be intentional. Subagent evidence is a lower bound and does not establish redundant work or task quality.",
        suggestedAction: "Inspect the delegation plan and compare task size with same-provider, same-execution peers before changing fan-out.",
      });
    }

    const contextSessions = repo.filter((s) => s.provider !== "cursor" && s.metrics.modelCalls >= t.minModelCalls && s.metrics.maxInputTokensPerCall > 0);
    const large = contextSessions.filter((s) => s.metrics.maxInputTokensPerCall >= t.longContextInputTokens);
    mark("long-context", contextSessions, contextSessions.length >= t.minRepoSessions);
    if (large.length > 0 && contextSessions.length >= t.minRepoSessions && large.length / contextSessions.length >= t.longContextShare) {
      add("long-context", scope("repo", repositoryId), contextSessions, total, {
        title: "Large request contexts recur here", confidence: "medium", names: [],
        evidence: [ratio("Sessions reaching the input threshold", large.length, contextSessions.length, "sessions with observed request sizes"), evidence("Request input threshold", t.longContextInputTokens, "tokens"), evidence("Largest observed request", Math.max(...large.map((s) => s.metrics.maxInputTokensPerCall)), "tokens")],
        estimatedImpact: impact(sum(large, (s) => s.tokens.inputTokens), "Estimated total input exposure in flagged sessions; not long-context token volume", "associated-usage", "tokens"),
        guardrail: "A session peak does not measure how many requests were large or prove a pricing premium. Context limits differ by model; input volume does not measure useful work.",
        suggestedAction: "Consider a focused handoff or smaller context bundle for a comparable task, then check whether it retains the needed information.",
      });
    }

    const gaps = repo.filter((s) => (s.insightSignals?.cacheGaps?.timedTransitions ?? 0) > 0);
    const transitions = sum(gaps, (s) => s.insightSignals!.cacheGaps!.timedTransitions);
    const five = sum(gaps, (s) => s.insightSignals!.cacheGaps!.fiveMinuteExpiries), hour = sum(gaps, (s) => s.insightSignals!.cacheGaps!.oneHourExpiries);
    mark("idle-cache", gaps, transitions >= t.idleGapMinEvents);
    if (transitions >= t.idleGapMinEvents && five + hour >= t.idleGapMinEvents) {
      const tokens = sum(gaps, (s) => s.insightSignals!.cacheGaps!.rewriteTokens), pricedTokens = sum(gaps, (s) => s.insightSignals!.cacheGaps!.pricedRewriteTokens);
      add("idle-cache", scope("repo", repositoryId, "claude"), gaps, total, {
        title: "Cache writes after gaps beyond the recorded TTL", confidence: "low", names: [],
        evidence: [ratio("5-minute write events after a longer gap", five, transitions, "timed same-model transitions"), ratio("1-hour write events after a longer gap", hour, transitions, "timed same-model transitions"), evidence("Cache-write tokens after gaps", tokens, "tokens"), ratio("Pricing coverage for those writes", pricedTokens, tokens, "cache-write tokens after gaps")],
        estimatedImpact: impact(pricedTokens > 0 ? sum(gaps, (s) => s.insightSignals!.cacheGaps!.estimatedPremiumUsd) : null, "Estimated write-versus-read premium on priced tokens after gaps", "scenario-difference"),
        guardrail: noInvoice + "A gap plus a cache write is an association, not proof of expiry or reusable content. Five-minute and one-hour event counts can overlap. Unrecorded TTLs are excluded.",
        suggestedAction: "Compare related requests before and after pauses. Keep natural breaks; consider provider cache settings only if the repeated context is actually reusable.",
      });
    }
  }

  for (const inventory of context.inventory) {
    const cohort = stable.filter((s) => s.provider === inventory.provider);
    for (const [rule, configured] of [["unused-skills", inventory.skills], ["unused-mcp", inventory.mcpServers]] as const) {
      const usable = cohort.filter((s) => rule !== "unused-skills" || s.skillEvidence !== "unavailable");
      const toolCalls = sum(usable, (s) => s.metrics.toolCalls);
      const sufficient = usable.length >= t.extensionMinSessions && toolCalls >= t.extensionMinToolCalls;
      if (configured.length) mark(rule, usable, sufficient);
      if (!configured.length || !sufficient) continue;
      const unused = configured.filter((name) => boundedName(name) && !usable.some((s) => rule === "unused-skills" ? (s.skills[name] ?? 0) > 0 : Object.entries(s.tools).some(([tool, count]) => count > 0 && (tool.startsWith(`mcp__${name}__`) || tool.startsWith(`mcp_${name}_`)))));
      if (!unused.length) continue;
      add(rule, scope("machine", null, inventory.provider), usable, sessions.length, {
        title: rule === "unused-skills" ? "Installed skills with no observed invocation" : "Configured MCP servers with no observed calls", confidence: "low", names: unused,
        evidence: [ratio("Names without observed use", unused.length, configured.length, "configured names"), evidence("Observed tool calls", toolCalls), evidence("Eligible provider sessions", usable.length, "count", sessions.length, "selected sessions")],
        estimatedImpact: impact(null, "Impact unavailable: schema size and avoided cost are not recorded"),
        guardrail: "Inventory is current; history may predate installation and may be partial. Profiles are pooled. Codex skill reads are a lower bound. No observed use does not mean unnecessary or safe to remove.",
        suggestedAction: "Review whether these extensions still serve your workflow. Check recent tasks and installation timing before disabling anything.",
      });
    }
  }

  const dated = stable.filter((s) => s.executionKind !== "subagent" && Number.isFinite(Date.parse(s.createdAt)));
  mark("time-pattern", dated, dated.length >= t.timeMinSessions);
  if (dated.length >= t.timeMinSessions) {
    const buckets = [0, 0, 0, 0];
    for (const s of dated) buckets[Math.floor(new Date(Date.parse(s.createdAt) + t.utcOffsetMinutes * 60_000).getUTCHours() / 6)]!++;
    const count = Math.max(...buckets), index = buckets.indexOf(count);
    if (count / dated.length >= t.timeBucketShare) add("time-pattern", scope("machine"), dated, sessions.length, {
      title: "Session starts cluster in one time window", confidence: "medium", names: [],
      evidence: [ratio("Starts in the busiest six-hour window", count, dated.length, "dated top-level, mixed or unknown sessions"), evidence("Window start hour", index * 6, "hour"), evidence("Window end hour", (index + 1) * 6, "hour"), evidence("UTC offset in minutes", t.utcOffsetMinutes)],
      estimatedImpact: impact(null, "Impact unavailable: timing does not measure productivity"),
      guardrail: "This describes start times, not working hours, attention, performance or wellbeing. The configured fixed UTC offset does not adjust for daylight saving time.",
      suggestedAction: "Use the observed window for capacity planning if useful. There is no recommended time of day to work.",
    });
  }

  // Dollars and tokens are distinct units; never add them or present overlapping cards as total savings.
  const rank = (card: Insight) => card.estimatedImpact.value === null ? 2 : card.estimatedImpact.unit === "USD" ? 0 : 1;
  cards.sort((a, b) => rank(a) - rank(b) || (b.estimatedImpact.value ?? 0) - (a.estimatedImpact.value ?? 0) || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1, generatedAt, rateCardEffectiveDate: context.rateCard.effectiveDate,
    thresholds: { ...t }, cards,
    coverage: ruleIds.map((rule) => {
      const count = eligible.get(rule)!.size, findings = cards.filter((card) => card.rule === rule).length;
      return { rule, eligibleSessions: count, totalSessions: sessions.length, findings, status: context.disabledRules.includes(rule) ? "disabled" : findings ? "findings" : !count ? "unavailable" : enough.has(rule) ? "no-findings" : "insufficient" };
    }),
    warnings: [...context.warnings, "Cards can overlap. Do not sum estimates; associated usage is not recoverable savings. Working snapshots are excluded."],
  };
}
