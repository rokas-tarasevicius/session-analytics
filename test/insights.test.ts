import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { buildInsights } from "../src/insights/engine.ts";
import { codexServerNames, inventoryFromSettings, loadInsightContext, parseInsightConfig } from "../src/insights/config.ts";
import { cacheGapSignals } from "../src/insights/cache-gaps.ts";
import { filterInsightSessions, formatInsights } from "../src/insights/service.ts";
import type { InsightContext, InsightRule } from "../src/insights/types.ts";
import { ruleIds } from "../src/insights/types.ts";
import { context, createInsightsFixture, session, sessions, testRateCard, tokens } from "./insights-fixtures.ts";
import type { SessionAnalytics } from "../src/types.ts";

const report = (items: SessionAnalytics[], config: InsightContext = context()) => buildInsights(items, config, "2026-10-01T12:00:00Z");
const cards = (rule: InsightRule, items: SessionAnalytics[], config = context()) => report(items, config).items.filter((card) => card.rule === rule);

test("outlier uses leave-one-out repository/provider/execution median and guards small samples", () => {
  const items = sessions(); const candidate = items[0]!; candidate.cost.totalUsd = 20;
  const found = cards("session-outlier", items);
  assert.equal(found.length, 1); assert.equal(found[0]!.scope.sessionKey, candidate.sessionKey);
  assert.equal(found[0]!.evidence[1]!.value, items[1]!.cost.totalUsd); assert.equal(found[0]!.coverage.eligibleSessions, 5);
  assert.equal(cards("session-outlier", items.slice(0, 5)).length, 0);
  items[1]!.provider = "codex"; assert.equal(cards("session-outlier", items).length, 0);
  items[1]!.provider = "claude"; items[1]!.executionKind = "subagent"; assert.equal(cards("session-outlier", items).length, 0);
  for (const s of items) s.cost.totalUsd = 0;
  assert.equal(cards("session-outlier", items).length, 0);
});

test("cache rule distinguishes observable writes, shows ratios and suppresses tiny activity", () => {
  const s = session(1, { tokens: tokens({ cachedInputTokens: 10_000, cacheWriteInputTokens: 150_000, cacheWrite5mInputTokens: 150_000 }) });
  const card = cards("cache-waste", [s])[0]!;
  assert.equal(card.evidence[0]!.denominator, 180_000); assert.equal(card.estimatedImpact.unit, "tokens");
  s.metrics.modelCalls = 1; assert.equal(cards("cache-waste", [s]).length, 0);
  s.metrics.modelCalls = 20; s.tokens = tokens(); assert.equal(cards("cache-waste", [s]).length, 0);
  s.provider = "codex"; s.tokens = tokens({ uncachedInputTokens: 200_000, cachedInputTokens: 0 });
  assert.equal(cards("cache-waste", [s]).length, 1);
  s.provider = "cursor"; assert.equal(cards("cache-waste", [s]).length, 0);
});

test("counterfactual preserves cache/output classes, excludes zero-price previews and remains within a provider", () => {
  const items = sessions(5), config = context();
  config.rateCard.models["free-preview"] = { ...testRateCard.models["claude-small"]!, inputPerMillion: 0, outputPerMillion: 0 };
  const card = cards("model-pricing", items, config)[0]!;
  assert.deepEqual(card.names, ["claude-small"]);
  assert.ok(Math.abs(card.evidence[2]!.value - 5 * (0.02 + 0.018 + 0.05)) < 1e-10);
  assert.ok(Math.abs(card.estimatedImpact.value! - 1.76) < 1e-10);
  assert.match(card.guardrail, /Price arithmetic only/);
  config.comparisonModels.claude = "claude-premium";
  assert.equal(cards("model-pricing", items, config).length, 0);
  items[0]!.costComplete = false;
  assert.equal(cards("model-pricing", items).length, 0);
});

