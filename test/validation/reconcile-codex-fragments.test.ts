import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

const primaryId = "11111111-1111-4111-8111-111111111111";
const syntheticSentinel = "SYNTHETIC_PRIVATE_FRAGMENT_CONTENT";
const token = (timestamp: string, input: number, cached: number, output: number,
  totalInput: number, totalCached: number, totalOutput: number, reasoning = 0, totalReasoning = 50) => ({
  timestamp, type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: totalInput, cached_input_tokens: totalCached,
      output_tokens: totalOutput, reasoning_output_tokens: totalReasoning },
    last_token_usage: { input_tokens: input, cached_input_tokens: cached,
      output_tokens: output, reasoning_output_tokens: reasoning },
  } },
});

test("RC-CODEX-01: registered Codex usage includes UUID-suffixed continuation fragments once", async () => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-codex-fragments-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const records = [
      { type: "session_meta", timestamp: "2026-07-21T10:00:00Z",
        payload: { id: primaryId, cwd: "/fixtures/workspaces/conductor/codex-workspace" } },
      { type: "turn_context", timestamp: "2026-07-21T10:00:01Z", payload: { model: "gpt-5.4" } },
      // Exact repeated state from the earlier fragment: must not be charged twice.
      token("2026-07-21T10:00:02Z", 500, 400, 50, 1500, 1200, 150, 10),
      { type: "response_item", timestamp: "2026-07-21T10:00:03Z",
        payload: { type: "message", role: "assistant", content: syntheticSentinel } },
      token("2026-07-21T10:00:04Z", 300, 100, 30, 1800, 1300, 180),
      { type: "event_msg", timestamp: "2026-07-21T10:00:05Z", payload: { type: "task_complete" } },
    ];
    await writeFile(join(fixture.codexArchiveRoot, `rollout-2026-07-21T10-00-00-${primaryId}_88888888-8888-4888-8888-888888888888.jsonl`), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const result = await analyzeMachineSessions({ ...fixture, pricingPolicy: "reviewed-only" });
    const primary = result.sessions.find(s => s.provider === "codex" && s.tokens.inputTokens >= 1500);
    assert.ok(primary);
    assert.equal(primary.tokens.inputTokens, 1800, "the continuation's 300 input tokens disappeared");
    assert.equal(primary.tokens.outputTokens, 180);
    assert.equal(primary.transcript.files, 2);
    assert.equal(primary.lastEventAt, "2026-07-21T10:00:05.000Z");
    assert.equal(result.sessions.filter(s => s.provider === "codex").length, 2);
    assert.equal(JSON.stringify(result).includes(syntheticSentinel), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RC-CODEX-01: directly discovered continuation fragments form one session", async () => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-codex-discovered-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const id = "77777777-7777-4777-8777-777777777777";
    const first = [
      { type: "session_meta", timestamp: "2026-07-22T10:00:00Z", payload: { id, cwd: fixture.repositoryRoot } },
      { type: "turn_context", timestamp: "2026-07-22T10:00:01Z", payload: { model: "gpt-5.4" } },
      token("2026-07-22T10:00:02Z", 123, 20, 11, 123, 20, 11, 0, 0),
    ];
    const second = [
      { type: "session_meta", timestamp: "2026-07-23T10:00:00Z", payload: { id, cwd: fixture.repositoryRoot } },
      { type: "turn_context", timestamp: "2026-07-23T10:00:01Z", payload: { model: "gpt-5.4" } },
      token("2026-07-23T10:00:02Z", 234, 30, 22, 357, 50, 33, 0, 0),
    ];
    await writeFile(join(fixture.codexRoot, `rollout-2026-07-22T10-00-00-${id}.jsonl`), first.map(record => JSON.stringify(record)).join("\n") + "\n");
    await writeFile(join(fixture.codexArchiveRoot, `rollout-2026-07-23T10-00-00-${id}.jsonl`), second.map(record => JSON.stringify(record)).join("\n") + "\n");
    const result = await analyzeMachineSessions({ ...fixture, pricingPolicy: "reviewed-only" });
    const discovered = result.sessions.find(s => s.firstEventAt === "2026-07-22T10:00:00.000Z");
    assert.ok(discovered);
    assert.equal(discovered.tokens.inputTokens, 357);
    assert.equal(discovered.tokens.outputTokens, 33);
    assert.equal(discovered.transcript.files, 2);
    assert.equal(result.sessions.filter(s => s.provider === "codex").length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
