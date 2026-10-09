import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { buildClaudeUsageOwners, type ClaudeObservationRead, type ClaudeOwnershipCache } from "../src/providers/claude-ownership.ts";
import { indexPath, openIndexDatabase, type IndexScanStats } from "../src/store/database.ts";
import { keyedHash } from "../src/store/fingerprint.ts";
import { projectConductorRecords, projectOwnershipObservations } from "../src/store/provider-evidence.ts";
import type { AnalyzeOptions, MachineAnalytics } from "../src/types.ts";
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "./fixtures.ts";

const jsonl = (records: unknown[]): string => records.map((value) => JSON.stringify(value)).join("\n") + "\n";
const claudeId = "22222222-2222-4222-8222-222222222222";
const recoveredId = "55555555-5555-4555-8555-555555555555", legacyId = "66666666-6666-4666-8666-666666666666";
const resetFrom = "88888888-8888-4888-8888-888888888888", resetTo = "77777777-7777-4777-8777-777777777777";
const sentinel = "PREPASS-CONTENT-SENTINEL";
const privateValues = /PREPASS-CONTENT-SENTINEL|prepass-message|prepass-tool|prepass-record|conductor-recovered|conductor-legacy|conductor-reset|55555555-5555|66666666-6666|77777777-7777|88888888-8888|22222222-2222|33333333-3333|message-one|\/fixtures\/workspaces/;

