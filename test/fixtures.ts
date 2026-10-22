import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AnalyzeOptions } from "../src/types.ts";

/** Small cross-provider encoding fixture; every source root is synthetic. */
export async function createProviderJsonlFixture(root: string): Promise<{ options: AnalyzeOptions; paths: string[] }> {
  const at = "2026-07-20T09:00:00.000Z", content = "PRIVATE-JSONL-ENCODING-雪﻿";
  const claudeId = "55555555-5555-4555-8555-555555555555", codexId = "66666666-6666-4666-8666-666666666666";
  const cursorId = "77777777-7777-4777-8777-777777777777";
  const options: AnalyzeOptions = {
    noIndex: true, additionalProviders: false, offline: true, pricingPolicy: "reviewed-only", dataDir: join(root, "index"),
    claudeRoot: join(root, "claude"), codexRoot: join(root, "codex"), codexArchiveRoot: join(root, "archive"),
    databasePath: join(root, "absent-conductor.db"), cursorDatabasePath: join(root, "absent-cursor.db"),
    cursorSdkRoot: join(root, "cursor-sdk"), cursorTranscriptRoot: join(root, "cursor-transcript"),
    copilotRoot: join(root, "copilot"), geminiRoot: join(root, "gemini"),
    opencodeDatabasePath: join(root, "absent-opencode.db"), antigravityRoot: join(root, "absent-antigravity"),
  };
  const usage = { input_tokens: 100, output_tokens: 20 };
  const sources: Array<[string, object[]]> = [
    [join(options.claudeRoot!, `${claudeId}.jsonl`), [
      { type: "user", sessionId: claudeId, cwd: root, timestamp: at, message: { content } },
      { type: "assistant", timestamp: at, message: { id: "encoding-response", model: "claude-opus-5", usage, content: [] } },
      { type: "assistant", timestamp: at, message: { id: "encoding-response", model: "claude-opus-5", usage: { ...usage, output_tokens: 40 }, content: [] } },
    ]],
    [join(options.codexRoot!, `${codexId}.jsonl`), [
      { type: "session_meta", timestamp: at, payload: { id: codexId, cwd: root, source: "cli", instructions: content } },
      { type: "turn_context", timestamp: at, payload: { model: "gpt-5.4" } },
      { type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } },
    ]],
    [join(options.cursorSdkRoot!, "store", "agents.ndjson"), [
      { agentId: "encoding-agent", cwd: root, createdAt: at, updatedAt: at, prompt: content },
    ]],
    [join(options.cursorSdkRoot!, "store", "runs.ndjson"), [
      { agentId: "encoding-agent", runId: "encoding-run", model: { id: "claude-opus-5" }, createdAt: at, startedAt: at, endedAt: at, updatedAt: at, status: "finished", usage: { inputTokens: 70, outputTokens: 10 } },
    ]],
    [join(options.cursorSdkRoot!, "store", "run_events.ndjson"), [
      { createdAt: at, payload: { type: "sdk_message", message: { type: "tool_call", agent_id: "encoding-agent", run_id: "encoding-run", call_id: "encoding-call", name: "read_file", arguments: content } } },
    ]],
    [join(options.cursorTranscriptRoot!, "project", "agent-transcripts", `${cursorId}.jsonl`), [
      { role: "user", message: { content } },
      { role: "assistant", message: { content: [{ type: "tool_use", id: "encoding-tool", name: "Read", input: content }] } },
    ]],
    [join(options.copilotRoot!, "encoding-copilot", "events.jsonl"), [
      { id: "encoding-start", type: "session.start", timestamp: at, data: { sessionId: "encoding-copilot", context: { cwd: root } } },
      { id: "encoding-user", type: "user.message", timestamp: at, data: { content } },
    ]],
    [join(options.geminiRoot!, "project", "chats", "session-encoding.jsonl"), [
      { sessionId: "encoding-gemini", projectHash: "project", startTime: at, lastUpdated: at },
      { id: "encoding-message", type: "gemini", timestamp: at, model: "unreviewed-model", tokens: { input: 30, output: 5 }, content },
    ]],
  ];
  for (const [path, rows] of sources) {
    await mkdir(join(path, ".."), { recursive: true });
    // CRLF and a complete final record without LF are both valid JSONL framing.
    await writeFile(path, rows.map(row => JSON.stringify(row)).join("\r\n"));
  }
  return { options, paths: sources.map(([path]) => path) };
}

export interface SessionAnalyticsFixture {
  additionalProviders: false;
  noIndex: true;
  dataDir: string;
  claudeRoot: string;
  codexArchiveRoot: string;
  codexRoot: string;
  cursorDatabasePath: string;
  databasePath: string;
  remote: string;
  repositoryRoot: string;
}

