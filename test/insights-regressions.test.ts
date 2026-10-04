import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions, calculateCost } from "../src/analyzer.ts";
import { loadInsightContext } from "../src/insights/config.ts";
import { buildInsights } from "../src/insights/engine.ts";
import { filterInsightSessions, insightsForSnapshot } from "../src/insights/service.ts";
import { context, createInsightsFixture, sessions, testRateCard, tokens } from "./insights-fixtures.ts";
import type { MachineAnalytics } from "../src/types.ts";

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const report = (items: ReturnType<typeof sessions>, config = context()) => buildInsights(items, config, "2026-10-01T00:00:00Z");

/** Synthetic Codex broadcasts: only file zero owns the large shared request. */
async function codexFixture(root: string, unknownSize = false, active = false) {
  const fixture = await createInsightsFixture(root);
  const emptyClaude = join(root, "empty-claude"); await mkdir(emptyClaude);
  fixture.options.claudeRoot = emptyClaude;
  for (let i = 0; i < 6; i++) {
    const id = `${String(i + 1).repeat(8)}-2222-4222-8222-222222222222`;
    const records: unknown[] = [
      { type: "session_meta", timestamp: "2026-09-01T00:00:00Z", payload: { id, cwd: join(root, "synthetic-project"), source: "cli" } },
      { type: "turn_context", payload: { model: "codex-premium" } },
      { type: "event_msg", timestamp: i === 0 ? "2026-09-01T00:00:59Z" : "2026-09-01T00:00:01Z", payload: { type: "task_started", content: "secret-lifecycle-content" } },
      { type: "event_msg", timestamp: "2026-09-01T00:01:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300_000, output_tokens: 100 }, last_token_usage: { input_tokens: 300_000, output_tokens: 100 }, model_context_window: 1_000_000 } } },
    ];
    // A shared numeric state alone is ambiguous; the provider receipt proves its producer.
    if (i === 0) records.splice(3, 0, { type: "token_usage_record", timestamp: "2026-09-01T00:01:00Z",
      payload: { thread_id: id, response_id: "synthetic-shared-request", usage: { input_tokens: 300_000, output_tokens: 100 },
        thread_token_usage: { input_tokens: 300_000, output_tokens: 100 } } });
    for (let n = 1; n <= 10; n++) records.push({ type: "event_msg", timestamp: `2026-09-01T00:02:${String(n).padStart(2, "0")}Z`, payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300_000 + i * 1_000_000 + n * 10_000, output_tokens: 100 + i * 1_000 + n * 100 }, last_token_usage: { input_tokens: 10_000, output_tokens: 100 } } } });
    if (unknownSize) records.push({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1_400_000 + i * 1_000_000, output_tokens: 1_100 + i * 1_000 } } } });
    if (!active) records.push({ type: "event_msg", timestamp: "2026-09-01T00:03:00Z", payload: { type: "task_complete" } });
    await writeFile(join(fixture.options.codexRoot!, `rollout-${id}.jsonl`), jsonl(records));
  }
  return fixture;
}

