import { errorFromText, nonnegative, record, text, type RecordValue } from "./reliability-rules.ts";
import type { ErrorClass, ToolClass, ToolOutcome } from "./reliability-types.ts";

/** Bounded, content-free evidence. Safe to retain before a matching call arrives. */
export interface CallResult {
  outcome: ToolOutcome;
  error: ErrorClass | null;
  durationMs: number | null;
  shell?: { code: number; durationMs: number | null };
  rule?: ErrorClass | null;
  editRule?: ErrorClass | null;
}
export const outcomeRank: Record<ToolOutcome, number> = { unknown: 0, success: 1, error: 2, interrupted: 3, denied: 4, timeout: 5 };

function duration(value: unknown): number | null {
  if (typeof value === "number") return nonnegative(value);
  const parts = record(value), seconds = nonnegative(parts["secs"]), nanos = nonnegative(parts["nanos"]);
  return seconds !== null ? seconds * 1000 + (nanos ?? 0) / 1_000_000 : null;
}

/** Consume only the recognized metadata prefix. Never search the stdout body. */
function receiptHeader(content: string): { code: number | null; durationMs: number | null; running: boolean } {
  let code: number | null = null, durationMs: number | null = null, running = false;
  for (const line of content.split("\n")) {
    if (/^(?:Final output|Output):\s*$/.test(line)) break;
    if (!line.trim() || /^(?:Chunk ID: [\w-]+|Original token count: \d+|Total output lines: \d+)\s*$/.test(line)) continue;
    if (/^(?:Process running with session ID \S+|Script running with cell ID .+)\s*$/.test(line)) { running = true; continue; }
    const exit = /^(?:Exit code|Process exited with code) (-?\d+)\s*$/.exec(line);
    if (exit) {
      const next = Number(exit[1]);
      if (!Number.isSafeInteger(next) || (code !== null && code !== next)) return { code: null, durationMs: null, running: true };
      code = next; continue;
    }
    const wall = /^Wall time: (\d+(?:\.\d+)?) seconds\s*$/.exec(line);
    if (wall) { durationMs = nonnegative(Number(wall[1]) * 1000); continue; }
    break;
  }
  return { code: running ? null : code, durationMs: running ? null : durationMs, running };
}

export function resultEvidence(fields: RecordValue, content: string, contentRules: boolean, allowReceipt = true): CallResult {
  const status = text(fields["status"])?.toLowerCase();
  const denial = text(fields["toolDenialKind"]);
  const code = typeof fields["exit_code"] === "number" && Number.isSafeInteger(fields["exit_code"]) ? fields["exit_code"] as number : null;
  const header = contentRules && allowReceipt ? receiptHeader(content) : null;
  const running = fields["isAsync"] === true || Boolean(fields["backgroundTaskId"]) || ["running", "in_progress", "pending", "queued"].includes(status ?? "") || header?.running;
  let outcome: ToolOutcome = "unknown", error: ErrorClass | null = null;
  if ((nonnegative(fields["timedOutAfterMs"]) ?? 0) > 0 || status === "timeout" || status === "timed_out") { outcome = "timeout"; error = "timeout"; }
  else if (denial || status === "denied" || status === "declined") {
    outcome = "denied";
    error = denial === "user" || denial === "user_denied" || status === "declined" ? "permission_denied_user"
      : denial === "hook" || denial === "hook_blocked" ? "hook_blocked"
      : ["policy", "sandbox", "rules", "rule", "classifier"].includes(denial ?? "") ? "permission_denied_policy" : "unknown";
  } else if (fields["interrupted"] === true || ["interrupted", "cancelled", "canceled"].includes(status ?? "")) { outcome = "interrupted"; error = "interrupted"; }
  else if ((code !== null && code !== 0) || fields["is_error"] === true || fields["isError"] === true || fields["success"] === false || status === "failed" || status === "error") {
    outcome = "error"; error = code === 127 ? "command_not_found" : code !== null && code !== 0 ? "nonzero_exit" : "unknown";
  } else if (!running && (code === 0 || fields["is_error"] === false || fields["isError"] === false || fields["success"] === true || status === "completed" || status === "success")) outcome = "success";
  const durationMs = running && outcome === "unknown" ? null : nonnegative(fields["duration_ms"]) ?? nonnegative(fields["durationMs"]) ?? nonnegative(fields["totalDurationMs"]) ??
    (nonnegative(fields["durationSeconds"]) !== null ? Number(fields["durationSeconds"]) * 1000 : null) ?? duration(fields["duration"]);
  const evidence: CallResult = { outcome, error, durationMs };
  // Explicit successful structured results are not reinterpreted from their output text.
  if (!running && header?.code !== null && header?.code !== undefined && fields["is_error"] !== false && fields["isError"] !== false && fields["success"] !== true) {
    evidence.shell = { code: header.code, durationMs: header.durationMs };
  }
  if (contentRules && (outcome === "error" || (evidence.shell && evidence.shell.code !== 0))) {
    evidence.rule = errorFromText(content, "other");
    evidence.editRule = errorFromText(content, "edit");
  }
  return evidence;
}

export function resolveResult(evidence: CallResult, toolClass: ToolClass, shell: boolean): CallResult {
  let { outcome, error, durationMs } = evidence;
  if (shell && evidence.shell) {
    const code = evidence.shell.code, inferred = code === 0 ? "success" : "error";
    if (outcomeRank[inferred] >= outcomeRank[outcome]) {
      outcome = inferred; error = code === 0 ? null : code === 127 ? "command_not_found" : "nonzero_exit";
    }
    durationMs ??= evidence.shell.durationMs;
  }
  if (outcome === "error") {
    if (toolClass === "test_build" && error !== "command_not_found") error = "test_failed";
    else if (toolClass === "mcp" && (!error || error === "unknown")) error = "mcp_error";
    error = (toolClass === "edit" || toolClass === "write" ? evidence.editRule : evidence.rule) ?? error;
    if (error === "timeout") outcome = "timeout";
    else if (error === "interrupted") outcome = "interrupted";
    else if (error === "permission_denied_policy" || error === "hook_blocked") outcome = "denied";
  }
  return { outcome, error, durationMs };
}

/** Duplicate receipts cannot shift completion order; stronger terminal evidence can. */
export function mergeResult(target: CallResult, source: CallResult): boolean {
  let terminalChanged = false;
  if (outcomeRank[source.outcome] > outcomeRank[target.outcome]) {
    target.outcome = source.outcome; target.error = source.error; terminalChanged = source.outcome !== "unknown";
  } else if (source.outcome === target.outcome && (!target.error || target.error === "unknown")) target.error = source.error;
  if (source.shell && (!target.shell || (target.shell.code === 0 && source.shell.code !== 0))) { target.shell = { ...source.shell }; terminalChanged = true; }
  if (source.durationMs !== null) target.durationMs = source.durationMs;
  if (source.rule) target.rule = source.rule;
  if (source.editRule) target.editRule = source.editRule;
  return terminalChanged;
}
