import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { analyzeMachineSessions as analyzeMachineSessionsRaw } from "../src/analyzer.ts";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { analyzeOptionsFrom } from "../src/options.ts";
import { copilotAdapter } from "../src/providers/copilot.ts";
import { cursorSdkAdapter } from "../src/providers/cursor-sdk.ts";
import { cursorTranscriptAdapter } from "../src/providers/cursor-transcript.ts";
import { geminiAdapter } from "../src/providers/gemini.ts";
import { opencodeAdapter } from "../src/providers/opencode.ts";
import { additionalProviderSessions } from "../src/providers/index.ts";
import { files, hash, tokens, zeroCost } from "../src/providers/common.ts";
import type { ProviderContext } from "../src/providers/adapter.ts";
import type { AnalyzeOptions, RateCard, SessionAnalytics } from "../src/types.ts";
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "./fixtures.ts";

// Every assembled provider fixture must survive the final public interchange contract.
async function analyzeMachineSessions(options: AnalyzeOptions) {
  return validateSnapshot(await analyzeMachineSessionsRaw(options));
}

const at = "2026-07-20T09:00:00.000Z", later = "2026-07-20T09:05:00.000Z";
const sentinel = "PRIVATE-CONTENT-SENTINEL /secret/path command --token=secret";
const sdkId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const cliId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
async function write(path: string, data: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); }
async function fixture(run: (root: string, fixture: SessionAnalyticsFixture) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "providers-test-"));
  try { await run(root, await createSessionAnalyticsFixture(root)); } finally { await rm(root, { recursive: true, force: true }); }
}
function legacyOptions(f: SessionAnalyticsFixture): AnalyzeOptions {
  return { noIndex: true, additionalProviders: false, pricingPolicy: "reviewed-only", claudeRoot: f.claudeRoot, codexRoot: f.codexRoot, codexArchiveRoot: f.codexArchiveRoot, cursorDatabasePath: f.cursorDatabasePath, databasePath: f.databasePath };
}
function privateOutput(value: unknown, root: string): void {
  const serialized = JSON.stringify(value);
  for (const secret of [sentinel, "PRIVATE-CONTENT-SENTINEL", root, sdkId, cliId, "raw-result-id", "raw-message-id", "raw-provider-id", "secret-title", "secret-branch"]) assert.ok(!serialized.includes(secret), `Leaked ${secret === root ? "fixture root" : secret}`);
  assert.doesNotMatch(serialized, /NaN|Infinity/);
}
function context(): ProviderContext {
  const rateCard: RateCard = { currency: "USD", effectiveDate: "2026-07-20", models: {} };
  return { repository: { id: "synthetic-repository", name: "Example" }, rateCard, price: () => zeroCost() };
}

test("Claude adapter migration preserves legacy fields as the session projection grows", async () => {
  await fixture(async (_root, f) => {
    const data = await analyzeMachineSessions(legacyOptions(f));
    const actual = data.sessions.map((s) => ({ ...s, repositoryId: s.repositoryName })).sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
    const expected = JSON.parse(await readFile(new URL("./provider-fixtures/legacy-sessions.json", import.meta.url), "utf8"));
    // Skills analysis was removed; the fixture predates that and still records the fields.
    for (const session of expected) { delete session.skills; delete session.skillEvidence; }
    // Limits/cache replaces the legacy ratio-of-maxima with per-request context evidence.
    for (const session of expected) if (session.provider === "claude") {
      session.tokens.nonReasoningOutputTokens = 0;
      for (const model of session.models) model.nonReasoningOutputTokens = 0;
      session.metrics.contextUtilizationPeak = 0.0006;
      session.metrics.maxContextWindow = 1_000_000;
      session.metrics.maxInputTokensPerCall = 600;
      if (session.firstEventAt) session.firstEventAt = new Date(session.firstEventAt).toISOString();
      if (session.lastEventAt) session.lastEventAt = new Date(session.lastEventAt).toISOString();
    }
    for (const session of expected) if (session.provider === "codex" && session.metrics.modelCalls === 1) session.metrics.maxInputTokensPerCall = 100;
    // Interchange normalizes database and provider dates to UTC instants.
    for (const session of expected) for (const key of ["createdAt", "updatedAt", "firstEventAt", "lastEventAt"]) if (session[key]) session[key] = new Date(session[key]).toISOString();
    // Other integrated lanes add optional namespaces; the original fixture remains the
    // accounting regression oracle for every field it defined.
    const legacyFields = (value: any, shape: any): any => Array.isArray(shape)
      ? shape.map((item, index) => legacyFields(value[index], item))
      : shape && typeof shape === "object"
        ? Object.fromEntries(Object.entries(shape).map(([key, item]) => [key, legacyFields(value[key], item)]))
        : value;
    assert.deepEqual(legacyFields(actual, expected), expected);
  });
});

