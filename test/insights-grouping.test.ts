import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { calculateCost, loadRateCard } from "../src/analyzer.ts";
import { buildInsights } from "../src/insights/engine.ts";
import { groupInsights } from "../src/insights/grouping.ts";
import { loadInsightContext, parseInsightConfig } from "../src/insights/config.ts";
import { formatInsights, selectInsightRule } from "../src/insights/service.ts";
import type { Insight, InsightRule } from "../src/insights/types.ts";
import { context, createInsightsFixture, session, sessions, tokens } from "./insights-fixtures.ts";

const report = (items: ReturnType<typeof sessions>, config = context()) => buildInsights(items, config, "2026-10-01T00:00:00Z");

test("many repeated findings become one group per rule/scope with exact contributor counts and retained denominators", () => {
  const selected = Array.from({ length: 3 }, (_, repo) => sessions(12).map((s, index) => {
    s.sessionKey = (repo * 100 + index).toString(16).padStart(12, "0");
    s.repositoryId = `discovered-${repo.toString(16).repeat(20)}`;
    if (index < 2) { s.cost.totalUsd = 20 + index; s.metrics.compactions = 8; }
    if (index < 5) s.metrics.maxInputTokensPerCall = 210_000;
    return s;
  })).flat();
  const output = report(selected);
  assert.equal(output.schemaVersion, 2);
  assert.ok(output.groups.length <= 10);
  assert.equal(new Set(output.groups.map((g) => `${g.rule}:${g.scopeKind}`)).size, output.groups.length);
  const outliers = output.groups.find((g) => g.rule === "session-outlier")!;
  assert.equal(outliers.itemIds.length, 6);
  assert.deepEqual(outliers.affected, { repositories: 3, sessions: 6 });
  assert.deepEqual(outliers.coverage, { eligibleSessions: 36, totalSessions: 36, totalRepositories: 3 });
  const compact = output.groups.find((g) => g.rule === "compaction-heavy")!;
  assert.deepEqual(compact.affected, { repositories: 3, sessions: 6 }, "Only compaction contributors count, not all eligible sessions");
  const contextGroup = output.groups.find((g) => g.rule === "long-context")!;
  assert.deepEqual(contextGroup.affected, { repositories: 3, sessions: 15 });
  const byId = new Map(output.items.map((item) => [item.id, item]));
  assert.equal(new Set(output.groups.flatMap((g) => g.itemIds)).size, output.items.length);
  for (const group of output.groups) {
    const entries = group.itemIds.map((id) => byId.get(id)!);
    assert.ok(entries.every((item) => item.rule === group.rule && item.scope.kind === group.scopeKind));
    if (group.estimatedImpact.value !== null) assert.equal(group.estimatedImpact.value, entries.reduce((total, item) => total + (item.estimatedImpact.value ?? 0), 0));
    assert.ok(group.guardrails.every((text) => entries.some((item) => item.guardrail === text)));
    if (group.rule === "session-outlier") assert.ok(entries.every((item) => item.coverage.eligibleSessions === 11 && item.evidence[2]!.denominator! > 0));
  }
  assert.deepEqual(output, report(selected.toReversed()), "Order and IDs do not depend on traversal order");
  const only = selectInsightRule(output, "session-outlier");
  assert.equal(only.groups.length, 1); assert.equal(only.items.length, 6); assert.deepEqual(only.groups[0]!.coverage, outliers.coverage);
  const text = formatInsights(only);
  assert.equal((text.match(/Sessions above their repository baselines/g) || []).length, 1);
  assert.match(text, /3 more scopes/);
  assert.match(formatInsights(only, true), /Baseline peer sessions: 11/);
  assert.throws(() => selectInsightRule(output, "secret-invalid-rule"), /Invalid insights rule/);
});

