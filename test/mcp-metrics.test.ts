import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { SnapshotCache } from "../src/mcp/cache.ts";
import { McpEvidenceCollector } from "../src/mcp/evidence.ts";
import { buildPayload, profile, ratio, windowStart } from "../src/mcp/metrics.ts";
import type { MachineAnalytics, McpSnapshot, SessionAnalytics } from "../src/types.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const NOW = Date.parse("2026-10-02T12:00:00Z");
let directory: string, baseline: MachineAnalytics;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcp-metrics-"));
  baseline = await analyzeMachineSessions(await createSessionAnalyticsFixture(directory));
});
after(async () => { if (directory) await rm(directory, { force: true, recursive: true }); });

function session(overrides: Partial<SessionAnalytics> = {}): SessionAnalytics {
  const seed = structuredClone(baseline.sessions.find((s) => s.provider === "claude")!);
  seed.createdAt = "2026-10-02T10:00:00Z";
  seed.firstEventAt = "2026-10-02T10:00:00Z";
  seed.lastEventAt = "2026-10-02T11:00:00Z";
  seed.metrics.durationMilliseconds = 3_600_000;
  seed.metrics.userTurns = 3;
  seed.mcpEvidence!.activityState = "settled";
  seed.metrics.compactions = 2;
  seed.tokens.inputTokens = 2000; seed.tokens.cachedInputTokens = 500;
  seed.spendByDay = { "2026-10-02": 2, "2026-10-01": 3, "2026-09-01": 100 };
  return Object.assign(seed, overrides);
}
function snapshot(sessions: SessionAnalytics[]): McpSnapshot {
  const analytics = structuredClone(baseline);
  analytics.generatedAt = new Date(NOW - 5000).toISOString();
  analytics.sessions = sessions;
  analytics.mcpContext = { repositoryId: baseline.repositories.find((r) => r.summary.sessions > 0)!.repository.id };
  return { analytics };
}

test("UTC calendar windows include today and Monday, across month/year boundaries", () => {
  assert.equal(new Date(windowStart("today", NOW)!).toISOString(), "2026-10-02T00:00:00.000Z");
  assert.equal(new Date(windowStart("week", NOW)!).toISOString(), "2026-09-28T00:00:00.000Z");
  assert.equal(new Date(windowStart("7d", NOW)!).toISOString(), "2026-09-26T00:00:00.000Z");
  assert.equal(new Date(windowStart("week", Date.parse("2027-01-01T08:00:00Z"))!).toISOString(), "2026-12-28T00:00:00.000Z");
  assert.equal(windowStart("all", NOW), null);
  const data = snapshot([session(), session({ createdAt: "2026-09-01T00:00:00Z" }), session({ createdAt: "2099-01-01T00:00:00Z" })]);
  assert.equal(buildPayload(data, "usage_summary", { window: "today" }, NOW, 60).totals.sessions, 1);
  assert.equal(buildPayload(data, "usage_summary", { window: "all" }, NOW, 60).totals.sessions, 2);
});

test("typical-session baselines exclude working, missing-duration and incomplete-price samples", () => {
  const sessions = Array.from({ length: 5 }, (_, i) => {
    const result = session(); result.cost.totalUsd = i + 1; result.metrics.userTurns = i + 1; return result;
  });
  const result = profile(sessions);
  assert.equal(result.apiEquivalentUsd.median, 3); assert.equal(result.apiEquivalentUsd.p90, 5);
  assert.equal(result.durationMilliseconds.median, 3_600_000);
  assert.equal(result.userTurns.median, 3);
  assert.equal(result.cacheHitRate.value, 0.25); assert.equal(result.cacheHitRate.denominator, 10000);
  assert.equal(result.compactionsPerSession.value, 2);
  sessions[0]!.transcript.snapshotWhileWorking = true;
  assert.equal(profile(sessions).apiEquivalentUsd.median, null);
  assert.equal(profile(sessions).apiEquivalentUsd.excludedSessions, 1);
  sessions[0]!.transcript.snapshotWhileWorking = false; sessions[0]!.costComplete = false;
  sessions[1]!.lastEventAt = null;
  assert.equal(profile(sessions).apiEquivalentUsd.samples, 4);
  assert.equal(profile(sessions).durationMilliseconds.samples, 4);
  assert.equal(profile([]).cacheHitRate.status, "unavailable");
  assert.equal(profile([session()]).compactionsPerSession.status, "insufficient-data");
  const cursor = session({ provider: "cursor", costBasis: "provider-reported" });
  assert.equal(profile([cursor]).cacheHitRate.value, null);
  assert.equal(profile([cursor]).compactionsPerSession.value, null);
  assert.deepEqual(ratio(0, 0), { value: null, numerator: 0, denominator: 0, minimumDenominator: 1, status: "unavailable" });
});

