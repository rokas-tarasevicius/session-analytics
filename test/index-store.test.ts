import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { inflateRawSync } from "node:zlib";
import { analyzeMachineSessions, analyzeRepositorySessions } from "../src/analyzer.ts";
import { analyzeOptionsFrom } from "../src/options.ts";
import { dataDirectory, indexPath, indexStatus, migrate, openIndexDatabase, pruneIndex, resetIndex, SCHEMA_VERSION, validatePruneDate } from "../src/store/database.ts";
import { fingerprint } from "../src/store/fingerprint.ts";
import { IndexScan, lastActivityAt } from "../src/store/index.ts";
import { projectSession, sessionForIndex } from "../src/store/projection.ts";
import type { AnalyzeOptions, MachineAnalytics, RateCard, SessionAnalytics } from "../src/types.ts";
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "./fixtures.ts";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(project, "bin/session-analytics.ts");
const jsonl = (records: unknown[]): string => records.map((value) => JSON.stringify(value)).join("\n") + "\n";
const codexId = "11111111-1111-4111-8111-111111111111";
const claudeId = "22222222-2222-4222-8222-222222222222";
async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]))).flat();
}
async function transcript(fixture: SessionAnalyticsFixture, provider: "claude" | "codex", id: string): Promise<string> {
  const found = (await files(provider === "claude" ? fixture.claudeRoot : fixture.codexRoot)).find((path) => path.endsWith(`${id}.jsonl`));
  assert.ok(found); return found;
}
function options(fixture: SessionAnalyticsFixture): AnalyzeOptions {
  return {
    claudeRoot: fixture.claudeRoot, codexRoot: fixture.codexRoot, codexArchiveRoot: fixture.codexArchiveRoot,
    cursorDatabasePath: fixture.cursorDatabasePath, databasePath: fixture.databasePath,
    dataDir: fixture.dataDir, includeHidden: true, additionalProviders: false, offline: true,
  };
}
function stable(snapshot: MachineAnalytics) { const { generatedAt, ...rest } = snapshot; void generatedAt; return rest; }
async function withFixture(run: (fixture: SessionAnalyticsFixture, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "session-analytics-index-test-"));
  try { await run(await createSessionAnalyticsFixture(root), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function broadcastPair(fixture: SessionAnalyticsFixture, undated = false) {
  await rm(fixture.codexRoot, { recursive: true });
  await rm(fixture.codexArchiveRoot, { recursive: true });
  await mkdir(fixture.codexRoot);
  await mkdir(fixture.codexArchiveRoot);
  const a = join(fixture.codexRoot, `rollout-${codexId}.jsonl`);
  const b = join(fixture.codexRoot, "rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
  const token = { type: "event_msg", ...(undated ? {} : { timestamp: "2026-07-20T10:00:00Z" }), payload: {
    type: "token_count", info: { total_token_usage: { input_tokens: 100 }, last_token_usage: { input_tokens: 100 } },
  } };
  const records = (id: string, activity: string) => [
    { type: "session_meta", timestamp: activity, payload: { id, cwd: "/fixtures/workspaces/conductor/codex-workspace" } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    { type: "event_msg", timestamp: activity, payload: { type: "agent_message" } }, token,
  ];
  await writeFile(a, jsonl(records(codexId, "2026-07-20T09:59:59Z")));
  await writeFile(b, jsonl(records("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-07-20T09:00:00Z")));
  return { a, b, token };
}

test("review: ownership transfer defers the entire component before source deletion", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), { a, b, token } = await broadcastPair(fixture);
    const initial = await analyzeMachineSessions(opts);
    assert.deepEqual(initial.sessions.filter((s) => s.provider === "codex").map((s) => s.tokens.inputTokens).sort((a,b) => a-b), [0,100]);
    await appendFile(b, jsonl([{ type: "event_msg", timestamp: token.timestamp, payload: { type: "agent_message" } }, token]));
    const commit = IndexScan.prototype.commit;
    IndexScan.prototype.commit = async function () {
      await appendFile(a, jsonl([{ type: "event_msg", timestamp: "2026-07-20T11:00:00Z", payload: { type: "task_complete" } }]));
      return commit.call(this);
    };
    try { await analyzeMachineSessions(opts); } finally { IndexScan.prototype.commit = commit; }
    const deferred = indexStatus(opts).lastScan?.deferredSessions;
    await rm(a); await rm(b);
    const retained = await analyzeMachineSessions(opts);
    assert.equal(retained.summary.workingSnapshots, 0);
    assert.equal(retained.sessions.filter((s) => s.provider === "codex").reduce((n,s) => n+s.tokens.inputTokens,0), 100);
    assert.equal(deferred, 2);
  });
});

test("review: mixed-offset event extrema survive a UTC prune boundary", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), path = await transcript(fixture, "claude", claudeId);
    await appendFile(path, jsonl(["2026-07-21T00:30:00Z", "2026-07-21T01:00:00+02:00"].map((timestamp) => ({ type: "queue-operation", timestamp }))));
    const before = await analyzeMachineSessions(opts);
    pruneIndex("2026-07-21", opts);
    const after = await analyzeMachineSessions(opts);
    assert.ok(after.sessions.some((s) => s.provider === "claude"));
    assert.equal(before.sessions.find((s) => s.provider === "claude")?.lastEventAt, "2026-07-21T00:30:00.000Z");
  });
});

test("review: legacy retention dates stay conservative until sources are revalidated", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture); const initial = await analyzeMachineSessions(opts);
    const db = new DatabaseSync(indexPath(opts));
    db.exec("ALTER TABLE sessions DROP COLUMN retention_verified; DROP TABLE exclusions; DROP TABLE claude_ownership; DROP TABLE conductor_records; DELETE FROM metadata WHERE key='key_verifier'; PRAGMA user_version=2;"); db.close();
    await rm(fixture.claudeRoot, { recursive: true });
    assert.equal(pruneIndex("2027-01-01", opts), 0);
    const after = await analyzeMachineSessions(opts);
    assert.equal(after.sessions.length, 1);
    assert.equal(after.sessions[0]?.sessionKey, initial.sessions.find((s) => s.provider === "claude")?.sessionKey);
    assert.equal(after.sessions[0]?.transcript.sourceDeleted, true);
    assert.ok(after.sessions[0]?.transcript.warnings.some((warning) => warning.startsWith("Legacy activity dates")));
    assert.equal(pruneIndex("2028-01-01", opts), 0);
  });
});

