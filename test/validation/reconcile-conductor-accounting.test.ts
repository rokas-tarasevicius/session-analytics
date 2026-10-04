import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { conductorFallback } from "../../src/providers/conductor.ts";
import { zeroCost } from "../../src/providers/common.ts";
import type { SessionDatabaseRow } from "../../src/types.ts";

const row: SessionDatabaseRow = {
  agent_type: "claude", branch: null, conductor_session_id: "synthetic-row", created_at: "2026-01-01T00:00:00Z",
  database_model: "claude-opus-5", default_branch: "main", is_hidden: 0, provider_session_id: "synthetic-provider",
  repository_id: "synthetic-repository", repository_name: "Example", repository_remote: "", root_path: "/synthetic",
  status: "completed", title: "synthetic-private-title", updated_at: "2026-01-01T01:00:00Z", workspace_name: null, workspace_path: "/synthetic",
};
function recover(events: object[]) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE session_messages (id TEXT,session_id TEXT,content TEXT,created_at TEXT)");
  events.forEach((event, index) => db.prepare("INSERT INTO session_messages VALUES (?,?,?,?)").run(String(index), row.conductor_session_id,
    JSON.stringify({ ...event, session_id: row.provider_session_id, result: "SYNTHETIC-PRIVATE-PROMPT", uuid: `receipt-${index}` }),
    new Date(Date.parse(row.created_at) + index * 1000).toISOString()));
  try {
    const result = conductorFallback(db, [row], new Set(), { rateCard: { currency: "USD", effectiveDate: "2026-01-01", models: {} }, price: zeroCost })[0]!;
    assert.ok(result);
    for (const sentinel of [row.provider_session_id!, row.conductor_session_id, row.title, "SYNTHETIC-PRIVATE-PROMPT", row.workspace_path]) assert.ok(!JSON.stringify(result).includes(sentinel));
    return result;
  } finally { db.close(); }
}
const init = { type: "system", subtype: "init", claude_code_version: "2.1.201" };
const receipt = (cost: number, input: number, output: number, cumulative = false) => ({
  type: "result", subtype: "success", total_cost_usd: cost,
  usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { "claude-opus-5": cumulative ? { inputTokens: input, outputTokens: output, costUSD: cost } : { contextWindow: 1_000_000 } },
});

test("RC-CONDUCTOR-LOCAL: multiple receipts retain observed main-loop tokens as a partial lower bound", () => {
  const result = recover([receipt(1, 100, 20), receipt(2, 50, 10)]);
  assert.equal(result.tokens.inputTokens, 150);
  assert.equal(result.tokens.outputTokens, 30);
  assert.equal(result.cost.totalUsd, 2);
  assert.equal(result.evidence?.accounting, "partial");
  assert.match(result.transcript.warnings.join(" "), /main.loop|top.level|lower bound/i);
});

test("RC-CONDUCTOR-LOCAL control: turn-local usage never adds onto cumulative whole-tree usage", () => {
  const result = recover([receipt(1, 100, 20, true), receipt(2, 200, 40, true)]);
  assert.equal(result.tokens.inputTokens, 200);
  assert.equal(result.tokens.outputTokens, 40);
  assert.equal(result.cost.totalUsd, 2);
});

test("RC-CONDUCTOR-REPLAY: old-version init does not rebill an unchanged zero-turn cumulative state", () => {
  const first = receipt(1, 100, 20, true);
  const replay = { ...first, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  const result = recover([init, first, init, replay]);
  assert.equal(result.cost.totalUsd, 1);
  assert.equal(result.tokens.inputTokens, 100);
  assert.equal(result.tokens.outputTokens, 20);
  assert.equal(result.conductor?.resultRecords, 2);
  assert.equal(result.costComplete, false);
});

test("RC-CONDUCTOR-REPLAY control: init and counter decrease do not prove disjoint usage", () => {
  const result = recover([init, receipt(1, 100, 20, true), init, receipt(0.5, 50, 10, true)]);
  assert.equal(result.cost.totalUsd, 1);
  assert.equal(result.tokens.inputTokens, 100);
  assert.equal(result.tokens.outputTokens, 20);
  assert.equal(result.costComplete, false);
});

test("RC-CONDUCTOR-REPLAY: a restored epoch can grow after replay without rebilling its prefix", () => {
  const first = receipt(1, 100, 20, true);
  const replay = { ...first, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  const result = recover([init, first, init, replay, receipt(1.5, 150, 30, true)]);
  assert.equal(result.cost.totalUsd, 1.5);
  assert.equal(result.tokens.inputTokens, 150);
  assert.equal(result.costComplete, false);
});

test("RC-CONDUCTOR-REPLAY control: retained assistant usage supersedes ambiguous receipts", () => {
  const first = receipt(1, 100, 20, true);
  const same = { ...first, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  const assistant = { type: "assistant", message: { usage: { input_tokens: 100, output_tokens: 20 } } };
  const result = recover([init, first, init, assistant, same]);
  assert.equal(result.evidence?.source, "conductor-messages");
  assert.equal(result.cost.totalUsd, 0); // No model/rate was retained in this synthetic message.
  assert.equal(result.tokens.inputTokens, 100);
  assert.equal(result.conductor?.reconciliation?.reportedUsd, 1);
  assert.equal(result.costComplete, false);
});
