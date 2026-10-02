import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { analyzeRepositorySessions, discoverProviderRoots } from "../src/analyzer.ts";
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "./fixtures.ts";

const jsonl = (records: unknown[]): string => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

async function withFixture(
  prefix: string,
  run: (fixture: SessionAnalyticsFixture, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(await createSessionAnalyticsFixture(directory), directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function analyzeFixture(fixture: SessionAnalyticsFixture, overrides: { cursorDatabasePath?: string } = {}) {
  return analyzeRepositorySessions({
    pricingPolicy: "reviewed-only",
    claudeRoot: fixture.claudeRoot,
    codexArchiveRoot: fixture.codexArchiveRoot,
    codexRoot: fixture.codexRoot,
    cursorDatabasePath: overrides.cursorDatabasePath ?? fixture.cursorDatabasePath,
    databasePath: fixture.databasePath,
    repositoryRoot: fixture.repositoryRoot,
  });
}

test("prices the final streamed Claude snapshot, with thinking tokens and effort", async () => {
  await withFixture("session-analytics-claude-stream-", async (fixture) => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const usage = (output: number, thinking?: number) => ({
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000,
      input_tokens: 10,
      output_tokens: output,
      ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
    });
    const assistant = (uuid: string, output: number, thinking?: number) => ({
      cwd: fixture.repositoryRoot,
      effort: "xhigh",
      message: {
        content: [{ text: "streamed-content-is-not-returned", type: "text" }],
        id: "streamed-message",
        model: "claude-opus-5",
        role: "assistant",
        usage: usage(output, thinking),
      },
      sessionId,
      timestamp: `2026-07-21T09:00:0${uuid.length % 10}Z`,
      type: "assistant",
      uuid,
    });
    const directory = join(fixture.claudeRoot, "-fixture-streamed");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${sessionId}.jsonl`),
      jsonl([
        assistant("first", 4),
        assistant("second", 120),
        assistant("third", 900, 600),
      ]),
    );

    const result = await analyzeFixture(fixture);
    const session = result.sessions.find(({ firstEventAt }) => firstEventAt?.startsWith("2026-07-21"));
    assert.ok(session);
    assert.equal(session.metrics.assistantMessages, 1);
    assert.equal(session.metrics.modelCalls, 1);
    assert.equal(session.tokens.outputTokens, 900);
    assert.equal(session.tokens.reasoningOutputTokens, 600);
    assert.equal(session.tokens.nonReasoningOutputTokens, 300);
    assert.equal(session.tokens.cachedInputTokens, 1_000);
    assert.equal(session.effort, "xhigh");
    // claude-opus-5: $5/M input, $0.50/M cache read, $25/M output.
    assert.equal(Number(session.cost.totalUsd.toFixed(8)), Number(((10 * 5 + 1_000 * 0.5 + 900 * 25) / 1e6).toFixed(8)));
    assert.equal(session.transcript.warnings.some((warning) => warning.includes("thinking tokens")), false);
    assert.doesNotMatch(JSON.stringify(session), /streamed-content-is-not-returned/);
  });
});

test("keeps snapshot ownership, thinking detail, and top-level effort across main and subagent files", async () => {
  await withFixture("session-analytics-claude-owner-", async (fixture) => {
    const sessionId = "77777777-7777-4777-8777-777777777777";
    const record = (
      messageId: string,
      timestamp: string,
      effort: string,
      usage: Record<string, unknown> | null,
    ) => ({
      cwd: fixture.repositoryRoot,
      effort,
      message: { content: [], id: messageId, model: "claude-opus-5", role: "assistant", ...(usage ? { usage } : {}) },
      sessionId,
      timestamp,
      type: "assistant",
      uuid: `${messageId}-${timestamp}`,
    });
    const usage = (output: number, thinking?: number) => ({
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 10,
      output_tokens: output,
      ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
    });
    const directory = join(fixture.claudeRoot, "-fixture-owner");
    await mkdir(join(directory, sessionId, "subagents"), { recursive: true });
    await writeFile(
      join(directory, `${sessionId}.jsonl`),
      jsonl([
        // A usage-free main record must not keep ownership of a subagent's usage.
        record("shared-message", "2026-07-23T10:00:00Z", "high", null),
        // A tie without thinking detail must not erase the detailed snapshot.
        record("tie-message", "2026-07-23T10:01:00Z", "high", usage(900, 600)),
        record("tie-message", "2026-07-23T10:01:01Z", "high", usage(900)),
        record("late-message", "2026-07-23T10:05:00Z", "xhigh", usage(1)),
      ]),
    );
    await writeFile(
      join(directory, sessionId, "subagents", "agent-older.jsonl"),
      jsonl([
        record("shared-message", "2026-07-23T09:59:00Z", "low", usage(500)),
      ]),
    );

    const result = await analyzeFixture(fixture);
    const session = result.sessions.find(({ firstEventAt }) => firstEventAt === "2026-07-23T09:59:00Z");
    assert.ok(session);
    assert.equal(session.metrics.assistantMessages, 3);
    assert.equal(session.tokens.outputTokens, 1_401);
    assert.equal(session.tokens.reasoningOutputTokens, 600);
    assert.equal(session.effort, "xhigh");
    // claude-opus-5 output is $25/M: the subagent owns 500 output and 10 input.
    assert.equal(Number(session.costByExecution.subagentUsd.toFixed(8)), Number(((10 * 5 + 500 * 25) / 1e6).toFixed(8)));
    assert.equal(session.executionKind, "mixed");
  });
});

test("counts current-format Codex turns, messages, and compactions once", async () => {
  await withFixture("session-analytics-codex-items-", async (fixture) => {
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const item = (id: string, type: string, timestamp: string) => ({
      payload: { item: { content: [{ text: "item-content-is-not-returned" }], id, type }, type: "item_completed" },
      timestamp,
      type: "event_msg",
    });
    await writeFile(
      join(fixture.codexRoot, "2026/07/20", `rollout-2026-07-20T15-00-00-${sessionId}.jsonl`),
      jsonl([
        { payload: { cwd: fixture.repositoryRoot, id: sessionId }, timestamp: "2026-07-20T15:00:00Z", type: "session_meta" },
        { payload: { effort: "high", model: "gpt-5.6-sol" }, timestamp: "2026-07-20T15:00:01Z", type: "turn_context" },
        item("user-1", "UserMessage", "2026-07-20T15:00:02Z"),
        item("agent-1", "AgentMessage", "2026-07-20T15:00:03Z"),
        item("agent-1", "AgentMessage", "2026-07-20T15:00:03Z"),
        { payload: ["compaction-summary-is-not-returned"], timestamp: "2026-07-20T15:00:04Z", type: "compacted" },
        item("compaction-1", "ContextCompaction", "2026-07-20T15:00:04Z"),
        item("user-2", "UserMessage", "2026-07-20T15:00:05Z"),
        item("agent-2", "AgentMessage", "2026-07-20T15:00:06Z"),
        { payload: ["second-compaction"], timestamp: "2026-07-20T15:00:07Z", type: "compacted" },
      ]),
    );

    const result = await analyzeFixture(fixture);
    const session = result.sessions.find(({ firstEventAt }) => firstEventAt === "2026-07-20T15:00:00Z");
    assert.ok(session);
    assert.equal(session.metrics.userTurns, 2);
    assert.equal(session.metrics.assistantMessages, 2);
    assert.equal(session.metrics.compactions, 2);
    assert.doesNotMatch(JSON.stringify(session), /item-content-is-not-returned|compaction-summary-is-not-returned/);
  });
});

test("discovers every Claude and Codex profile once, following symbolic links", async () => {
  const home = await mkdtemp(join(tmpdir(), "session-analytics-home-"));
  try {
    await Promise.all([
      mkdir(join(home, ".claude", "projects"), { recursive: true }),
      mkdir(join(home, ".claude-work", "projects"), { recursive: true }),
      mkdir(join(home, ".claude-empty"), { recursive: true }),
      mkdir(join(home, "custom-claude", "projects"), { recursive: true }),
      mkdir(join(home, ".codex", "sessions"), { recursive: true }),
      mkdir(join(home, ".codex-personal", "archived_sessions"), { recursive: true }),
      mkdir(join(home, ".codexbar", "sessions"), { recursive: true }),
    ]);
    await symlink(join(home, ".codex"), join(home, ".codex-shared"));
    await symlink(join(home, ".claude"), join(home, ".claude-alias"));

    const roots = await discoverProviderRoots({
      claudeConfigDirectory: join(home, "custom-claude"),
      codexHome: undefined,
      home,
    });
    assert.deepEqual(roots.claude, [
      join(home, ".claude", "projects"),
      join(home, "custom-claude", "projects"),
      join(home, ".claude-work", "projects"),
    ]);
    assert.deepEqual(roots.codex, [
      join(home, ".codex", "sessions"),
      join(home, ".codex", "archived_sessions"),
      join(home, ".codex-personal", "archived_sessions"),
    ]);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("maps Cursor composers through the current composer headers table", async () => {
  await withFixture("session-analytics-cursor-headers-", async (fixture, directory) => {
    const userRoot = join(directory, "Cursor", "User");
    const workspaceId = "abc123def456";
    await mkdir(join(userRoot, "globalStorage"), { recursive: true });
    await mkdir(join(userRoot, "workspaceStorage", workspaceId), { recursive: true });
    await writeFile(
      join(userRoot, "workspaceStorage", workspaceId, "workspace.json"),
      JSON.stringify({ folder: `file://${fixture.repositoryRoot}` }),
    );
    const databasePath = join(userRoot, "globalStorage", "state.vscdb");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB);
      CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);
      CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);
    `);
    const created = Date.parse("2026-07-22T08:00:00Z");
    for (const [composerId, isSubagent] of [["cursor-header-top", 0], ["cursor-header-sub", 1]] as const) {
      database.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        `composerData:${composerId}`,
        JSON.stringify({
          composerId,
          conversation: [{ text: "cursor-header-content-is-not-returned", type: 1 }],
          createdAt: created,
          lastUpdatedAt: created + 60_000,
        }),
      );
      database
        .prepare("INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, value) VALUES (?, ?, ?, ?, ?, ?)")
        .run(composerId, workspaceId, created, created + 60_000, isSubagent, "{}");
    }
    database.close();

    const result = await analyzeFixture(fixture, { cursorDatabasePath: databasePath });
    const cursor = result.sessions.filter(({ firstEventAt, provider }) =>
      provider === "cursor" && firstEventAt?.startsWith("2026-07-22"));
    assert.equal(cursor.length, 2);
    assert.equal(cursor.every(({ repositoryName }) => repositoryName === "conductor"), true);
    assert.deepEqual(cursor.map(({ executionKind }) => executionKind).sort(), ["subagent", "top-level"]);
    assert.doesNotMatch(JSON.stringify(cursor), /cursor-header-content-is-not-returned/);
  });
});
