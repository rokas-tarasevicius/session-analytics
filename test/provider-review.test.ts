import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { cursorSdkAdapter } from "../src/providers/cursor-sdk.ts";
import { geminiAdapter } from "../src/providers/gemini.ts";
import { jsonLines, modelName, zeroCost } from "../src/providers/common.ts";
import type { ProviderContext } from "../src/providers/adapter.ts";
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "./fixtures.ts";

const at = "2026-07-20T09:00:00.000Z", later = "2026-07-21T09:00:00.000Z";
const secret = "/private/REVIEW-SECRET command --token=credential";
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const context: ProviderContext = { repository: { id: "example", name: "Example" }, rateCard: { currency: "USD", effectiveDate: "2026-07-20", models: {} }, price: () => zeroCost() };
const options = (f: SessionAnalyticsFixture) => ({ additionalProviders: false, databasePath: f.databasePath, claudeRoot: f.claudeRoot, codexRoot: f.codexRoot, codexArchiveRoot: f.codexArchiveRoot, cursorDatabasePath: f.cursorDatabasePath });
async function fixture(run: (root: string, f: SessionAnalyticsFixture) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "provider-review-"));
  try { await run(root, await createSessionAnalyticsFixture(root)); } finally { await rm(root, { recursive: true, force: true }); }
}
async function write(path: string, rows: unknown[]) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, jsonl(rows)); }
function resultsDb(f: SessionAnalyticsFixture) {
  const db = new DatabaseSync(f.databasePath);
  db.exec("CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT, full_message TEXT, created_at TEXT)");
  const workspace = db.prepare("SELECT workspace_id FROM sessions LIMIT 1").get()!["workspace_id"]!;
  const row = (id: string, provider: string | null = "provider-private") => db.prepare("INSERT INTO sessions (id,agent_type,status,created_at,updated_at,workspace_id,claude_session_id) VALUES (?,?,?,?,?,?,?)").run(id, "claude", "completed", at, later, workspace, provider);
  let index = 0;
  const event = (rowId: string, data: object) => { index++; db.prepare("INSERT INTO session_messages VALUES (?,?,?,?,?)").run(`event-${index}`, rowId, JSON.stringify(data), JSON.stringify(data), new Date(Date.parse(at) + index * 1000).toISOString()); };
  return { db, row, event };
}
const result = (uuid: string, cost: number, input = cost * 100, session_id = "provider-private") => ({ type: "result", uuid, session_id, subtype: "success", total_cost_usd: cost, modelUsage: { "claude-opus-5": { inputTokens: input, outputTokens: 20, costUSD: cost } }, usage: { input_tokens: 11, output_tokens: 3 }, num_turns: 1, duration_ms: 100, duration_api_ms: cost * 500 });

test("review: Conductor streaming receipts select cumulative snapshots and keep turn-local usage separate", async () => {
  await fixture(async (_root, f) => {
    const { db, row, event } = resultsDb(f); row("stream");
    event("stream", result("one", 1)); event("stream", result("two", 2)); db.close();
    const s = (await analyzeMachineSessions(options(f))).sessions.find((s) => s.conductor)!;
    assert.equal(s.cost.totalUsd, 2); assert.equal(s.tokens.inputTokens, 200); assert.equal(s.models[0]!.totalUsd, 2);
    assert.equal(s.conductor!.resultRecords, 2);
    // Counter scopes aren't established by a result UUID; don't invent additive durations.
    assert.equal(s.conductor!.apiDurationMilliseconds, null);
    assert.equal(s.costComplete, false);
  });
});

test("review: Conductor groups all rows, including unregistered identities, independent of row order", async () => {
  for (const reverse of [false, true]) await fixture(async (_root, f) => {
    const { db, row, event } = resultsDb(f);
    for (const id of reverse ? ["z-old", "a-new"] : ["a-new", "z-old"]) row(id, id === "z-old" ? null : "provider-private");
    event("z-old", result("one", 1)); event("a-new", result("two", 2)); event("a-new", result("one", 1)); db.close();
    const recovered = (await analyzeMachineSessions(options(f))).sessions.filter((s) => s.conductor);
    assert.equal(recovered.length, 1); assert.equal(recovered[0]!.cost.totalUsd, 2); assert.equal(recovered[0]!.conductor!.resultRecords, 2);
  });
});

