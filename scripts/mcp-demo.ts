import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Fixed synthetic extension inventory and a recent quota sample for the MCP demo. */
export function seedMcpDemo(root: string): void {
  const project = join(root, "repos/acme-web");
  for (const provider of ["claude", "codex"]) {
    for (const skill of ["review", "unused-demo-skill"]) {
      const directory = join(root, provider, "skills", skill);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), "Synthetic demo skill; its content is never read.\n");
    }
  }
  writeFileSync(join(root, "claude/.claude.json"), JSON.stringify({ mcpServers: {
    github: { command: "synthetic-never-executed" }, "unused-demo-server": { command: "synthetic-never-executed" },
  } }));
  writeFileSync(join(root, "codex/config.toml"), '[mcp_servers.unused-demo-server]\ncommand = "synthetic-never-executed"\n');
  mkdirSync(join(project, ".cursor"), { recursive: true });
  writeFileSync(join(project, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { "unused-demo-server": { command: "synthetic-never-executed" } } }));
  const now = Date.now(), at = (offset: number): string => new Date(now + offset).toISOString();
  const id = "88888888-8888-4888-8888-888888888888";
  const usage = { input_tokens: 10_000, cached_input_tokens: 8_000, output_tokens: 500, reasoning_output_tokens: 200 };
  const rows = [
    { type: "session_meta", timestamp: at(-120_000), payload: { id, cwd: project, source: "cli" } },
    { type: "turn_context", timestamp: at(-119_000), payload: { model: "gpt-5.6-sol" } },
    { type: "event_msg", timestamp: at(-118_000), payload: { type: "user_message", message: "Synthetic demo request" } },
    { type: "event_msg", timestamp: at(-60_000), payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage }, rate_limits: {
      primary: { window_minutes: 300, used_percent: 38, resets_at: Math.floor(now / 1000) + 7200 },
      secondary: { window_minutes: 10080, used_percent: 21, resets_at: Math.floor(now / 1000) + 172800 },
    } } },
    { type: "event_msg", timestamp: at(-30_000), payload: { type: "task_complete" } },
  ];
  writeFileSync(join(root, "codex/sessions", `rollout-demo-${id}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