test("review: legacy key binding authenticates existing payloads before bootstrapping", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture); await analyzeMachineSessions(opts);
    const db = new DatabaseSync(indexPath(opts));
    db.exec("ALTER TABLE sessions DROP COLUMN retention_verified; DROP TABLE exclusions; DROP TABLE claude_ownership; DROP TABLE conductor_records; DELETE FROM metadata WHERE key='key_verifier'; PRAGMA user_version=2;"); db.close();
    const path = join(fixture.dataDir, "index.key"), original = await readFile(path);
    const changed = Buffer.from(original); changed[0] = changed[0]! ^ 1; await writeFile(path, changed);
    await assert.rejects(analyzeMachineSessions(opts), /integrity check/);
    const legacy = new DatabaseSync(indexPath(opts), { readOnly: true });
    try { assert.equal(legacy.prepare("PRAGMA user_version").get()?.["user_version"], 2); }
    finally { legacy.close(); }
    await writeFile(path, original);
    assert.equal((await analyzeMachineSessions(opts)).sessions.length, 5);
    const check = new DatabaseSync(indexPath(opts), { readOnly: true });
    try { assert.ok(check.prepare("SELECT value FROM metadata WHERE key='key_verifier'").get()); }
    finally { check.close(); }
  });
});

test("review: undated pruned sources reuse checkpoints without retaining usage payloads", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture); await broadcastPair(fixture, true);
    await analyzeMachineSessions(opts); pruneIndex("2027-01-01", opts);
    await analyzeMachineSessions(opts); await analyzeMachineSessions(opts);
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 0);
    const db = new DatabaseSync(indexPath(opts), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get()?.["n"], 0);
      const checkpoints = db.prepare("SELECT * FROM exclusions").all();
      assert.equal(checkpoints.length, 5);
      assert.ok(checkpoints.every((row) => Object.keys(row).sort().join(",") === "identity_key,scope,signature,source_keys"));
      assert.doesNotMatch(JSON.stringify(checkpoints), /secret|input_tokens|fixture|conductor/);
    } finally { db.close(); }
  });
});

test("review: ownership deferral follows a transitive chain including a vanished counter", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), { a, b, token } = await broadcastPair(fixture);
    const c = join(fixture.codexRoot, "rollout-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl");
    const second = { ...token, timestamp: "2026-07-20T12:00:00Z", payload: {
      type: "token_count", info: { total_token_usage: { input_tokens: 200 }, last_token_usage: { input_tokens: 100 } },
    } };
    await appendFile(b, jsonl([{ type: "event_msg", timestamp: "2026-07-20T11:59:59Z", payload: { type: "agent_message" } }, second]));
    await writeFile(c, jsonl([
      { type: "session_meta", timestamp: "2026-07-20T09:00:00Z", payload: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", cwd: "/fixtures/workspaces/conductor/codex-workspace" } }, second,
    ]));
    await analyzeMachineSessions(opts);
    // A no longer observes the first request. Its prior ownership must still connect it to B and C.
    const lines = (await readFile(a, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    await writeFile(a, jsonl(lines.filter((row) => row.payload?.type !== "token_count")));
    await appendFile(c, jsonl([{ type: "event_msg", timestamp: second.timestamp, payload: { type: "agent_message" } }, second]));
    const commit = IndexScan.prototype.commit;
    IndexScan.prototype.commit = async function () { await appendFile(a, "\n"); return commit.call(this); };
    try { await analyzeMachineSessions(opts); } finally { IndexScan.prototype.commit = commit; }
    assert.equal(indexStatus(opts).lastScan?.deferredSessions, 3);
    await rm(a); await rm(b); await rm(c);
    const retained = await analyzeMachineSessions(opts);
    assert.equal(retained.sessions.filter((s) => s.provider === "codex").reduce((n,s) => n+s.tokens.inputTokens,0), 200);
  });
});

test("review: requests first observed after the ledger pass still connect to their prior owner", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), { a, b, token } = await broadcastPair(fixture);
    await analyzeMachineSessions(opts);
    for (const path of [a,b]) {
      const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      await writeFile(path, jsonl(rows.filter((row) => row.payload?.type !== "token_count")));
    }
    const ledger = IndexScan.prototype.codexLedger;
    IndexScan.prototype.codexLedger = async function (path) {
      const result = await ledger.call(this, path);
      if (path === b) await appendFile(b, jsonl([token]));
      return result;
    };
    try { await analyzeMachineSessions(opts); } finally { IndexScan.prototype.codexLedger = ledger; }
    await rm(a); await rm(b);
    const retained = await analyzeMachineSessions(opts);
    assert.equal(retained.sessions.filter((s) => s.provider === "codex").reduce((n,s) => n+s.tokens.inputTokens,0), 100);
  });
});

for (const prune of [false, true]) test(`review: undated requests stay reserved after ${prune ? "pruning" : "owner deletion"}`, async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), { a, b } = await broadcastPair(fixture, true);
    await appendFile(b, jsonl([{ type: "event_msg", timestamp: "2026-07-22T00:00:00Z", payload: { type: "task_complete" } }]));
    await analyzeMachineSessions(opts); await rm(a);
    await analyzeMachineSessions(opts);
    if (prune) pruneIndex("2026-07-21", opts);
    const after = await analyzeMachineSessions(opts);
    assert.equal(after.sessions.filter((s) => s.provider === "codex" && !s.transcript.sourceDeleted).reduce((n,s) => n+s.tokens.inputTokens,0), 0);
  });
});

test("review: pruned unchanged sources use exclusion checkpoints and new activity re-enters", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture);
    await analyzeMachineSessions(opts); pruneIndex("2027-01-01", opts);
    await analyzeMachineSessions(opts);
    assert.equal((await analyzeMachineSessions(opts)).sessions.length, 0);
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 0);
    await appendFile(await transcript(fixture, "claude", claudeId), jsonl([{ type: "queue-operation", timestamp: "2027-01-02T00:00:00Z" }]));
    assert.equal((await analyzeMachineSessions(opts)).sessions.length, 1);
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 1);
  });
});

