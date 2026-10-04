import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "../fixtures.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const sentinel = "SYNTHETIC-PRIVATE-OVERLAP-CONTENT";
const optionsFor = (f: SessionAnalyticsFixture) => ({ noIndex: true, additionalProviders: false,
  pricingPolicy: "reviewed-only" as const, databasePath: f.databasePath, dataDir: f.dataDir,
  claudeRoot: f.claudeRoot, codexRoot: f.codexRoot, codexArchiveRoot: f.codexArchiveRoot,
  cursorDatabasePath: f.cursorDatabasePath });

test("VC-O1: a native current identity must not hide a disjoint pre-reset identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-overlap-"));
  try {
    const f = await createSessionAnalyticsFixture(root);
    const db = new DatabaseSync(f.databasePath);
    db.exec("CREATE TABLE session_messages(id TEXT, session_id TEXT, content TEXT, created_at TEXT)");
    const row = db.prepare("SELECT id, claude_session_id FROM sessions WHERE agent_type='claude' LIMIT 1").get()!;
    const insert = db.prepare("INSERT INTO session_messages VALUES (?,?,?,?)");
    insert.run("old-result", row["id"]!, JSON.stringify({ type: "result", uuid: "old-result",
      session_id: "synthetic-before-reset", subtype: "success", total_cost_usd: 5,
      modelUsage: { "claude-opus-5": { inputTokens: 100, outputTokens: 20, costUSD: 5 } }, result: sentinel,
    }), "2026-07-01T00:00:00Z");
    insert.run("reset-link", row["id"]!, JSON.stringify({ type: "conversation_reset", uuid: "reset-link",
      session_id: "synthetic-before-reset", new_conversation_id: row["claude_session_id"],
    }), "2026-07-01T00:01:00Z");
    // This current-identity receipt must still be suppressed by canonical precedence.
    insert.run("current-result", row["id"]!, JSON.stringify({ type: "result", uuid: "current-result",
      session_id: row["claude_session_id"], subtype: "success", total_cost_usd: 999,
    }), "2026-07-01T00:02:00Z");
    db.close();
    const snapshot = await analyzeMachineSessions(optionsFor(f));
    const old = snapshot.sessions.find(s => s.sessionKey === hash("claude:synthetic-before-reset"));
    assert.ok(old, "verified reset-linked history is a different provider identity and must remain recoverable");
    assert.equal(old.cost.totalUsd, 5);
    assert.equal(old.tokens.inputTokens, 100);
    assert.equal(snapshot.sessions.filter(s => s.evidence?.source === "conductor-result").length, 1);
    assert.ok(!JSON.stringify(snapshot).includes(sentinel));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("VC-O2: a registered session retains its key after canonical evidence is replaced by fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-key-"));
  try {
    const f = await createSessionAnalyticsFixture(root);
    const db = new DatabaseSync(f.databasePath);
    db.exec("CREATE TABLE session_messages(id TEXT, session_id TEXT, content TEXT, created_at TEXT)");
    const row = db.prepare("SELECT id, claude_session_id FROM sessions WHERE agent_type='claude' LIMIT 1").get()!;
    db.prepare("INSERT INTO session_messages VALUES (?,?,?,?)").run("synthetic-result", row["id"]!, JSON.stringify({
      type: "result", uuid: "synthetic-result", session_id: row["claude_session_id"], subtype: "success", total_cost_usd: 5,
    }), "2026-07-01T00:00:00Z");
    db.close();
    const native = await analyzeMachineSessions(optionsFor(f));
    const nativeSession = native.sessions.find(s => s.sessionKey === hash(String(row["id"])))!;
    assert.ok(nativeSession);
    const empty = join(root, "empty-claude"); await mkdir(empty);
    const fallback = await analyzeMachineSessions({ ...optionsFor(f), claudeRoot: empty });
    const recovered = fallback.sessions.find(s => s.evidence?.source === "conductor-result")!;
    assert.ok(recovered);
    assert.equal(recovered.sessionKey, nativeSession.sessionKey,
      "deleting a transcript must not change the public identity of an unchanged registered session");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("VC-O3: a retained result survives deletion of its workspace metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-orphan-"));
  try {
    const f = await createSessionAnalyticsFixture(root);
    const db = new DatabaseSync(f.databasePath);
    db.exec("CREATE TABLE session_messages(id TEXT, session_id TEXT, content TEXT, created_at TEXT)");
    db.prepare("INSERT INTO sessions(id,agent_type,status,created_at,updated_at,workspace_id,claude_session_id) VALUES (?,?,?,?,?,?,?)")
      .run("synthetic-orphan", "claude", "idle", "2026-07-01T00:00:00Z", "2026-07-01T00:01:00Z",
        "synthetic-deleted-workspace", "synthetic-orphan-provider");
    db.prepare("INSERT INTO session_messages VALUES (?,?,?,?)").run("synthetic-orphan-result", "synthetic-orphan",
      JSON.stringify({ type: "result", uuid: "synthetic-orphan-result", session_id: "synthetic-orphan-provider",
        subtype: "success", total_cost_usd: 3, usage: { input_tokens: 10, output_tokens: 2 }, result: sentinel,
      }), "2026-07-01T00:01:00Z");
    db.close();
    const snapshot = await analyzeMachineSessions(optionsFor(f));
    const recovered = snapshot.sessions.find(s => s.evidence?.source === "conductor-result");
    assert.ok(recovered, "valid retained usage must not require a surviving workspace row");
    assert.equal(recovered.cost.totalUsd, 3);
    assert.equal(recovered.tokens.inputTokens, 10);
    assert.equal(recovered.repositoryName, "Conductor · unassigned");
    assert.equal(recovered.repositoryId, "conductor-" + createHash("sha256").update("conductor:unassigned:conductor").digest("hex").slice(0, 20));
    assert.ok(snapshot.repositories.some(r => r.repository.id === recovered.repositoryId));
    assert.ok(!JSON.stringify(snapshot).includes(sentinel));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("VC-O3 guard: an orphan row cannot replace native repository evidence with an unassigned group", async () => {
  const root = await mkdtemp(join(tmpdir(), "conductor-orphan-native-"));
  try {
    const f = await createSessionAnalyticsFixture(root);
    const db = new DatabaseSync(f.databasePath);
    db.prepare("UPDATE sessions SET workspace_id=? WHERE agent_type='claude'").run("synthetic-deleted-workspace");
    db.close();
    const snapshot = await analyzeMachineSessions(optionsFor(f));
    const native = snapshot.sessions.find(s => s.provider === "claude")!;
    assert.ok(native);
    assert.notEqual(native.repositoryName, "Conductor · unassigned");
    assert.equal(native.evidence?.source, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
