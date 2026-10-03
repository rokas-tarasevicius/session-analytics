import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowCollector, workflowTimestamp } from "../src/metrics/workflow.ts";
import { compareVersions, concurrency, histogram, mergeHistograms, summarizeWorkflow } from "../src/public/workflow-data.js";
import { analyzeOptionsFrom } from "../src/options.ts";
import { slashCommand } from "../src/metrics/workflow-inventory.ts";
import type { SessionAnalytics, SessionWorkflow } from "../src/types.ts";

const BASE = Date.parse("2026-06-01T10:00:00Z");
const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();
const AFTER = BASE + 3 * 86_400_000;
function codex(subagent = false) {
  const collector = new WorkflowCollector("codex");
  collector.observe({ type: "session_meta", timestamp: at(0), payload: { cli_version: "0.140.0", source: subagent ? { subagent: {} } : "cli", originator: "codex_cli_rs" } }, 0);
  collector.observe({ type: "turn_context", timestamp: at(0), payload: { model: "gpt-test", effort: "high" } }, 1);
  let line = 2;
  return { collector, event: (seconds: number, type: string, extra: Record<string, unknown> = {}) => collector.observe({ type: "event_msg", timestamp: at(seconds), payload: { type, ...extra } }, line++) };
}
function session(workflow: SessionWorkflow, overrides: Partial<SessionAnalytics> = {}): SessionAnalytics {
  return { workflow, provider: "codex", createdAt: at(0), repositoryId: "repo", skills: {}, transcript: { status: "ok", snapshotWhileWorking: false }, ...overrides } as SessionAnalytics;
}

test("workflow: joins short work gaps, bounds human waiting and leaves idle unclassified", () => {
  const { collector: c, event } = codex();
  event(0, "user_message"); event(0, "task_started", { turn_id: "a" });
  c.tool(at(30), 3); event(60, "task_complete", { turn_id: "a", duration_ms: 60_000 });
  event(3660, "user_message"); event(3660, "task_started", { turn_id: "b" });
  c.tool(at(3690)); event(3780, "task_complete", { turn_id: "b", duration_ms: 120_000 });
  const w = c.finish(AFTER);
  assert.equal(w.humanTurns, 2);
  assert.deepEqual(w.toolRuns, histogram([3, 1]));
  assert.deepEqual(w.turnWallTime, histogram([60_000, 120_000]));
  assert.equal(w.recordedTurnDurations, 2);
  assert.equal(w.time.activeMilliseconds, 180_000);
  assert.equal(w.time.waitingForHumanMilliseconds, 1_800_000);
  assert.equal(w.time.unclassifiedMilliseconds, 1_800_000);
  assert.equal(w.time.observedSpanMilliseconds, 3_780_000);
  assert.equal(w.time.activeSpans.length, 2);
  assert.equal(w.abandonment, "not-flagged");
});

test("workflow: zero-tool turns and the final run enter exact pooled quantiles", () => {
  const { collector: c, event } = codex();
  event(0, "user_message"); event(10, "agent_message"); event(20, "user_message"); c.tool(at(30), 7);
  const w = c.finish(AFTER);
  assert.deepEqual(w.toolRuns.bins, [{ value: 0, count: 1 }, { value: 7, count: 1 }]);
  assert.equal(w.toolRuns.p50, 0); assert.equal(w.toolRuns.max, 7);
  assert.equal(w.turnWallTime.samples, 1);
  assert.equal(w.inferredTurnDurations, 1);
  assert.equal(mergeHistograms([histogram([1, 1, 1, 1, 1]), histogram([100])]).p50, 1);
});

test("workflow: selects the richest lifecycle shape and deduplicates typed items", () => {
  const { collector: c, event } = codex();
  event(0, "user_message");
  event(0, "item_completed", { item: { id: "one", type: "UserMessage" } });
  event(30, "item_completed", { item: { id: "cmd", type: "CommandExecution", command: "SENTINEL command" } });
  event(31, "item_completed", { item: { id: "cmd", type: "CommandExecution" } });
  event(40, "item_completed", { item: { id: "two", type: "UserMessage" } });
  c.tool(at(29));
  const w = c.finish(AFTER);
  assert.equal(w.humanTurns, 2); assert.equal(w.toolCalls, 1);
  assert.equal(w.toolRuns.max, 1);
  assert.doesNotMatch(JSON.stringify(w), /SENTINEL|"cmd"|"one"/);
});

