import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Deterministic, synthetic workflow episodes: version eras, fan-out and open ends. */
export function addWorkflowDemo(claudeRoot: string, codexRoot: string, repositories: Array<{ root: string }>, now: number): void {
  const day = 86_400_000, today = Math.floor(now / day) * day;
  const write = (path: string, records: unknown[]): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n"); };
  const history: unknown[] = [];
  for (const [provider, root] of [["claude", dirname(claudeRoot)], ["codex", dirname(codexRoot)]] as const) {
    for (const name of ["code-review", "frontend-design", "webapp-testing", "release-notes", "architecture-review", "incident-triage"]) {
      const directory = join(root, "skills", name); mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\n---\nSynthetic ${provider} demo skill.\n`);
    }
  }
  const repository = repositories[0];
  if (!repository) return;
  // Eight sessions on either side of a version transition, with fixed model,
  // effort, entrypoint and archetype. Their synthetic timing shift is intentional.
  for (let index = 0; index < 16; index += 1) {
    const id = `ba000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const start = today - (20 - index) * day + 10 * 3_600_000, slower = index >= 8;
    const events: unknown[] = [];
    const add = (seconds: number, type: string, payload: Record<string, unknown>): void => { events.push({ type, timestamp: new Date(start + seconds * 1000).toISOString(), payload }); };
    add(0, "session_meta", { id, cwd: repository.root, source: "review", originator: "codex_cli_rs", cli_version: slower ? "0.141.0" : "0.140.0" });
    add(0, "turn_context", { model: "gpt-5.6-sol", effort: "high", collaboration_mode: { mode: index % 3 === 0 ? "plan" : "default" } });
    for (let turn = 0; turn < 3; turn += 1) {
      const base = turn * 600;
      add(base, "event_msg", { type: "user_message", message: "[synthetic workflow prompt]" });
      add(base, "event_msg", { type: "task_started", turn_id: `turn-${turn}` });
      for (let tool = 0; tool < 8; tool += 1) {
        add(base + (tool + 1) * (slower ? 30 : 20), "response_item", { type: "function_call", name: "exec_command", call_id: `call-${turn}-${tool}`, arguments: "[synthetic arguments]" });
        add(base + (tool + 1) * (slower ? 30 : 20) + 1, "response_item", { type: "function_call_output", call_id: `call-${turn}-${tool}`, output: "[synthetic output]" });
      }
      if (turn === 0) add(base + 90, "event_msg", { type: "item_completed", item: { id: "plan", type: "Plan", text: "[synthetic plan]" } });
      add(base + (slower ? 270 : 180), "event_msg", { type: "task_complete", turn_id: `turn-${turn}`, duration_ms: (slower ? 270 : 180) * 1000 });
    }
    write(join(codexRoot, `rollout-${id}.jsonl`), events);
  }
  // Four parallel Claude sessions, including a deliberate stale open ending.
  for (let index = 0; index < 4; index += 1) {
    const id = `cb000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const repo = repositories[index % repositories.length] ?? repository;
    const start = today - 2 * day + 14 * 3_600_000 + index * 60_000;
    const events: unknown[] = [];
    const add = (seconds: number, record: Record<string, unknown>): void => {
      events.push({ ...record, timestamp: new Date(start + seconds * 1000).toISOString(), sessionId: id, cwd: repo.root, uuid: `${index}-${events.length}`, version: "2.4.0", entrypoint: index % 2 ? "sdk-ts" : "cli" });
    };
    add(0, { type: "user", permissionMode: "plan", message: { content: "[synthetic prompt]" } });
    add(0, { type: "queue-operation", operation: "enqueue", reason: "user_input", content: "[synthetic queued prompt]" });
    for (let tool = 0; tool < 10; tool += 1) {
      add(20 + tool * 60, { type: "assistant", effort: "high", message: { id: `message-${tool}`, model: "claude-opus-5", content: [{ type: "tool_use", id: `tool-${tool}`, name: "Read", input: { file_path: "[synthetic path]" } }], usage: { input_tokens: 100, output_tokens: 20 } } });
      add(30 + tool * 60, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `tool-${tool}`, content: "[synthetic result]" }] } });
    }
    if (index !== 3) add(610, { type: "system", subtype: "turn_duration", durationMs: 610_000 });
    if (index === 1) {
      add(900, { type: "user", message: { content: "[synthetic next prompt]" } });
      add(920, { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    }
    write(join(claudeRoot, "synthetic-workflow", `${id}.jsonl`), events);
    history.push({ sessionId: id, timestamp: start, display: `${index % 2 ? "/review" : "/plan"} [synthetic arguments]` });
  }
  write(join(dirname(claudeRoot), "history.jsonl"), history);
}
