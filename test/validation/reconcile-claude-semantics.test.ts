import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";

const sessionId = "77777777-7777-4777-8777-777777777777";
async function analyze(records: Array<Record<string, unknown>>) {
  const root = await mkdtemp(join(tmpdir(), "reconcile-claude-"));
  try {
    const projects = join(root, "profile", "projects"), repo = join(root, "fixture-repo");
    await mkdir(join(projects, "synthetic-project"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(projects, "synthetic-project", `${sessionId}.jsonl`), records.map((r) => JSON.stringify({ sessionId, cwd: repo, ...r })).join("\n") + "\n");
    const result = await analyzeMachineSessions({
      noIndex: true, additionalProviders: false, pricingPolicy: "reviewed-only", dataDir: join(root, "data"),
      claudeRoot: projects, codexRoot: join(root, "no-codex"), codexArchiveRoot: join(root, "no-archive"),
      databasePath: join(root, "no-conductor.db"), cursorDatabasePath: join(root, "no-cursor.db"),
    });
    const session = result.sessions.find((s) => s.provider === "claude");
    assert.ok(session);
    assert.equal(JSON.stringify(result).includes("SENTINEL_PRIVATE_TRANSCRIPT"), false);
    return session;
  } finally { await rm(root, { recursive: true, force: true }); }
}
function assistant(output: number, cache: number, creation = 0, ttl = 0) {
  return { type: "assistant", timestamp: `2026-09-01T10:00:${output === 4 ? "00" : "01"}.000Z`, message: {
    id: "synthetic-message", model: "claude-opus-4-8", content: [{ type: "text", text: "SENTINEL_PRIVATE_TRANSCRIPT" }],
    usage: { input_tokens: 2, cache_read_input_tokens: cache, cache_creation_input_tokens: creation,
      cache_creation: { ephemeral_5m_input_tokens: ttl, ephemeral_1h_input_tokens: 0 }, output_tokens: output },
  } };
}

test("RC-CLAUDE verified: final streamed usage keeps corrected input instead of independent counter maxima", async () => {
  const result = await analyze([assistant(4, 100, 12, 12), assistant(100, 80, 0, 12)]);
  assert.equal(result.tokens.cachedInputTokens, 80);
  assert.equal(result.tokens.cacheWriteInputTokens, 12);
  assert.equal(result.tokens.inputTokens, 94);
  assert.equal(result.tokens.outputTokens, 100);
  assert.equal(result.metrics.modelCalls, 1);
});

test("RC-CLAUDE verified: TTL detail recovers omitted cache creation without summing streamed repeats", async () => {
  const record = assistant(100, 80, 0, 17);
  const result = await analyze([record, record]);
  assert.equal(result.tokens.cacheWriteInputTokens, 17);
  assert.equal(result.tokens.inputTokens, 99);
  assert.equal(result.tokens.outputTokens, 100);
  assert.equal(result.metrics.modelCalls, 1);
});

test("RC-CLAUDE verified: an old zero cost-state cannot erase later request evidence", async () => {
  const result = await analyze([{ type: "cost-state", totalCostUSD: 0, modelUsage: {}, startTime: Date.parse("2026-09-01T09:00:00Z") }, assistant(100, 80, 17, 17)]);
  assert.equal(result.tokens.inputTokens, 99);
  assert.equal(result.tokens.outputTokens, 100);
  assert.ok(result.cost.totalUsd > 0);
});
