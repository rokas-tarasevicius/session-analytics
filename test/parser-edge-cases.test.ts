import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { validateSnapshot } from "../src/interop/snapshot.ts";
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

for (const shape of ["token_count", "receipt", "cumulative"] as const) test(`Codex bounds inconsistent token subsets (${shape})`, async () => {
  await fixture(async (root, options) => {
    const before = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 };
    const after = { input_tokens: 150, cached_input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 15 };
    const invalid = { input_tokens: 50, cached_input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 15 };
    const event = (total: object, last?: object) => ({ type: "event_msg", timestamp: at,
      payload: { type: "token_count", info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}) } } });
    await write(join(options.codexRoot!, `${sessionId}.jsonl`), [
      { type: "session_meta", timestamp: at, payload: { id: sessionId, cwd: root, source: "cli", instructions: sentinel } },
      { type: "turn_context", timestamp: at, payload: { model: "gpt-5.4" } },
      ...(shape === "cumulative" ? [event(before), event(after)] : shape === "receipt" ? [
        { type: "token_usage_record", timestamp: at, payload: { thread_id: sessionId, response_id: "private-response", usage: invalid } },
      ] : [event(invalid, invalid)]),
    ]);
    const result = await analyzeMachineSessions(options);
    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0]!;
    assert.equal(session.tokens.inputTokens, 50);
    assert.equal(session.tokens.cachedInputTokens, 50);
    assert.equal(session.tokens.uncachedInputTokens, 0);
    assert.equal(session.tokens.outputTokens, 10);
    assert.equal(session.tokens.reasoningOutputTokens, 10);
    assert.equal(session.tokens.nonReasoningOutputTokens, 0);
    assert.equal(session.metrics.modelCalls, 1);
    assert.equal(session.transcript.completeness, "partial");
    assert.match(session.transcript.warnings.join(" "), /breakdown.*exceed|exceed.*breakdown/i);
    assert.ok(session.pricedTokenCoverage! <= 1);
    assert.deepEqual(validateSnapshot(result), result);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-PARSER-CONTENT|private-response|99999999-9999/);
    for (let scan = 0; scan < 2; scan++) {
      const indexed = await analyzeMachineSessions({ ...options, noIndex: false });
      assert.deepEqual(indexed.sessions, result.sessions, "cold and warm indexed accounting matches the full scan");
      validateSnapshot(indexed);
    }
  });
});

test("Codex cumulative-only baselines with valid breakdowns do not imply inconsistent intervals", async () => {
  await fixture(async (root, options) => {
    const event = (input: number, cached: number, output: number, reasoning: number) => ({ type: "event_msg", timestamp: at,
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning } } } });
    await write(join(options.codexRoot!, `${sessionId}.jsonl`), [
      { type: "session_meta", timestamp: at, payload: { id: sessionId, cwd: root, source: "cli" } },
      { type: "turn_context", timestamp: at, payload: { model: "gpt-5.4" } },
      event(100, 50, 10, 5), event(160, 80, 20, 8),
    ]);
    const result = await analyzeMachineSessions(options), session = result.sessions[0]!;
    assert.equal(session.tokens.inputTokens, 60);
    assert.equal(session.tokens.cachedInputTokens, 30);
    assert.equal(session.tokens.reasoningOutputTokens, 3);
    assert.equal(session.transcript.completeness, "complete");
    assert.doesNotMatch(session.transcript.warnings.join(" "), /breakdown.*exceed|exceed.*breakdown/i);
    validateSnapshot(result);
  });
});