test("target long-context premiums are never applied to an aggregate or silently omitted", () => {
  const config = context(), items = sessions(5);
  config.rateCard.models["claude-small"]!.longContext = { thresholdInputTokens: 50_000, inputMultiplier: 2, outputMultiplier: 1.5 };
  items[0]!.metrics.maxInputTokensPerCall = 50_001;
  assert.equal(cards("model-pricing", items, config).length, 0);
  items[0]!.metrics.maxInputTokensPerCall = 50_000;
  assert.equal(cards("model-pricing", items, config).length, 1);
});

test("compaction density has a call denominator, count guard and no causal cost claim", () => {
  const items = sessions(5); for (const s of items) s.metrics.compactions = 2;
  const card = cards("compaction-heavy", items)[0]!;
  assert.equal(card.evidence[0]!.value, 10); assert.equal(card.evidence[0]!.denominator, 100);
  assert.match(card.estimatedImpact.label, /not compaction cost/);
  for (const s of items) s.provider = "cursor";
  assert.equal(cards("compaction-heavy", items).length, 0);
});

test("delegation anomaly compares same-execution peers and never treats unknown attribution as zero", () => {
  const items = sessions(); for (const s of items) { s.executionKind = "mixed"; s.cost.totalUsd = 10; s.costByExecution = { subagentUsd: 1, topLevelUsd: 9, unknownUsd: 0 }; }
  items[0]!.costByExecution = { subagentUsd: 8, topLevelUsd: 2, unknownUsd: 0 };
  const card = cards("subagent-share", items)[0]!;
  assert.equal(card.evidence[0]!.value, 8); assert.equal(card.evidence[0]!.denominator, 10);
  items[0]!.costByExecution.unknownUsd = 1;
  assert.equal(cards("subagent-share", items).length, 0);
});

test("large context uses per-session peaks and reports eligible session denominator", () => {
  const items = sessions(5); items[0]!.metrics.maxInputTokensPerCall = 210_000; items[1]!.metrics.maxInputTokensPerCall = 220_000;
  const card = cards("long-context", items)[0]!;
  assert.equal(card.evidence[0]!.value, 2); assert.equal(card.evidence[0]!.denominator, 5);
  assert.match(card.guardrail, /does not measure how many requests/);
  items[1]!.metrics.maxInputTokensPerCall = 0;
  assert.equal(cards("long-context", items).length, 0);
  const config = context(); config.thresholds.longContextShare = 0;
  assert.equal(cards("long-context", sessions(5), config).length, 0);
});

test("extension rules count configured names against eligible provider evidence, including namespaced MCP tools", () => {
  const items = sessions(10), config = context();
  config.inventory = [{ provider: "claude", skills: ["used", "unused"], mcpServers: ["used", "unused"] }];
  items[0]!.skills["used"] = 1; items[0]!.tools["mcp__used__search"] = 1;
  for (const rule of ["unused-skills", "unused-mcp"] as const) {
    const card = cards(rule, items, config)[0]!;
    assert.deepEqual(card.names, ["unused"]); assert.equal(card.evidence[0]!.denominator, 2); assert.equal(card.estimatedImpact.value, null);
    assert.equal(cards(rule, items.slice(0, 2), config).length, 0);
  }
  assert.equal(cards("unused-mcp", items).length, 0);
});

test("idle gap rule exposes separate TTL event denominators and partial pricing", () => {
  const s = session(1, { insightSignals: { cacheGaps: { observableCalls: 10, timedTransitions: 9, fiveMinuteExpiries: 3, oneHourExpiries: 1, rewriteTokens: 800, pricedRewriteTokens: 400, estimatedPremiumUsd: 0.01 } } });
  const card = cards("idle-cache", [s])[0]!;
  assert.equal(card.evidence[0]!.denominator, 9); assert.equal(card.evidence[3]!.value, 400); assert.equal(card.evidence[3]!.denominator, 800);
  assert.equal(card.confidence, "low"); assert.match(card.guardrail, /not proof/);
  s.insightSignals!.cacheGaps!.fiveMinuteExpiries = 0; s.insightSignals!.cacheGaps!.oneHourExpiries = 0;
  assert.equal(cards("idle-cache", [s]).length, 0);
});

