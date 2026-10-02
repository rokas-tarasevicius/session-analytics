import { emptyFlags, emptyLatency, emptyStats, guardedShare, latencyFrom, mergeLatency } from "../public/reliability-data.js";
import { classifyTool, fileFingerprints, fingerprint, name } from "./reliability-rules.ts";
import type { ErrorClass, McpReliability, SessionReliability, ToolClass, ToolOutcome, ToolReliability } from "./reliability-types.ts";

export interface ReliabilityContext { contentRules: boolean; secret: Buffer | null }
export interface CallResult { outcome: ToolOutcome; error: ErrorClass | null; durationMs: number | null }
interface Call extends CallResult {
  name: string;
  toolClass: ToolClass;
  server: string | null;
  argHash: string | null;
  files: string[];
  started: number | null;
  order: number;
}
export interface CallInput {
  id: string; name: string; args?: unknown; parsed?: unknown; cwd: string;
  started: number | null; server?: string | null;
}
const failed = (call: Call): boolean => call.outcome === "error" || call.outcome === "timeout";
const edited = (call: Call): boolean => call.toolClass === "edit" || call.toolClass === "write";
const rank: Record<ToolOutcome, number> = { unknown: 0, success: 1, error: 2, interrupted: 3, denied: 4, timeout: 5 };
const MAX_CALLS = 50_000;

/** One execution stream. Retains bounded enums, numbers and HMACs, never raw arguments/results. */
export class ReliabilityCollector {
  context: ReliabilityContext;
  calls = new Map<string, Call>();
  pending = new Map<string, CallResult>();
  seenEvents = new Set<string>();
  connectionFailures = new Map<string, number>();
  hooks: SessionReliability["hooks"] = { runs: 0, blocks: 0, latency: emptyLatency() };
  permissions: SessionReliability["permissions"] = { denials: 0, modes: {}, approvalPolicies: {}, sandboxes: {} };
  apiErrors: SessionReliability["apiErrors"] = {};
  firstTimestamp: number | null = null;
  truncated = false;
  inProgress = false;

