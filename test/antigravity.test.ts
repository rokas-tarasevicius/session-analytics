import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAntigravityDemoDatabase, proto, protoTime } from "../scripts/demo-antigravity.ts";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { analyzeOptionsFrom } from "../src/options.ts";
import { antigravityAdapter, antigravityWarnings } from "../src/providers/antigravity.ts";
import { priceUsage } from "../src/pricing/usage.ts";
import type { ProviderContext, ProviderSession } from "../src/providers/adapter.ts";
import { providerEvidenceRows, providerIds } from "../src/public/providers.js";
import { openIndexDatabase, pruneIndex } from "../src/store/database.ts";
import type { AnalyzeOptions } from "../src/types.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const id = "a1000000-0000-4000-8000-000000000001", otherId = "a1000000-0000-4000-8000-000000000002";
const at = "2026-10-18T10:00:00.000Z", later = "2026-10-18T10:05:00.000Z";
const context: ProviderContext = { repository: { id: "discovered-01234567890123456789", name: "synthetic" }, rateCard: { currency: "USD", effectiveDate: "2026-10-01", models: { "claude-sonnet-5": { provider: "claude", inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWrite5mPerMillion: 3.75, source: "https://example.com" } } }, price: (rate, usage, size) => priceUsage(rate, usage, size).cost };

async function fixture(run: (root: string, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "antigravity-test-")), path = join(root, "antigravity", "conversations", `${id}.db`);
  try { createAntigravityDemoDatabase(path, id, join(root, "repo"), at, later); await run(root, path); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function change(path: string, run: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path); try { run(db); } finally { db.close(); }
}
async function parse(root: string) {
  const adapter = antigravityAdapter(), warnings: string[] = [];
  const identities: ProviderSession[] = [];
  for await (const identity of adapter.identify(root, (warning) => warnings.push(warning))) identities.push(identity);
  const sessions = [];
  for (const identity of identities) sessions.push((await adapter.analyze(identity, context))!);
  return { sessions, identities, warnings };
}
const generation = (usage: Buffer, time: string | null = later, model: string | null = "claude-sonnet-5"): Buffer => proto([1, proto([4, usage], ...(time ? [[9, proto([4, protoTime(time)])] as [number, Buffer]] : []), ...(model ? [[19, model] as [number, string]] : []))]);

test("Antigravity: discovers app, IDE and CLI roots, explicit roots and opt-out flag precedence", async () => {
  const adapter = antigravityAdapter();
  const options = analyzeOptionsFrom(["--antigravity-root", "/flag", "--no-additional-providers"], { SESSION_ANALYTICS_ANTIGRAVITY_ROOT: "/env" });
  assert.equal(options.antigravityRoot, "/flag"); assert.equal(options.additionalProviders, false);
  assert.equal(analyzeOptionsFrom([], { SESSION_ANALYTICS_ANTIGRAVITY_ROOT: "/env" }).antigravityRoot, "/env");
  await fixture(async (root, path) => {
    const defaultRoot = join(root, ".gemini"), override = join(root, "override");
    assert.deepEqual(await adapter.discoverRoots({ home: root, options: {}, environment: {} }), []);
    assert.deepEqual(await adapter.discoverRoots({ home: root, options: { antigravityRoot: override }, environment: {} }), [override]);
    await mkdir(defaultRoot);
    assert.deepEqual(await adapter.discoverRoots({ home: root, options: {}, environment: {} }), []);
    await mkdir(join(defaultRoot, "antigravity", "conversations"), { recursive: true });
    assert.deepEqual(await adapter.discoverRoots({ home: root, options: {}, environment: {} }), [defaultRoot]);
    for (const surface of ["antigravity-ide", "antigravity-cli"]) {
      const target = join(root, surface, "conversations", `${id}.db`);
      await mkdir(dirname(target), { recursive: true }); await copyFile(path, target);
    }
    assert.equal((await parse(root)).sessions.length, 1); // The freshest copy is selected before ownership reconciliation.
    assert.equal((await parse(join(root, "antigravity"))).sessions.length, 1);
    assert.equal((await parse(join(root, "missing"))).sessions.length, 0);
  });
});

