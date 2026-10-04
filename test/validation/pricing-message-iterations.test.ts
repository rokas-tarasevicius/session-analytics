import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { validateSnapshot } from "../../src/interop/snapshot.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

async function messageIterations(count: 1 | 2, thinking?: number, ambiguousTtl = false) {
  const directory = await mkdtemp(join(tmpdir(), "pricing-message-iterations-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    const root = join(fixture.claudeRoot, "-synthetic-message-iterations"); await mkdir(root);
    const id = "88888888-2222-4222-8222-222222222222";
    // Official Opus4.6 launch pricing: >200k input costs2x input/1.5x output.
    // This fixture's historical card is explicit; current rates are not substituted.
    const rateCardPath = join(directory, "historical-rate-card.json");
    await writeFile(rateCardPath, JSON.stringify({ currency: "USD", effectiveDate: "2026-02-05", models: {
      "claude-opus-4-6": { provider: "claude", inputPerMillion: 5, cacheReadPerMillion: 0.5,
        cacheWrite5mPerMillion: 6.25, cacheWrite1hPerMillion: 10, outputPerMillion: 25,
        longContext: { thresholdInputTokens: 200000, inputMultiplier: 2, outputMultiplier: 1.5 },
        source: "https://www.anthropic.com/news/claude-opus-4-6" },
    } }));
    const step = { type: "message", input_tokens: 150001, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
    const iterations = ambiguousTtl ? [
      { ...step, input_tokens: 149901, cache_creation_input_tokens: 100, cache_creation: undefined, output_tokens: 10 },
      { ...step, input_tokens: 249901, cache_creation_input_tokens: 100, cache_creation: undefined, output_tokens: 20 },
    ] : [{ ...step, output_tokens: 10 }, ...(count === 2 ? [{ ...step, output_tokens: 20 }] : [])];
    const input = ambiguousTtl ? 399802 : count * 150001, output = count === 1 ? 10 : 30;
    const record = { type: "assistant", timestamp: "2026-02-15T10:00:00Z", sessionId: id,
      cwd: fixture.repositoryRoot, message: { id: "synthetic-tool-loop", model: "claude-opus-4-6", content: [],
        usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: ambiguousTtl ? 200 : 0, output_tokens: output,
          ...(ambiguousTtl ? { cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 100 } } : {}),
          ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } }), iterations } } };
    await writeFile(join(root, `${id}.jsonl`), JSON.stringify(record) + "\n" + JSON.stringify(record) + "\n");
    const result = validateSnapshot(await analyzeMachineSessions({ ...fixture, offline: true, rateCardPath }));
    const session = result.sessions.find(s => s.firstEventAt === "2026-02-15T10:00:00.000Z");
    assert.ok(session);
    return session;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("PRICING-MESSAGE-ITERATIONS: tool-loop aggregate is not one long-context request", async () => {
  const session = await messageIterations(2);
  assert.equal(session.tokens.inputTokens, 300002);
  assert.equal(session.tokens.outputTokens, 30);
  const expected = (300002 * 5 + 30 * 25) / 1e6;
  assert.ok(Math.abs(session.cost.totalUsd - expected) < 1e-12,
    `actual=${session.cost.totalUsd}; independent per-iteration oracle=${expected}`);
  assert.equal(session.metrics.maxInputTokensPerCall, 150001);
  assert.equal(session.metrics.modelCalls, 2);
  assert.equal(session.metrics.assistantMessages, 1);
});

test("PRICING-MESSAGE-ITERATIONS: a single mirrored iteration remains one request", async () => {
  const session = await messageIterations(1, 5);
  assert.equal(session.tokens.inputTokens, 150001);
  assert.equal(session.tokens.outputTokens, 10);
  assert.equal(session.tokens.reasoningOutputTokens, 5);
  assert.equal(session.metrics.modelCalls, 1);
  const expected = (150001 * 5 + 10 * 25) / 1e6;
  assert.ok(Math.abs(session.cost.totalUsd - expected) < 1e-12);
});

test("PRICING-MESSAGE-ITERATIONS: aggregate thinking survives per-iteration pricing", async () => {
  const session = await messageIterations(2, 15);
  assert.equal(session.tokens.reasoningOutputTokens, 15);
  assert.equal(session.tokens.nonReasoningOutputTokens, 15);
  assert.equal(session.tokens.outputTokens, 30);
  assert.equal(session.metrics.modelCalls, 2);
  const values = session.velocity!.buckets.flatMap(bucket => [bucket[3]]);
  assert.equal(values.reduce((sum, value) => sum + value[6], 0), 15);
  assert.equal(values.reduce((sum, value) => sum + value[11], 0), 0);
  assert.ok(Math.abs(session.cost.totalUsd - (300002 * 5 + 30 * 25) / 1e6) < 1e-12);
});


test("PRICING-MESSAGE-ITERATIONS: aggregate TTL preserves totals but cannot fix a request allocation", async () => {
  const session = await messageIterations(2, undefined, true);
  assert.equal(session.tokens.inputTokens, 400002);
  assert.equal(session.tokens.cacheWriteInputTokens, 200);
  assert.equal(session.tokens.cacheWrite5mInputTokens, 100);
  assert.equal(session.tokens.cacheWrite1hInputTokens, 100);
  assert.equal(session.costComplete, false);
  assert.ok(session.pricedTokenCoverage! < 1);
  const fixed = (149901 * 5 + 249901 * 10 + 10 * 25 + 20 * 37.5) / 1e6;
  const shortHour = fixed + (100 * 10 + 100 * 6.25 * 2) / 1e6;
  const longHour = fixed + (100 * 6.25 + 100 * 10 * 2) / 1e6;
  assert.notEqual(shortHour, longHour);
  assert.ok(session.cost.totalUsd <= Math.min(shortHour, longHour));
  assert.ok(session.cost.upperEstimateUsd >= Math.max(shortHour, longHour));
  assert.ok(session.transcript.warnings.some(warning => warning.includes("allocation across iterations is unavailable")));
});