for (const prune of [false, true]) test(`review: same-length key mismatch fails closed with ${prune ? "retired reservations" : "deleted history"}`, async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture);
    await analyzeMachineSessions(opts);
    await rm(await transcript(fixture, "claude", claudeId));
    await analyzeMachineSessions(opts);
    if (prune) pruneIndex("2027-01-01", opts);
    const before = indexStatus(opts);
    const path = join(fixture.dataDir, "index.key"), key = await readFile(path);
    key[0] = key[0]! ^ 1; await writeFile(path, key);
    await assert.rejects(analyzeMachineSessions(opts), /integrity check/);
    assert.equal(indexStatus(opts).state, "corrupt");
    key[0] = key[0]! ^ 1; await writeFile(path, key);
    assert.equal(indexStatus(opts).sessions, before.sessions);
  });
});

test("review: corrupt writer coordination is diagnosed and rebuild repairs it", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture); await analyzeMachineSessions(opts);
    await writeFile(join(fixture.dataDir, "writer.sqlite"), "synthetic-corrupt-coordination-secret");
    assert.equal(indexStatus(opts).state, "corrupt");
    assert.throws(() => openIndexDatabase(opts), /coordination.*rebuild/);
    resetIndex(opts);
    assert.equal((await analyzeMachineSessions(opts)).sessions.length, 5);
  });
});

test("review: default repository projection shares retained machine history", async () => {
  await withFixture(async (fixture) => {
    const { includeHidden, ...opts } = options(fixture); void includeHidden;
    const initial = await analyzeMachineSessions(opts);
    await rm(fixture.claudeRoot, { recursive: true });
    const machine = await analyzeMachineSessions(opts);
    const repository = await analyzeRepositorySessions({ ...opts, repositoryRoot: fixture.repositoryRoot });
    assert.equal(machine.sessions.length, initial.sessions.length);
    assert.deepEqual(repository.sessions, machine.sessions.filter((s) => s.repositoryId === repository.repository.id));
  });
});

test("review: dashboard retains filtered history caveats and scan warnings without calling history live", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), db = new DatabaseSync(fixture.databasePath);
    db.exec("UPDATE sessions SET status='working'"); db.close();
    await analyzeMachineSessions(opts);
    await rm(fixture.claudeRoot, { recursive: true }); await rm(fixture.codexRoot, { recursive: true });
    await rm(fixture.codexArchiveRoot, { recursive: true }); await rm(fixture.cursorDatabasePath);
    const retained = await analyzeMachineSessions(opts);
    const deferred = "Evidence changed during analysis; unstable index groups were deferred until the next scan.";
    assert.equal(retained.summary.workingSnapshots, 0);
    retained.warnings.push(deferred);
    const source = (await readFile(join(project, "src/public/app.js"), "utf8"))
      .replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, "").split("const urlParameters =")[0]!;
    const helpers = { ...await import("../src/public/evidence.js"), ...await import("../src/public/export-data.js"),
      ...await import("../src/public/timestamps.js"), ...await import(new URL("../src/public/view-model.js", import.meta.url).href),
      ...await import(new URL("../src/public/providers.js", import.meta.url).href),
      ...await import(new URL("../src/public/velocity-data.js", import.meta.url).href),
      ...await import(new URL("../src/public/ui.js", import.meta.url).href) };
    const element = () => ({ value: "", textContent: "", dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, addEventListener() {}, querySelectorAll: () => [], replaceChildren() {}, append() {} });
    const elements = new Map<string, ReturnType<typeof element>>();
    const document = { addEventListener() {}, documentElement: { dataset: {} }, querySelectorAll: () => [], createElement: element, querySelector: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { ...element(), value: selector === "#repository-filter" ? "all" : "" });
      return elements.get(selector);
    } };
    (globalThis as any).document = document;
    const [view, filtered] = runInNewContext(source + `\nsnapshot = fixture; windowPreset = "all";
      const all = activeView();
      renderSparkline = renderLine = renderDonut = renderBars = renderRepositoryTable = renderRepositoryNav = renderProviderEvidence = () => {};
      renderSharedView(all); renderSummary(all);
      windowPreset = 'custom'; elements.windowStart.value = '2027-01-01';
      [all, activeView()];`, {
      ...helpers, renderHistoryCoverage() {}, fixture: retained, document, window: { matchMedia: () => ({ matches: false, addEventListener() {} }) }, URLSearchParams, localStorage: { getItem: () => null, setItem() {} }, fetch: () => new Promise(() => {}),
    });
    assert.ok(view.warnings.some((s: string) => s.includes("source-deleted")));
    assert.ok(view.warnings.includes(deferred));
    assert.equal(view.summary.workingSnapshots, 0);
    assert.equal(view.summary.retainedSessions, 5);
    assert.match(elements.get("#metric-spend-note")?.textContent ?? "", /last-ingest prices/);
    assert.match(elements.get("#metric-live-note")?.textContent ?? "", /historical working observations excluded/);
    assert.match(elements.get("#retention-note")?.textContent ?? "", /5 source-deleted sessions/);
    assert.equal(filtered.summary.retainedSessions, 0);
    assert.equal(filtered.warnings.some((warning: string) => warning.includes("source-deleted")), false);
    assert.ok(filtered.warnings.includes(deferred));
    assert.doesNotMatch(JSON.stringify({ view, filtered }), /secret-command|secret-path|content-is-not-returned|conductor-claude|\/fixtures\/workspaces/);
  });
});

test("cold and warm indexed snapshots exactly match full scans, including filters and warnings", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture);
    const full = await analyzeMachineSessions({ ...opts, noIndex: true });
    assert.equal(indexStatus(opts).state, "missing");
    const cold = await analyzeMachineSessions(opts);
    assert.deepEqual(stable(cold), stable(full));
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 3);
    assert.equal(indexStatus(opts).evidenceFiles, 4);
    const warm = await analyzeMachineSessions(opts);
    assert.deepEqual(stable(warm), stable(full));
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 0);
    assert.equal(indexStatus(opts).lastScan?.reusedSessions, 3);
    assert.equal(indexStatus(opts).lastScan?.ledgerHits, 2);
    const repository = await analyzeRepositorySessions({ ...opts, repositoryRoot: fixture.repositoryRoot });
    assert.deepEqual(repository.sessions, full.sessions.filter((session) => session.repositoryId === repository.repository.id));
    assert.equal(indexStatus(opts).lastScan?.reusedSessions, 3);
  });
});

