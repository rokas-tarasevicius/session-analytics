import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { conductorFallback } from "../../src/providers/conductor.ts";
import { zeroCost } from "../../src/providers/common.ts";
import type { SessionDatabaseRow } from "../../src/types.ts";

// Synthetic reproduction of legacy modelUsage containing contextWindow only.
test("RC-MODEL-01: retain unallocated SDK value and turn-local tokens in the model breakdown", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE session_messages (id TEXT, session_id TEXT, content TEXT, created_at TEXT)");
    const at = "2026-08-01T12:00:00.000Z";
    db.prepare("INSERT INTO session_messages VALUES (?, ?, ?, ?)").run("receipt", "synthetic-conductor", JSON.stringify({
      type: "result", uuid: "synthetic-receipt", session_id: "synthetic-provider", subtype: "success", total_cost_usd: 2,
      modelUsage: { "claude-opus-4-1": { contextWindow: 200000 } },
      usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
      result: "PRIVATE-RECONCILE-SENTINEL",
    }), at);
    const row: SessionDatabaseRow = {
      conductor_session_id: "synthetic-conductor", provider_session_id: "synthetic-provider", agent_type: "claude",
      created_at: at, updated_at: at, status: "completed", title: "PRIVATE-RECONCILE-SENTINEL",
      repository_id: "synthetic-repository", repository_name: "Synthetic", root_path: "/synthetic",
      repository_remote: "", default_branch: "", workspace_path: "/synthetic", workspace_name: null,
      branch: null, database_model: null, is_hidden: 0,
    };
    const [session] = conductorFallback(db, [row], new Set(), {
      rateCard: { currency: "USD", effectiveDate: "2026-08-01", models: {} }, price: () => zeroCost(),
    });
    assert.ok(session);
    assert.equal(session.cost.totalUsd, 2);
    assert.equal(session.tokens.inputTokens, 90);
    assert.equal(session.tokens.outputTokens, 10);
    assert.doesNotMatch(JSON.stringify(session), /PRIVATE-RECONCILE-SENTINEL|synthetic-provider|synthetic-receipt/);
    assert.equal(session.models.reduce((total, model) => total + model.totalUsd, 0), 2,
      "model breakdown must retain known value whose allocation is unavailable");
    assert.equal(session.models.reduce((total, model) => total + model.inputTokens, 0), 90);
    assert.equal(session.models.reduce((total, model) => total + model.outputTokens, 0), 10);
    const unallocated = session.models.find((model) => model.model === "<unknown>");
    assert.ok(unallocated, "metadata-only model names do not prove token or cost allocation");
    assert.equal(unallocated.totalUsd, 2);
  } finally { db.close(); }
});