test("Conductor recovers deduplicated result-only sessions and never adds fallback to canonical evidence", async () => {
  await fixture(async (root, f) => {
    const db = new DatabaseSync(f.databasePath);
    db.exec("CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT, full_message TEXT, created_at TEXT)");
    const original = db.prepare("SELECT id, workspace_id, claude_session_id FROM sessions WHERE agent_type = 'claude' LIMIT 1").get()!;
    db.prepare("INSERT INTO sessions (id, status, agent_type, title, created_at, updated_at, claude_session_id, model, workspace_id) VALUES (?,?,?,?,?,?,?,?,?)").run("missing-transcript", sentinel, "claude", "secret-title", at, later, "raw-provider-id", "claude-opus-5", original["workspace_id"]!);
    const result = { type: "result", uuid: "raw-result-id", session_id: "raw-provider-id", result: sentinel, total_cost_usd: 2,
      usage: { input_tokens: 999999, output_tokens: 999999 },
      modelUsage: { "claude-opus-5": { inputTokens: 100, cacheReadInputTokens: 40, cacheCreationInputTokens: 20, outputTokens: 30, costUSD: 2, content: sentinel } },
      num_turns: 3, duration_ms: 1234, duration_api_ms: 1000, permission_denials: [{ tool_name: sentinel, tool_input: { command: sentinel } }], is_error: true, terminal_reason: sentinel };
    const insert = db.prepare("INSERT INTO session_messages VALUES (?,?,?,?,?)");
    insert.run("raw-message-id", "missing-transcript", JSON.stringify(result), JSON.stringify(result), at);
    insert.run("duplicate", "missing-transcript", JSON.stringify(result), null, later);
    insert.run("canonical-result", original["id"]!, JSON.stringify({ ...result, session_id: original["claude_session_id"] }), null, at);
    insert.run("not-result", "missing-transcript", JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 99999 }, content: sentinel } }), null, at);
    db.close();
    const snapshot = await analyzeMachineSessions(legacyOptions(f));
    const recovered = snapshot.sessions.filter((s) => s.evidence?.source === "conductor-result");
    assert.equal(recovered.length, 1);
    const s = recovered[0]!;
    assert.equal(s.status, "unknown");
    assert.equal(s.costBasis, "provider-reported");
    assert.equal(s.cost.totalUsd, 2);
    assert.equal(s.pricedTokenCoverage, null);
    assert.equal(s.tokens.inputTokens, 160);
    assert.equal(s.tokens.outputTokens, 30);
    assert.equal(s.metrics.userTurns, 0);
    assert.equal(s.metrics.modelCalls, 0);
    assert.deepEqual(s.tools, {}); assert.deepEqual(s.spendByDay, {});
    assert.deepEqual(s.conductor, { resultRecords: 1, reportedTurns: 3, durationMilliseconds: 1234, apiDurationMilliseconds: 1000, permissionDenials: 1, errorResults: 1, terminalReasons: { unknown: 1 }, turnLocalTokens: tokens(999999, 0, 0, 999999) });
    const manifest = await readFile(new URL("../docs/privacy.md", import.meta.url), "utf8");
    for (const [namespace, value] of [["evidence", s.evidence], ["conductor", s.conductor]] as const) {
      for (const key of Object.keys(value!)) assert.ok(manifest.includes(`\`${namespace}.${key}\``), `Undocumented public field ${namespace}.${key}`);
    }
    assert.equal(snapshot.summary.sessions, 6);
    assert.equal(snapshot.summary.providerReportedSpendUsd, 3.48);
    privateOutput(snapshot, root);
  });
});

