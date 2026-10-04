import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

const child = "44444444-4444-4444-8444-444444444444";
const parent = "55555555-5555-4555-8555-555555555555";
const key = createHash("sha256").update(`codex:${child}`).digest("hex").slice(0, 12);
const record = (second: number, type: string, payload: unknown) => ({
  timestamp: `2026-09-01T12:00:${String(second).padStart(2, "0")}Z`, type, payload,
});
const usage = { input_tokens: 3210, cached_input_tokens: 1024, output_tokens: 321, reasoning_output_tokens: 100 };

async function analyzeMetadataSequence(foreign: boolean) {
  const root = await mkdtemp(join(tmpdir(), "codex-fork-validation-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const header = { id: child, cwd: fixture.repositoryRoot, forked_from_id: parent,
      source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } }, originator: "codex_exec" };
    await writeFile(join(fixture.codexRoot, `rollout-${child}.jsonl`), [
      record(0, "session_meta", header),
      // Real spawned rollouts can carry the inherited parent's metadata after their own header.
      record(1, "session_meta", { id: foreign ? parent : child, cwd: fixture.repositoryRoot, source: "cli", originator: "codex_cli_rs" }),
      record(2, "turn_context", { model: "gpt-5.6-sol", effort: "high" }),
      record(3, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "synthetic-private-message" }] }),
      record(4, "event_msg", { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } }),
      record(5, "event_msg", { type: "task_complete" }),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const result = await analyzeMachineSessions({ ...fixture, pricingPolicy: "reviewed-only" });
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-message|44444444-4444|55555555-5555/);
    const session = result.sessions.find((s) => s.sessionKey === key);
    assert.ok(session);
    return session;
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("CODEX-03: inherited parent metadata cannot relabel a fork's own usage as top-level", async () => {
  const session = await analyzeMetadataSequence(true);
  assert.equal(session.executionKind, "subagent");
  assert.equal(session.costByExecution.topLevelUsd, 0);
  assert.equal(session.costByExecution.subagentUsd, session.cost.totalUsd);
  assert.ok(session.velocity?.dimensions.every((d) => d.executionKind === "subagent" && d.agent === "codex-subagent"));
});

test("CODEX-03 control: a same-thread metadata update still permits a real source change", async () => {
  const session = await analyzeMetadataSequence(false);
  assert.equal(session.executionKind, "mixed");
  assert.equal(session.costByExecution.topLevelUsd, session.cost.totalUsd);
  assert.equal(session.costByExecution.subagentUsd, 0);
});
