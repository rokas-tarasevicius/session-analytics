import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** A fixed recent synthetic session so the MCP demo always has settled current-day activity. */
export function seedMcpDemo(root: string): void {
  const project = join(root, "repos/acme-web");
  const now = Date.now(), at = (offset: number): string => new Date(now + offset).toISOString();
  const id = "88888888-8888-4888-8888-888888888888";
  const usage = { input_tokens: 10_000, cached_input_tokens: 8_000, output_tokens: 500, reasoning_output_tokens: 200 };
  const rows = [
    { type: "session_meta", timestamp: at(-120_000), payload: { id, cwd: project, source: "cli" } },
    { type: "turn_context", timestamp: at(-119_000), payload: { model: "gpt-5.6-sol" } },
    { type: "event_msg", timestamp: at(-118_000), payload: { type: "user_message", message: "Synthetic demo request" } },
    { type: "event_msg", timestamp: at(-60_000), payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } },
    { type: "event_msg", timestamp: at(-30_000), payload: { type: "task_complete" } },
  ];
  writeFileSync(join(root, "codex/sessions", `rollout-demo-${id}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