test("workflow: sub-agent inputs are not human turns; sub-agent timing is retained", () => {
  const { collector: c, event } = codex(true);
  event(0, "user_message"); event(0, "task_started"); c.tool(at(30)); event(60, "task_complete");
  const w = c.finish(AFTER);
  assert.equal(w.humanTurns, null); assert.equal(w.toolRuns.samples, 0);
  assert.equal(w.coverage.humanTurns, "not-applicable"); assert.equal(w.time.activeMilliseconds, 60_000);
  assert.equal(w.turnWallTime.p50, 60_000); assert.equal(w.abandonment, "insufficient-evidence");
});

test("workflow: interruption reasons and plan events are allowlisted, lifecycle duplicates collapse", () => {
  const { collector: c, event } = codex();
  event(0, "user_message"); event(0, "task_started", { turn_id: "private-turn" });
  c.tool(at(15)); event(20, "user_message", { turn_id: "private-turn" });
  event(30, "turn_aborted", { turn_id: "private-turn", reason: "replaced", duration_ms: 30_000 });
  event(31, "turn_aborted", { turn_id: "private-turn", reason: "replaced" });
  event(32, "turn_aborted", { turn_id: "private-other", reason: "SENTINEL /private/path" });
  event(33, "item_completed", { item: { id: "sub", type: "SubAgentActivity", kind: "interrupted", agent: "SENTINEL" } });
  event(34, "item_completed", { item: { id: "plan", type: "Plan", text: "SENTINEL" } });
  c.observe({ type: "turn_context", timestamp: at(35), payload: { collaboration_mode: { mode: "plan" } } }, 50);
  c.observe({ type: "turn_context", timestamp: at(36), payload: { collaboration_mode: { mode: "plan" } } }, 51);
  const w = c.finish(AFTER);
  assert.equal(w.humanTurns, 2); assert.equal(w.interruptions.replaced, 1);
  assert.equal(w.interruptions.other, 1); assert.equal(w.interruptions.subagentInterrupted, 1);
  assert.equal(w.steering.planItems, 1); assert.equal(w.steering.planEntries, 1);
  assert.equal(w.steering.midTurnHumanTurns, 1);
  assert.doesNotMatch(JSON.stringify(w), /SENTINEL|private-turn|private-other/);
});

test("workflow: task clocks survive a delayed UserMessage item and mid-turn human steering", () => {
  const { collector: c, event } = codex();
  event(0, "task_started", { turn_id: "turn" });
  event(1, "item_completed", { item: { type: "UserMessage", id: "first" } });
  c.tool(at(10), 2);
  event(20, "item_completed", { item: { type: "UserMessage", id: "steer" } });
  c.tool(at(30)); event(60, "task_complete", { turn_id: "turn" });
  const w = c.finish(AFTER);
  assert.equal(w.steering.midTurnHumanTurns, 1);
  assert.deepEqual(w.turnWallTime, histogram([60_000]));
  assert.deepEqual(w.toolRuns, histogram([2, 1]));
});

test("workflow: a missing later task-start does not retain the prior turn identity", () => {
  const { collector: c, event } = codex();
  event(0, "user_message"); event(0, "task_started", { turn_id: "first" }); c.tool(at(10)); event(30, "task_complete", { turn_id: "first" });
  event(60, "user_message"); c.tool(at(70)); event(90, "task_complete", { turn_id: "second" });
  assert.deepEqual(c.finish(AFTER).turnWallTime, histogram([30_000, 30_000]));
});

