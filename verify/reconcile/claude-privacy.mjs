/** Closed projections for the standalone Claude validation collectors. */
export const safeModel = value => typeof value === 'string' && /^(?:claude-(?:opus|sonnet|haiku|fable|mythos)(?:-(?:\d{1,2}|\d{8}|preview)){1,5}(?:\[1m\])?|<synthetic>)$/.test(value) ? value : '<unknown>';
export function safeTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const milliseconds = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? new Date(milliseconds).toISOString() : null;
}
export const costRecordFields = new Set(['type','timestamp','sessionId','startTime','totalCostUSD','totalAPIDuration','totalAPIDurationWithoutRetries','totalToolDuration','totalLinesAdded','totalLinesRemoved','totalDuration','modelUsage','hasUnknownModelCost']);
export const modelUsageFields = new Set(['inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','costUSD','thinkingTokens','webSearchRequests','contextWindow','maxOutputTokens']);
export const projectLastFields = new Set(['lastAPIDuration','lastAPIDurationWithoutRetries','lastCost','lastDuration','lastFpsAverage','lastFpsLow1Pct','lastLinesAdded','lastLinesRemoved','lastToolDuration','lastTotalCacheCreationInputTokens','lastTotalCacheReadInputTokens','lastTotalInputTokens','lastTotalOutputTokens','lastTotalWebSearchRequests','lastStartTime']);
export const safeFieldNames = (value, allowed) => value && typeof value === 'object' ? Object.keys(value).filter(key => allowed.has(key)).sort() : [];
export const failSafely = () => { console.error('Claude reconciliation failed; raw error suppressed.'); process.exitCode = 1; };
