import type { ClaudeUsageObservation } from "../providers/claude-ownership.ts";
import type { ConductorMessage } from "../providers/conductor-messages.ts";
import type { ConductorRowRecords, Receipt } from "../providers/conductor.ts";
import { modelName, name } from "../providers/common.ts";
import { projectModelId } from "../public/model-id.js";
import { IndexParityError } from "./parity.ts";

/** The complete disk allowlist for cached provider evidence: keyed identifier hashes,
 * counters, enums, timestamps and bounded public names. Anything else fails closed. */

const fail = (): never => { throw new IndexParityError(); };
const KEY = /^[0-9a-f]{32}$/;
const key = (value: unknown): string => typeof value === "string" && KEY.test(value) ? value : fail();
const nullableKey = (value: unknown): string | null => value === null ? null : key(value);
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : fail();
const nullableNumber = (value: unknown): number | null => value === null ? null : number(value);
const boolean = (value: unknown): boolean => typeof value === "boolean" ? value : fail();
const oneOf = <T>(values: readonly T[], value: unknown): T => values.includes(value as T) ? value as T : fail();
// Normalized UTC instants only; no free text fits this alphabet and length.
const time = (value: unknown): string => typeof value === "string" && /^[0-9TZ:.+-]{0,40}$/.test(value) ? value : fail();
const nullableTime = (value: unknown): string | null => value === null ? null : time(value);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail();

const tokenKeys = ["inputTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteInputTokens", "cacheWrite5mInputTokens",
  "cacheWrite1hInputTokens", "outputTokens", "reasoningOutputTokens", "nonReasoningOutputTokens"];
const costKeys = ["cachedInputUsd", "cacheWriteUsd", "inputUsd", "outputUsd", "totalUsd", "upperEstimateUsd"];
/** Copy only known fields, in their stored order, so replay sees the parser's own key order. */
function fields<T>(value: unknown, allowed: Record<string, (item: unknown) => unknown>, optional: string[] = []): T {
  const entries: Array<[string, unknown]> = [];
  for (const [field, item] of Object.entries(object(value))) entries.push([field, Object.hasOwn(allowed, field) ? allowed[field]!(item) : fail()]);
  const present = new Set(entries.map(([field]) => field));
  for (const field of Object.keys(allowed)) if (!present.has(field) && !optional.includes(field)) fail();
  return Object.fromEntries(entries) as T;
}
const tokenFields = Object.fromEntries(tokenKeys.map((field) => [field, number]));
const tokens = (value: unknown) => fields<Receipt["usage"]>(value, tokenFields);
const modelFields = {
  ...tokenFields, ...Object.fromEntries(costKeys.map((field) => [field, number])), calls: number, priced: boolean,
  model: (item: unknown) => typeof item === "string" && modelName(item) === item ? item : fail(),
};
const model = (value: unknown) => fields<Receipt["models"][number]>(value, modelFields);
const reasons = ["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries", "completed", "cancelled", "interrupted", "unknown"] as const;

const receiptFields: Record<string, (item: unknown) => unknown> = {
  id: key, providerId: nullableKey, at: time, epoch: nullableKey, version: (item) => oneOf(["old", "restored", null], item),
  cost: nullableNumber, marginalCost: nullableNumber, usage: tokens, usageObserved: boolean,
  localUsage: (item) => item === null ? null : tokens(item), models: (item) => array(item).map(model),
  turns: nullableNumber, duration: nullableNumber, apiDuration: nullableNumber, denials: nullableNumber,
  error: boolean, reason: (item) => oneOf(reasons, item),
};
const receipt = (value: unknown) => fields<Receipt>(value, receiptFields);
const toolFields = { id: key, name: (value: unknown) => name(value) === value || value === "unknown_tool" ? value : fail() };
const messageFields: Record<string, (item: unknown) => unknown> = {
  queryId: key, id: key, recordId: key, inputKey: key, statisticsTokens: number, providerId: nullableKey, identityKnown: boolean,
  at: nullableTime, model: (item) => typeof item === "string" && projectModelId(item) === item ? item : fail(),
  usage: tokens, usageObserved: boolean, reasoningExposed: boolean, cacheRead: boolean, cacheWrite: boolean,
  executionKind: (item) => oneOf(["top-level", "subagent"], item),
  tools: (item) => array(item).map((tool) => fields(tool, toolFields)),
};
const message = (value: unknown) => fields<ConductorMessage>(value, messageFields, ["queryId"]);

export function projectConductorRecords(value: unknown): ConductorRowRecords {
  return fields<ConductorRowRecords>(value, {
    receipts: (item) => array(item).map(receipt),
    messages: (item) => array(item).map(message),
    resets: (item) => array(item).map((pair) => { const [before, after, ...rest] = array(pair); return rest.length ? fail() : [key(before), key(after)]; }),
  });
}

export function projectOwnershipObservations(value: unknown): ClaudeUsageObservation[] {
  return array(value).map((item) => {
    const [id, output, total, reasoning, ttl, input, cached, writes, ...rest] = array(item);
    if (rest.length) fail();
    return [key(id), number(output), number(total), nullableNumber(reasoning), number(ttl), number(input), number(cached), number(writes)];
  });
}
