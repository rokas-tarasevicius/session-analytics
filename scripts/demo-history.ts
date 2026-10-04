import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Synthetic deleted-history evidence, never a copy of a local provider store. */
export function seedHistoryDemo(root: string, claudeRoot: string, now: number): void {
  const model = "claude-sonnet-5";
  const days = Array.from({ length: 90 }, (_, index) => ({ date: new Date(now - (index + 1) * 86_400_000).toISOString().slice(0, 10), tokensByModel: { [model]: 1_400_000 + index * 18_000 } }));
  writeFileSync(join(dirname(claudeRoot), "stats-cache.json"), JSON.stringify({ version: 5, dailyModelTokensVersion: 5,
    lastComputedDate: days[0]!.date, dailyModelTokens: days, modelUsage: { [model]: { inputTokens: 6_000_000, outputTokens: 9_000_000, cacheReadInputTokens: 120_000_000, cacheCreationInputTokens: 15_000_000, costUSD: 0 } } }));
  const db = new DatabaseSync(join(root, "conductor.db"));
  try {
    // Surviving synthetic native/SDK pairs exercise measured calibration. These
    // receipts finalize only part of native output, so the demo shows a range.
    for (let index = 0; index < 5; index++) {
      const id = `calibration-demo-${index}`, providerId = `f0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const time = new Date(now - (index + 7) * 86_400_000).toISOString();
      const workspace = db.prepare("SELECT workspace_path FROM workspaces WHERE id=?").get(`workspace-${index}`) as { workspace_path: string };
      const usage = { input_tokens: 100_000, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 40_000,
        cache_creation: { ephemeral_5m_input_tokens: 40_000, ephemeral_1h_input_tokens: 0 }, output_tokens: 100_000 };
      const directory = join(claudeRoot, "synthetic-recovery-calibration"); mkdirSync(directory, { recursive: true });
      const path = join(directory, `${providerId}.jsonl`);
      writeFileSync(path, JSON.stringify({ type: "assistant", sessionId: providerId, uuid: `${id}-native`, timestamp: time, cwd: workspace.workspace_path,
        entrypoint: "sdk-ts", message: { id: `${id}-response`, model, role: "assistant", stop_reason: "end_turn", usage, content: [{ type: "text", text: "Synthetic calibration example" }] } }) + "\n");
      utimesSync(path, new Date(time), new Date(time));
      db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, "claude", "completed", "Synthetic paired session", time, time, providerId, model, 0, `workspace-${index}`);
      const insert = db.prepare("INSERT INTO session_messages VALUES (?,?,?,?)");
      insert.run(`${id}-assistant`, id, JSON.stringify({ type: "assistant", uuid: `${id}-assistant`, session_id: providerId, message: { model, usage: { ...usage, output_tokens: 2 } } }), time);
      insert.run(`${id}-result`, id, JSON.stringify({ type: "result", uuid: `${id}-result`, session_id: providerId, subtype: "success",
        usage: { ...usage, output_tokens: 70_000 + 5_000 * index }, total_cost_usd: index === 4 ? 1.30 : 0 }), time);
    }
    for (let index = 0; index < 3; index++) {
      const id = `history-demo-${index}`, providerId = `history-provider-${index}`, start = now - (70 + index * 5) * 86_400_000;
      const first = new Date(start).toISOString(), last = new Date(start + 86_400_000).toISOString();
      db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, "claude", "completed", "Synthetic recovered session", first, last, providerId, model, 0, `workspace-${index}`);
      const insert = db.prepare("INSERT INTO session_messages VALUES (?,?,?,?)");
      for (let message = 0; message < 4; message++) for (const output of [500, 2000]) {
        const at = message < 2 ? first : last;
        insert.run(`${id}-${message}-${output}`, id, JSON.stringify({ type: "assistant", uuid: `${id}-${message}-${output}`, session_id: providerId,
          parent_tool_use_id: message === 3 ? "synthetic-parent" : null, timestamp: at,
          message: { id: `${id}-message-${message}`, model, usage: { input_tokens: 10_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5_000, output_tokens: output },
            content: [{ type: "text", text: "Synthetic history example" }, { type: "tool_use", id: `${id}-tool-${message}`, name: "Read", input: { file_path: "synthetic.txt" } }] } }), at);
      }
      insert.run(`${id}-result`, id, JSON.stringify({ type: "result", uuid: `${id}-result`, session_id: providerId, total_cost_usd: 0.29, subtype: "success", result: "Synthetic completion" }), last);
    }
  } finally { db.close(); }
}