test("owned Codex peaks exclude large foreign broadcasts in both context and pricing rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "insights-owned-"));
  try {
    const fixture = await codexFixture(root), snapshot = await analyzeMachineSessions(fixture.options), config = context();
    config.comparisonModels.codex = "codex-small";
    config.rateCard.models["codex-small"]!.longContext = { thresholdInputTokens: 200_000, inputMultiplier: 2, outputMultiplier: 2 };
    const small = snapshot.sessions.filter((s) => s.tokens.inputTokens === 100_000);
    assert.equal(small.length, 5);
    const output = report(snapshot.sessions, config);
    assert.equal(output.items.filter((c) => c.rule === "long-context").length, 0);
    assert.ok(small.every((s) => s.metrics.maxInputTokensPerCall === 10_000));
    const card = output.items.find((c) => c.rule === "model-pricing")!;
    assert.ok(card); assert.equal(card.coverage.eligibleSessions, 5); assert.equal(card.coverage.totalSessions, 6);
    assert.doesNotMatch(JSON.stringify({ snapshot, output }), /secret-lifecycle|22222222-2222|rollout-/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mixed sized requests and cumulative-only deltas cannot establish target premium coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "insights-size-coverage-"));
  try {
    const fixture = await codexFixture(root, true), snapshot = await analyzeMachineSessions(fixture.options), config = context();
    config.comparisonModels.codex = "codex-small";
    // Above even the foreign diagnostic, so this reproduces independently of the peak fix.
    config.rateCard.models["codex-small"]!.longContext = { thresholdInputTokens: 500_000, inputMultiplier: 2, outputMultiplier: 2 };
    const output = report(snapshot.sessions, config);
    assert.equal(output.items.filter((c) => c.rule === "model-pricing").length, 0);
    assert.equal(output.coverage.find((c) => c.rule === "model-pricing")!.eligibleSessions, 0);
    assert.ok(snapshot.sessions.every((s) => s.insightSignals!.requestSizes!.unknownTokens === 1_000_000));
    assert.match(output.warnings.join(" "), /request.size/i);
    delete config.rateCard.models["codex-small"]!.longContext;
    const flat = report(snapshot.sessions, config).items.find((c) => c.rule === "model-pricing")!;
    assert.ok(flat); assert.equal(flat.coverage.eligibleSessions, 6);
    assert.ok(flat.evidence.some((e) => e.label === "Tokens in this scenario" && e.denominator! > 6_000_000));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed tails and unresolved standalone lifecycle stay out of stable comparisons", async () => {
  const root = await mkdtemp(join(tmpdir(), "insights-partial-"));
  try {
    const fixture = await createInsightsFixture(root);
    const lines = (await readFile(fixture.source, "utf8")).split("\n");
    await writeFile(fixture.source, lines.slice(0, 13).join("\n") + '\n{"secret-malformed-tail":\n');
    let snapshot = await analyzeMachineSessions(fixture.options);
    const output = insightsForSnapshot(snapshot, await loadInsightContext(fixture.options));
    assert.equal(output.coverage.find((c) => c.rule === "model-pricing")!.eligibleSessions, 5);
    assert.equal(snapshot.sessions.find((s) => s.sessionKey === fixture.sessionKey)!.transcript.completeness, "partial");
    assert.match(output.warnings.join(" "), /partial/i);
    assert.doesNotMatch(JSON.stringify(output), /secret-malformed/);
    const active = await codexFixture(join(root, "active"), false, true);
    snapshot = await analyzeMachineSessions(active.options);
    assert.ok(snapshot.sessions.every((s) => s.transcript.liveness === "unknown"));
    const unresolved = report(snapshot.sessions);
    assert.equal(unresolved.coverage.find((c) => c.rule === "session-outlier")!.eligibleSessions, 0);
    assert.match(unresolved.warnings.join(" "), /unknown.*liveness|liveness.*unknown/i);
    assert.ok(unresolved.items.every((c) => c.confidence !== "high"));
    // No timestamps imply no proof of activity, while explicit starts at scan time do.
    const files = await readdir(active.options.codexRoot!);
    for (const file of files) await appendFile(join(active.options.codexRoot!, file), jsonl([{ type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "task_started" } }]));
    snapshot = await analyzeMachineSessions(active.options);
    assert.ok(snapshot.sessions.every((s) => s.transcript.liveness === "active"));
    assert.equal(report(snapshot.sessions).items.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("UTC date filters use instants and exclude invalid starts only when a date bound is present", () => {
  const items = sessions(7);
  const starts = ["2026-09-01T23:30:00-07:00", "2026-09-02T06:30:00Z", "2026-09-02T00:00:00Z", "2026-09-02T23:59:59.999Z", "2026-09-03T00:00:00Z", "", "invalid-start"];
  items.forEach((s, i) => { s.createdAt = starts[i]!; });
  const snapshot = { sessions: items, repositories: [], generatedAt: "2026-10-01T00:00:00Z" } as unknown as MachineAnalytics;
  assert.deepEqual(filterInsightSessions(snapshot, { from: "2026-09-02", through: "2026-09-02" }).map((s) => s.sessionKey), items.slice(0, 4).map((s) => s.sessionKey));
  assert.equal(filterInsightSessions(snapshot, {}).length, 7);
  assert.equal(filterInsightSessions(snapshot, { through: "2026-09-02" }).length, 4);
  assert.match(insightsForSnapshot(snapshot, context(), { from: "2026-09-02" }).warnings.join(" "), /2.*invalid or missing.*start/i);
});

test("next-tier mapping ignores an insufficient cheapest alternative and keeps the sufficient mapped target", () => {
  const items = sessions(5), config = context();
  config.rateCard.models["claude-cheapest"] = { ...testRateCard.models["claude-small"]!, inputPerMillion: 0.01, outputPerMillion: 0.01, longContext: { thresholdInputTokens: 50_000, inputMultiplier: 2, outputMultiplier: 2 } };
  items.forEach((s, index) => {
    s.metrics.maxInputTokensPerCall = index === 0 ? 20_000 : 60_000;
    s.tokens = tokens({ uncachedInputTokens: index === 0 ? 400_000 : 60_000, cachedInputTokens: 0, outputTokens: 100 });
    s.cost = calculateCost(testRateCard.models["claude-premium"]!, s.tokens, s.metrics.maxInputTokensPerCall);
    s.models = [{ ...s.tokens, ...s.cost, model: "claude-premium", calls: 20, priced: true }];
  });
  // Make the all-session alternative's difference smaller than the insufficient cheapest candidate.
  config.rateCard.models["claude-small"]!.inputPerMillion = 3;
  const card = report(items, config).items.find((c) => c.rule === "model-pricing");
  assert.ok(card); assert.deepEqual(card.names, ["claude-small"]); assert.equal(card.coverage.eligibleSessions, 5);
});

test("overlapping legacy MCP names remain ambiguous instead of confirming both servers", () => {
  const items = sessions(10), config = context();
  config.inventory = [{ provider: "claude", skills: [], mcpServers: ["foo", "foo_bar", "used"] }];
  items[0]!.tools = { mcp_foo_bar_search: 1, mcp__used__search: 1, Read: 100 };
  const output = report(items, config), card = output.items.find((c) => c.rule === "unused-mcp");
  assert.ok(card); assert.deepEqual(card.names, ["foo", "foo_bar"]);
  assert.match(card.guardrail, /ambiguous/i);
  assert.ok(card.evidence.some((e) => e.label === "Names with ambiguous attribution" && e.value === 2));
  items[0]!.tools = { mcp__foo_bar__search: 1, mcp__used__search: 1, Read: 100 };
  assert.deepEqual(report(items, config).items.find((c) => c.rule === "unused-mcp")!.names, ["foo"]);
  config.inventory[0]!.mcpServers = ["foo"];
  items[0]!.tools = { mcp_foo_bar_search: 1, Read: 100 };
  assert.deepEqual(report(items, config).items.find((c) => c.rule === "unused-mcp")!.names, ["foo"]);
});

test("structured MCP attribution is bounded, deduplicated and takes precedence over ambiguous spellings", async () => {
  const root = await mkdtemp(join(tmpdir(), "insights-mcp-attribution-"));
  try {
    const fixture = await createInsightsFixture(root);
    await writeFile(fixture.source, (await readFile(fixture.source, "utf8")).replaceAll('"type":"assistant"', '"type":"assistant","attributionMcpServer":"foo_bar"'));
    await appendFile(fixture.source, jsonl([{ type: "assistant", attributionMcpServer: "/secret-server-path", message: { id: "empty", content: [{ type: "tool_use", id: "empty", name: "Read", input: { secret: "secret-attribution-args" } }] } }]));
    let snapshot = await analyzeMachineSessions(fixture.options);
    assert.equal(snapshot.sessions.find((s) => s.sessionKey === fixture.sessionKey)!.insightSignals!.mcpServers!["foo_bar"], 20);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-server-path|secret-attribution-args/);
    const codex = await codexFixture(join(root, "codex-case"));
    const item = { type: "event_msg", payload: { type: "item_completed", item: { id: "mcp-call", type: "McpToolCall", server: "foo_bar", tool: "search", result: "secret-mcp-result" } } };
    for (const path of await readdir(codex.options.codexRoot!)) await appendFile(join(codex.options.codexRoot!, path), jsonl([
      item, item,
      { type: "event_msg", payload: { type: "item_completed", item: { id: "invalid", type: "McpToolCall", server: "/secret-server-path" } } },
      ...Array.from({ length: 10 }, (_, i) => ({ type: "response_item", payload: { type: "function_call", call_id: `call-${i}`, name: "mcp_foo_bar_search", arguments: "secret-mcp-args" } })),
    ]));
    snapshot = await analyzeMachineSessions(codex.options);
    assert.ok(snapshot.sessions.every((s) => s.insightSignals!.mcpServers!["foo_bar"] === 1));
    const config = context(); config.thresholds.extensionMinSessions = 5;
    config.inventory = [{ provider: "codex", skills: [], mcpServers: ["foo", "foo_bar"] }];
    const output = report(snapshot.sessions, config);
    assert.deepEqual(output.items.find((c) => c.rule === "unused-mcp")!.names, ["foo"]);
    assert.doesNotMatch(JSON.stringify({ snapshot, output }), /secret-server-path|secret-mcp|22222222-2222/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("active child evidence prevents a completed Claude parent from becoming a peer baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "insights-active-child-"));
  try {
    const fixture = await createInsightsFixture(root);
    const directory = fixture.source.slice(0, -6) + "/subagents";
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "agent-synthetic.jsonl"), jsonl([{ type: "user", timestamp: new Date().toISOString(), message: { content: "secret-child-prompt" } }]));
    const snapshot = await analyzeMachineSessions(fixture.options);
    const selected = snapshot.sessions.find((s) => s.sessionKey === fixture.sessionKey)!;
    assert.equal(selected.transcript.liveness, "active");
    assert.equal(report(snapshot.sessions).coverage.find((r) => r.rule === "session-outlier")!.eligibleSessions, 5);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-child-prompt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review source checks stay scoped to the requested key and preserve unrelated numeric evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "insights-review-scope-"));
  try {
    const fixture = await createInsightsFixture(root);
    const other = fixture.source.replace("11111111-1111", "22222222-1111");
    const lines = (await readFile(other, "utf8")).trimEnd().split("\n");
    const first = JSON.parse(lines[0]!); first.message.content = "secret-large-prose" + "x".repeat(1_000_001); lines[0] = JSON.stringify(first);
    await writeFile(other, lines.join("\n") + "\n");
    const observed: string[] = [];
    const observer = Object.assign((s: ReturnType<typeof sessions>[number]) => { observed.push(s.sessionKey); }, { sessionKey: fixture.sessionKey });
    const snapshot = await analyzeMachineSessions(fixture.options, observer);
    assert.equal(snapshot.sessions.length, 6);
    assert.deepEqual(observed, [fixture.sessionKey]);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-large-prose/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
