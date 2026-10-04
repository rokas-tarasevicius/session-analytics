import type { TokenUsage } from "../types.ts";
import { finite, record, type RecordValue } from "./common.ts";

/** Shared by native transcripts and the SDK recovery path. Cache reads/writes are disjoint input. */
export function claudeUsage(raw: RecordValue): TokenUsage {
  const input = finite(raw["input_tokens"]) ?? 0, read = finite(raw["cache_read_input_tokens"]) ?? 0;
  const output = finite(raw["output_tokens"]) ?? 0;
  const thinking = Math.min(output, finite(record(raw["output_tokens_details"])?.["thinking_tokens"]) ?? 0);
  const ttl = record(raw["cache_creation"]);
  const five = finite(ttl?.["ephemeral_5m_input_tokens"]) ?? 0, hour = finite(ttl?.["ephemeral_1h_input_tokens"]) ?? 0;
  const write = Math.max(finite(raw["cache_creation_input_tokens"]) ?? 0, five + hour);
  return { inputTokens: input + read + write, uncachedInputTokens: input, cachedInputTokens: read,
    cacheWriteInputTokens: write, cacheWrite5mInputTokens: five, cacheWrite1hInputTokens: hour,
    outputTokens: output, reasoningOutputTokens: thinking, nonReasoningOutputTokens: finite(record(raw["output_tokens_details"])?.["thinking_tokens"]) !== null ? output - thinking : 0 };
}
export function replacesClaudeUsage(previous: { usage: TokenUsage; reasoningExposed: boolean } | undefined, next: { usage: TokenUsage; reasoningExposed: boolean }): boolean {
  return !previous || next.usage.outputTokens > previous.usage.outputTokens ||
    (next.usage.outputTokens === previous.usage.outputTokens && next.usage.inputTokens + next.usage.outputTokens > 0 &&
      (previous.usage.inputTokens + previous.usage.outputTokens === 0 || next.reasoningExposed && !previous.reasoningExposed));
}
