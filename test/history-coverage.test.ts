import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";
import type { HistoryCoverage } from "../src/metrics/history-types.ts";
import { collectHistoryCoverage } from "../src/metrics/history-coverage.ts";
import { loadPricingCatalog } from "../src/pricing/catalog.ts";
import { emptySession } from "../src/providers/common.ts";
import { calculateCost } from "../src/analyzer.ts";
import { filterSnapshot } from "../src/public/export-data.js";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { projectSession } from "../src/store/projection.ts";
import { historyReport } from "../src/report/history.ts";

test("history: daily model reconciliation cannot offset missing days with excess session evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-coverage-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const sentinel = "/private/HISTORY-STATS-SECRET command --token=secret";
    await writeFile(join(fixture.claudeRoot, "stats-cache.json"), JSON.stringify({
      version: 5, dailyModelTokensVersion: 5, lastComputedDate: "2026-07-20", longestSession: { sessionId: sentinel, content: sentinel },
      dailyModelTokens: [
        { date: "2026-07-19", tokensByModel: { "claude-opus-5": 1000 } },
        { date: "2026-07-20", tokensByModel: { "claude-opus-5": 1200 } },
        { date: sentinel, tokensByModel: { [sentinel]: 999999 } },
      ],
      modelUsage: { "claude-opus-5": { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 700, cacheCreationInputTokens: 0, costUSD: 999999, content: sentinel } },
    }));
    const result = await analyzeMachineSessions({ ...fixture, repositoryRoot: undefined });
    const history = (result as unknown as { historyCoverage: HistoryCoverage }).historyCoverage;
    assert.ok(history, "provider statistics coverage must be present");
    const p = history.profiles.find((p) => p.status === "available")!;
    const m = p.months[0]!.models[0]!;
    assert.equal(m.providerTokens, 2200); assert.equal(m.sessionTokens, 800);
    assert.equal(m.sessionStatisticsTokens, 1440, "v5 counts repeated streamed blocks; these known counters must not become a false gap");
    assert.equal(m.gapTokens, 1000); assert.equal(m.unattributedTokens, 1000);
    assert.equal(m.pricedUnattributedTokens, 1000); assert.ok(m.unattributedEstimateUsd > 0);
    assert.equal(p.firstStatisticsDay, "2026-07-19"); assert.equal(p.firstTranscriptDay, "2026-07-20");
    assert.ok(!JSON.stringify(result).includes(sentinel));
    assert.ok(!JSON.stringify(history).includes(root));
    assert.equal(history.months[0]!.unattributedEstimateUsd, m.unattributedEstimateUsd);
    // Statistics remain a separate estimate, never synthetic repository sessions.
    assert.equal(result.summary.sessions, 5);
    assert.equal(result.summary.estimatedSpendUsd, result.sessions.reduce((n,s) => n + s.cost.totalUsd, 0));
    assert.equal(validateSnapshot(result).historyCoverage, history);
    assert.deepEqual(filterSnapshot(result).historyCoverage, history);
    assert.equal(filterSnapshot(result, { start: "2026-07-19T00:00:00Z" }).historyCoverage, undefined);
    assert.match(historyReport(result), /History coverage/);
    assert.ok(!historyReport(result).includes(sentinel));
    for (const session of result.sessions) assert.deepEqual(projectSession(session), session);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("history: unknown-profile overlap is consumed once across profiles and never across days/models", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-profiles-"));
  try {
    const model = "claude-opus-5", profiles = [join(root, "profile-a"), join(root, "profile-b")];
    for (const profile of profiles) {
      await mkdir(profile);
      await writeFile(join(profile, "stats-cache.json"), JSON.stringify({ dailyModelTokensVersion: 5, lastComputedDate: "2026-07-20",
        modelUsage: { [model]: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 700, cacheCreationInputTokens: 0 } },
        dailyModelTokens: [{ date: "2026-07-20", tokensByModel: { [model]: 101 } }, { date: "2026-07-20", tokensByModel: { [model]: 100 } }] }));
    }
    await symlink(profiles[0]!, join(root, "alias"));
    const rates = await loadPricingCatalog({ dataDir: root, pricingPolicy: "reviewed-only", offline: true });
    const session = emptySession({ id: "private", path: "", cwd: null, createdAt: "2026-07-20T12:00:00Z", updatedAt: "2026-07-20T12:00:00Z" }, "claude", { repository: { id: "private", name: "Synthetic" }, rateCard: rates, price: calculateCost }, { source: "conductor-messages", fidelity: "message", tokens: "reported", tools: "observed", turns: "unavailable", timing: "provider", usageUnit: "request" });
    session.history = { days: [{ day: "2026-07-20", model, tokens: 101, valueUsd: 1 }, { day: "2026-07-19", model, tokens: 999, valueUsd: 1 }, { day: "2026-07-20", model: "different-model", tokens: 999, valueUsd: 1 }], undatedTokens: 2, undatedValueUsd: 0 };
    const result = await collectHistoryCoverage([...profiles, join(root, "alias")], [session], rates);
    assert.equal(result.profiles.length, 2);
    const models = result.profiles.flatMap((p) => p.months.flatMap((m) => m.models));
    assert.equal(models.reduce((n,m) => n + m.providerTokens, 0), 202);
    assert.equal(models.reduce((n,m) => n + m.possibleOverlapTokens, 0), 101);
    assert.equal(models.reduce((n,m) => n + m.unattributedTokens, 0), 101);
    assert.deepEqual(models.map((m) => m.possibleOverlapTokens).sort(), [50, 51]);
    assert.equal(result.unassignedProfileTokens, 2101);
    assert.ok(!JSON.stringify(result).includes(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("history: stats-only profiles are discovered; unsupported, malformed, absent and unpriced stores stay explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-missing-"));
  try {
    const old = join(root, ".claude-old"), valid = join(root, ".claude-kept"), bad = join(root, "bad");
    for (const profile of [old, valid, bad]) await mkdir(profile);
    await writeFile(join(old, "stats-cache.json"), JSON.stringify({ dailyModelTokensVersion: 2, dailyModelTokens: [{ date: "2026-08-01", tokensByModel: { "claude-opus-5": 2000 } }] }));
    await writeFile(join(valid, "stats-cache.json"), JSON.stringify({ dailyModelTokensVersion: 5, dailyModelTokens: [{ date: "2026-08-01", tokensByModel: { "unpriced-model": 2000, "claude-opus-5": -1 } }] }));
    await writeFile(join(bad, "stats-cache.json"), "private malformed sentinel");
    const rates = await loadPricingCatalog({ dataDir: root, pricingPolicy: "reviewed-only", offline: true });
    const result = await collectHistoryCoverage([bad, join(root, "missing")], [], rates, { home: root });
    assert.deepEqual(result.profiles.map((p) => p.status).sort(), ["available", "missing", "unreadable", "unsupported"]);
    assert.equal(result.months[0]!.unattributedTokens, 2000);
    assert.equal(result.months[0]!.pricedUnattributedTokens, 0);
    assert.equal(result.months[0]!.unattributedEstimateUsd, 0);
    assert.ok(!JSON.stringify(result).includes("sentinel"));
    const explicit = await collectHistoryCoverage([bad], [], rates);
    assert.equal(explicit.profiles.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("history: recovered sessions and stream-counter comparisons survive full, cold, warm and export projections", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-03T10:05:00Z") });
  const root = await mkdtemp(join(tmpdir(), "history-roundtrip-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root), sentinel = "HISTORY_PRIVATE_CONTENT_credential";
    const db = new DatabaseSync(fixture.databasePath);
    db.exec("CREATE TABLE session_messages (id TEXT,session_id TEXT,content TEXT,full_message TEXT,created_at TEXT,sdk_message_id TEXT)");
    db.prepare("INSERT INTO sessions SELECT 'history-row',status,agent_type,title,'2026-07-10T12:00:00Z',updated_at,'88888888-8888-4888-8888-888888888888',model,is_hidden,workspace_id FROM sessions WHERE id='conductor-claude'").run();
    for (const output of [10, 20]) {
      const data = { type: "assistant", uuid: `HISTORY_PRIVATE_RECORD_${output}`, session_id: "88888888-8888-4888-8888-888888888888", timestamp: "2026-07-10T12:00:00Z", message: {
        model: "claude-opus-5", usage: { input_tokens: 100, output_tokens: output }, content: [{ type: "text", text: sentinel }, { type: "tool_use", id: "HISTORY_PRIVATE_TOOL", name: "Read", input: { path: sentinel } }],
      } };
      db.prepare("INSERT INTO session_messages VALUES (?,?,?,?,?,?)").run(`row-${output}`, "history-row", JSON.stringify(data), JSON.stringify(data), data.timestamp, data.uuid);
    }
    db.close();
    await writeFile(join(fixture.claudeRoot, "stats-cache.json"), JSON.stringify({ dailyModelTokensVersion: 5,
      dailyModelTokens: [{ date: "2026-07-10", tokensByModel: { "claude-opus-5": 230 } }],
      modelUsage: { "claude-opus-5": { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    }));
    const options = { ...fixture, repositoryRoot: undefined, offline: true, noIndex: false };
    const full = validateSnapshot(await analyzeMachineSessions({ ...options, noIndex: true }));
    const cold = validateSnapshot(await analyzeMachineSessions(options));
    const warm = validateSnapshot(await analyzeMachineSessions(options));
    assert.deepEqual(cold, full); assert.deepEqual(warm, full);
    const recovered = full.sessions.find((s) => s.evidence?.source === "conductor-messages")!;
    assert.ok(recovered); assert.equal(recovered.tokens.inputTokens + recovered.tokens.outputTokens, 120);
    assert.equal(recovered.historyStatistics!.days[0]!.tokens, 230, "copies of each SDK record only count once in the statistics overlap pool");
    assert.equal(full.historyCoverage!.months[0]!.possibleOverlapTokens, 230);
    assert.equal(full.historyCoverage!.months[0]!.unattributedTokens, 0);
    assert.deepEqual(projectSession(recovered), recovered);
    const exported = validateSnapshot(filterSnapshot(full));
    assert.deepEqual(exported.sessions, full.sessions);
    assert.deepEqual(exported.historyCoverage, full.historyCoverage);
    const report = historyReport(full);
    for (const output of [JSON.stringify(full), JSON.stringify(filterSnapshot(full)), report]) assert.doesNotMatch(output, /HISTORY_PRIVATE_|88888888|history-row/);
    const corrupted = structuredClone(full);
    corrupted.historyCoverage!.months[0]!.unattributedTokens++;
    assert.throws(() => validateSnapshot(corrupted), /invalid/);
    const unknown = structuredClone(full);
    (unknown.historyCoverage as unknown as Record<string, unknown>)["prompt"] = sentinel;
    assert.throws(() => validateSnapshot(unknown), /invalid/);
    const invalidDay = structuredClone(full);
    invalidDay.sessions.find((s) => s.historyStatistics)!.historyStatistics!.days[0]!.day = "2026-02-31";
    assert.throws(() => validateSnapshot(invalidDay), /invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
