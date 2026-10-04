import { claudeUsage, replacesClaudeUsage } from "./claude-usage.ts";
import { HistoryStatisticsCollector } from "../metrics/history-statistics.ts";
import { stat } from "node:fs/promises";
import { desktopIdentityMatches } from "./claude-desktop.ts";
import { desktopSupplements } from "./claude-desktop-audit.ts";
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
import { claudeEntrypoint, claudeSubagentType, counterExposed, velocityDimension, zeroVelocity } from "../metrics/velocity.ts";
import type { AgentIdentity, ClaudeSubagentType, VelocityDimension } from "../types.ts";
import { resolveRate, type PricingCatalog } from "../pricing/catalog.ts";
import { priceUsage } from "../pricing/usage.ts";
import { projectModelId } from "../public/model-id.js";
import type { MutableSession } from "../analyzer.ts";
import type { SessionAnalytics, SessionDatabaseRow, TokenUsage } from "../types.ts";
import type { ProviderAdapter, ProviderEnvironment } from "./adapter.ts";
import { record as asRecord, text as stringValue, finite, modelName, name as safeName, effortName, safeTime, zeroTokens, sum as sumTokens, type RecordValue as JsonRecord } from "./common.ts";

export interface ClaudeCandidate {
  cwd: string; id: string; path: string; provider: "claude" | "codex"; timestamp: string | null;
}
interface ClaudeContext { mainPaths?: string[]; usageOwners?: ReadonlyMap<string, string>; row: SessionDatabaseRow; rateCard: PricingCatalog; warnings: string[]; reliabilityContext: ReliabilityContext; limits?: LimitsCollector; outcomeEnricher: OutcomeEnricher; workflowSources?: WorkflowSources; contentRules: boolean }
interface ClaudeRuntime {
  discoverRoots(environment: ProviderEnvironment): Promise<string[]>;
  identify(root: string): Promise<ClaudeCandidate[]>;
  createMutableSession(): MutableSession;
  updateWorkflow(state: MutableSession, update: (collector: WorkflowCollector) => void): void;
  walkJsonl(path: string): AsyncGenerator<string>;
  visitJsonLines(path: string, visitor: (record: JsonRecord, line: number) => void): Promise<void>;
  trackTimestamp(session: MutableSession, timestamp: string | null): void;
  addModelUsage(session: MutableSession, rateCard: PricingCatalog, model: string, usage: TokenUsage, input: number, timestamp: string | null, fallback: string, executionKind: SessionAnalytics["executionKind"], velocityContext?: { dimension: VelocityDimension; reasoning: boolean; cacheRead: boolean; cacheWrite: boolean }, requestEvidence?: RequestEvidence, requestSizeKnown?: boolean, calls?: number): void;
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
  // Iterations replace top-level usage: fallback reports only the returned
  // attempt; compaction/advisor usage is omitted from the executor totals.
  // Retain normalized numeric counters only, never raw attempt records.
  function billableIterations(raw: JsonRecord | null, model: string): {
    attempts: Array<{ model: string; usage: TokenUsage; reasoningExposed: boolean; advisor: boolean; explicitTtl: boolean }>;
    incomplete: boolean; count: number; outputTokens: number; quality: number; thinkingResidual: number;
    ttlResidual: { fiveMinute: number; oneHour: number } | null;
  } | null {
    const values = raw?.["iterations"];
    if (!Array.isArray(values) || !values.length ||
        (values.length === 1 && asRecord(values[0])?.["type"] === "message")) return null;
    const rows = values.map(asRecord);
    const fallback = rows.some((row) => row?.["type"] === "fallback_message");
    const lastFallback = rows.findLastIndex((row) => row?.["type"] === "fallback_message");
    const messageCount = rows.filter((row) => row?.["type"] === "message").length;
    let incomplete = false;
    const attempts = rows.flatMap((row, index) => {
      const type = row?.["type"];
      if (!row || !["message", "fallback_message", "compaction", "advisor_message"].includes(String(type)) ||
          !["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]
            .every((key) => counterExposed(row[key]))) {
        incomplete = true; return [];
      }
      // Before-output fallback refusals have date/category-dependent billing.
      // Their token counters alone do not establish a billable charge.
      if (fallback && (type === "message" || type === "fallback_message") && row["output_tokens"] === 0) {
        incomplete = true; return [];
      }
      const inferModel = (!fallback && type !== "advisor_message") ||
        (type === "fallback_message" && index === lastFallback);
      const iterationModel = projectModelId(row["model"] ?? (inferModel ? model : undefined));
      if (iterationModel === "<unknown>") incomplete = true;
      const returned = row["output_tokens"] === raw?.["output_tokens"] && iterationModel === model &&
        ((!fallback && type === "message" && messageCount === 1) || (type === "fallback_message" && index === lastFallback));
      const details = asRecord(row["output_tokens_details"]) ?? (returned ? asRecord(raw?.["output_tokens_details"]) : null);
      const usage = claudeUsage({ ...row, output_tokens_details: details });
      const ttl = asRecord(row["cache_creation"]);
      const ttlExposed = ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]
        .some((key) => counterExposed(ttl?.[key]));
      return [{ model: iterationModel, advisor: type === "advisor_message", usage,
        explicitTtl: ttlExposed && (usage.cacheWriteInputTokens === 0 ||
          usage.cacheWrite5mInputTokens + usage.cacheWrite1hInputTokens > 0),
        reasoningExposed: counterExposed(details?.["thinking_tokens"]) }];
    });
    // A plain tool loop can report thinking only for the aggregate executor.
    // Preserve that group total after pricing; do not invent an iteration split.
    let thinkingResidual = 0;
    const reportedThinking = asRecord(raw?.["output_tokens_details"])?.["thinking_tokens"];
    if (!incomplete && rows.every((row) => row?.["type"] === "message") &&
        attempts.every((attempt) => attempt.model === model) && counterExposed(reportedThinking) &&
        attempts.reduce((sum, attempt) => sum + attempt.usage.outputTokens, 0) === raw?.["output_tokens"]) {
      const knownThinking = attempts.reduce((sum, attempt) => sum + attempt.usage.reasoningOutputTokens, 0);
      const unknownOutput = attempts.filter((attempt) => !attempt.reasoningExposed)
        .reduce((sum, attempt) => sum + attempt.usage.outputTokens, 0);
      const residual = Math.min(Number(reportedThinking), Number(raw?.["output_tokens"])) - knownThinking;
      if (residual >= 0 && residual <= unknownOutput) thinkingResidual = residual;
    }
    let ttlResidual: { fiveMinute: number; oneHour: number } | null = null;
    const topTtl = asRecord(raw?.["cache_creation"]);
    if (!incomplete && rows.every((row) => row?.["type"] === "message") &&
        attempts.every((attempt) => attempt.model === model) &&
        counterExposed(topTtl?.["ephemeral_5m_input_tokens"]) && counterExposed(topTtl?.["ephemeral_1h_input_tokens"]) &&
        attempts.reduce((sum, attempt) => sum + attempt.usage.cacheWriteInputTokens, 0) === raw?.["cache_creation_input_tokens"]) {
      const fiveMinute = Number(topTtl?.["ephemeral_5m_input_tokens"]) -
        attempts.reduce((sum, attempt) => sum + attempt.usage.cacheWrite5mInputTokens, 0);
      const oneHour = Number(topTtl?.["ephemeral_1h_input_tokens"]) -
        attempts.reduce((sum, attempt) => sum + attempt.usage.cacheWrite1hInputTokens, 0);
      const unknown = attempts.reduce((sum, attempt) => sum + attempt.usage.cacheWriteInputTokens -
        attempt.usage.cacheWrite5mInputTokens - attempt.usage.cacheWrite1hInputTokens, 0);
      if (fiveMinute >= 0 && oneHour >= 0 && fiveMinute + oneHour > 0 && fiveMinute + oneHour <= unknown) {
        ttlResidual = { fiveMinute, oneHour };
      }
    }
    return { attempts, incomplete, count: rows.length, thinkingResidual, ttlResidual,
      quality: attempts.length * 10 + attempts.reduce((sum, attempt) => sum +
        Number(attempt.model !== "<unknown>") + Number(attempt.reasoningExposed) + Number(attempt.explicitTtl), 0),
      outputTokens: rows.reduce((sum, row) => sum + nonNegativeNumberValue(row?.["output_tokens"]), 0) };
  }