test("Conductor cost-only model allocations retain available top-level usage", async () => {
  await fixture(async (root, f) => {
    const db = new DatabaseSync(f.databasePath);
    db.exec("CREATE TABLE session_messages (id TEXT, session_id TEXT, content TEXT)");
    const original = db.prepare("SELECT workspace_id FROM sessions LIMIT 1").get()!;
    db.prepare("INSERT INTO sessions (id, agent_type, status, created_at, updated_at, workspace_id, claude_session_id) VALUES (?,?,?,?,?,?,?)").run("cost-only-model", "claude", "completed", at, later, original["workspace_id"]!, "raw-provider-id");
    db.prepare("INSERT INTO session_messages VALUES (?,?,?)").run("raw-message-id", "cost-only-model", JSON.stringify({
      type: "result", uuid: "raw-result-id", session_id: "raw-provider-id", result: sentinel, total_cost_usd: 3,
      modelUsage: { "claude-opus-5": { costUSD: 3 } }, usage: { input_tokens: 23, output_tokens: 7 },
    }));
    db.close();
    const result = await analyzeMachineSessions(legacyOptions(f));
    const session = result.sessions.find((s) => s.evidence?.source === "conductor-result")!;
    assert.equal(session.tokens.inputTokens, 23); assert.equal(session.tokens.outputTokens, 7);
    assert.equal(session.models[0]!.inputTokens, 0); assert.equal(session.cost.totalUsd, 3);
    assert.equal(session.evidence!.tokens, "reported"); assert.equal(session.pricedTokenCoverage, null);
    privateOutput(result, root);
  });
});

test("Conductor supports old schemas, zero reported cost, absent counters, and legacy rows without provider IDs", async () => {
  await fixture(async (root, f) => {
    const db = new DatabaseSync(f.databasePath);
    db.exec("CREATE TABLE session_messages (id TEXT, session_id TEXT, content TEXT)");
    const original = db.prepare("SELECT id, workspace_id FROM sessions LIMIT 1").get()!;
    const insertSession = db.prepare("INSERT INTO sessions (id, agent_type, status, created_at, updated_at, workspace_id, claude_session_id) VALUES (?,?,?,?,?,?,NULL)");
    insertSession.run("legacy-summary", "claude", "completed", "2020-01-01T00:00:00Z", "2020-01-01T00:01:00Z", original["workspace_id"]!);
    insertSession.run("duplicate-summary", "claude", "completed", "2020-01-02T00:00:00Z", "2020-01-02T00:01:00Z", original["workspace_id"]!);
    const result = JSON.stringify({ type: "result", uuid: "raw-result-id", session_id: "raw-provider-id", total_cost_usd: 0, subtype: "success", result: sentinel });
    db.prepare("INSERT INTO session_messages VALUES (?,?,?)").run("one", "legacy-summary", result);
    db.prepare("INSERT INTO session_messages VALUES (?,?,?)").run("two", "duplicate-summary", result);
    db.close();
    const snapshot = await analyzeMachineSessions(legacyOptions(f));
    const recovered = snapshot.sessions.filter((s) => s.evidence?.source === "conductor-result");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.costBasis, "provider-reported");
    assert.equal(recovered[0]!.costComplete, true);
    assert.equal(recovered[0]!.conductor!.permissionDenials, null);
    assert.equal(recovered[0]!.conductor!.reportedTurns, null);
    assert.equal(recovered[0]!.evidence!.tokens, "unavailable");
    privateOutput(snapshot, root);
  });
});