function options(fixture: SessionAnalyticsFixture): AnalyzeOptions {
  return {
    claudeRoot: fixture.claudeRoot, codexRoot: fixture.codexRoot, codexArchiveRoot: fixture.codexArchiveRoot,
    cursorDatabasePath: fixture.cursorDatabasePath, databasePath: fixture.databasePath,
    dataDir: fixture.dataDir, includeHidden: true, additionalProviders: false, offline: true,
  };
}
function stable(snapshot: MachineAnalytics) { const { generatedAt, ...rest } = snapshot; void generatedAt; return rest; }
async function withFixture(run: (fixture: SessionAnalyticsFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "session-analytics-prepass-"));
  try { await run(await createSessionAnalyticsFixture(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function lastStats(opts: AnalyzeOptions): Required<IndexScanStats> {
  const db = new DatabaseSync(indexPath(opts), { readOnly: true });
  try { return JSON.parse(String(db.prepare("SELECT stats FROM scans ORDER BY completed_at DESC LIMIT 1").get()?.["stats"])); }
  finally { db.close(); }
}
/** Cold, warm and unindexed scans must agree exactly; returns the warm scan's stats. */
async function assertParity(opts: AnalyzeOptions): Promise<Required<IndexScanStats>> {
  const full = stable(await analyzeMachineSessions({ ...opts, noIndex: true }));
  assert.deepEqual(stable(await analyzeMachineSessions(opts)), full);
  const first = lastStats(opts);
  assert.deepEqual(stable(await analyzeMachineSessions(opts)), full);
  const warm = lastStats(opts);
  assert.equal(warm.ownershipReads + warm.conductorReads, 0, "a repeated scan replays every pre-pass entry");
  return first;
}

const model = "claude-opus-5";
const assistant = (id: string, output: number, session: string, extra: object = {}) => ({
  type: "assistant", uuid: `prepass-record-${id}-${output}`, session_id: session, ...extra, message: {
    id: `prepass-message-${id}`, model, content: [{ type: "text", text: sentinel }, { type: "tool_use", id: `prepass-tool-${id}`, name: "Read", input: { path: sentinel } }],
    usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 200, cache_creation_input_tokens: 40 },
  },
});
const result = (id: string, session: string, cost: number, reported = model) => ({ type: "result", uuid: `prepass-record-result-${id}`, session_id: session, total_cost_usd: cost, result: sentinel, subtype: "success",
  usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 200, cache_creation_input_tokens: 40 }, num_turns: 1,
  modelUsage: { [reported]: { inputTokens: 100, outputTokens: 7, cacheReadInputTokens: 200, cacheCreationInputTokens: 40, costUSD: cost } } });

/** Conductor's own table shape, with recovered, paired, legacy and reset-linked sessions. */
function conductorHistory(fixture: SessionAnalyticsFixture): DatabaseSync {
  const db = new DatabaseSync(fixture.databasePath);
  db.exec(`CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT, full_message TEXT, cancelled_at TEXT, model TEXT, sdk_message_id TEXT);
    CREATE INDEX idx_session_messages_cancelled_at ON session_messages(session_id, cancelled_at);`);
  const session = db.prepare("INSERT INTO sessions (id,status,agent_type,title,created_at,updated_at,claude_session_id,model,is_hidden,workspace_id) VALUES (?,?,?,?,?,?,?,?,0,?)");
  session.run("conductor-recovered", "idle", "claude", sentinel, "2026-07-22T10:00:00Z", "2026-07-22T11:00:00Z", recoveredId, model, "workspace-claude");
  session.run("conductor-legacy", "idle", "claude", sentinel, "2026-07-24T10:00:00Z", "2026-07-24T11:00:00Z", null, model, "workspace-claude");
  session.run("conductor-reset", "idle", "claude", sentinel, "2026-07-26T10:00:00Z", "2026-07-26T11:00:00Z", resetTo, model, "workspace-claude");
  let row = 0;
  const put = (session: string, data: object, at: string) => db.prepare("INSERT INTO session_messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)")
    .run(`conductor-row-${++row}`, session, "assistant", JSON.stringify(data), at);
  put("conductor-recovered", assistant("a", 10, recoveredId), "2026-07-22T10:01:00.000Z");
  put("conductor-recovered", assistant("a", 20, recoveredId), "2026-07-22T10:02:00.000Z");
  put("conductor-recovered", result("a", recoveredId, 0.5), "2026-07-22T10:03:00.000Z");
  put("conductor-claude", assistant("paired", 30, claudeId), "2026-07-20T12:30:00.000Z");
  put("conductor-claude", result("paired", claudeId, 0.25), "2026-07-20T12:31:00.000Z");
  put("conductor-legacy", assistant("legacy", 5, legacyId), "2026-07-24T10:01:00.000Z");
  put("conductor-legacy", result("legacy", legacyId, 0.1), "2026-07-24T10:02:00.000Z");
  put("conductor-reset", assistant("before", 4, resetFrom), "2026-07-26T10:01:00.000Z");
  // Equivalent receipts at one instant: only their raw identities choose the retained model allocation.
  put("conductor-reset", result("before-2", resetFrom, 0.3, "claude-sonnet-5"), "2026-07-26T10:02:00.000Z");
  put("conductor-reset", result("before-1", resetFrom, 0.3), "2026-07-26T10:02:00.000Z");
  put("conductor-reset", { type: "conversation_reset", session_id: resetFrom, new_conversation_id: resetTo }, "2026-07-26T10:03:00.000Z");
  put("conductor-reset", assistant("after", 6, resetTo), "2026-07-26T10:04:00.000Z");
  return db;
}

test("Conductor projections replay exactly while unchanged and refresh when rows are added or updated in place", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture);
    const db = conductorHistory(fixture);
    try {
      const cold = await assertParity(opts);
      assert.equal(cold.conductorReads, 4);
      const recovered = (await analyzeMachineSessions(opts)).sessions.filter((session) => session.evidence?.source?.startsWith("conductor-"));
      assert.equal(recovered.length, 4, "recovered, legacy and both reset-linked identities");
      assert.equal(lastStats(opts).conductorHits, 4);
      // A new row in one session invalidates only that session.
      db.prepare("INSERT INTO session_messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)")
        .run("conductor-row-new", "conductor-recovered", "assistant", JSON.stringify(assistant("b", 15, recoveredId)), "2026-07-22T10:05:00.000Z");
      let changed = await assertParity(opts);
      assert.equal(changed.conductorReads, 1); assert.equal(changed.conductorHits, 3);
      // Conductor fills full_message after the fact.
      db.prepare("UPDATE session_messages SET full_message=? WHERE id='conductor-row-1'").run(JSON.stringify(assistant("a", 12, recoveredId)));
      changed = await assertParity(opts);
      assert.equal(changed.conductorReads, 1);
      // An in-place content edit changes the recovered accounting.
      db.prepare("UPDATE session_messages SET content=? WHERE id='conductor-row-2'").run(JSON.stringify(assistant("a", 2000, recoveredId)));
      changed = await assertParity(opts);
      assert.equal(changed.conductorReads, 1);
      // An SDK message ID assigned later changes record identity.
      db.prepare("UPDATE session_messages SET sdk_message_id='prepass-record-sdk' WHERE id='conductor-row-6'").run();
      changed = await assertParity(opts);
      assert.equal(changed.conductorReads, 1);
      // A deleted session's cache entry is dropped once the pass runs again (its public facts are retained history).
      db.prepare("DELETE FROM session_messages WHERE session_id='conductor-legacy'").run();
      db.prepare("DELETE FROM sessions WHERE id='conductor-legacy'").run();
      await analyzeMachineSessions(opts);
      const connection = openIndexDatabase(opts);
      try {
        assert.equal(Number(connection.database.prepare("SELECT count(*) AS n FROM conductor_records").get()?.["n"]), 3);
        // The disk form is the allowlisted projection: keyed hashes, counters and bounded names only.
        const payloads = connection.database.prepare("SELECT session_key,signature,payload FROM conductor_records").all()
          .map((row) => ({ ...row, payload: inflateRawSync(row["payload"] as Uint8Array).toString("utf8") }));
        for (const { payload } of payloads) assert.deepEqual(projectConductorRecords(JSON.parse(payload)), JSON.parse(payload));
        assert.doesNotMatch(JSON.stringify(payloads), privateValues);
      } finally { connection.close(); }
    } finally { db.close(); }
  });
});