test("the disk allowlist, warm results, and management status contain no fixture content or raw identities", async () => {
  await withFixture(async (fixture, root) => {
    const opts = options(fixture);
    const cold = await analyzeMachineSessions(opts), warm = await analyzeMachineSessions(opts);
    const connection = openIndexDatabase(opts);
    try {
      const forbidden = /secret-command|secret-path|secret-skill-args|content-is-not-returned|delegated-agent|message-two|tool-two|conductor-codex|cursor-fixture.ts|https:\/\/github.com\/example|\/fixtures\/workspaces|11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222/;
      const payloads = JSON.stringify({
        sessions: connection.database.prepare("SELECT * FROM sessions").all(),
        evidence: connection.database.prepare("SELECT * FROM evidence").all(), cold, warm, status: indexStatus(opts),
        ownership: connection.database.prepare("SELECT * FROM claude_ownership").all().map((row) => ({ ...row, observations: inflateRawSync(row["observations"] as Uint8Array).toString("utf8") })),
      });
      assert.doesNotMatch(payloads, forbidden);
      assert.equal(payloads.includes(root), false);
      const session = cold.sessions[0] as SessionAnalytics;
      const poisoned = { ...session, raw: "extra-content-is-not-returned", metrics: { ...session.metrics, raw: "extra-content-is-not-returned" } };
      assert.equal(JSON.stringify(projectSession(poisoned)).includes("extra-content-is-not-returned"), false);
      assert.equal((await stat(fixture.dataDir)).mode & 0o777, 0o700);
      for (const name of await readdir(fixture.dataDir)) assert.equal((await stat(join(fixture.dataDir, name))).mode & 0o777, 0o600, name);
    } finally { connection.close(); }
    for (const path of await files(fixture.dataDir)) {
      if (path.endsWith(".key")) continue;
      assert.doesNotMatch((await readFile(path)).toString("utf8"), /secret-command|secret-path|content-is-not-returned|\/fixtures\/workspaces/);
    }
  });
});

test("index validation retains plain public graphs while copying private fields and serialization hooks", async () => {
  await withFixture(async (fixture) => {
    const session = (await analyzeMachineSessions({ ...options(fixture), noIndex: true })).sessions.find(value => value.provider === "codex")!;
    assert.equal(sessionForIndex(session), session);
    assert.notEqual(projectSession(session), session);
    const poisoned = { ...session, metrics: { ...session.metrics, privateContent: "PRIVATE_PROJECTION_SENTINEL" } };
    const cleaned = sessionForIndex(poisoned);
    assert.notEqual(cleaned, poisoned);
    assert.deepEqual(cleaned, session);
    for (const object of [
      Object.assign(Object.create({ toJSON() { return "PRIVATE_PROJECTION_SENTINEL"; } }), session),
      Object.defineProperty({ ...session }, "toJSON", { value() { return "PRIVATE_PROJECTION_SENTINEL"; } }),
      { ...session, metrics: Object.defineProperty({ ...session.metrics }, "toJSON", { value() { return "PRIVATE_PROJECTION_SENTINEL"; } }) },
    ]) {
      const projected = sessionForIndex(object);
      assert.notEqual(projected, object);
      assert.deepEqual(projected, session);
      assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_PROJECTION_SENTINEL/);
    }
    const accessor = Object.defineProperty({ ...session }, "metrics", { enumerable: true, get: () => session.metrics });
    assert.notEqual(sessionForIndex(accessor), accessor);
    assert.deepEqual(sessionForIndex(accessor), session);
  });
});

test("an appended streamed Claude snapshot invalidates only its composite session", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture);
    await analyzeMachineSessions(opts);
    const main = await transcript(fixture, "claude", claudeId);
    const records = (await readFile(main, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const assistant = records.find((row) => row.type === "assistant");
    assistant.message.usage.output_tokens += 80;
    assistant.message.content = [{ type: "text", text: "appended-content-is-not-returned" }];
    await appendFile(main, jsonl([assistant]));
    const changed = await analyzeMachineSessions(opts);
    assert.deepEqual(stable(changed), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 1);
    assert.equal(indexStatus(opts).lastScan?.reusedSessions, 2);
    const subagent = (await files(fixture.claudeRoot)).find((path) => path.includes("/subagents/"));
    assert.ok(subagent);
    const record = JSON.parse((await readFile(subagent, "utf8")).trim());
    record.message.id = "synthetic-new-subagent-message"; record.agentId = "synthetic-new-agent";
    await writeFile(join(dirname(subagent), "new-subagent.jsonl"), jsonl([record]));
    const composite = await analyzeMachineSessions(opts);
    assert.deepEqual(stable(composite), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
    assert.equal(composite.sessions.find((session) => session.provider === "claude")?.transcript.files, 3);
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 1);
    assert.doesNotMatch(JSON.stringify(composite), /appended-content-is-not-returned|synthetic-new-agent/);
  });
});

test("Codex append reuse verifies its full prefix; partial lines, truncation and replacement fall back safely", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), path = await transcript(fixture, "codex", codexId);
    await analyzeMachineSessions(opts);
    await appendFile(path, jsonl([{ type: "event_msg", timestamp: "2026-07-20T11:30:00Z", payload: { type: "task_complete", text: "append-secret" } }]));
    const appended = await analyzeMachineSessions(opts);
    assert.equal(indexStatus(opts).lastScan?.ledgerAppends, 1);
    assert.deepEqual(stable(appended), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
    // Same inode, larger file, unchanged leading/trailing samples: an internal rewrite is not an append.
    const largePadding = jsonl([{ type: "padding", content: "synthetic-padding-".repeat(700) }]);
    await appendFile(path, largePadding);
    await analyzeMachineSessions(opts);
    let body = await readFile(path, "utf8");
    body = body.replace("synthetic-padding-", "rewritten-padding-");
    await writeFile(path, body + jsonl([{ type: "event_msg", payload: { type: "task_complete" } }]));
    const rewritten = await analyzeMachineSessions(opts);
    assert.equal(indexStatus(opts).lastScan?.ledgerAppends, 0);
    assert.deepEqual(stable(rewritten), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
    await appendFile(path, '{"type":"event_msg","payload":');
    await analyzeMachineSessions(opts);
    await appendFile(path, '{"type":"task_complete"}}\n');
    const completed = await analyzeMachineSessions(opts);
    assert.equal(indexStatus(opts).lastScan?.ledgerAppends, 0);
    assert.deepEqual(stable(completed), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
    await writeFile(path, (await readFile(path, "utf8")).split("\n").slice(0, 3).join("\n") + "\n");
    const truncated = await analyzeMachineSessions(opts);
    assert.equal(indexStatus(opts).lastScan?.ledgerAppends, 0);
    assert.deepEqual(stable(truncated), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
    await rename(path, `${path}.old`); await writeFile(path, await readFile(`${path}.old`));
    const replaced = await analyzeMachineSessions(opts);
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 1);
    assert.equal(indexStatus(opts).lastScan?.ledgerAppends, 0);
    assert.deepEqual(stable(replaced), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
  });
});

