import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { WorkflowCollector } from "../src/metrics/workflow.ts";
import { compareVersions, histogram } from "../src/public/workflow-data.js";
import type { SessionAnalytics } from "../src/types.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const base = Date.parse("2026-06-01T10:00:00Z");
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const after = base + 3 * 86_400_000;
function collector() {
  const c = new WorkflowCollector("codex");
  c.observe({ type: "session_meta", timestamp: at(0), payload: { source: "cli", cli_version: "0.140.0", originator: "codex_cli_rs" } }, 0);
  c.observe({ type: "turn_context", timestamp: at(0), payload: { model: "gpt-test", effort: "high" } }, 1);
  let line = 2;
  return { c, event: (seconds: number, type: string, payload: Record<string, unknown> = {}, uuid?: string) => c.observe({ type: "event_msg", timestamp: at(seconds), uuid, payload: { type, ...payload } }, line++) };
}

test("review 3: stale completions and aborts cannot close, split or add waiting to the current turn", () => {
  for (const staleKind of ["task_complete", "turn_aborted"]) {
    const { c, event } = collector();
    event(0, "user_message"); event(0, "task_started", { turn_id: "a" });
    event(20, "turn_aborted", { turn_id: "a", reason: "interrupted", duration_ms: 20_000 });
    event(21, "user_message"); event(21, "task_started", { turn_id: "b" }); c.tool(at(30), 3);
    event(40, staleKind, { turn_id: staleKind === "turn_aborted" ? "unrelated" : "a", duration_ms: 40_000 });
    const open = c.finish(after);
    assert.equal(open.ending, "open"); assert.equal(open.abandonment, "flagged");
    assert.equal(open.time.activeMilliseconds, 29_000, "rejected markers are not work evidence");
    assert.equal(open.time.waitingForHumanMilliseconds, 1_000);
    assert.deepEqual(open.turnWallTime, histogram([20_000]));
    const sessions = Array.from({ length: 10 }, (_, index) => ({
      provider: "codex", repositoryId: "repo", createdAt: at(index * 86_400), transcript: { status: "ok", snapshotWhileWorking: false },
      workflow: { ...open, mix: open.mix.map((m) => ({ ...m, cliVersion: index < 5 ? "0.140.0" : "0.141.0" })) },
    } as SessionAnalytics));
    assert.deepEqual(compareVersions(sessions), []);
    c.tool(at(50));
    assert.equal(c.finish(after).time.activeMilliseconds, 49_000, "work spans join past a rejected marker");
    event(60, "task_complete", { turn_id: "b" });
    const closed = c.finish(after);
    assert.equal(closed.ending, "terminal"); assert.equal(closed.abandonment, "not-flagged");
    assert.deepEqual(closed.turnWallTime, histogram([20_000, 39_000]));
  }
});

test("review 5: same-timestamp humans are distinct unless a stable event ID repeats", () => {
  const { c, event } = collector();
  event(0, "user_message"); event(0, "user_message"); c.tool(at(10), 3);
  assert.equal(c.finish(after).humanTurns, 2);
  assert.deepEqual(c.finish(after).toolRuns, histogram([0, 3]));
  const identified = collector();
  identified.event(0, "user_message", {}, "stable-human");
  identified.event(5, "user_message", {}, "stable-human");
  identified.event(5, "user_message", {}, "different-human"); identified.c.tool(at(10), 3);
  assert.equal(identified.c.finish(after).humanTurns, 2);
  assert.deepEqual(identified.c.finish(after).toolRuns, histogram([0, 3]));
  const messages = collector();
  messages.event(0, "user_message", { message_id: "first" }); messages.event(1, "user_message", { message_id: "first" });
  messages.event(2, "user_message", { id: "second" }); messages.event(3, "user_message", { id: "second" });
  assert.equal(messages.c.finish(after).humanTurns, 2);
});

