import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReliabilityCollector } from "../src/metrics/reliability.ts";
import { combineReliability, observeClaude, observeCodex } from "../src/metrics/reliability-providers.ts";
import { classifyTool, fingerprint, shellClass } from "../src/metrics/reliability-rules.ts";
import { loadReliabilitySecret } from "../src/metrics/reliability-secret.ts";
import { reliabilityReport } from "../src/metrics/reliability-report.ts";
import { errorRate, latencyFrom, mergeLatency, summarizeReliability } from "../src/public/reliability-data.js";
import { analyzeOptionsFrom } from "../src/options.ts";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { analyzeMachineSessionsIsolated } from "../src/analysis-process.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";
import type { SessionReliability } from "../src/metrics/reliability-types.ts";

const key = Buffer.alloc(32, 17);
const cwd = "/synthetic/private-reliability-root";
const sentinel = "reliability-private-sentinel";
const time = (n: number): string => new Date(Date.UTC(2026, 6, 20, 10) + n * 1000).toISOString();
const collector = (enabled = true): ReliabilityCollector => new ReliabilityCollector({ contentRules: enabled, secret: enabled ? key : null });
let sequence = 0;
function claudeCall(c: ReliabilityCollector, name: string, input: unknown, fields: Record<string, unknown> = {}, isError = false, content = sentinel): string {
  const id = `synthetic-call-${++sequence}`;
  observeClaude(c, { type: "assistant", timestamp: time(sequence), uuid: `a-${id}`, message: { content: [{ type: "tool_use", id, name, input }] } }, sequence, cwd);
  const { toolDenialKind, ...structured } = fields;
  observeClaude(c, { type: "user", timestamp: time(sequence + 1), uuid: `r-${id}`, toolDenialKind, toolUseResult: structured, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] } }, sequence, cwd);
  return id;
}
function codexItem(c: ReliabilityCollector, item: Record<string, unknown>): void {
  observeCodex(c, { type: "event_msg", timestamp: time(++sequence), payload: { type: "item_completed", item } }, sequence, cwd);
}
const summarize = (reliability: SessionReliability) => summarizeReliability([{ reliability }]);

