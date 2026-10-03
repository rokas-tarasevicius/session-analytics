import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { pricingDirectory, saveSnapshot } from "../src/pricing/store.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";
import { privateSentinel, sourceSnapshot } from "./pricing-fixtures.ts";

test("request-time prices and all provenance survive session/repository/machine aggregation, report and rates status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pricing-accounting-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    const options = { ...fixture, offline: true, dataDir: join(directory, "analytics-data") };
    const snapshots = pricingDirectory(options);
    await saveSnapshot(snapshots, sourceSnapshot("models.dev", "2026-01-01T00:00:00.000Z", 2));
    await saveSnapshot(snapshots, sourceSnapshot("models.dev", "2026-02-01T00:00:00.000Z", 4));
    const sessionId = "77777777-1111-4111-8111-111111111111";
    const path = join(fixture.codexRoot, `rollout-2026-01-15-${sessionId}.jsonl`);
    const usage = (input: number) => ({ input_tokens: input, cached_input_tokens: 100000, output_tokens: 100, reasoning_output_tokens: 50 });
    await writeFile(path, [
      { type: "session_meta", timestamp: "2026-01-15T00:00:00Z", payload: { id: sessionId, cwd: fixture.repositoryRoot, originator: privateSentinel } },
      { type: "turn_context", timestamp: "2026-01-15T00:00:00Z", payload: { model: "openai/gpt-fixture" } },
      { type: "response_item", timestamp: "2026-01-15T00:00:01Z", payload: { type: "message", role: "assistant", content: privateSentinel } },
      { type: "event_msg", timestamp: "2026-01-15T00:00:02Z", payload: { type: "token_count", info: { last_token_usage: usage(200000), total_token_usage: usage(200000) } } },
      { type: "response_item", timestamp: "2026-02-15T00:00:01Z", payload: { type: "message", role: "assistant", content: privateSentinel } },
      { type: "event_msg", timestamp: "2026-02-15T00:00:02Z", payload: { type: "token_count", info: { last_token_usage: usage(300000), total_token_usage: { input_tokens: 500000, cached_input_tokens: 200000, output_tokens: 200, reasoning_output_tokens: 100 } } } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const snapshot = await analyzeMachineSessions(options);
    const session = snapshot.sessions.find(({ models }) => models.some(({ model }) => model === "openai/gpt-fixture"))!;
    assert.ok(session);
    // January: 100K uncached at $2 + 100K cached at $0.2 + 100 output at $10.
    // February: 200K uncached above 272K at $8 + 100K cache at $0.3 + 100 output at $15.
    assert.ok(Math.abs(session.cost.totalUsd - (0.221 + 1.6315)) < 1e-10);
    assert.ok(Math.abs(session.cost.upperEstimateUsd - (0.271 + 2.0315)) < 1e-10);
    assert.equal(session.models[0]?.pricing?.length, 2);
    const aggregated = snapshot.spendByModel.find(({ model }) => model === "openai/gpt-fixture");
    assert.deepEqual(aggregated?.pricing, session.models[0]?.pricing);
    assert.equal(snapshot.repositories.find(({ repository }) => repository.id === session.repositoryId)?.spendByModel
      .find(({ model }) => model === "openai/gpt-fixture")?.pricing?.length, 2);
    const stableCost = session.cost.totalUsd;
    await saveSnapshot(snapshots, sourceSnapshot("models.dev", "2026-03-01T00:00:00.000Z", 9));
    const next = await analyzeMachineSessions(options);
    assert.equal(next.sessions.find(({ sessionKey }) => sessionKey === session.sessionKey)?.cost.totalUsd, stableCost);
    const serialized = JSON.stringify(next);
    for (const forbidden of [privateSentinel, fixture.claudeRoot, fixture.repositoryRoot, fixture.remote, sessionId]) assert.ok(!serialized.includes(forbidden));

    const env = { ...process.env, SESSION_ANALYTICS_NO_INDEX: "1", SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0", SESSION_ANALYTICS_DATA_DIR: options.dataDir, SESSION_ANALYTICS_OFFLINE: "1",
      SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot, SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot,
      SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot, SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath,
      SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath };
    for (const args of [["report", "--json"], ["rates", "status", "--json"]]) {
      const result = spawnSync(process.execPath, ["bin/session-analytics.ts", ...args], { encoding: "utf8", env });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      if (args[0] === "rates") { assert.ok(output.coverage.modelsSeen >= 3); assert.ok(output.coverage.modelsPriced > 0); assert.equal(output.status.offline, true); }
      else assert.equal(output.spendByModel.find(({ model }: { model: string }) => model === "openai/gpt-fixture").pricing.length, 2);
      for (const forbidden of [privateSentinel, fixture.claudeRoot, fixture.remote, sessionId]) assert.ok(!result.stdout.includes(forbidden));
    }
    const onlineReport = spawnSync(process.execPath, ["bin/session-analytics.ts", "report", "--json"], {
      encoding: "utf8", env: { ...env, SESSION_ANALYTICS_OFFLINE: "0" },
    });
    assert.equal(onlineReport.status, 0, onlineReport.stderr); JSON.parse(onlineReport.stdout);
    assert.match(onlineReport.stderr, /rates update/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Claude cache TTLs and long-context absolute tiers are priced per request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pricing-claude-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory, "claude-fixture-4-5");
    const dataDir = join(directory, "data");
    await saveSnapshot(pricingDirectory({ dataDir }), sourceSnapshot("litellm", "2026-01-01T00:00:00.000Z"));
    const root = join(fixture.claudeRoot, "-pricing-context"); await mkdir(root);
    const id = "88888888-1111-4111-8111-111111111111";
    await writeFile(join(root, `${id}.jsonl`), JSON.stringify({ type: "assistant", timestamp: "2026-07-21T09:00:00Z",
      sessionId: id, cwd: fixture.repositoryRoot, uuid: "synthetic-cache", message: { id: "one", model: "claude-fixture-4-5",
        content: [{ type: "text", text: privateSentinel }], usage: { input_tokens: 200000, cache_read_input_tokens: 10,
          cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 10 }, output_tokens: 10 } } }) + "\n");
    const snapshot = await analyzeMachineSessions({ ...fixture, dataDir, offline: true });
    const session = snapshot.sessions.find(({ firstEventAt }) => firstEventAt === "2026-07-21T09:00:00.000Z")!;
    assert.ok(session); assert.equal(session.cost.inputUsd, 1.2);
    assert.equal(session.cost.cacheWriteUsd, (10 * 7.5 + 10 * 12) / 1e6);
    assert.equal(session.cost.cachedInputUsd, 10 * 0.6 / 1e6);
    assert.equal(session.cost.outputUsd, 10 * 22.5 / 1e6);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(privateSentinel));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("coverage counts priced requests when the same model is missing from an earlier snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pricing-partial-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    const dataDir = join(directory, "data");
    await saveSnapshot(pricingDirectory({ dataDir }), sourceSnapshot("models.dev", "2026-01-01T00:00:00.000Z"));
    const second = sourceSnapshot("models.dev", "2026-02-01T00:00:00.000Z");
    second.models["claude-late"] = second.models["claude-fixture-4-5"]!;
    await saveSnapshot(pricingDirectory({ dataDir }), second);
    const root = join(fixture.claudeRoot, "-pricing-partial"); await mkdir(root);
    const id = "99999999-1111-4111-8111-111111111111";
    await writeFile(join(root, `${id}.jsonl`), ["2026-01-15T00:00:00Z", "2026-02-15T00:00:00Z"].map((timestamp) => JSON.stringify({
      type: "assistant", timestamp, sessionId: id, cwd: fixture.repositoryRoot, uuid: timestamp,
      message: { id: timestamp, model: "claude-late", content: [{ type: "text", text: privateSentinel }], usage: { input_tokens: 100, output_tokens: 0 } },
    })).join("\n") + "\n");
    const snapshot = await analyzeMachineSessions({ ...fixture, dataDir, offline: true });
    const session = snapshot.sessions.find(({ models }) => models.some(({ model }) => model === "claude-late"))!;
    assert.equal(session.models[0]?.priced, false);
    assert.deepEqual(session.models[0]?.pricingCoverage, { eligibleTokens: 200, pricedTokens: 100 });
    assert.equal(session.models[0]?.pricing?.length, 1);
    assert.equal(session.pricedTokenCoverage, 0.5); assert.equal(session.costComplete, false);
    assert.deepEqual(snapshot.spendByModel.find(({ model }) => model === "claude-late")?.pricingCoverage,
      { eligibleTokens: 200, pricedTokens: 100 });
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(privateSentinel));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
