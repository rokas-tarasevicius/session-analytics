import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

test("integration: a registered child cwd cannot replace the genuine Claude primary stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-primary-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const project = join(fixture.claudeRoot, (await readdir(fixture.claudeRoot))[0]!);
    const rows = [
      { type: "user", sessionId: "22222222-2222-4222-8222-222222222222", cwd: fixture.repositoryRoot, timestamp: "2026-07-20T12:00:00Z", message: { content: "SYNTHETIC_PRIVATE_PRIMARY" } },
      { type: "assistant", timestamp: "2026-07-20T12:00:30Z", message: { id: "synthetic-primary-response", model: "claude-opus-5", content: [], usage: { input_tokens: 100, output_tokens: 20 } } },
    ];
    await writeFile(join(project, "22222222-2222-4222-8222-222222222222.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + '\n{"synthetic_truncated":');
    const result = await analyzeMachineSessions(fixture);
    const session = result.sessions.find(session => session.provider === "claude" && session.transcript.status === "ok")!;
    assert.ok(session);
    assert.ok(session.transcript.warnings.some(warning => warning.includes("primary transcript")));
    assert.ok(!session.transcript.warnings.some(warning => warning.includes("Primary transcript is unavailable")));
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_PRIMARY|synthetic-primary-response/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
