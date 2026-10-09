import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { analyzeMachineSessions as analyzeMachineSessionsRaw } from "../src/analyzer.ts";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { VelocityAccumulator, addSessionDated, localClock, velocityDimension, zeroVelocity } from "../src/metrics/velocity.ts";
import { buildVelocity, ledgerCells } from "../src/public/velocity-data.js";
import type { AnalyzeOptions, SessionAnalytics, VelocityValues } from "../src/types.ts";
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "./fixtures.ts";

// Synthetic records in each additional source's real shape. Times are mid-day UTC on separate
// dates; expectations use the analysis timezone's own clock, so the suite holds in any `TZ`.
const day1 = "2026-07-18T12:00:00.000Z", day2 = "2026-07-20T12:00:00.000Z", last = "2026-07-21T12:00:00.000Z";
const sentinel = "PRIVATE-CONTENT-SENTINEL /secret/path command --token=secret";
const window = { start: "2026-07-01", end: "2026-07-31" };
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
async function write(path: string, data: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); }
const local = (at: string) => localClock(at)!;

async function fixture(run: (root: string, fixture: SessionAnalyticsFixture) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "session-dating-"));
  try { await run(root, await createSessionAnalyticsFixture(root)); } finally { await rm(root, { recursive: true, force: true }); }
}
function options(f: SessionAnalyticsFixture, extra: AnalyzeOptions): AnalyzeOptions {
  return { noIndex: true, additionalProviders: false, pricingPolicy: "reviewed-only", claudeRoot: f.claudeRoot, codexRoot: f.codexRoot, codexArchiveRoot: f.codexArchiveRoot, cursorDatabasePath: f.cursorDatabasePath, databasePath: f.databasePath, ...extra };
}
async function analyze(extra: (root: string, f: SessionAnalyticsFixture) => Promise<AnalyzeOptions>, check: (sessions: SessionAnalytics[], root: string) => void) {
  await fixture(async (root, f) => {
    const snapshot = validateSnapshot(await analyzeMachineSessionsRaw(options(f, await extra(root, f))));
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /PRIVATE-CONTENT-SENTINEL/);
    assert.ok(!serialized.includes(root), "Leaked fixture root");
    check(snapshot.sessions, root);
  });
}
const sum = (cells: Array<{ 3: VelocityValues } | VelocityValues>, index: number) =>
  cells.reduce((total, cell) => total + (Array.isArray(cell[3]) ? (cell[3] as VelocityValues)[index]! : (cell as VelocityValues)[index]!), 0);
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const cellsOn = (cells: Array<[string, number, number, VelocityValues]>, at: string) => cells.filter(([day, hour]) => day === local(at).day && hour === local(at).hour);
function conserved(session: SessionAnalytics): void {
  const velocity = session.velocity!;
  const dated = sum(velocity.buckets, 0), placed = sum(velocity.sessionDated ?? [], 0), undated = velocity.undated.reduce((n, [, values]) => n + values[0], 0);
  close(dated + placed + undated, session.cost.totalUsd);
  // Daily spend holds activity-dated value only, never session-dated value.
  close(Object.values(session.spendByDay).reduce((n, v) => n + v, 0), dated);
}

