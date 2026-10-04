import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";

const sessionId = "11111111-1111-4111-8111-111111111111";
const sentinel = "PRIVATE_ITERATION_CONTENT_DO_NOT_RETURN";

async function analyze(t: TestContext, iterations: boolean | "single" | "single-ttl" | "single-tie") {
  const root = await mkdtemp(join(tmpdir(), "claude-iterations-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeRoot = join(root, "claude");
  const repository = join(root, "repository");
  await mkdir(claudeRoot, { recursive: true });
  await mkdir(join(repository, ".git"), { recursive: true });
  const initial = { type: "message", model: "claude-opus-5-5", input_tokens: 100,
    cache_read_input_tokens: 1000, cache_creation_input_tokens: 40, output_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 } };
  const fallback = { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 2,
    cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 80,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
  const records = [0, 1, 2].map(index => ({ type: "assistant", sessionId, cwd: repository,
    uuid: `synthetic-event-${index}`, requestId: "synthetic-request", timestamp: `2026-09-01T12:00:0${index}Z`,
    message: { id: "synthetic-message", model: "claude-opus-4-8", stop_reason: "end_turn",
      content: [{ type: "text", text: sentinel }], usage: { ...fallback,
        cache_creation_input_tokens: iterations === "single-ttl" || iterations === "single-tie" ? 40 : 0,
        output_tokens_details: iterations === "single-tie" && index > 0 ? undefined : { thinking_tokens: 60 },
        // The outer fallback snapshot retains the initial attempt's TTL fields.
        cache_creation: iterations === true ? initial.cache_creation : iterations === "single-ttl" || (iterations === "single-tie" && index > 0) ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40 } : fallback.cache_creation,
        iterations: iterations === true ? [initial, fallback] : typeof iterations === "string" ? [{ ...fallback,
          cache_creation_input_tokens: iterations === "single" ? 0 : 40,
          cache_creation: undefined, model: undefined, type: "message" }] : [], fallback_credit: null } } }));
  await writeFile(join(claudeRoot, `${sessionId}.jsonl`), records.map(x => JSON.stringify(x)).join("\n") + "\n");
  const result = await analyzeMachineSessions({ noIndex: true, additionalProviders: false,
    pricingPolicy: "reviewed-only", dataDir: join(root, "data"), claudeRoot,
    codexRoot: join(root, "missing-codex"), codexArchiveRoot: join(root, "missing-archive"),
    cursorDatabasePath: join(root, "missing-cursor.db"), databasePath: join(root, "missing-conductor.db") });
  assert.equal(result.sessions.length, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
  return result.sessions[0]!;
}

test("Claude fallback iterations retain every physical model usage once despite streamed duplicate blocks", async t => {
  const session = await analyze(t, true);
  assert.equal(session.tokens.outputTokens, 100, "20 initial output + 80 fallback output");
  assert.equal(session.tokens.inputTokens, 2042);
  assert.equal(session.tokens.uncachedInputTokens, 102);
  assert.equal(session.tokens.cachedInputTokens, 1900);
  assert.equal(session.metrics.assistantMessages, 1, "one visible assistant message remains one message");
  assert.equal(session.metrics.modelCalls, 2, "two physical model attempts");
});

test("Claude fallback TTL writes belong to the initial iteration model, not stale outer fallback metadata", async t => {
  const session = await analyze(t, true);
  const fallback = session.models.find(model => model.model === "claude-opus-4-8");
  assert.ok(fallback);
  assert.equal(fallback.cacheWriteInputTokens, 0);
  assert.equal(fallback.cacheWrite5mInputTokens, 0);
  const initial = session.models.find(model => model.model === "claude-opus-5-5");
  assert.ok(initial);
  assert.equal(initial.cacheWriteInputTokens, 40);
});

test("Claude iteration API-equivalent value sums independently priced model attempts", async t => {
  const session = await analyze(t, true);
  assert.ok(Math.abs(session.cost.totalUsd - 0.00366) < 1e-12,
    `expected initial 0.0012 + fallback 0.00246, received ${session.cost.totalUsd}`);
  assert.equal(session.tokens.reasoningOutputTokens, 60, "only the final attempt exposes thinking");
});

test("Claude empty iteration arrays preserve ordinary max-output stream deduplication", async t => {
  const session = await analyze(t, false);
  assert.equal(session.tokens.outputTokens, 80);
  assert.equal(session.tokens.inputTokens, 902);
  assert.equal(session.metrics.modelCalls, 1);
  assert.ok(Math.abs(session.cost.totalUsd - 0.00246) < 1e-12);
});

test("Claude ordinary single-iteration arrays inherit the outer model and thinking breakdown", async t => {
  const session = await analyze(t, "single");
  assert.equal(session.tokens.outputTokens, 80);
  assert.equal(session.tokens.reasoningOutputTokens, 60);
  assert.equal(session.models[0]?.model, "claude-opus-4-8");
  assert.ok(Math.abs(session.cost.totalUsd - 0.00246) < 1e-12);
});

test("Claude single iteration missing nested TTL preserves the matching outer TTL", async t => {
  const session = await analyze(t, "single-ttl");
  assert.equal(session.tokens.cacheWrite1hInputTokens, 40);
  assert.equal(session.tokens.reasoningOutputTokens, 60);
  assert.ok(Math.abs(session.cost.totalUsd - 0.00286) < 1e-12);
});

test("Claude single-iteration equal-output snapshots combine thinking and later TTL", async t => {
  const session = await analyze(t, "single-tie");
  assert.equal(session.tokens.cacheWrite1hInputTokens, 40);
  assert.equal(session.tokens.reasoningOutputTokens, 60);
  assert.ok(Math.abs(session.cost.totalUsd - 0.00286) < 1e-12);
});
