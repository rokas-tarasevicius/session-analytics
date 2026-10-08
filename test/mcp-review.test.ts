import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { buildPayload, profile } from "../src/mcp/metrics.ts";
import type { AnalyzeOptions } from "../src/types.ts";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const jsonl = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-review-"));
  const options: AnalyzeOptions = { noIndex: true, additionalProviders: false, offline: true, claudeRoot: join(root, "claude"), codexRoot: join(root, "codex"),
    cursorDatabasePath: join(root, "cursor.db"), databasePath: join(root, "conductor.db"), mcpCwd: join(root, "repository") };
  await mkdir(options.claudeRoot!); await mkdir(options.codexRoot!);
  await mkdir(join(options.mcpCwd!, ".git"), { recursive: true });
  return { root, options };
}
function meta(index: number, cwd: string, timestamp: string) {
  const id = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return { type: "session_meta", timestamp, payload: { id, cwd, source: "cli", instructions: "SECRET_INSTRUCTIONS" } };
}
function event(type: string, timestamp = "2026-10-02T11:50:00Z") {
  return { type: "event_msg", timestamp, payload: { type, message: "SECRET_CONTENT", turn_id: "SECRET_TURN_ID" } };
}
function usage(input: number, timestamp: string) {
  const tokens = { input_tokens: input, output_tokens: 10 };
  return { type: "event_msg", timestamp, payload: { type: "token_count", info: { total_token_usage: tokens, last_token_usage: tokens } } };
}
async function rollout(options: AnalyzeOptions, index: number, rows: object[], start = "2026-10-02T11:50:00Z") {
  const first = meta(index, options.mcpCwd!, start), path = join(options.codexRoot!, `rollout-${first.payload.id}.jsonl`);
  await writeFile(path, jsonl([first, ...rows])); return path;
}

