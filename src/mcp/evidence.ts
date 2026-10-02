import type { McpRateWindow, McpSessionEvidence } from "./types.ts";
import { record, safeName, timestamp } from "./names.ts";

const MAX_CALLS = 100_000;

/** Called during the existing streaming pass. IDs only join structured flags locally. */
export class McpEvidenceCollector {
  private calls = new Map<string, string>();
  private results = new Map<string, boolean>();
  private limits = new Map<number, McpRateWindow>();
  private truncated = false;

  private call(id: unknown, name: unknown): void {
    const tool = safeName(name);
    if (typeof id !== "string" || id.length > 512 || !tool) return;
    if (this.calls.size >= MAX_CALLS && !this.calls.has(id)) { this.truncated = true; return; }
    this.calls.set(id, tool);
  }

  private result(id: unknown, error: unknown): void {
    if (typeof id !== "string" || id.length > 512 || typeof error !== "boolean") return;
    if (this.results.size >= MAX_CALLS && !this.results.has(id)) { this.truncated = true; return; }
    // A repeated observation must not erase an explicitly observed failure.
    this.results.set(id, error || this.results.get(id) === true);
  }

  claude(raw: Record<string, unknown>): void {
    const message = record(raw["message"]);
    const content = message?.["content"];
    if (!Array.isArray(content)) return;
    for (const value of content) {
      const block = record(value);
      if (raw["type"] === "assistant" && block?.["type"] === "tool_use") {
        this.call(block["id"], block["name"]);
      } else if (raw["type"] === "user" && block?.["type"] === "tool_result") {
        this.result(block["tool_use_id"], block["is_error"]);
      }
    }
  }

  codex(raw: Record<string, unknown>): void {
    const payload = record(raw["payload"]);
    if (!payload) return;
    if (raw["type"] === "response_item") {
      if (payload["type"] === "function_call" || payload["type"] === "custom_tool_call") {
        this.call(payload["call_id"], payload["name"]);
      }
      if (payload["type"] === "function_call_output" || payload["type"] === "custom_tool_call_output") {
        this.result(payload["call_id"], record(payload["output"])?.["isError"]);
      }
    }
    if (raw["type"] !== "event_msg") return;
    if (payload["type"] === "item_completed") {
      const item = record(payload["item"]);
      if (item?.["type"] === "McpToolCall") {
        const server = safeName(item["server"]), tool = safeName(item["tool"]);
        const id = item["id"];
        if (server && tool) this.call(id, `mcp__${server}__${tool}`);
        const flag = record(item["result"])?.["isError"];
        const status = item["status"];
        if (status === "failed" || flag === true) this.result(id, true);
        else if (status === "completed" || flag === false) this.result(id, false);
      }
    }
    if (payload["type"] !== "token_count") return;
    const observedAt = timestamp(raw["timestamp"]);
    if (!observedAt) return;
    const limits = record(payload["rate_limits"]);
    for (const key of ["primary", "secondary"]) {
      const window = record(limits?.[key]);
      const minutes = window?.["window_minutes"], used = window?.["used_percent"], reset = window?.["resets_at"];
      if ((minutes !== 300 && minutes !== 10080) || typeof used !== "number" || !Number.isFinite(used) ||
          used < 0 || used > 100 || typeof reset !== "number" || !Number.isFinite(reset) ||
          reset < 1_577_836_800 || reset > 32_503_680_000) continue;
      const previous = this.limits.get(minutes);
      if (!previous || observedAt > previous.observedAt || (observedAt === previous.observedAt && used > previous.usedPercent)) {
        this.limits.set(minutes, { windowMinutes: minutes, usedPercent: used, observedAt, resetsAt: new Date(reset * 1000).toISOString() });
      }
    }
  }

  finish(): McpSessionEvidence {
    const byTool = new Map<string, { tool: string; observedResults: number; errors: number }>();
    for (const [id, error] of this.results) {
      const tool = this.calls.get(id);
      if (!tool) continue;
      const value = byTool.get(tool) ?? { tool, observedResults: 0, errors: 0 };
      value.observedResults += 1;
      if (error) value.errors += 1;
      byTool.set(tool, value);
    }
    return {
      toolOutcomes: [...byTool.values()].sort((a, b) => a.tool.localeCompare(b.tool)),
      rateLimits: [...this.limits.values()].sort((a, b) => a.windowMinutes - b.windowMinutes),
      truncated: this.truncated,
    };
  }
}
