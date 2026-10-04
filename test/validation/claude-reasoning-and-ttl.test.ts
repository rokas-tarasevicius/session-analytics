import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import type { SessionAnalytics } from "../../src/types.ts";
import { loadMachineSnapshot, validateSnapshot } from "../../src/interop/snapshot.ts";
import { exportFiles } from "../../src/interop/exports.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

const sessionId = "22222222-2222-4222-8222-222222222222";
const sessionKey = createHash("sha256").update("conductor-claude").digest("hex").slice(0, 12);
const sentinel = "PRIVATE_VALIDATION_MESSAGE_MUST_NOT_ESCAPE";

async function analyzeUsage(records: Record<string, unknown>[]): Promise<SessionAnalytics> {
  const directory = await mkdtemp(join(tmpdir(), "claude-reasoning-ttl-validation-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory, "claude-opus-5");
    const root = join(fixture.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace");
    await rm(join(root, sessionId, "subagents"), { recursive: true, force: true });
    const rows = records.map((usage, index) => ({ type: "assistant", sessionId, cwd: "/fixtures/workspaces/conductor/claude-workspace", uuid: `synthetic-${index}`,
      timestamp: `2026-07-20T12:01:0${index}Z`, message: { id: "synthetic-request", model: "claude-opus-5",
        role: "assistant", content: [{ type: "text", text: sentinel }], usage } }));
    await writeFile(join(root, `${sessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const snapshot = await analyzeMachineSessions({ ...fixture, offline: true, pricingPolicy: "reviewed-only" });
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes(sentinel));
    // A parser fix must remain importable and exportable, including unknown output detail.
    const snapshotPath = join(directory, "snapshot.json");
    await writeFile(snapshotPath, serialized);
    const imported = await loadMachineSnapshot(snapshotPath);
    assert.deepEqual(validateSnapshot(JSON.parse(serialized)), imported);
    for (const format of ["csv", "ndjson", "otlp-json"] as const) {
      const exported = exportFiles(imported, format);
      assert.ok(Object.keys(exported).length > 0);
      for (const content of Object.values(exported)) assert.ok(!content.includes(sentinel));
    }
    const session = snapshot.sessions.find(session => session.sessionKey === sessionKey);
    assert.ok(session);
    return session;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Claude unknown reasoning does not claim all output is known non-reasoning", async () => {
  const session = await analyzeUsage([{ input_tokens: 10, output_tokens: 100 }]);
  assert.equal(session.tokens.outputTokens, 100);
  assert.equal(session.tokens.reasoningOutputTokens, 0);
  // docs/metrics.md: derive non-reasoning output only when a separate breakdown is exposed.
  assert.equal(session.tokens.nonReasoningOutputTokens, 0);
});

test("Claude tied output snapshot retains a newly available one-hour TTL breakdown", async () => {
  const session = await analyzeUsage([
    { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 200 },
    { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 } },
  ]);
  assert.equal(session.tokens.cacheWriteInputTokens, 200);
  assert.equal(session.tokens.cacheWrite1hInputTokens, 200);
  assert.equal(session.cost.cacheWriteUsd, 0.002);
  assert.equal(session.pricedTokenCoverage, 1);
});

test("Claude tied output snapshot retains a later growing thinking counter", async () => {
  const session = await analyzeUsage([
    { input_tokens: 10, output_tokens: 100, output_tokens_details: { thinking_tokens: 0 } },
    { input_tokens: 10, output_tokens: 100, output_tokens_details: { thinking_tokens: 80 } },
  ]);
  assert.equal(session.tokens.outputTokens, 100);
  assert.equal(session.tokens.reasoningOutputTokens, 80);
  assert.equal(session.tokens.nonReasoningOutputTokens, 20);
});

test("Claude invalid or missing TTL entries preserve unsplit writes and explicit valid counters", async () => {
  const session = await analyzeUsage([{ input_tokens: 10, output_tokens: 100,
    cache_creation_input_tokens: 200,
    cache_creation: { ephemeral_5m_input_tokens: "150", ephemeral_1h_input_tokens: 50 },
    output_tokens_details: { thinking_tokens: 20 } }]);
  assert.equal(session.tokens.cacheWriteInputTokens, 200);
  assert.equal(session.tokens.cacheWrite5mInputTokens, 0);
  assert.equal(session.tokens.cacheWrite1hInputTokens, 50);
  assert.equal(session.tokens.reasoningOutputTokens, 20);
  assert.equal(session.tokens.nonReasoningOutputTokens, 80);
  assert.equal(session.cost.cacheWriteUsd, (150 * 6.25 + 50 * 10) / 1e6);
  assert.equal(session.pricedTokenCoverage, 160 / 310);
});

test("Claude split-only writes reconcile the aggregate and clamp thinking to output", async () => {
  const session = await analyzeUsage([{ input_tokens: 10, output_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 150, ephemeral_1h_input_tokens: 50 },
    output_tokens_details: { thinking_tokens: 200 } }]);
  assert.equal(session.tokens.cacheWriteInputTokens, 200);
  assert.equal(session.tokens.inputTokens, 210);
  assert.equal(session.tokens.reasoningOutputTokens, 100);
  assert.equal(session.tokens.nonReasoningOutputTokens, 0);
  assert.equal(session.cost.cacheWriteUsd, (150 * 6.25 + 50 * 10) / 1e6);
});