test("a resumed Claude copy keeps unrelated Claude sessions cached and is never retained twice", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture);
    const main = await transcript(fixture, "claude", claudeId);
    const copy = (id: string) => join(dirname(main), `${id}.jsonl`);
    const records = (await readFile(main, "utf8")).trim().split("\n");
    const session = (id: string, hour: string, messages = true) => records.map((line) => JSON.parse(line.replaceAll(claudeId, id).replaceAll("T12:0", `T${hour}:0`)
      .replaceAll(messages ? "\u0000" : "message-one", "unrelated-message")));
    const resumedId = "33333333-3333-4333-8333-333333333333", unrelatedId = "44444444-4444-4444-8444-444444444444";
    const resumed = session(resumedId, "13");
    await writeFile(copy(resumedId), jsonl(resumed));
    await writeFile(copy(unrelatedId), jsonl(session(unrelatedId, "14", false)));
    await analyzeMachineSessions(opts);
    const cached = await analyzeMachineSessions(opts);
    assert.deepEqual(stable(cached), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 0);
    const index = new DatabaseSync(indexPath(opts), { readOnly: true });
    const claudeRows = Number(index.prepare("SELECT count(*) AS n FROM sessions WHERE payload LIKE '%\"provider\":\"claude\"%'").get()?.["n"]);
    index.close();
    assert.equal(claudeRows, 1, "only the Claude session that shares no message is indexed");
    // A richer snapshot in the copy takes ownership of the shared message from the unchanged main file.
    const richer = resumed.find((row) => row.type === "assistant");
    richer.message.usage.output_tokens += 50;
    await appendFile(copy(resumedId), jsonl([richer]));
    assert.deepEqual(stable(await analyzeMachineSessions(opts)), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
    // Provider cleanup deletes the original; its shared message must not be counted by both sessions.
    await rm(main);
    assert.deepEqual(stable(await analyzeMachineSessions(opts)), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
  });
});

test("a new Codex broadcast owner invalidates the old owner while unrelated sessions stay cached", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture);
    await analyzeMachineSessions(opts);
    const path = await transcript(fixture, "codex", codexId);
    const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const tokens = rows.filter((row) => row.type === "event_msg" && row.payload?.type === "token_count");
    const newId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const contents: unknown[] = [
      { type: "session_meta", timestamp: "2026-07-20T09:00:00Z", payload: { id: newId, cwd: fixture.repositoryRoot, secret: "owner-secret" } },
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    ];
    for (const token of tokens) contents.push({ type: "event_msg", timestamp: token.timestamp, payload: { type: "agent_message" } }, token);
    await writeFile(join(fixture.codexRoot, `rollout-${newId}.jsonl`), jsonl(contents));
    const changed = await analyzeMachineSessions(opts);
    assert.deepEqual(stable(changed), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
    assert.ok((indexStatus(opts).lastScan?.parsedSessions ?? 0) >= 2);
    assert.ok((indexStatus(opts).lastScan?.reusedSessions ?? 0) >= 1);
    const warm = await analyzeMachineSessions(opts);
    assert.deepEqual(stable(warm), stable(changed));
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 0);
  });
});

test("provider cleanup retains sessions and reserves deleted Codex ownership without double charging receivers", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), initial = await analyzeMachineSessions(opts);
    await rm(await transcript(fixture, "codex", codexId));
    await rm(await transcript(fixture, "claude", claudeId));
    const retained = await analyzeMachineSessions(opts);
    assert.equal(retained.summary.sessions, initial.summary.sessions);
    assert.equal(retained.summary.totalInputTokens, initial.summary.totalInputTokens);
    assert.equal(retained.summary.estimatedSpendUsd, initial.summary.estimatedSpendUsd);
    assert.equal(retained.sessions.filter((session) => session.transcript.sourceDeleted).length, 2);
    assert.equal(indexStatus(opts).sourceDeletedSessions, 2);
    assert.equal(indexStatus(opts).lastScan?.retainedSessions, 2);
    assert.doesNotMatch(JSON.stringify(retained), /secret-command|secret-path|content-is-not-returned|\/fixtures\/workspaces|11111111-1111/);
    const full = await analyzeMachineSessions({ ...opts, noIndex: true });
    assert.ok(full.summary.sessions < retained.summary.sessions);
    assert.equal(indexStatus(opts).sourceDeletedSessions, 2);
    assert.deepEqual(stable(await analyzeMachineSessions(opts)), stable(retained));
  });
});

test("moving a rollout into archives does not retain a duplicate", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), initial = await analyzeMachineSessions(opts);
    const path = await transcript(fixture, "codex", codexId);
    await rename(path, join(fixture.codexArchiveRoot, `rollout-${codexId}.jsonl`));
    const moved = await analyzeMachineSessions(opts);
    assert.equal(moved.summary.sessions, initial.summary.sessions);
    assert.equal(indexStatus(opts).sourceDeletedSessions, 0);
    assert.deepEqual(stable(moved), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
  });
});