test("Antigravity: uses the generation ledger once, separates cache classes and includes thinking in output", async () => {
  await fixture(async (root) => {
    const { sessions, warnings } = await parse(root), s = sessions[0]!;
    assert.deepEqual(warnings, []);
    assert.equal(s.tokens.inputTokens, 3100); assert.equal(s.tokens.uncachedInputTokens, 1000);
    assert.equal(s.tokens.cachedInputTokens, 2000); assert.equal(s.tokens.cacheWriteInputTokens, 100);
    assert.equal(s.tokens.outputTokens, 400); assert.equal(s.tokens.reasoningOutputTokens, 150);
    assert.equal(s.tokens.nonReasoningOutputTokens, 250); assert.equal(s.metrics.modelCalls, 1);
    assert.equal(s.metrics.userTurns, 1); assert.equal(s.metrics.assistantMessages, 1);
    assert.deepEqual(s.tools, { run_command: 1 });
    assert.equal(s.evidence?.tokens, "reported"); assert.equal(s.evidence?.accounting, undefined);
    assert.equal(s.metrics.durationMilliseconds, 300_000);
    assert.equal(s.models[0]?.model, "claude-sonnet-5");
    assert.equal(s.models[0]?.priced, true);
    assert.ok(Math.abs(s.cost.totalUsd - 0.009975) < 1e-12);
    assert.equal(s.costBasis, "api-list-price-equivalent");
    assert.deepEqual(Object.keys(s.spendByDay), ["2026-10-18"]);
    assert.equal(s.velocity?.buckets.reduce((sum, row) => sum + row[3][1], 0), 3100);
    assert.ok(providerIds.includes("antigravity"));
    assert.equal(providerEvidenceRows([s])[0]?.source, "Antigravity conversations");
    const serialized = JSON.stringify(s);
    for (const secret of ["PRIVATE_DEMO_CONTENT_SENTINEL", root, id, "response-", "message-", "execution-", "tool-"]) assert.ok(!serialized.includes(secret));
  });
});

test("Antigravity: keeps distinct equal-sized requests and deduplicates copied response IDs", async () => {
  await fixture(async (root, path) => {
    change(path, (db) => {
      const original = db.prepare("SELECT data FROM gen_metadata WHERE idx=0").get()!["data"]!;
      db.prepare("INSERT INTO gen_metadata VALUES (1,?,0)").run(original);
      db.prepare("INSERT INTO gen_metadata VALUES (2,?,0)").run(generation(proto([2, 1000], [3, 400], [4, 100], [5, 2000], [9, 150], [11, "distinct-response"])));
    });
    const { sessions } = await parse(root), s = sessions[0]!;
    assert.equal(s.tokens.inputTokens, 6200); assert.equal(s.metrics.modelCalls, 2);
    assert.equal(s.evidence?.accounting, undefined);
  });
});

test("Antigravity: unknown numeric models stay unpriced and absent reasoning remains unknown", async () => {
  await fixture(async (root, path) => {
    change(path, (db) => db.prepare("UPDATE gen_metadata SET data=?").run(generation(proto([1, 999], [2, 30], [3, 20]), later, null)));
    const s = (await parse(root)).sessions[0]!;
    assert.equal(s.tokens.inputTokens, 30); assert.equal(s.tokens.outputTokens, 20);
    assert.equal(s.tokens.nonReasoningOutputTokens, 0); assert.equal(s.tokens.reasoningOutputTokens, 0);
    assert.equal(s.models[0]?.model, "antigravity-model-999"); assert.equal(s.costBasis, "unavailable");
    assert.equal(s.pricedTokenCoverage, 0); assert.equal(s.costComplete, false);
    assert.equal(s.velocity?.buckets.reduce((sum, row) => sum + row[3][11], 0), 0);
  });
});

test("Antigravity: actual model metadata uses the shared public identifier policy before pricing or storage", async () => {
  await fixture(async (root, path) => {
    for (const model of ["message-private-marker", "session-private-marker", "repo/file.txt", "a".repeat(161)]) {
      change(path, (db) => db.prepare("UPDATE gen_metadata SET data=?").run(generation(proto([2, 10], [3, 5]), later, model)));
      const session = (await parse(root)).sessions[0]!;
      assert.equal(session.models[0]?.model, "<unknown>");
      assert.ok(!JSON.stringify(session).includes(model));
    }
  });
});

