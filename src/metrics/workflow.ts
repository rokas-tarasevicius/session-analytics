import { histogram } from "../public/workflow-data.js";
import type { SessionWorkflow, WorkflowEffort, WorkflowEntrypoint, WorkflowMix, WorkflowOriginator, WorkflowSpan } from "./workflow-types.ts";

type RecordValue = Record<string, unknown>;
type Kind = "human" | "start" | "activity" | "assistant" | "tool" | "end" | "abort";
interface Event { at: number; kind: Kind; count: number; duration: number | null; turn: string | null }
export interface WorkflowHistory {
  commands: Map<string, Array<{ name: string; at: string }>>;
  available: boolean;
}
const IDLE = 5 * 60_000, WAIT_CAP = 30 * 60_000, DAY = 86_400_000;
const MAX_EVENTS = 100_000;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const string = (value: unknown): string | null => typeof value === "string" ? value : null;
const duration = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 7 * DAY ? value : null;
export const workflowName = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value) ? value : null;
export function workflowTimestamp(value: unknown): number | null {
  // Reject arbitrary strings, relative clocks, invalid dates and very distant dates.
  const time = typeof value === "number" ? value : typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time >= Date.UTC(2020, 0) && time <= Date.UTC(2100, 0) ? time : null;
}
const iso = (time: number): string => new Date(time).toISOString();
const entrypoint = (value: unknown): WorkflowEntrypoint => ["cli", "sdk-ts", "local-agent", "vscode", "exec", "subagent", "review"].includes(String(value)) ? value as WorkflowEntrypoint : "unknown";
const originator = (value: unknown): WorkflowOriginator => ["codex_cli_rs", "codex_vscode", "codex_exec", "codex_sdk", "app-server"].includes(String(value)) ? value as WorkflowOriginator : "unknown";
const effort = (value: unknown): WorkflowEffort | null => ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(String(value)) ? value as WorkflowEffort : null;
const version = (value: unknown): string | null => typeof value === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc|dev)(?:[.-]?\d{1,6})?)?$/.test(value) ? value : null;
const blocks = (message: RecordValue | null): RecordValue[] => Array.isArray(message?.content) ? message.content.map(record).filter((b): b is RecordValue => b !== null) : [];

/** Streaming projection: retains timestamps, bounded labels and ephemeral dedupe IDs only. */
export class WorkflowCollector {
  private readonly provider: "claude" | "codex";
  private readonly contentRules: boolean;
  private readonly history: WorkflowHistory | undefined;
  private commands: Array<{ name: string; at: string }> = [];
  private events: Event[] = [];
  private humans: Event[][] = [[], []];
  private tools: Event[][] = [[], []];
  private humanCounts = [0, 0];
  private toolCounts = [0, 0];
  private seen = new Set<string>();
  private messageEnds = new Map<string, Event>();
  private timestamped = 0;
  private untimed = 0;
  private dropped = 0;
  private count = 0;
  private subagent = false;
  private topLevel = false;
  private plan = false;
  private mix: WorkflowMix[] = [];
  private current: Omit<WorkflowMix, "at"> = { model: null, effort: null, cliVersion: null, entrypoint: "unknown", originator: "unknown" };
  private interruptions: SessionWorkflow["interruptions"];
  private steering: SessionWorkflow["steering"] = {
    midTurnHumanTurns: 0, planEntries: 0, planItems: 0,
    queueOperations: { enqueue: 0, dequeue: 0, remove: 0, other: 0 },
    queueReasons: { prompt: 0, interrupt: 0, completion: 0, cancellation: 0, other: 0, unspecified: 0 },
  };
  private values = new Map<string, number>();
  private pricedRequests = 0;
  private timestampedPricedRequests = 0;

  constructor(provider: "claude" | "codex", contentRules = false, history?: WorkflowHistory) {
    this.provider = provider; this.contentRules = provider === "claude" && contentRules; this.history = history;
    this.interruptions = { interrupted: 0, replaced: 0, other: 0, subagentInterrupted: 0, claudeMarkers: this.contentRules ? 0 : null };
  }

