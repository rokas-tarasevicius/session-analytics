import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

test("CLAUDE-D01: supported Desktop local_<UUID>.json includes its adjacent subagent transcripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-discovery-validation-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const parent = join(fixture.claudeRoot, "synthetic-desktop", `local_${sessionId}`);
    await mkdir(join(parent, "subagents"), { recursive: true });
    const assistant = (messageId: string, input: number, output: number) => ({
      type: "assistant", sessionId, cwd: fixture.repositoryRoot,
      timestamp: "2026-07-20T15:00:00.000Z", entrypoint: "local-agent",
      message: { id: messageId, model: "claude-opus-5", stop_reason: "end_turn",
        usage: { input_tokens: input, output_tokens: output },
        content: [{ type: "text", text: "PRIVATE-DISCOVERY-SENTINEL" }] },
    });
    await writeFile(`${parent}.json`, JSON.stringify(assistant("main-message", 100, 20)) + "\n");
    await writeFile(join(parent, "subagents", "agent-child.jsonl"), JSON.stringify(assistant("child-message", 300, 40)) + "\n");
    const snapshot = await analyzeMachineSessions({
      ...fixture, pricingPolicy: "reviewed-only", additionalProviders: false, noIndex: true,
    });
    const key = createHash("sha256").update(`claude:${sessionId}`).digest("hex").slice(0, 12);
    const session = snapshot.sessions.find(s => s.sessionKey === key);
    assert.ok(session, "The documented .json main transcript must be discovered");
    assert.equal(session.transcript.files, 2, "Desktop .json must use its full stem for the child directory");
    assert.equal(session.tokens.inputTokens, 400);
    assert.equal(session.tokens.outputTokens, 60);
    assert.ok(session.costByExecution.subagentUsd > 0);
    assert.ok(!JSON.stringify(snapshot).includes("PRIVATE-DISCOVERY-SENTINEL"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