test("retained-only discovered repositories can be selected using a keyed root match", async () => {
  await withFixture(async (fixture, root) => {
    const opts = { ...options(fixture), databasePath: join(root, "absent.db"), cursorDatabasePath: join(root, "absent-cursor.db") };
    // Without Conductor metadata the fixture's workspace path is not a repository; give it a Git root.
    const checkout = join(root, "unregistered-checkout");
    await mkdir(join(checkout, ".git"), { recursive: true }); await writeFile(join(checkout, ".git/config"), "[core]\n bare = false\n");
    for (const path of await files(fixture.claudeRoot)) {
      await writeFile(path, (await readFile(path, "utf8")).replaceAll("/fixtures/workspaces/conductor/claude-workspace", checkout));
    }
    const initial = await analyzeMachineSessions(opts);
    const chosen = initial.sessions.find((session) => session.provider === "claude"); assert.ok(chosen);
    await rm(fixture.claudeRoot, { recursive: true });
    const retained = await analyzeRepositorySessions({ ...opts, repositoryRoot: checkout });
    assert.equal(retained.sessions[0]?.sessionKey, chosen.sessionKey);
    assert.equal(retained.sessions[0]?.transcript.sourceDeleted, true);
    // A folder that is not a repository cannot be selected as one.
    await assert.rejects(analyzeRepositorySessions({ ...opts, repositoryRoot: "/fixtures/workspaces/conductor/codex-workspace" }), /No evidenced repository/);
  });
});

test("rate-card and Conductor metadata edits invalidate cached session facts", async () => {
  await withFixture(async (fixture, root) => {
    const opts = options(fixture);
    await analyzeMachineSessions(opts);
    const rateCard = JSON.parse(await readFile(join(project, "data/rate-cards.json"), "utf8")) as RateCard;
    for (const rate of Object.values(rateCard.models)) rate.outputPerMillion *= 2;
    const rateCardPath = join(root, "rates.json"); await writeFile(rateCardPath, JSON.stringify(rateCard));
    const changed = await analyzeMachineSessions({ ...opts, rateCardPath });
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 3);
    assert.deepEqual(stable(changed), stable(await analyzeMachineSessions({ ...opts, rateCardPath, noIndex: true })));
    const db = new DatabaseSync(fixture.databasePath);
    db.exec("UPDATE sessions SET status='working' WHERE agent_type='codex'"); db.close();
    const metadata = await analyzeMachineSessions({ ...opts, rateCardPath });
    assert.equal(indexStatus(opts).lastScan?.parsedSessions, 1);
    assert.deepEqual(stable(metadata), stable(await analyzeMachineSessions({ ...opts, rateCardPath, noIndex: true })));
  });
});

test("explicit source scopes never mix retained synthetic histories", async () => {
  await withFixture(async (fixture, root) => {
    const opts = options(fixture); await analyzeMachineSessions(opts);
    const other = await createSessionAnalyticsFixture(join(root, "other"));
    const empty = { ...options(other), dataDir: fixture.dataDir };
    await rm(other.claudeRoot, { recursive: true });
    const result = await analyzeMachineSessions(empty);
    assert.equal(result.sessions.some((session) => session.provider === "claude"), false);
    assert.equal(result.sessions.some((session) => session.transcript.sourceDeleted), false);
    assert.equal(indexStatus(opts).scopes, 2);
  });
});

test("prune is date-validated, exclusive at UTC midnight, and surviving files do not reintroduce old sessions", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture); await analyzeMachineSessions(opts);
    assert.throws(() => pruneIndex("2026-02-30", opts), /valid date/);
    assert.throws(() => validatePruneDate("not-a-date"), /valid date/);
    assert.equal(pruneIndex("2026-07-19", opts), 0);
    const deleted = pruneIndex("2026-07-21", opts);
    assert.ok(deleted > 0);
    const pruned = await analyzeMachineSessions(opts);
    assert.ok(pruned.sessions.every((session) => (session.lastEventAt ?? session.updatedAt) >= "2026-07-21T00:00:00.000Z"));
    assert.ok(pruned.sessions.length < (await analyzeMachineSessions({ ...opts, noIndex: true })).sessions.length);
  });
});

test("schema migrations retain facts and reject future schemas without modifying them", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE evidence(scope TEXT,source_key TEXT,fingerprint TEXT,ledger TEXT,ledger_mac TEXT);
      CREATE TABLE sessions(scope TEXT,identity_key TEXT,signature TEXT,payload TEXT,payload_mac TEXT,source_keys TEXT,root_key TEXT,remote_key TEXT,owned_counters TEXT,last_event_at TEXT);
      INSERT INTO sessions(scope,identity_key,last_event_at) VALUES ('scope','key','2026-01-01'); PRAGMA user_version=1;`);
    migrate(db); migrate(db);
    assert.equal(db.prepare("PRAGMA user_version").get()?.["user_version"], SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT source_deleted FROM sessions").get()?.["source_deleted"], 0);
    for (const table of ["claude_ownership", "conductor_records"]) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"], 0);
    db.exec("PRAGMA user_version=999");
    assert.throws(() => migrate(db), /newer version/);
    assert.equal(db.prepare("PRAGMA user_version").get()?.["user_version"], 999);
  } finally { db.close(); }
});

test("corruption is diagnosed with fixed errors and explicit rebuild recovers", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture); const before = await analyzeMachineSessions(opts);
    await writeFile(indexPath(opts), "deliberately-corrupt-index-secret");
    assert.equal(indexStatus(opts).state, "corrupt");
    await assert.rejects(analyzeMachineSessions(opts), /local index is unavailable/);
    resetIndex(opts);
    assert.deepEqual(stable(await analyzeMachineSessions(opts)), stable(before));
    assert.equal(indexStatus(opts).state, "ready");
  });
});

test("same-size rewrites with restored mtime still invalidate fingerprints", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-analytics-fingerprint-"));
  try {
    const path = join(root, "source.jsonl"), secret = Buffer.alloc(32, 7);
    await writeFile(path, "a".repeat(20_000)); const info = await stat(path);
    const initial = await fingerprint(path, secret);
    await writeFile(path, "a".repeat(10_000) + "b" + "a".repeat(9_999));
    await utimes(path, info.atime, info.mtime);
    const changed = await fingerprint(path, secret);
    assert.equal(changed.head, initial.head); assert.equal(changed.tail, initial.tail);
    assert.notEqual(changed.ctime, initial.ctime);
    assert.notDeepEqual(changed, initial);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uncommitted ingest changes roll back and status remains readable under a writer", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture); await analyzeMachineSessions(opts);
    const before = indexStatus(opts), connection = openIndexDatabase(opts);
    try {
      connection.database.exec("BEGIN IMMEDIATE; DELETE FROM sessions;");
      assert.equal(indexStatus(opts).sessions, before.sessions);
      connection.database.exec("ROLLBACK");
    } finally { connection.close(); }
    assert.equal(indexStatus(opts).sessions, before.sessions);
  });
});

test("concurrent writer processes serialize and recover the lease after process exit", { timeout: 15_000 }, async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture); await analyzeMachineSessions(opts);
    const module = new URL("../src/store/database.ts", import.meta.url).href;
    const source = `import {openIndexDatabase} from ${JSON.stringify(module)}; const c=openIndexDatabase(JSON.parse(process.argv[1])); process.stdout.write('ready'); setTimeout(()=>{c.close()},500);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(opts)], { stdio: ["ignore", "pipe", "pipe"] });
    await once(child.stdout!, "data");
    const exited = once(child, "exit");
    const start = performance.now(), connection = openIndexDatabase(opts);
    connection.close();
    assert.ok(performance.now() - start >= 200);
    await exited;
    assert.equal(indexStatus(opts).state, "ready");
  });
});

