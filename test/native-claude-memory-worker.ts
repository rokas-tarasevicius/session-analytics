/** Synthetic large child fan-out must discover every child exactly once. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeMachineSessions } from "../src/analyzer.ts";

const root = process.argv[2]!;
const codexRoot = join(root, "codex"), claudeRoot = join(root, "claude"), codexArchiveRoot = join(root, "archive");
const parent = "cccccccc-0000-4000-8000-000000000000", children = 1_000;
const childRoot = join(claudeRoot, "project", parent, "subagents");
await Promise.all([codexRoot, childRoot, codexArchiveRoot].map(path => mkdir(path, { recursive: true })));
const jsonl = (n: number, child: boolean) => JSON.stringify({
  type: "assistant", sessionId: parent, cwd: root, timestamp: "2026-07-02T00:00:00Z", isSidechain: child,
  message: { id: `response-${n}`, model: "claude-sonnet-4", content: [{ type: "text", text: "PRIVATE_SYNTHETIC_MESSAGE" }],
    usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
}) + "\n";
await writeFile(join(claudeRoot, "project", `${parent}.jsonl`), jsonl(children, false));
for (let n = 0; n < children; n++) await writeFile(join(childRoot, `agent-${n}.jsonl`), jsonl(n, true));
const snapshot = await analyzeMachineSessions({
  codexRoot, codexArchiveRoot, claudeRoot, dataDir: join(root, "data"),
  databasePath: join(root, "missing.db"), cursorDatabasePath: join(root, "missing-cursor.db"),
  noIndex: true, offline: true, additionalProviders: false,
});
assert.equal(snapshot.sessions.length, 1);
const session = snapshot.sessions[0]!;
assert.equal(session.transcript.files, children + 1);
assert.equal(session.tokens.inputTokens, (children + 1) * 100);
assert.equal(session.tokens.outputTokens, children + 1);
assert.equal(session.metrics.modelCalls, children + 1);
assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_SYNTHETIC_MESSAGE|response-\d/);
process.stdout.write(JSON.stringify({ sessions: 1, files: children + 1, calls: children + 1 }));