async function geminiStore(root: string, cwd: string): Promise<string> {
  const store = join(root, "gemini", "tmp"), project = createHash("sha256").update(cwd).digest("hex");
  await write(join(dirname(store), "projects.json"), JSON.stringify({ projects: { [cwd]: "example" } }));
  const usage = { input: 1000, cached: 400, output: 300, thoughts: 50 };
  await write(join(store, "example", "chats", "session-dated.jsonl"), jsonl([
    { sessionId: "gemini-dated", projectHash: project, startTime: day1, lastUpdated: last, kind: "main", summary: sentinel },
    { id: "user", type: "user", timestamp: day1, content: sentinel },
    { id: "a", type: "gemini", timestamp: day1, model: "gemini-fixture", tokens: usage, content: sentinel, toolCalls: [{ id: "tool-a", name: "read_file", args: sentinel }] },
    { id: "b", type: "gemini", timestamp: day2, model: "gemini-fixture", tokens: usage, content: sentinel },
    { id: "c", type: "gemini", model: "gemini-fixture", tokens: usage, content: sentinel },
  ]));
  return store;
}
async function openCodeDatabase(root: string, cwd: string): Promise<string> {
  const path = join(root, "opencode.db"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT)");
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("opencode-dated", null, cwd, Date.parse(day1), Date.parse(last));
  db.prepare("INSERT INTO message VALUES (?,?,?)").run("assistant", "opencode-dated", JSON.stringify({ role: "assistant", modelID: "claude-opus-5", time: { created: Date.parse(day1) }, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } }, content: sentinel }));
  const part = db.prepare("INSERT INTO part VALUES (?,?,?,?,?)");
  const step = { type: "step-finish", tokens: { input: 100, output: 30, reasoning: 10, cache: { read: 40, write: 20 } } };
  part.run("step-1", "opencode-dated", "assistant", Date.parse(day1), JSON.stringify(step));
  part.run("step-2", "opencode-dated", "assistant", Date.parse(day2), JSON.stringify(step));
  part.run("tool", "opencode-dated", "assistant", Date.parse(day2), JSON.stringify({ type: "tool", tool: "read", callID: "call", state: { input: sentinel, output: sentinel } }));
  db.close();
  return path;
}
async function copilotStore(root: string, cwd: string): Promise<string> {
  const store = join(root, "copilot");
  const event = (type: string, id: string, timestamp: string, data: object) => ({ id, type, timestamp, data });
  await write(join(store, "copilot-dated", "events.jsonl"), jsonl([
    event("session.start", "start", day1, { sessionId: "copilot-dated", startTime: day1, context: { cwd } }),
    event("user.message", "user", day1, { content: sentinel }),
    event("tool.execution_start", "tool-1", day1, { toolCallId: "call-1", toolName: "read_file", arguments: sentinel }),
    event("tool.execution_start", "tool-2", day2, { toolCallId: "call-2", toolName: "edit_file", arguments: sentinel }),
  ]));
  return store;
}
async function sdkStore(root: string, cwd: string): Promise<string> {
  const store = join(root, "sdk"), dir = join(store, "agent");
  const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await write(join(dir, "agents.ndjson"), jsonl([{ agentId, cwd, name: sentinel, createdAt: day1, updatedAt: day2 }]));
  const usage = { inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 20, outputTokens: 30, reasoningTokens: 10 };
  await write(join(dir, "runs.ndjson"), jsonl([
    { agentId, runId: "run-1", model: { id: "claude-opus-5" }, status: "finished", startedAt: day1, endedAt: day1, usage, result: sentinel },
    { agentId, runId: "run-2", model: { id: "claude-opus-5" }, status: "finished", startedAt: day2, endedAt: day2, usage, result: sentinel },
    // A run with no time of its own: its value is session-dated, not given an invented run date.
    { agentId, runId: "run-3", model: { id: "claude-opus-5" }, status: "finished", usage, result: sentinel },
  ]));
  await write(join(dir, "run_events.ndjson"), jsonl([
    { createdAt: day2, payload: { type: "sdk_message", message: { type: "tool_call", agent_id: agentId, run_id: "run-2", call_id: "call", name: "read_file", args: sentinel } } },
  ]));
  return store;
}
function conductorReceipt(f: SessionAnalyticsFixture): void {
  const db = new DatabaseSync(f.databasePath);
  db.exec("CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT, full_message TEXT, created_at TEXT)");
  const original = db.prepare("SELECT workspace_id FROM sessions WHERE agent_type = 'claude' LIMIT 1").get()!;
  db.prepare("INSERT INTO sessions (id, status, agent_type, title, created_at, updated_at, claude_session_id, model, workspace_id) VALUES (?,?,?,?,?,?,?,?,?)").run("receipt-only", "completed", "claude", sentinel, day1, last, "receipt-provider", "claude-opus-5", original["workspace_id"]!);
  const result = { type: "result", uuid: "receipt", session_id: "receipt-provider", result: sentinel, total_cost_usd: 2,
    modelUsage: { "claude-opus-5": { inputTokens: 100, cacheReadInputTokens: 40, cacheCreationInputTokens: 20, outputTokens: 30, costUSD: 2 } } };
  db.prepare("INSERT INTO session_messages VALUES (?,?,?,?,?)").run("receipt-row", "receipt-only", JSON.stringify(result), null, day2);
  db.close();
}
async function rates(root: string): Promise<string> {
  const path = join(root, "rates.json");
  await writeFile(path, JSON.stringify({ currency: "USD", effectiveDate: "2026-07-01", models: {
    "gemini-fixture": { provider: "gemini", inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 2, source: "https://example.invalid/synthetic-rate" },
    "claude-opus-5": { provider: "claude", inputPerMillion: 5, cacheReadPerMillion: 0.5, cacheWrite5mPerMillion: 6.25, outputPerMillion: 25, source: "https://example.invalid/synthetic-rate" },
  } }));
  return path;
}