test("permissions are repaired and symlink targets are never modified", async () => {
  await withFixture(async (fixture, root) => {
    const opts = options(fixture); await analyzeMachineSessions(opts);
    await chmod(fixture.dataDir, 0o755); await chmod(indexPath(opts), 0o644);
    const connection = openIndexDatabase(opts); connection.close();
    assert.equal((await stat(fixture.dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(indexPath(opts))).mode & 0o777, 0o600);
    const target = join(root, "private-target"); await writeFile(target, "unchanged", { mode: 0o644 });
    await rm(indexPath(opts)); await symlink(target, indexPath(opts));
    assert.throws(() => openIndexDatabase(opts), /index is unavailable/);
    assert.equal(await readFile(target, "utf8"), "unchanged");
    assert.equal((await stat(target)).mode & 0o777, 0o644);
  });
});

test("management CLI and data-directory options are deterministic and do not create stores for path/status", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), env = { ...process.env, SESSION_ANALYTICS_DATA_DIR: fixture.dataDir };
    const run = (args: string[]) => spawnSync(process.execPath, [bin, "index", ...args], { encoding: "utf8", env });
    const status = run(["status", "--json"]); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).state, "missing");
    assert.equal(run(["path"]).stdout.trim(), indexPath(opts));
    await assert.rejects(stat(fixture.dataDir), { code: "ENOENT" });
    assert.equal(run(["prune"]).status, 2);
    assert.equal(run(["path", "--unknown"]).status, 2);
    assert.match(run(["--help"]).stdout, /--no-index/);
    assert.equal(dataDirectory({}, {}, "linux", "/synthetic-home"), "/synthetic-home/.local/share/session-analytics");
    assert.equal(dataDirectory({}, { XDG_DATA_HOME: "/synthetic-xdg" }, "linux", "/synthetic-home"), "/synthetic-xdg/session-analytics");
    assert.equal(dataDirectory({}, { XDG_DATA_HOME: "relative" }, "linux", "/synthetic-home"), "/synthetic-home/.local/share/session-analytics");
    assert.equal(dataDirectory({}, {}, "darwin", "/synthetic-home"), "/synthetic-home/Library/Application Support/session-analytics");
    assert.equal(analyzeOptionsFrom(["--no-index", "--data-dir", "/flag"], { SESSION_ANALYTICS_DATA_DIR: "/env" }).dataDir, "/flag");
    assert.equal(analyzeOptionsFrom([], { SESSION_ANALYTICS_NO_INDEX: "1" }).noIndex, true);
  });
});

test("--no-index never creates an index even when the configured data directory is unusable", async () => {
  await withFixture(async (fixture, root) => {
    const path = join(root, "not-a-directory"); await writeFile(path, "sentinel");
    const result = await analyzeMachineSessions({ ...options(fixture), dataDir: path, noIndex: true });
    assert.equal(result.summary.sessions, 5); assert.equal(await readFile(path, "utf8"), "sentinel");
  });
});

test("a source changing during ingest keeps its previous good facts and commits other stable work", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), initial = await analyzeMachineSessions(opts);
    const session = initial.sessions.find((item) => item.provider === "claude"); assert.ok(session);
    const path = await transcript(fixture, "claude", claudeId);
    const rates = JSON.parse(await readFile(join(project, "data/rate-cards.json"), "utf8")) as RateCard;
    const scan = await IndexScan.open(opts, rates, true); assert.ok(scan);
    try {
      const changed = { ...session, cost: { ...session.cost, totalUsd: 999 } };
      await scan.session({
        agent_type: "claude", provider_session_id: claudeId, conductor_session_id: "conductor-claude",
        repository_id: session.repositoryId, repository_name: session.repositoryName, repository_remote: fixture.remote,
        root_path: fixture.repositoryRoot, workspace_path: "/fixtures/workspaces/conductor/claude-workspace",
        created_at: session.createdAt, updated_at: session.updatedAt, status: session.status,
        branch: null, title: "never-stored", workspace_name: null, database_model: null, default_branch: "", is_hidden: 0,
      }, [path], [], async () => changed);
      await appendFile(path, jsonl([{ type: "queue-operation", timestamp: "2026-07-20T12:10:00Z" }]));
      assert.equal(await scan.commit(), false);
    } finally { scan.close(); }
    const status = indexStatus(opts);
    assert.equal(status.lastScan?.deferredSessions, 1);
    const db = new DatabaseSync(indexPath(opts), { readOnly: true });
    try {
      const stored = db.prepare("SELECT payload FROM sessions").all().map((row) => JSON.parse(String(row["payload"])) as SessionAnalytics);
      assert.equal(stored.find((item) => item.provider === "claude")?.cost.totalUsd, session.cost.totalUsd);
    } finally { db.close(); }
    assert.deepEqual(stable(await analyzeMachineSessions(opts)), stable(await analyzeMachineSessions({ ...opts, noIndex: true })));
  });
});

test("pruned owners never transfer old requests to surviving broadcast receivers", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture), archive = (await files(fixture.codexArchiveRoot))[0]; assert.ok(archive);
    await appendFile(archive, jsonl([{ type: "event_msg", timestamp: "2026-07-22T00:00:00Z", payload: { type: "task_complete" } }]));
    const initial = await analyzeMachineSessions(opts);
    const receiver = initial.sessions.find((session) => session.provider === "codex" && session.executionKind === "mixed"); assert.ok(receiver);
    await rm(await transcript(fixture, "codex", codexId));
    await analyzeMachineSessions(opts);
    pruneIndex("2026-07-21", opts);
    const result = await analyzeMachineSessions(opts);
    assert.deepEqual(result.sessions.find((session) => session.sessionKey === receiver.sessionKey)?.tokens, receiver.tokens);
  });
});

