import { historySchemas } from "./history-schema.ts";
/** Explicit public metric field maps; used only to generate the bundled interchange schema. */
import type * as T from "../src/types.ts";
export type Schema = Record<string, unknown>;
export const n: Schema = { type: "number", minimum: 0 };
export const signed: Schema = { type: "number", minimum: -Number.MAX_SAFE_INTEGER };
export const i: Schema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
export const b: Schema = { type: "boolean" };
export const text: Schema = { type: "string" };
export const name: Schema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
export const command: Schema = { type: "string", pattern: "^/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
export const model: Schema = { type: "string", maxLength: 160, pattern: "^(<unknown>|(?:@cf/)?[A-Za-z][A-Za-z0-9._-]*(?:/[A-Za-z][A-Za-z0-9._-]*){0,2})$" };
export const ref = (value: string): Schema => ({ $ref: `#/$defs/${value}` });
export const arr = (items: Schema): Schema => ({ type: "array", items });
export const nil = (value: Schema): Schema => ({ anyOf: [value, { type: "null" }] });
export const en = (...values: (string | number)[]): Schema => ({ anyOf: values.map((value) => ({ const: value })) });
export const fields = <K extends string>(...keys: K[]): Record<K, Schema> => Object.fromEntries(keys.map((key) => [key, i])) as Record<K, Schema>;
export const dict = (values: Schema, keys: Schema = name): Schema => ({ type: "object", additionalProperties: values, propertyNames: keys });
export function obj<T>(properties: { [K in keyof T]-?: Schema }, optional: Array<keyof T> = []): Schema {
  return { type: "object", properties, required: Object.keys(properties).filter((key) => !optional.includes(key as keyof T)), additionalProperties: false };
}
const shape = (properties: Record<string, Schema>): Schema => obj(properties);
const partialCounts = (...keys: string[]): Schema => obj(fields(...keys), keys);
const tuple = (...prefixItems: Schema[]): Schema => ({ type: "array", prefixItems, minItems: prefixItems.length, maxItems: prefixItems.length });
const provider = en("claude", "codex", "cursor", "copilot", "opencode", "gemini", "unsupported");
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const ratio = nil(n);
const day: Schema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const instant: Schema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})?$" };
const repository: Schema = { type: "string", pattern: "^(conductor|discovered)-[a-f0-9]{20}$" };

export function metricSchemas(): Record<string, Schema> {
  return {
    ...historySchemas(),
    McpSourceHealth: obj<T.McpSourceHealth>({ provider, status: en("available", "incomplete", "unavailable", "unknown"), ...fields("sourcesRead", "missingSources", "unreadableSources") }),
    McpContext: obj<T.McpContext>({ repositoryId: nil(repository) }),
    McpSessionEvidence: obj<T.McpSessionEvidence>({ activityState: en("active", "settled", "unknown"), pricingByDay: arr(shape({ day, eligibleTokens: i, pricedTokens: i })), undatedTokens: i }, ["activityState", "pricingByDay", "undatedTokens"]),
    RateProvenance: obj<T.RateProvenance>({ source: en("models.dev", "litellm", "reviewed"), kind: en("api", "reviewed", "fallback"), snapshotDate: { anyOf: [day, instant] }, payloadSha256: hash, rateModel: model, match: en("exact", "alias"), temporal: en("at-or-before", "oldest", "undated"), assumptions: arr(en("anthropic-cache-1h-2x", "codex-cache-write-upper-1.25x", "cache-write-upper-multiplier", "cache-read-at-input", "cache-write-5m-at-input", "cache-write-5m-multiplier", "cache-write-1h-at-5m", "context-cache-read-at-base", "context-cache-write-5m-at-base", "context-cache-write-1h-at-base", "cache-write-ttl-5m")) }),
    PricingSourceStatus: obj<T.PricingSourceStatus>({ source: en("models.dev", "litellm"), url: en("https://models.dev/api.json", "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"), fetchedAt: nil(instant), payloadSha256: nil(hash), ageDays: ratio, stale: b, models: i, rejectedModels: i }),
    PricingStatus: obj<T.PricingStatus>({ offline: b, policy: en("reviewed-first", "api-first", "reviewed-only"), refreshAfterDays: n, newestSnapshotAt: nil(instant), ageDays: ratio, stale: b, snapshots: i, sources: arr(ref("PricingSourceStatus")), warnings: arr(en("cache-unavailable", "invalid-snapshot", "large-price-change", "rejected-models")) }),
    ProviderEvidence: obj<T.ProviderEvidence>({ accounting: en("complete", "partial"), source: en("conductor-result", "conductor-messages", "cursor-sdk", "cursor-transcript", "copilot-events", "opencode-db", "gemini-chat"), fidelity: en("message", "summary", "activity-only"), tokens: en("reported", "unavailable"), tools: en("observed", "unavailable"), turns: en("observed", "unavailable"), timing: en("provider", "file-mtime"), usageUnit: en("request", "run", "session", "unavailable") }, ["accounting"]),
    ConductorResultMetrics: obj<T.ConductorResultMetrics>({ reconciliation: ref("HistoryReconciliation"), turnLocalTokens: nil(ref("TokenUsage")), resultRecords: i, reportedTurns: nil(i), durationMilliseconds: ratio, apiDurationMilliseconds: ratio, permissionDenials: nil(i), errorResults: i, terminalReasons: partialCounts("success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries", "completed", "cancelled", "interrupted", "unknown") }, ["turnLocalTokens", "reconciliation"]),
    AgentIdentity: obj<T.AgentIdentity>({ claudeEntrypoint: en("cli", "sdk", "desktop", "unknown"), claudeSubagentType: en("general-purpose", "explore", "plan", "other", "mixed"), codexSource: en("cli", "exec", "vscode", "subagent", "review", "unknown"), codexOriginator: en("cli", "exec", "vscode", "desktop", "unknown") }, ["claudeEntrypoint", "claudeSubagentType", "codexSource", "codexOriginator"]),
    VelocityMetadata: obj<T.VelocityMetadata>({ version: { const: 1 }, timeZone: { type: "string", pattern: "^[A-Za-z_+-]+(?:/[A-Za-z0-9_+-]+){0,2}$" } }),
    VelocityDimension: obj<T.VelocityDimension>({ agent: en("claude-cli", "claude-sdk", "claude-desktop", "claude-unknown", "claude-general-purpose", "claude-explore", "claude-plan", "claude-subagent", "codex-cli", "codex-exec", "codex-vscode", "codex-desktop", "codex-subagent", "codex-review", "codex-unknown", "cursor", "copilot", "opencode", "gemini"), model, executionKind: en("subagent", "top-level", "unknown"), effort: en("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown") }),
    VelocityValues: tuple(n, ...Array.from({ length: 13 }, () => i)),
    SessionVelocity: obj<T.SessionVelocity>({ dimensions: arr(ref("VelocityDimension")), buckets: arr(tuple(day, i, i, ref("VelocityValues"))), undated: arr(tuple(i, ref("VelocityValues"))), sessionDated: arr(tuple(day, i, i, ref("VelocityValues"))) }, ["sessionDated"]),
  };
}
