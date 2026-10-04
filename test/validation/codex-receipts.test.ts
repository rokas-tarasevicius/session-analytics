import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeRepositorySessions } from "../../src/analyzer.ts";
import type { SessionAnalytics } from "../../src/types.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

const id = "11111111-1111-4111-8111-111111111111";
const turn = "synthetic-turn-a";
const timestamp = (second: number) => `2026-07-20T10:00:${String(second).padStart(2, "0")}.000Z`;
const usage = (input: number, cached: number, output: number, reasoning = 0) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, cache_write_input_tokens: 0, total_tokens: input + output });
const record = (type: string, payload: Record<string, unknown>, second: number) => ({ type, payload, timestamp: timestamp(second) });
const receipt = (responseId: string, counts: ReturnType<typeof usage>, second: number, threadId = id) => record("token_usage_record", { thread_id: threadId, session_id: "synthetic-process", turn_id: turn, root_turn_id: turn, response_id: responseId, usage: counts, thread_token_usage: counts, turn_token_usage: counts }, second);
const counter = (total: ReturnType<typeof usage>, last: ReturnType<typeof usage>, second: number) => record("event_msg", { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 } }, second);

async function analyze(records: object[], sibling?: { id: string; records: object[] }, inspect?: (sessions: SessionAnalytics[]) => void) {
  const root = await mkdtemp(join(tmpdir(), "codex-receipt-validation-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const directory = join(fixture.codexRoot, "2026/07/20");
    const [filename] = await readdir(directory);
    assert.ok(filename);
    await writeFile(join(directory, filename), [
      record("session_meta", { id, cwd: "/fixtures/workspaces/conductor/codex-workspace", source: "cli" }, 0),
      record("turn_context", { model: "gpt-5.6-sol", turn_id: turn }, 1),
      record("event_msg", { type: "task_started", turn_id: turn }, 2),
      ...records,
      record("event_msg", { type: "task_complete", turn_id: turn }, 59),
    ].map(r => JSON.stringify(r)).join("\n") + "\n");
    if (sibling) await writeFile(join(directory, `rollout-2026-07-20T10-00-00-${sibling.id}.jsonl`), [
      record("session_meta", { id: sibling.id, cwd: fixture.repositoryRoot, source: "cli" }, 0),
      record("turn_context", { model: "gpt-5.6-sol", turn_id: turn }, 1),
      record("event_msg", { type: "task_started", turn_id: turn }, 2),
      ...sibling.records,
      record("event_msg", { type: "task_complete", turn_id: turn }, 59),
    ].map(r => JSON.stringify(r)).join("\n") + "\n");
    const result = await analyzeRepositorySessions({ ...fixture, pricingPolicy: "reviewed-only", repositoryRemote: fixture.remote });
    const sessionKey = createHash("sha256").update("conductor-codex").digest("hex").slice(0, 12);
    const session = result.sessions.find(s => s.sessionKey === sessionKey);
    assert.ok(session);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-response|synthetic-process|synthetic-turn|receipt-content-sentinel/);
    inspect?.(result.sessions);
    return session;
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("CODEX-01: receipt-only usage counts once per response identity", async () => {
  const one = receipt("synthetic-response-a", usage(1000, 800, 100, 30), 3);
  const session = await analyze([one, one]);
  assert.equal(session.tokens.inputTokens, 1000);
  assert.equal(session.tokens.cachedInputTokens, 800);
  assert.equal(session.tokens.outputTokens, 100);
  assert.equal(session.tokens.reasoningOutputTokens, 30);
  assert.equal(session.metrics.modelCalls, 1);
  assert.ok(Math.abs(session.cost.totalUsd - 0.0044) < 1e-12);
});

test("CODEX-01: compaction receipt missing from token_count remains billable", async () => {
  const session = await analyze([
    counter(usage(1000, 800, 100, 30), usage(1000, 800, 100, 30), 3),
    receipt("synthetic-response-compaction", usage(200, 100, 20), 4),
    record("compacted", { message: "receipt-content-sentinel", compaction_response_id: "synthetic-response-compaction" }, 5),
    counter(usage(1000, 800, 100, 30), usage(0, 0, 0), 6),
    counter(usage(1100, 850, 110, 30), usage(100, 50, 10), 7),
  ]);
  assert.equal(session.tokens.inputTokens, 1300);
  assert.equal(session.tokens.outputTokens, 130);
  assert.equal(session.metrics.modelCalls, 3);
});

test("CODEX-01: distinct equal-sized receipt-only responses both count", async () => {
  const counts = usage(1000, 800, 100, 30);
  const session = await analyze([receipt("synthetic-response-a", counts, 3), receipt("synthetic-response-b", counts, 4)]);
  assert.equal(session.tokens.inputTokens, 2000);
  assert.equal(session.tokens.outputTokens, 200);
  assert.equal(session.metrics.modelCalls, 2);
});

test("CODEX-01 guard: matching delayed counter and receipt do not double count", async () => {
  const counts = usage(1000, 800, 100, 30);
  const session = await analyze([receipt("synthetic-response-a", counts, 3), counter(counts, counts, 20)]);
  assert.equal(session.tokens.inputTokens, 1000);
  assert.equal(session.tokens.outputTokens, 100);
  assert.equal(session.metrics.modelCalls, 1);
});

test("CODEX-01 guard: current turn model prices a receipt-only long request", async () => {
  const session = await analyze([receipt("synthetic-response-long", usage(300000, 250000, 1000, 400), 3)]);
  assert.equal(session.tokens.inputTokens, 300000);
  assert.equal(session.metrics.maxInputTokensPerCall, 300000);
  assert.ok(Math.abs(session.cost.totalUsd - 0.795) < 1e-12);
});

test("CODEX-01: explicit identities preserve equal counters from independent threads", async () => {
  const counts = usage(1000, 800, 100, 30);
  const siblingId = "77777777-7777-4777-8777-777777777777";
  await analyze([receipt("synthetic-response-one", counts, 3), counter(counts, counts, 4)], {
    id: siblingId,
    records: [receipt("synthetic-response-two", counts, 3, siblingId), counter(counts, counts, 4)],
  }, sessions => {
    const keys = ["conductor-codex", `codex:${siblingId}`].map(s => createHash("sha256").update(s).digest("hex").slice(0, 12));
    const selected = sessions.filter(s => keys.includes(s.sessionKey));
    assert.equal(selected.length, 2);
    assert.equal(selected.reduce((n, s) => n + s.tokens.inputTokens, 0), 2000);
    assert.equal(selected.reduce((n, s) => n + s.tokens.outputTokens, 0), 200);
    assert.equal(selected.reduce((n, s) => n + s.metrics.modelCalls, 0), 2);
  });
});

test("CODEX-01: receipt turn_id resolves the earlier model after interleaved context", async () => {
  const session = await analyze([
    record("turn_context", { model: "gpt-6-astra", turn_id: "synthetic-turn-b" }, 3),
    receipt("synthetic-response-earlier-turn", usage(1000, 800, 100, 30), 4),
  ]);
  assert.equal(session.models.length, 1);
  assert.equal(session.models[0]?.model, "gpt-5.6-sol");
  assert.ok(Math.abs(session.cost.totalUsd - 0.0044) < 1e-12);
});

test("CODEX-01 guard: a counter replay selected in a later turn still matches the earlier receipt", async () => {
  const counts = usage(1000, 800, 100, 30);
  const session = await analyze([
    receipt("synthetic-response-earlier-counter", counts, 3),
    counter(counts, counts, 20),
    record("turn_context", { model: "gpt-5.6-sol", turn_id: "synthetic-turn-b" }, 21),
    record("response_item", { type: "message", role: "assistant", content: [] }, 22),
    counter(counts, counts, 23),
  ]);
  assert.equal(session.tokens.inputTokens, 1000);
  assert.equal(session.tokens.outputTokens, 100);
  assert.equal(session.metrics.modelCalls, 1);
});

test("CODEX-01 guard: cross-turn matching consumes one counter per distinct equal-sized response", async () => {
  const counts = usage(1000, 800, 100, 30);
  const session = await analyze([
    receipt("synthetic-response-earlier-counter", counts, 3),
    receipt("synthetic-response-additional-equal", counts, 4),
    counter(counts, counts, 20),
    record("turn_context", { model: "gpt-5.6-sol", turn_id: "synthetic-turn-b" }, 21),
    record("response_item", { type: "message", role: "assistant", content: [] }, 22),
    counter(counts, counts, 23),
  ]);
  assert.equal(session.tokens.inputTokens, 2000);
  assert.equal(session.tokens.outputTokens, 200);
  assert.equal(session.metrics.modelCalls, 2);
});