async function sdkFixture(root: string, cwd: string): Promise<string> {
  const store = join(root, "sdk"), dir = join(store, "synthetic-agent");
  const agent = { agentId: sdkId, cwd, name: sentinel, sdkMetadata: { blobEncryptionKey: sentinel }, createdAt: at, updatedAt: later };
  await write(join(dir, "agents.ndjson"), jsonl([agent, agent]));
  const run = { agentId: sdkId, runId: "private-run-id", requestId: sentinel, model: { id: "claude-opus-5", params: sentinel }, status: "finished", startedAt: at, endedAt: later,
    usage: { inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 20, outputTokens: 30, reasoningTokens: 10, totalTokens: 190 }, result: sentinel, error: sentinel };
  await write(join(dir, "runs.ndjson"), jsonl([{ ...run, usage: null, status: "queued" }, run, run]));
  const event = (status: string, call = "raw-call-id") => ({ eventType: "run_stream_event", payload: { type: "sdk_message", message: { type: "tool_call", agent_id: sdkId, run_id: "private-run-id", call_id: call, name: "read_file", status, args: { path: sentinel }, result: sentinel } } });
  await write(join(dir, "run_events.ndjson"), jsonl([event("started"), event("completed"), event("completed"), event("completed", "second-call")]));
  return store;
}

test("Cursor SDK prices disjoint token classes once per run and suppresses activity-only copies", async () => {
  await fixture(async (root, f) => {
    const cursorSdkRoot = await sdkFixture(root, f.repositoryRoot);
    const cursorTranscriptRoot = join(root, "cursor-projects");
    const project = f.repositoryRoot.replace(/^\//, "").replace(/[^A-Za-z0-9]/g, "-");
    const rows = [{ role: "user", message: { content: [{ type: "text", text: sentinel }] } }, { role: "assistant", message: { content: [{ type: "tool_use", id: "raw-call-id", name: "Read", input: { path: sentinel } }] } }];
    for (const id of [sdkId, cliId]) {
      const path = join(cursorTranscriptRoot, project, "agent-transcripts", id, `${id}.jsonl`);
      await write(path, jsonl([...rows, rows[1]])); await utimes(path, new Date(at), new Date(at));
    }
    const snapshot = await analyzeMachineSessions({ ...legacyOptions(f), cursorSdkRoot, cursorTranscriptRoot });
    const sdk = snapshot.sessions.find((s) => s.evidence?.source === "cursor-sdk")!;
    assert.ok(sdk); assert.equal(sdk.tokens.inputTokens, 160); assert.equal(sdk.tokens.reasoningOutputTokens, 10);
    assert.equal(sdk.costBasis, "api-list-price-equivalent");
    assert.equal(sdk.cost.totalUsd, 0.001395);
    assert.equal(sdk.metrics.modelCalls, 0); assert.equal(sdk.metrics.userTurns, 1);
    assert.deepEqual(sdk.tools, { read_file: 2 }); assert.deepEqual(sdk.spendByDay, { "2026-07-20": 0.001395 });
    const cli = snapshot.sessions.filter((s) => s.evidence?.source === "cursor-transcript");
    assert.equal(cli.length, 1); assert.equal(cli[0]!.createdAt, at);
    assert.equal(cli[0]!.evidence!.timing, "file-mtime"); assert.equal(cli[0]!.firstEventAt, null);
    assert.equal(cli[0]!.metrics.durationMilliseconds, 0); assert.equal(cli[0]!.metrics.userTurns, 1);
    assert.equal(cli[0]!.repositoryId, sdk.repositoryId); assert.equal(cli[0]!.costBasis, "unavailable");
    assert.deepEqual(cli[0]!.tools, { Read: 1 });
    privateOutput(snapshot, root);
  });
});

test("Cursor SDK keeps run evidence when tool events are gone, and stays unpriced for unknown models", async () => {
  await fixture(async (root, f) => {
    const store = await sdkFixture(root, f.repositoryRoot);
    await rm(join(store, "synthetic-agent", "run_events.ndjson"));
    const path = join(store, "synthetic-agent", "runs.ndjson");
    await writeFile(path, (await readFile(path, "utf8")).replaceAll("claude-opus-5", "unknown-reviewed-model"));
    const result = await analyzeMachineSessions({ ...legacyOptions(f), cursorSdkRoot: store });
    const session = result.sessions.find((s) => s.evidence?.source === "cursor-sdk")!;
    assert.equal(session.evidence!.tools, "unavailable"); assert.equal(session.cost.totalUsd, 0);
    assert.equal(session.pricedTokenCoverage, 0); assert.equal(session.costComplete, false);
    privateOutput(result, root);
  });
});

async function openCodeFixture(path: string, cwd: string): Promise<void> {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT DEFAULT 'assistant-id', time_created INTEGER DEFAULT 1784538000000, data TEXT)");
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("opencode-session-id", "parent-private-id", cwd, Date.parse(at), Date.parse(later));
  db.prepare("INSERT INTO message VALUES (?,?,?)").run("user-id", "opencode-session-id", JSON.stringify({ role: "user", time: { created: Date.parse(at) }, content: sentinel }));
  db.prepare("INSERT INTO message VALUES (?,?,?)").run("assistant-id", "opencode-session-id", JSON.stringify({ role: "assistant", modelID: "claude-opus-5", time: { created: Date.parse(at), completed: Date.parse(later) }, tokens: { input: 100, cache: { read: 40, write: 20 }, output: 30, reasoning: 10 }, cost: 999, content: sentinel, error: { message: sentinel } }));
  const insert = db.prepare("INSERT INTO part (id, session_id, data) VALUES (?,?,?)");
  for (const id of ["part-a", "part-b"]) insert.run(id, "opencode-session-id", JSON.stringify({ type: "tool", tool: "read", callID: "private-call-id", state: { input: sentinel, output: sentinel } }));
  insert.run("step", "opencode-session-id", JSON.stringify({ type: "step-finish", tokens: { input: 100, output: 30, reasoning: 10, cache: { read: 40, write: 20 } }, cost: 999 }));
  insert.run("compact", "opencode-session-id", JSON.stringify({ type: "compaction", content: sentinel }));
  db.close();
}

