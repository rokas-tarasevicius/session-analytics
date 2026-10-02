import { emptyLatency, mergeLatency, summarizeReliability, latencyFrom } from "../public/reliability-data.js";
import { ReliabilityCollector, type CallResult, type ReliabilityContext } from "./reliability.ts";
import { argumentsValue, errorFromText, name, nonnegative, record, text, timestamp, type RecordValue } from "./reliability-rules.ts";
import type { ErrorClass, SessionReliability, ToolClass, ToolOutcome } from "./reliability-types.ts";

const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
function duration(value: unknown): number | null {
  if (typeof value === "number") return nonnegative(value);
  const parts = record(value);
  const seconds = nonnegative(parts["secs"]), nanos = nonnegative(parts["nanos"]);
  return seconds !== null ? seconds * 1000 + (nanos ?? 0) / 1_000_000 : null;
}
function resultText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 65_536);
  return array(value).map((block) => text(record(block)["text"]) ?? "").join("\n").slice(0, 65_536);
}
function resultFrom(fields: RecordValue, content: string, toolClass: ToolClass, contentRules: boolean, shellReceipt = false): CallResult {
  const status = text(fields["status"])?.toLowerCase();
  const denial = text(fields["toolDenialKind"]);
  const exit = typeof fields["exit_code"] === "number" && Number.isInteger(fields["exit_code"]) ? fields["exit_code"] as number : null;
  const parsedExit = contentRules && shellReceipt && fields["is_error"] !== false && fields["isError"] !== false && fields["success"] !== true
    ? /^(?:Exit code|Process exited with code) (-?\d+)\b/m.exec(content)?.[1] : undefined;
  const code = exit ?? (parsedExit === undefined ? null : Number(parsedExit));
  const timeout = (nonnegative(fields["timedOutAfterMs"]) ?? 0) > 0 || status === "timeout" || status === "timed_out";
  let outcome: ToolOutcome = "unknown", error: ErrorClass | null = null;
  if (timeout) { outcome = "timeout"; error = "timeout"; }
  else if (denial || status === "denied" || status === "declined") {
    outcome = "denied";
    error = denial === "user" || denial === "user_denied" || status === "declined" ? "permission_denied_user"
      : denial === "hook" || denial === "hook_blocked" ? "hook_blocked"
      : ["policy", "sandbox", "rules", "rule", "classifier"].includes(denial ?? "") ? "permission_denied_policy" : "unknown";
  } else if (fields["interrupted"] === true || status === "interrupted" || status === "cancelled" || status === "canceled") {
    outcome = "interrupted"; error = "interrupted";
  } else if ((code !== null && code !== 0) || fields["is_error"] === true || fields["isError"] === true || fields["success"] === false || status === "failed" || status === "error") {
    outcome = "error";
    error = code === 127 ? "command_not_found" : toolClass === "test_build" ? "test_failed" : code !== null && code !== 0 ? "nonzero_exit" : toolClass === "mcp" ? "mcp_error" : "unknown";
    if (contentRules) error = errorFromText(content, toolClass) ?? error;
    if (error === "timeout") outcome = "timeout";
    else if (error === "interrupted") outcome = "interrupted";
    else if (error === "permission_denied_policy" || error === "hook_blocked") outcome = "denied";
  } else if (code === 0 || fields["is_error"] === false || fields["isError"] === false || fields["success"] === true || status === "completed" || status === "success") outcome = "success";
  const durationMs = nonnegative(fields["duration_ms"]) ?? nonnegative(fields["durationMs"]) ?? nonnegative(fields["totalDurationMs"]) ??
    (nonnegative(fields["durationSeconds"]) !== null ? Number(fields["durationSeconds"]) * 1000 : null) ?? duration(fields["duration"]);
  return { outcome, error, durationMs };
}

function mix(target: Record<string, number>, value: unknown, allowed: string[]): void {
  if (value === undefined || value === null) return;
  const key = typeof value === "string" && allowed.includes(value) ? value : "unknown";
  target[key] = (target[key] ?? 0) + 1;
}