test("Antigravity: supports the older step ledger and session-dates usage without a request timestamp", async () => {
  await fixture(async (root, path) => {
    change(path, (db) => db.exec("DELETE FROM gen_metadata"));
    const s = (await parse(root)).sessions[0]!;
    assert.equal(s.tokens.inputTokens, 3100); assert.equal(s.metrics.modelCalls, 1);
    assert.equal(s.models[0]?.model, "antigravity-model-101"); assert.equal(s.costBasis, "unavailable");
    change(path, (db) => db.prepare("INSERT INTO gen_metadata VALUES (0,?,0)").run(generation(proto([2, 10], [3, 5]), null)));
    const undated = (await parse(root)).sessions[0]!;
    assert.equal(undated.tokens.inputTokens, 10);
    assert.equal(undated.velocity?.sessionDated?.reduce((sum, row) => sum + row[3][1], 0), 10);
  });
});

test("Antigravity: only unique message/execution joins establish a missing request time", async () => {
  await fixture(async (root, path) => {
    change(path, (db) => db.prepare("UPDATE gen_metadata SET data=?").run(generation(proto([2, 12], [3, 3], [7, `message-${id}`]), null)));
    const unique = (await parse(root)).sessions[0]!;
    assert.equal(unique.velocity?.sessionDated, undefined);
    assert.equal(unique.velocity?.buckets.reduce((sum, row) => sum + row[3][1], 0), 12);
    change(path, (db) => db.prepare("INSERT INTO steps SELECT 3,step_type,status,metadata,step_payload FROM steps WHERE idx=1").run());
    const ambiguous = (await parse(root)).sessions[0]!;
    assert.equal(ambiguous.velocity?.sessionDated?.reduce((sum, row) => sum + row[3][1], 0), 12);
  });
});

test("Antigravity: conflicting IDs, malformed and oversized protobuf retain valid siblings as partial", async () => {
  await fixture(async (root, path) => {
    change(path, (db) => {
      const insert = db.prepare("INSERT INTO gen_metadata VALUES (?,?,0)");
      insert.run(1, generation(proto([2, 999], [3, 1], [11, `response-${id}`])));
      insert.run(2, Buffer.from([10, 127, 1])); // Truncated length-delimited field.
      insert.run(3, Buffer.alloc(1024 * 1024 + 1));
      insert.run(4, generation(proto([2, 2n ** 63n], [3, 10])));
      insert.run(5, generation(proto([2, 1], [3, 1], [9, 2])));
      insert.run(6, generation(proto([1, 99]))); // An unfinished call is not a model request.
    });
    const s = (await parse(root)).sessions[0]!;
    assert.equal(s.tokens.inputTokens, 3100); assert.equal(s.metrics.modelCalls, 1);
    assert.equal(s.evidence?.accounting, "partial"); assert.equal(s.costComplete, false);
    assert.ok(s.transcript.warnings.includes(antigravityWarnings.partial));
    change(path, (db) => db.exec("DELETE FROM gen_metadata WHERE idx=0 OR idx=1 OR idx=6"));
    const corrupt = (await parse(root)).sessions[0]!;
    assert.equal(corrupt.tokens.inputTokens, 0); // Never revive usage from the step mirror.
    assert.equal(corrupt.evidence?.tokens, "unavailable");
  });
});

test("Antigravity: reports unsupported legacy files and corrupt schemas without leaking errors", async () => {
  await fixture(async (root, path) => {
    const directory = dirname(path);
    await writeFile(join(directory, `${otherId}.pb`), "PRIVATE_DEMO_CONTENT_SENTINEL");
    await writeFile(join(directory, `${otherId}.db`), "PRIVATE_DEMO_CONTENT_SENTINEL");
    const result = await parse(root);
    assert.equal(result.sessions.length, 1);
    assert.ok(result.warnings.includes(antigravityWarnings.legacy));
    assert.ok(result.warnings.includes(antigravityWarnings.unreadable));
    change(path, (db) => db.exec("PRAGMA user_version=2"));
    assert.equal((await parse(root)).sessions.length, 0);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_DEMO_CONTENT_SENTINEL"));
  });
});