test("workflow: Claude markers require P2 opt-in and exact control text", () => {
  for (const enabled of [false, true]) {
    const c = new WorkflowCollector("claude", enabled);
    c.observe({ type: "user", timestamp: at(0), uuid: "a", message: { content: "SENTINEL prompt" } }, 0);
    c.observe({ type: "user", timestamp: at(10), uuid: "b", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }, 1);
    c.observe({ type: "user", timestamp: at(20), uuid: "c", message: { content: "Discuss [Request interrupted by user] in documentation" } }, 2);
    c.observe({ type: "user", timestamp: at(30), uuid: "d", isMeta: true, message: { content: "SENTINEL agent task" } }, 3);
    const w = c.finish(AFTER);
    assert.equal(w.interruptions.claudeMarkers, enabled ? 1 : null);
    assert.equal(w.humanTurns, enabled ? 2 : 3);
    assert.equal(w.coverage.contentRules, enabled);
    assert.doesNotMatch(JSON.stringify(w), /SENTINEL|Discuss|Request interrupted/);
  }
});

test("workflow: Claude version, mode, queue reasons and durations discard arbitrary metadata", () => {
  const c = new WorkflowCollector("claude");
  c.observe({ type: "user", timestamp: at(0), version: "2.4.0", entrypoint: "sdk-ts", permissionMode: "plan", uuid: "a", message: { content: "SENTINEL" } }, 1);
  c.observe({ type: "queue-operation", timestamp: at(10), operation: "enqueue", reason: "user_input", content: "SENTINEL" }, 2);
  c.observe({ type: "queue-operation", timestamp: at(20), operation: "SENTINEL", reason: "SENTINEL" }, 3);
  c.observe({ type: "assistant", timestamp: at(30), effort: "high", message: { id: "private-id", model: "claude-test", content: [] } }, 4);
  c.observe({ type: "system", timestamp: at(60), subtype: "turn_duration", durationMs: 60_000, version: "/SENTINEL", entrypoint: "SENTINEL" }, 5);
  const w = c.finish(AFTER);
  assert.equal(w.steering.planEntries, 1); assert.equal(w.steering.queueOperations.enqueue, 1); assert.equal(w.steering.queueOperations.other, 1);
  assert.equal(w.steering.queueReasons.prompt, 1); assert.equal(w.steering.queueReasons.other, 1);
  assert.equal(w.recordedTurnDurations, 1); assert.equal(w.turnWallTime.p95, 60_000);
  assert.ok(w.mix.some((m) => m.cliVersion === "2.4.0" && m.entrypoint === "sdk-ts"));
  assert.doesNotMatch(JSON.stringify(w), /SENTINEL|private-id/);
});

test("workflow: timestamps are normalized; untimed records retain counts but suppress run estimates", () => {
  const { collector: c, event } = codex();
  event(0, "user_message"); c.tool("SENTINEL timestamp", 4);
  c.observe({ type: "event_msg", timestamp: "invalid", payload: { type: "user_message" } }, 8);
  event(60, "task_complete", { duration_ms: -500 });
  const w = c.finish(AFTER);
  assert.equal(w.humanTurns, 2); assert.equal(w.toolCalls, 4); assert.equal(w.toolRuns.samples, 0);
  assert.equal(w.coverage.timing, "partial"); assert.equal(w.coverage.untimedEvents, 2);
  assert.equal(w.recordedTurnDurations, 0);
  assert.equal(workflowTimestamp(123), null); assert.equal(workflowTimestamp("June 1, 2026"), null);
  assert.equal(workflowTimestamp("2026-06-01T11:00:00+01:00"), BASE);
  assert.doesNotMatch(JSON.stringify(w), /SENTINEL|invalid/);
});

test("workflow: broadcasts and long work gaps do not invent active time", () => {
  const { collector: c, event } = codex();
  event(0, "user_message"); event(0, "task_started");
  event(60, "token_count", { info: { total_token_usage: { input_tokens: 100000 } } });
  c.tool(at(3600)); event(3660, "task_complete", { duration_ms: 3_660_000 });
  const w = c.finish(AFTER);
  assert.equal(w.time.activeMilliseconds, 60_000);
  assert.equal(w.time.unclassifiedMilliseconds, 3_600_000);
  assert.equal(w.turnWallTime.p50, 3_660_000);
});