test("Gemini dates value per message and session-dates a message without its own time", async () => {
  await analyze(async (root, f) => ({ geminiRoot: await geminiStore(root, f.repositoryRoot), rateCardPath: await rates(root) }), (sessions) => {
    const s = sessions.find((item) => item.evidence?.source === "gemini-chat")!;
    const v = s.velocity!;
    assert.equal(v.dimensions[0]!.agent, "gemini");
    assert.ok(cellsOn(v.buckets, day1).some((cell) => cell[3][0] > 0 && cell[3][8] === 1), "day-one message value and its tool are dated");
    assert.ok(cellsOn(v.buckets, day2).some((cell) => cell[3][0] > 0), "day-two message value is dated");
    // The untimed message lands on the last observed message time, labeled session-dated.
    assert.equal(v.sessionDated!.length, 1);
    assert.deepEqual(v.sessionDated![0]!.slice(0, 2), [local(day2).day, local(day2).hour]);
    close(v.sessionDated![0]![3][0], s.cost.totalUsd / 3);
    assert.equal(sum(v.sessionDated!, 7), 1);
    conserved(s);
  });
});

test("OpenCode dates each step and tool by its own row time", async () => {
  await analyze(async (root, f) => ({ opencodeDatabasePath: await openCodeDatabase(root, f.repositoryRoot), rateCardPath: await rates(root) }), (sessions) => {
    const s = sessions.find((item) => item.provider === "opencode")!;
    const v = s.velocity!;
    assert.equal(v.dimensions[0]!.agent, "opencode");
    assert.equal(v.sessionDated, undefined);
    close(sum(cellsOn(v.buckets, day1), 0), s.cost.totalUsd / 2);
    close(sum(cellsOn(v.buckets, day2), 0), s.cost.totalUsd / 2);
    assert.equal(sum(cellsOn(v.buckets, day2), 8), 1);
    // OpenCode records cache writes and reasoning, so their coverage numerators are filled.
    assert.equal(sum(v.buckets, 13), s.tokens.inputTokens); assert.equal(sum(v.buckets, 11), s.tokens.outputTokens);
    conserved(s);
  });
});

test("Copilot dates tool calls by event time and records no value", async () => {
  await analyze(async (root, f) => ({ copilotRoot: await copilotStore(root, f.repositoryRoot) }), (sessions) => {
    const s = sessions.find((item) => item.provider === "copilot")!;
    const v = s.velocity!;
    assert.equal(v.dimensions[0]!.agent, "copilot");
    assert.equal(sum(cellsOn(v.buckets, day1), 8), 1); assert.equal(sum(cellsOn(v.buckets, day2), 8), 1);
    assert.equal(sum(cellsOn(v.buckets, day1), 9), 1);
    assert.equal(sum(v.buckets, 0), 0); assert.equal(v.sessionDated, undefined);
  });
});

test("Cursor SDK dates value per run and session-dates a run without its own time", async () => {
  await analyze(async (root, f) => ({ cursorSdkRoot: await sdkStore(root, f.repositoryRoot), rateCardPath: await rates(root) }), (sessions) => {
    const s = sessions.find((item) => item.evidence?.source === "cursor-sdk")!;
    const v = s.velocity!, perRun = s.cost.totalUsd / 3;
    close(sum(cellsOn(v.buckets, day1), 0), perRun);
    close(sum(cellsOn(v.buckets, day2), 0), perRun);
    assert.equal(sum(cellsOn(v.buckets, day2), 8), 1);
    assert.equal(v.sessionDated!.length, 1);
    assert.deepEqual(v.sessionDated![0]!.slice(0, 2), [local(day2).day, local(day2).hour]);
    close(v.sessionDated![0]![3][0], perRun);
    // Run-dated value enters UTC daily spend; the session-dated run does not.
    assert.deepEqual(Object.keys(s.spendByDay).sort(), [day1.slice(0, 10), day2.slice(0, 10)]);
    conserved(s);
  });
});

test("Conductor result receipts are session-dated at the receipt time, never request-dated", async () => {
  await analyze(async (_root, f) => { conductorReceipt(f); return {}; }, (sessions) => {
    const s = sessions.find((item) => item.evidence?.source === "conductor-result")!;
    const v = s.velocity!;
    assert.equal(s.costBasis, "provider-reported"); assert.deepEqual(s.spendByDay, {});
    assert.equal(sum(v.buckets, 0), 0, "No receipt value is placed on a request date");
    assert.equal(sum(v.buckets, 9), 1, "The session start is still dated");
    assert.equal(v.sessionDated!.length, 1);
    assert.deepEqual(v.sessionDated![0]!.slice(0, 2), [local(day2).day, local(day2).hour]);
    assert.equal(v.dimensions[v.sessionDated![0]![2]]!.agent, "claude-sdk");
    assert.equal(v.sessionDated![0]![3][0], 2);
    assert.equal(v.sessionDated![0]![3][10], s.tokens.inputTokens + s.tokens.outputTokens, "Reported value covers its reported tokens");
  });
});

