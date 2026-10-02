import type { MutableSession } from "../analyzer.ts";
import type { RateCard, SessionAnalytics, SessionDatabaseRow, TokenUsage } from "../types.ts";
import type { ProviderAdapter, ProviderEnvironment } from "./adapter.ts";
import { record as asRecord, text as stringValue, finite, zeroTokens, sum as sumTokens, type RecordValue as JsonRecord } from "./common.ts";

export interface ClaudeCandidate {
  cwd: string; id: string; path: string; provider: "claude" | "codex"; timestamp: string | null;
}
interface ClaudeContext { row: SessionDatabaseRow; rateCard: RateCard; warnings: string[] }
interface ClaudeRuntime {
  discoverRoots(environment: ProviderEnvironment): Promise<string[]>;
  identify(root: string): Promise<ClaudeCandidate[]>;
  createMutableSession(): MutableSession;
  walkJsonl(path: string): AsyncGenerator<string>;
  visitJsonLines(path: string, visitor: (record: JsonRecord, line: number) => void): Promise<void>;
  trackTimestamp(session: MutableSession, timestamp: string | null): void;
  addModelUsage(session: MutableSession, rateCard: RateCard, model: string, usage: TokenUsage, input: number, timestamp: string | null, fallback: string, executionKind: SessionAnalytics["executionKind"]): void;
  finalizeSession(row: SessionDatabaseRow, state: MutableSession, tokens: TokenUsage, files: number): SessionAnalytics;
}
const nonNegativeNumberValue = (value: unknown): number => finite(value) ?? 0;
const tokenCount = (usage: TokenUsage): number => usage.inputTokens + usage.outputTokens;
function increment(target: Record<string, number>, key: string, amount = 1): void { target[key] = (target[key] ?? 0) + amount; }
function normalizedSkillName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name) ? name : null;
}