test("Claude reconciles streamed calls and results with explicit outcome precedence", () => {
  const c = collector();
  const first = claudeCall(c, "Read", { file_path: `${cwd}/${sentinel}` });
  observeClaude(c, { type: "assistant", uuid: "another-stream", message: { content: [{ type: "tool_use", id: first, name: "Read", input: {} }] } }, 100, cwd);
  observeClaude(c, { type: "user", uuid: "another-result", message: { content: [{ type: "tool_result", tool_use_id: first, content: sentinel, is_error: false }] } }, 101, cwd);
  claudeCall(c, "Bash", { command: "npm test" }, { durationMs: 200 }, true, `Exit code 1\n${sentinel}`);
  claudeCall(c, "Bash", { command: "npm test" }, { interrupted: true, durationMs: 80 }, true);
  claudeCall(c, "Bash", { command: "npm test" }, { interrupted: true, timedOutAfterMs: 100, durationMs: 100 }, true);
  claudeCall(c, "Edit", { file_path: "example.ts" }, { toolDenialKind: "user" }, true);
  claudeCall(c, "Write", {}, { toolDenialKind: "policy" }, true);
  claudeCall(c, "Write", {}, { toolDenialKind: "hook" }, true);
  c.add({ id: "pending", name: "Read", cwd, started: null });
  const result = c.finish(), s = summarize(result);
  assert.equal(s.totals.calls, 8);
  assert.deepEqual(s.totals.outcomes, { success: 1, error: 1, denied: 3, interrupted: 1, timeout: 1, unknown: 1 });
  assert.equal(s.totals.errors.test_failed, 1);
  assert.equal(s.totals.errors.permission_denied_user, 1);
  assert.equal(s.totals.errors.permission_denied_policy, 1);
  assert.equal(s.totals.errors.hook_blocked, 1);
  assert.equal(s.totals.latency.samples, 3);
  assert.equal(s.permissions.denials, 3);
  assert.equal(errorRate(s.totals), null);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${sentinel}|synthetic-call|private-reliability-root`));
});

test("low-cardinality rules classify every supported text error without returning content", () => {
  const cases = [
    ["Read", "ENOENT: no such file", "not_found"],
    ["Edit", "String to replace not found in file", "edit_anchor_mismatch"],
    ["Bash", "Permission denied by sandbox", "permission_denied_policy"],
    ["Bash", "Blocked by a hook", "hook_blocked"],
    ["Bash", "Command timed out", "timeout"],
    ["Bash", "Command not found", "command_not_found"],
    ["Bash", "Exit code 2", "nonzero_exit"],
    ["Read", "Interrupted by user", "interrupted"],
    ["Read", "HTTP 429 Too many requests", "api_rate_limit"],
    ["Read", "HTTP 503 Service unavailable", "api_server_error"],
    ["mcp__sample__lookup", "Unexpected remote fault", "mcp_error"],
    ["Read", "Unexpected failure", "unknown"],
  ] as const;
  for (const [tool, content, expected] of cases) {
    const c = collector(); claudeCall(c, tool, { command: "custom-task" }, {}, true, `${content}\n${sentinel}`);
    assert.equal(summarize(c.finish()).totals.errors[expected], 1, expected);
    assert.doesNotMatch(JSON.stringify(c.finish()), new RegExp(sentinel));
  }
  const c = collector(); claudeCall(c, "Read", {}, {}, false, "Error: ENOENT, command not found");
  claudeCall(c, "Read", {}, {}, false, "Exit code 127\nProcess exited with code 1");
  claudeCall(c, "Bash", { command: "cat sample.log" }, {}, false, "Exit code 127");
  assert.deepEqual(summarize(c.finish()).totals.errors, {});
});

test("P2 is off by default: content, arguments, command classes and flags are not inspected", () => {
  const c = collector(false);
  for (let i = 0; i < 5; i++) claudeCall(c, "Bash", { command: "npm test", file_path: sentinel }, {}, true, "Exit code 127: command not found");
  const result = c.finish();
  assert.equal(result.tools[0]?.toolClass, "shell");
  assert.deepEqual(result.tools[0]?.errors, { unknown: 5 });
  assert.equal(result.flags, null);
  assert.equal(result.verification.share, null);
  assert.equal(result.hashing, "disabled");
  assert.equal(result.coverage.argumentCalls, 0);
  assert.equal(result.coverage.fileCalls, 0);
  assert.equal(errorRate(summarize(result).totals), 1);
});

test("cross-provider ontology uses bounded names, conservative argv and typed parsed_cmd", () => {
  const examples = new Map([
    ["Read", "read"], ["Grep", "search"], ["Edit", "edit"], ["Write", "write"], ["Bash", "shell"],
    ["mcp__sample__find", "mcp"], ["functions.spawn_agent", "delegate"], ["WebSearch", "web"], ["web.run", "web"], ["update_plan", "plan"], ["unknown_tool", "other"],
  ]);
  for (const [tool, kind] of examples) assert.equal(classifyTool(tool, {}, [], false), kind);
  const commands = new Map([
    ["npm test", "test_build"], ["cd '/synthetic/repo' && npm run check", "test_build"], ["CI=1 pnpm run test:unit", "test_build"],
    ["python3 -m pytest", "test_build"], ["node --test test/example.ts", "test_build"], ["go test ./...", "test_build"],
    ["git status", "vcs"], ["/usr/bin/git diff", "vcs"], ["rg example src", "search"], ["sed -n '1,20p' example.ts", "read"],
    ["echo 'npm test'", "shell"], ["npm install", "shell"], ["sed -i 's/a/b/' file", "shell"], ["cat file | custom", "shell"],
    ["echo $(npm test)", "shell"], ["sh -c 'npm test'", "shell"], ["npm test || true", "shell"],
  ]);
  for (const [command, kind] of commands) assert.equal(shellClass(command), kind, command);
  assert.equal(classifyTool("exec_command", {}, [{ type: "search" }], false), "search");
  assert.equal(classifyTool("exec_command", {}, [{ type: "read" }, { type: "list_files" }], false), "read");
  assert.equal(shellClass(["/bin/zsh", "-lc", "npm test"]), "test_build");
  assert.equal(shellClass(["git", "status"]), "vcs");
  assert.equal(classifyTool("constructor", {}, [], true), "other");
});

test("Codex typed completions reconcile calls, Duration objects, errors, MCP and FileChange", () => {
  const c = collector();
  observeCodex(c, { type: "response_item", timestamp: time(0), payload: { type: "function_call", name: "exec_command", call_id: "shared", arguments: JSON.stringify({ cmd: "npm test" }) } }, 1, cwd);
  const item = { type: "CommandExecution", id: "shared", command: "npm test", exit_code: 1, status: "completed", duration: { secs: 1, nanos: 500_000_000 }, aggregated_output: sentinel };
  codexItem(c, item); codexItem(c, item);
  codexItem(c, { type: "CommandExecution", id: "missing-command", command: "missing", exit_code: 127, status: "completed", duration: { secs: 0, nanos: 0 } });
  codexItem(c, { type: "McpToolCall", id: "mcp-error", server: "sample", tool: "lookup", status: "completed", result: { isError: true, content: sentinel }, duration: { secs: 2, nanos: 0 } });
  codexItem(c, { type: "McpToolCall", id: "mcp-ok", server: "sample", tool: "lookup", status: "completed", result: { isError: false }, duration: { secs: 1, nanos: 0 } });
  codexItem(c, { type: "FileChange", id: "change", status: "completed", changes: { [`src/${sentinel}.ts`]: { type: "update", unified_diff: sentinel } } });
  const result = c.finish(), summary = summarize(result);
  assert.equal(summary.totals.calls, 5);
  assert.equal(summary.totals.outcomes.error, 3);
  assert.equal(summary.totals.errors.test_failed, 1);
  assert.equal(summary.totals.errors.command_not_found, 1);
  assert.equal(summary.totals.errors.mcp_error, 1);
  assert.equal(summary.totals.latency.samples, 4);
  assert.ok((result.tools.find((t) => t.toolClass === "test_build")?.latency.p95Ms ?? 0) >= 1500);
  assert.equal(result.mcp[0]?.calls, 2);
  assert.equal(result.verification.skip, true);
  assert.equal(result.verification.stepsToFirstEdit, 4);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
});

test("Codex receipts keep running commands and opaque wrapper results unknown", () => {
  const c = collector();
  for (const [id, tool, output] of [
    ["ok", "exec_command", `Process exited with code 0\nWall time: 1.2 seconds\n${sentinel}`],
    ["bad", "exec_command", `Process exited with code 9\n${sentinel}`],
    ["running", "exec_command", "Process running with session ID 123"],
    ["wrapper", "functions.exec", "Script completed\nTool call output hidden"],
  ]) {
    observeCodex(c, { type: "response_item", payload: { type: "function_call", call_id: id, name: tool, arguments: '{"cmd":"npm test"}' } }, ++sequence, cwd);
    observeCodex(c, { type: "response_item", payload: { type: "function_call_output", call_id: id, output } }, ++sequence, cwd);
  }
  const s = summarize(c.finish());
  assert.deepEqual(s.totals.outcomes, { success: 1, error: 1, unknown: 2, timeout: 0, denied: 0, interrupted: 0 });
  assert.equal(s.totals.latency.samples, 1);
  assert.equal(c.finish().verification.skip, null);
});

test("Codex typed status matrix and text-block receipts keep unknown and failure distinct", () => {
  const c = collector();
  for (const [id, status] of ["completed", "failed", "declined", "interrupted", "timed_out", "in_progress"].entries()) {
    codexItem(c, { type: "CommandExecution", id: `status-${id}`, command: ["/bin/zsh", "-lc", "npm test"], status });
  }
  observeCodex(c, { type: "response_item", payload: { type: "function_call", call_id: "text-block", name: "exec_command", arguments: '{"cmd":"npm test"}' } }, ++sequence, cwd);
  observeCodex(c, { type: "response_item", payload: { type: "function_call_output", call_id: "text-block", output: [{ type: "text", text: `Process exited with code 0\n${sentinel}` }] } }, ++sequence, cwd);
  assert.deepEqual(summarize(c.finish()).totals.outcomes, { success: 2, error: 1, denied: 1, interrupted: 1, timeout: 1, unknown: 1 });
  assert.equal(c.finish().tools[0]?.toolClass, "test_build");
  assert.doesNotMatch(JSON.stringify(c.finish()), new RegExp(sentinel));
});

test("typed MCP completions enrich generic calls and default structured receipts remain available", () => {
  const c = collector(false);
  c.add({ id: "mcp", name: "lookup", cwd, started: null });
  codexItem(c, { type: "McpToolCall", id: "mcp", server: "sample", tool: "lookup", status: "completed", result: { isError: true } });
  c.add({ id: "shell", name: "exec_command", cwd, started: null });
  observeCodex(c, { type: "response_item", payload: { type: "function_call_output", call_id: "shell", output: JSON.stringify({ exit_code: 0, duration_ms: 10, output: sentinel }) } }, ++sequence, cwd);
  const result = c.finish();
  assert.equal(result.mcp[0]?.calls, 1);
  assert.equal(result.tools.find((t) => t.name === "lookup")?.toolClass, "mcp");
  assert.equal(summarize(result).totals.outcomes.success, 1);
  assert.equal(summarize(result).totals.outcomes.error, 1);
  assert.equal(summarize(result).totals.latency.samples, 1);
});

test("permission failures, asynchronous launches and return-code interpretation are conservative", () => {
  const c = collector(false);
  const id = "async";
  c.add({ id, name: "Bash", cwd, started: null });
  observeClaude(c, { type: "user", uuid: "async-result", toolUseResult: { isAsync: true, backgroundTaskId: sentinel }, message: { content: [{ type: "tool_result", tool_use_id: id }] } }, ++sequence, cwd);
  claudeCall(c, "Bash", {}, { returnCodeInterpretation: { type: "error", exitCode: 127 } }, false);
  claudeCall(c, "Edit", {}, { toolDenialKind: sentinel }, true);
  const s = summarize(c.finish());
  assert.equal(s.totals.outcomes.unknown, 1);
  assert.equal(s.totals.errors.command_not_found, 1);
  assert.equal(s.totals.outcomes.denied, 1);
  assert.equal(s.totals.errors.unknown, 1, "unknown denial kinds do not imply a policy cause");
  assert.doesNotMatch(JSON.stringify(c.finish()), new RegExp(sentinel));
});

test("out-of-order and orphan results are counted without inventing tool calls", () => {
  const c = collector(false);
  observeClaude(c, { type: "user", uuid: "before", message: { content: [{ type: "tool_result", tool_use_id: "late", is_error: true }] } }, 1, cwd);
  c.add({ id: "late", name: "Read", cwd, started: null });
  c.result("orphan", { outcome: "success", error: null, durationMs: 10 });
  assert.equal(summarize(c.finish()).totals.calls, 1);
  assert.equal(summarize(c.finish()).totals.outcomes.error, 1);
  assert.equal(c.finish().coverage.unmatchedResults, 1);
});

test("Claude batches never fan out one structured receipt across multiple tool results", () => {
  const c = collector();
  for (const id of ["one", "two"]) c.add({ id, name: "Bash", cwd, started: null });
  observeClaude(c, { type: "user", uuid: "batch", toolUseResult: { timedOutAfterMs: 100, durationMs: 100 }, message: { content: ["one", "two"].map((id) => ({ type: "tool_result", tool_use_id: id, is_error: false })) } }, 1, cwd);
  const s = summarize(c.finish());
  assert.equal(s.totals.outcomes.success, 2);
  assert.equal(s.totals.outcomes.timeout, 0);
  assert.equal(s.totals.latency.samples, 0);
});

test("loop detectors count episodes, normalize argument keys and never expose HMACs", () => {
  const c = collector();
  for (let i = 0; i < 5; i++) claudeCall(c, "Read", i % 2 ? { offset: 0, file_path: "src/sample.ts" } : { file_path: "src/sample.ts", offset: 0 });
  const result = c.finish();
  assert.equal(result.flags?.exact_repeat, 1);
  assert.equal(result.flags?.reread_churn, 1);
  assert.equal(result.flags?.repeated_failure, 0);
  const hmac = fingerprint(key, "arguments:Read", { file_path: "src/sample.ts", offset: 0 });
  assert.ok(hmac); assert.ok(!JSON.stringify(result).includes(hmac));
  assert.equal(fingerprint(key, "a", { one: 1, two: 2 }), fingerprint(key, "a", { two: 2, one: 1 }));
  assert.notEqual(fingerprint(key, "a", {}), fingerprint(Buffer.alloc(32, 18), "a", {}));
  assert.equal(fingerprint(key, "a", "x".repeat(1_048_577)), null);
});

test("failed edits, thrash and search loops use the documented thresholds and passing-check reset", () => {
  const c = collector();
  for (let i = 0; i < 3; i++) claudeCall(c, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }, {}, true, "String to replace not found");
  for (let i = 0; i < 3; i++) claudeCall(c, "Edit", { file_path: "src/a.ts", old_string: String(i), new_string: String(i + 1) });
  claudeCall(c, "Bash", { command: "npm test" }, {}, false, "Exit code 0");
  for (let i = 0; i < 3; i++) claudeCall(c, "Edit", { file_path: "src/a.ts", old_string: String(i), new_string: String(i + 1) });
  for (let i = 0; i < 15; i++) claudeCall(c, "Grep", { pattern: String(i) });
  assert.deepEqual(c.finish().flags, { exact_repeat: 1, repeated_failure: 1, failed_edit_cascade: 1, edit_thrash: 2, reread_churn: 0, search_loop: 1 });
  assert.equal(c.finish().verification.skip, true);
  assert.equal(c.finish().verification.share, 1 / 7);
});

test("edit-thrash window expires and independent subagents never form loops", () => {
  const c = collector();
  claudeCall(c, "Edit", { file_path: "src/a.ts" });
  for (let i = 0; i < 10; i++) claudeCall(c, "Bash", { command: `custom ${i}` });
  claudeCall(c, "Edit", { file_path: "src/a.ts" });
  claudeCall(c, "Edit", { file_path: "src/a.ts" });
  assert.equal(c.finish().flags?.edit_thrash, 0);
  const streams = Array.from({ length: 3 }, () => {
    const sub = collector(); claudeCall(sub, "Edit", { file_path: "src/a.ts" }); return sub.finish();
  });
  const combined = combineReliability(streams, false);
  assert.equal(combined.flags?.exact_repeat, 0);
  assert.equal(combined.flags?.edit_thrash, 0);
  assert.equal(combined.verification.skip, true);
  assert.equal(combineReliability(streams, true).verification.skip, null);
});

test("reads after a file changes are not a re-read episode and lexical paths match", () => {
  const c = collector();
  claudeCall(c, "Read", { file_path: "src/../src/a.ts" });
  claudeCall(c, "Read", { file_path: `${cwd}/src/a.ts` });
  claudeCall(c, "Edit", { file_path: "src/a.ts" });
  claudeCall(c, "Read", { file_path: "src/a.ts" });
  assert.equal(c.finish().flags?.reread_churn, 0);
  claudeCall(c, "Read", { file_path: "src/a.ts" });
  claudeCall(c, "Read", { file_path: `${cwd}/src/a.ts` });
  assert.equal(c.finish().flags?.reread_churn, 1);
});

test("active Codex turns and incomplete streams suppress verification claims", () => {
  const c = collector(); claudeCall(c, "Edit", { file_path: "sample.ts" });
  observeCodex(c, { type: "event_msg", payload: { type: "task_started" } }, ++sequence, cwd);
  assert.equal(c.finish().verification.skip, null);
  observeCodex(c, { type: "event_msg", payload: { type: "task_complete" } }, ++sequence, cwd);
  assert.equal(c.finish().verification.skip, true);
  c.truncated = true;
  assert.equal(c.finish().verification.skip, null);
  assert.equal(c.finish().flags, null);
});

test("verification distinguishes no edits, missing outcomes, failed checks and final edits", () => {
  const c = collector(); c.observeTime(Date.parse(time(0)));
  claudeCall(c, "Read", {});
  claudeCall(c, "Edit", { file_path: "sample.ts" });
  claudeCall(c, "Bash", { command: "npm test" }, {}, true, "Exit code 1");
  assert.equal(c.finish().verification.skip, false);
  assert.equal(c.finish().verification.failed, 1);
  assert.equal(c.finish().verification.stepsToFirstEdit, 1);
  assert.ok((c.finish().verification.msToFirstEdit ?? 0) > 0);
  assert.equal(c.finish().verification.share, null, "small denominators are suppressed");
  claudeCall(c, "Edit", { file_path: "sample.ts" });
  assert.equal(c.finish().verification.skip, true);
  c.add({ id: "unfinished-test", name: "Bash", args: { command: "npm test" }, cwd, started: null });
  assert.equal(c.finish().verification.skip, null);
  assert.equal(collector().finish().verification.skip, null);
  const denied = collector(); claudeCall(denied, "Edit", {}, { toolDenialKind: "user" }, true);
  assert.equal(denied.finish().verification.editCalls, 0);
  assert.equal(denied.finish().verification.stepsToFirstEdit, null);
});

test("latency distributions merge observation counts instead of averaging percentiles", () => {
  const fast = latencyFrom(Array(100).fill(10)), slow = latencyFrom([10_000]);
  const merged = mergeLatency([fast, slow]);
  assert.equal(merged.samples, 101);
  assert.ok(merged.p95Ms! < 12);
  assert.ok(slow.p95Ms! >= 10_000 && slow.p95Ms! <= 11_001);
  assert.deepEqual(latencyFrom([NaN, Infinity, -1, 604_800_001]), { samples: 0, buckets: [], p50Ms: null, p95Ms: null });
  assert.equal(latencyFrom([0]).p50Ms, 0);
});

test("hooks, connection failures, permission mixes and API errors use enum-only projections", () => {
  const c = collector();
  const hook = { uuid: "hook-summary", type: "system", subtype: "stop_hook_summary", hookCount: 2, hookInfos: [{ durationMs: 100, command: sentinel }, { durationMs: 200 }], hookErrors: [sentinel], preventedContinuation: true };
  observeClaude(c, hook, 1, cwd); observeClaude(c, hook, 2, cwd);
  observeClaude(c, { uuid: "attachment", type: "attachment", attachment: { failedMcpServers: ["sample", { name: "second", error: sentinel }] } }, 3, cwd);
  observeClaude(c, { uuid: "permission", type: "user", permissionMode: "plan" }, 4, cwd);
  observeClaude(c, { uuid: "unknown-permission", type: "user", permissionMode: sentinel }, 5, cwd);
  for (const status of [429, 500]) observeClaude(c, { uuid: `api-${status}`, type: "assistant", isApiErrorMessage: true, apiErrorStatus: status, message: { content: sentinel } }, 6, cwd);
  observeCodex(c, { type: "turn_context", payload: { approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } } }, 7, cwd);
  observeCodex(c, { type: "turn_context", payload: { approval_policy: sentinel, sandbox_policy: { type: sentinel } } }, 8, cwd);
  const result = c.finish();
  assert.equal(result.hooks.runs, 2); assert.equal(result.hooks.blocks, 1); assert.equal(result.hooks.latency.samples, 2);
  assert.equal(result.mcp.length, 2); assert.equal(result.mcp[0]?.calls, 0); assert.equal(result.mcp[0]?.connectionFailures, 1);
  assert.deepEqual(result.permissions.modes, { plan: 1, unknown: 1 });
  assert.deepEqual(result.permissions.approvalPolicies, { "on-request": 1, unknown: 1 });
  assert.deepEqual(result.apiErrors, { api_rate_limit: 1, api_server_error: 1 });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
});

test("secret creation is persistent, 0600 and atomic across concurrent scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "reliability-key-"));
  try {
    const directory = join(root, "data");
    const keys = await Promise.all(Array.from({ length: 8 }, () => loadReliabilitySecret(directory)));
    assert.ok(keys.every((k) => k?.length === 32 && k.equals(keys[0]!)));
    assert.equal((await lstat(join(directory, "reliability-hmac.key"))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["reliability-hmac.key"]);
    await chmod(join(directory, "reliability-hmac.key"), 0o644);
    assert.equal(await loadReliabilitySecret(directory), null);
    assert.equal((await readFile(join(directory, "reliability-hmac.key"))).length, 32, "unsafe keys are never overwritten");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid or symlinked secrets fail closed, with no unkeyed fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "reliability-key-invalid-"));
  try {
    const path = join(root, "reliability-hmac.key"), target = join(root, "target");
    await writeFile(target, Buffer.alloc(32), { mode: 0o600 }); await symlink(target, path);
    assert.equal(await loadReliabilitySecret(root), null);
    await rm(path); await writeFile(path, "invalid", { mode: 0o600 });
    assert.equal(await loadReliabilitySecret(root), null);
    const c = new ReliabilityCollector({ contentRules: true, secret: null });
    claudeCall(c, "Edit", { file_path: sentinel });
    assert.equal(c.finish().flags, null); assert.equal(c.finish().hashing, "unavailable");
    assert.equal(c.finish().coverage.argumentCalls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reliability settings share CLI/env precedence and explicit opt-out", () => {
  assert.equal(analyzeOptionsFrom([], {}).reliabilityContentRules, false);
  assert.equal(analyzeOptionsFrom([], { SESSION_ANALYTICS_RELIABILITY_CONTENT_RULES: "1" }).reliabilityContentRules, true);
  assert.equal(analyzeOptionsFrom([], { SESSION_ANALYTICS_RELIABILITY_CONTENT_RULES: "true" }).reliabilityContentRules, false);
  assert.equal(analyzeOptionsFrom(["--no-reliability-content-rules"], { SESSION_ANALYTICS_RELIABILITY_CONTENT_RULES: "1" }).reliabilityContentRules, false);
  assert.equal(analyzeOptionsFrom(["--reliability-content-rules", "--data-dir", "/synthetic/cli"], { SESSION_ANALYTICS_DATA_DIR: "/synthetic/env" }).dataDir, "/synthetic/cli");
});

test("end-to-end worker, snapshot and report keep content and private hashes inside the parser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reliability-e2e-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    const id = "33333333-3333-4333-8333-333333333333";
    const path = join(fixture.claudeRoot, `${id}.jsonl`);
    const records: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      records.push({ type: "assistant", uuid: `a${i}`, sessionId: id, cwd: fixture.repositoryRoot, timestamp: time(i * 2),
        message: { id: `message-${i}`, model: "claude-opus-5", content: [{ type: "text", text: sentinel }, { type: "tool_use", id: `tool-${i}`, name: "Edit", input: { file_path: `${fixture.repositoryRoot}/${sentinel}`, old_string: sentinel, new_string: sentinel } }] } });
      records.push({ type: "user", uuid: `r${i}`, sessionId: id, cwd: fixture.repositoryRoot, timestamp: time(i * 2 + 1), toolUseResult: { durationMs: 40, stdout: sentinel, stderr: sentinel },
        message: { content: [{ type: "tool_result", tool_use_id: `tool-${i}`, is_error: true, content: `String to replace not found ${sentinel}` }] } });
    }
    await writeFile(path, records.map((r) => JSON.stringify(r)).join("\n"));
    const options = { ...fixture, reliabilityContentRules: true, dataDir: join(directory, "derived") };
    const snapshot = await analyzeMachineSessionsIsolated(options);
    const relevant = snapshot.sessions.find((s) => s.reliability?.flags?.failed_edit_cascade);
    assert.ok(relevant); assert.equal(relevant.reliability?.flags?.failed_edit_cascade, 1);
    assert.equal(relevant.reliability?.tools[0]?.errors.edit_anchor_mismatch, 4);
    assert.ok(snapshot.sessions.filter((s) => s.provider === "cursor").every((s) => !s.reliability));
    const report = reliabilityReport(snapshot.sessions);
    for (const output of [JSON.stringify(snapshot), report]) {
      assert.doesNotMatch(output, new RegExp(`${sentinel}|${id}|tool-0|message-0`));
      assert.ok(!output.includes(directory));
      assert.ok(!output.includes((await readFile(join(options.dataDir, "reliability-hmac.key"))).toString("hex")));
    }
    assert.match(report, /Reliability/); assert.match(report, /By agent/); assert.match(report, /By repository/); assert.match(report, /not verdicts/);
    const disabledDir = join(directory, "disabled");
    const disabled = await analyzeMachineSessions({ ...fixture, dataDir: disabledDir });
    assert.ok(disabled.sessions.filter((s) => s.reliability).every((s) => s.reliability?.flags === null));
    await assert.rejects(lstat(disabledDir), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("malformed and size-bounded evidence never claims complete behavior or verification", () => {
  const c = collector(false);
  for (let i = 0; i <= 50_000; i++) c.add({ id: `call-${i}`, name: "Read", cwd, started: null });
  const result = c.finish();
  assert.equal(result.coverage.truncated, true);
  assert.equal(summarize(result).totals.calls, 50_000);
  assert.equal(result.flags, null); assert.equal(result.verification.skip, null);
});