test("cache gap extractor respects exact TTL boundaries, unknown TTL, file boundaries, model switches and timestamps", () => {
  const make = (minutes: number, extra = {}) => ({ stream: "internal-only-path", timestamp: new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString(), model: "claude-premium", explicitTtl: true, usage: tokens({ cacheWriteInputTokens: 200, cacheWrite5mInputTokens: 100, cacheWrite1hInputTokens: 100 }), ...extra });
  const result = cacheGapSignals([make(0), make(5), make(11), make(71), make(132)], testRateCard);
  assert.equal(result.timedTransitions, 4); assert.equal(result.fiveMinuteExpiries, 3); assert.equal(result.oneHourExpiries, 1); assert.equal(result.rewriteTokens, 400);
  assert.ok(Math.abs(result.estimatedPremiumUsd - (300 * 5.75 + 100 * 9.5) / 1_000_000) < 1e-12);
  assert.equal(cacheGapSignals([make(0), make(10, { stream: "other" })], testRateCard).timedTransitions, 0);
  assert.equal(cacheGapSignals([make(0), make(10, { explicitTtl: false })], testRateCard).rewriteTokens, 0);
  assert.equal(cacheGapSignals([make(0), make(10, { model: "claude-small" })], testRateCard).timedTransitions, 0);
  assert.equal(cacheGapSignals([make(0), make(10, { timestamp: null }), make(20)], testRateCard).timedTransitions, 0);
  assert.equal(cacheGapSignals([make(10), make(0)], testRateCard).timedTransitions, 0);
});

test("time patterns use an explicit fixed offset, ignore subagent starts and make no productivity claim", () => {
  const items = sessions(20), config = context(); config.thresholds.utcOffsetMinutes = -600;
  const card = cards("time-pattern", items, config)[0]!;
  assert.equal(card.evidence[0]!.denominator, 20); assert.equal(card.evidence[1]!.value, 0); assert.equal(card.estimatedImpact.value, null);
  assert.match(card.guardrail, /not working hours/);
  items[0]!.executionKind = "subagent"; assert.equal(cards("time-pattern", items, config).length, 0);
});

test("coverage distinguishes missing, insufficient, disabled and evaluated; empty evidence never produces a zero-percent card", () => {
  const config = context(); config.disabledRules = ["cache-waste"];
  const empty = report([], config);
  assert.equal(empty.items.length, 0); assert.equal(empty.coverage.find((c) => c.rule === "cache-waste")!.status, "disabled");
  assert.ok(empty.coverage.filter((c) => c.rule !== "cache-waste").every((c) => c.status === "unavailable"));
  assert.equal(report([session(1)]).coverage.find((c) => c.rule === "time-pattern")!.status, "insufficient");
  const items = sessions(); items[0]!.transcript.snapshotWhileWorking = true; items[1]!.transcript.status = "invalid";
  assert.equal(report(items).coverage.find((c) => c.rule === "model-pricing")!.eligibleSessions, 4);
  assert.equal(new Set(ruleIds).size, 10);
});

test("card IDs and ordering are deterministic, thresholds are validated without echoing private config", () => {
  const items = sessions(20), config = context();
  assert.deepEqual(report(items).items, report(items.toReversed()).items);
  const first = report(items).items[0]!; assert.equal(first.estimatedImpact.unit, "USD");
  assert.match(first.id, /^insight-[a-f0-9]{20}$/);
  for (const raw of [null, { thresholds: { secret: 1 } }, { thresholds: { minRepoSessions: 0 } }, { thresholds: { cacheReadShare: 2 } }, { thresholds: { minModelCalls: NaN } }, { disabledRules: ["secret-invalid-rule"] }, { comparisonModels: { claude: "/secret-path" } }, { thresholds: { utcOffsetMinutes: -841 } }]) assert.throws(() => parseInsightConfig(raw), /configuration is invalid/);
  assert.equal(parseInsightConfig({ thresholds: { utcOffsetMinutes: -60, cacheReadShare: 0.2 } }).thresholds.cacheReadShare, 0.2);
  config.disabledRules = [...ruleIds]; assert.equal(report(items, config).items.length, 0);
});

