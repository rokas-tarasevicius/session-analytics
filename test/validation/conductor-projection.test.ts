import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { conductorFallback } from "../../src/providers/conductor.ts";
import { zeroCost } from "../../src/providers/common.ts";
import type { SessionDatabaseRow } from "../../src/types.ts";

const at = "2026-07-01T00:00:00.000Z";
const row: SessionDatabaseRow = {
  agent_type: "claude", branch: null, conductor_session_id: "synthetic-conductor", created_at: at,
  database_model: null, default_branch: "", is_hidden: 0, provider_session_id: "synthetic-provider",
  repository_id: "synthetic-repository", repository_name: "Synthetic", repository_remote: "",
  root_path: "/synthetic", status: "completed", title: "", updated_at: "2026-07-01T00:01:00.000Z",
  workspace_name: null, workspace_path: "/synthetic",
};
function recover(fields: Record<string, unknown>) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE session_messages(id TEXT, session_id TEXT, content TEXT, created_at TEXT)");
    db.prepare("INSERT INTO session_messages VALUES (?,?,?,?)").run("synthetic-message", row.conductor_session_id,
      JSON.stringify({ type: "result", uuid: "synthetic-receipt", session_id: row.provider_session_id, subtype: "success", ...fields }), at);
    return conductorFallback(db, [row], new Set(), { rateCard: { currency: "USD", effectiveDate: "2026-07-01", models: {} }, price: zeroCost })[0]!;
  } finally { db.close(); }
}

test("VC-P1: Claude model context suffixes preserve their distinct model identity", () => {
  const session = recover({ total_cost_usd: 3, modelUsage: {
    "claude-opus-5[1m]": { inputTokens: 100, outputTokens: 20, costUSD: 2 },
    "claude-fable-5[1m]": { inputTokens: 50, outputTokens: 10, costUSD: 1 },
  } });
  assert.deepEqual(session.models.map((m) => m.model), ["claude-opus-5", "claude-fable-5"]);
  assert.deepEqual(session.models.map((m) => m.totalUsd), [2, 1]);
  assert.equal(session.tokens.inputTokens, 150);
});

test("VC-P2: partial model cost allocations cannot establish a complete reported total", () => {
  const session = recover({ modelUsage: {
    "claude-opus-5": { inputTokens: 100, costUSD: 3 },
    "claude-haiku-4-5-20251001": { inputTokens: 50 },
  } });
  assert.equal(session.cost.totalUsd, 3);
  assert.equal(session.costComplete, false);
  assert.equal(session.evidence?.accounting, "partial");
});

test("VC-P3: explicit cache-write TTL remains observable in turn-local result usage", () => {
  const session = recover({ total_cost_usd: 1, usage: { input_tokens: 3, cache_read_input_tokens: 4,
    cache_creation_input_tokens: 12, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 7 }, output_tokens: 2 } });
  assert.equal(session.conductor?.turnLocalTokens?.cacheWrite5mInputTokens, 5);
  assert.equal(session.conductor?.turnLocalTokens?.cacheWrite1hInputTokens, 7);
  assert.equal(session.tokens.cacheWrite5mInputTokens, 5);
  assert.equal(session.tokens.cacheWrite1hInputTokens, 7);
  assert.equal(session.tokens.inputTokens, 19);
});

test("VC-P4: absent model costs do not trigger a model allocation disagreement", () => {
  const session = recover({ total_cost_usd: 7, modelUsage: { "claude-opus-5": { contextWindow: 1000000 } } });
  assert.equal(session.cost.totalUsd, 7);
  assert.ok(!session.transcript.warnings.some((warning) => warning.startsWith("Reported model allocations differ")));
  assert.equal(session.evidence?.tokens, "unavailable");
});

test("Conductor projection rejects malformed models and strips private fields", () => {
  const session = recover({ total_cost_usd: 1, result: "PRIVATE-SENTINEL", permission_denials: [{ tool_input: "PRIVATE-SENTINEL" }],
    modelUsage: { "/private/secret.json": { inputTokens: 3, costUSD: 1, private: "PRIVATE-SENTINEL" } } });
  assert.equal(session.models[0]?.model, "<unknown>");
  const serialized = JSON.stringify(session);
  for (const secret of ["PRIVATE-SENTINEL", "/private/secret.json", "synthetic-conductor", "synthetic-provider", "synthetic-receipt", "synthetic-message"])
    assert.ok(!serialized.includes(secret));
});
