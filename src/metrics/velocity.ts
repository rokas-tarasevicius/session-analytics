import type {
  AgentIdentity, ClaudeEntrypoint, ClaudeSubagentType, CodexOriginator, CodexSource,
  ExecutionKind, SessionProvider, SessionVelocity, TokenUsage, VelocityAgent,
  VelocityDimension, VelocityEffort, VelocityMetadata, VelocityValues,
} from "../types.ts";

import { normalizeTimestamp } from "../public/timestamps.js";

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
  if (provider === "cursor" || provider === "copilot" || provider === "opencode" || provider === "gemini" || provider === "antigravity") return provider;
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
    agent: velocityAgent(provider, identity, execution), model: publicModelId(model),
    executionKind: execution === "top-level" || execution === "subagent" ? execution : "unknown",
    effort: velocityEffort(effort),
  };
}

/** Public IDs are bounded ASCII tokens, never paths, URLs or executable/free text.
 * Raw labels may still be used privately for pricing lookups. */
export function publicModelId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : "<unknown>";
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
  const normalized = normalizeTimestamp(timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!normalized) return null;
  const date = new Date(normalized);
  if (!Number.isFinite(date.valueOf())) return null;
  return {
    day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    hour: date.getHours(),
  };
}

export const zeroVelocity = (): VelocityValues => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

export function usageVelocity(usage: TokenUsage, value: number, pricedTokens: number, coverage: { reasoning: boolean; cacheRead: boolean; cacheWrite: boolean }, calls = 1): VelocityValues {
  return [
    value, usage.inputTokens, usage.uncachedInputTokens, usage.cachedInputTokens,
    usage.cacheWriteInputTokens, usage.outputTokens, usage.reasoningOutputTokens, calls, 0, 0,
    pricedTokens,
    coverage.reasoning ? usage.outputTokens : 0,
    coverage.cacheRead ? usage.inputTokens : 0,
    coverage.cacheWrite ? usage.inputTokens : 0,
  ];
}

/** Adds session-dated values to a finished ledger without changing its activity-dated cells.
 * Without a valid session time the values stay undated. */
export function addSessionDated(velocity: SessionVelocity, at: string | null, dimension: VelocityDimension, values: VelocityValues): SessionVelocity {
  const model = publicModelId(dimension.model);
  const dimensions = [...velocity.dimensions];
  let id = dimensions.findIndex((item) => item.agent === dimension.agent && item.model === model && item.executionKind === dimension.executionKind && item.effort === dimension.effort);
  if (id < 0) { id = dimensions.length; dimensions.push({ agent: dimension.agent, model, executionKind: dimension.executionKind, effort: dimension.effort }); }
  const merge = (target: VelocityValues): VelocityValues => target.map((value, index) => value + values[index]!) as VelocityValues;
  const clock = localClock(at);
  if (!clock) {
    const undated = velocity.undated.some(([dimension]) => dimension === id)
      ? velocity.undated.map(([dimension, cell]): [number, VelocityValues] => [dimension, dimension === id ? merge(cell) : cell])
      : [...velocity.undated, [id, merge(zeroVelocity())] as [number, VelocityValues]].sort((a, b) => a[0] - b[0]);
    return { ...velocity, dimensions, undated };
  }
  const cells = velocity.sessionDated ?? [];
  const matches = (cell: [string, number, number, VelocityValues]) => cell[0] === clock.day && cell[1] === clock.hour && cell[2] === id;
  const sessionDated = cells.some(matches)
    ? cells.map((cell): [string, number, number, VelocityValues] => matches(cell) ? [cell[0], cell[1], cell[2], merge(cell[3])] : cell)
    : [...cells, [clock.day, clock.hour, id, merge(zeroVelocity())] as [string, number, number, VelocityValues]].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]);
  return { ...velocity, dimensions, sessionDated };
}

/** Placement of a counter without its own valid timestamp: `undated` keeps it out of every date
 * window; `session` places it on the session's last evidenced activity time when finished. */
export type VelocityFallback = "undated" | "session";

/** Streaming, content-free accumulator. Storage grows with occupied cells, not request count. */
export class VelocityAccumulator {
  private dimensions: VelocityDimension[] = [];
  private dimensionIds = new Map<string, number>();
  private buckets = new Map<string, [string, number, number, VelocityValues]>();
  private undated = new Map<number, VelocityValues>();
  private pendingSession = new Map<number, VelocityValues>();

  add(timestamp: string | null, dimension: VelocityDimension, values: VelocityValues, fallback: VelocityFallback = "undated"): void {
    // Final boundary also covers dimensions amended by parser model fallbacks.
    dimension = { ...dimension, model: publicModelId(dimension.model) };
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
      const cells = fallback === "session" ? this.pendingSession : this.undated;
      target = cells.get(id) ?? zeroVelocity();
      cells.set(id, target);
    }
    for (let index = 0; index < target.length; index += 1) target[index]! += values[index]!;
  }

  tool(timestamp: string | null, dimension: VelocityDimension, count = 1, fallback: VelocityFallback = "undated"): void {
    const values = zeroVelocity(); values[8] = count; this.add(timestamp, dimension, values, fallback);
  }

  /** `sessionAt` dates the counters added with the session fallback; without a valid time they stay undated. */
  finish(start: string | null, dimension: VelocityDimension, sessionAt: string | null = null): SessionVelocity {
    const values = zeroVelocity(); values[9] = 1; this.add(start, dimension, values);
    const clock = localClock(sessionAt);
    const sessionDated: NonNullable<SessionVelocity["sessionDated"]> = [];
    for (const [id, pending] of [...this.pendingSession].sort((a, b) => a[0] - b[0])) {
      if (clock) { sessionDated.push([clock.day, clock.hour, id, pending]); continue; }
      const target = this.undated.get(id) ?? zeroVelocity();
      for (let index = 0; index < target.length; index += 1) target[index]! += pending[index]!;
      this.undated.set(id, target);
    }
    this.pendingSession.clear();
    return {
      dimensions: this.dimensions,
      buckets: [...this.buckets.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]),
      undated: [...this.undated].sort((a, b) => a[0] - b[0]),
      // Additive: sessions whose counters all carry their own time never have the field.
      ...(sessionDated.length ? { sessionDated } : {}),
    };
  }
}
