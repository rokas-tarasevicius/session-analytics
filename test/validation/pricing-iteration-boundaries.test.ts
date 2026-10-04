import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { validateSnapshot } from "../../src/interop/snapshot.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

type Fields = Record<string, unknown>;
const primary: Fields = { type: "message", model: "claude-fable-5-1", input_tokens: 20,
  cache_read_input_tokens: 300, cache_creation_input_tokens: 100,
  cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 }, output_tokens: 40 };
const fallback: Fields = { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 10,
  cache_read_input_tokens: 200, cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 50 };

async function analyze(build: (p: Fields, f: Fields) => Fields[]) {
  const directory = await mkdtemp(join(tmpdir(), "pricing-iteration-boundary-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    const root = join(fixture.claudeRoot, "-synthetic-review"); await mkdir(root);
    const id = "99999999-2222-4222-8222-222222222222";
    const records = build(structuredClone(primary), structuredClone(fallback)).map(message => ({
      type: "assistant", timestamp: "2026-09-01T10:00:00Z", sessionId: id, cwd: fixture.repositoryRoot,
      message: { id: "review-stream", content: [], ...message },
    }));
    await writeFile(join(root, `${id}.jsonl`), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const result = validateSnapshot(await analyzeMachineSessions({ ...fixture, offline: true, pricingPolicy: "reviewed-only" }));
    const session = result.sessions.find(s => s.firstEventAt === "2026-09-01T10:00:00.000Z");
    assert.ok(session); return session;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("PRICING-ITERATIONS: missing primary model remains unpriced", async () => {
  const session = await analyze((p, f) => { delete p.model; return [{ model: f.model, usage: { ...f, iterations: [p, f] } }]; });
  assert.equal(session.costComplete, false);
  assert.equal(session.tokens.inputTokens, 630);
  assert.ok(session.models.some(model => model.model === "<unknown>"));
});

test("PRICING-ITERATIONS: returned fallback may inherit the returned model", async () => {
  const session = await analyze((p, f) => [{ model: f.model, usage: { ...f, iterations: [p, { ...f, model: undefined }] } }]);
  assert.equal(session.costComplete, true);
  assert.equal(session.tokens.inputTokens, 630);
});

test("PRICING-ITERATIONS: equal-output final snapshot adds complete attempt accounting", async () => {
  const session = await analyze((p, f) => [{ model: f.model, usage: f }, { model: f.model, usage: { ...f, iterations: [p, f] } }]);
  assert.equal(session.tokens.inputTokens, 630);
  assert.equal(session.tokens.outputTokens, 90);
});

test("PRICING-ITERATIONS: incomplete early stream does not taint complete final billing", async () => {
  const session = await analyze((p, f) => [
    { model: f.model, usage: { ...f, iterations: [{ ...p, output_tokens: undefined }, f] } },
    { model: f.model, usage: { ...f, output_tokens: 51, iterations: [p, { ...f, output_tokens: 51 }] } },
  ]);
  assert.equal(session.tokens.outputTokens, 91);
  assert.equal(session.costComplete, true);
  assert.ok(!session.transcript.warnings.some(warning => warning.includes("Iteration billing is incomplete")));
});

test("PRICING-ITERATIONS: fallback output reset still replaces primary stream snapshot", async () => {
  const session = await analyze((p, f) => {
    p.output_tokens = 500;
    return [{ model: p.model, usage: p }, { model: f.model, usage: { ...f, iterations: [p, f] } }];
  });
  assert.equal(session.tokens.inputTokens, 630);
  assert.equal(session.tokens.outputTokens, 550);
});

test("PRICING-ITERATIONS: compaction is additional billed work at the executor model", async () => {
  const session = await analyze((p, f) => [{ model: f.model, usage: {
    ...f, iterations: [{ ...p, type: "compaction", model: undefined }, { ...f, type: "message", model: undefined }],
  } }]);
  assert.equal(session.tokens.inputTokens, 630);
  assert.equal(session.tokens.outputTokens, 90);
  assert.equal(session.models.length, 1);
  const expected = (30 * 5 + 500 * 0.5 + 100 * 6.25 + 90 * 25) / 1e6;
  assert.ok(Math.abs(session.cost.totalUsd - expected) < 1e-12);
});

test("PRICING-ITERATIONS: advisor has its own rate and executor iterations are not counted twice", async () => {
  const session = await analyze((p, f) => [{ model: f.model, usage: {
    ...f, input_tokens: 20, cache_read_input_tokens: 400,
    iterations: [{ ...f, type: "message", model: undefined, output_tokens: 20 },
      { ...p, type: "advisor_message" }, { ...f, type: "message", model: undefined, output_tokens: 30 }],
  } }]);
  assert.equal(session.tokens.inputTokens, 840);
  assert.equal(session.tokens.outputTokens, 90);
  const expected = (20 * 10 + 300 * 0.25 + 100 * 12.5 + 40 * 50 + 20 * 5 + 400 * 0.5 + 50 * 25) / 1e6;
  assert.ok(Math.abs(session.cost.totalUsd - expected) < 1e-12);
});

test("PRICING-ITERATIONS: ordinary message-only iterations do not duplicate top-level usage", async () => {
  const session = await analyze((p) => [{ model: p.model, usage: {
    ...p, input_tokens: 40, cache_read_input_tokens: 600, cache_creation_input_tokens: 200,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 }, output_tokens: 80,
    iterations: [p, p],
  } }]);
  assert.equal(session.tokens.inputTokens, 840);
  assert.equal(session.tokens.outputTokens, 80);
});

test("PRICING-ITERATIONS: zero-output refusal does not fabricate a billed primary attempt", async () => {
  const session = await analyze((p, f) => [{ model: f.model, usage: { ...f, iterations: [{ ...p, output_tokens: 0 }, f] } }]);
  assert.equal(session.costComplete, false);
  assert.equal(session.tokens.inputTokens, 210);
  assert.equal(session.tokens.outputTokens, 50);
  assert.ok(Math.abs(session.cost.totalUsd - (10 * 5 + 200 * 0.5 + 50 * 25) / 1e6) < 1e-12);
});

test("PRICING-ITERATIONS: unknown iteration type preserves partial coverage", async () => {
  const session = await analyze((p, f) => [{ model: f.model, usage: { ...f, iterations: [{ ...p, type: "future_usage_kind" }, f] } }]);
  assert.equal(session.costComplete, false);
  assert.equal(session.tokens.inputTokens, 210);
});

test("PRICING-ITERATIONS: missing compaction counters are not invented as known zero", async () => {
  const session = await analyze((p, f) => [{ model: f.model, usage: {
    ...f, iterations: [{ ...p, type: "compaction", cache_read_input_tokens: undefined }, { ...f, type: "message" }],
  } }]);
  assert.equal(session.costComplete, false);
});

test("PRICING-ITERATIONS: equal-output final iteration details retain reported thinking", async () => {
  const session = await analyze((p, f) => [
    { model: f.model, usage: { ...f, iterations: [p, f] } },
    { model: f.model, usage: { ...f, iterations: [
      { ...p, output_tokens_details: { thinking_tokens: 20 } },
      { ...f, output_tokens_details: { thinking_tokens: 10 } },
    ] } },
  ]);
  assert.equal(session.tokens.outputTokens, 90);
  assert.equal(session.tokens.reasoningOutputTokens, 30);
});

test("PRICING-ITERATIONS: richer partial final snapshot preserves known tokens", async () => {
  const session = await analyze((p, f) => [
    { model: f.model, usage: { ...f, iterations: [{ ...p, model: undefined, input_tokens: undefined }, f] } },
    { model: f.model, usage: { ...f, iterations: [{ ...p, model: undefined }, f] } },
  ]);
  assert.equal(session.tokens.inputTokens, 630);
  assert.equal(session.costComplete, false);
});

test("PRICING-ITERATIONS: late per-attempt TTL replaces the initial unknown TTL", async () => {
  const session = await analyze((p, f) => [
    { model: f.model, usage: { ...f, iterations: [{ ...p, cache_creation: undefined }, f] } },
    { model: f.model, usage: { ...f, iterations: [
      { ...p, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } }, f,
    ] } },
  ]);
  assert.equal(session.tokens.cacheWrite1hInputTokens, 100);
  assert.ok(Math.abs(session.cost.cacheWriteUsd - 100 * 20 / 1e6) < 1e-12);
});
