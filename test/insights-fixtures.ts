import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { calculateCost } from "../src/analyzer.ts";
import { defaultThresholds } from "../src/insights/config.ts";
import type { InsightContext } from "../src/insights/types.ts";
import type { AnalyzeOptions, RateCard, SessionAnalytics, TokenUsage } from "../src/types.ts";

export const testRateCard: RateCard = {
  currency: "USD", effectiveDate: "2026-10-01", models: {
    "claude-premium": { provider: "claude", inputPerMillion: 5, cacheReadPerMillion: 0.5, cacheWrite5mPerMillion: 6.25, cacheWrite1hPerMillion: 10, outputPerMillion: 25, source: "https://example.test/claude" },
    "claude-small": { provider: "claude", inputPerMillion: 1, cacheReadPerMillion: 0.1, cacheWrite5mPerMillion: 1.25, cacheWrite1hPerMillion: 2, outputPerMillion: 5, source: "https://example.test/claude" },
    "codex-premium": { provider: "codex", inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30, source: "https://example.test/codex" },
    "codex-small": { provider: "codex", inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 5, source: "https://example.test/codex" },
  },
};
export const context = (): InsightContext => ({ thresholds: { ...defaultThresholds }, disabledRules: [], comparisonModels: {}, nextTierModels: { claude: { "claude-premium": "claude-small" }, codex: { "codex-premium": "codex-small" } }, inventory: [], rateCard: structuredClone(testRateCard), warnings: [] });
export function tokens(overrides: Partial<TokenUsage> = {}): TokenUsage {
  const result = { inputTokens: 200_000, uncachedInputTokens: 20_000, cachedInputTokens: 180_000, cacheWriteInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0, outputTokens: 10_000, reasoningOutputTokens: 0, nonReasoningOutputTokens: 10_000, ...overrides };
  result.inputTokens = result.uncachedInputTokens + result.cachedInputTokens + result.cacheWriteInputTokens;
  return result;
}
export function session(index: number, overrides: Partial<SessionAnalytics> = {}): SessionAnalytics {
  const usage = tokens(), cost = calculateCost(testRateCard.models["claude-premium"]!, usage, usage.inputTokens);
  return {
    cost, costBasis: "api-list-price-equivalent", costByExecution: { subagentUsd: 0, topLevelUsd: cost.totalUsd, unknownUsd: 0 }, costComplete: true,
    insightSignals: { requestSizes: { observedTokens: usage.inputTokens + usage.outputTokens, unknownTokens: 0 } },
    createdAt: `2026-09-${String(index % 28 + 1).padStart(2, "0")}T10:00:00Z`, updatedAt: "2026-09-30T10:10:00Z", firstEventAt: "2026-09-01T10:00:00Z", lastEventAt: "2026-09-01T10:10:00Z",
    effort: "medium", executionKind: "top-level", provider: "claude", repositoryId: "discovered-aaaaaaaaaaaaaaaaaaaa", repositoryName: "demo-repository", sessionKey: index.toString(16).padStart(12, "0"),
    metrics: { assistantMessages: 20, compactions: 0, contextUtilizationPeak: null, delegatedAgents: 0, durationMilliseconds: 600_000, eventSpanMilliseconds: 600_000, maxContextWindow: 0, maxInputTokensPerCall: 20_000, modelCalls: 20, queueOperations: 0, summaries: 0, taskCompletions: 0, taskStarts: 0, toolCalls: 20, transportToolCalls: 20, userTurns: 4 },
    models: [{ ...usage, ...cost, model: "claude-premium", calls: 20, priced: true }], pricedTokenCoverage: 1, skillEvidence: "explicit", skills: {}, spendByDay: {}, status: "idle", tokens: usage, tools: { Read: 20 }, transportTools: { Read: 20 }, transcript: { files: 1, status: "ok", snapshotWhileWorking: false, completeness: "complete", liveness: "inactive", warnings: [] },
    ...overrides,
  };
}
export const sessions = (count = 6): SessionAnalytics[] => Array.from({ length: count }, (_, index) => session(index + 1));