test("a Conductor projection refuses fields outside its allowlist", () => {
  const key = "0".repeat(32);
  assert.throws(() => projectConductorRecords({ receipts: [], messages: [], resets: [], extra: sentinel }), /consistency/);
  assert.throws(() => projectConductorRecords({ receipts: [], messages: [], resets: [[sentinel, key]] }), /consistency/);
  assert.throws(() => projectOwnershipObservations([[sentinel, 1, 1, null, 0, 0, 0, 0]]), /consistency/);
  assert.throws(() => projectOwnershipObservations([[key, 1, 1, null, 0, 0, 0, 0, sentinel]]), /consistency/);
  assert.deepEqual(projectOwnershipObservations([[key, 1, 2, null, 0, 0, 0, 0]]), [[key, 1, 2, null, 0, 0, 0, 0]]);
});

async function resumedCopies(fixture: SessionAnalyticsFixture) {
  const files = async (root: string): Promise<string[]> => (await Promise.all((await readdir(root, { withFileTypes: true }))
    .map(async (entry) => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]))).flat();
  const main = (await files(fixture.claudeRoot)).find((path) => path.endsWith(`${claudeId}.jsonl`))!;
  const copy = join(dirname(main), "33333333-3333-4333-8333-333333333333.jsonl");
  const records = (await readFile(main, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line.replaceAll(claudeId, "33333333-3333-4333-8333-333333333333").replaceAll("T12:0", "T13:0")));
  await writeFile(copy, jsonl(records));
  return { main, copy, records };
}

test("Claude ownership observations replay per file and refresh on append, replacement and loss", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture);
    const { main, copy, records } = await resumedCopies(fixture);
    const cold = await assertParity(opts);
    assert.ok(cold.ownershipReads >= 3, "main, sub-agent and resumed copy files");
    const files = cold.ownershipReads;
    // An appended richer snapshot moves the shared message's owner.
    const richer = structuredClone(records.find((row) => row.type === "assistant"));
    richer.message.usage.output_tokens += 50;
    await appendFile(copy, jsonl([richer]));
    let changed = await assertParity(opts);
    assert.equal(changed.ownershipReads, 1); assert.equal(changed.ownershipHits, files - 1);
    // A same-name replacement that no longer shares the message.
    await writeFile(copy, jsonl(records.map((row) => row.type === "assistant" ? { ...row, message: { ...row.message, id: "prepass-message-replaced" } } : row)));
    changed = await assertParity(opts);
    assert.equal(changed.ownershipReads, 1);
    await writeFile(copy, jsonl(records));
    await assertParity(opts);
    // Provider cleanup removes the original; its entry is dropped.
    await rm(main);
    await assertParity(opts);
    const connection = openIndexDatabase(opts);
    try {
      const rows = connection.database.prepare("SELECT source_key,fingerprint,observations FROM claude_ownership").all()
        .map((row) => ({ ...row, observations: inflateRawSync(row["observations"] as Uint8Array).toString("utf8") }));
      assert.equal(rows.length, files - 1);
      assert.doesNotMatch(JSON.stringify(rows), privateValues);
    } finally { connection.close(); }
  });
});