/** Called alongside the existing streaming parser; provider payloads never leave this module. */
export function observeClaude(collector: ReliabilityCollector, event: RecordValue, line: number, cwd: string): void {
  cwd = text(event["cwd"]) ?? cwd;
  const time = timestamp(event["timestamp"]);
  collector.observeTime(time);
  const id = text(event["uuid"]) ?? `line:${line}`;
  const message = record(event["message"]);
  if (event["type"] === "assistant") {
    for (const [index, raw] of array(message["content"]).entries()) {
      const block = record(raw);
      if (block["type"] !== "tool_use") continue;
      collector.add({ id: text(block["id"]) ?? `${id}:${index}`, name: name(block["name"]), args: collector.context.contentRules ? block["input"] : undefined, cwd, started: time });
    }
  }
  if (!collector.once(id)) return;
  mix(collector.permissions.modes, event["permissionMode"], ["default", "auto", "bypassPermissions", "plan", "acceptEdits", "dontAsk"]);
  if (event["type"] === "permission-mode") mix(collector.permissions.modes, event["mode"], ["default", "auto", "bypassPermissions", "plan", "acceptEdits", "dontAsk"]);
  if (event["type"] === "user") {
    const results = array(message["content"]).map(record).filter((b) => b["type"] === "tool_result");
    for (const block of results) {
      const callId = text(block["tool_use_id"]);
      if (!callId) continue;
      // A top-level toolUseResult belongs to the one result in that record, never to a whole batch.
      const structured = results.length === 1 ? record(event["toolUseResult"]) : {};
      const interpretation = structured["returnCodeInterpretation"];
      const interpretedStatus = typeof interpretation === "string" ? interpretation : record(interpretation)["type"];
      const fields: RecordValue = {
        is_error: block["is_error"], status: structured["status"] ?? interpretedStatus, success: structured["success"],
        interrupted: structured["interrupted"], timedOutAfterMs: structured["timedOutAfterMs"],
        toolDenialKind: block["toolDenialKind"] ?? (results.length === 1 ? event["toolDenialKind"] : undefined),
        durationMs: structured["durationMs"], totalDurationMs: structured["totalDurationMs"], durationSeconds: structured["durationSeconds"],
        exit_code: structured["exitCode"] ?? structured["exit_code"] ?? record(interpretation)["exitCode"],
      };
      // A Claude tool_result without is_error is a successful result by the provider schema,
      // except async launches, which acknowledge a start rather than a completed execution.
      if (fields["is_error"] === undefined && structured["isAsync"] !== true && !structured["backgroundTaskId"]) fields["is_error"] = false;
      const content = collector.context.contentRules ? resultText(block["content"]) : "";
      collector.result(callId, resultFrom(fields, content, collector.toolClass(callId), collector.context.contentRules, collector.isShellCall(callId)));
    }
  }
  if (event["subtype"] === "stop_hook_summary") {
    const infos = array(event["hookInfos"]);
    collector.hooks.runs += Math.max(0, Math.floor(nonnegative(event["hookCount"]) ?? infos.length));
    collector.hooks.blocks += Number(event["preventedContinuation"] === true);
    collector.hooks.latency = mergeLatency([collector.hooks.latency, latencyFrom(infos.flatMap((info) => {
      const ms = nonnegative(record(info)["durationMs"]); return ms === null ? [] : [ms];
    }))]);
  }
  const attachment = record(event["attachment"]);
  for (const failed of array(attachment["failedMcpServers"])) collector.connectionFailure(typeof failed === "string" ? failed : record(failed)["name"] ?? record(failed)["serverName"]);
  if ((event["isApiErrorMessage"] === true || event["subtype"] === "api_error") && collector.once(`api:${text(message["id"]) ?? id}`)) {
    const status = event["apiErrorStatus"] ?? event["statusCode"];
    const kind = status === 429 || event["error"] === "rate_limit" ? "api_rate_limit" :
      (typeof status === "number" && status >= 500 && status <= 599) || event["error"] === "server_error" ? "api_server_error" : "unknown";
    collector.apiErrors[kind] = (collector.apiErrors[kind] ?? 0) + 1;
  }
}