test("workflow: abandonment is a stale-open-turn heuristic, never a terminal interruption verdict", () => {
  const make = (complete: boolean, now: number, tools = 3) => {
    const { collector: c, event } = codex(); event(0, "user_message"); event(0, "task_started"); c.tool(at(30), tools);
    if (complete) event(40, "turn_aborted", { reason: "interrupted" });
    return c.finish(now);
  };
  assert.equal(make(false, AFTER).abandonment, "flagged");
  assert.equal(make(false, BASE + 60_000).abandonment, "ongoing");
  assert.equal(make(true, AFTER).abandonment, "not-flagged");
  assert.equal(make(false, AFTER, 2).abandonment, "insufficient-evidence");
});

test("workflow: archetypes respect duration, human and tool thresholds with marathon precedence", () => {
  const make = (tools: number, seconds = 60) => {
    const { collector: c, event } = codex(); event(0, "user_message"); c.tool(at(30), tools); event(seconds, "task_complete"); return c.finish(AFTER).archetype;
  };
  assert.equal(make(10), "quick"); assert.equal(make(11), "standard"); assert.equal(make(80), "deep"); assert.equal(make(300), "marathon");
});

test("workflow: concurrency unions per-session spans, ties are half-open, peaks split at UTC midnight", () => {
  const span = (start: number, end: number) => ({ start: at(start), end: at(end) });
  const c = concurrency([{ spans: [span(0, 120), span(0, 60)] }, { spans: [span(60, 180)] }, { spans: [span(180, 240)] }]);
  assert.equal(c.peak, 2); assert.equal(c.activeSessionMilliseconds, 300_000); assert.equal(c.wallClockActiveMilliseconds, 240_000); assert.equal(c.effectiveParallelism, 1.25);
  assert.equal(concurrency([{ spans: [span(0, 1)] }]).effectiveParallelism, null);
  const midnight = concurrency([{ spans: [{ start: "2026-06-01T23:59:00Z", end: "2026-06-02T00:01:00Z" }] }]);
  assert.deepEqual(midnight.daily.map((d) => [d.day, d.peak, d.wallClockActiveMilliseconds]), [["2026-06-01", 1, 60_000], ["2026-06-02", 1, 60_000]]);
});

test("workflow: concurrency matches a discrete reference with randomized nested overlaps", () => {
  let seed = 41;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let trial = 0; trial < 25; trial += 1) {
    const raw = Array.from({ length: 6 }, () => Array.from({ length: 4 }, () => { const start = Math.floor(random() * 30); return [start, start + 1 + Math.floor(random() * 10)] as const; }));
    const expected = Array.from({ length: 40 }, (_, t) => raw.filter((spans) => spans.some(([a, b]) => a <= t && t < b)).length);
    const c = concurrency(raw.map((spans) => ({ spans: spans.map(([a, b]) => ({ start: at(a * 60), end: at(b * 60) })) })));
    assert.equal(c.peak, Math.max(...expected));
    assert.equal(c.activeSessionMilliseconds, expected.reduce((a, b) => a + b) * 60_000);
    assert.equal(c.wallClockActiveMilliseconds, expected.filter(Boolean).length * 60_000);
  }
});

test("workflow: UTC heatmaps split hours, value follows request time and streaks use snapshot day", () => {
  const { collector: c, event } = codex(); event(0, "user_message"); c.tool(at(120)); event(180, "task_complete");
  const w = c.finish(AFTER);
  w.time.activeSpans = [{ start: "2026-06-01T23:59:00Z", end: "2026-06-02T00:01:00Z" }];
  w.valueByHour = [{ hour: "2026-06-03T05:00:00Z", usd: 4 }]; w.pricedRequests = 2; w.timestampedPricedRequests = 1;
  const summary = summarizeWorkflow([session(w)], undefined, "2026-06-03T12:00:00Z");
  assert.equal(summary.patterns.cells.find((c) => c.weekday === 1 && c.hour === 23)?.activeMilliseconds, 60_000);
  assert.equal(summary.patterns.cells.find((c) => c.weekday === 2 && c.hour === 0)?.activeMilliseconds, 60_000);
  assert.equal(summary.patterns.cells.find((c) => c.weekday === 3 && c.hour === 5)?.apiEquivalentUsd, 4);
  assert.equal(summary.patterns.activeDays, 2); assert.equal(summary.patterns.longestStreakDays, 2); assert.equal(summary.patterns.currentStreakDays, 2);
  assert.equal(summarizeWorkflow([session(w)], undefined, "2026-06-05T00:00:00Z").patterns.currentStreakDays, 0);
});

