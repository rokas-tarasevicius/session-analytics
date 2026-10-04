import { writeFileSync } from "node:fs";
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