test("group and row ranks separate money, tokens and unavailable impact; totals expose partial coverage and lowest confidence", () => {
  const make = (id: string, rule: InsightRule, value: number | null, unit: "USD" | "tokens", confidence: Insight["confidence"] = "high"): Insight => ({
    id, rule, scope: { kind: "repo", repositoryId: "discovered-aaaaaaaaaaaaaaaaaaaa", sessionKey: null, provider: "claude" }, title: "Fixed title", names: [], evidence: [],
    estimatedImpact: { value, unit, basis: value === null ? "unavailable" : "associated-usage", label: "Estimated associated usage, not savings" },
    confidence, guardrail: "Fixed guardrail", suggestedAction: "Compare similar tasks.", coverage: { eligibleSessions: 1, totalSessions: 1 },
  });
  const items = [make("z", "idle-cache", 2, "USD"), make("a", "session-outlier", 2, "USD"), make("b", "session-outlier", 6, "USD", "medium"), make("c", "cache-waste", 9_999_999, "tokens"), make("d", "unused-mcp", null, "USD", "low"), make("e", "idle-cache", null, "USD", "low")];
  const contributor = session(1), sources = new Map(items.map((item) => [item.id, [contributor]]));
  const groups = groupInsights(items, [contributor], sources, new Map());
  assert.deepEqual(groups.map((g) => g.rule), ["session-outlier", "idle-cache", "cache-waste", "unused-mcp"]);
  assert.deepEqual(groups[0]!.itemIds, ["b", "a"]); assert.equal(groups[0]!.confidence, "medium");
  assert.deepEqual(groups[0]!.affected, { repositories: 1, sessions: 1 }, "Affected counts use a union");
  assert.deepEqual(groups[1]!.impactCoverage, { quantifiedItems: 1, totalItems: 2 });
  assert.equal(groups[1]!.estimatedImpact.value, 2); assert.equal(groups[1]!.confidence, "low"); assert.match(groups[1]!.estimatedImpact.label, /quantified/);
  assert.equal(groups[3]!.estimatedImpact.value, null);
  const anotherLevel = { ...items[0]!, id: "session-level", scope: { ...items[0]!.scope, kind: "session" as const } };
  const levels = groupInsights([items[0]!, anotherLevel], [contributor], sources, new Map());
  assert.equal(levels.length, 2); assert.notEqual(levels[0]!.id, levels[1]!.id); assert.equal(levels[0]!.ruleDecisionId, levels[1]!.ruleDecisionId);
});

test("default pricing policy uses the next mapped tier, never the cheapest model or another provider", async () => {
  const config = context(); config.rateCard = await loadRateCard(); config.nextTierModels = parseInsightConfig({}).nextTierModels;
  const selected = sessions(5);
  for (const s of selected) {
    const usage = tokens({ uncachedInputTokens: 1_000_000 });
    const cost = calculateCost(config.rateCard.models["claude-opus-5"]!, usage, 20_000);
    s.tokens = usage; s.cost = cost;
    s.models = [{ ...usage, ...cost, model: "claude-opus-5", calls: 20, priced: true }];
    s.insightSignals = { requestSizes: { observedTokens: usage.inputTokens + usage.outputTokens, unknownTokens: 0 } };
  }
  const output = report(selected, config), price = output.items.find((i) => i.rule === "model-pricing")!;
  assert.deepEqual(price.names, ["claude-sonnet-5"]); assert.equal(price.pricing!.strategy, "next-tier-down");
  assert.deepEqual(price.pricing!.transitions, [{ sourceModel: "claude-opus-5", targetModel: "claude-sonnet-5" }]);
  assert.match(output.groups.find((g) => g.rule === "model-pricing")!.title, /Next-tier-down/);
  config.nextTierModels.claude!["claude-opus-5"] = null;
  assert.equal(report(selected, config).items.filter((i) => i.rule === "model-pricing").length, 0);
  config.comparisonModels.claude = "claude-haiku-4-5-20251001";
  const explicit = report(selected, config).items.find((i) => i.rule === "model-pricing")!;
  assert.equal(explicit.pricing!.strategy, "configured-target"); assert.deepEqual(explicit.names, ["claude-haiku-4-5-20251001"]);
  assert.ok(explicit.estimatedImpact.value! > price.estimatedImpact.value!);
  const oldRuleId = output.groups.find((g) => g.rule === "model-pricing")!.ruleDecisionId;
  assert.equal(report(selected, config).groups.find((g) => g.rule === "model-pricing")!.ruleDecisionId, oldRuleId, "Rule decisions survive changed targets");
});