test("workflow: empty and unsupported scopes keep ratios unavailable", () => {
  const empty = summarizeWorkflow([], undefined, at(0));
  assert.equal(empty.autonomy.turnsPerSession, null); assert.equal(empty.interruptions.perHumanTurn, null); assert.equal(empty.concurrency.effectiveParallelism, null);
  const cursor = summarizeWorkflow([{ provider: "cursor", repositoryId: "repo", transcript: { status: "ok" } } as SessionAnalytics], undefined, at(0));
  assert.equal(cursor.coverage.sessions, 1); assert.equal(cursor.coverage.supportedSessions, 0);
  assert.equal(cursor.autonomy.turnWallTime.p50, null);
  const c = new WorkflowCollector("claude"); c.gap("malformed");
  const partial = summarizeWorkflow([session(c.finish(AFTER))], undefined, at(0));
  assert.equal(partial.coverage.partialSessions, 1);
  assert.equal(partial.coverage.timedSessions, 0, "a parse gap without positive event span is not timed evidence");
});

test("workflow: leading command token is bounded, argument-free and never a path prefix", () => {
  assert.equal(slashCommand("/review secret args /private/path"), "/review");
  assert.equal(slashCommand("/plugin:review\nSENTINEL", new Set(["/plugin:review"])), "/plugin:review");
  for (const value of ["/PRIVATE_FILE.txt", "/PRIVATE_DIRECTORY", "/PRIVATE_RAW_ID", "/plugin:review", "ordinary /review", " /review", "/Users/private/file", "/review;secret", "/review?secret", "/__proto__", `/${"a".repeat(129)}`, null, 42]) assert.equal(slashCommand(value), null);
});

test("workflow: content rules default off and explicit disable beats the environment", () => {
  assert.equal(analyzeOptionsFrom([], {}).workflowContentRules, false);
  assert.equal(analyzeOptionsFrom([], { SESSION_ANALYTICS_WORKFLOW_CONTENT_RULES: "1" }).workflowContentRules, true);
  assert.equal(analyzeOptionsFrom(["--no-workflow-content-rules"], { SESSION_ANALYTICS_WORKFLOW_CONTENT_RULES: "1" }).workflowContentRules, false);
  assert.equal(analyzeOptionsFrom(["--workflow-content-rules"], {}).workflowContentRules, true);
});

test("workflow: large histories are bounded and label partial coverage", () => {
  const { collector: c, event } = codex(); event(0, "user_message");
  for (let n = 1; n < 100_100; n += 1) c.tool(at(n));
  const w = c.finish(AFTER);
  assert.equal(w.coverage.timing, "partial"); assert.ok(w.coverage.droppedEvents > 0);
  assert.equal(w.toolRuns.samples, 0); assert.equal(w.abandonment, "insufficient-evidence");
});

test("workflow: final streamed end and recorded duration replace earlier timing evidence once", () => {
  const c = new WorkflowCollector("claude");
  c.observe({ type: "user", timestamp: at(0), uuid: "human", message: { content: "synthetic" } }, 1);
  c.observe({ type: "assistant", timestamp: at(10), uuid: "a", message: { id: "same", stop_reason: "end_turn", content: [] } }, 2);
  c.observe({ type: "assistant", timestamp: at(20), uuid: "b", message: { id: "same", stop_reason: "end_turn", content: [] } }, 3);
  c.observe({ type: "system", timestamp: at(21), uuid: "c", subtype: "turn_duration", durationMs: 22_000 }, 4);
  const w = c.finish(AFTER);
  assert.deepEqual(w.turnWallTime, histogram([22_000]));
  assert.equal(w.recordedTurnDurations, 1); assert.equal(w.inferredTurnDurations, 0);
  assert.equal(w.time.activeMilliseconds, 20_000);
  assert.deepEqual(c.finish(AFTER), w, "finalization must be repeatable");
});