test("ownership with a cache keeps sharedBy and visited semantics for keyed messages and partial files", async () => {
  const assistantRecord = (id: string, output: number) => ({ type: "assistant", message: { id, usage: { input_tokens: 10, output_tokens: output } } });
  const files: Record<string, unknown[]> = {
    "/a.jsonl": [assistantRecord("shared", 10), assistantRecord("shared", 10), assistantRecord("own-a", 1)],
    "/b.jsonl": [assistantRecord("shared", 20)],
    "/c.jsonl": [assistantRecord("x", 1), assistantRecord("y", 1)],
  };
  const mains = [{ path: "/a.jsonl", timestamp: "2026-07-20T12:00:00Z" }, { path: "/b.jsonl", timestamp: "2026-07-20T13:00:00Z" }, { path: "/c.jsonl", timestamp: "2026-07-20T14:00:00Z" }];
  const stored = new Map<string, ClaudeObservationRead>();
  let reads = 0;
  const cache: ClaudeOwnershipCache = {
    key: (id) => keyedHash(Buffer.alloc(32, 9), id).slice(0, 32),
    prefetch: async () => {},
    observations: async (path, read) => {
      const hit = stored.get(path);
      if (hit) return hit;
      reads++;
      const fresh = await read();
      if (fresh.complete) stored.set(path, fresh);
      return fresh;
    },
  };
  const run = (withCache: boolean) => buildClaudeUsageOwners(mains, async (main) => [main], async (path, visitor) => {
    for (const [line, record] of (files[path] ?? []).entries()) {
      if (path === "/c.jsonl" && line > 0) throw new Error("unreadable");
      visitor(record as never, line + 1);
    }
  }, withCache ? cache : null);
  const plain = await run(false);
  for (const attempt of [1, 2]) {
    const keyed = await run(true);
    assert.equal(keyed.ownerOf("shared"), "/b.jsonl");
    assert.equal(keyed.ownerOf("shared"), plain.ownerOf("shared"));
    assert.equal(keyed.ownerOf("own-a"), undefined);
    assert.equal(keyed.has("shared"), false, "keyed owners never hold raw message IDs");
    for (const paths of [["/a.jsonl"], ["/b.jsonl"], ["/c.jsonl"], ["/never-visited.jsonl"]]) assert.equal(keyed.sharedBy(paths), plain.sharedBy(paths), `${attempt}:${paths}`);
    assert.equal(keyed.sharedBy(["/c.jsonl"]), true);
  }
  assert.equal(reads, 4, "complete files replay; the partial file is read again");
});

for (const target of ["ownership", "conductor"] as const) test(`a warm ${target} audit detects validly signed stale evidence and falls back`, async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture);
    await resumedCopies(fixture);
    const db = conductorHistory(fixture);
    try {
      const full = stable(await analyzeMachineSessions({ ...opts, noIndex: true }));
      await analyzeMachineSessions(opts);
      // Emulate an earlier extraction bug, not disk corruption (the MAC remains valid).
      const connection = openIndexDatabase(opts);
      try {
        const [table, column, payloadColumn] = target === "ownership" ? ["claude_ownership", "source_key", "observations"] : ["conductor_records", "session_key", "payload"];
        for (const row of connection.database.prepare(`SELECT scope,${column} AS key,${payloadColumn} AS payload FROM ${table}`).all()) {
          const value = JSON.parse(inflateRawSync(row["payload"] as Uint8Array).toString("utf8"));
          if (target === "ownership") value.push(["f".repeat(32), 1, 1, null, 0, 0, 0, 0]);
          else value.resets.push(["f".repeat(32), "e".repeat(32)]);
          const payload = deflateRawSync(JSON.stringify(value));
          connection.database.prepare(`UPDATE ${table} SET ${payloadColumn}=?,${payloadColumn === "payload" ? "payload_mac" : "observations_mac"}=? WHERE scope=? AND ${column}=?`)
            .run(payload, keyedHash(connection.secret, payload), row["scope"] as string, row["key"] as string);
        }
      } finally { connection.close(); }
      const audited = await analyzeMachineSessions(opts);
      assert.ok(audited.warnings.some((warning) => warning.includes("full scan")));
      const { warnings, ...rest } = stable(audited);
      const { warnings: expected, ...fullRest } = full;
      assert.deepEqual(rest.sessions, fullRest.sessions);
      void warnings; void expected;
    } finally { db.close(); }
  });
});

test("a version 3 index migrates in place, keeps its facts and fills the pre-pass caches", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture);
    await resumedCopies(fixture);
    const full = stable(await analyzeMachineSessions({ ...opts, noIndex: true }));
    await analyzeMachineSessions(opts);
    const db = new DatabaseSync(indexPath(opts));
    db.exec("DROP TABLE claude_ownership; DROP TABLE conductor_records; PRAGMA user_version=3;"); db.close();
    assert.deepEqual(stable(await analyzeMachineSessions(opts)), full);
    const migrated = lastStats(opts);
    assert.equal(migrated.parsedSessions, 0, "existing session facts are reused");
    assert.ok(migrated.ownershipReads > 0);
    const check = new DatabaseSync(indexPath(opts), { readOnly: true });
    try { assert.equal(check.prepare("PRAGMA user_version").get()?.["user_version"], 4); }
    finally { check.close(); }
    assert.deepEqual(stable(await analyzeMachineSessions(opts)), full);
    assert.equal(lastStats(opts).ownershipReads, 0);
  });
});