const repositoryId = "repository-1";
const codexWorkspace = "/fixtures/workspaces/conductor/codex-workspace";
const claudeWorkspace = "/fixtures/workspaces/conductor/claude-workspace";
const codexSessionId = "11111111-1111-4111-8111-111111111111";
const claudeSessionId = "22222222-2222-4222-8222-222222222222";

export async function createSessionAnalyticsFixture(
  root: string,
  claudeModel = "claude-opus-5",
): Promise<SessionAnalyticsFixture> {
  const databasePath = join(root, "conductor.db");
  const cursorDatabasePath = join(root, "cursor.db");
  const codexRoot = join(root, "codex");
  const codexArchiveRoot = join(root, "codex-archive");
  const claudeRoot = join(root, "claude");
  const repositoryRoot = join(root, "repository");
  const remote = "https://github.com/example/conductor.git";
  await Promise.all([
    mkdir(join(codexRoot, "2026/07/20"), { recursive: true }),
    mkdir(codexArchiveRoot, { recursive: true }),
    mkdir(
      join(
        claudeRoot,
        "-fixtures-workspaces-conductor-claude-workspace",
        claudeSessionId,
        "subagents",
      ),
      { recursive: true },
    ),
    mkdir(repositoryRoot, { recursive: true }),
  ]);

  const database = new DatabaseSync(databasePath);
  const cursorDatabase = new DatabaseSync(cursorDatabasePath);
  cursorDatabase.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB)");
  const cursorSource = join(repositoryRoot, "cursor-fixture.ts");
  await writeFile(cursorSource, "export const fixture = true;\n");
  cursorDatabase.prepare("INSERT INTO cursorDiskKV (key,value) VALUES (?,?)").run(
    "composerData:cursor-fixture",
    JSON.stringify({
      composerId: "cursor-fixture",
      createdAt: Date.parse("2026-07-20T14:00:00Z"),
      lastUpdatedAt: Date.parse("2026-07-20T14:04:00Z"),
      originalModelLines: { [cursorSource]: [] },
      usageData: { "cursor-fixture-model": { amount: 1, costInCents: 123 } },
      conversation: [
        { type: 1, text: "cursor-content-is-not-returned", timingInfo: { clientStartTime: Date.parse("2026-07-20T14:00:00Z") } },
        { type: 2, tokenCount: { inputTokens: 200, outputTokens: 40 }, capabilitiesRan: [{ name: "edit_file" }], timingInfo: { clientEndTime: Date.parse("2026-07-20T14:04:00Z") } },
      ],
    }),
  );
  cursorDatabase.prepare("INSERT INTO cursorDiskKV (key,value) VALUES (?,?)").run(
    "composerData:cursor-metadata-only",
    JSON.stringify({
      composerId: "cursor-metadata-only",
      createdAt: Date.parse("2026-07-19T14:00:00Z"),
      lastUpdatedAt: Date.parse("2026-07-21T14:00:00Z"),
      originalModelLines: { [cursorSource]: [] },
      status: "completed",
      usageData: { "cursor-archived-model": { amount: 2, costInCents: 25 } },
    }),
  );
  cursorDatabase.prepare("INSERT INTO cursorDiskKV (key,value) VALUES (?,?)").run(
    "bubbleId:cursor-metadata-only:bubble-one",
    JSON.stringify({
      bubbleId: "bubble-one",
      tokenCount: { inputTokens: 300, outputTokens: 50 },
      toolFormerData: { name: "search_code", toolCallId: "cursor-tool-one" },
      timingInfo: { clientStartTime: 123, clientEndTime: 456 },
      type: 2,
    }),
  );
  cursorDatabase.prepare("INSERT INTO cursorDiskKV (key,value) VALUES (?,?)").run(
    "bubbleId:cursor-metadata-only:bubble-invalid-negative",
    JSON.stringify({
      bubbleId: "bubble-invalid-negative",
      tokenCount: { inputTokens: -999, outputTokens: -999 },
      type: 2,
    }),
  );
  cursorDatabase.close();
  database.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      name TEXT,
      root_path TEXT,
      remote_url TEXT,
      default_branch TEXT,
      hidden INTEGER DEFAULT 0
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      repository_id TEXT,
      workspace_name TEXT,
      workspace_path TEXT,
      branch TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      status TEXT,
      agent_type TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT,
      claude_session_id TEXT,
      model TEXT,
      is_hidden INTEGER DEFAULT 0,
      workspace_id TEXT
    );
  `);
  database
    .prepare(
      "INSERT INTO repos (id,name,root_path,remote_url,default_branch,hidden) VALUES (?,?,?,?,?,0)",
    )
    .run(repositoryId, "conductor", repositoryRoot, remote, "master");
  database
    .prepare(
      "INSERT INTO repos (id,name,root_path,remote_url,default_branch,hidden) VALUES (?,?,?,?,?,0)",
    )
    .run(
      "repository-2",
      "quiet-repository",
      join(root, "quiet-repository"),
      "https://github.com/example/quiet-repository.git",
      "main",
    );
  database
    .prepare(
      "INSERT INTO repos (id,name,root_path,remote_url,default_branch,hidden) VALUES (?,?,?,?,?,1)",
    )
    .run(
      "repository-hidden",
      "hidden-repository",
      join(root, "hidden-repository"),
      "https://github.com/example/hidden-repository.git",
      "main",
    );
  database
    .prepare(
      "INSERT INTO workspaces (id,repository_id,workspace_name,workspace_path,branch) VALUES (?,?,?,?,?)",
    )
    .run("workspace-codex", repositoryId, "Codex fixture", codexWorkspace, "codex-fixture");
  database
    .prepare(
      "INSERT INTO workspaces (id,repository_id,workspace_name,workspace_path,branch) VALUES (?,?,?,?,?)",
    )
    .run("workspace-claude", repositoryId, "Claude fixture", claudeWorkspace, "claude-fixture");
  database
    .prepare(
      "INSERT INTO sessions (id,status,agent_type,title,created_at,updated_at,claude_session_id,model,is_hidden,workspace_id) VALUES (?,?,?,?,?,?,?,?,0,?)",
    )
    .run(
      "conductor-codex",
      "idle",
      "codex",
      "Codex fixture session",
      "2026-07-20T10:00:00Z",
      "2026-07-20T11:00:00Z",
      codexSessionId,
      "gpt-5.6-sol",
      "workspace-codex",
    );
  database
    .prepare(
      "INSERT INTO sessions (id,status,agent_type,title,created_at,updated_at,claude_session_id,model,is_hidden,workspace_id) VALUES (?,?,?,?,?,?,?,?,0,?)",
    )
    .run(
      "conductor-claude",
      "idle",
      "claude",
      "Claude fixture session",
      "2026-07-20T12:00:00Z",
      "2026-07-20T13:00:00Z",
      claudeSessionId,
      claudeModel,
      "workspace-claude",
    );
  database.close();

  const codexRecords = [
    {
      payload: { cwd: codexWorkspace, id: codexSessionId },
      timestamp: "2026-07-20T10:00:00Z",
      type: "session_meta",
    },
    {
      payload: { effort: "high", model: "gpt-5.6-sol" },
      timestamp: "2026-07-20T10:00:01Z",
      type: "turn_context",
    },
    {
      payload: { message: "content-is-not-returned", type: "user_message" },
      timestamp: "2026-07-20T10:00:02Z",
      type: "event_msg",
    },
    {
      payload: { type: "task_started" },
      timestamp: "2026-07-20T10:00:03Z",
      type: "event_msg",
    },
    {
      payload: {
        info: {
          last_token_usage: {
            cached_input_tokens: 800,
            input_tokens: 1000,
            output_tokens: 100,
            reasoning_output_tokens: 40,
          },
          model_context_window: 2000,
          total_token_usage: {
            cached_input_tokens: 800,
            input_tokens: 1000,
            output_tokens: 100,
            reasoning_output_tokens: 40,
          },
        },
        type: "token_count",
      },
      timestamp: "2026-07-20T10:01:00Z",
      type: "event_msg",
    },
    {
      payload: {
        call_id: "call-one",
        input:
          'await tools.exec_command({cmd:"secret-command /fixture-skills/frontend-design/SKILL.md"}); await tools.apply_patch("secret patch");',
        name: "exec",
        type: "custom_tool_call",
      },
      timestamp: "2026-07-20T10:02:00Z",
      type: "response_item",
    },
    {
      payload: {
        info: {
          last_token_usage: {
            cached_input_tokens: 400,
            input_tokens: 500,
            output_tokens: 50,
            reasoning_output_tokens: 10,
          },
          model_context_window: 2000,
          total_token_usage: {
            cached_input_tokens: 1200,
            input_tokens: 1500,
            output_tokens: 150,
            reasoning_output_tokens: 50,
          },
        },
        type: "token_count",
      },
      timestamp: "2026-07-20T10:03:00Z",
      type: "event_msg",
    },
    {
      payload: { type: "context_compacted" },
      timestamp: "2026-07-20T10:04:00Z",
      type: "event_msg",
    },
    {
      payload: { type: "task_complete" },
      timestamp: "2026-07-20T10:05:00Z",
      type: "event_msg",
    },
  ];
  const codexPath = join(
    codexRoot,
    "2026/07/20",
    `rollout-2026-07-20T10-00-00-${codexSessionId}.jsonl`,
  );
  await writeFile(codexPath, `${codexRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const archivedCodexSessionId = "33333333-3333-4333-8333-333333333333";
  const archivedCodexRecords = [
    {
      payload: {
        cwd: repositoryRoot,
        id: archivedCodexSessionId,
        source: { subagent: { thread_spawn: { parent_thread_id: codexSessionId } } },
      },
      timestamp: "2026-07-18T10:00:00Z",
      type: "session_meta",
    },
    {
      payload: { cwd: repositoryRoot, id: archivedCodexSessionId, source: "vscode" },
      timestamp: "2026-07-18T10:01:00Z",
      type: "session_meta",
    },
    {
      payload: {
        info: {
          last_token_usage: { cached_input_tokens: 80, input_tokens: 100, output_tokens: 10 },
          total_token_usage: { cached_input_tokens: 80, input_tokens: 100, output_tokens: 10 },
        },
        type: "token_count",
      },
      timestamp: "2026-07-18T10:02:00Z",
      type: "event_msg",
    },
    {
      // Older evidence can emit its first usage state before the sole model
      // context. A unique file-level model remains safe to recover.
      payload: { model: "gpt-5.6-sol" },
      timestamp: "2026-07-18T10:02:01Z",
      type: "turn_context",
    },
    {
      // Codex broadcasts process-wide cumulative snapshots into more than one
      // session file. This is the same request already recorded by the main
      // fixture session and must not be priced a second time here. The stale
      // receiver timestamp is deliberately earlier so ownership must use the
      // main file's much closer response activity, not observation order.
      payload: {
        info: {
          last_token_usage: {
            cached_input_tokens: 400,
            input_tokens: 500,
            output_tokens: 50,
            reasoning_output_tokens: 10,
          },
          total_token_usage: {
            cached_input_tokens: 1200,
            input_tokens: 1500,
            output_tokens: 150,
            reasoning_output_tokens: 50,
          },
        },
        type: "token_count",
      },
      timestamp: "2026-07-20T10:02:59Z",
      type: "event_msg",
    },
  ];
  await writeFile(
    join(codexArchiveRoot, `rollout-2026-07-18T10-00-00-${archivedCodexSessionId}.jsonl`),
    `${archivedCodexRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  const claudeDirectory = join(
    claudeRoot,
    "-fixtures-workspaces-conductor-claude-workspace",
  );
  const claudeRecords = [
    {
      message: { content: "human request", role: "user" },
      sessionId: claudeSessionId,
      timestamp: "2026-07-20T12:00:00Z",
      type: "user",
      uuid: "human-one",
    },
    {
      agentId: "delegated-agent",
      cwd: claudeWorkspace,
      message: {
        content: [
          {
            id: "tool-one",
            input: { command: "secret-command" },
            name: "Bash",
            type: "tool_use",
          },
          {
            id: "tool-skill",
            input: { args: "secret-skill-args", skill: "review" },
            name: "Skill",
            type: "tool_use",
          },
        ],
        id: "message-one",
        model: claudeModel,
        role: "assistant",
        usage: {
          cache_creation: {
            ephemeral_1h_input_tokens: 50,
            ephemeral_5m_input_tokens: 150,
          },
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
          input_tokens: 100,
          output_tokens: 40,
        },
      },
      sessionId: claudeSessionId,
      timestamp: "2026-07-20T12:01:00Z",
      type: "assistant",
      uuid: "assistant-one-a",
    },
    {
      cwd: claudeWorkspace,
      message: {
        content: [
          {
            id: "tool-one",
            input: { command: "secret-command" },
            name: "Bash",
            type: "tool_use",
          },
          {
            id: "tool-skill",
            input: { args: "secret-skill-args", skill: "review" },
            name: "Skill",
            type: "tool_use",
          },
        ],
        id: "message-one",
        model: claudeModel,
        role: "assistant",
        usage: {
          cache_creation: {
            ephemeral_1h_input_tokens: 50,
            ephemeral_5m_input_tokens: 150,
          },
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
          input_tokens: 100,
          output_tokens: 40,
        },
      },
      sessionId: claudeSessionId,
      timestamp: "2026-07-20T12:01:01Z",
      type: "assistant",
      uuid: "assistant-one-b",
    },
    {
      cwd: claudeWorkspace,
      message: { content: [{ tool_use_id: "tool-one", type: "tool_result" }], role: "user" },
      sessionId: claudeSessionId,
      timestamp: "2026-07-20T12:02:00Z",
      type: "user",
      uuid: "tool-result-one",
    },
  ];
  await writeFile(
    join(claudeDirectory, `${claudeSessionId}.jsonl`),
    `${claudeRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const subagentRecord = {
    agentId: "delegated-agent",
    cwd: claudeWorkspace,
    message: {
      content: [{ id: "tool-two", input: { path: "secret-path" }, name: "Read", type: "tool_use" }],
      id: "message-two",
      model: claudeModel,
      role: "assistant",
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100,
        input_tokens: 50,
        output_tokens: 10,
      },
    },
    sessionId: claudeSessionId,
    timestamp: "2026-07-20T12:03:00Z",
    type: "assistant",
    uuid: "assistant-two",
  };
  await writeFile(
    join(claudeDirectory, claudeSessionId, "subagents", "agent-one.jsonl"),
    `${JSON.stringify(subagentRecord)}\n`,
  );

  return { noIndex: true, dataDir: join(root, "index"), additionalProviders: false, claudeRoot, codexArchiveRoot, codexRoot, cursorDatabasePath, databasePath, remote, repositoryRoot };
}

/** Synthetic canaries for surfaces that must never carry transcript metadata or content. */
export const privacySentinelPattern = /BOUNDARY-(?:TITLE|CWD|BRANCH|INPUT|RESULT|ERROR|MODEL|FILE)-SENTINEL/;

export async function plantPrivacySentinels(fixture: SessionAnalyticsFixture): Promise<void> {
  const title = "BOUNDARY-TITLE-SENTINEL";
  const cwd = "/private/BOUNDARY-CWD-SENTINEL";
  const branch = "BOUNDARY-BRANCH-SENTINEL";
  const input = "BOUNDARY-INPUT-SENTINEL";
  const result = "BOUNDARY-RESULT-SENTINEL";
  const error = "Error: BOUNDARY-ERROR-SENTINEL";
  const model = "gpt-5\n/private/BOUNDARY-MODEL-SENTINEL";
  const timestamp = "2026-07-20T15:00:00Z";
  const claudeFile = join(fixture.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", `${claudeSessionId}.jsonl`);
  await appendFile(claudeFile, [
    { type: "assistant", timestamp, cwd, title, gitBranch: branch, error,
      message: { id: "boundary-assistant", model, usage: { input_tokens: 17, output_tokens: 3 },
        content: [{ type: "text", text: title }, { type: "thinking", thinking: result },
          { type: "tool_use", id: "boundary-tool", name: "Read", input: { path: cwd, command: input } }] } },
    { type: "user", timestamp, cwd, toolUseResult: { stdout: result, stderr: error },
      message: { content: [{ type: "tool_result", tool_use_id: "boundary-tool", is_error: true, content: result }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  await appendFile(join(fixture.codexRoot, "2026/07/20", `rollout-2026-07-20T10-00-00-${codexSessionId}.jsonl`), [
    { type: "turn_context", timestamp, payload: { cwd, model, title, git: { branch }, error } },
    { type: "response_item", timestamp, payload: { type: "function_call", call_id: "boundary-call", name: "Read", arguments: JSON.stringify({ path: cwd, command: input }) } },
    { type: "response_item", timestamp, payload: { type: "function_call_output", call_id: "boundary-call", output: result, error } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  // Invalid source names must not become diagnostic output, even when JSON cannot be parsed.
  await writeFile(join(fixture.codexRoot, "2026/07/20", "BOUNDARY-FILE-SENTINEL.jsonl"), "{malformed\n");
  const conductor = new DatabaseSync(fixture.databasePath);
  try {
    conductor.prepare("UPDATE sessions SET title = ?").run(title);
    conductor.prepare("UPDATE workspaces SET branch = ?").run(branch);
    conductor.prepare("UPDATE repos SET default_branch = ?").run(branch);
  } finally { conductor.close(); }
  const cursor = new DatabaseSync(fixture.cursorDatabasePath);
  try {
    const key = "composerData:cursor-fixture";
    const row = cursor.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(key)!;
    const data = JSON.parse(String(row["value"]));
    data.name = title; data.cwd = cwd; data.gitBranch = branch; data.error = error;
    data.conversation.push({ type: 1, text: input, toolResults: result, error });
    const source = join(fixture.repositoryRoot, "BOUNDARY-FILE-SENTINEL.ts");
    await writeFile(source, input);
    data.originalModelLines[source] = [];
    cursor.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?").run(JSON.stringify(data), key);
  } finally { cursor.close(); }
}