test("invalid cached payloads fail closed and rebuild repairs a lost machine key", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture); await analyzeMachineSessions(opts);
    const db = new DatabaseSync(indexPath(opts));
    db.exec("UPDATE sessions SET payload='untrusted-content-sentinel'"); db.close();
    await assert.rejects(analyzeMachineSessions(opts), /integrity check/);
    resetIndex(opts); await analyzeMachineSessions(opts);
    await rm(join(fixture.dataDir, "index.key"));
    await assert.rejects(analyzeMachineSessions(opts), /index is unavailable/);
    resetIndex(opts);
    assert.equal((await analyzeMachineSessions(opts)).summary.sessions, 5);
  });
});

test("index rebuild and prune commands operate on isolated fixtures end to end", async () => {
  await withFixture(async (fixture) => {
    const env = {
      ...process.env, SESSION_ANALYTICS_DATA_DIR: fixture.dataDir,
      SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0", SESSION_ANALYTICS_OFFLINE: "1",
      SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot, SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot,
      SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot, SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath,
      SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath, SESSION_ANALYTICS_NO_INDEX: "1",
    };
    const rebuild = spawnSync(process.execPath, [bin, "index", "rebuild"], { env, encoding: "utf8" });
    assert.equal(rebuild.status, 0, rebuild.stderr); assert.match(rebuild.stdout, /Index: ready/);
    assert.equal(indexStatus(options(fixture)).sessions, 5);
    const prune = spawnSync(process.execPath, [bin, "index", "prune", "--before", "2027-01-01"], { env, encoding: "utf8" });
    assert.equal(prune.status, 0, prune.stderr); assert.equal(indexStatus(options(fixture)).sessions, 0);
    const reset = spawnSync(process.execPath, [bin, "index", "rebuild"], { env, encoding: "utf8" });
    assert.equal(reset.status, 0, reset.stderr); assert.equal(indexStatus(options(fixture)).sessions, 5);
  });
});

test("report failures expose actionable fixed index errors without child stderr or paths", async () => {
  await withFixture(async (fixture) => {
    await analyzeMachineSessions(options(fixture));
    await writeFile(indexPath(options(fixture)), "private-corruption-sentinel");
    const result = spawnSync(process.execPath, [bin, "report", "--json"], {
      encoding: "utf8", env: {
        ...process.env, SESSION_ANALYTICS_DATA_DIR: fixture.dataDir,
        SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot, SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot,
        SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot, SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath,
        SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath,
      },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "The local index is unavailable; use --no-index or run index rebuild.");
    assert.equal(result.stderr.includes(fixture.dataDir), false);
    assert.doesNotMatch(result.stderr, /private-corruption-sentinel|file:\/\//);
  });
});

test("retention dates normalize UTC offsets and keep unknown dates out of age-based pruning", () => {
  assert.equal(lastActivityAt({ lastEventAt: "2026-07-21T00:30:00+02:00", updatedAt: "", createdAt: "" }), "2026-07-20T22:30:00.000Z");
  assert.equal(lastActivityAt({ lastEventAt: "invalid", updatedAt: "2026-07-21T00:00:00Z", createdAt: "" }), "2026-07-21T00:00:00.000Z");
  assert.equal(lastActivityAt({ lastEventAt: null, updatedAt: "invalid", createdAt: "" }), "");
});

test("retained history rejoins the same canonical repository when Conductor metadata disappears", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture);
    await mkdir(join(fixture.repositoryRoot, ".git"));
    const path = await transcript(fixture, "claude", claudeId);
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    for (const row of lines) if (row.cwd) row.cwd = fixture.repositoryRoot;
    await writeFile(path, jsonl(lines));
    const initial = await analyzeMachineSessions(opts);
    const claude = initial.sessions.find((session) => session.provider === "claude"); assert.ok(claude);
    await rm(path); await rm(fixture.databasePath);
    const result = await analyzeRepositorySessions({ ...opts, repositoryRoot: fixture.repositoryRoot });
    assert.equal(result.sessions.find((session) => session.provider === "claude")?.sessionKey, claude.sessionKey);
    assert.equal(result.sessions.filter((session) => session.provider === "cursor").length, 2);
    assert.ok(result.sessions.every((session) => session.repositoryId === result.repository.id));
  });
});

test("deleted Cursor databases retain their facts with a source-deleted mark", async () => {
  await withFixture(async (fixture) => {
    const opts = options(fixture); const initial = await analyzeMachineSessions(opts);
    await rm(fixture.cursorDatabasePath);
    const result = await analyzeMachineSessions(opts);
    assert.equal(result.summary.sessions, initial.summary.sessions);
    assert.equal(result.summary.providerReportedSpendUsd, initial.summary.providerReportedSpendUsd);
    assert.ok(result.sessions.filter((session) => session.provider === "cursor").every((session) => session.transcript.sourceDeleted));
    assert.equal(indexStatus(opts).sourceDeletedSessions, 2);
  });
});

test("indexed sessions from earlier versions keep history coverage inputs and drop removed analysis fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "index-legacy-projection-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const current = (await analyzeMachineSessions({ ...fixture, noIndex: true, offline: true })).sessions.find((s) => s.provider === "claude" && s.historyProfile)!;
    const { historyProfile, ...withoutProfile } = current;
    const legacy = { ...withoutProfile, skills: { review: 1 }, skillEvidence: "explicit", reliability: { version: 1 }, workflow: { schemaVersion: 1 },
      outcomes: { editsObserved: false }, insightSignals: {}, limitsCache: { profileKey: historyProfile!.profileKey,
        buckets: historyProfile!.days.map((d) => ({ day: d.day, model: d.model, executionKind: "top-level", observedTokens: d.tokens })) } };
    const projected = projectSession(legacy as unknown as SessionAnalytics);
    assert.deepEqual(projected.historyProfile, historyProfile);
    assert.deepEqual(projected, current);
    // Non-Claude sessions gain nothing.
    assert.equal(projectSession({ ...legacy, provider: "codex" } as unknown as SessionAnalytics).historyProfile, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
