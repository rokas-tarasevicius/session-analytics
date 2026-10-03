import { emptyFlags, emptyLatency, emptyStats, guardedShare, latencyFrom, mergeLatency } from "../public/reliability-data.js";
import { classifyTool, fileFingerprints, fingerprint, hashBudget, name, toolIdentity } from "./reliability-rules.ts";
import { mergeResult, resolveResult, type CallResult } from "./reliability-results.ts";
import type { McpReliability, SessionReliability, ToolClass, ToolReliability } from "./reliability-types.ts";
export type { CallResult } from "./reliability-results.ts";

export interface ReliabilityContext { contentRules: boolean; secret: Buffer | null }
interface Call {
  name: string;
  toolClass: ToolClass;
  server: string | null;
  argHash: string | null;
  files: string[];
  started: number | null;
  order: number;
  startSequence: number | null;
  completedSequence: number | null;
  shellReceipt: boolean;
  evidence: CallResult;
}
interface ResolvedCall extends Call, CallResult {}
interface PendingResult { evidence: CallResult; completedSequence: number | null }
export interface CallInput {
  id: string; name: string; args?: unknown; parsed?: unknown; cwd: string;
  started: number | null; server?: string | null; completionOnly?: boolean;
}
const failed = (call: ResolvedCall): boolean => call.outcome === "error" || call.outcome === "timeout";
const edited = (call: Call): boolean => call.toolClass === "edit" || call.toolClass === "write";
const MAX_CALLS = 50_000;

/** One execution stream. Retains bounded enums, numbers and HMACs, never raw arguments/results. */
export class ReliabilityCollector {
  context: ReliabilityContext;
  calls = new Map<string, Call>();
  pending = new Map<string, PendingResult>();
  seenEvents = new Set<string>();
  connectionFailures = new Map<string, number>();
  hooks: SessionReliability["hooks"] = { runs: 0, blocks: 0, latency: emptyLatency() };
  permissions: SessionReliability["permissions"] = { denials: 0, modes: {}, approvalPolicies: {}, sandboxes: {} };
  apiErrors: SessionReliability["apiErrors"] = {};
  firstTimestamp: number | null = null;
  truncated = false;
  inProgress = false;
  private sequence = 0;
  private hashBudget = hashBudget();