/** Existing Claude parser, moved without changing its projection or accounting. */
export function createClaudeAdapter(runtime: ClaudeRuntime): ProviderAdapter<ClaudeCandidate, ClaudeContext> {
  const { createMutableSession, walkJsonl, visitJsonLines, trackTimestamp, addModelUsage, finalizeSession } = runtime;
  function claudeUsage(raw: JsonRecord): TokenUsage {
    const input = nonNegativeNumberValue(raw["input_tokens"]);
    const cacheRead = nonNegativeNumberValue(raw["cache_read_input_tokens"]);
    const cacheWrite = nonNegativeNumberValue(raw["cache_creation_input_tokens"]);
    const output = nonNegativeNumberValue(raw["output_tokens"]);
    const thinking = Math.min(
      output,
      nonNegativeNumberValue(asRecord(raw["output_tokens_details"])?.["thinking_tokens"]),
    );
    const cacheCreation = asRecord(raw["cache_creation"]);
    let cacheWrite5m = nonNegativeNumberValue(cacheCreation?.["ephemeral_5m_input_tokens"]);
    const cacheWrite1h = nonNegativeNumberValue(cacheCreation?.["ephemeral_1h_input_tokens"]);
    if (cacheWrite > 0 && cacheWrite5m + cacheWrite1h === 0) cacheWrite5m = cacheWrite;
    return {
      cacheWrite1hInputTokens: cacheWrite1h,
      cacheWrite5mInputTokens: cacheWrite5m,
      cacheWriteInputTokens: cacheWrite,
      cachedInputTokens: cacheRead,
      inputTokens: input + cacheRead + cacheWrite,
      nonReasoningOutputTokens: output - thinking,
      outputTokens: output,
      reasoningOutputTokens: thinking,
      uncachedInputTokens: input,
    };
  }

  function contentBlocks(message: JsonRecord | null): unknown[] {
    const content = message?.["content"];
    return Array.isArray(content) ? content : [];
  }

  async function claudeEvidencePaths(mainPath: string): Promise<string[]> {
    const subagentRoot = mainPath.slice(0, -".jsonl".length) + "/subagents";
    const paths = [mainPath];
    try {
      for await (const path of walkJsonl(subagentRoot)) paths.push(path);
    } catch (error) {
      const code = asRecord(error)?.["code"];
      if (code !== "ENOENT") throw error;
    }
    return paths;
  }

  async function analyzeClaude(
    row: SessionDatabaseRow,
    mainPath: string,
    rateCard: RateCard,
    inheritedWarnings: string[],
  ): Promise<SessionAnalytics> {
    const state = createMutableSession();
    state.effort = null;
    state.executionKind = "top-level";
    state.executionKindsSeen.add("top-level");
    state.warnings.push(...inheritedWarnings);
    const paths = await claudeEvidencePaths(mainPath);
    // Claude Code writes one record per streamed content block. Every record of
    // a message repeats the same input and cache counters while output grows, so
    // only the final snapshot - the one with the most output - is the message's
    // usage. Pricing the first snapshot undercounts output and reasoning.
    const assistantUsage = new Map<string, {
      executionKind: SessionAnalytics["executionKind"];
      model: string;
      reasoningExposed: boolean;
      timestamp: string | null;
      usage: TokenUsage;
    }>();
    // Subagent files are read after the whole main transcript, so file order is
    // not chronology. The session's effort is the latest top-level value, and a
    // subagent's effort only when the main transcript never records one.
    const effort: {
      current: { executionKind: SessionAnalytics["executionKind"]; timestamp: string; value: string } | null;
    } = { current: null };
    const seenHumanMessages = new Set<string>();
    const seenToolCalls = new Set<string>();
    let parseErrors = 0;
    const totals = zeroTokens();

    for (const path of paths) {
      const executionKind: SessionAnalytics["executionKind"] =
        path === mainPath ? "top-level" : "subagent";
      state.executionKindsSeen.add(executionKind);
      await visitJsonLines(path, (record, line) => {
        if (record["__parse_error"] === true) {
          parseErrors += 1;
          return;
        }
        const timestamp = stringValue(record["timestamp"]);
        trackTimestamp(state, timestamp);
        const type = stringValue(record["type"]) ?? "";
        const subtype = stringValue(record["subtype"]) ?? "";
        const agentId = stringValue(record["agentId"]);
        if (agentId) state.delegatedAgents.add(agentId);
        if (type === "queue-operation") state.queueOperations += 1;
        if (type.includes("compact") || subtype.includes("compact")) state.compactions += 1;
        if (type.includes("summary") || subtype.includes("summary")) state.summaries += 1;

        const message = asRecord(record["message"]);
        if (type === "assistant" && message) {
          const messageId =
            stringValue(message["id"]) ?? stringValue(record["uuid"]) ?? `${path}:${line}`;
          const recordedEffort = stringValue(record["effort"]);
          if (recordedEffort) {
            const candidate = { executionKind, timestamp: timestamp ?? "", value: recordedEffort };
            const current = effort.current;
            const outranks =
              !current ||
              (executionKind === "top-level" && current.executionKind !== "top-level") ||
              (executionKind === current.executionKind && candidate.timestamp >= current.timestamp);
            if (outranks) effort.current = candidate;
          }
          const usageRecord = asRecord(message["usage"]);
          const usage = usageRecord ? claudeUsage(usageRecord) : zeroTokens();
          const snapshot = {
            executionKind,
            model: stringValue(message["model"]) ?? row.database_model ?? "<unknown>",
            reasoningExposed: Boolean(asRecord(usageRecord?.["output_tokens_details"])),
            timestamp,
            usage,
          };
          const previous = assistantUsage.get(messageId);
          if (!previous) state.assistantMessages += 1;
          // Keep the snapshot with the most output. On a tie, an earlier snapshot
          // keeps ownership unless it carried no usage or lacked the thinking
          // breakdown that the later one reports.
          const replaces =
            !previous ||
            usage.outputTokens > previous.usage.outputTokens ||
            (usage.outputTokens === previous.usage.outputTokens &&
              tokenCount(usage) > 0 &&
              (tokenCount(previous.usage) === 0 || (snapshot.reasoningExposed && !previous.reasoningExposed)));
          if (replaces) {
            assistantUsage.set(messageId, {
              ...snapshot,
              timestamp: previous?.timestamp ?? timestamp,
            });
          }
          for (const rawBlock of contentBlocks(message)) {
            const block = asRecord(rawBlock);
            if (block?.["type"] !== "tool_use") continue;
            const toolId = stringValue(block["id"]) ?? `${path}:${line}`;
            if (seenToolCalls.has(toolId)) continue;
            seenToolCalls.add(toolId);
            const name = stringValue(block["name"]) ?? "tool_use";
            increment(state.tools, name);
            increment(state.transportTools, name);
            if (name === "Skill") {
              const skill = normalizedSkillName(asRecord(block["input"])?.["skill"]);
              if (skill) increment(state.skills, skill);
            }
          }
        }
        if (type === "user" && message) {
          const messageId = stringValue(record["uuid"]) ?? `${path}:${line}`;
          if (seenHumanMessages.has(messageId)) return;
          const content = message["content"];
          const humanContent =
            (typeof content === "string" && content.length > 0) ||
            contentBlocks(message).some((rawBlock) => asRecord(rawBlock)?.["type"] === "text");
          if (humanContent) {
            seenHumanMessages.add(messageId);
            state.userTurns += 1;
          }
        }
      });
    }
    state.effort = effort.current?.value ?? null;
    let reasoningMissing = false;
    for (const { executionKind, model, reasoningExposed, timestamp, usage } of assistantUsage.values()) {
      if (tokenCount(usage) === 0) continue;
      if (usage.outputTokens > 0 && !reasoningExposed) reasoningMissing = true;
      sumTokens(totals, usage);
      addModelUsage(state, rateCard, model, usage, usage.inputTokens, timestamp, row.updated_at, executionKind);
    }
    if (reasoningMissing) {
      state.warnings.push(
        "Some Claude responses do not expose thinking tokens separately; they remain included in output.",
      );
    }
    if (parseErrors > 0) state.warnings.push(`${parseErrors} malformed JSONL records were skipped.`);
    return finalizeSession(row, state, totals, paths.length);
  }

  return {
    id: "claude", provider: "claude",
    discoverRoots: runtime.discoverRoots,
    async *identify(root) { yield* await runtime.identify(root); },
    analyze(candidate, context) { return analyzeClaude(context.row, candidate.path, context.rateCard, context.warnings); },
  };
}
