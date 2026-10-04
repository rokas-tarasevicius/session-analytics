import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeRepositorySessions } from "../../src/analyzer.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";

async function isolated(record: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "claude-validation-boundary-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    const sessionId = "abcdefab-1234-4234-8234-abcdefabcdef";
    const source = join(fixture.claudeRoot, "-synthetic-boundaries");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, `${sessionId}.jsonl`), [
      { type: "user", sessionId, cwd: fixture.repositoryRoot, uuid: "synthetic-user", timestamp: "2026-08-10T12:00:00Z", message: { role: "user", content: "VALIDATION_PRIVATE_SENTINEL" } },
      { type: "assistant", sessionId, cwd: fixture.repositoryRoot, uuid: "synthetic-assistant", ...record },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    const snapshot = await analyzeRepositorySessions({ ...fixture, pricingPolicy: "reviewed-only" });
    assert.doesNotMatch(JSON.stringify(snapshot), /VALIDATION_PRIVATE_SENTINEL/);
    const session = snapshot.sessions.find(value => value.firstEventAt === "2026-08-10T12:00:00.000Z");
    assert.ok(session);
    return session;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function message(model = "claude-opus-5") {
  return { role: "assistant", id: "synthetic-response", model, content: [], usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 50 } };
}

test("VC-STUB: synthetic assistant stubs cannot contribute physical tokens", async () => {
  const session = await isolated({ timestamp: "2026-08-10T12:00:01Z", message: message("<synthetic>") });
  assert.equal(session.tokens.inputTokens + session.tokens.outputTokens, 0);
  assert.equal(session.metrics.modelCalls, 0);
});

test("VC-STUB: API-error assistant envelopes cannot become priced model calls", async () => {
  const session = await isolated({ timestamp: "2026-08-10T12:00:01Z", isApiErrorMessage: true, apiErrorStatus: 429, message: message() });
  assert.equal(session.cost.totalUsd, 0);
  assert.equal(session.tokens.inputTokens + session.tokens.outputTokens, 0);
});

test("VC-UNDATED: undated priced Claude usage must not acquire a dated spend cell", async () => {
  const session = await isolated({ message: message() });
  assert.ok(session.cost.totalUsd > 0);
  assert.deepEqual(session.spendByDay, {});
});
