import { createAntigravityDemoDatabase } from "./demo-antigravity.ts";
import { createHash } from "node:crypto";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
function write(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }

/** Synthetic evidence for every new source; no machine history or credentials are consulted. */
export function generateProviderDemo(root: string, repositories: Array<{ root: string; name: string }>, now: number): string[] {
  const copilot = join(root, "copilot"), gemini = join(root, "gemini", "tmp"), sdk = join(root, "cursor-sdk"), transcripts = join(root, "cursor-transcripts");
  const opencode = join(root, "opencode.db"), conductor = join(root, "conductor.db");
  const db = new DatabaseSync(opencode);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT)");
  const metadata = new DatabaseSync(conductor);
  metadata.exec("CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, remote_url TEXT, default_branch TEXT, hidden INTEGER); CREATE TABLE workspaces (id TEXT PRIMARY KEY, repository_id TEXT, workspace_name TEXT, workspace_path TEXT, branch TEXT); CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_type TEXT, status TEXT, title TEXT, created_at TEXT, updated_at TEXT, claude_session_id TEXT, model TEXT, is_hidden INTEGER, workspace_id TEXT); CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT, created_at TEXT)");
  const projects: Record<string, string> = {};
  for (const [i, repo] of repositories.entries()) {
    projects[repo.root] = repo.name;
    metadata.prepare("INSERT INTO repos VALUES (?,?,?,?,?,0)").run(`repo-${i}`, repo.name, repo.root, null, "main");
    metadata.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?)").run(`workspace-${i}`, `repo-${i}`, "synthetic", repo.root, "main");
    for (let n = 0; n < 4; n++) {
      const start = now - (i + n * 8 + 1) * 86400000, end = start + (n + 1) * 240000;
      const at = new Date(start).toISOString(), later = new Date(end).toISOString(), id = `demo-${i}-${n}`;
      db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(id, null, repo.root, start, end);
      db.prepare("INSERT INTO message VALUES (?,?,?)").run(`${id}-user`, id, JSON.stringify({ role: "user", time: { created: start }, content: "Synthetic demo message" }));
      for (let turn = 0; turn < 3 + n; turn++) {
        db.prepare("INSERT INTO message VALUES (?,?,?)").run(`${id}-response-${turn}`, id, JSON.stringify({ role: "assistant", modelID: "claude-sonnet-5", time: { created: start + turn * 30000 }, tokens: { input: 4000 * (i + 1), output: 1800, reasoning: 500, cache: { read: 6000, write: 1200 } } }));
        db.prepare("INSERT INTO part (id, session_id, data) VALUES (?,?,?)").run(`${id}-tool-${turn}`, id, JSON.stringify({ type: "tool", tool: ["read", "edit", "bash"][turn % 3], callID: `${id}-call-${turn}`, state: { input: {}, output: "Synthetic output" } }));
      }
      const antigravityId = `e0000000-0000-4000-8000-${String(i * 10 + n).padStart(12, "0")}`;
      createAntigravityDemoDatabase(join(root, "antigravity", "conversations", `${antigravityId}.db`), antigravityId, repo.root, at, later);
      const events = [{ id: `${id}-start`, type: "session.start", timestamp: at, data: { sessionId: id, startTime: at, context: { cwd: repo.root } } }];
      const persisted: unknown[] = [...events];
      for (let turn = 0; turn < 4 + n; turn++) {
        persisted.push({ id: `${id}-user-${turn}`, type: "user.message", timestamp: at, data: { content: "Synthetic prompt" } }, { id: `${id}-tool-${turn}`, type: "tool.execution_start", timestamp: later, data: { toolCallId: `${id}-${turn}`, toolName: "read_file", arguments: {} } });
      }
      write(join(copilot, id, "events.jsonl"), jsonl(persisted));
      write(join(gemini, repo.name, "chats", `session-${id}.json`), JSON.stringify({ sessionId: id, projectHash: createHash("sha256").update(repo.root).digest("hex"), startTime: at, lastUpdated: later, kind: "main", messages: [
        { id: `${id}-user`, type: "user", timestamp: at, content: "Synthetic prompt" },
        { id: `${id}-response`, type: "gemini", timestamp: later, model: "claude-sonnet-5", tokens: { input: 35000 * (n + 1), cached: 12000, output: 4500, thoughts: 2500 }, toolCalls: [{ id: `${id}-read`, name: "read_file", args: {}, result: "Synthetic result" }] },
      ] }));
      const agentId = `c0000000-0000-4000-8000-${String(i * 10 + n).padStart(12, "0")}`, dir = join(sdk, id);
      write(join(dir, "agents.ndjson"), jsonl([{ agentId, cwd: repo.root, createdAt: at, updatedAt: later }]));
      write(join(dir, "runs.ndjson"), jsonl([{ agentId, runId: id, model: { id: "claude-opus-5" }, status: "finished", createdAt: at, startedAt: at, endedAt: later, usage: { inputTokens: 75000, cacheReadTokens: 120000, cacheWriteTokens: 15000, outputTokens: 8500, reasoningTokens: 3000 } }]));
      write(join(dir, "run_events.ndjson"), jsonl(Array.from({ length: 7 + n }, (_, tool) => ({ payload: { type: "sdk_message", message: { type: "tool_call", agent_id: agentId, run_id: id, call_id: `${id}-${tool}`, name: tool % 2 ? "read_file" : "edit_file", status: "completed" } } }))));
      const transcriptId = `d0000000-0000-4000-8000-${String(i * 10 + n).padStart(12, "0")}`;
      const path = join(transcripts, repo.root.replace(/^\//, "").replace(/[^A-Za-z0-9]/g, "-"), "agent-transcripts", `${transcriptId}.jsonl`);
      write(path, jsonl([{ role: "user", message: { content: [{ type: "text", text: "Synthetic prompt" }] } }, { role: "assistant", message: { content: [{ type: "tool_use", id: `${id}-tool`, name: "Read", input: {} }] } }]));
      utimesSync(path, new Date(end), new Date(end));
      if (n === 0) {
        metadata.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, "claude", "completed", "Synthetic result-only session", at, later, `missing-${id}`, "claude-sonnet-5", 0, `workspace-${i}`);
        metadata.prepare("INSERT INTO session_messages VALUES (?,?,?,?)").run(`${id}-result`, id, JSON.stringify({ type: "result", uuid: `${id}-result`, session_id: `missing-${id}`, subtype: "success", total_cost_usd: 1.25 + i * 0.25, num_turns: 4, duration_ms: end - start, duration_api_ms: 90000, permission_denials: [], is_error: false, modelUsage: { "claude-sonnet-5": { inputTokens: 125000, cacheReadInputTokens: 40000, outputTokens: 15000, costUSD: 1.25 + i * 0.25 } }, result: "Synthetic result" }), later);
      }
    }
  }
  write(join(dirname(gemini), "projects.json"), JSON.stringify({ projects }));
  db.close(); metadata.close();
  return ["--no-additional-providers", "--antigravity-root", join(root, "antigravity"), "--copilot-root", copilot, "--opencode-database", opencode, "--gemini-root", gemini, "--cursor-sdk-root", sdk, "--cursor-transcript-root", transcripts, "--database", conductor];
}
