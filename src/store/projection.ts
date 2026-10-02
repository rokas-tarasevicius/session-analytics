import type { CostBreakdown, SessionAnalytics, TokenUsage } from "../types.ts";

function tokens(value: TokenUsage): TokenUsage {
  return {
    inputTokens: value.inputTokens, uncachedInputTokens: value.uncachedInputTokens,
    cachedInputTokens: value.cachedInputTokens, cacheWriteInputTokens: value.cacheWriteInputTokens,
    cacheWrite5mInputTokens: value.cacheWrite5mInputTokens, cacheWrite1hInputTokens: value.cacheWrite1hInputTokens,
    outputTokens: value.outputTokens, reasoningOutputTokens: value.reasoningOutputTokens,
    nonReasoningOutputTokens: value.nonReasoningOutputTokens,
  };
}
function cost(value: CostBreakdown): CostBreakdown {
  return {
    cachedInputUsd: value.cachedInputUsd, cacheWriteUsd: value.cacheWriteUsd, inputUsd: value.inputUsd,
    outputUsd: value.outputUsd, totalUsd: value.totalUsd, upperEstimateUsd: value.upperEstimateUsd,
  };
}
function counts(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter(([, count]) => typeof count === "number" && Number.isFinite(count)));
}

/** The disk boundary is independent of parser internals. Never persist a row or provider record. */
export function projectSession(value: SessionAnalytics): SessionAnalytics {
  const metrics = value.metrics;
  return {
    sessionKey: value.sessionKey, repositoryId: value.repositoryId, repositoryName: value.repositoryName,
    provider: value.provider, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt,
    firstEventAt: value.firstEventAt, lastEventAt: value.lastEventAt, effort: value.effort,
    executionKind: value.executionKind, costBasis: value.costBasis, costComplete: value.costComplete,
    pricedTokenCoverage: value.pricedTokenCoverage, cost: cost(value.cost), tokens: tokens(value.tokens),
    costByExecution: {
      subagentUsd: value.costByExecution.subagentUsd, topLevelUsd: value.costByExecution.topLevelUsd,
      unknownUsd: value.costByExecution.unknownUsd,
    },
    models: value.models.map((model) => ({
      ...tokens(model), ...cost(model), model: model.model, calls: model.calls, priced: model.priced,
    })),
    spendByDay: counts(value.spendByDay), tools: counts(value.tools), transportTools: counts(value.transportTools),
    skills: counts(value.skills), skillEvidence: value.skillEvidence,
    metrics: {
      assistantMessages: metrics.assistantMessages, compactions: metrics.compactions,
      contextUtilizationPeak: metrics.contextUtilizationPeak, delegatedAgents: metrics.delegatedAgents,
      durationMilliseconds: metrics.durationMilliseconds, eventSpanMilliseconds: metrics.eventSpanMilliseconds,
      maxContextWindow: metrics.maxContextWindow, maxInputTokensPerCall: metrics.maxInputTokensPerCall,
      modelCalls: metrics.modelCalls, queueOperations: metrics.queueOperations, summaries: metrics.summaries,
      taskCompletions: metrics.taskCompletions, taskStarts: metrics.taskStarts, toolCalls: metrics.toolCalls,
      transportToolCalls: metrics.transportToolCalls, userTurns: metrics.userTurns,
    },
    transcript: {
      files: value.transcript.files, snapshotWhileWorking: value.transcript.snapshotWhileWorking,
      status: value.transcript.status, warnings: value.transcript.warnings.map((warning) => String(warning)),
      ...(value.transcript.sourceDeleted ? { sourceDeleted: true } : {}),
    },
  };
}
