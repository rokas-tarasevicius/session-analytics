import type { McpActivityState } from "./types.ts";
import { record, timestamp } from "./names.ts";

/** Lifecycle observations, not a liveness or success detector. Keys stay local. */
export class McpActivityCollector {
  private sources = new Map<string, { state: McpActivityState; time: number }>();
  private invalid = false;

  private observe(source: string, raw: Record<string, unknown>, state?: McpActivityState): void {
    const previous = this.sources.get(source) ?? { state: "unknown", time: -Infinity };
    this.sources.set(source, previous);
    if (raw["__parse_error"] === true) this.invalid = true;
    if (!state) return;
    const date = timestamp(raw["timestamp"]);
    if (!date) { this.invalid = true; return; }
    const time = Date.parse(date);
    if (time >= previous.time) this.sources.set(source, { state, time });
  }

  claude(raw: Record<string, unknown>, source: string): void {
    const message = record(raw["message"]);
    let state: McpActivityState | undefined;
    if (raw["type"] === "user") state = "active";
    if (raw["type"] === "assistant") state = message?.["stop_reason"] === "end_turn" ? "settled" : "active";
    if (raw["type"] === "system" && raw["subtype"] === "turn_duration") state = "settled";
    this.observe(source, raw, state);
  }

  codex(raw: Record<string, unknown>): void {
    const payload = record(raw["payload"]);
    const type = payload?.["type"];
    let state: McpActivityState | undefined;
    if (raw["type"] === "event_msg") {
      if (type === "task_started" || type === "user_message" ||
          (type === "item_completed" && record(payload?.["item"])?.["type"] === "UserMessage")) state = "active";
      if (type === "task_complete" || type === "turn_aborted") state = "settled";
    }
    if (raw["type"] === "response_item" && (type === "function_call" || type === "custom_tool_call")) state = "active";
    // token_count can be a broadcast from another session, even after completion.
    this.observe("codex", raw, state);
  }

  finish(working: boolean): McpActivityState {
    const states = [...this.sources.values()].map((item) => item.state);
    if (working || states.includes("active")) return "active";
    return this.invalid || !states.length || states.includes("unknown") ? "unknown" : "settled";
  }
}
