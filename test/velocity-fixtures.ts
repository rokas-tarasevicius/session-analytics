import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionAnalyticsFixture } from "./fixtures.ts";

// Deliberately invalid model metadata, including events with no priced usage.
export const unsafeVelocityModels = [
  "/private/velocity-model-SENTINEL/config", "C:\\velocity-model-SENTINEL\\config",
  "https://velocity-model-SENTINEL.invalid/model", "../velocity-model-SENTINEL",
  "cat velocity-model-SENTINEL", "$(velocity-model-SENTINEL)",
  "gpt-5;velocity-model-SENTINEL", "velocity-model-SENTINEL\ncontent",
  `velocity-model-SENTINEL-${"a".repeat(128)}`,
];

export async function addUnsafeVelocityModels(fixture: SessionAnalyticsFixture): Promise<number> {
  let count = 0;
  const timestamp = "2026-07-20T23:30:00Z";
  await mkdir(join(fixture.claudeRoot, "synthetic-models"), { recursive: true });
  for (const provider of ["codex", "claude"] as const) {
    for (const tool of [false, true]) for (const model of unsafeVelocityModels) {
      const id = `cccccccc-cccc-4ccc-8ccc-${String(++count).padStart(12, "0")}`;
      const records = provider === "codex" ? [
        { timestamp, type: "session_meta", payload: { id, cwd: fixture.repositoryRoot, source: "cli" } },
        { timestamp, type: "turn_context", payload: { model } },
        ...(tool ? [{ timestamp, type: "response_item", payload: { type: "function_call", call_id: "synthetic-call", name: "Read", arguments: "{}" } }] : []),
      ] : [
        { timestamp, cwd: fixture.repositoryRoot, sessionId: id, entrypoint: "cli", type: "assistant", message: {
          id: "synthetic-message", model, content: tool ? [{ type: "tool_use", id: "synthetic-call", name: "Read", input: {} }] : [],
        } },
      ];
      await writeFile(provider === "codex" ? join(fixture.codexRoot, `rollout-${id}.jsonl`) : join(fixture.claudeRoot, "synthetic-models", `${id}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    }
  }
  return count;
}
