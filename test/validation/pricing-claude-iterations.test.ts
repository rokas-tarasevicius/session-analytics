import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

test("PRICING-ITERATIONS: bill both output-producing fallback attempts at their own models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pricing-validation-iterations-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    const root = join(fixture.claudeRoot, "-synthetic-billing"); await mkdir(root);
    const id = "77777777-2222-4222-8222-222222222222";
    const primary = { type: "message", model: "claude-fable-5-1", input_tokens: 20,
      cache_read_input_tokens: 300, cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 }, output_tokens: 40 };
    const fallback = { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 10,
      cache_read_input_tokens: 200, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 50 };
    const record = { type: "assistant", timestamp: "2026-09-01T10:00:00Z", sessionId: id,
      cwd: fixture.repositoryRoot, message: { id: "synthetic-fallback", model: fallback.model,
        content: [{ type: "text", text: "PRIVATE_VALIDATION_SENTINEL" }],
        // Real format: returned-attempt counters, with a retained primary TTL breakdown.
        usage: { ...fallback, cache_creation: primary.cache_creation, iterations: [primary, fallback] } } };
    await writeFile(join(root, `${id}.jsonl`), JSON.stringify(record) + "\n" + JSON.stringify(record) + "\n");
    const result = await analyzeMachineSessions({ ...fixture, offline: true, pricingPolicy: "reviewed-only" });
    const session = result.sessions.find(s => s.firstEventAt === "2026-09-01T10:00:00.000Z")!;
    assert.ok(session);
    // 20+300+100 primary input, 10+200 fallback input. Repeated streamed record bills once.
    assert.equal(session.tokens.inputTokens, 630);
    assert.equal(session.tokens.outputTokens, 90);
    assert.equal(session.tokens.cacheWriteInputTokens, 100);
    assert.equal(session.models.length, 2);
    const primaryUsd = (20 * 10 + 300 * 0.25 + 100 * 12.5 + 40 * 50) / 1e6;
    const fallbackUsd = (10 * 5 + 200 * 0.5 + 50 * 25) / 1e6;
    assert.ok(Math.abs(session.cost.totalUsd - primaryUsd - fallbackUsd) < 1e-12);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALIDATION_SENTINEL/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