  constructor(context: ReliabilityContext) { this.context = context; }
  observeTime(time: number | null): void {
    if (time !== null && (this.firstTimestamp === null || time < this.firstTimestamp)) this.firstTimestamp = time;
  }
  once(id: string): boolean {
    if (this.seenEvents.has(id)) return false;
    if (this.seenEvents.size >= MAX_CALLS * 4) { this.truncated = true; return false; }
    this.seenEvents.add(id); return true;
  }
  add(input: CallInput): void {
    this.observeTime(input.started);
    const tool = name(input.name);
    const toolClass = input.server ? "mcp" : classifyTool(tool, input.args, input.parsed, this.context.contentRules);
    const existing = this.calls.get(input.id);
    if (existing) {
      // Typed completion items often enrich the original response_item with parsed_cmd.
      if ((existing.toolClass === "shell" || existing.toolClass === "other") && toolClass !== "shell" && toolClass !== "other") existing.toolClass = toolClass;
      if (input.server) existing.server = name(input.server);
      const key = this.context.contentRules ? this.context.secret : null;
      existing.argHash ??= fingerprint(key, `arguments:${existing.name}`, input.args);
      if (!existing.files.length) existing.files = fileFingerprints(key, input.args, input.cwd);
      return;
    }
    if (this.calls.size + this.pending.size >= MAX_CALLS && !this.pending.has(input.id)) { this.truncated = true; return; }
    const key = this.context.contentRules ? this.context.secret : null;
    const call: Call = {
      name: tool, toolClass,
      server: input.server ? name(input.server) : (/^(?:functions\.)?mcp__([^_].*?)__/.exec(tool)?.[1] ?? null),
      argHash: fingerprint(key, `arguments:${tool}`, input.args),
      files: fileFingerprints(key, input.args, input.cwd),
      started: input.started, order: this.calls.size,
      outcome: "unknown", error: null, durationMs: null,
    };
    this.calls.set(input.id, call);
    const pending = this.pending.get(input.id);
    if (pending) { this.result(input.id, pending); this.pending.delete(input.id); }
  }
  result(id: string, result: CallResult): void {
    const target = this.calls.get(id) ?? this.pending.get(id);
    if (!target) {
      if (this.calls.size + this.pending.size >= MAX_CALLS) { this.truncated = true; return; }
      this.pending.set(id, { outcome: result.outcome, error: result.error, durationMs: result.durationMs });
      return;
    }
    if (rank[result.outcome] > rank[target.outcome] || (rank[result.outcome] === rank[target.outcome] && (!target.error || target.error === "unknown"))) {
      target.outcome = result.outcome; target.error = result.error;
    }
    if (result.durationMs !== null) target.durationMs = result.durationMs;
  }
  toolClass(id: string): ToolClass { return this.calls.get(id)?.toolClass ?? "other"; }
  isShellCall(id: string): boolean {
    const call = this.calls.get(id);
    return Boolean(call && classifyTool(call.name, undefined, undefined, false) === "shell");
  }
  connectionFailure(server: unknown): void {
    const normalized = name(server);
    this.connectionFailures.set(normalized, (this.connectionFailures.get(normalized) ?? 0) + 1);
  }
  finish(): SessionReliability {
    const calls = [...this.calls.values()];
    const tools = new Map<string, ToolReliability>();
    const mcp = new Map<string, McpReliability>();
    for (const [server, connectionFailures] of this.connectionFailures) mcp.set(server, { server, connectionFailures, ...emptyStats() });
    const count = (target: ToolReliability | McpReliability, call: Call): void => {
      target.calls += 1; target.outcomes[call.outcome] += 1;
      if (call.error) target.errors[call.error] = (target.errors[call.error] ?? 0) + 1;
      if (call.durationMs !== null) target.latency = mergeLatency([target.latency, latencyFrom([call.durationMs])]);
    };
    for (const call of calls) {
      // Class-sensitive fallback labels are resolved after all completion enrichment.
      if (call.error === "nonzero_exit" && call.toolClass === "test_build") call.error = "test_failed";
      const key = JSON.stringify([call.name, call.toolClass]);
      const tool = tools.get(key) ?? { name: call.name, toolClass: call.toolClass, ...emptyStats() };
      count(tool, call); tools.set(key, tool);
      if (call.server) {
        const server = mcp.get(call.server) ?? { server: call.server, connectionFailures: 0, ...emptyStats() };
        count(server, call); mcp.set(call.server, server);
      }
    }
    const flags = this.context.contentRules && this.context.secret && !this.truncated ? behaviorFlags(calls) : null;
    const checks = calls.filter((c) => c.toolClass === "test_build");
    // Failed/denied edit attempts cannot establish that a file changed. Unknown edits remain eligible.
    const edits = calls.filter((c) => edited(c) && (c.outcome === "success" || c.outcome === "unknown"));
    const firstEdit = edits[0];
    const lastEdit = edits.at(-1);
    const lastCheck = checks.filter((c) => c.outcome !== "unknown" && c.outcome !== "denied" && c.outcome !== "interrupted").at(-1);
    const opaque = calls.some((c) => c.toolClass === "other" || c.outcome === "unknown");
    const verificationAvailable = this.context.contentRules && !this.truncated && !this.inProgress && !opaque;
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
        share: this.context.contentRules && !this.truncated ? guardedShare(checks.length, checks.length + edits.length) : null,
        skip: verificationAvailable && lastEdit ? !lastCheck || lastCheck.order < lastEdit.order : null,
        stepsToFirstEdit: firstEdit?.order ?? null,
        msToFirstEdit: firstEdit?.started !== null && firstEdit?.started !== undefined && this.firstTimestamp !== null ? Math.max(0, firstEdit.started - this.firstTimestamp) : null,
      },
      hooks: this.hooks,
      permissions: { ...this.permissions, denials: calls.filter((c) => c.outcome === "denied").length },
      apiErrors: this.apiErrors,
    };
  }
}

function behaviorFlags(calls: Call[]): ReturnType<typeof emptyFlags> {
  const flags = emptyFlags();
  let repeat = 0, failures = 0, editFailures = 0, reads = 0;
  let previous: string | null = null, previousFailure: string | null = null, previousEdit: string | null = null;
  let window: Array<{ files: string[]; edit: boolean; read: boolean; order: number }> = [];
  const thrashing = new Set<string>(), rereading = new Set<string>();
  for (const call of calls) {
    repeat = call.argHash && call.argHash === previous ? repeat + 1 : call.argHash ? 1 : 0;
    if (repeat === 3) flags.exact_repeat += 1;
    previous = call.argHash;
    failures = failed(call) && call.argHash ? call.argHash === previousFailure ? failures + 1 : 1 : 0;
    previousFailure = failed(call) ? call.argHash : null;
    if (failures === 3) flags.repeated_failure += 1;
    const file = call.files[0] ?? null;
    editFailures = edited(call) && failed(call) && file ? file === previousEdit ? editFailures + 1 : 1 : 0;
    previousEdit = edited(call) && failed(call) ? file : null;
    if (editFailures === 3) flags.failed_edit_cascade += 1;
    if (call.toolClass === "test_build" && call.outcome === "success") { window = []; thrashing.clear(); rereading.clear(); }
    // Reading a file again after it changed is expected, not re-read churn.
    if (edited(call) && call.outcome === "success") {
      for (const entry of window) if (entry.read) entry.files = entry.files.filter((path) => !call.files.includes(path));
      for (const path of call.files) rereading.delete(path);
    }
    window = window.filter((w) => call.order - w.order < 10);
    window.push({ files: call.files, edit: edited(call) && call.outcome === "success", read: call.toolClass === "read", order: call.order });
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
