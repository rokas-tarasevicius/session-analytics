import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { conductorFallback } from "../src/providers/conductor.ts";
import { calculateCost } from "../src/analyzer.ts";
import type { SessionDatabaseRow, RateCard } from "../src/types.ts";

const secret = "/private/HISTORY-SENTINEL prompt --credential=secret";
const model = "claude-sonnet-4-20250514";
const at = "2026-07-31T23:59:00.000Z", later = "2026-08-01T00:01:00.000Z";
const rates: RateCard = { currency: "USD", effectiveDate: "2026-01-01", models: {
  [model]: { provider: "claude", inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWrite5mPerMillion: 3.75, cacheWrite1hPerMillion: 6, source: "https://example.com/pricing" },
} };
const pricing = { rateCard: rates, price: calculateCost };
function row(id = "row-private", provider: string | null = "provider-private"): SessionDatabaseRow {
  return { conductor_session_id: id, provider_session_id: provider, agent_type: "claude", status: "completed", created_at: at, updated_at: later,
    repository_id: "conductor-00000000000000000000", repository_name: "Synthetic", repository_remote: secret, root_path: secret,
    default_branch: secret, workspace_path: secret, workspace_name: secret, title: secret, branch: secret, database_model: model, is_hidden: 0 };
}
function fixture(run: (db: DatabaseSync, event: (data: object, time?: string, session?: string) => void) => void) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT, full_message TEXT, created_at TEXT)");
  let id = 0;
  const event = (data: object, time = at, session = "row-private") => db.prepare("INSERT INTO session_messages (id,session_id,content,full_message,created_at) VALUES (?,?,?,?,?)").run(`private-record-${++id}`, session, JSON.stringify(data), JSON.stringify(data), time);
  try { run(db, event); } finally { db.close(); }
}
function assistant(id: string, output: number, extra: object = {}) {
  return { type: "assistant", uuid: `private-${id}-${output}`, session_id: "provider-private", ...extra, message: {
    id, model, content: [{ type: "text", text: secret }, { type: "thinking", thinking: secret }, { type: "tool_use", id: `private-tool-${id}`, name: "Read", input: { path: secret } }],
    usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 200, cache_creation_input_tokens: 40,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 30 } },
  } };
}
const receipt = (cost: number) => ({ type: "result", uuid: "private-receipt", session_id: "provider-private", total_cost_usd: cost, result: secret, subtype: "success" });

test("history: recover assistant-only SDK streams once, retain request dates and sidechain attribution", () => fixture((db, event) => {
  event(assistant("private-main", 10));
  event(assistant("private-main", 20), later);
  event(assistant("private-child", 30, { parent_tool_use_id: "private-parent" }), later);
  const sessions = conductorFallback(db, [row()], new Set(), pricing);
  assert.equal(sessions.length, 1, "assistant usage without a result must survive");
  const s = sessions[0]!;
  assert.equal(s.evidence?.source, "conductor-messages");
  assert.equal(s.evidence?.fidelity, "message");
  assert.equal(s.costBasis, "api-list-price-equivalent");
  assert.equal(s.tokens.inputTokens, 680); assert.equal(s.tokens.outputTokens, 50);
  assert.equal(s.tokens.cacheWrite1hInputTokens, 60);
  assert.equal(s.metrics.modelCalls, 2); assert.equal(s.metrics.assistantMessages, 2);
  assert.deepEqual(s.tools, { Read: 2 });
  assert.deepEqual(s.transportTools, { Read: 2 });
  assert.equal(s.executionKind, "mixed");
  assert.ok(s.costByExecution.subagentUsd > s.costByExecution.topLevelUsd);
  assert.deepEqual(Object.keys(s.spendByDay).sort(), ["2026-07-31", "2026-08-01"]);
  assert.equal(s.firstEventAt, at); assert.equal(s.lastEventAt, later);
  assert.equal(s.velocity!.buckets.reduce((n, b) => n + b[3][7], 0), 2);
  const output = JSON.stringify(s);
  for (const value of [secret, "private-main", "private-child", "private-parent", "provider-private", "row-private"]) assert.ok(!output.includes(value));
}));

test("history: prefer messages to receipts and compare their value without adding it twice", () => fixture((db, event) => {
  event(assistant("private-main", 20));
  const expected = 100 * 3 / 1e6 + 200 * .3 / 1e6 + 10 * 3.75 / 1e6 + 30 * 6 / 1e6 + 20 * 15 / 1e6;
  event(receipt(expected), later);
  const s = conductorFallback(db, [row()], new Set(), pricing)[0]!;
  assert.equal(s.costBasis, "api-list-price-equivalent");
  assert.ok(Math.abs(s.cost.totalUsd - expected) < 1e-12);
  const reconciliation = (s.conductor as unknown as { reconciliation: { status: string; reportedUsd: number; differenceUsd: number } }).reconciliation;
  assert.equal(reconciliation.status, "agrees"); assert.equal(reconciliation.reportedUsd, expected);
  assert.ok(Math.abs(reconciliation.differenceUsd) < 1e-12);
}));

