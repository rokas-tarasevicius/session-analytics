import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

function counter(timestamp: string, input: number, output: number, lastInput = 0, lastOutput = 0) {
  return { type: "event_msg", timestamp, payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 },
    last_token_usage: { input_tokens: lastInput, cached_input_tokens: 0, output_tokens: lastOutput, reasoning_output_tokens: 0 },
  } } };
}

for (const explicitOriginal of [false, true]) {
  test(`RC-CODEX-02: cumulative fallback excludes ${explicitOriginal ? "a chain of explicit requests" : "the same interval observed by another session"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "reconcile-codex-fallback-"));
    try {
      const fixture = await createSessionAnalyticsFixture(root);
      for (const [index, id] of ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"].entries()) {
        const records: unknown[] = [
          { type: "session_meta", timestamp: `2026-07-${22 + index}T10:00:00Z`, payload: { id, cwd: fixture.repositoryRoot, ...(index === 1 ? { forked_from_id: "44444444-4444-4444-8444-444444444444" } : {}) } },
          { type: "turn_context", timestamp: `2026-07-${22 + index}T10:00:01Z`, payload: { model: "gpt-5.4" } },
          counter(`2026-07-${22 + index}T10:00:02Z`, 1000, 100),
        ];
        if (explicitOriginal && index === 0) {
          records.push(counter("2026-07-22T10:00:03Z", 1040, 104, 40, 4));
          records.push(counter("2026-07-22T10:00:04Z", 1100, 110, 60, 6));
        } else records.push(counter(`2026-07-${22 + index}T10:00:05Z`, 1100, 110));
        await writeFile(join(fixture.codexRoot, `rollout-2026-07-${22 + index}T10-00-00-${id}.jsonl`), records.map(r => JSON.stringify(r)).join("\n") + "\n");
      }
      const result = await analyzeMachineSessions({ ...fixture, pricingPolicy: "reviewed-only" });
      const targets = result.sessions.filter(s => ["2026-07-22T10:00:00.000Z", "2026-07-23T10:00:00.000Z"].includes(s.firstEventAt ?? ""));
      assert.equal(targets.length, 2);
      assert.equal(targets.reduce((n, s) => n + s.tokens.inputTokens, 0), 100,
        "process-wide cumulative interval was billed twice");
      assert.equal(targets.reduce((n, s) => n + s.tokens.outputTokens, 0), 10);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
