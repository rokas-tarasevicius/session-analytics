/** Synthetic fork fan-out: absent ancestor calls must not be retained per child. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeMachineSessions } from "../src/analyzer.ts";

const root = process.argv[2]!;
const codexRoot = join(root, "codex"), claudeRoot = join(root, "claude"), codexArchiveRoot = join(root, "archive");
await Promise.all([codexRoot, claudeRoot, codexArchiveRoot].map(path => mkdir(path, { recursive: true })));
const count = 10_000, children = 600;
const parent = "aaaaaaaa-0000-4000-8000-000000000000";
const id = (n: number): string => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
const meta = (identity: string, timestamp: string, forked_from_id?: string) => ({ type: "session_meta", timestamp, payload: { id: identity, cwd: root, source: "cli", forked_from_id } });
const call = (call_id: string, timestamp: string) => ({ type: "response_item", timestamp, payload: { type: "function_call", call_id, name: "exec_command", arguments: "PRIVATE_SYNTHETIC_ARGUMENT" } });
const complete = (timestamp: string) => ({ type: "event_msg", timestamp, payload: { type: "task_complete" } });
const jsonl = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
await writeFile(join(codexRoot, `rollout-${parent}.jsonl`), jsonl([
  meta(parent, "2026-07-01T00:00:00Z"),
  ...Array.from({ length: count }, (_, n) => call(`ancestor-${n}`, "2026-07-01T00:00:01Z")),
  complete("2026-07-01T00:00:02Z"),
]));
for (let n = 0; n < children; n++) await writeFile(join(codexRoot, `rollout-${id(n)}.jsonl`), jsonl([
  meta(id(n), "2026-07-02T00:00:00Z", parent),
  call(`ancestor-${n}`, "2026-07-01T00:00:01Z"),
  call(`new-${n}`, "2026-07-02T00:00:01Z"),
  complete("2026-07-02T00:00:02Z"),
]));
const snapshot = await analyzeMachineSessions({
  codexRoot, codexArchiveRoot, claudeRoot, dataDir: join(root, "data"),
  databasePath: join(root, "missing.db"), cursorDatabasePath: join(root, "missing-cursor.db"),
  noIndex: true, offline: true, additionalProviders: false,
});
assert.equal(snapshot.sessions.length, children + 1);
assert.equal(snapshot.sessions.reduce((sum, session) => sum + session.metrics.transportToolCalls, 0), count + children);
assert.equal(snapshot.sessions.filter(session => session.metrics.transportToolCalls === 1).length, children);
assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_SYNTHETIC_ARGUMENT|ancestor-\d|new-\d/);
process.stdout.write(JSON.stringify({ sessions: snapshot.sessions.length, calls: count + children }));
