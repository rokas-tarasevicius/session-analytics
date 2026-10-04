import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";

for (const { clonedOutput, retainedOutput, stub } of [
  { clonedOutput: 10, retainedOutput: 10, stub: null },
  { clonedOutput: 15, retainedOutput: 15, stub: null },
  { clonedOutput: 999, retainedOutput: 10, stub: "synthetic" },
  { clonedOutput: 999, retainedOutput: 10, stub: "api-error" },
]) test(`Claude resumed copies retain output ${retainedOutput}; copied stub=${stub ?? "none"}; copied output=${clonedOutput}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "claude-resume-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeRoot = join(root, "claude"), repository = join(root, "repository");
  await mkdir(claudeRoot, { recursive: true }); await mkdir(repository, { recursive: true });
  const sessions = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  for (const [i, id] of sessions.entries()) {
    const record = (messageId: string, input: number, output: number) => ({
      type: "assistant", sessionId: id, cwd: repository, uuid: `synthetic-${i}-${messageId}`, isApiErrorMessage: false,
      requestId: `request-${messageId}`, timestamp: "2026-09-01T12:00:00Z",
      message: { id: messageId, model: "claude-opus-4-8", content: [],
        usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 0 } } },
    });
    const copied = record("copied-shared-message", 100, i === 0 ? 10 : clonedOutput);
    if (i === 1 && stub === "synthetic") copied.message.model = "<synthetic>";
    if (i === 1 && stub === "api-error") copied.isApiErrorMessage = true;
    await writeFile(join(claudeRoot, `${id}.jsonl`), [copied,
      record(`unique-message-${i}`, (i + 2) * 100, (i + 2) * 10)].map(x => JSON.stringify(x)).join("\n") + "\n");
  }
  const result = await analyzeMachineSessions({ noIndex: true, additionalProviders: false,
    pricingPolicy: "reviewed-only", dataDir: join(root, "data"), claudeRoot,
    codexRoot: join(root, "missing-codex"), codexArchiveRoot: join(root, "missing-archive"),
    cursorDatabasePath: join(root, "missing-cursor.db"), databasePath: join(root, "missing-conductor.db") });
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions.reduce((sum, s) => sum + s.tokens.inputTokens, 0), 600);
  assert.equal(result.sessions.reduce((sum, s) => sum + s.tokens.outputTokens, 0), 50 + retainedOutput);
  assert.ok(Math.abs(result.sessions.reduce((sum, s) => sum + s.cost.totalUsd, 0) - (0.003 + (50 + retainedOutput) * 25 / 1e6)) < 1e-12);
});