test("Antigravity: requires filename identity, ignores source symlinks and never attributes a remote file URI", async () => {
  await fixture(async (root, path) => {
    await symlink(path, join(dirname(path), `${otherId}.db`));
    assert.equal((await parse(root)).sessions.length, 1);
    change(path, (db) => db.prepare("UPDATE trajectory_metadata_blob SET data=?").run(proto([1, proto([1, "file://remote-host/secret/path"])], [2, protoTime(at)])));
    assert.equal((await parse(root)).identities[0]?.cwd, null);
    change(path, (db) => db.prepare("UPDATE trajectory_metadata_blob SET data=?").run(proto([1, proto([1, "/workspace/one"])], [1, proto([1, "/workspace/two"])], [2, protoTime(at)])));
    assert.equal((await parse(root)).identities[0]?.cwd, null);
    change(path, (db) => db.prepare("UPDATE trajectory_meta SET cascade_id=?").run(otherId));
    assert.equal((await parse(root)).sessions.length, 0);
  });
});

test("Antigravity: shared response identities exclude inherited usage from forks", async () => {
  await fixture(async (root, path) => {
    const child = join(dirname(path), `${otherId}.db`);
    await copyFile(path, child);
    change(child, (db) => {
      db.prepare("UPDATE trajectory_meta SET cascade_id=?").run(otherId);
      db.prepare("INSERT INTO parent_references VALUES (0,?)").run(proto([1, id]));
      db.prepare("INSERT INTO gen_metadata VALUES (1,?,0)").run(generation(proto([2, 25], [3, 5], [11, "fork-new-response"])));
      db.prepare("INSERT INTO gen_metadata VALUES (2,?,0)").run(generation(proto([2, 9999], [3, 9999])));
    });
    const sessions = (await parse(root)).sessions;
    assert.equal(sessions.length, 2);
    assert.equal(sessions.reduce((sum, s) => sum + s.tokens.inputTokens, 0), 3125);
    assert.equal(sessions.reduce((sum, s) => sum + s.metrics.modelCalls, 0), 2);
    assert.equal(sessions[1]?.evidence?.accounting, "partial");
  });
});

test("Antigravity: request owners survive index reopen, parent loss, reappearance and pruning", { timeout: 60_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T15:00:00Z") });
  await fixture(async (root, path) => {
    const f = await createSessionAnalyticsFixture(join(root, "native"));
    const options: AnalyzeOptions = { ...f, noIndex: false, repositoryRoot: undefined, offline: true, antigravityRoot: root, pricingPolicy: "reviewed-only" };
    const child = join(dirname(path), `${otherId}.db`), backup = join(root, "parent-backup.db");
    await copyFile(path, child); await copyFile(path, backup);
    change(child, (db) => {
      db.prepare("UPDATE trajectory_meta SET cascade_id=?").run(otherId);
      db.prepare("UPDATE trajectory_metadata_blob SET data=?").run(proto([1, proto([1, join(root, "repo")])], [2, protoTime("2026-10-19T10:00:00Z")]));
      db.prepare("INSERT INTO parent_references VALUES (0,?)").run(proto([1, id]));
      db.prepare("INSERT INTO gen_metadata VALUES (1,?,0)").run(generation(proto([2, 25], [3, 5], [11, "fork-new-response"]), "2026-10-19T10:05:00Z"));
    });
    const selected = async () => validateSnapshot(await analyzeMachineSessions(options)).sessions.filter((s) => s.provider === "antigravity");
    const total = (sessions: Awaited<ReturnType<typeof selected>>) => sessions.reduce((n, s) => n + s.tokens.inputTokens, 0);
    const full = validateSnapshot(await analyzeMachineSessions({ ...options, noIndex: true })).sessions.filter((s) => s.provider === "antigravity");
    const first = await selected(); assert.equal(total(first), 3125); assert.deepEqual(first, full);
    assert.deepEqual(await selected(), first);
    await rm(path);
    const absent = await selected(); assert.equal(total(absent), 3125);
    assert.equal(absent.find((s) => s.tokens.inputTokens === 3100)?.transcript.sourceDeleted, true);
    await copyFile(backup, path); assert.equal(total(await selected()), 3125);
    await rm(path);
    assert.ok(pruneIndex("2026-10-19", options) > 0);
    assert.equal(total(await selected()), 25);
    await copyFile(backup, path); assert.equal(total(await selected()), 25);
    const connection = openIndexDatabase(options);
    try {
      const disk = JSON.stringify(connection.database.prepare("SELECT owned_counters FROM sessions").all());
      assert.ok(disk.includes("provider-request:"));
      for (const secret of [id, otherId, "fork-new-response", `response-${id}`, root]) assert.ok(!disk.includes(secret));
    } finally { connection.close(); }
  });
});

