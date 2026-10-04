import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { indexStatus, openIndexDatabase } from "../src/store/database.ts";
import { keyedHash } from "../src/store/fingerprint.ts";
import { IndexScan } from "../src/store/index.ts";
import { projectSession } from "../src/store/projection.ts";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { monthlyTotals, parityDiff, paritySession, schemaFailureFields } from "../scripts/parity.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";
import { createOutcomeFixture, outcomeSentinels } from "./outcomes-fixtures.ts";
import { changedEvidence, evidenceGenerations } from "../scripts/parity-evidence.ts";
import { rotatingSample } from "../src/store/parity.ts";

test("an unchanged Claude child can age out of active liveness without a cache mismatch warning", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-03T10:05:00Z") });
  const root = await mkdtemp(join(tmpdir(), "index-liveness-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const children = join(fixture.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", "22222222-2222-4222-8222-222222222222", "subagents");
    await appendFile(join(children, (await readdir(children))[0]!), JSON.stringify({ type: "user", uuid: "synthetic-live-child",
      timestamp: new Date().toISOString(), message: { content: "PRIVATE_LIVE_CHILD" } }) + "\n");
    const options = { ...fixture, noIndex: false, offline: true };
    const cold = await analyzeMachineSessions(options);
    assert.equal(cold.sessions.find((s) => s.provider === "claude")?.transcript.liveness, "active");
    t.mock.timers.tick(16 * 60_000);
    const warm = await analyzeMachineSessions(options), full = await analyzeMachineSessions({ ...options, noIndex: true });
    assert.equal(warm.sessions.find((s) => s.provider === "claude")?.transcript.liveness, "unknown");
    assert.deepEqual(warm, full);
    assert.equal(indexStatus(options).lastScan?.parsedSessions, 1);
    assert.doesNotMatch(JSON.stringify(warm), /PRIVATE_LIVE_CHILD/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: "600,000 broadcast observations", worker: "index-parity-memory-worker.ts", expected: { files: 600, ledgerReads: 600 } },
  { name: "400 dense cached sessions", worker: "index-parity-cache-worker.ts", expected: { sessions: 400, previousRows: 0 } },
  { name: "a snapshot larger than 128 MiB", worker: "index-parity-output-worker.ts", expected: { complete: true, over128MiB: true } },
  { name: "5,000 projected sessions", worker: "index-parity-projection-worker.ts", expected: { sessions: 5000 } },
]) test(`index memory stays bounded under a 64 MB heap with ${scenario.name}`, { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "index-memory-"));
  try {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=64", new URL(`./${scenario.worker}`, import.meta.url).pathname, root], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (data) => { output += String(data); });
      child.stderr.resume();
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 0, "the bounded ledger worker must complete");
    assert.deepEqual(JSON.parse(result.output), scenario.expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audit sampling rotates and real-run generation checks detect changed composites without source content", async () => {
  assert.deepEqual(rotatingSample(["b", "a", "c", "d", "e"], "", 4), ["a", "b", "c", "d"]);
  assert.deepEqual(rotatingSample(["b", "a", "c", "d", "e"], "d", 4), ["e", "a", "b", "c"]);
  const root = await mkdtemp(join(tmpdir(), "parity-generations-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const before = await evidenceGenerations(fixture);
    assert.equal(changedEvidence(before, await evidenceGenerations(fixture)).size, 0);
    const children = join(fixture.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", "22222222-2222-4222-8222-222222222222", "subagents");
    await appendFile(join(children, (await readdir(children))[0]!), "\n");
    const after = await evidenceGenerations(fixture);
    assert.equal(changedEvidence(before, after).size, 2, "provider and registered keys share the changed composite generation");
    assert.doesNotMatch(JSON.stringify([...after]), /fixture|secret|repository|workspace|content-is-not-returned/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const target of ["session", "ledger"] as const) test(`a warm ${target} audit detects validly signed stale facts and falls back`, async () => {
  const root = await mkdtemp(join(tmpdir(), "index-audit-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root), options = { ...fixture, offline: true, noIndex: false };
    const full = await analyzeMachineSessions({ ...options, noIndex: true });
    await analyzeMachineSessions(options);
    // Emulate an earlier accounting bug, not disk corruption (the MAC remains valid).
    const connection = openIndexDatabase(options);
    try {
      if (target === "session") {
        for (const row of connection.database.prepare("SELECT scope,identity_key,payload FROM sessions").all()) {
          const session = JSON.parse(String(row.payload));
          if (session.provider !== "codex" && session.provider !== "claude") continue;
          session.tokens.inputTokens++;
          const payload = JSON.stringify(session);
          connection.database.prepare("UPDATE sessions SET payload=?,payload_mac=? WHERE scope=? AND identity_key=?")
            .run(payload, keyedHash(connection.secret, payload), row.scope!, row.identity_key!);
        }
      } else {
        for (const row of connection.database.prepare("SELECT scope,source_key,ledger FROM evidence WHERE ledger IS NOT NULL").all()) {
          const ledger = JSON.parse(String(row.ledger));
          ledger.observations = [];
          const payload = JSON.stringify(ledger);
          connection.database.prepare("UPDATE evidence SET ledger=?,ledger_mac=? WHERE scope=? AND source_key=?")
            .run(payload, keyedHash(connection.secret, payload), row.scope!, row.source_key!);
        }
      }
    } finally { connection.close(); }
    const result = await analyzeMachineSessions(options);
    assert.deepEqual(parityDiff(full.sessions.map(paritySession), result.sessions.map(paritySession)), []);
    assert.ok(result.warnings.some((warning) => warning.includes("full scan")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("outcome-bearing Codex and streamed Claude composites retain exact cold/warm/full accounting", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-03T10:05:00Z") });
  const root = await mkdtemp(join(tmpdir(), "index-outcomes-"));
  try {
    const fixture = await createOutcomeFixture(root);
    const children = join(fixture.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", "22222222-2222-4222-8222-222222222222", "subagents");
    const child = join(children, (await readdir(children))[0]!);
    await appendFile(child, [
      { type: "user", uuid: "synthetic-operation", timestamp: "2026-07-20T12:02:00Z",
        message: { content: [{ type: "tool_result", tool_use_id: "synthetic-call", content: "PRIVATE_CHILD_CONTENT" }] },
        toolUseResult: { gitOperation: { commit: { kind: "committed" }, pr: { action: "created" } } } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const options = { ...fixture, noIndex: false, offline: true };
    const full = await analyzeMachineSessions({ ...options, noIndex: true });
    const prefixes = new Set(full.sessions.flatMap((s) => s.outcomes?.links.map((l) => l.ref.replace(/-[a-f0-9]{24}$/, "")) ?? []));
    for (const prefix of ["branch", "commit", "pr", "commit-event", "pr-event", "workspace-pr"]) assert.ok(prefixes.has(prefix), prefix);
    for (const session of full.sessions) assert.deepEqual(projectSession(session), JSON.parse(JSON.stringify(session)));
    validateSnapshot(full);
    const cold = await analyzeMachineSessions(options), warm = await analyzeMachineSessions(options);
    assert.deepEqual(cold, full);
    assert.deepEqual(warm, full);
    assert.equal(indexStatus(options).lastScan?.parsedSessions, 0);
    assert.equal(indexStatus(options).lastScan?.reusedSessions, 3);
    const serialized = JSON.stringify([full, cold, warm]) + (await readFile(join(fixture.dataDir, "index.sqlite"))).toString("utf8");
    for (const sentinel of [...outcomeSentinels, "PRIVATE_CHILD_CONTENT"]) assert.ok(!serialized.includes(sentinel));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an index projection failure rolls back the scan and retries full accounting with a fixed warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "index-failure-"));
  const original = IndexScan.prototype.session;
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const options = { ...fixture, offline: true, noIndex: false };
    const full = await analyzeMachineSessions({ ...options, noIndex: true });
    let injected = false;
    IndexScan.prototype.session = async function (row, paths, warnings, analyze, ...rest) {
      return original.call(this, row, paths, warnings, async () => {
        const session = await analyze();
        // Simulate future schema drift after the parser has claimed Codex counters.
        if (session && row.agent_type === "codex" && !injected) {
          injected = true;
          session.transcript.warnings.push("PRIVATE_INDEX_FAILURE_SENTINEL");
        }
        return session;
      }, ...rest);
    };
    const result = await analyzeMachineSessions(options);
    assert.ok(injected);
    assert.deepEqual(parityDiff(full.sessions.map(paritySession), result.sessions.map(paritySession)), []);
    assert.ok(result.warnings.some((warning) => warning.includes("full scan")));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INDEX_FAILURE_SENTINEL/);
    assert.equal(indexStatus(options).lastScan, null, "failed ingest must not persist a partial accounting generation");
  } finally { IndexScan.prototype.session = original; await rm(root, { recursive: true, force: true }); }
});

test("parity diagnostics compare every token class, model, status and duplicate without exposing content", async () => {
  const root = await mkdtemp(join(tmpdir(), "index-parity-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const snapshot = await analyzeMachineSessions({ ...fixture, offline: true });
    const baseline = snapshot.sessions.map(paritySession);
    assert.deepEqual(parityDiff(baseline, structuredClone(baseline)), []);
    const changed = structuredClone(baseline);
    changed[0]!.tokens.cacheWrite1hInputTokens!++;
    changed[0]!.transcript.status = "invalid";
    changed[0]!.models[0]!.tokens.reasoningOutputTokens!++;
    assert.deepEqual(parityDiff(baseline, changed), [{ sessionKey: baseline[0]!.sessionKey,
      fields: ["models.*.tokens.reasoningOutputTokens", "tokens.cacheWrite1hInputTokens", "transcript.status"] }]);
    assert.ok(parityDiff(baseline, [...baseline, baseline[0]!]).some((d) => d.fields.includes("duplicate")));
    assert.ok(parityDiff(baseline, baseline.slice(1)).some((d) => d.fields.includes("missing")));
    assert.ok(parityDiff(baseline.slice(1), baseline).some((d) => d.fields.includes("extra")));
    const rounded = structuredClone(baseline);
    rounded[0]!.cost.totalUsd! += 0.000000001;
    assert.deepEqual(parityDiff(baseline, rounded), []);
    rounded[0]!.cost.totalUsd! += 0.02;
    assert.equal(parityDiff(baseline, rounded).length, 1);
    assert.equal(monthlyTotals(baseline).reduce((sum, row) => sum + row.sessions, 0), snapshot.sessions.length);
    assert.doesNotMatch(JSON.stringify([baseline, monthlyTotals(baseline)]), /secret|content-is-not-returned|fixtures|workspace|repository/i);
    assert.deepEqual(schemaFailureFields({ PRIVATE_CONTENT: "PRIVATE_TEXT" }, { type: "object", additionalProperties: { type: "number" } }), ["session.*"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