  private event(kind: Kind, timestamp: unknown, target = this.events, count = 1, elapsed: unknown = null, turn: unknown = null): Event | undefined {
    if (this.count >= MAX_EVENTS) { this.dropped += 1; return; }
    this.count += 1;
    if (kind === "human") { const index = target === this.humans[1] ? 1 : 0; this.humanCounts[index] = (this.humanCounts[index] ?? 0) + count; }
    if (kind === "tool") { const index = target === this.tools[1] ? 1 : 0; this.toolCounts[index] = (this.toolCounts[index] ?? 0) + count; }
    const at = workflowTimestamp(timestamp);
    if (at === null) { this.untimed += 1; return; }
    this.timestamped += 1;
    const event = { at, kind, count, duration: duration(elapsed), turn: string(turn) };
    target.push(event); return event;
  }

  private duplicate(key: string): boolean {
    if (this.seen.has(key)) return true;
    if (this.seen.size < MAX_EVENTS) this.seen.add(key);
    else { this.dropped += 1; return true; }
    return false;
  }

  /** Called only for already-deduplicated effective tool calls in the accounting parser. */
  tool(timestamp: unknown, count = 1): void { this.event("tool", timestamp, this.tools[0], count); }

  /** Called only after deduplication and pricing, never from raw usage records. */
  value(timestamp: unknown, usd: number, executionKind: string): void {
    if (this.provider === "claude" && executionKind === "subagent") return;
    this.pricedRequests += 1;
    const at = workflowTimestamp(timestamp);
    if (at === null || !Number.isFinite(usd) || usd < 0) return;
    this.timestampedPricedRequests += 1;
    const hour = iso(Math.floor(at / 3_600_000) * 3_600_000);
    this.values.set(hour, (this.values.get(hour) ?? 0) + usd);
  }

  private mode(value: unknown): void {
    if (typeof value !== "string") return;
    const plan = value === "plan";
    if (plan && !this.plan) this.steering.planEntries += 1;
    this.plan = plan;
  }