test("Antigravity: a complete rewritten owner releases old claims to surviving fork evidence immediately", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T15:00:00Z") });
  await fixture(async (root, path) => {
    const f = await createSessionAnalyticsFixture(join(root, "native"));
    const options: AnalyzeOptions = { ...f, noIndex: false, repositoryRoot: undefined, offline: true, antigravityRoot: root, pricingPolicy: "reviewed-only" };
    const child = join(dirname(path), `${otherId}.db`);
    await copyFile(path, child);
    change(child, (db) => {
      db.prepare("UPDATE trajectory_meta SET cascade_id=?").run(otherId);
      db.prepare("INSERT INTO parent_references VALUES (0,?)").run(proto([1, id]));
    });
    const selected = async (noIndex = false) => validateSnapshot(await analyzeMachineSessions({ ...options, noIndex })).sessions.filter((s) => s.provider === "antigravity");
    assert.equal((await selected()).reduce((n, s) => n + s.tokens.inputTokens, 0), 3100);
    change(path, (db) => db.exec("DELETE FROM gen_metadata; DELETE FROM steps"));
    const full = await selected(true), refreshed = await selected();
    assert.equal(refreshed.reduce((n, s) => n + s.tokens.inputTokens, 0), 3100);
    assert.deepEqual(refreshed, full); assert.deepEqual(await selected(), full);
  });
});

test("Antigravity: a healthy fork relinquishes removed claims before its restored parent is analyzed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T15:00:00Z") });
  await fixture(async (root, path) => {
    const f = await createSessionAnalyticsFixture(join(root, "native"));
    const options: AnalyzeOptions = { ...f, noIndex: false, repositoryRoot: undefined, offline: true, antigravityRoot: root, pricingPolicy: "reviewed-only" };
    const backup = join(root, "parent-backup.db"), child = join(dirname(path), `${otherId}.db`);
    await copyFile(path, backup); await copyFile(path, child); await rm(path);
    change(child, (db) => {
      db.prepare("UPDATE trajectory_meta SET cascade_id=?").run(otherId);
      db.prepare("INSERT INTO parent_references VALUES (0,?)").run(proto([1, id]));
      db.prepare("INSERT INTO gen_metadata VALUES (1,?,0)").run(generation(proto([2, 17], [3, 5], [11, "fork-owned-new-response"])));
    });
    const selected = async (noIndex = false) => validateSnapshot(await analyzeMachineSessions({ ...options, noIndex })).sessions.filter((s) => s.provider === "antigravity");
    const total = (sessions: Awaited<ReturnType<typeof selected>>) => sessions.reduce((n, s) => n + s.tokens.inputTokens, 0);
    assert.equal(total(await selected()), 3117);
    await copyFile(backup, path); assert.equal(total(await selected()), 3117);
    change(child, (db) => db.exec("DELETE FROM gen_metadata WHERE idx=0; DELETE FROM steps WHERE idx=1"));
    const full = await selected(true), refreshed = await selected();
    assert.equal(total(refreshed), 3117); assert.deepEqual(refreshed, full);
    assert.deepEqual(await selected(), full);
  });
});