test("OpenCode reads the verified SQLite layout read-only without double-counting step summaries", async () => {
  await fixture(async (root, f) => {
    const path = join(root, "opencode.db"); await openCodeFixture(path, f.repositoryRoot);
    const before = await readFile(path);
    const result = await analyzeMachineSessions({ ...legacyOptions(f), opencodeDatabasePath: path });
    const s = result.sessions.find((s) => s.provider === "opencode")!;
    assert.equal(s.tokens.inputTokens, 160); assert.equal(s.cost.totalUsd, 0.001395);
    assert.equal(s.metrics.modelCalls, 1); assert.equal(s.metrics.compactions, 1); assert.equal(s.metrics.userTurns, 1);
    assert.equal(s.executionKind, "subagent"); assert.deepEqual(s.tools, { read: 1 });
    assert.deepEqual(s.spendByDay, { "2026-07-20": 0.001395 });
    assert.deepEqual(await readFile(path), before);
    privateOutput(result, root);
  });
});

test("OpenCode retains every request when one assistant message has multiple steps", async () => {
  await fixture(async (root, f) => {
    const path = join(root, "opencode.db"); await openCodeFixture(path, f.repositoryRoot);
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO part (id,session_id,data) VALUES (?,?,?)").run("second-step", "opencode-session-id", JSON.stringify({ type: "step-finish", tokens: { input: 300, output: 90, reasoning: 30, cache: { read: 120, write: 60 } } }));
    db.close();
    const result = await analyzeMachineSessions({ ...legacyOptions(f), opencodeDatabasePath: path });
    const s = result.sessions.find((s) => s.provider === "opencode")!;
    assert.equal(s.tokens.inputTokens, 640); assert.equal(s.tokens.outputTokens, 120); assert.equal(s.metrics.modelCalls, 2);
    assert.equal(s.metrics.assistantMessages, 1);
  });
});

test("run summaries bound long-context pricing without mistaking aggregate input for one request", async () => {
  await fixture(async (root, f) => {
    const store = await sdkFixture(root, f.repositoryRoot);
    const rates = join(root, "rates.json");
    await writeFile(rates, JSON.stringify({ currency: "USD", effectiveDate: "2026-07-20", models: { "claude-opus-5": { provider: "claude", inputPerMillion: 1, cacheReadPerMillion: 0.1, cacheWrite5mPerMillion: 1.25, outputPerMillion: 2, longContext: { thresholdInputTokens: 50, inputMultiplier: 2, outputMultiplier: 1.5 }, source: "https://example.invalid/synthetic" } } }));
    const result = await analyzeMachineSessions({ ...legacyOptions(f), cursorSdkRoot: store, rateCardPath: rates });
    const s = result.sessions.find((s) => s.evidence?.source === "cursor-sdk")!;
    assert.equal(s.cost.totalUsd, 0.000189);
    assert.ok(Math.abs(s.cost.upperEstimateUsd - 0.000348) < 1e-12);
    assert.equal(s.metrics.maxInputTokensPerCall, 0);
    assert.deepEqual(s.spendByDay, { "2026-07-20": 0.000189 });
  });
});