  constructor(context: ReliabilityContext) { this.context = context; }
  observeTime(time: number | null): void {
    if (time !== null && (this.firstTimestamp === null || time < this.firstTimestamp)) this.firstTimestamp = time;
  }
  once(id: string): boolean {
    if (id.length > 512) { this.truncated = true; return false; }
    if (this.seenEvents.has(id)) return false;
    if (this.seenEvents.size >= MAX_CALLS * 4) { this.truncated = true; return false; }
    this.seenEvents.add(id); return true;
  }
  add(input: CallInput): void {
    this.observeTime(input.started);
    if (input.id.length > 512) { this.truncated = true; return; }
    const { tool, server } = toolIdentity(input.name, input.server);
    const toolClass = server ? "mcp" : classifyTool(tool, input.args, input.parsed, this.context.contentRules);
    const key = this.context.contentRules && !this.hashBudget.exhausted ? this.context.secret : null;
    const existing = this.calls.get(input.id);
    if (existing) {
      // Typed completion items often enrich the original response_item with parsed_cmd.
      if ((existing.toolClass === "shell" || existing.toolClass === "other") && toolClass !== "shell" && toolClass !== "other") existing.toolClass = toolClass;
      if (server) { existing.server = server; existing.name = tool; existing.toolClass = "mcp"; }
      existing.argHash ??= fingerprint(key, "arguments", input.args, this.hashBudget);
      if (!existing.files.length) existing.files = fileFingerprints(key, input.args, input.cwd, input.parsed, this.hashBudget);
      if (this.hashBudget.exhausted) this.truncated = true;
      return;
    }
    if (this.calls.size + this.pending.size >= MAX_CALLS && !this.pending.has(input.id)) { this.truncated = true; return; }
    const call: Call = {
      name: tool, toolClass, server,
      argHash: fingerprint(key, "arguments", input.args, this.hashBudget),
      files: fileFingerprints(key, input.args, input.cwd, input.parsed, this.hashBudget),
      started: input.started, order: this.calls.size,
      startSequence: input.completionOnly || this.pending.has(input.id) ? null : ++this.sequence,
      completedSequence: null, shellReceipt: classifyTool(tool, undefined, undefined, false) === "shell",
      evidence: { outcome: "unknown", error: null, durationMs: null },
    };
    if (this.hashBudget.exhausted) this.truncated = true;
    this.calls.set(input.id, call);
    const pending = this.pending.get(input.id);
    if (pending) { call.evidence = pending.evidence; call.completedSequence = pending.completedSequence; this.pending.delete(input.id); }
  }
  result(id: string, result: CallResult): void {
    if (id.length > 512) { this.truncated = true; return; }
    let target: Call | PendingResult | undefined = this.calls.get(id) ?? this.pending.get(id);
    if (!target) {
      if (this.calls.size + this.pending.size >= MAX_CALLS) { this.truncated = true; return; }
      target = { evidence: { outcome: "unknown", error: null, durationMs: null }, completedSequence: null };
      this.pending.set(id, target);
    }
    const sequence = ++this.sequence;
    if (mergeResult(target.evidence, result)) target.completedSequence = sequence;
  }
  connectionFailure(server: unknown): void {
    const normalized = name(server);
    if (this.connectionFailures.size >= 1000 && !this.connectionFailures.has(normalized)) { this.truncated = true; return; }
    this.connectionFailures.set(normalized, (this.connectionFailures.get(normalized) ?? 0) + 1);
  }
  finish(): SessionReliability {
    const calls: ResolvedCall[] = [...this.calls.values()].map((call) => ({ ...call, ...resolveResult(call.evidence, call.toolClass, call.shellReceipt) }));
    const tools = new Map<string, ToolReliability>();
    const mcp = new Map<string, McpReliability>();
    for (const [server, connectionFailures] of this.connectionFailures) mcp.set(server, { server, connectionFailures, ...emptyStats() });
    const count = (target: ToolReliability | McpReliability, call: ResolvedCall): void => {
      target.calls += 1; target.outcomes[call.outcome] += 1;
      if (call.error) target.errors[call.error] = (target.errors[call.error] ?? 0) + 1;
      if (call.durationMs !== null) target.latency = mergeLatency([target.latency, latencyFrom([call.durationMs])]);
    };
    for (const call of calls) {
      const key = JSON.stringify([call.name, call.toolClass]);
      const tool = tools.get(key) ?? { name: call.name, toolClass: call.toolClass, ...emptyStats() };
      count(tool, call); tools.set(key, tool);
      if (call.server) {
        const server = mcp.get(call.server) ?? { server: call.server, connectionFailures: 0, ...emptyStats() };
        count(server, call); mcp.set(call.server, server);
      }
    }
    const incomplete = this.truncated || this.pending.size > 0;
    const flags = this.context.contentRules && this.context.secret && !incomplete ? behaviorFlags(calls) : null;
    const checks = calls.filter((c) => c.toolClass === "test_build");
    // Failed/denied edit attempts cannot establish that a file changed. Unknown edits remain eligible.
    const edits = calls.filter((c) => edited(c) && (c.outcome === "success" || c.outcome === "unknown"));
    const firstEdit = edits[0];
    const opaque = calls.some((c) => c.toolClass === "other" || c.outcome === "unknown");
    const verificationAvailable = this.context.contentRules && !incomplete && !this.inProgress && !opaque;
    return {
      version: 1,
      contentRules: this.context.contentRules ? "enabled" : "disabled",
      hashing: !this.context.contentRules ? "disabled" : this.context.secret ? "enabled" : "unavailable",
      tools: [...tools.values()], mcp: [...mcp.values()],
      coverage: { argumentCalls: calls.filter((c) => c.argHash).length, fileCalls: calls.filter((c) => c.files.length).length, unmatchedResults: this.pending.size, truncated: this.truncated },
      flags,
      verification: {
        checks: checks.length, passed: checks.filter((c) => c.outcome === "success").length,
        failed: checks.filter(failed).length, editCalls: edits.length,
        share: this.context.contentRules && !incomplete ? guardedShare(checks.length, checks.length + edits.length) : null,
        skip: verificationAvailable ? verificationSkip(edits, checks) : null,
        stepsToFirstEdit: firstEdit?.order ?? null,
        msToFirstEdit: firstEdit?.started !== null && firstEdit?.started !== undefined && this.firstTimestamp !== null ? Math.max(0, firstEdit.started - this.firstTimestamp) : null,
      },
      hooks: this.hooks,
      permissions: { ...this.permissions, denials: calls.filter((c) => c.outcome === "denied").length },
      apiErrors: this.apiErrors,
    };
  }
}