  function contentBlocks(message: JsonRecord | null): unknown[] {
    const content = message?.["content"];
    return Array.isArray(content) ? content : [];
  }

  async function claudeEvidencePaths(mainPath: string, warnings: string[] = [], visitedRoots = new Set<string>()): Promise<string[]> {
    const subagentRoot = mainPath.includes("/subagents/") ? mainPath.slice(0, mainPath.indexOf("/subagents/") + "/subagents".length) : mainPath.replace(/\.(?:jsonl|json)$/i, "") + "/subagents";
    const paths = [mainPath];
    if (visitedRoots.has(subagentRoot)) return paths;
    visitedRoots.add(subagentRoot);
    try {
      for await (const path of walkJsonl(subagentRoot)) paths.push(path);
    } catch (error) {
      const code = asRecord(error)?.["code"];
      if (code !== "ENOENT") warnings.push("Some child transcript evidence could not be read.");
    }
    return [...new Set(paths)];
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
    usageOwners?: ReadonlyMap<string, string>,
    mainPaths: string[] = [mainPath],
  ): Promise<SessionAnalytics> {
    const state = createMutableSession();
    if (await desktopIdentityMatches(mainPath, row.provider_session_id)) state.agentIdentity.claudeEntrypoint = "desktop";
    const historyStatistics = new HistoryStatisticsCollector();
    state.workflow = new WorkflowCollector("claude", contentRules, await historyForTranscript(mainPath, workflowSources, row.root_path));
    const outcomes = new OutcomeCollector(row);
    state.limitsProvider = "claude";
    state.limitsCache.profileKey = limits?.profileKey(mainPath) ?? null;
    const sessionLimits = limits?.fork();
    state.effort = null;
    const orphan = mainPath.includes("/subagents/");
    state.executionKind = orphan ? "subagent" : "top-level";
    state.executionKindsSeen.add(state.executionKind);
    if (orphan) state.warnings.push("Primary transcript is unavailable; surviving child evidence is partial.");
    state.warnings.push(...inheritedWarnings);
    const primaryPaths = new Set(mainPaths.filter(path => !path.includes("/subagents/")));
    // Discovery also supplies child files for orphan recovery. Enumerate their
    // shared child root once; one directory walk per child retained N² paths.
    const evidencePaths = new Set<string>(), visitedRoots = new Set<string>();
    for (const path of mainPaths) for (const evidence of await claudeEvidencePaths(path, state.warnings, visitedRoots)) evidencePaths.add(evidence);
    const paths = [...evidencePaths];
    let changed = false;
    let activeEvidence = false, unknownLiveness = false;
    // Claude Code writes one record per streamed content block. Every record of
    // a message repeats the same input and cache counters while output grows, so
    // only the final snapshot - the one with the most output - is the message's
    // usage. Pricing the first snapshot undercounts output and reasoning.
    const assistantUsage = new Map<string, {
      billing: ReturnType<typeof billableIterations>;
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
        primaryPaths.has(path) ? "top-level" : "subagent";
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
        if (!orphan && path === mainPath) updateWorkflow(state, (workflow) => workflow.observe(record, line));
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
          const usageRecord = record["isApiErrorMessage"] === true || message["model"] === "<synthetic>" ? null : asRecord(message["usage"]);
          if (path !== mainPath || !record["isSidechain"]) historyStatistics.add(timestamp, message["model"], usageRecord);
          const usage = usageRecord ? claudeUsage(usageRecord) : zeroTokens();
          if (usage.cacheWriteInputTokens > nonNegativeNumberValue(usageRecord?.["cache_creation_input_tokens"])) state.warnings.push("Cache-write totals were reconciled from the recorded TTL breakdown.");
          const dimension = velocityDimension("claude", identity, executionKind, projectModelId(Object.hasOwn(message, "model") ? message["model"] : row.database_model), fileEffort);
          if (executionKind === "top-level") state.startDimension ??= dimension;
          const ttlCounters = ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"].map((key) => {
            const value = asRecord(usageRecord?.["cache_creation"])?.[key];
            return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
          });
          const snapshot = {
            billing: billableIterations(usageRecord, projectModelId(Object.hasOwn(message, "model") ? message["model"] : row.database_model)),
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
          // Usage and timestamp evidence improve independently. A replay may
          // expose an earlier/previously missing request time without increasing
          // output, so reconcile the time even when this snapshot will not win.
          if (previous && previous.executionKind === executionKind && tokenCount(usage) > 0 && timestamp &&
              (!previous.timestamp || timestamp < previous.timestamp)) previous.timestamp = timestamp;
          if (!previous) state.assistantMessages += 1;
          // Equal-output snapshots can expose different subsets of the same
          // request. Preserve known detail when a later snapshot adds another
          // breakdown, provided its physical input classes still agree.
          const sameCounters = previous && usage.outputTokens === previous.usage.outputTokens &&
            usage.uncachedInputTokens === previous.usage.uncachedInputTokens &&
            usage.cachedInputTokens === previous.usage.cachedInputTokens &&
            usage.cacheWriteInputTokens === previous.usage.cacheWriteInputTokens;
          if (sameCounters) {
            if (previous.reasoningExposed && (!snapshot.reasoningExposed ||
                previous.usage.reasoningOutputTokens > usage.reasoningOutputTokens)) {
              usage.reasoningOutputTokens = previous.usage.reasoningOutputTokens;
              usage.nonReasoningOutputTokens = previous.usage.nonReasoningOutputTokens;
              snapshot.reasoningExposed = true;
            }
            if (previous.usage.cacheWrite5mInputTokens + previous.usage.cacheWrite1hInputTokens >
                usage.cacheWrite5mInputTokens + usage.cacheWrite1hInputTokens) {
              usage.cacheWrite5mInputTokens = previous.usage.cacheWrite5mInputTokens;
              usage.cacheWrite1hInputTokens = previous.usage.cacheWrite1hInputTokens;
              snapshot.explicitTtl = previous.explicitTtl;
            }
          }
          const richerBreakdown = sameCounters && (
            usage.reasoningOutputTokens > previous.usage.reasoningOutputTokens ||
            usage.cacheWrite5mInputTokens + usage.cacheWrite1hInputTokens >
              previous.usage.cacheWrite5mInputTokens + previous.usage.cacheWrite1hInputTokens);
          // Keep the snapshot with the most output. On a tie, an earlier snapshot
          // keeps ownership unless it carried no usage or lacked the thinking
          // breakdown that the later one reports.
          const billing = snapshot.billing;
          const count = billing?.count ?? 0, previousCount = previous?.billing?.count ?? 0;
          const output = billing?.outputTokens ?? usage.outputTokens;
          const previousOutput = previous?.billing?.outputTokens ?? previous?.usage.outputTokens ?? 0;
          const replaces = !previous || count > previousCount || (count === previousCount && (
            output > previousOutput || (output === previousOutput && (
              (previous.billing?.incomplete === true && billing?.incomplete === false) ||
              (billing?.incomplete === previous.billing?.incomplete && (billing?.quality ?? 0) > (previous.billing?.quality ?? 0)) ||
              replacesClaudeUsage(previous, snapshot) || Boolean(richerBreakdown)))));
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
            if (!orphan && path === mainPath) updateWorkflow(state, (workflow) => workflow.tool(timestamp));
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
    const ownedUsage = [...assistantUsage].filter(([id]) => !usageOwners?.has(id) || usageOwners.get(id) === mainPath).map(([, value]) => value);
    let reasoningMissing = false;
    const incompleteBilling = ownedUsage.some((snapshot) => snapshot.billing?.incomplete);
    if (incompleteBilling) state.warnings.push("Iteration billing is incomplete; uncertain attempts were omitted or left unpriced.");
    if (ownedUsage.some((snapshot) => snapshot.billing?.ttlResidual)) {
      state.warnings.push("Aggregate cache-write TTL totals are known, but their allocation across iterations is unavailable; pricing remains estimated.");
    }
    const billedRequests = ownedUsage.flatMap((snapshot) => snapshot.billing?.attempts.map((attempt) => ({
      ...snapshot, ...attempt, dimension: { ...snapshot.dimension, model: attempt.model },
      requestSizeKnown: true, cacheRead: true, cacheWrite: true,
      stream: attempt.advisor ? `${snapshot.stream}:advisor:${attempt.model}` : snapshot.stream,
      evidence: { ...snapshot.evidence, requestInputKnown: true, reportedReason: null,
        stream: attempt.advisor ? `${snapshot.stream}:advisor:${attempt.model}` : snapshot.stream,
        ttlMinutes: attempt.usage.cacheWrite1hInputTokens > 0 ? 60 : attempt.usage.cacheWrite5mInputTokens > 0 ? 5 : null },
    })) ?? [snapshot]);
    for (const { billing, evidence, requestSizeKnown, dimension, cacheRead, cacheWrite, executionKind, model, reasoningExposed, timestamp, usage } of billedRequests.sort((a, b) => (a.timestamp ?? "\uffff").localeCompare(b.timestamp ?? "\uffff"))) {
      if (tokenCount(usage) === 0) continue;
      if (usage.outputTokens > 0 && !reasoningExposed) reasoningMissing = true;
      sumTokens(totals, usage);
      addModelUsage(state, rateCard, model, usage, usage.inputTokens, timestamp, row.updated_at, executionKind, { dimension, reasoning: reasoningExposed, cacheRead, cacheWrite }, evidence, requestSizeKnown);
      if (billing?.ttlResidual) {
        const unknown = usage.cacheWriteInputTokens - usage.cacheWrite5mInputTokens - usage.cacheWrite1hInputTokens;
        const selected = unknown > 0 ? resolveRate(rateCard, model, timestamp) : undefined;
        if (selected) {
          // Bound the newly split rows without assigning aggregate TTL to a request.
          const possible = { ...usage, cacheWrite1hInputTokens: usage.cacheWrite1hInputTokens + unknown };
          const ordinary = priceUsage(selected.rate, usage, usage.inputTokens).cost.upperEstimateUsd;
          const upper = priceUsage(selected.rate, possible, usage.inputTokens).cost.upperEstimateUsd;
          state.models.get(model)!.upperEstimateUsd += Math.max(0, upper - ordinary);
        }
      }
    }
    for (const snapshot of ownedUsage) {
      const residual = snapshot.billing?.thinkingResidual ?? 0, ttl = snapshot.billing?.ttlResidual;
      if (!residual && !ttl) continue;
      const aggregate = state.models.get(snapshot.model);
      if (!aggregate) continue;
      if (residual) {
        totals.reasoningOutputTokens += residual;
        aggregate.reasoningOutputTokens += residual;
        const classified = snapshot.billing!.attempts.reduce((sum, attempt) => sum + attempt.usage.reasoningOutputTokens + attempt.usage.nonReasoningOutputTokens, 0);
        const groupOutput = snapshot.billing!.attempts.reduce((sum, attempt) => sum + attempt.usage.outputTokens, 0);
        const knownNonReasoning = groupOutput - classified - residual;
        totals.nonReasoningOutputTokens += knownNonReasoning;
        aggregate.nonReasoningOutputTokens += knownNonReasoning;
        const values = zeroVelocity(); values[6] = residual;
        // Aggregate reasoning is known, but per-iteration coverage remains unknown.
        state.velocity.add(snapshot.timestamp, snapshot.dimension, values);
      }
      if (ttl) {
        for (const target of [totals, aggregate]) {
          target.cacheWrite5mInputTokens += ttl.fiveMinute;
          target.cacheWrite1hInputTokens += ttl.oneHour;
        }
      }
    }
    const supplements = await desktopSupplements(mainPath, row.provider_session_id, assistantUsage);
    for (const supplement of supplements) {
      sumTokens(totals, supplement.usage);
      state.executionKindsSeen.add(supplement.executionKind);
      addModelUsage(state, rateCard, supplement.model, supplement.usage, 0, supplement.timestamp, row.updated_at,
        supplement.executionKind, { dimension: velocityDimension("claude", state.agentIdentity, supplement.executionKind, supplement.model, state.effort), reasoning: false, cacheRead: true, cacheWrite: true }, undefined, false, 0);
    }
    if (supplements.length) state.warnings.push("Aggregate usage has no per-request context sizes; the upper estimate applies the long-context premium to all usage.");
    if (reasoningMissing) {
      state.warnings.push(
        "Some Claude responses do not expose thinking tokens separately; they remain included in output.",
      );
    }
    if (primaryParseErrors > 0) state.warnings.push(`${primaryParseErrors} malformed JSONL records were skipped in the primary transcript.`);
    if (parseErrors > primaryParseErrors) state.warnings.push(`${parseErrors - primaryParseErrors} malformed JSONL records were skipped in child transcripts.`);
    state.outcomes = await outcomes.finish(outcomeEnricher, state.firstEventAt, state.lastEventAt);
    state.completeness = orphan || state.warnings.includes("Some child transcript evidence could not be read.") || parseErrors || changed ? "partial" : "complete";
    state.liveness = activeEvidence ? "active" : unknownLiveness ? "unknown" : "inactive";
    const result = finalizeSession(row, state, totals, paths.length);
    if (incompleteBilling) { result.costComplete = false; result.transcript.completeness = "partial"; }
    result.historyStatistics = historyStatistics.finish();
    if (result.limitsCache && sessionLimits) result.limitsCache.quotaEvidence = sessionLimits.evidence();
    result.insightSignals!.cacheGaps = cacheGapSignals(billedRequests, rateCard);
    result.reliability = combineReliability(reliabilityStreams, row.status === "working");
    return result;
  }

  return {
    id: "claude", provider: "claude",
    discoverRoots: runtime.discoverRoots,
    async *identify(root) { yield* await runtime.identify(root); },
    analyze(candidate, context) { return analyzeClaude(context.row, candidate.path, context.rateCard, context.warnings, context.reliabilityContext, context.limits, context.outcomeEnricher, context.workflowSources, context.contentRules, context.usageOwners, context.mainPaths); },
  };
}