test("Copilot counts only persisted activity, validates identity, and never interprets credits as dollars", async () => {
  await fixture(async (root, f) => {
    const store = join(root, "copilot"), path = join(store, "copilot-session-id", "events.jsonl");
    const event = (type: string, id: string, data: object) => ({ id, type, timestamp: at, data });
    const events = [
      event("session.start", "start", { sessionId: "copilot-session-id", startTime: at, context: { cwd: f.repositoryRoot, branch: "secret-branch" } }),
      event("user.message", "user", { content: sentinel }), event("assistant.message", "assistant", { messageId: "raw-message-id", content: sentinel }),
      event("tool.execution_start", "tool-1", { toolCallId: "call", toolName: "read_file", arguments: sentinel }),
      event("tool.execution_start", "tool-2", { toolCallId: "call", toolName: "read_file", arguments: sentinel }),
      event("assistant.usage", "usage", { inputTokens: 999, cost: 10, credits: 100, model: sentinel }),
      event("session.compaction_complete", "compaction", { success: true, summaryContent: sentinel }),
      event("session.shutdown", "shutdown", { modelMetrics: {}, totalPremiumRequests: 100, totalNanoAiu: 999, codeChanges: { filesModified: [sentinel] } }),
    ];
    await write(path, jsonl([...events, ...events]) + "{truncated");
    await write(join(store, "wrong-directory", "events.jsonl"), jsonl(events));
    const result = await analyzeMachineSessions({ ...legacyOptions(f), copilotRoot: store });
    const sessions = result.sessions.filter((s) => s.provider === "copilot"); assert.equal(sessions.length, 1);
    const s = sessions[0]!;
    assert.equal(s.metrics.userTurns, 1); assert.equal(s.metrics.assistantMessages, 1); assert.equal(s.metrics.compactions, 1);
    assert.deepEqual(s.tools, { read_file: 1 }); assert.equal(s.costBasis, "unavailable");
    assert.equal(s.pricedTokenCoverage, null); assert.equal(s.evidence!.tokens, "unavailable");
    privateOutput(result, root);
    const missing = join(root, "absent-store");
    const report = spawnSync(process.execPath, ["bin/session-analytics.ts", "report", "--no-remote", "--no-index", "--no-additional-providers", "--claude-root", missing, "--codex-root", missing, "--codex-archive-root", missing, "--cursor-database", missing, "--database", missing, "--copilot-root", store], { encoding: "utf8", timeout: 20000 });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /Evidence: 0\/1 summary-only, 1\/1 activity-only/);
    assert.match(report.stdout, /Cache reads: N\/A;/);
    assert.match(report.stdout, /Priced usage value: N\/A/);
    assert.match(report.stdout, /Tokens: N\/A input, N\/A output/);
    assert.doesNotMatch(report.stdout, /\$0\.00|Session [a-f0-9]{12}/);
    privateOutput(report.stdout, root);
  });
});

