import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { indexStatus, openIndexDatabase } from "../src/store/database.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";
import { addCommandHistoryFixture, commandSentinels } from "./workflow-fixtures.ts";
import { seedDemoPricing } from "../scripts/demo-pricing.ts";

const jsonl = (records: object[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

test("integration: cold and warm indexes replay the complete projection, quota facts and pricing provenance", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-03T10:05:00Z") });
  const root = await mkdtemp(join(tmpdir(), "complete-index-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    await addCommandHistoryFixture(fixture);
    await seedDemoPricing(fixture.dataDir);
    // Locate the fixture's known rollout without assuming its basename convention.
    const { readdir } = await import("node:fs/promises");
    const directory = join(fixture.codexRoot, "2026/07/20");
    const rollout = join(directory, (await readdir(directory)).find((name) => name.endsWith(".jsonl"))!);
    await appendFile(rollout, jsonl([
      { type: "event_msg", timestamp: "2026-10-03T10:00:00Z", payload: { type: "token_count", rate_limits: {
        limit_id: "PRIVATE_QUOTA_ID", plan_type: "pro", credits: { has_credits: true, unlimited: false, balance: "12.5" },
        primary: { used_percent: 72, window_minutes: 300, resets_at: Date.parse("2026-10-03T11:00:00Z") / 1000 },
      } } },
      { type: "event_msg", timestamp: "2026-10-03T10:01:00Z", payload: { type: "task_complete", turn_id: "PRIVATE_TURN_ID", error: { codex_error_info: "usage_limit_exceeded", message: "PRIVATE_ERROR_TEXT" } } },
    ]));
    const options = { ...fixture, noIndex: false, offline: true, reliabilityContentRules: true, workflowContentRules: true };
    const full = validateSnapshot(await analyzeMachineSessions({ ...options, noIndex: true }));
    const cold = validateSnapshot(await analyzeMachineSessions(options));
    const warm = validateSnapshot(await analyzeMachineSessions(options));
    assert.deepEqual(cold, full);
    assert.deepEqual(warm, full);
    assert.equal(indexStatus(options).lastScan?.parsedSessions, 0);
    assert.equal(indexStatus(options).lastScan?.reusedSessions, 3);
    assert.ok(full.limitsCache?.profiles.some((p) => p.windows.length && p.limitHitCount));
    const native = warm.sessions.filter((s) => s.provider === "claude" || s.provider === "codex");
    for (const s of native) for (const key of ["velocity", "reliability", "limitsCache", "outcomes", "workflow", "insightSignals", "mcpEvidence"] as const) assert.ok(s[key], key);
    const connection = openIndexDatabase(options);
    try {
      const payloads = connection.database.prepare("SELECT payload FROM sessions").all().map((row) => JSON.parse(String(row.payload)));
      assert.equal(payloads.length, warm.sessions.length);
      for (const s of warm.sessions) assert.deepEqual(payloads.find((p) => p.sessionKey === s.sessionKey), s);
      assert.doesNotMatch(JSON.stringify(payloads), /PRIVATE_|secret-command|secret-path|content-is-not-returned/);
      assert.doesNotMatch(JSON.stringify(payloads), commandSentinels);
    } finally { connection.close(); }
    // Command history is external to transcript fingerprints but changes Workflow facts.
    await appendFile(join(dirname(fixture.claudeRoot), "history.jsonl"), jsonl([{ sessionId: "22222222-2222-4222-8222-222222222222", timestamp: Date.parse("2026-07-20T12:00:30Z"), display: "/review PRIVATE_HISTORY_ARGUMENT" }]));
    const history = await analyzeMachineSessions(options);
    assert.equal(indexStatus(options).lastScan?.parsedSessions, 1);
    assert.deepEqual(history, await analyzeMachineSessions({ ...options, noIndex: true }));
    assert.ok(history.sessions.find((s) => s.provider === "claude")!.workflow!.commands.length > warm.sessions.find((s) => s.provider === "claude")!.workflow!.commands.length);
    // Disabling P2 is a cache boundary: earlier rule-derived evidence cannot leak into a P0/P1 scan.
    t.mock.timers.tick(1);
    const disabled = await analyzeMachineSessions({ ...options, reliabilityContentRules: false, workflowContentRules: false });
    assert.ok(disabled.sessions.filter((s) => s.reliability).every((s) => s.reliability!.contentRules === "disabled"));
    assert.ok(disabled.sessions.filter((s) => s.workflow).every((s) => !s.workflow!.coverage.contentRules));
    assert.equal(indexStatus(options).lastScan?.parsedSessions, 3);
    await rm(fixture.claudeRoot, { recursive: true });
    const retained = await analyzeMachineSessions({ ...options, reliabilityContentRules: false, workflowContentRules: false });
    assert.ok(retained.sessions.some((s) => s.provider === "claude" && s.transcript.sourceDeleted));
    assert.ok(retained.sessions.filter((s) => s.reliability).every((s) => s.reliability!.contentRules === "disabled"));
    assert.ok(retained.sessions.filter((s) => s.workflow).every((s) => !s.workflow!.coverage.contentRules));
  } finally { await rm(root, { recursive: true, force: true }); }
});