test("review: Conductor unknown restarts and zeroed crashes retain a partial snapshot without summing", async () => {
  await fixture(async (_root, f) => {
    const { db, row, event } = resultsDb(f); row("restart");
    event("restart", result("one", 2)); event("restart", result("reset", 1));
    event("restart", { ...result("crash", 0, 0), modelUsage: {}, is_error: true, subtype: "error_during_execution" }); db.close();
    const s = (await analyzeMachineSessions(options(f))).sessions.find((s) => s.conductor)!;
    assert.equal(s.cost.totalUsd, 2); assert.equal(s.tokens.inputTokens, 200); assert.equal(s.costComplete, false);
    assert.equal(s.conductor!.resultRecords, 3); assert.equal(s.conductor!.errorResults, 1);
    assert.match(s.transcript.warnings.join(" "), /partial|ambiguous/i);
  });
});

test("review: OpenCode original, fork and continued fork conserve request tokens, cost and dates", async () => {
  await fixture(async (root, f) => {
    const path = join(root, "fork.db"), db = new DatabaseSync(path);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT)");
    for (const [id, created] of [["original", at], ["fork", later], ["continued", "2026-07-22T09:00:00Z"]]) {
      db.prepare("INSERT INTO session VALUES (?,NULL,?,?,?)").run(id!, f.repositoryRoot, Date.parse(created!), Date.parse(created!));
      const message = { role: "assistant", modelID: "claude-opus-5", time: { created: Date.parse(at), completed: Date.parse(at) + 1000 }, tokens: { input: 100, output: 20 } };
      db.prepare("INSERT INTO message VALUES (?,?,?)").run(`${id}-message`, id!, JSON.stringify(message));
      db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run(`${id}-part`, id!, `${id}-message`, Date.parse(created!), JSON.stringify({ type: "step-finish", tokens: message.tokens }));
    }
    const newTime = "2026-07-22T10:00:00Z";
    db.prepare("INSERT INTO message VALUES (?,?,?)").run("new", "continued", JSON.stringify({ role: "assistant", modelID: "claude-opus-5", time: { created: Date.parse(newTime) }, tokens: { input: 50, output: 10 } }));
    db.close();
    const s = (await analyzeMachineSessions({ ...options(f), opencodeDatabasePath: path })).sessions.filter((s) => s.provider === "opencode");
    assert.equal(s.reduce((n, s) => n + s.tokens.inputTokens, 0), 150); assert.equal(s.reduce((n, s) => n + s.metrics.modelCalls, 0), 2);
    assert.equal(s.reduce((n, s) => n + s.cost.totalUsd, 0), 0.0015);
    assert.deepEqual(Object.assign({}, ...s.map((s) => s.spendByDay)), { "2026-07-20": 0.001, "2026-07-22": 0.0005 });
  });
});

test("review: Gemini partial order and removal preserve the unmentioned prefix before rewind", async () => {
  await fixture(async (root, _f) => {
    for (const remove of [false, true]) {
      const path = join(root, `session-${remove}.jsonl`);
      await write(path, [{ sessionId: "gemini", projectHash: "synthetic", startTime: at },
        { id: "u1", type: "user", timestamp: at }, { id: "a1", type: "gemini", timestamp: at, tokens: { input: 100, output: 20 } },
        { id: "u2", type: "user", timestamp: later }, { id: "a2", type: "gemini", timestamp: later },
        { $patch: { ...(remove ? { removeIds: ["a2"] } : {}), orderIds: ["u2", "a2"] } }, { $rewindTo: "u2" }]);
      const s = await geminiAdapter().analyze({ id: "gemini", path, cwd: null, createdAt: at, updatedAt: later }, context);
      assert.equal(s!.tokens.inputTokens, 100); assert.equal(s!.metrics.userTurns, 1);
    }
  });
});