test("Gemini supports JSON and JSONL, registry mapping, thought tokens, checkpoints, and rewinds", async () => {
  await fixture(async (root, f) => {
    const store = join(root, "gemini", "tmp"), project = createHash("sha256").update(f.repositoryRoot).digest("hex");
    await write(join(dirname(store), "projects.json"), JSON.stringify({ projects: { [f.repositoryRoot]: "example" } }));
    const user = { id: "user", type: "user", timestamp: at, content: sentinel };
    const assistant = { id: "assistant", type: "gemini", timestamp: later, model: "gemini-fixture", tokens: { input: 100, cached: 40, output: 30, thoughts: 5, total: 135 }, content: sentinel, thoughts: [{ text: sentinel }], toolCalls: [{ id: "tool", name: "read_file", args: sentinel, result: sentinel }] };
    const metadata = { sessionId: "gemini-json", projectHash: project, startTime: at, lastUpdated: later, summary: sentinel, kind: "main" };
    await write(join(store, "example", "chats", "session-a.json"), JSON.stringify({ ...metadata, messages: [user, assistant, assistant] }));
    await write(join(store, "example", "chats", "session-b.jsonl"), jsonl([
      { ...metadata, sessionId: "gemini-jsonl" }, user, assistant,
      { ...assistant, id: "rewound", tokens: { input: 99999, output: 99999 } }, { $rewindTo: "rewound" },
      { $patch: { id: "assistant", content: sentinel, toolCalls: [{ id: "tool", result: sentinel }] } },
      { $set: { lastUpdated: later } },
    ]));
    const ratePath = join(root, "rates.json");
    await writeFile(ratePath, JSON.stringify({ currency: "USD", effectiveDate: "2026-07-20", models: { "gemini-fixture": { provider: "gemini", inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 2, source: "https://example.invalid/synthetic-rate" } } }));
    const result = await analyzeMachineSessions({ ...legacyOptions(f), geminiRoot: store, rateCardPath: ratePath });
    const sessions = result.sessions.filter((s) => s.provider === "gemini"); assert.equal(sessions.length, 2);
    for (const s of sessions) {
      assert.equal(s.repositoryName, "conductor"); assert.equal(s.tokens.inputTokens, 100);
      assert.equal(s.tokens.outputTokens, 35); assert.equal(s.tokens.reasoningOutputTokens, 5);
      assert.equal(s.metrics.userTurns, 1); assert.equal(s.metrics.modelCalls, 1);
      assert.deepEqual(s.tools, { read_file: 1 }); assert.equal(s.pricedTokenCoverage, 1);
    }
    privateOutput(result, root);
  });
});

test("provider root discovery and CLI settings are explicit, isolated, and honor XDG for OpenCode", async () => {
  const environment = { home: "/synthetic/home", options: {}, environment: { XDG_DATA_HOME: "/synthetic/data" } };
  assert.deepEqual(await copilotAdapter.discoverRoots(environment), ["/synthetic/home/.copilot/session-state"]);
  assert.deepEqual(await opencodeAdapter.discoverRoots(environment), ["/synthetic/data/opencode/opencode.db"]);
  assert.deepEqual(await geminiAdapter().discoverRoots(environment), ["/synthetic/home/.gemini/tmp"]);
  assert.deepEqual(await cursorTranscriptAdapter().discoverRoots(environment), ["/synthetic/home/.cursor/projects"]);
  assert.deepEqual(await cursorSdkAdapter.discoverRoots(environment), ["/synthetic/home/Library/Application Support/com.conductor.app/cursor-sdk-store"]);
  const options = analyzeOptionsFrom(["--copilot-root", "/explicit/copilot", "--no-additional-providers"], { SESSION_ANALYTICS_COPILOT_ROOT: "/ignored", SESSION_ANALYTICS_GEMINI_ROOT: "/explicit/gemini" });
  assert.equal(options.copilotRoot, "/explicit/copilot"); assert.equal(options.geminiRoot, "/explicit/gemini"); assert.equal(options.additionalProviders, false);
});