function cohorts(left = 5, right = 5): SessionAnalytics[] {
  return Array.from({ length: left + right }, (_, index) => {
    const newer = index >= left;
    const { collector: c, event } = codex(); event(0, "user_message"); event(0, "task_started"); c.tool(at(30), 3); event(60, "task_complete", { duration_ms: newer ? 90_000 : 60_000 });
    const w = c.finish(AFTER);
    w.mix = [{ at: at(0), model: "gpt-test", cliVersion: newer ? "0.141.0" : "0.140.0", effort: "high", entrypoint: "cli", originator: "codex_cli_rs" }];
    return session(w, { createdAt: at(index * 86_400) });
  });
}

test("workflow: before/after compares five matched sessions per era and pools actual turn samples", () => {
  const result = compareVersions(cohorts());
  assert.equal(result.length, 1); assert.equal(result[0]?.status, "eligible");
  assert.equal(result[0]?.beforeSessions, 5); assert.equal(result[0]?.afterSessions, 5);
  assert.equal(result[0]?.turnTimeChange, .5); assert.equal(result[0]?.beforeTurnP50, 60_000);
  assert.equal(result[0]?.durationEvidence, "provider-duration");
});

test("workflow: comparison guards small cohorts, different contexts, open sessions and overlapping eras", () => {
  assert.equal(compareVersions(cohorts(4, 5))[0]?.status, "small-cohort");
  assert.equal(compareVersions(cohorts(4, 5))[0]?.turnTimeChange, null);
  const overlapping = cohorts(); overlapping[0]!.createdAt = at(8 * 86_400);
  assert.equal(compareVersions(overlapping)[0]?.status, "overlapping-eras");
  assert.equal(compareVersions(overlapping)[0]?.beforeSessions, 4, "before counts must exclude the old version used after the boundary");
  const contexts = cohorts();
  for (const s of contexts.slice(5)) s.repositoryId = "another-repo";
  assert.equal(compareVersions(contexts).length, 0);
  const efforts = cohorts(); for (const s of efforts.slice(5)) s.workflow!.mix[0]!.effort = "low";
  assert.equal(compareVersions(efforts).length, 0);
  const mixed = cohorts(); mixed[0]!.workflow!.mix.push({ ...mixed[0]!.workflow!.mix[0]!, cliVersion: "0.141.0" });
  assert.equal(compareVersions(mixed)[0]?.status, "small-cohort");
  const open = cohorts(); open[0]!.workflow!.ending = "open";
  assert.equal(compareVersions(open)[0]?.status, "small-cohort");
  const evidence = cohorts(); evidence[0]!.workflow!.recordedTurnDurations = 0; evidence[0]!.workflow!.inferredTurnDurations = 1;
  assert.equal(compareVersions(evidence)[0]?.status, "small-cohort");
});

test("workflow: sparse evidence cannot establish a quick session; inferred endings are not ongoing", () => {
  const { collector: sparse, event } = codex(); event(0, "user_message"); sparse.tool(at(3600));
  assert.equal(sparse.finish(AFTER).archetype, null);
  const c = new WorkflowCollector("claude");
  c.observe({ type: "user", timestamp: at(0), message: { content: "synthetic" } }, 1);
  c.tool(at(10), 3);
  c.observe({ type: "assistant", timestamp: at(30), message: { content: [] } }, 2);
  const w = c.finish(BASE + 60_000);
  assert.equal(w.ending, "inferred"); assert.equal(w.abandonment, "not-flagged");
});

test("workflow: comparison windows exclude distant baselines and do not divide by tiny timings", () => {
  const old = cohorts(); old[0]!.createdAt = at(-30 * 86_400);
  assert.equal(compareVersions(old)[0]?.beforeSessions, 4);
  const tiny = cohorts(); for (const s of tiny.slice(0, 5)) s.workflow!.turnWallTime = histogram([500]);
  assert.equal(compareVersions(tiny)[0]?.status, "eligible"); assert.equal(compareVersions(tiny)[0]?.turnTimeChange, null);
});