test("Cursor transcripts keep their activity undated", async () => {
  await analyze(async (root, f) => {
    const project = f.repositoryRoot.replace(/^\//, "").replace(/[^A-Za-z0-9]/g, "-");
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", path = join(root, "cursor-projects", project, "agent-transcripts", `${id}.jsonl`);
    await write(path, jsonl([{ role: "user", message: { content: [{ type: "text", text: sentinel }] } }, { role: "assistant", message: { content: [{ type: "tool_use", id: "call", name: "Read", input: { path: sentinel } }] } }]));
    await utimes(path, new Date(day2), new Date(day2));
    return { cursorTranscriptRoot: join(root, "cursor-projects") };
  }, (sessions) => {
    const s = sessions.find((item) => item.evidence?.source === "cursor-transcript")!;
    assert.deepEqual(s.velocity!.buckets, []); assert.equal(s.velocity!.sessionDated, undefined);
    assert.equal(s.velocity!.undated.reduce((n, [, values]) => n + values[8], 0), 1, "File mtime never dates the tool call");
  });
});

test("Summary and Velocity include previously excluded sources and still agree", async () => {
  const sources = new Set(["gemini-chat", "opencode-db", "cursor-sdk", "conductor-result", "copilot-events"]);
  await analyze(async (root, f) => {
    conductorReceipt(f);
    return { geminiRoot: await geminiStore(root, f.repositoryRoot), opencodeDatabasePath: await openCodeDatabase(root, f.repositoryRoot),
      copilotRoot: await copilotStore(root, f.repositoryRoot), cursorSdkRoot: await sdkStore(root, f.repositoryRoot), rateCardPath: await rates(root) };
  }, (all) => {
    const sessions = all.filter((s) => sources.has(s.evidence?.source ?? ""));
    assert.equal(sessions.length, 5);
    // Summary groups the ledger by repository; Velocity by agent. Both cover every source's value.
    const summary = buildVelocity(sessions, { ...window, group: "repository", metric: "value" });
    const velocity = buildVelocity(sessions, { ...window, group: "agent", metric: "value" });
    const total = sessions.reduce((n, s) => n + s.cost.totalUsd, 0);
    close(summary.totals[0]!, total); close(velocity.totals[0]!, total);
    assert.deepEqual(summary.unledgered, { sessions: 0, value: 0 }); assert.equal(summary.missingSessions, 0);
    // Gemini's untimed message, the untimed Cursor SDK run and the receipt are labeled session-dated.
    const sessionDated = sessions.flatMap((s) => s.velocity?.sessionDated ?? []).reduce((n, cell) => n + cell[3][0], 0);
    close(summary.sessionDated[0]!, sessionDated); assert.equal(summary.sessionDatedSessions, 3);
    assert.equal(summary.evidence.unsupported, 0, "Cursor SDK value is priced evidence, not unsupported");
    // ledgerCells exposes the same cells to the Summary daily chart.
    close(sessions.flatMap((s) => ledgerCells(s.velocity)).reduce((n, cell) => n + (cell[3][0] ?? 0), 0), total);
  });
});

test("an old snapshot without a ledger is still disclosed, not silently dropped", () => {
  const session = { provider: "gemini", evidence: { source: "gemini-chat" }, cost: { totalUsd: 3 } } as unknown as SessionAnalytics;
  const data = buildVelocity([session], { ...window, metric: "value" });
  assert.deepEqual(data.unledgered, { sessions: 1, value: 3 }); assert.equal(data.totals[0], 0);
});

test("session-dated placement needs a valid absolute time; otherwise values stay undated", () => {
  const dimension = velocityDimension("gemini", {}, "top-level", "gemini-fixture", null);
  const values = zeroVelocity(); values[0] = 1.5;
  const withTime = new VelocityAccumulator(); withTime.add(null, dimension, values, "session");
  const placed = withTime.finish(day1, dimension, day2);
  assert.deepEqual(placed.sessionDated, [[local(day2).day, local(day2).hour, 0, [1.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]]);
  const withoutTime = new VelocityAccumulator(); withoutTime.add(null, dimension, values, "session");
  const undated = withoutTime.finish(day1, dimension, "2026-07-20 12:00");
  assert.equal(undated.sessionDated, undefined); assert.equal(undated.undated[0]![1][0], 1.5);
  // The default fallback keeps existing sources unchanged.
  const legacy = new VelocityAccumulator(); legacy.add(null, dimension, values);
  assert.equal(legacy.finish(day1, dimension, day2).sessionDated, undefined);
  const merged = addSessionDated(addSessionDated(placed, day2, dimension, values), null, dimension, values);
  assert.equal(merged.sessionDated![0]![3][0], 3); assert.equal(merged.undated[0]![1][0], 1.5);
});