test("review 2: malformed middle and truncated tail records invalidate primary boundary evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-gaps-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const project = join(fixture.claudeRoot, (await readdir(fixture.claudeRoot))[0]!);
    const main = join(project, "22222222-2222-4222-8222-222222222222.jsonl");
    const codexFile = join(fixture.codexRoot, "2026/07/20", (await readdir(join(fixture.codexRoot, "2026/07/20")))[0]!);
    const claude = [
      { type: "user", sessionId: "22222222-2222-4222-8222-222222222222", cwd: fixture.repositoryRoot, timestamp: at(0), message: { content: "synthetic" } },
      { type: "assistant", timestamp: at(30), message: { id: "synthetic-usage", model: "claude-opus-5", content: [1, 2, 3].map((id) => ({ type: "tool_use", id: `tool-${id}`, name: "Read" })), usage: { input_tokens: 100, output_tokens: 20 } } },
    ];
    const codex = [
      { type: "session_meta", timestamp: at(0), payload: { id: "11111111-1111-4111-8111-111111111111", cwd: fixture.repositoryRoot, source: "cli" } },
      { type: "event_msg", timestamp: at(0), payload: { type: "user_message" } },
      ...[1, 2, 3].map((id) => ({ type: "response_item", timestamp: at(id * 10), payload: { type: "function_call", call_id: `tool-${id}`, name: "read_file" } })),
    ];
    for (const tail of [false, true]) {
      for (const [path, rows] of [[main, claude], [codexFile, codex]] as const) {
        const lines = rows.map((r) => JSON.stringify(r));
        if (!tail) lines.push(JSON.stringify(path === main
          ? { type: "system", subtype: "turn_duration", timestamp: at(60), durationMs: 60_000 }
          : { type: "event_msg", timestamp: at(60), payload: { type: "task_complete", duration_ms: 60_000 } }));
        lines.splice(tail ? lines.length : 1, 0, '{"PRIVATE_TRUNCATED_RECORD":');
        await writeFile(path, lines.join("\n") + (tail ? "" : "\n"));
      }
      const result = await analyzeMachineSessions(fixture);
      for (const provider of ["claude", "codex"]) {
        const s = result.sessions.find((s) => s.provider === provider && s.transcript.status === "ok")!;
        assert.ok(s.transcript.warnings.some((w) => w.includes("malformed JSONL")));
        const w = s.workflow!;
        assert.equal(w.coverage.timing, "partial", `${provider} ${tail ? "tail" : "middle"}`);
        assert.equal(w.coverage.malformedRecords, 1); assert.equal(w.coverage.projectionErrors, 0);
        assert.equal(w.coverage.humanTurns, "partial"); assert.equal(w.ending, "unavailable");
        assert.equal(w.toolRuns.samples, 0); assert.equal(w.inferredTurnDurations, 0);
        assert.equal(w.abandonment, "insufficient-evidence");
        assert.equal(w.time.waitingForHumanMilliseconds, 0);
        assert.equal(w.time.activeMilliseconds, 0, "gapped transcripts cannot establish uninterrupted activity spans");
        assert.equal(w.recordedTurnDurations, tail ? 0 : 1);
        assert.equal(w.turnWallTime.samples, tail ? 0 : 1);
        assert.deepEqual(compareVersions([s]), []);
      }
      assert.equal(result.workflow!.coverage.partialSessions, 2);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TRUNCATED_RECORD/);
    }
    await writeFile(main, claude.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await writeFile(join(project, "22222222-2222-4222-8222-222222222222", "subagents", "malformed-child.jsonl"), "{\"PRIVATE_CHILD_TAIL\":");
    const s = (await analyzeMachineSessions(fixture)).sessions.find((s) => s.provider === "claude")!;
    assert.equal(s.workflow!.coverage.timing, "observed", "excluded child errors must not invalidate primary evidence");
    assert.ok(s.transcript.warnings.some((w) => w.includes("child") && w.includes("malformed JSONL")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review 4: non-string optional enums cannot change accounting or escape the workflow projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-metadata-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const main = join(fixture.claudeRoot, (await readdir(fixture.claudeRoot))[0]!, "22222222-2222-4222-8222-222222222222.jsonl");
    const original = (await readFile(main, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const codexFile = join(fixture.codexRoot, "2026/07/20", (await readdir(join(fixture.codexRoot, "2026/07/20")))[0]!);
    const originalCodex = (await readFile(codexFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const baselineSessions = (await analyzeMachineSessions(fixture)).sessions;
    const baseline = baselineSessions.find((s) => s.provider === "claude")!;
    for (const value of [{ toString: "PRIVATE_BAD_METADATA" }, ["cli"], ["high"], null]) {
      await writeFile(main, original.map((row) => JSON.stringify({ ...row, entrypoint: value, effort: value })).join("\n") + "\n");
      await writeFile(codexFile, originalCodex.map((row) => JSON.stringify({ ...row, payload: {
        ...row.payload as Record<string, unknown>,
        ...(row.type === "session_meta" ? { source: value, originator: value } : row.type === "turn_context" ? { effort: value } : {}),
      } })).join("\n") + "\n");
      const result = await analyzeMachineSessions(fixture), s = result.sessions.find((s) => s.provider === "claude")!;
      assert.deepEqual(result.sessions.map((s) => [s.tokens, s.cost, s.metrics]), baselineSessions.map((s) => [s.tokens, s.cost, s.metrics]));
      assert.deepEqual(s.tokens, baseline.tokens); assert.deepEqual(s.cost, baseline.cost); assert.deepEqual(s.metrics, baseline.metrics);
      assert.ok(s.workflow!.mix.every((m) => typeof m.entrypoint === "string" && m.effort === null));
      assert.doesNotMatch(JSON.stringify(s.workflow), /PRIVATE_BAD_METADATA/);
      const { c } = collector();
      assert.doesNotThrow(() => {
        c.observe({ type: "session_meta", timestamp: at(1), payload: { source: value, originator: value } }, 2);
        c.observe({ type: "turn_context", timestamp: at(2), payload: { effort: value } }, 3);
        c.observe({ type: "event_msg", timestamp: at(3), payload: { type: "item_completed", item: { type: value } } }, 4);
        const cl = new WorkflowCollector("claude");
        cl.observe({ type: "queue-operation", timestamp: at(0), reason: value }, 0);
        assert.equal(cl.finish(after).steering.queueReasons.prompt, 0);
      });
      assert.equal(c.finish(after).mix.at(-1)!.originator, "unknown");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review 4: an optional observer exception cannot discard a valid accounting record", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-observer-"));
  const observe = WorkflowCollector.prototype.observe;
  const finish = WorkflowCollector.prototype.finish;
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const baseline = await analyzeMachineSessions(fixture);
    WorkflowCollector.prototype.observe = () => { throw new Error("PRIVATE_PROJECTION_ERROR"); };
    const result = await analyzeMachineSessions(fixture);
    assert.deepEqual(result.summary, baseline.summary);
    assert.deepEqual(result.sessions.map((s) => [s.tokens, s.cost, s.metrics]), baseline.sessions.map((s) => [s.tokens, s.cost, s.metrics]));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROJECTION_ERROR|malformed JSONL/);
    assert.ok(result.sessions.filter((s) => s.workflow).every((s) => s.workflow!.coverage.timing !== "observed"));
    WorkflowCollector.prototype.observe = observe;
    WorkflowCollector.prototype.finish = () => { throw new Error("PRIVATE_PROJECTION_ERROR"); };
    const unavailable = await analyzeMachineSessions(fixture);
    assert.deepEqual(unavailable.summary, baseline.summary);
    assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE_PROJECTION_ERROR/);
    assert.ok(unavailable.sessions.filter((s) => s.provider !== "cursor").every((s) => s.workflow === undefined));
  } finally { WorkflowCollector.prototype.observe = observe; WorkflowCollector.prototype.finish = finish; await rm(root, { recursive: true, force: true }); }
});
