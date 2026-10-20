import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import type { AnalyzeOptions } from "../src/types.ts";

const at = "2026-07-20T09:00:00.000Z";
const sentinel = "PRIVATE-PARSER-CONTENT-雪";
const sessionId = "99999999-9999-4999-8999-999999999999";

async function fixture(run: (root: string, options: AnalyzeOptions) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "parser-edge-cases-"));
  try {
    await run(root, {
      noIndex: true, additionalProviders: false, offline: true, pricingPolicy: "reviewed-only",
      claudeRoot: join(root, "claude"), codexRoot: join(root, "codex"), codexArchiveRoot: join(root, "archive"),
      databasePath: join(root, "missing-conductor.db"), cursorDatabasePath: join(root, "missing-cursor.db"), dataDir: join(root, "data"),
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function write(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("Claude counts each anonymous tool block while deduplicating explicit tool IDs", async () => {
  await fixture(async (root, options) => {
    await write(join(options.claudeRoot!, `${sessionId}.jsonl`), [
      { type: "user", sessionId, cwd: root, timestamp: at, message: { content: sentinel } },
      { type: "assistant", uuid: "private-record", timestamp: at, message: {
        model: "claude-opus-5", usage: { input_tokens: 100, output_tokens: 20 },
        content: [
          { type: "tool_use", name: "Read", input: { path: sentinel } },
          { type: "tool_use", name: "Read", input: { path: sentinel } },
          { type: "tool_use", name: "Bash", input: { command: sentinel } },
          { type: "tool_use", id: "private-tool", name: "Write", input: sentinel },
          { type: "tool_use", id: "private-tool", name: "Write", input: sentinel },
        ],
      } },
    ]);
    const result = await analyzeMachineSessions(options);
    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0]!;
    assert.deepEqual(session.tools, { Read: 2, Bash: 1, Write: 1 });
    assert.deepEqual(session.transportTools, session.tools);
    assert.equal(session.metrics.toolCalls, 4);
    assert.equal(session.velocity!.buckets.reduce((n, cell) => n + cell[3][8], 0), 4);
    assert.equal(session.metrics.assistantMessages, 1);
    assert.equal(session.tokens.inputTokens, 100);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-PARSER-CONTENT|private-record|private-tool|99999999-9999/);
  });
});