function verificationSkip(edits: ResolvedCall[], checks: ResolvedCall[]): boolean | null {
  if (!edits.length || edits.some((c) => c.completedSequence === null)) return null;
  const last = edits.reduce((a, b) => a.completedSequence! > b.completedSequence! ? a : b);
  const attempted = checks.filter((c) => c.outcome === "success" || failed(c));
  if (attempted.some((c) => c.startSequence !== null && c.startSequence > last.completedSequence!)) return false;
  // A check that overlaps the last completed edit is neither a following check nor a skip.
  if (attempted.some((c) => last.startSequence === null || c.completedSequence === null || c.completedSequence > last.startSequence)) return null;
  return true;
}

function behaviorFlags(calls: ResolvedCall[]): ReturnType<typeof emptyFlags> {
  const flags = emptyFlags();
  let repeat = 0, failures = 0, editFailures = 0, reads = 0;
  let previous: string | null = null, previousFailure: string | null = null, previousEdit: string | null = null;
  let window: Array<{ files: string[]; edit: boolean; read: boolean; order: number; completed: number | null }> = [];
  const thrashing = new Set<string>(), rereading = new Set<string>();
  const checks = calls.filter((c) => c.toolClass === "test_build" && c.outcome === "success" && c.startSequence !== null && c.completedSequence !== null).sort((a, b) => a.completedSequence! - b.completedSequence!);
  let checked = 0;
  for (const call of calls) {
    const identity = call.argHash ? `${call.name}\0${call.argHash}` : null;
    repeat = identity && identity === previous ? repeat + 1 : identity ? 1 : 0;
    if (repeat === 3) flags.exact_repeat += 1;
    previous = identity;
    failures = failed(call) && identity ? identity === previousFailure ? failures + 1 : 1 : 0;
    previousFailure = failed(call) ? identity : null;
    if (failures === 3) flags.repeated_failure += 1;
    const file = call.files[0] ?? null;
    editFailures = edited(call) && failed(call) && file ? file === previousEdit ? editFailures + 1 : 1 : 0;
    previousEdit = edited(call) && failed(call) ? file : null;
    if (editFailures === 3) flags.failed_edit_cascade += 1;
    while (call.startSequence !== null && checked < checks.length && checks[checked]!.completedSequence! < call.startSequence) {
      const check = checks[checked++]!;
      // Reset only when all activity in the current window finished before the check started.
      if (window.every((entry) => entry.completed !== null && entry.completed < check.startSequence!)) { window = []; thrashing.clear(); rereading.clear(); }
    }
    // Reading a file again after it changed is expected, not re-read churn.
    if (edited(call) && call.outcome === "success") {
      for (const entry of window) if (entry.read) entry.files = entry.files.filter((path) => !call.files.includes(path));
      for (const path of call.files) rereading.delete(path);
    }
    window = window.filter((w) => call.order - w.order < 10);
    if (call.toolClass !== "test_build") window.push({ files: call.files, edit: edited(call) && call.outcome === "success", read: call.toolClass === "read", order: call.order, completed: call.completedSequence });
    for (const [active, kind] of [[thrashing, "edit"], [rereading, "read"]] as const) {
      const counts = new Map<string, number>();
      for (const entry of window) if (entry[kind]) for (const path of entry.files) counts.set(path, (counts.get(path) ?? 0) + 1);
      for (const path of active) if ((counts.get(path) ?? 0) < 3) active.delete(path);
      for (const [path, count] of counts) if (count >= 3 && !active.has(path)) {
        active.add(path); flags[kind === "edit" ? "edit_thrash" : "reread_churn"] += 1;
      }
    }
    if (edited(call) || call.toolClass === "test_build") reads = 0;
    else if (call.toolClass === "read" || call.toolClass === "search") {
      reads += 1; if (reads === 10) flags.search_loop += 1;
    }
  }
  return flags;
}