test("history: duplicate Conductor rows, canonical transcripts and Codex never multiply recovery", () => fixture((db, event) => {
  event(assistant("private-main", 20)); event(assistant("private-main", 20), later, "row-copy");
  const rows = [row(), row("row-copy"), { ...row("codex-row"), agent_type: "codex" }];
  assert.equal(conductorFallback(db, rows, new Set(), pricing).length, 1);
  assert.deepEqual(conductorFallback(db, rows, new Set(["claude:provider-private", "codex:provider-private"]), pricing), []);
}));

test("history: a message without usage keeps the result-only fallback", () => fixture((db, event) => {
  event({ type: "assistant", session_id: "provider-private", message: { id: "private-message", model, content: secret } });
  event(receipt(2), later);
  const s = conductorFallback(db, [row()], new Set(), pricing)[0]!;
  assert.equal(s.evidence?.source, "conductor-result"); assert.equal(s.cost.totalUsd, 2);
}));

test("history: SDK record UUIDs are not response IDs; stripped streams use conservative usage groups", () => fixture((db, event) => {
  db.exec("ALTER TABLE session_messages ADD COLUMN sdk_message_id TEXT");
  const insert = (uuid: string, output: number, extra: object = {}) => {
    const data = assistant("discarded", output, extra);
    delete (data.message as { id?: string }).id;
    data.uuid = uuid;
    db.prepare("INSERT INTO session_messages VALUES (?,?,?,?,?,?)").run(uuid, "row-private", JSON.stringify(data), null, at, uuid);
  };
  insert("private-sdk-block-1", 10);
  insert("private-sdk-block-2", 20);
  insert("private-sdk-block-3", 30, { parent_tool_use_id: "private-child-parent" });
  event(receipt(1));
  const s = conductorFallback(db, [row()], new Set(), pricing)[0]!;
  assert.equal(s.tokens.inputTokens, 680, "SDK block IDs must not multiply input tokens");
  assert.equal(s.tokens.outputTokens, 50);
  assert.equal(s.metrics.modelCalls, 2);
  assert.equal(s.conductor!.reconciliation!.messagesWithoutIdentity, 2);
  assert.equal(s.conductor!.reconciliation!.status, "partial");
  for (const value of [secret, "private-sdk-block", "private-child-parent"]) assert.ok(!JSON.stringify(s).includes(value));
}));

test("history: explicit response identities preserve distinct requests with identical input counters", () => fixture((db, event) => {
  event(assistant("request-one", 20));
  event(assistant("request-two", 20));
  const s = conductorFallback(db, [row()], new Set(), pricing)[0]!;
  assert.equal(s.metrics.modelCalls, 2);
  assert.equal(s.tokens.inputTokens, 680);
  assert.equal(s.conductor!.reconciliation!.messagesWithoutIdentity, 0);
}));

test("history: a result envelope without accounting fields does not invent a summary", () => fixture((db, event) => {
  event({ type: "result", uuid: "private-empty-receipt", session_id: "provider-private", result: secret });
  assert.deepEqual(conductorFallback(db, [row()], new Set(), pricing), []);
}));

test("history: late streamed blocks extend observed time without moving request cost to another day", () => fixture((db, event) => {
  event(assistant("same-response", 10));
  event(assistant("same-response", 20), later);
  const s = conductorFallback(db, [row()], new Set(), pricing)[0]!;
  assert.equal(s.firstEventAt, at); assert.equal(s.lastEventAt, later);
  assert.deepEqual(Object.keys(s.spendByDay), ["2026-07-31"]);
}));

test("history: partially populated copies of one SDK block do not invent another response", () => fixture((db, event) => {
  const rich = assistant("discarded", 20);
  delete (rich.message as { id?: string }).id;
  const sparse = { type: "assistant", uuid: rich.uuid, message: { model } };
  event(sparse);
  db.prepare("UPDATE session_messages SET full_message=?").run(JSON.stringify(rich));
  const s = conductorFallback(db, [row()], new Set(), pricing)[0]!;
  assert.equal(s.metrics.assistantMessages, 1);
  assert.equal(s.metrics.modelCalls, 1);
  assert.equal(s.conductor!.reconciliation!.messagesWithoutUsage, 0);
  assert.equal(s.historyStatistics!.days[0]!.tokens, 360);
  assert.deepEqual(s.tools, { Read: 1 });
}));