test("mixed-model next-tier scenarios move usage once, retain unmapped usage, and keep cohort/request-size guards", () => {
  const config = context(); config.thresholds.minDifferenceUsd = 0.1;
  config.rateCard.models["claude-middle"] = { ...config.rateCard.models["claude-small"]!, inputPerMillion: 2, outputPerMillion: 10 };
  config.nextTierModels.claude = { "claude-premium": "claude-middle", "claude-middle": "claude-small" };
  const selected = sessions(5);
  const premiumUsage = tokens({ uncachedInputTokens: 200_000, cachedInputTokens: 0 });
  const make = (model: string) => ({ ...premiumUsage, ...calculateCost(config.rateCard.models[model]!, premiumUsage, 20_000), model, calls: 10, priced: true });
  for (const s of selected) {
    s.models = [make("claude-premium"), make("claude-middle"), make("claude-small")];
    s.tokens = tokens({ uncachedInputTokens: premiumUsage.inputTokens * 3, cachedInputTokens: 0, outputTokens: premiumUsage.outputTokens * 3 });
    s.cost.totalUsd = s.models.reduce((n, m) => n + m.totalUsd, 0);
    s.insightSignals = { requestSizes: { observedTokens: s.tokens.inputTokens + s.tokens.outputTokens, unknownTokens: 0 } };
  }
  const price = report(selected, config).items.find((i) => i.rule === "model-pricing")!;
  assert.deepEqual(price.pricing!.transitions, [{ sourceModel: "claude-middle", targetModel: "claude-small" }, { sourceModel: "claude-premium", targetModel: "claude-middle" }]);
  const expected = 5 * (make("claude-middle").totalUsd + 2 * make("claude-small").totalUsd);
  assert.ok(Math.abs(price.evidence[2]!.value - expected) < 1e-10);
  assert.equal(price.evidence[4]!.value, 5 * 2 * (premiumUsage.inputTokens + premiumUsage.outputTokens));
  assert.equal(price.evidence[4]!.denominator, 5 * 3 * (premiumUsage.inputTokens + premiumUsage.outputTokens));
  config.rateCard.models["claude-middle"]!.longContext = { thresholdInputTokens: 50_000, inputMultiplier: 2, outputMultiplier: 2 };
  selected[0]!.insightSignals!.requestSizes!.unknownTokens = 1;
  const guarded = report(selected, config);
  assert.equal(guarded.items.filter((i) => i.rule === "model-pricing").length, 0);
  assert.equal(guarded.coverage.find((r) => r.rule === "model-pricing")!.eligibleSessions, 4);
  config.thresholds.minRepoSessions = 4;
  const partial = report(selected, config).items.find((i) => i.rule === "model-pricing")!;
  assert.equal(partial.evidence[0]!.value, 4); assert.equal(partial.evidence[0]!.denominator, 5);
  assert.ok(partial.evidence[3]!.value < partial.evidence[3]!.denominator!);
});

test("next-tier configuration validates names/providers/rates without echoing private settings, and permits null overrides", async () => {
  for (const config of [{ nextTierModels: [] }, { nextTierModels: { cursor: {} } }, { nextTierModels: { claude: [] } }, { nextTierModels: { claude: { "secret/path": "target" } } }, { nextTierModels: { claude: { source: ["secret"] } } }, { nextTierModels: { claude: { same: "same" } } }]) assert.throws(() => parseInsightConfig(config), /^Error: The insights configuration is invalid or unavailable\.$/);
  const root = await mkdtemp(join(tmpdir(), "insights-mapping-"));
  try {
    const fixture = await createInsightsFixture(root);
    for (const target of ["codex-small", "unregistered-secret"]) {
      await writeFile(fixture.config, JSON.stringify({ nextTierModels: { claude: { "claude-premium": target } }, inventory: {} }));
      await assert.rejects(loadInsightContext(fixture.options), /^Error: The insights configuration is invalid or unavailable\.$/);
    }
    await writeFile(fixture.config, JSON.stringify({ nextTierModels: { claude: { "claude-premium": null } }, inventory: {} }));
    assert.equal((await loadInsightContext(fixture.options)).nextTierModels.claude!["claude-premium"], null);
    await writeFile(fixture.config, JSON.stringify({ inventory: {} }));
    const missingDefault = await loadInsightContext(fixture.options);
    assert.deepEqual(missingDefault.nextTierModels, { claude: {}, codex: {} });
    assert.equal(report(sessions(5), missingDefault).items.filter((i) => i.rule === "model-pricing").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
