import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

const thread = "88888888-8888-4888-8888-888888888888";
const segment = "99999999-9999-4999-8999-999999999999";
const turn = "synthetic-integration-turn";
const key = createHash("sha256").update(`codex:${thread}`).digest("hex").slice(0, 12);
const event = (minute: number, second: number, type: string, payload: unknown) => ({
  timestamp: `2026-09-01T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`, type, payload,
});
const usage = (input: number) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
const counter = (minute: number, second: number, total: number, last?: number) => event(minute, second, "event_msg", {
  type: "token_count", info: { total_token_usage: usage(total), ...(last === undefined ? {} : { last_token_usage: usage(last) }) },
});
const receipt = (minute: number, second: number, response: string, input: number) => event(minute, second, "token_usage_record", {
  thread_id: thread, turn_id: turn, response_id: response, usage: usage(input),
});

async function runPages(first: object[], second: object[]) {
  const root = await mkdtemp(join(tmpdir(), "codex-combined-validation-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const header = (minute: number) => [
      event(minute, 0, "session_meta", { id: thread, cwd: fixture.repositoryRoot, source: "cli" }),
      event(minute, 1, "turn_context", { model: "gpt-5.6-sol", turn_id: turn }),
    ];
    await writeFile(join(fixture.codexRoot, `rollout-2026-09-01T12-00-00-${thread}.jsonl`), [...header(0), ...first].map(r => JSON.stringify(r)).join("\n") + "\n");
    await writeFile(join(fixture.codexRoot, `rollout-2026-09-01T12-10-00-${thread}_${segment}.jsonl`), [...header(10), ...second].map(r => JSON.stringify(r)).join("\n") + "\n");
    const result = await analyzeMachineSessions({ ...fixture, pricingPolicy: "reviewed-only" });
    assert.doesNotMatch(JSON.stringify(result), /88888888-8888|99999999-9999|synthetic-integration|compaction-content-sentinel/);
    const session = result.sessions.find(s => s.sessionKey === key);
    assert.ok(session);
    return session;
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("CODEX-01+07: cross-page receipts deduplicate while a new compaction receipt counts", async () => {
  const session = await runPages([
    receipt(0, 2, "synthetic-integration-response-a", 350),
    counter(0, 3, 350, 350),
  ], [
    receipt(10, 2, "synthetic-integration-response-a", 350),
    counter(10, 3, 350, 350),
    receipt(10, 4, "synthetic-integration-compaction", 97),
    event(10, 5, "compacted", { message: "compaction-content-sentinel", compaction_response_id: "synthetic-integration-compaction" }),
  ]);
  assert.equal(session.tokens.inputTokens, 447);
  assert.equal(session.metrics.modelCalls, 2);
  assert.equal(session.transcript.files, 2);
});

test("CODEX-05+07: cumulative-only ownership follows the page that observed the delta", async () => {
  const session = await runPages([counter(0, 3, 350, 350)], [
    counter(10, 2, 350),
    event(10, 3, "response_item", { type: "message", role: "assistant", content: [] }),
    counter(10, 4, 450),
  ]);
  assert.equal(session.tokens.inputTokens, 450);
  assert.equal(session.metrics.modelCalls, 2);
  assert.equal(session.transcript.files, 2);
});