test("unassigned Gemini projects remain pseudonymous and unknown models remain unpriced", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-unassigned-"));
  try {
    const project = "c".repeat(64), store = join(root, "tmp");
    await write(join(store, project, "chats", "session-test.json"), JSON.stringify({ sessionId: "private-gemini-id", projectHash: project, startTime: at, lastUpdated: later, messages: [{ type: "gemini", id: "response", model: "unknown-model", timestamp: later, content: sentinel, tokens: { input: 100, output: 20 } }] }));
    const result = await additionalProviderSessions({ home: root, options: { noIndex: true, additionalProviders: false, geminiRoot: store }, environment: {}, knownPaths: [], existingSessions: [], pricing: context(), repositoryForSession: async (identity) => {
      assert.equal(identity.cwd, null); return { id: hash(identity.group!), name: "Gemini · unassigned" };
    } });
    assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0]!.pricedTokenCoverage, 0);
    privateOutput(result.sessions, root); assert.ok(!JSON.stringify(result.sessions).includes(project));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dashboard covers every provider and keeps unavailable evidence out of coverage numerators", async () => {
  const client = await import(new URL("../src/public/providers.js", import.meta.url).href);
  assert.deepEqual(client.providerIds, ["codex", "claude", "cursor", "copilot", "opencode", "gemini", "unsupported"]);
  const sample = (provider: string, evidence: object, spendByDay = {}) => ({ provider, evidence, tokens: { inputTokens: 0, outputTokens: 0 }, spendByDay });
  const sessions = [
    sample("claude", { source: "conductor-result", fidelity: "summary", tokens: "reported", tools: "unavailable", timing: "provider" }),
    sample("cursor", { source: "cursor-transcript", fidelity: "activity-only", tokens: "unavailable", tools: "observed", timing: "file-mtime" }),
    sample("gemini", { source: "gemini-chat", fidelity: "message", tokens: "reported", tools: "observed", timing: "provider" }, { "2026-07-20": 2 }),
    sample("opencode", { source: "opencode-db", fidelity: "message", tokens: "reported", tools: "observed", timing: "provider" }, { "2026-07-20": 1 }),
  ];
  const rows = client.providerEvidenceRows(sessions);
  assert.equal(rows.find((r: { provider: string }) => r.provider === "claude").toolSessions, 0);
  assert.equal(rows.find((r: { provider: string }) => r.provider === "cursor").tokenSessions, 0);
  assert.equal(rows.find((r: { provider: string }) => r.provider === "cursor").fileTimes, 1);
  assert.deepEqual(client.dailySpendByProvider(sessions, "2026-07-20", "2026-07-20"), [{ name: "2026-07-20", codex: 0, claude: 0, cursor: 0, copilot: 0, opencode: 1, gemini: 2, unsupported: 0 }]);
});

test("bad stores are isolated and symbolic-link children are not traversed", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-bad-store-"));
  try {
    await mkdir(join(root, "data")); await writeFile(join(root, "data", "file.jsonl"), "{}");
    await symlink(root, join(root, "data", "cycle"));
    const found: string[] = [];
    for await (const file of files(join(root, "data"), (p) => p.endsWith(".jsonl"))) found.push(file);
    assert.equal(found.length, 1);
    const bad = join(root, "bad.db"); await writeFile(bad, sentinel);
    const result = await additionalProviderSessions({ home: root, options: { noIndex: true, additionalProviders: false, opencodeDatabasePath: bad }, environment: {}, knownPaths: [], existingSessions: [], pricing: context(), repositoryForSession: async () => context().repository });
    assert.equal(result.sessions.length, 0); assert.equal(result.warnings.length, 1); privateOutput(result, root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("token normalization rejects non-finite and negative counters and keeps reasoning within output", () => {
  const normalized = tokens(-1, Infinity, NaN, 5, 99);
  assert.equal(normalized.inputTokens, 0); assert.equal(normalized.outputTokens, 5); assert.equal(normalized.reasoningOutputTokens, 5);
  assert.equal(normalized.nonReasoningOutputTokens, 0);
});

test("isolated JSON report includes new evidence without exposing content", async () => {
  await fixture(async (root, f) => {
    const sdk = await sdkFixture(root, f.repositoryRoot);
    const child = spawnSync(process.execPath, ["bin/session-analytics.ts", "report", "--no-remote", "--json", "--no-index", "--no-additional-providers", "--claude-root", f.claudeRoot, "--codex-root", f.codexRoot, "--codex-archive-root", f.codexArchiveRoot, "--cursor-database", f.cursorDatabasePath, "--database", f.databasePath, "--cursor-sdk-root", sdk], { encoding: "utf8", timeout: 20000 });
    assert.equal(child.status, 0, child.stderr);
    const snapshot = JSON.parse(child.stdout) as { sessions: SessionAnalytics[] };
    assert.ok(snapshot.sessions.some((s) => s.sessionKey === hash(`cursor:${sdkId}`)));
    privateOutput(snapshot, root);
  });
});
