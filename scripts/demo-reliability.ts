/** Deliberately synthetic, reproducible reliability episodes for screenshots and demos. */
export function claudeReliabilityDemo(start: number, cwd: string, sessionId: string): unknown[] {
  const events: unknown[] = [];
  let tick = 0;
  const push = (value: Record<string, unknown>): void => { events.push({ ...value, cwd, sessionId, timestamp: new Date(start + (++tick) * 1000).toISOString(), uuid: `demo-reliability-event-${tick}` }); };
  const call = (name: string, input: unknown, result: Record<string, unknown> = {}, isError = false, content = "Synthetic result"): void => {
    const id = `demo-reliability-tool-${tick}`;
    push({ type: "assistant", message: { id: `demo-reliability-message-${tick}`, content: [{ type: "tool_use", id, name, input }] } });
    const { toolDenialKind, ...toolUseResult } = result;
    push({ type: "user", permissionMode: "default", ...(toolDenialKind ? { toolDenialKind } : {}), toolUseResult,
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] } });
  };
  const file = `${cwd}/src/demo-widget.ts`;
  for (let i = 0; i < 10; i += 1) call("Read", { file_path: file }, { durationMs: 40 + i });
  for (let i = 0; i < 3; i += 1) call("Edit", { file_path: file, old_string: "old sample", new_string: "new sample" }, { durationMs: 120 }, true, "String to replace not found in file");
  for (let i = 0; i < 3; i += 1) call("Edit", { file_path: file, old_string: `sample ${i}`, new_string: `sample ${i + 1}` }, { durationMs: 80 });
  call("Bash", { command: "npm test" }, { durationMs: 3200 }, true, "Exit code 1\nSynthetic test failure");
  call("Bash", { command: "npm test" }, { durationMs: 2900 }, false, "Exit code 0");
  call("Bash", { command: "npm run build" }, { durationMs: 6000, timedOutAfterMs: 6000 }, true);
  call("Bash", { command: "git status" }, { interrupted: true }, true);
  call("Write", { file_path: file, content: "Synthetic file" }, { toolDenialKind: "user" }, true);
  call("mcp__demo_docs__search", { query: "demo" }, { durationMs: 900 });
  call("mcp__demo_docs__search", { query: "demo next" }, { durationMs: 2100 }, true);
  push({ type: "system", subtype: "stop_hook_summary", hookCount: 2, hookInfos: [{ durationMs: 50 }, { durationMs: 150 }], preventedContinuation: false });
  push({ type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ durationMs: 400 }], preventedContinuation: true });
  push({ type: "attachment", attachment: { type: "deferred_tools_delta", failedMcpServers: ["demo_index"] } });
  push({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, error: "rate_limit", message: { id: "demo-api-error", content: [] } });
  call("Edit", { file_path: file, old_string: "demo", new_string: "demo finished" }, { durationMs: 90 });
  return events;
}

export function codexReliabilityDemo(start: number): unknown[] {
  const events: unknown[] = [];
  let tick = 0;
  const push = (type: string, payload: unknown): void => { events.push({ type, timestamp: new Date(start + (++tick) * 1000).toISOString(), payload }); };
  push("turn_context", { approval_policy: "on-request", sandbox_policy: { type: "workspace-write", network_access: false } });
  const command = (command: string, exit_code: number, secs: number, status = "completed"): void => {
    push("event_msg", { type: "item_completed", item: { type: "CommandExecution", id: `demo-command-${tick}`, command, status, exit_code, duration: { secs, nanos: 500_000_000 }, parsed_cmd: [{ type: "unknown" }] } });
  };
  command("git diff --stat", 0, 1);
  command("npm test", 1, 4);
  command("npm test", 1, 4);
  command("npm test", 1, 4);
  push("event_msg", { type: "item_completed", item: { type: "FileChange", id: "demo-file-change", status: "completed", changes: { "src/demo-widget.ts": { type: "update", unified_diff: "Synthetic diff" } } } });
  command("npm test", 0, 3);
  for (let i = 0; i < 6; i += 1) push("event_msg", { type: "item_completed", item: { type: "McpToolCall", id: `demo-mcp-${i}`, server: "demo_docs", tool: "search", status: i === 0 ? "failed" : "completed", result: { isError: i === 0 }, duration: { secs: 1, nanos: i * 100_000_000 } } });
  push("event_msg", { type: "task_complete" });
  return events;
}
