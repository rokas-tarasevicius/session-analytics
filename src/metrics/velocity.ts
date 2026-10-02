import type {
  AgentIdentity, ClaudeEntrypoint, ClaudeSubagentType, CodexOriginator, CodexSource,
  ExecutionKind, SessionProvider, SessionVelocity, TokenUsage, VelocityAgent,
  VelocityDimension, VelocityEffort, VelocityMetadata, VelocityValues,
} from "../types.ts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function claudeEntrypoint(value: unknown): ClaudeEntrypoint {
  return value === "cli" ? "cli" : value === "sdk-ts" ? "sdk" : value === "local-agent" ? "desktop" : "unknown";
}
export function claudeSubagentType(value: unknown): ClaudeSubagentType {
  return value === "general-purpose" ? value : value === "Explore" ? "explore" : value === "Plan" ? "plan" : "other";
}
export function codexSource(value: unknown): CodexSource {
  if (record(value)?.["subagent"]) return "subagent";
  return value === "cli" || value === "exec" || value === "vscode" || value === "review" ? value : "unknown";
}
export function codexOriginator(value: unknown): CodexOriginator {
  switch (value) {
    case "codex_cli_rs": return "cli";
    case "codex_exec": return "exec";
    case "codex_vscode": return "vscode";
    case "Codex Desktop": return "desktop";
    default: return "unknown";
  }
}
export function velocityEffort(value: unknown): VelocityEffort {
  switch (value) {
    case "none": case "minimal": case "low": case "medium": case "high":
    case "xhigh": case "max": case "ultra": return value;
    default: return "unknown";
  }
}
export function velocityAgent(provider: SessionProvider, identity: AgentIdentity, execution: ExecutionKind): VelocityAgent {
  if (provider === "cursor") return "cursor";
  if (provider === "codex") {
    const source = identity.codexSource;
    return `codex-${source && source !== "unknown" ? source : identity.codexOriginator ?? "unknown"}`;
  }
  if (execution === "subagent") {
    const type = identity.claudeSubagentType;
    return type && type !== "other" && type !== "mixed" ? `claude-${type}` : "claude-subagent";
  }
  return `claude-${identity.claudeEntrypoint ?? "unknown"}`;
}
export function velocityDimension(provider: SessionProvider, identity: AgentIdentity, execution: ExecutionKind, model: string, effort: unknown): VelocityDimension {
  return {
    agent: velocityAgent(provider, identity, execution), model,
    executionKind: execution === "top-level" || execution === "subagent" ? execution : "unknown",
    effort: velocityEffort(effort),
  };
}

export function counterExposed(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function velocityMetadata(): VelocityMetadata {
  return { version: 1, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
}

/** Require an absolute, evidenced timestamp. Never substitute a file mtime or an invalid raw string. */
export function localClock(timestamp: string | null): { day: string; hour: number } | null {
  if (!timestamp || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.valueOf())) return null;
  return {
    day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    hour: date.getHours(),
  };
}

export const zeroVelocity = (): VelocityValues => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

export function usageVelocity(usage: TokenUsage, value: number, priced: boolean, coverage: { reasoning: boolean; cacheRead: boolean; cacheWrite: boolean }): VelocityValues {
  return [
    value, usage.inputTokens, usage.uncachedInputTokens, usage.cachedInputTokens,
    usage.cacheWriteInputTokens, usage.outputTokens, usage.reasoningOutputTokens, 1, 0, 0,
    priced ? usage.inputTokens + usage.outputTokens : 0,
    coverage.reasoning ? usage.outputTokens : 0,
    coverage.cacheRead ? usage.inputTokens : 0,
    coverage.cacheWrite ? usage.inputTokens : 0,
  ];
}

/** Streaming, content-free accumulator. Storage grows with occupied cells, not request count. */
export class VelocityAccumulator {
  private dimensions: VelocityDimension[] = [];
  private dimensionIds = new Map<string, number>();
  private buckets = new Map<string, [string, number, number, VelocityValues]>();
  private undated = new Map<number, VelocityValues>();

  add(timestamp: string | null, dimension: VelocityDimension, values: VelocityValues): void {
    const key = JSON.stringify([dimension.agent, dimension.model, dimension.executionKind, dimension.effort]);
    let id = this.dimensionIds.get(key);
    if (id === undefined) {
      id = this.dimensions.length;
      this.dimensionIds.set(key, id);
      this.dimensions.push({ agent: dimension.agent, model: dimension.model, executionKind: dimension.executionKind, effort: dimension.effort });
    }
    const clock = localClock(timestamp);
    let target: VelocityValues;
    if (clock) {
      const cellKey = `${clock.day}:${clock.hour}:${id}`;
      let cell = this.buckets.get(cellKey);
      if (!cell) {
        cell = [clock.day, clock.hour, id, zeroVelocity()];
        this.buckets.set(cellKey, cell);
      }
      target = cell[3];
    } else {
      target = this.undated.get(id) ?? zeroVelocity();
      this.undated.set(id, target);
    }
    for (let index = 0; index < target.length; index += 1) target[index]! += values[index]!;
  }

  tool(timestamp: string | null, dimension: VelocityDimension, count = 1): void {
    const values = zeroVelocity(); values[8] = count; this.add(timestamp, dimension, values);
  }

  finish(start: string | null, dimension: VelocityDimension): SessionVelocity {
    const values = zeroVelocity(); values[9] = 1; this.add(start, dimension, values);
    return {
      dimensions: this.dimensions,
      buckets: [...this.buckets.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]),
      undated: [...this.undated].sort((a, b) => a[0] - b[0]),
    };
  }
}