test("budget pricing coverage follows cross-week mixed-price transcript activity", async () => {
  const f = await fixture();
  try {
    await rollout(f.options, 1, [
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } }, usage(1000, "2026-09-01T11:00:00Z"),
      usage(1500, "2026-10-02T11:00:00Z"), { type: "turn_context", payload: { model: "unpriced-fixture" } },
      usage(999000, "2026-10-02T11:01:00Z"), event("task_complete"),
    ], "2026-09-01T10:00:00Z");
    for (let index = 2; index <= 4; index++) await rollout(f.options, index, [
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } }, usage(index * 1000, "2026-10-02T11:02:00Z"), event("task_complete"),
    ]);
    const analytics = await analyzeMachineSessions(f.options);
    const payload = buildPayload({ analytics }, "budget_status", {}, NOW, 60);
    assert.ok("today" in payload.data);
    for (const period of [payload.data.today, payload.data.week]) {
      assert.equal(period.pricingCoverage?.numerator, 10540);
      assert.equal(period.pricingCoverage.denominator, 1009550);
      assert.equal(period.pricingCoverage.value, 10540 / 1009550);
      assert.equal(period.unpricedTokens, 999010);
      assert.equal(period.datedSessions, 4); assert.equal(period.undatedSessions, 0);
      assert.ok(period.apiEquivalentUsdPerHour! > 0);
    }
    assert.equal(payload.totals.sessions, 3);
    assert.equal(payload.totals.basis, "session-start");
    assert.doesNotMatch(JSON.stringify([analytics, payload]), /SECRET_/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("standalone active and unknown sessions are excluded from settled baselines through discovery", async () => {
  const f = await fixture();
  try {
    const paths: string[] = [];
    for (let index = 1; index <= 5; index++) paths.push(await rollout(f.options, index, [
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } }, event("task_started"),
      event("user_message"), usage(index * 1000, "2026-10-02T11:59:59Z"),
    ]));
    await rollout(f.options, 6, [{ type: "turn_context", payload: { model: "gpt-5.6-sol" } }, usage(6000, "2026-10-02T11:59:59Z")]);
    let analytics = await analyzeMachineSessions(f.options);
    const active = profile(analytics.sessions);
    assert.equal(active.durationMilliseconds.samples, 0);
    assert.equal(active.apiEquivalentUsd.samples, 0);
    assert.deepEqual(active.activityStates, { active: 5, settled: 0, unknown: 1 });
    assert.equal(active.durationMilliseconds.excludedSessions, 6);
    for (const path of paths) await appendFile(path, jsonl([event("task_complete", "2026-10-02T12:00:00Z")]));
    analytics = await analyzeMachineSessions(f.options);
    const settled = profile(analytics.sessions);
    assert.equal(settled.durationMilliseconds.samples, 5);
    assert.deepEqual(settled.activityStates, { active: 0, settled: 5, unknown: 1 });
    assert.ok(settled.apiEquivalentUsd.median! > 0);
    await appendFile(paths[0]!, jsonl([event("task_started", "2026-10-02T12:00:01Z")]));
    analytics = await analyzeMachineSessions(f.options);
    assert.equal(profile(analytics.sessions).durationMilliseconds.samples, 4);
    assert.doesNotMatch(JSON.stringify(analytics), /SECRET_/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Claude settled evidence includes subagents and excludes resumed or malformed tails", async () => {
  const f = await fixture();
  try {
    const id = "20000000-0000-4000-8000-000000000001";
    const main = join(f.options.claudeRoot!, `${id}.jsonl`);
    const subroot = join(f.options.claudeRoot!, id, "subagents"), sub = join(subroot, "agent.jsonl");
    await mkdir(subroot, { recursive: true });
    const response = (stop: string | null, timestamp: string, extra = {}) => ({
      sessionId: id, cwd: f.options.mcpCwd, type: "assistant", timestamp,
      message: { id: "SECRET_MESSAGE_ID", model: "claude-opus-5", stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 20 }, content: [{ type: "text", text: "SECRET_CONTENT" }] }, ...extra,
    });
    await writeFile(main, jsonl([response("end_turn", "2026-10-02T11:00:00Z")]));
    await writeFile(sub, jsonl([response(null, "2026-10-02T10:59:00Z", { agentId: "SECRET_AGENT" })]));
    let analytics = await analyzeMachineSessions(f.options);
    assert.equal(analytics.sessions[0]!.mcpEvidence?.activityState, "active");
    await appendFile(sub, jsonl([{ type: "system", subtype: "turn_duration", timestamp: "2026-10-02T11:01:00Z", content: "SECRET_SYSTEM" }]));
    analytics = await analyzeMachineSessions(f.options);
    assert.equal(analytics.sessions[0]!.mcpEvidence?.activityState, "settled");
    await appendFile(main, jsonl([{ type: "user", timestamp: "2026-10-02T11:02:00Z", message: { content: "SECRET_REQUEST" } }]));
    analytics = await analyzeMachineSessions(f.options);
    assert.equal(analytics.sessions[0]!.mcpEvidence?.activityState, "active");
    await appendFile(main, jsonl([response("end_turn", "2026-10-02T11:03:00Z")]) + "{SECRET_MALFORMED\n");
    analytics = await analyzeMachineSessions(f.options);
    assert.equal(analytics.sessions[0]!.mcpEvidence?.activityState, "unknown");
    assert.doesNotMatch(JSON.stringify(analytics), /SECRET_/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("source health survives a completely empty machine and never forwards warnings", async () => {
  const f = await fixture();
  try {
    const analytics = await analyzeMachineSessions({ ...f.options, claudeRoot: join(f.root, "SECRET_MISSING"), mcpCwd: undefined });
    assert.equal(analytics.sessions.length, 0); assert.equal(analytics.repositories.length, 0);
    analytics.warnings.push("SECRET_LOCAL_ERROR");
    const payload = buildPayload({ analytics }, "usage_summary", { provider: "claude", window: "all" }, NOW, 60);
    assert.deepEqual(payload.sourceHealth, [{ provider: "claude", status: "unavailable", sourcesRead: 0, missingSources: 1, unreadableSources: 0 }]);
    assert.match(payload.notes.join(" "), /sources.*incomplete/);
    assert.doesNotMatch(JSON.stringify(payload), /SECRET_/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