test("review: model normalization preserves exact namespaces while rejecting paths and credentials", () => {
  for (const id of ["org/model", "anthropic/claude-sonnet-4", "@cf/meta/llama-3.1-8b-instruct", "us.anthropic.claude-sonnet-4:0"]) assert.equal(modelName(id), id);
  for (const id of [secret, "/private/secret", "../model", "Users/secret", "file:///secret", "https://secret", "sk-secret", "org/model\n", "org/../model", "C:\\secret", "__proto__"]) assert.equal(modelName(id), "<unknown>");
});

test("review: Cursor SDK traverses runs and events once for a shared multi-agent directory", async (t) => {
  await fixture(async (root, _f) => {
    const path = join(root, "sdk", "store", "agents.ndjson");
    await write(path, ["a", "b", "c"].map((agentId) => ({ agentId, cwd: root, createdAt: at })));
    await write(join(dirname(path), "runs.ndjson"), ["a", "b", "c"].map((agentId) => ({ agentId, runId: agentId, model: { id: "claude-opus-5" }, status: "finished", startedAt: at, endedAt: later, usage: { inputTokens: 100, outputTokens: 20 } })));
    await write(join(dirname(path), "run_events.ndjson"), ["a", "b", "c"].map((agentId) => ({ payload: { type: "sdk_message", message: { type: "tool_call", agent_id: agentId, run_id: agentId, call_id: agentId, name: "Read", args: secret } } })));
    const counts = new Map<string, number>(), original = fs.createReadStream;
    t.mock.method(fs, "createReadStream", (...args: Parameters<typeof fs.createReadStream>) => { const path = String(args[0]); counts.set(path, (counts.get(path) ?? 0) + 1); return original(...args); }); syncBuiltinESMExports();
    try {
      const sessions = [];
      for await (const id of cursorSdkAdapter.identify(join(root, "sdk"))) sessions.push(await cursorSdkAdapter.analyze(id, context));
      assert.equal(sessions.length, 3); assert.ok(sessions.every((s) => s!.tokens.inputTokens === 100 && s!.tools["Read"] === 1));
      assert.equal(counts.get(join(dirname(path), "runs.ndjson")), 1); assert.equal(counts.get(join(dirname(path), "run_events.ndjson")), 1);
      assert.ok(!JSON.stringify(sessions).includes(secret));
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
});

test("review: isolated Claude JSON rejects private structured fields and malformed timestamps/status", async () => {
  await fixture(async (root, f) => {
    const path = join(f.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", "22222222-2222-4222-8222-222222222222.jsonl");
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    for (const row of lines) if (row.type === "assistant") { row.effort = secret; row.timestamp = secret; row.message.model = secret; for (const block of row.message.content ?? []) if (block.type === "tool_use") block.name = secret; }
    await writeFile(path, jsonl(lines));
    const db = new DatabaseSync(f.databasePath); db.prepare("UPDATE sessions SET status=?, created_at=?, model=? WHERE agent_type='claude'").run(secret, secret, secret); db.close();
    const cursor = new DatabaseSync(f.cursorDatabasePath);
    const composer = JSON.parse(String(cursor.prepare("SELECT value FROM cursorDiskKV WHERE key='composerData:cursor-fixture'").get()!["value"]));
    composer.usageData = { [secret]: { costInCents: 100 }, "/private/SECOND-REVIEW-SECRET": { costInCents: 200 } };
    cursor.prepare("UPDATE cursorDiskKV SET value=? WHERE key='composerData:cursor-fixture'").run(JSON.stringify(composer)); cursor.close();
    const child = spawnSync(process.execPath, ["bin/session-analytics.ts", "report", "--json", "--no-additional-providers", "--database", f.databasePath, "--claude-root", f.claudeRoot, "--codex-root", f.codexRoot, "--codex-archive-root", f.codexArchiveRoot, "--cursor-database", f.cursorDatabasePath], { encoding: "utf8", timeout: 20000 });
    assert.equal(child.status, 0, child.stderr); assert.ok(!child.stdout.includes("REVIEW-SECRET")); assert.ok(!child.stdout.includes(root));
    const s = JSON.parse(child.stdout).sessions.find((s: { provider: string }) => s.provider === "claude"); assert.ok(s);
    assert.equal(s.status, "unknown"); assert.ok(Number.isFinite(Date.parse(s.createdAt)));
    const nativeCursor = JSON.parse(child.stdout).sessions.find((s: { provider: string; cost: { totalUsd: number } }) => s.provider === "cursor" && s.cost.totalUsd === 3);
    assert.equal(nativeCursor.models.length, 1); assert.equal(nativeCursor.models[0].model, "<unknown>");
  });
});

test("review: Conductor versioned restarts, restored resumes and explicit resets conserve totals", async () => {
  for (const version of ["2.1.276", "2.1.277"]) await fixture(async (_root, f) => {
    const { db, row, event } = resultsDb(f); row("epochs");
    event("epochs", { type: "system", subtype: "init", uuid: "process-1", session_id: "provider-private", claude_code_version: version });
    event("epochs", result("one", 1)); event("epochs", result("two", 2));
    event("epochs", { type: "system", subtype: "init", uuid: "process-2", session_id: "provider-private", claude_code_version: version });
    event("epochs", result("three", version === "2.1.276" ? 1 : 3));
    event("epochs", { type: "conversation_reset", uuid: "reset-id", session_id: "provider-private", new_conversation_id: "after-reset" });
    event("epochs", result("four", 4, 400, "after-reset")); db.close();
    const s = (await analyzeMachineSessions(options(f))).sessions.filter((s) => s.conductor);
    assert.equal(s.length, 2); assert.equal(s.reduce((n, s) => n + s.cost.totalUsd, 0), 7);
    assert.equal(s.reduce((n, s) => n + s.tokens.inputTokens, 0), 700);
    assert.equal(s.reduce((n, s) => n + s.conductor!.resultRecords, 0), 4);
    assert.ok(s.every((s) => s.costComplete));
    assert.equal(s.reduce((n, s) => n + s.conductor!.turnLocalTokens!.inputTokens, 0), 44);
  });
});

test("review: Conductor conflicting repository rows use an explicit unassigned group", async () => {
  await fixture(async (_root, f) => {
    const { db, row, event } = resultsDb(f); row("original"); row("reattached");
    const workspace = db.prepare("SELECT id FROM workspaces WHERE repository_id='repository-2'").get();
    if (!workspace) db.exec("INSERT INTO workspaces (id,repository_id,workspace_path) VALUES ('other-workspace','repository-2','/synthetic/other')");
    db.prepare("UPDATE sessions SET workspace_id=? WHERE id='reattached'").run(workspace?.["id"] ?? "other-workspace");
    event("original", result("one", 1)); event("reattached", result("two", 2)); db.close();
    const snapshot = await analyzeMachineSessions(options(f));
    const s = snapshot.sessions.filter((s) => s.conductor); assert.equal(s.length, 1);
    assert.equal(s[0]!.repositoryName, "Conductor · unassigned"); assert.equal(s[0]!.cost.totalUsd, 2);
    assert.ok(snapshot.repositories.some((r) => r.repository.id === s[0]!.repositoryId));
  });
});

test("review: OpenCode orphaned inherited usage is partial and exact namespaced rates remain distinct", async () => {
  await fixture(async (root, f) => {
    const path = join(root, "models.db"), db = new DatabaseSync(path);
    db.exec("CREATE TABLE session (id TEXT,parent_id TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE message (id TEXT,session_id TEXT,data TEXT); CREATE TABLE part (id TEXT,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT)");
    db.prepare("INSERT INTO session VALUES ('session',NULL,?,?,?)").run(f.repositoryRoot, Date.parse(later), Date.parse(later));
    for (const [id, model, time] of [["one", "org/model", later], ["two", "other/model", later], ["orphan", "org/model", at], ["private", secret, later]]) db.prepare("INSERT INTO message VALUES (?,'session',?)").run(id!, JSON.stringify({ role: "assistant", modelID: model, time: { created: Date.parse(time!) }, tokens: { input: 100, output: 20 } }));
    db.close();
    const rate = (inputPerMillion: number) => ({ provider: "opencode", inputPerMillion, outputPerMillion: 1, source: "https://example.invalid/synthetic" });
    const rates = join(root, "rates.json"); await writeFile(rates, JSON.stringify({ currency: "USD", effectiveDate: "2026-07-20", models: { "org/model": rate(1), "other/model": rate(2) } }));
    const s = (await analyzeMachineSessions({ ...options(f), opencodeDatabasePath: path, rateCardPath: rates })).sessions.find((s) => s.provider === "opencode")!;
    assert.deepEqual(s.models.map((m) => m.model).sort(), ["<unknown>", "org/model", "other/model"]);
    assert.equal(s.models.find((m) => m.model === "org/model")!.totalUsd, 0.00012);
    assert.equal(s.models.find((m) => m.model === "other/model")!.totalUsd, 0.00022);
    assert.equal(s.tokens.inputTokens, 300); assert.equal(s.evidence!.accounting, "partial"); assert.equal(s.costComplete, false);
    assert.ok(!JSON.stringify(s).includes("REVIEW-SECRET"));
  });
});

test("review: Gemini legacy JSON is read once and oversized replay is rejected within a 256 MiB heap", async (t) => {
  await fixture(async (root, _f) => {
    const path = join(root, "gemini", "synthetic", "chats", "session-small.json");
    const header = { sessionId: "gemini", projectHash: "synthetic", startTime: at, lastUpdated: later };
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ ...header, messages: [{ id: "one", type: "user", timestamp: at }] }));
    const promises = (await import("node:fs/promises")).default, original = promises.readFile; let reads = 0;
    t.mock.method(promises, "readFile", (...args: Parameters<typeof promises.readFile>) => { if (String(args[0]) === path) reads++; return original(...args); }); syncBuiltinESMExports();
    try { const adapter = geminiAdapter(); for await (const id of adapter.identify(join(root, "gemini"))) await adapter.analyze(id, context); assert.equal(reads, 1); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    // A legacy file close to the former 32 MiB allowance, with earlier provider results still live.
    const messages = Array.from({ length: 160_000 }, (_, i) => ({ id: String(i), type: "gemini", model: "gemini-fixture", timestamp: at, tokens: { input: 100, output: 20 }, content: "synthetic padding for memory regression" }));
    await writeFile(path, JSON.stringify({ ...header, messages }));
    const script = `import {geminiAdapter} from ${JSON.stringify(new URL("../src/providers/gemini.ts", import.meta.url).href)}; const reserve=Array(8_000_000).fill(1); let rejected=false; try {for await(const id of geminiAdapter().identify(${JSON.stringify(join(root, "gemini"))})) {}} catch {rejected=true;} console.log(JSON.stringify({rejected,reserve:reserve.length,heap:process.memoryUsage().heapUsed}));`;
    const child = spawnSync(process.execPath, ["--max-old-space-size=256", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30000, maxBuffer: 8192 });
    assert.equal(child.status, 0, "bounded Gemini probe must complete under the production heap cap");
    const output = JSON.parse(child.stdout); assert.equal(output.rejected, true); assert.ok(output.heap < 192 * 1024 * 1024);
  });
});


test("review: bounded JSONL buffering skips oversized lines and resumes at the next record", async () => {
  await fixture(async (root, _f) => {
    const path = join(root, "bounded.jsonl");
    await writeFile(path, " ".repeat(200_000) + "\n" + JSON.stringify({ counter: 1 }) + "\r\n" + JSON.stringify({ counter: 2 }));
    const values = []; for await (const value of jsonLines(path, 1024)) values.push(value);
    assert.deepEqual(values, [null, { counter: 1 }, { counter: 2 }]);
  });
});
