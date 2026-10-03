import { stat } from "node:fs/promises";
import { cacheGapSignals } from "../insights/cache-gaps.ts";
import { TranscriptLifecycle } from "../insights/transcript-evidence.ts";
import { sameVersion } from "../insights/review-source.ts";
import { canonicalMcpServer } from "../insights/mcp-attribution.ts";
import { WorkflowCollector } from "../metrics/workflow.ts";
import { historyForTranscript, type WorkflowSources } from "../metrics/workflow-inventory.ts";
import { OutcomeCollector } from "../metrics/outcomes.ts";
import { OutcomeEnricher } from "../metrics/outcomes-enrichment.ts";
import { normalizeTimestamp as normalizedTimestamp } from "../public/timestamps.js";
import { claudeRequestEvidence, type RequestEvidence } from "../metrics/cache-context.ts";
import type { LimitsCollector } from "../metrics/limits.ts";
import { ReliabilityCollector } from "../metrics/reliability.ts";
import { combineReliability, observeClaude } from "../metrics/reliability-providers.ts";
import type { ReliabilityContext } from "../metrics/reliability.ts";
import type { SessionReliability } from "../metrics/reliability-types.ts";
import { claudeEntrypoint, claudeSubagentType, counterExposed, velocityDimension } from "../metrics/velocity.ts";
import type { AgentIdentity, ClaudeSubagentType, VelocityDimension } from "../types.ts";
import type { PricingCatalog } from "../pricing/catalog.ts";
import { projectModelId } from "../public/model-id.js";
import type { MutableSession } from "../analyzer.ts";
import type { SessionAnalytics, SessionDatabaseRow, TokenUsage } from "../types.ts";
import type { ProviderAdapter, ProviderEnvironment } from "./adapter.ts";
import { record as asRecord, text as stringValue, finite, modelName, name as safeName, effortName, safeTime, zeroTokens, sum as sumTokens, type RecordValue as JsonRecord } from "./common.ts";

export interface ClaudeCandidate {
  cwd: string; id: string; path: string; provider: "claude" | "codex"; timestamp: string | null;
}
interface ClaudeContext { row: SessionDatabaseRow; rateCard: PricingCatalog; warnings: string[]; reliabilityContext: ReliabilityContext; limits?: LimitsCollector; outcomeEnricher: OutcomeEnricher; workflowSources?: WorkflowSources; contentRules: boolean }
interface ClaudeRuntime {
  discoverRoots(environment: ProviderEnvironment): Promise<string[]>;
  identify(root: string): Promise<ClaudeCandidate[]>;
  createMutableSession(): MutableSession;
  updateWorkflow(state: MutableSession, update: (collector: WorkflowCollector) => void): void;
  walkJsonl(path: string): AsyncGenerator<string>;
  visitJsonLines(path: string, visitor: (record: JsonRecord, line: number) => void): Promise<void>;
  trackTimestamp(session: MutableSession, timestamp: string | null): void;
  addModelUsage(session: MutableSession, rateCard: PricingCatalog, model: string, usage: TokenUsage, input: number, timestamp: string | null, fallback: string, executionKind: SessionAnalytics["executionKind"], velocityContext?: { dimension: VelocityDimension; reasoning: boolean; cacheRead: boolean; cacheWrite: boolean }, requestEvidence?: RequestEvidence, requestSizeKnown?: boolean): void;
  finalizeSession(row: SessionDatabaseRow, state: MutableSession, tokens: TokenUsage, files: number): SessionAnalytics;
}
const nonNegativeNumberValue = (value: unknown): number => finite(value) ?? 0;
const tokenCount = (usage: TokenUsage): number => usage.inputTokens + usage.outputTokens;
function increment(target: Record<string, number>, key: string, amount = 1): void { target[key] = (target[key] ?? 0) + amount; }
function normalizedSkillName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return safeName(name);
}

