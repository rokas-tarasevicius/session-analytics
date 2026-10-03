import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReliabilityCollector } from "../src/metrics/reliability.ts";
import { combineReliability, observeClaude, observeCodex } from "../src/metrics/reliability-providers.ts";
import { shellClass } from "../src/metrics/reliability-rules.ts";
import { summarizeReliability, summarizeReliabilityComparisons } from "../src/public/reliability-data.js";
import { analyzeMachineSessionsIsolated } from "../src/analysis-process.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const secret = Buffer.alloc(32, 31);
const sentinel = "review-private-content-sentinel";
const cwd = `/synthetic/${sentinel}`;
const collector = (contentRules = true) => new ReliabilityCollector({ contentRules, secret: contentRules ? secret : null });
let sequence = 0;
function call(c: ReliabilityCollector, id: string, name = "Bash", args: unknown = { command: "npm test" }): void {
  observeClaude(c, { type: "assistant", uuid: `call-${++sequence}`, message: { content: [{ type: "tool_use", id, name, input: args }] } }, sequence, cwd);
}
function result(c: ReliabilityCollector, id: string, fields: Record<string, unknown> = {}, isError: boolean | undefined = false): void {
  observeClaude(c, { type: "user", uuid: `result-${++sequence}`, toolUseResult: fields, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: sentinel }] } }, sequence, cwd);
}
function edit(c: ReliabilityCollector, id: string): void { call(c, id, "Edit", { file_path: "src/sample.ts", new_string: id }); result(c, id); }
function check(c: ReliabilityCollector, id: string): void { call(c, id); result(c, id); }
function codex(c: ReliabilityCollector, payload: Record<string, unknown>, type = "response_item"): void {
  observeCodex(c, { type, payload }, ++sequence, cwd);
}
function receipt(c: ReliabilityCollector, id: string, output: unknown): void { codex(c, { type: "function_call_output", call_id: id, output }); }
function codexCall(c: ReliabilityCollector, id: string, name = "exec_command", args: unknown = { cmd: "npm test" }): void {
  codex(c, { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
}
const summary = (c: ReliabilityCollector) => summarizeReliability([{ reliability: c.finish() }]);

test("review: asynchronous Claude launch acknowledgments never pass checks", () => {
  for (const enabled of [false, true]) for (const isError of [false, undefined]) for (const fields of [
    { isAsync: true }, { backgroundTaskId: sentinel }, { isAsync: true, status: "completed", success: true, exitCode: 0, durationMs: 2 },
  ]) {
    const c = collector(enabled); edit(c, "edit"); call(c, "check"); result(c, "check", fields, isError);
    assert.equal(summary(c).totals.outcomes.unknown, 1);
    assert.equal(c.finish().verification.passed, 0);
    assert.equal(c.finish().verification.skip, null);
    assert.equal(summary(c).totals.latency.samples, 0);
    result(c, "check", { status: "completed", durationMs: 20 });
    assert.equal(c.finish().verification.passed, Number(enabled), "independently linked terminal result resolves the launch");
    assert.equal(summary(c).totals.outcomes.success, 2);
    assert.doesNotMatch(JSON.stringify(c.finish()), new RegExp(sentinel));
  }
  for (const fields of [{ isAsync: true, exitCode: 1 }, { isAsync: true, interrupted: true }, { isAsync: true, timedOutAfterMs: 10 }]) {
    const c = collector(); call(c, "failed"); result(c, "failed", fields);
    assert.equal(summary(c).totals.outcomes.unknown, 0, "explicit terminal failures survive launch metadata");
    assert.equal(c.finish().verification.passed, 0);
  }
  const launch = collector(); edit(launch, "one"); edit(launch, "two"); call(launch, "check"); result(launch, "check", { isAsync: true, success: true }); edit(launch, "three");
  assert.equal(launch.finish().flags?.edit_thrash, 1, "a launch cannot reset passing-check windows");
});

test("review: orphan results and partial constituents suppress scope-wide claims", () => {
  const complete = collector();
  for (let i = 0; i < 3; i++) edit(complete, `edit-${i}`);
  check(complete, "check-1"); check(complete, "check-2");
  const good = complete.finish(); assert.equal(good.verification.skip, false); assert.notEqual(good.verification.share, null);
  complete.result("orphan", { outcome: "success", error: null, durationMs: null });
  const orphan = complete.finish();
  assert.equal(orphan.coverage.unmatchedResults, 1);
  assert.equal(orphan.verification.skip, null); assert.equal(orphan.verification.share, null); assert.equal(orphan.flags, null);
  assert.equal(summarizeReliability([{ reliability: orphan }]).verification.share, null);
  const partial = collector(); partial.truncated = true;
  for (const incomplete of [partial.finish(), orphan]) {
    const combined = combineReliability([incomplete, good], false);
    assert.equal(combined.verification.skip, null); assert.equal(combined.verification.share, null); assert.equal(combined.flags, null);
  }
});

test("review: capped analysis worker suppresses malformed-main/subagent and orphan verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reliability-review-worker-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    for (const [offset, malformed] of [[3, true], [4, false]] as const) {
      const id = `${offset}${offset}${offset}${offset}${offset}${offset}${offset}${offset}-3333-4333-8333-333333333333`;
      const main = { type: "user", uuid: `main-${id}`, sessionId: id, cwd: fixture.repositoryRoot, timestamp: "2026-07-20T12:00:00Z", message: { content: malformed ? sentinel : [{ type: "tool_result", tool_use_id: "orphan", is_error: false }] } };
      await writeFile(join(fixture.claudeRoot, `${id}.jsonl`), `${JSON.stringify(main)}\n${malformed ? "{malformed\n" : ""}`);
      const children = join(fixture.claudeRoot, id, "subagents"); await mkdir(children, { recursive: true });
      const records = Array.from({ length: 6 }, (_, i) => [
        { type: "assistant", uuid: `a-${i}`, sessionId: id, message: { content: [{ type: "tool_use", id: `tool-${i}`, name: i < 3 ? "Edit" : "Bash", input: i < 3 ? { file_path: sentinel } : { command: "npm test" } }] } },
        { type: "user", uuid: `r-${i}`, sessionId: id, message: { content: [{ type: "tool_result", tool_use_id: `tool-${i}`, is_error: false, content: sentinel }] } },
      ]).flat();
      await writeFile(join(children, "agent-synthetic.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));
    }
    const snapshot = await analyzeMachineSessionsIsolated({ ...fixture, reliabilityContentRules: true, dataDir: join(directory, "key") });
    const partials = snapshot.sessions.flatMap((s) => s.reliability && (s.reliability.coverage.truncated || s.reliability.coverage.unmatchedResults) && s.reliability.verification.checks === 3 ? [s.reliability] : []);
    assert.equal(partials.length, 2);
    for (const r of partials) { assert.equal(r.verification.skip, null); assert.equal(r.verification.share, null); assert.equal(r.flags, null); }
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(sentinel));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("review: verification requires a check start after edit completion", () => {
  for (const completionOrder of [["check", "edit"], ["edit", "check"]]) {
    const c = collector();
    observeClaude(c, { type: "assistant", uuid: `parallel-${++sequence}`, message: { content: [
      { type: "tool_use", id: "edit", name: "Edit", input: { file_path: "src/sample.ts" } },
      { type: "tool_use", id: "check", name: "Bash", input: { command: "npm test" } },
    ] } }, sequence, cwd);
    for (const id of completionOrder) result(c, id);
    assert.equal(c.finish().verification.skip, null, "parallel launches cannot establish following verification");
  }
  const sequential = collector(); edit(sequential, "edit"); check(sequential, "check");
  assert.equal(sequential.finish().verification.skip, false);
  const preceding = collector(); check(preceding, "check"); edit(preceding, "edit");
  assert.equal(preceding.finish().verification.skip, true);
  const interleaved = collector(); call(interleaved, "edit", "Edit", { file_path: "sample.ts" }); check(interleaved, "overlap"); result(interleaved, "edit"); check(interleaved, "following");
  assert.equal(interleaved.finish().verification.skip, false, "a later causal check resolves an earlier overlap");
  const duplicate = collector(); edit(duplicate, "edit"); check(duplicate, "check"); result(duplicate, "edit");
  assert.equal(duplicate.finish().verification.skip, false, "duplicate results do not move an edit past its following check");
});

test("review: overlapping passing checks do not clear edit-thrash windows", () => {
  for (const overlapping of [false, true]) {
    const c = collector(); edit(c, "one");
    call(c, "two", "Edit", { file_path: "src/sample.ts", new_string: "two" });
    if (overlapping) { call(c, "check"); result(c, "check"); result(c, "two"); }
    else { result(c, "two"); check(c, "check"); }
    edit(c, "three");
    assert.equal(c.finish().flags?.edit_thrash, overlapping ? 1 : 0);
  }
});

test("review: running receipt stdout cannot supply exit codes or latency", () => {
  for (const stdout of ["Exit code 0", "Process exited with code 1", "Wall time: 123 seconds\nExit code 0"]) {
    const c = collector(); codexCall(c, "running");
    receipt(c, "running", `Chunk ID: synthetic\nWall time: 0.1 seconds\nProcess running with session ID 123\nOutput:\n${stdout}\n${sentinel}`);
    assert.equal(summary(c).totals.outcomes.unknown, 1); assert.equal(summary(c).totals.latency.samples, 0); assert.equal(c.finish().verification.passed, 0);
  }
  const complete = collector(); codexCall(complete, "done");
  receipt(complete, "done", `Chunk ID: synthetic\nWall time: 1 seconds\nProcess exited with code 0\nFinal output:\nExit code 1\nWall time: 999 seconds\n${sentinel}`);
  assert.equal(complete.finish().verification.passed, 1); assert.ok(summary(complete).totals.latency.p95Ms! < 1101);
  const ambiguous = collector(); codexCall(ambiguous, "ambiguous"); receipt(ambiguous, "ambiguous", "Some program output\nExit code 0\nWall time: 1 seconds");
  assert.equal(summary(ambiguous).totals.outcomes.unknown, 1);
});

test("review: cleanup help version and background commands never verify or reset churn", () => {
  const commands = ["make clean", "cmake --version", "tsc --version", "npm test --help", "npm test &", "npm test&", "pytest -h", "ninja -t clean", "mvn clean", "gradle clean", "xcodebuild -list", "make -n test", "ninja -n test", "tsc --init", "pytest --fixtures", "eslint --print-config sample.js", "cmake -S . -B build", "make custom-unknown-target"];
  for (const command of commands) {
    assert.equal(shellClass(command), "shell", command);
    const c = collector(); edit(c, "one"); edit(c, "two"); call(c, "non-check", "Bash", { command }); result(c, "non-check"); edit(c, "three");
    assert.equal(c.finish().verification.checks, 0, command); assert.equal(c.finish().verification.skip, true, command); assert.equal(c.finish().flags?.edit_thrash, 1, command);
  }
  for (const command of ["make test", "cmake --build build", "tsc --noEmit", "npm run check", "ninja test", "mvn test", "gradle build"]) assert.equal(shellClass(command), "test_build", command);
});

test("review: Codex parsed read paths enrich existing calls without exposing paths or hashes", () => {
  for (const enabled of [false, true]) for (const sameFile of [false, true]) {
    const c = collector(enabled);
    for (let i = 0; i < 3; i++) {
      const path = sameFile ? i === 1 ? `${cwd}/src/sample.ts` : "src/../src/sample.ts" : `src/sample-${i}.ts`;
      codexCall(c, `read-${i}`, "exec_command", { cmd: `sed -n '${i + 1}p' ${sentinel}` });
      codex(c, { type: "item_completed", item: { type: "CommandExecution", id: `read-${i}`, command: `sed -n '${i + 1}p' ${sentinel}`, parsed_cmd: [{ type: "read", path }], status: "completed", exit_code: 0 } }, "event_msg");
    }
    const r = c.finish(); assert.equal(r.coverage.fileCalls, enabled ? 3 : 0); assert.equal(r.flags?.reread_churn ?? 0, enabled && sameFile ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(`${sentinel}|sample\\.ts|[a-f0-9]{64}`));
  }
});

test("review: MCP server identity separates tools and repeat fingerprints across provider shapes", () => {
  for (const sameServer of [false, true]) for (const failed of [false, true]) {
    const c = collector();
    for (let i = 0; i < 3; i++) {
      const server = sameServer ? "sample" : `server-${i}`;
      const args = { query: sentinel };
      if (i === 0) { call(c, `mcp-${i}`, `mcp__${server}__search`, args); result(c, `mcp-${i}`, {}, failed); }
      else {
        codexCall(c, `mcp-${i}`, i === 1 ? `functions.mcp__${server}__search` : "search", args);
        codex(c, { type: "item_completed", item: { type: "McpToolCall", id: `mcp-${i}`, server, tool: "search", arguments: args, status: failed ? "failed" : "completed" } }, "event_msg");
      }
    }
    const r = c.finish(); assert.equal(r.tools.length, sameServer ? 1 : 3); assert.equal(r.flags?.exact_repeat, sameServer ? 1 : 0); assert.equal(r.flags?.repeated_failure, sameServer && failed ? 1 : 0);
    assert.ok(r.tools.every((t) => t.name.length <= 128)); assert.doesNotMatch(JSON.stringify(r), new RegExp(sentinel));
  }
  const long = collector();
  for (const suffix of ["a", "b"]) codex(long, { type: "item_completed", item: { type: "McpToolCall", id: suffix, server: "server".repeat(20) + suffix, tool: "search".repeat(20), arguments: {}, status: "completed" } }, "event_msg");
  assert.equal(long.finish().tools.length, 2); assert.ok(long.finish().tools.every((t) => t.name.length <= 128));
});

test("review: out-of-order receipts retain only content-free tool-sensitive evidence", () => {
  for (const name of ["exec_command", "apply_patch", "mcp__sample__lookup"]) {
    const outputs = name === "exec_command" ? ["Process exited with code 1\nWall time: 1 seconds\nFinal output:\n" + sentinel] : [JSON.stringify({ isError: true, duration_ms: 20, output: sentinel })];
    const projections = [];
    for (const late of [false, true]) {
      const c = collector(); if (!late) codexCall(c, "late", name);
      receipt(c, "late", outputs[0]); receipt(c, "late", outputs[0]);
      if (late) codexCall(c, "late", name);
      projections.push(c.finish().tools);
      assert.equal(summary(c).totals.outcomes.error, 1); assert.equal(summary(c).totals.latency.samples, 1);
      assert.doesNotMatch(JSON.stringify(c.finish()), new RegExp(`${sentinel}|[a-f0-9]{64}`));
    }
    assert.deepEqual(projections[1], projections[0]);
  }
  const nonShell = collector(); receipt(nonShell, "edit", "Process exited with code 0\nWall time: 1 seconds"); codexCall(nonShell, "edit", "apply_patch");
  assert.equal(summary(nonShell).totals.outcomes.unknown, 1, "shell envelopes never establish edit or MCP success");
  const orphan = collector(); receipt(orphan, "orphan", `Process exited with code 1\nWall time: 1 seconds\nFinal output:\n${sentinel}`);
  assert.equal(orphan.finish().coverage.unmatchedResults, 1); assert.equal(summary(orphan).totals.calls, 0);
  assert.doesNotMatch(JSON.stringify([...orphan.pending.values()]), new RegExp(sentinel), "pending state must not retain receipt content");
  const lateEdit = collector();
  observeClaude(lateEdit, { type: "user", uuid: `late-edit-${++sequence}`, message: { content: [{ type: "tool_result", tool_use_id: "late-edit", is_error: true, content: `String to replace not found ${sentinel}` }] } }, sequence, cwd);
  call(lateEdit, "late-edit", "Edit", { file_path: sentinel });
  assert.equal(summary(lateEdit).totals.errors.edit_anchor_mismatch, 1);
  assert.doesNotMatch(JSON.stringify([...lateEdit.calls.values()]), new RegExp(sentinel), "retained calls contain only hashes and rule labels");
});

test("review: lightweight scope comparisons preserve full-summary totals and verification", () => {
  const first = collector(); edit(first, "edit"); check(first, "check");
  const second = collector(); edit(second, "edit"); second.result("orphan", { outcome: "error", error: "unknown", durationMs: 123 });
  const sessions = [
    { provider: "claude", repositoryId: "one", repositoryName: "Synthetic one", reliability: first.finish() },
    { provider: "codex", repositoryId: "one", repositoryName: "Synthetic one", reliability: second.finish() },
    { provider: "cursor", repositoryId: "two", repositoryName: "Synthetic two" },
  ];
  const comparisons = summarizeReliabilityComparisons(sessions);
  for (const [groups, property] of [[comparisons.providers, "provider"], [comparisons.repositories, "repositoryName"]] as const) for (const group of groups) {
    const full = summarizeReliability(sessions.filter((s) => s[property] === group.name));
    assert.deepEqual(group.totals, full.totals);
    assert.equal(group.sessions, full.sessions); assert.equal(group.coveredSessions, full.coveredSessions);
    assert.equal(group.verification.eligibleSessions, full.verification.eligibleSessions);
    assert.equal(group.verification.skippedSessions, full.verification.skippedSessions);
  }
});
