/** Synthetic recovered histories must coexist within a bounded worker heap. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { conductorFallback } from "../src/providers/conductor.ts";
import { priceUsage } from "../src/pricing/usage.ts";
import type { RateCard, SessionDatabaseRow } from "../src/types.ts";

const groups = 120, requests = 1_200, model = "claude-sonnet-4-20250514";
const at = "2026-07-01T00:00:00.000Z", secret = "PRIVATE_SYNTHETIC_CONDUCTOR_MEMORY";
const rateCard: RateCard = { currency: "USD", effectiveDate: "2026-01-01", models: {
  [model]: { provider: "claude", inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, source: "https://example.com/rates" },
} };
const rows: SessionDatabaseRow[] = [];
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE session_messages (id TEXT, session_id TEXT, content TEXT, full_message TEXT, created_at TEXT); CREATE INDEX messages_by_session ON session_messages(session_id)");
const insert = db.prepare("INSERT INTO session_messages VALUES (?,?,?,?,?)");
try {
  db.exec("BEGIN");
  for (let group = 0; group < groups; group++) {
    const conductorId = `private-row-${group}`, providerId = `private-provider-${group}`;
    rows.push({ conductor_session_id: conductorId, provider_session_id: providerId, agent_type: "claude", status: "completed", created_at: at, updated_at: at,
      repository_id: "conductor-00000000000000000000", repository_name: "Synthetic", repository_remote: secret, root_path: secret,
      default_branch: secret, workspace_path: secret, workspace_name: secret, title: secret, branch: secret, database_model: model, is_hidden: 0 });
    for (let request = 0; request < requests; request++) {
      const id = `private-response-${group}-${request}`;
      const message = JSON.stringify({ type: "assistant", uuid: id, session_id: providerId, message: { id, model,
        content: [{ type: "text", text: secret }], usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
      insert.run(id, conductorId, message, message, at);
    }
  }
  db.exec("COMMIT");
  const sessions = conductorFallback(db, rows, new Set(), { rateCard, price: (rate, usage, input) => priceUsage(rate, usage, input).cost });
  assert.equal(sessions.length, groups);
  for (const session of sessions) {
    assert.equal(session.metrics.modelCalls, requests);
    assert.equal(session.tokens.inputTokens, requests * 100);
    assert.equal(session.tokens.outputTokens, requests);
    assert.ok(Math.abs(session.cost.totalUsd - requests * 0.000315) < 1e-10);
    assert.doesNotMatch(JSON.stringify(session), /PRIVATE_SYNTHETIC_CONDUCTOR_MEMORY|private-response|private-provider|private-row/);
  }
  process.stdout.write(JSON.stringify({ sessions: groups, calls: groups * requests, inputTokens: groups * requests * 100, outputTokens: groups * requests }));
} finally { db.close(); }