  private metadata(at: unknown, fields: Partial<Omit<WorkflowMix, "at">>): void {
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
      const value = fields[key];
      if (value !== undefined) Object.assign(this.current, { [key]: value });
    }
    const time = workflowTimestamp(at);
    if (time === null) return;
    const previous = this.mix.at(-1), timestamp = iso(time);
    if (!previous || previous.at.slice(0, 10) !== timestamp.slice(0, 10) || Object.keys(this.current).some((key) => previous[key as keyof typeof this.current] !== this.current[key as keyof typeof this.current])) {
      if (this.mix.length >= 10_000) { this.dropped += 1; return; }
      this.mix.push({ at: timestamp, model: this.current.model, effort: this.current.effort, cliVersion: this.current.cliVersion, entrypoint: this.current.entrypoint, originator: this.current.originator });
    }
  }

  observe(raw: RecordValue, line: number): void {
    if (this.count >= MAX_EVENTS) { this.dropped += 1; return; }
    if (this.provider === "claude") this.claude(raw, line);
    else this.codex(raw, line);
  }

  private claude(raw: RecordValue, line: number): void {
    const timestamp = raw.timestamp, type = raw.type, message = record(raw.message);
    if (this.duplicate(`record:${string(raw.uuid) ?? line}`)) return;
    this.topLevel = true;
    const sessionId = string(raw.sessionId);
    if (sessionId && this.history?.commands.has(sessionId)) this.commands = this.history.commands.get(sessionId) ?? [];
    this.metadata(timestamp, {
      model: message?.model === undefined ? undefined : workflowName(message.model),
      effort: raw.effort === undefined ? undefined : effort(raw.effort),
      cliVersion: raw.version === undefined ? undefined : version(raw.version),
      entrypoint: raw.entrypoint === undefined ? undefined : entrypoint(raw.entrypoint),
    });
    this.mode(raw.permissionMode ?? (type === "permission-mode" || type === "mode" ? raw.mode : undefined));
    if (type === "queue-operation") {
      const op = string(raw.operation) ?? "other";
      this.steering.queueOperations[op === "enqueue" || op === "dequeue" || op === "remove" ? op : "other"] += 1;
      const reason = raw.reason;
      const bucket = reason === undefined || reason === null ? "unspecified"
        : ["prompt", "user", "user_input", "user-input"].includes(String(reason)) ? "prompt"
          : ["interrupt", "interrupted", "replaced"].includes(String(reason)) ? "interrupt"
            : ["complete", "completed", "completion"].includes(String(reason)) ? "completion"
              : ["cancel", "cancelled", "canceled", "clear"].includes(String(reason)) ? "cancellation" : "other";
      this.steering.queueReasons[bucket] += 1;
    }
    if (type === "system" && raw.subtype === "turn_duration") this.event("end", timestamp, this.events, 1, raw.durationMs);
    if (type === "assistant") {
      this.event(blocks(message).some((b) => b.type === "tool_use") ? "activity" : "assistant", timestamp);
      if (message?.stop_reason === "end_turn" || message?.stop_reason === "stop_sequence") {
        const key = string(message?.id) ?? `${line}`, prior = this.messageEnds.get(key), at = workflowTimestamp(timestamp);
        if (prior && at !== null) prior.at = Math.max(prior.at, at);
        else { const event = this.event("end", timestamp); if (event) this.messageEnds.set(key, event); }
      }
    }
    if (type === "user" && message) {
      const content = message.content, parts = blocks(message);
      // Fixed transport markers only, never substring searches over a user's prose.
      const marker = (text: unknown): boolean => text === "[Request interrupted by user]" || text === "[Request interrupted by user for tool use]";
      if (this.contentRules && (marker(content) || (parts.length === 1 && parts[0]?.type === "text" && marker(parts[0]?.text)))) {
        this.interruptions.claudeMarkers = (this.interruptions.claudeMarkers ?? 0) + 1;
        this.event("abort", timestamp); return;
      }
      if (parts.some((b) => b.type === "tool_result")) this.event("activity", timestamp);
      // Synthetic task notifications / sub-agent messages are not human decisions.
      const automated = raw.isMeta === true || raw.isSidechain === true || raw.isCompactSummary === true || record(raw.origin)?.kind === "agent";
      if (!automated && ((typeof content === "string" && content.length > 0) || parts.some((b) => b.type === "text"))) this.event("human", timestamp, this.humans[0]);
    }
  }

  private codex(raw: RecordValue, line: number): void {
    const payload = record(raw.payload), timestamp = raw.timestamp, type = raw.type, subtype = payload?.type;
    if (!payload) return;
    if (type === "session_meta") {
      this.subagent = Boolean(record(payload.source)?.subagent);
      if (!this.subagent) this.topLevel = true;
      this.metadata(timestamp, { cliVersion: payload.cli_version === undefined ? undefined : version(payload.cli_version), entrypoint: this.subagent ? "subagent" : entrypoint(payload.source), originator: originator(payload.originator) });
      return;
    }
    if (type === "turn_context") {
      this.metadata(timestamp, { model: payload.model === undefined ? undefined : workflowName(payload.model), effort: payload.effort === undefined ? undefined : effort(payload.effort) });
      this.mode(record(payload.collaboration_mode)?.mode); return;
    }
    this.metadata(timestamp, {});
    if (type === "event_msg") {
      const turn = string(payload.turn_id), fallback = string(raw.uuid) ?? `${string(timestamp) ?? line}`;
      if (subtype === "user_message" && !this.subagent && !this.duplicate(`human:${fallback}`)) this.event("human", timestamp, this.humans[0]);
      if (subtype === "agent_message") this.event("assistant", timestamp);
      if (subtype === "task_started" && !this.duplicate(`start:${turn ?? fallback}`)) this.event("start", timestamp, this.events, 1, null, turn);
      if (subtype === "task_complete" && !this.duplicate(`end:${turn ?? fallback}`)) this.event("end", timestamp, this.events, 1, payload.duration_ms, turn);
      if (subtype === "turn_aborted" && !this.duplicate(`abort:${turn ?? fallback}`)) {
        const reason = payload.reason;
        this.interruptions[reason === "interrupted" || reason === "replaced" ? reason : "other"] += 1;
        this.event("abort", timestamp, this.events, 1, payload.duration_ms, turn);
      }
      if (subtype === "item_completed") {
        const item = record(payload.item);
        if (!item || this.duplicate(`item:${item.type}:${string(item.id) ?? line}`)) return;
        if (item.type === "UserMessage" && !this.subagent) this.event("human", timestamp, this.humans[1]);
        else if (item.type === "AgentMessage") this.event("assistant", timestamp);
        else if (["CommandExecution", "FileChange", "McpToolCall", "WebSearch"].includes(String(item.type))) this.event("tool", timestamp, this.tools[1]);
        else if (item.type === "Plan") { this.steering.planItems += 1; this.event("activity", timestamp); }
        else if (item.type === "SubAgentActivity") {
          if (item.kind === "interrupted") this.interruptions.subagentInterrupted += 1;
          this.event("activity", timestamp);
        }
      }
    }
    if (type === "response_item" && (subtype === "function_call_output" || subtype === "custom_tool_call_output")) this.event("activity", timestamp);
    // token_count is often broadcast across sessions; it is not local activity.
  }

  finish(now = Date.now(), working = false): SessionWorkflow {
    const humanShape = this.humanCounts[1]! > this.humanCounts[0]! ? 1 : 0;
    const toolShape = this.toolCounts[1]! > this.toolCounts[0]! ? 1 : 0;
    const humans = this.humans[humanShape]!, tools = this.tools[toolShape]!;
    const order: Record<Kind, number> = { human: 0, start: 1, tool: 2, activity: 3, assistant: 4, end: 5, abort: 6 };
    const events = [...this.events, ...humans, ...tools].sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);
    const runs: number[] = [], elapsed: number[] = [], spans: WorkflowSpan[] = [];
    let run: number | null = null, humanStart: number | null = null, turnStart: number | null = null, turnId: string | null = null;
    let lastWork: number | null = null, ended = false, explicitOpen = false, recorded = 0, inferred = 0, waiting = 0;
    let midTurnHumanTurns = 0, latestDurationRecorded = false, turnSampleIndex: number | null = null;
    let previous: Event | null = null, pendingEnd: number | null = null, toolPending = false;
    for (const event of events) {
      if (event.kind === "human") {
        if (run !== null) runs.push(run);
        if (explicitOpen && turnStart !== null && lastWork !== null && lastWork > turnStart) midTurnHumanTurns += 1;
        else if (!explicitOpen && !ended && humanStart !== null && lastWork !== null && lastWork > humanStart) {
          if (toolPending) midTurnHumanTurns += 1;
          else { elapsed.push(lastWork - humanStart); inferred += 1; }
        }
        if (pendingEnd !== null) waiting += Math.min(WAIT_CAP, Math.max(0, event.at - pendingEnd));
        run = 0; humanStart = event.at; ended = false; toolPending = false; pendingEnd = null;
        // A typed UserMessage can be logged after task_started. Mid-turn input
        // splits an autonomy run, but must not reset the task's wall clock.
        if (!explicitOpen) { turnStart = null; turnId = null; latestDurationRecorded = false; turnSampleIndex = null; }
      } else if (event.kind === "start") {
        turnStart = event.at; turnId = event.turn; explicitOpen = true; ended = false; pendingEnd = null; latestDurationRecorded = false; turnSampleIndex = null;
      } else if (event.kind === "end" || event.kind === "abort") {
        if (!event.turn || !turnId || event.turn === turnId) {
          if (!ended) {
            const start = turnStart ?? humanStart;
            if (event.duration !== null) { turnSampleIndex = elapsed.length; elapsed.push(event.duration); recorded += 1; latestDurationRecorded = true; }
            else if (start !== null && event.at > start) { turnSampleIndex = elapsed.length; elapsed.push(event.at - start); inferred += 1; }
          } else if (event.duration !== null && !latestDurationRecorded) {
            if (turnSampleIndex !== null) { elapsed[turnSampleIndex] = event.duration; inferred -= 1; }
            else { turnSampleIndex = elapsed.length; elapsed.push(event.duration); }
            recorded += 1; latestDurationRecorded = true;
          }
          ended = true; explicitOpen = false; toolPending = false; pendingEnd = event.at;
        }
      } else {
        if (event.kind === "tool") { if (run !== null) run += event.count; toolPending = true; }
        if (event.kind === "assistant") toolPending = false;
        lastWork = event.at; pendingEnd = null;
      }
      if (previous) {
        const gap = event.at - previous.at;
        const afterTerminal = previous.kind === "end" || previous.kind === "abort";
        if (gap > 0 && gap <= IDLE && !afterTerminal && !(previous.kind === "human" && event.kind === "human")) {
          const last = spans.at(-1), start = iso(previous.at), end = iso(event.at);
          if (last?.end === start) last.end = end;
          else spans.push({ start, end });
        }
      }
      previous = event;
    }
    if (run !== null) runs.push(run);
    const last = events.at(-1), first = events[0];
    const ending = !last ? "unavailable" : last.kind === "end" ? "terminal" : last.kind === "abort" ? "interrupted" : last.kind === "assistant" && !explicitOpen ? "inferred" : "open";
    if (!ended && !explicitOpen && last?.kind === "assistant" && humanStart !== null && last.at > humanStart) { elapsed.push(last.at - humanStart); inferred += 1; }
    const active = spans.reduce((sum, span) => sum + Date.parse(span.end) - Date.parse(span.start), 0);
    const observedSpan = last && first ? last.at - first.at : 0;
    // Waiting is only between a terminal marker and the next human, with no
    // intervening work. Metadata does not advance the activity clock.
    waiting = Math.min(waiting, Math.max(0, observedSpan - active));
    const toolCalls = this.toolCounts[toolShape]!, humanTurns = this.topLevel ? this.humanCounts[humanShape]! : null;
    const turns = humanTurns ?? 0;
    const archetype = !active ? null : active >= 4 * 3_600_000 || turns >= 30 || toolCalls >= 300 ? "marathon"
      : active >= 3_600_000 || turns >= 10 || toolCalls >= 80 ? "deep"
        : active < 10 * 60_000 && turns <= 2 && toolCalls <= 10 ? "quick" : "standard";
    const abandonment = working || (last && now - last.at < DAY && ending === "open") ? "ongoing"
      : humanTurns === null || !last || !humanTurns || toolCalls < 3 || this.dropped > 0 ? "insufficient-evidence"
        : !ended && last.kind !== "assistant" && now - last.at >= DAY ? "flagged" : "not-flagged";
    return {
      schemaVersion: 1, scope: "primary-transcript", ending,
      coverage: { timing: !observedSpan ? "unavailable" : this.untimed || this.dropped ? "partial" : "observed", humanTurns: humanTurns === null ? "not-applicable" : "observed", timestampedEvents: this.timestamped, untimedEvents: this.untimed, droppedEvents: this.dropped, contentRules: this.contentRules },
      humanTurns, toolCalls, toolRuns: histogram(humanTurns === null || this.untimed || this.dropped ? [] : runs), turnWallTime: histogram(elapsed), recordedTurnDurations: recorded, inferredTurnDurations: inferred,
      time: { activeMilliseconds: active, waitingForHumanMilliseconds: waiting, unclassifiedMilliseconds: Math.max(0, observedSpan - active - waiting), observedSpanMilliseconds: observedSpan, idleThresholdMilliseconds: IDLE, waitingCapMilliseconds: WAIT_CAP, activeSpans: spans },
      interruptions: { ...this.interruptions },
      steering: { midTurnHumanTurns, planEntries: this.steering.planEntries, planItems: this.steering.planItems, queueOperations: { ...this.steering.queueOperations }, queueReasons: { ...this.steering.queueReasons } },
      archetype, abandonment, mix: this.mix,
      commands: this.commands.map(({ name, at }) => ({ name, at })), commandHistoryAvailable: this.history?.available ?? false,
      valueByHour: [...this.values].sort(([a], [b]) => a.localeCompare(b)).map(([hour, usd]) => ({ hour, usd })), pricedRequests: this.pricedRequests, timestampedPricedRequests: this.timestampedPricedRequests,
    };
  }
}