/** Existing Claude parser, moved without changing its projection or accounting. */
export function createClaudeAdapter(runtime: ClaudeRuntime): ProviderAdapter<ClaudeCandidate, ClaudeContext> {
  const { createMutableSession, walkJsonl, visitJsonLines, trackTimestamp, addModelUsage, finalizeSession, updateWorkflow } = runtime;
  function claudeUsage(raw: JsonRecord): TokenUsage {
    const input = nonNegativeNumberValue(raw["input_tokens"]);
    const cacheRead = nonNegativeNumberValue(raw["cache_read_input_tokens"]);
    let cacheWrite = nonNegativeNumberValue(raw["cache_creation_input_tokens"]);
    const output = nonNegativeNumberValue(raw["output_tokens"]);
    const thinking = Math.min(
      output,
      nonNegativeNumberValue(asRecord(raw["output_tokens_details"])?.["thinking_tokens"]),
    );
    const cacheCreation = asRecord(raw["cache_creation"]);
    const cacheWrite5m = nonNegativeNumberValue(cacheCreation?.["ephemeral_5m_input_tokens"]);
    const cacheWrite1h = nonNegativeNumberValue(cacheCreation?.["ephemeral_1h_input_tokens"]);
    cacheWrite = Math.max(cacheWrite, cacheWrite5m + cacheWrite1h);
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
    rateCard: PricingCatalog,
    inheritedWarnings: string[],
    reliabilityContext: ReliabilityContext,
    limits: LimitsCollector | undefined,
    outcomeEnricher: OutcomeEnricher,
    workflowSources?: WorkflowSources,
    contentRules = false,
  ): Promise<SessionAnalytics> {
    const state = createMutableSession();
    state.workflow = new WorkflowCollector("claude", contentRules, await historyForTranscript(mainPath, workflowSources, row.root_path));
    const outcomes = new OutcomeCollector(row);
    state.limitsProvider = "claude";
    state.limitsCache.profileKey = limits?.profileKey(mainPath) ?? null;
    const sessionLimits = limits?.fork();
    state.effort = null;
    state.executionKind = "top-level";
    state.executionKindsSeen.add("top-level");
    state.warnings.push(...inheritedWarnings);
    const paths = await claudeEvidencePaths(mainPath);
    let changed = false;
    let activeEvidence = false, unknownLiveness = false;
    // Claude Code writes one record per streamed content block. Every record of
    // a message repeats the same input and cache counters while output grows, so
    // only the final snapshot - the one with the most output - is the message's
    // usage. Pricing the first snapshot undercounts output and reasoning.
    const assistantUsage = new Map<string, {
      evidence: RequestEvidence;
      stream: string;
      explicitTtl: boolean;
      requestSizeKnown: boolean;
      dimension: VelocityDimension;
      cacheRead: boolean;
      cacheWrite: boolean;
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
    const subagentTypes = new Set<ClaudeSubagentType>();
    const seenHumanMessages = new Set<string>();
    const seenToolCalls = new Set<string>();
    let parseErrors = 0, primaryParseErrors = 0;
    const totals = zeroTokens();
    const reliabilityStreams: SessionReliability[] = [];

    for (const path of paths) {
      const sourceBefore = await stat(path);
      const lifecycle = new TranscriptLifecycle();
      let streamTurns = 0, streamCompactions = 0;
      const streamBoundaries = new Set<string>();
      const reliability = new ReliabilityCollector(reliabilityContext);
      const executionKind: SessionAnalytics["executionKind"] =
        path === mainPath ? "top-level" : "subagent";
      state.executionKindsSeen.add(executionKind);
      let identity: AgentIdentity = { claudeEntrypoint: state.agentIdentity.claudeEntrypoint ?? "unknown" };
      let fileEffort: string | null = null;
      await visitJsonLines(path, (record, line) => {
        state.mcpEvidence.claude(record, path);
        if (record["__parse_error"] === true) {
          parseErrors += 1;
          if (path === mainPath) { primaryParseErrors += 1; state.workflow?.gap("malformed"); }
          reliability.truncated = true;
          return;
        }
        observeClaude(reliability, record, line, row.workspace_path);
        outcomes.observeClaude(record, path === mainPath ? "main" : path);
        const timestamp = normalizedTimestamp(record["timestamp"]);
        lifecycle.observe("claude", record);
        trackTimestamp(state, timestamp);
        if (path === mainPath) updateWorkflow(state, (workflow) => workflow.observe(record, line));
        if (record["entrypoint"] !== undefined) identity.claudeEntrypoint = claudeEntrypoint(record["entrypoint"]);
        if (record["attributionAgent"] !== undefined) {
          identity.claudeSubagentType = claudeSubagentType(record["attributionAgent"]);
          if (executionKind === "subagent") subagentTypes.add(identity.claudeSubagentType);
        }
        if (executionKind === "top-level") state.agentIdentity = { claudeEntrypoint: identity.claudeEntrypoint ?? "unknown" };
        fileEffort = effortName(record["effort"]) ?? fileEffort;
        const type = stringValue(record["type"]) ?? "";
        const subtype = stringValue(record["subtype"]) ?? "";
        let repeatedBoundary = false;
        sessionLimits?.observe(mainPath, record, row.conductor_session_id);
        if (subtype === "compact_boundary") {
          const identity = stringValue(record["uuid"]) ?? `${line}`;
          repeatedBoundary = streamBoundaries.has(identity);
          if (!streamBoundaries.has(identity)) {
            streamBoundaries.add(identity); streamCompactions++;
            state.limitsCache.addCompaction(path, "boundary", identity, timestamp, executionKind, streamTurns, record["compactMetadata"]);
          }
        } else if (type.includes("compact") || subtype.includes("compact")) {
          // Preserve older markers in the shared summary, even without sizes.
          streamCompactions++;
          state.limitsCache.addCompaction(path, `${type}:${subtype}`, stringValue(record["uuid"]), timestamp, executionKind, streamTurns);
        }
        const agentId = stringValue(record["agentId"]);
        if (agentId) state.delegatedAgents.add(agentId);
        if (type === "queue-operation") state.queueOperations += 1;
        if (!repeatedBoundary && (type.includes("compact") || subtype.includes("compact"))) state.compactions += 1;
        if (type.includes("summary") || subtype.includes("summary")) state.summaries += 1;

        const message = asRecord(record["message"]);
        if (type === "assistant" && message) {
          const messageId =
            stringValue(message["id"]) ?? stringValue(record["uuid"]) ?? `${path}:${line}`;
          const recordedEffort = effortName(record["effort"]);
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
          if (usage.cacheWriteInputTokens > nonNegativeNumberValue(usageRecord?.["cache_creation_input_tokens"])) state.warnings.push("Cache-write totals were reconciled from the recorded TTL breakdown.");
          const dimension = velocityDimension("claude", identity, executionKind, projectModelId(Object.hasOwn(message, "model") ? message["model"] : row.database_model), fileEffort);
          if (executionKind === "top-level") state.startDimension ??= dimension;
          const ttlCounters = ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"].map((key) => {
            const value = asRecord(usageRecord?.["cache_creation"])?.[key];
            return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
          });
          const snapshot = {
            stream: path,
            explicitTtl: ttlCounters.some((value) => value !== null) &&
              (usage.cacheWriteInputTokens === 0 || ttlCounters.some((value) => value !== null && value > 0)),
            requestSizeKnown: typeof usageRecord?.["input_tokens"] === "number" && Number.isFinite(usageRecord["input_tokens"]) && usageRecord["input_tokens"] >= 0,
            evidence: claudeRequestEvidence(record, path, streamCompactions),
            dimension,
            cacheRead: counterExposed(usageRecord?.["cache_read_input_tokens"]),
            cacheWrite: counterExposed(usageRecord?.["cache_creation_input_tokens"]),
            executionKind,
            model: projectModelId(Object.hasOwn(message, "model") ? message["model"] : row.database_model),
            reasoningExposed: counterExposed(asRecord(usageRecord?.["output_tokens_details"])?.["thinking_tokens"]),
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
              evidence: { ...snapshot.evidence, reportedReason: snapshot.evidence.reportedReason ?? previous?.evidence.reportedReason ?? null },
              timestamp: previous && tokenCount(previous.usage) > 0 && previous.executionKind === executionKind ? previous.timestamp ?? timestamp : timestamp,
            });
          }
          if (previous && !previous.evidence.reportedReason && snapshot.evidence.reportedReason) previous.evidence.reportedReason = snapshot.evidence.reportedReason;
          for (const rawBlock of contentBlocks(message)) {
            const block = asRecord(rawBlock);
            if (block?.["type"] !== "tool_use") continue;
            const toolId = stringValue(block["id"]) ?? `${path}:${line}`;
            if (seenToolCalls.has(toolId)) continue;
            seenToolCalls.add(toolId);
            if (path === mainPath) updateWorkflow(state, (workflow) => workflow.tool(timestamp));
            const name = safeName(block["name"]) ?? "unknown_tool";
            increment(state.tools, name);
            increment(state.transportTools, name);
            const server = canonicalMcpServer(record["attributionMcpServer"]);
            if (server) increment(state.mcpServers, server);
            state.velocity.tool(timestamp, dimension);
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
            streamTurns += 1;
          }
        }
      });
      reliabilityStreams.push(reliability.finish());
      const sourceAfter = await stat(path);
      changed ||= !sameVersion(sourceBefore, sourceAfter);
      activeEvidence ||= lifecycle.liveness() === "active";
      unknownLiveness ||= lifecycle.liveness() === "unknown";
    }
    state.effort = effort.current?.value ?? null;
    if (subagentTypes.size) state.agentIdentity.claudeSubagentType = subagentTypes.size > 1 ? "mixed" : [...subagentTypes][0];
    let reasoningMissing = false;
    for (const { evidence, requestSizeKnown, dimension, cacheRead, cacheWrite, executionKind, model, reasoningExposed, timestamp, usage } of [...assistantUsage.values()].sort((a, b) => (a.timestamp ?? "\uffff").localeCompare(b.timestamp ?? "\uffff"))) {
      if (tokenCount(usage) === 0) continue;
      if (usage.outputTokens > 0 && !reasoningExposed) reasoningMissing = true;
      sumTokens(totals, usage);
      addModelUsage(state, rateCard, model, usage, usage.inputTokens, timestamp, row.updated_at, executionKind, { dimension, reasoning: reasoningExposed, cacheRead, cacheWrite }, evidence, requestSizeKnown);
    }
    if (reasoningMissing) {
      state.warnings.push(
        "Some Claude responses do not expose thinking tokens separately; they remain included in output.",
      );
    }
    if (primaryParseErrors > 0) state.warnings.push(`${primaryParseErrors} malformed JSONL records were skipped in the primary transcript.`);
    if (parseErrors > primaryParseErrors) state.warnings.push(`${parseErrors - primaryParseErrors} malformed JSONL records were skipped in child transcripts.`);
    state.outcomes = await outcomes.finish(outcomeEnricher, state.firstEventAt, state.lastEventAt);
    state.completeness = parseErrors || changed ? "partial" : "complete";
    state.liveness = activeEvidence ? "active" : unknownLiveness ? "unknown" : "inactive";
    const result = finalizeSession(row, state, totals, paths.length);
    if (result.limitsCache && sessionLimits) result.limitsCache.quotaEvidence = sessionLimits.evidence();
    result.insightSignals!.cacheGaps = cacheGapSignals(assistantUsage.values(), rateCard);
    result.reliability = combineReliability(reliabilityStreams, row.status === "working");
    return result;
  }

  return {
    id: "claude", provider: "claude",
    discoverRoots: runtime.discoverRoots,
    async *identify(root) { yield* await runtime.identify(root); },
    analyze(candidate, context) { return analyzeClaude(context.row, candidate.path, context.rateCard, context.warnings, context.reliabilityContext, context.limits, context.outcomeEnricher, context.workflowSources, context.contentRules); },
  };
}