export function observeCodex(collector: ReliabilityCollector, event: RecordValue, line: number, cwd: string): void {
  const time = timestamp(event["timestamp"]);
  collector.observeTime(time);
  const payload = record(event["payload"]);
  const type = payload["type"];
  if (event["type"] === "turn_context" && collector.once(`context:${text(payload["turn_id"]) ?? line}`)) {
    mix(collector.permissions.approvalPolicies, payload["approval_policy"], ["untrusted", "on-failure", "on-request", "never"]);
    mix(collector.permissions.sandboxes, record(payload["sandbox_policy"])["type"], ["read-only", "workspace-write", "danger-full-access", "external-sandbox"]);
  }
  if (event["type"] === "event_msg" && type === "task_started") collector.inProgress = true;
  if (event["type"] === "event_msg" && (type === "task_complete" || type === "turn_aborted")) collector.inProgress = false;
  if (event["type"] === "response_item" && (type === "function_call" || type === "custom_tool_call")) {
    collector.add({ id: text(payload["call_id"]) ?? text(payload["id"]) ?? `line:${line}`, name: name(payload["name"]), args: collector.context.contentRules ? argumentsValue(payload["arguments"] ?? payload["input"]) : undefined, cwd, started: time });
  }
  if (event["type"] === "response_item" && (type === "function_call_output" || type === "custom_tool_call_output")) {
    const id = text(payload["call_id"]);
    if (!id) return;
    const output = payload["output"];
    // JSON receipt wrappers expose structured exit_code and timing without enabling text rules.
    const structured = record(argumentsValue(output));
    const fields: RecordValue = {
      exit_code: structured["exit_code"], status: structured["status"], isError: structured["isError"],
      duration_ms: structured["duration_ms"], duration: structured["duration"],
    };
    const content = collector.context.contentRules ? resultText(output) : "";
    const result = resultFrom(fields, content, collector.toolClass(id), collector.context.contentRules, collector.isShellCall(id));
    if (collector.context.contentRules) {
      // Only receipt headers at line starts; do not treat arbitrary command stdout as a result.
      const wall = /^Wall time: (\d+(?:\.\d+)?) seconds\s*$/m.exec(content)?.[1];
      if (wall !== undefined && result.outcome !== "unknown") result.durationMs ??= Number(wall) * 1000;
    }
    collector.result(id, result);
  }
  if (event["type"] === "event_msg" && type === "item_completed") {
    const item = record(payload["item"]);
    const kind = item["type"];
    if (kind !== "CommandExecution" && kind !== "McpToolCall" && kind !== "FileChange") return;
    const id = text(item["call_id"]) ?? text(item["id"]) ?? `item:${line}`;
    const server = kind === "McpToolCall" ? name(item["server"]) : null;
    collector.add({ id, name: kind === "CommandExecution" ? "exec_command" : kind === "FileChange" ? "apply_patch" : name(item["tool"]),
      args: collector.context.contentRules ? kind === "CommandExecution" ? { command: item["command"] } : kind === "FileChange" ? { changes: item["changes"] } : item["arguments"] : undefined,
      parsed: item["parsed_cmd"], cwd: text(item["cwd"]) ?? cwd, started: time, server });
    const fields: RecordValue = {
      status: item["status"], exit_code: item["exit_code"], duration: item["duration"], duration_ms: item["duration_ms"],
      isError: record(item["result"])["isError"] ?? (item["error"] ? true : undefined),
    };
    const content = collector.context.contentRules ? resultText(item["aggregated_output"] ?? item["stderr"]) : "";
    collector.result(id, resultFrom(fields, content, collector.toolClass(id), collector.context.contentRules, kind === "CommandExecution"));
  }
  if (event["type"] === "event_msg" && type === "task_complete" && collector.once(`api:${text(payload["turn_id"]) ?? line}`)) {
    const kind = record(payload["error"])["codex_error_info"];
    if (kind === "usage_limit_exceeded" || kind === "rate_limit_exceeded") collector.apiErrors.api_rate_limit = (collector.apiErrors.api_rate_limit ?? 0) + 1;
    else if (kind === "server_error") collector.apiErrors.api_server_error = (collector.apiErrors.api_server_error ?? 0) + 1;
  }
}

/** Keep independent Claude main/subagent sequences separate; aggregate only finished projections. */
export function combineReliability(streams: SessionReliability[], working: boolean): SessionReliability {
  const main = streams[0];
  if (!main) throw new Error("Reliability requires an evidence stream.");
  const summary = summarizeReliability(streams.map((reliability) => ({ reliability })));
  const editing = streams.filter((s) => s.verification.editCalls > 0);
  return {
    version: 1, contentRules: main.contentRules, hashing: main.hashing,
    tools: summary.tools, mcp: summary.mcp,
    coverage: {
      argumentCalls: streams.reduce((n, s) => n + s.coverage.argumentCalls, 0),
      fileCalls: streams.reduce((n, s) => n + s.coverage.fileCalls, 0),
      unmatchedResults: streams.reduce((n, s) => n + s.coverage.unmatchedResults, 0),
      truncated: streams.some((s) => s.coverage.truncated),
    },
    flags: streams.every((s) => s.flags !== null) ? summary.flags : null,
    verification: {
      checks: summary.verification.checks, passed: summary.verification.passed, failed: summary.verification.failed,
      editCalls: summary.verification.editCalls, share: summary.verification.share,
      skip: working || !editing.length || editing.some((s) => s.verification.skip === null) ? null : editing.some((s) => s.verification.skip),
      stepsToFirstEdit: main.verification.stepsToFirstEdit, msToFirstEdit: main.verification.msToFirstEdit,
    },
    hooks: { runs: summary.hooks.runs, blocks: summary.hooks.blocks, latency: summary.hooks.latency ?? emptyLatency() },
    permissions: summary.permissions, apiErrors: summary.apiErrors,
  };
}