test("inventory projection drops settings content, rejects path-like names and recognizes disabled servers", () => {
  const inventory = inventoryFromSettings({ skills: { review: true, "/secret-path": true, disabled: false }, mcpServers: { useful: { command: "secret-command", env: { TOKEN: "secret-credential" }, url: "https://secret-remote" }, off: { disabled: true }, "/secret-path": {} }, arbitrary: "content-is-not-returned" });
  assert.deepEqual(inventory, { skills: ["review"], mcpServers: ["useful"] });
  assert.deepEqual(codexServerNames('[mcp_servers.alpha]\ncommand="secret-command"\n[mcp_servers."beta.test"]\nurl="https://secret-remote"\n[mcp_servers.disabled]\nenabled = false\n[mcp_servers."/secret-path"]\n'), ["alpha", "beta.test"]);
  assert.deepEqual(codexServerNames('[mcp_servers.alpha]\ncommand="""\n[mcp_servers.secret-command]\n"""\n[mcp_servers.beta]\nargs=["[mcp_servers.secret-input]"]\n'), ["alpha", "beta"]);
  assert.doesNotMatch(JSON.stringify(inventory), /secret|content-is-not-returned/);
});

test("real parser shapes yield deduplicated Claude gaps, request peaks and private insights across all output objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "insights-evidence-"));
  try {
    const fixture = await createInsightsFixture(root), config = await loadInsightContext(fixture.options);
    const snapshot = await analyzeMachineSessions(fixture.options), output = report(snapshot.sessions, config);
    assert.equal(snapshot.sessions.length, 6);
    const s = snapshot.sessions[0]!;
    assert.equal(s.metrics.modelCalls, 20); assert.equal(s.metrics.maxInputTokensPerCall, 200_060);
    assert.equal(s.insightSignals!.cacheGaps!.observableCalls, 20); assert.equal(s.insightSignals!.cacheGaps!.timedTransitions, 19); assert.equal(s.insightSignals!.cacheGaps!.fiveMinuteExpiries, 19);
    for (const rule of ["cache-waste", "model-pricing", "compaction-heavy", "long-context", "idle-cache", "unused-skills", "unused-mcp"]) assert.ok(output.items.some((card) => card.rule === rule), rule);
    for (const serialized of [JSON.stringify(snapshot), JSON.stringify(output), formatInsights(output)]) {
      assert.doesNotMatch(serialized, /secret-|content-is-not-returned|synthetic-private-branch|person@example|private\.example|11111111-1111|\/projects\/|rollout-/);
      assert.ok(!serialized.includes(root));
    }
    assert.equal(filterInsightSessions(snapshot, { from: "2026-09-02", through: "2026-09-03" }).length, 2);
    assert.throws(() => filterInsightSessions(snapshot, { from: "2026-02-30" }));
    assert.throws(() => filterInsightSessions(snapshot, { from: "2026-09-03", through: "2026-09-01" }));
    assert.throws(() => filterInsightSessions(snapshot, { repositoryId: "missing" }));
    const source = (await readFile(fixture.source, "utf8")).replaceAll('"ephemeral_5m_input_tokens":200000', '"ephemeral_5m_input_tokens":0');
    await writeFile(fixture.source, source);
    const withoutTtl = (await analyzeMachineSessions(fixture.options)).sessions.find((s) => s.sessionKey === fixture.sessionKey)!;
    assert.equal(withoutTtl.insightSignals!.cacheGaps!.observableCalls, 0);
    assert.equal(withoutTtl.insightSignals!.cacheGaps!.rewriteTokens, 0); // Aggregate-only fallback cannot establish a TTL.
    await writeFile(fixture.config, JSON.stringify({ inventory: { claude: { skills: ["/secret-path"] } } }));
    await assert.rejects(loadInsightContext(fixture.options), /configuration is invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