export async function setUtcBoundaryStarts(source: string): Promise<void> {
  const starts = ["2026-09-01T23:30:00-07:00", "2026-09-02T06:30:00Z", "2026-09-02T00:00:00Z", "2026-09-02T23:59:59.999Z", "2026-09-03T00:00:00Z", "invalid-start"];
  const files = (await readdir(dirname(source))).filter((name) => name.endsWith(".jsonl")).sort();
  for (const [index, file] of files.entries()) {
    const path = join(dirname(source), file), lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const first = JSON.parse(lines[0]!); first.timestamp = starts[index]; lines[0] = JSON.stringify(first);
    await writeFile(path, lines.join("\n") + "\n");
  }
}

export async function createInsightsFixture(root: string): Promise<{ options: AnalyzeOptions; flags: string[]; sessionKey: string; source: string; config: string }> {
  const claudeRoot = join(root, "profile", "projects"), repository = join(root, "synthetic-project");
  const codexRoot = join(root, "codex", "sessions"), codexArchiveRoot = join(root, "codex", "archived_sessions");
  await Promise.all([mkdir(join(claudeRoot, "synthetic"), { recursive: true }), mkdir(join(repository, ".git"), { recursive: true }), mkdir(codexRoot, { recursive: true }), mkdir(codexArchiveRoot, { recursive: true })]);
  const rateCardPath = join(root, "rates.json"), config = join(root, "insights.json");
  await writeFile(rateCardPath, JSON.stringify(testRateCard));
  await writeFile(config, JSON.stringify({ nextTierModels: { claude: { "claude-premium": "claude-small" }, codex: { "codex-premium": "codex-small" } }, inventory: { claude: { skills: ["unused-skill"], mcpServers: ["unused-server"] } }, thresholds: { extensionMinSessions: 5 } }));
  let source = "", sessionKey = "";
  for (let index = 1; index <= 6; index++) {
    const id = `${String(index).repeat(8)}-1111-4111-8111-111111111111`;
    const path = join(claudeRoot, "synthetic", `${id}.jsonl`);
    const records: unknown[] = [];
    const base = { cwd: repository, sessionId: id, gitBranch: "synthetic-private-branch" };
    for (let turn = 0; turn < 20; turn++) {
      const timestamp = new Date(Date.UTC(2026, 8, index, 10, turn * 6)).toISOString();
      records.push({ ...base, type: "user", uuid: `u-${turn}`, timestamp, message: { role: "user", content: "synthetic-private-branch Please inspect /secret-private/source.ts at https://private.example.test/task using api_key=secret-credential-123. Contact person@example.test. content-is-not-returned" } });
      const message = { id: `m-${turn}`, model: "claude-premium", usage: { input_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 200_000, cache_creation: { ephemeral_5m_input_tokens: 200_000, ephemeral_1h_input_tokens: 0 }, output_tokens: 100, output_tokens_details: { thinking_tokens: 10 } }, content: [{ type: "text", text: "I will compare the request context. content-is-not-returned" }, { type: "thinking", thinking: "secret-reasoning" }, { type: "tool_use", id: `call-${turn}`, name: "Read", input: { file_path: "/secret-path", command: "secret-command", value: "secret-tool-args" } }] };
      records.push({ ...base, timestamp, type: "assistant", message });
      records.push({ ...base, timestamp, type: "assistant", message: { ...message, usage: { ...message.usage, output_tokens: 200 } } });
      if (turn % 5 === 0) records.push({ ...base, timestamp, type: "system", subtype: "compact_boundary", content: "secret-compaction" });
      records.push({ ...base, timestamp, type: "user", message: { content: [{ type: "tool_result", content: "secret-tool-result" }] } });
    }
    records.push({ ...base, type: "system", subtype: "turn_duration", timestamp: `2026-09-${String(index).padStart(2, "0")}T12:00:00Z` });
    await writeFile(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
    if (index === 1) { source = path; sessionKey = createHash("sha256").update(`claude:${id}`).digest("hex").slice(0, 12); }
  }
  const options = { claudeRoot, codexRoot, codexArchiveRoot, cursorDatabasePath: join(root, "absent-cursor.db"), databasePath: join(root, "absent-conductor.db"), rateCardPath, insightsConfigPath: config };
  const flags = ["--claude-root", claudeRoot, "--codex-root", codexRoot, "--codex-archive-root", codexArchiveRoot, "--cursor-database", options.cursorDatabasePath, "--database", options.databasePath, "--rate-card", rateCardPath, "--insights-config", config];
  return { options, flags, sessionKey, source, config };
}