test("budget dates requests across session boundaries and never spreads Cursor value over days", () => {
  const sessions = Array.from({ length: 3 }, () => session({ createdAt: "2026-09-01T00:00:00Z" }));
  const cursor = session({ provider: "cursor", costBasis: "provider-reported", spendByDay: {} });
  cursor.cost.totalUsd = 123;
  const response = buildPayload(snapshot([...sessions, cursor]), "budget_status", {}, NOW, 60);
  assert.ok("today" in response.data);
  assert.equal(response.data.today.apiEquivalentUsd, 6);
  assert.equal(response.data.week.apiEquivalentUsd, 15);
  assert.equal(response.data.today.excludedProviderReportedUsd, 123);
  assert.equal(response.data.today.datedSessions, 3);
  assert.equal(response.data.today.undatedSessions, 1);
  assert.equal(response.data.today.apiEquivalentUsdPerHour, 0.5);
  assert.equal(response.data.week.apiEquivalentUsdPerHour, 15 / 108);
  const small = buildPayload(snapshot([sessions[0]!]), "budget_status", {}, NOW, 60);
  assert.ok("today" in small.data); assert.equal(small.data.today.apiEquivalentUsdPerHour, null);
  assert.equal(response.window.basis, "activity-day"); assert.equal(response.snapshot.ageSeconds, 5);
});

test("tool stats count calls by name and never emit result or error fields", () => {
  const value = session({ tools: { Bash: 30, Read: 5, unknown: 0 } });
  const response = buildPayload(snapshot([value]), "tool_stats", {}, NOW, 60);
  assert.ok("tools" in response.data);
  assert.deepEqual(response.data.tools, [{ name: "Bash", calls: 30 }, { name: "Read", calls: 5 }]);
});

test("tool breakdowns use the same evidence eligibility as MCP coverage totals", () => {
  const observed = session({ tools: { Read: 3 } }); observed.metrics.toolCalls = 3;
  const invalid = session({ tools: { Read: 100, Invalid: 100 } });
  invalid.metrics.toolCalls = 200; invalid.transcript.status = "invalid";
  const unavailable = session({ tools: { Read: 1000, Unavailable: 1000 }, evidence: {
    source: "cursor-sdk", fidelity: "summary", tokens: "reported", tools: "unavailable", turns: "observed", timing: "provider", usageUnit: "run",
  } });
  unavailable.metrics.toolCalls = 2000;
  const data = snapshot([observed, invalid, unavailable]);
  const expected = [{ name: "Read", calls: 3 }];
  const stats = buildPayload(data, "tool_stats", {}, NOW, 60);
  assert.equal(stats.totals.coverage?.toolSessions, 1);
  assert.equal(stats.totals.toolCalls, 3);
  assert.ok("tools" in stats.data);
  assert.deepEqual(stats.data.tools, expected);
  assert.equal(stats.data.totalTools, 1);
  assert.deepEqual(profile(data.analytics.sessions).toolMix, expected);
  const comparison = buildPayload(data, "compare_agents", {}, NOW, 60);
  assert.ok("agents" in comparison.data);
  assert.deepEqual(comparison.data.agents.find((row) => row.provider === "claude")!.profile.toolMix, expected);
});

test("budget status reports dated value without quota headroom", () => {
  const response = buildPayload(snapshot([session()]), "budget_status", {}, NOW, 60);
  assert.ok("today" in response.data);
  assert.deepEqual(Object.keys(response.data).sort(), ["today", "week"]);
});

test("model totals reconcile value, preserve provider bases and omit unattributable measures", () => {
  const sessions = structuredClone(baseline.sessions);
  const result = buildPayload(snapshot(sessions), "usage_summary", { groupBy: "model", window: "all", limit: 50 }, NOW, 60);
  assert.ok("groups" in result.data);
  const api = result.data.groups.reduce((v, g) => v + g.totals.value.apiEquivalentUsd, 0);
  const reported = result.data.groups.reduce((v, g) => v + g.totals.value.providerReportedUsd, 0);
  assert.ok(Math.abs(api - result.totals.value.apiEquivalentUsd) < 1e-10);
  assert.equal(reported, result.totals.value.providerReportedUsd);
  for (const group of result.data.groups) {
    assert.equal(group.totals.toolCalls, null); assert.equal(group.totals.userTurns, null);
    if (group.key.startsWith("cursor:")) {
      assert.equal(group.totals.inputTokens, null); assert.equal(group.totals.value.pricingCoverage.value, null);
    }
  }
  const unknown = session(); unknown.models[0]!.priced = false; if (unknown.models[0]!.pricingCoverage) unknown.models[0]!.pricingCoverage.pricedTokens = 0; unknown.costComplete = false;
  const unpriced = buildPayload(snapshot([unknown]), "usage_summary", {}, NOW, 60);
  assert.equal(unpriced.totals.value.pricingCoverage.value, 0);
  assert.ok(unpriced.totals.value.unpricedTokens > 0);
});

