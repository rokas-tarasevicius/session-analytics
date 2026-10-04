import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

const thread = "66666666-6666-4666-8666-666666666666";
const segment = "77777777-7777-4777-8777-777777777777";
const key = createHash("sha256").update(`codex:${thread}`).digest("hex").slice(0, 12);
const event = (minute: number, second: number, type: string, payload: unknown) => ({
  timestamp: `2026-09-01T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`, type, payload,
});
const counter = (minute: number, second: number, input: number, last: number) => event(minute, second, "event_msg", {
  type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: 0 }, last_token_usage: { input_tokens: last, output_tokens: 0 } },
});

async function runPagination(firstPagePresent: boolean) {
  const root = await mkdtemp(join(tmpdir(), "codex-pagination-validation-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const header = (minute: number) => event(minute, 0, "session_meta", { id: thread, cwd: fixture.repositoryRoot, source: "cli" });
    const context = (minute: number) => event(minute, 1, "turn_context", { model: "gpt-5.6-sol" });
    if (firstPagePresent) await writeFile(join(fixture.codexRoot, `rollout-2026-09-01T12-00-00-${thread}.jsonl`), [
      header(0), context(0), counter(0, 3, 350, 350),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    await writeFile(join(fixture.codexRoot, `rollout-2026-09-01T12-10-00-${thread}_${segment}.jsonl`), [
      header(10), context(10),
      ...(firstPagePresent ? [counter(10, 2, 350, 350)] : []),
      counter(10, 3, firstPagePresent ? 447 : 97, 97),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const result = await analyzeMachineSessions({ ...fixture, pricingPolicy: "reviewed-only" });
    assert.doesNotMatch(JSON.stringify(result), /66666666-6666|77777777-7777/);
    const session = result.sessions.find((s) => s.sessionKey === key);
    assert.ok(session, "A segmented filename must be discovered under its first, metadata-matching thread UUID");
    assert.equal(result.sessions.filter((s) => s.sessionKey === key).length, 1);
    return session;
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("CODEX-07: a native suffixed rollout is discovered even when its original page is absent", async () => {
  const session = await runPagination(false);
  assert.equal(session.tokens.inputTokens, 97);
});

test("CODEX-07: pages of one thread combine without charging their overlapping state twice", async () => {
  const session = await runPagination(true);
  assert.equal(session.tokens.inputTokens, 447);
  assert.equal(session.metrics.modelCalls, 2);
  assert.equal(session.transcript.files, 2);
});
