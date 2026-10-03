import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionAnalyticsFixture } from "./fixtures.ts";

export const malformedModels = [
  "/private/SYNTHETIC-MODEL-SENTINEL", "C:\\private\\SYNTHETIC-MODEL-SENTINEL",
  "https://example.invalid/SYNTHETIC-MODEL-SENTINEL", "../SYNTHETIC-MODEL-SENTINEL",
  "Error: SYNTHETIC-MODEL-SENTINEL", "gpt-5\nSYNTHETIC-MODEL-SENTINEL",
  "SYNTHETIC-MODEL-SENTINEL".repeat(8),
];

/** All malformed metadata is synthetic; exercise every provider's public model path. */
export async function plantMalformedModels(fixture: SessionAnalyticsFixture): Promise<void> {
  const claude = join(fixture.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", "22222222-2222-4222-8222-222222222222.jsonl");
  const codex = join(fixture.codexRoot, "2026/07/20", "rollout-2026-07-20T10-00-00-11111111-1111-4111-8111-111111111111.jsonl");
  for (const [index, model] of malformedModels.entries()) {
    const timestamp = `2026-07-20T15:0${index}:00Z`;
    await appendFile(claude, JSON.stringify({ type: "assistant", timestamp,
      diagnostics: { cache_miss_reason: { type: "tools_changed" } },
      message: { id: `malformed-${index}`, role: "assistant", model,
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 1000 } } }) + "\n");
    await appendFile(codex, [
      { type: "turn_context", timestamp, payload: { model } },
      { type: "event_msg", timestamp, payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: 10000 + index * 100, output_tokens: 1000 + index * 10 },
        last_token_usage: { input_tokens: 100, output_tokens: 10 }, model_context_window: 200000,
      } } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  const database = new DatabaseSync(fixture.cursorDatabasePath);
  try {
    const row = database.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get("composerData:cursor-fixture")!;
    const data = JSON.parse(String(row["value"]));
    data.usageData = { [malformedModels[0]!]: { costInCents: 100 }, [malformedModels[1]!]: { costInCents: 23 } };
    database.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?").run(JSON.stringify(data), "composerData:cursor-fixture");
  } finally { database.close(); }
}