test("recent pagination is stable and output projection never spreads unexpected session fields", () => {
  const s = session(); Object.assign(s, { rawContent: "SECRET_CONTENT", command: "SECRET_COMMAND" });
  s.tools["/SECRET_PATH"] = 5;
  s.models[0]!.model = "/SECRET_MODEL_PATH";
  const data = snapshot([s, session({ sessionKey: "000000000000", lastEventAt: "2026-10-02T10:10:00Z" })]);
  const first = buildPayload(data, "recent_sessions", { limit: 1 }, NOW, 60);
  assert.ok("totalSessions" in first.data);
  assert.equal(first.data.nextOffset, 1);
  const second = buildPayload(data, "recent_sessions", { limit: 1, offset: 1 }, NOW, 60);
  assert.ok("totalSessions" in second.data);
  assert.equal(second.data.sessions[0]!.sessionKey, "000000000000"); assert.equal(second.data.nextOffset, null);
  const comparison = buildPayload(data, "compare_agents", {}, NOW, 60);
  assert.ok("agents" in comparison.data); assert.equal(comparison.data.agents.length, 8);
  assert.equal(comparison.data.agents[1]!.profile.apiEquivalentUsd.median, null);
  assert.doesNotMatch(JSON.stringify([first, second, comparison]), /SECRET_/);
});

test("structured evidence keeps lifecycle and pricing counters, never tool results, quotas or text", () => {
  const collector = new McpEvidenceCollector();
  const call = { type: "assistant", timestamp: "2026-10-02T11:00:00Z", message: { stop_reason: "end_turn", content: [{ type: "tool_use", id: "SECRET_CALL", name: "Bash", input: { command: "SECRET_COMMAND" } }] } };
  collector.claude(call);
  collector.claude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "SECRET_CALL", is_error: true, content: "SECRET_RESULT" }] } });
  collector.codex({ type: "event_msg", timestamp: "2026-10-02T11:59:00Z", payload: { type: "token_count", rate_limits: { limit_id: "SECRET_LIMIT_ID", primary: { used_percent: 25, window_minutes: 300, resets_at: (NOW + 60_000) / 1000 } } } });
  collector.usage("2026-10-02", 100, 60); collector.usage("SECRET_DAY", 7, true);
  const result = collector.finish();
  assert.deepEqual(Object.keys(result).sort(), ["activityState", "pricingByDay", "undatedTokens"]);
  assert.deepEqual(result.pricingByDay, [{ day: "2026-10-02", eligibleTokens: 100, pricedTokens: 60 }]);
  assert.equal(result.undatedTokens, 7);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|Process exited/);
});

test("snapshot TTL starts on completion, coalesces refreshes and never caches failures", async () => {
  let now = 0, loads = 0, finish!: (value: number) => void;
  const cache = new SnapshotCache(async () => { loads += 1; return await new Promise<number>((resolve) => { finish = resolve; }); }, 60_000, () => now);
  const a = cache.get(), b = cache.get(); await Promise.resolve();
  assert.equal(loads, 1); now = 90_000; finish(42);
  assert.deepEqual(await a, { value: 42, completedAt: 90_000 }); assert.deepEqual(await b, await a);
  now = 149_999; assert.equal((await cache.get()).value, 42); assert.equal(loads, 1);
  now = 150_000; const expired = cache.get(); await Promise.resolve(); assert.equal(loads, 2); finish(43); assert.equal((await expired).value, 43);
  let fail = false, attempts = 0;
  const failing = new SnapshotCache(async () => { attempts += 1; if (fail) throw new Error("SECRET_ERROR"); return 7; }, 1, () => now);
  assert.equal((await failing.get()).value, 7); now += 2; fail = true;
  await assert.rejects(failing.get()); await assert.rejects(failing.get()); assert.equal(attempts, 3);
  fail = false; assert.equal((await failing.get()).value, 7);
});

test("integration: MCP exposes the shared metric families and partial pricing coverage", () => {
  const s = session();
  const model = s.models[0]!;
  const eligible = model.inputTokens + model.outputTokens;
  model.priced = false; model.pricingCoverage = { eligibleTokens: eligible, pricedTokens: eligible / 2 };
  s.costComplete = false;
  const result = buildPayload(snapshot([s]), "usage_summary", { window: "all" }, NOW, 60);
  assert.equal(result.totals.value.pricingCoverage.value, 0.5);
  assert.ok(result.metrics);
  assert.deepEqual(Object.keys(result.metrics).sort(), ["basis", "pricing", "velocity"]);
  assert.equal(result.metrics.velocity.coveredSessions, 1);
  const activity = session({ provider: "copilot", evidence: { source: "copilot-events", fidelity: "activity-only", tokens: "unavailable", tools: "observed", turns: "observed", timing: "provider", usageUnit: "unavailable" } });
  const unavailable = buildPayload(snapshot([activity]), "usage_summary", { window: "all", provider: "copilot" }, NOW, 60);
  assert.equal(unavailable.totals.sessions, 1);
  assert.equal(unavailable.totals.inputTokens, null);
  assert.equal(unavailable.totals.coverage?.tokenSessions, 0);
});