test("Antigravity: reads committed WAL rows in a read-only snapshot and leaves source bytes unchanged", async () => {
  await fixture(async (root, path) => {
    const writer = new DatabaseSync(path);
    try {
      writer.exec("PRAGMA journal_mode=WAL");
      writer.prepare("INSERT INTO gen_metadata VALUES (1,?,0)").run(generation(proto([2, 50], [3, 10], [11, "wal-response"])));
      const before = await readFile(path), wal = await readFile(`${path}-wal`);
      assert.equal((await parse(root)).sessions[0]?.tokens.inputTokens, 3150);
      assert.deepEqual(await readFile(path), before); assert.deepEqual(await readFile(`${path}-wal`), wal);
    } finally { writer.close(); }
    await chmod(path, 0o444);
    try { assert.equal((await parse(root)).sessions[0]?.tokens.inputTokens, 3150); }
    finally { await chmod(path, 0o644); }
  });
});

test("Antigravity: full scan, cold/warm index, CLI JSON, schema, and private disk projection agree", { timeout: 60_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T15:00:00Z") });
  await fixture(async (root, path) => {
    const f = await createSessionAnalyticsFixture(join(root, "native"));
    const options: AnalyzeOptions = { ...f, noIndex: false, repositoryRoot: undefined, offline: true, additionalProviders: false, antigravityRoot: root, pricingPolicy: "reviewed-only" };
    // A copied session in another surface must not add a session or its counters.
    const copy = join(root, "antigravity-ide", "conversations", `${id}.db`);
    await mkdir(dirname(copy), { recursive: true }); await copyFile(path, copy);
    const full = validateSnapshot(await analyzeMachineSessions({ ...options, noIndex: true }));
    assert.equal(full.sessions.filter((s) => s.provider === "antigravity").length, 1);
    assert.deepEqual(validateSnapshot(await analyzeMachineSessions(options)), full);
    assert.deepEqual(validateSnapshot(await analyzeMachineSessions(options)), full);
    const connection = openIndexDatabase(options);
    try {
      const rows = connection.database.prepare("SELECT payload FROM sessions").all();
      const disk = JSON.stringify(rows);
      for (const secret of ["PRIVATE_DEMO_CONTENT_SENTINEL", root, id, "response-", "message-", "execution-"]) assert.ok(!disk.includes(secret));
      assert.ok(rows.some((row) => JSON.parse(String(row["payload"])).provider === "antigravity"));
    } finally { connection.close(); }
    const command = ["bin/session-analytics.ts", "report", "--json", "--offline", "--no-index", "--no-additional-providers", "--antigravity-root", options.antigravityRoot!, "--claude-root", f.claudeRoot, "--codex-root", f.codexRoot, "--codex-archive-root", f.codexArchiveRoot, "--cursor-database", f.cursorDatabasePath, "--database", f.databasePath, "--data-dir", f.dataDir, "--pricing-policy", "reviewed-only"];
    const cli = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 30_000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(validateSnapshot(JSON.parse(cli.stdout)).sessions, full.sessions);
    const isolated = validateSnapshot(await analyzeMachineSessions({ ...options, antigravityRoot: join(root, "missing"), noIndex: false }));
    assert.equal(isolated.sessions.some((s) => s.provider === "antigravity"), false);
    const defaultDisabled = validateSnapshot(await analyzeMachineSessions({ ...options, antigravityRoot: undefined, noIndex: true }));
    assert.equal(defaultDisabled.sessions.some((s) => s.provider === "antigravity"), false);
    change(path, (db) => db.prepare("INSERT INTO gen_metadata VALUES (1,?,0)").run(generation(proto([2, 50], [3, 10], [11, "index-new-response"]))));
    const refreshed = validateSnapshot(await analyzeMachineSessions(options));
    assert.equal(refreshed.sessions.find((s) => s.provider === "antigravity")?.tokens.inputTokens, 3150);
    await rm(path); await rm(copy);
    const retained = validateSnapshot(await analyzeMachineSessions(options));
    const saved = retained.sessions.find((s) => s.provider === "antigravity");
    assert.equal(saved?.tokens.inputTokens, 3150); assert.equal(saved?.transcript.sourceDeleted, true);
  });
});
