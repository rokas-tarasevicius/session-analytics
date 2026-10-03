import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { analyzeMachineSessions, analyzeRepositorySessions } from "../src/analyzer.ts";
import { analyzeOptionsFrom } from "../src/options.ts";
import { LimitsCollector, summarizeLimitWindow } from "../src/metrics/limits.ts";
import { readLimitsConfig } from "../src/metrics/limits-config.ts";
import { CacheContextCollector, claudeRequestEvidence } from "../src/metrics/cache-context.ts";
import { claudeContextWindow } from "../src/metrics/context-windows.ts";
import { limitsCacheReport } from "../src/metrics/limits-report.ts";
import type { LimitSample } from "../src/metrics/limits-cache-types.ts";
import type { AnalyzeOptions, SessionAnalytics, TokenUsage } from "../src/types.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";
import { plantMalformedModels } from "./model-privacy-fixture.ts";
import { publicModel } from "../src/public-model.ts";
import { boundContextDetail } from "../src/metrics/context-detail.ts";

const date = (minute: number, day = 29) => new Date(Date.UTC(2026, 8, day, 10, minute)).toISOString();
const secret = "private-content-must-never-escape";
const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "limits-cache-fixture-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function point(minute: number, usedPercent: number | null, reset = 60): LimitSample {
  return { timestamp: date(minute), usedPercent, resetsAt: date(reset), status: null, source: "codex-transcript", usingOverage: null };
}
function summarize(points: LimitSample[], now = 10) {
  return summarizeLimitWindow({ key: "fixture", label: "primary", windowMinutes: 300, duplicatesDiscarded: 0, historyLimited: false }, points, Date.parse(date(now)));
}
function rateRecord(minute: number, used: unknown = 75, overrides: Record<string, unknown> = {}) {
  return { timestamp: date(minute), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: {
    limit_id: "codex", plan_type: "pro", primary: { used_percent: used, window_minutes: 300, resets_at: Date.parse(date(60)) / 1000 },
    secondary: null, credits: { has_credits: true, unlimited: false, balance: "12.5", raw: secret }, ...overrides }, content: secret } };
}

test("quota exposure is time-weighted, bounded by resets and gaps, and guarded for sparse evidence", () => {
  const result = summarize([point(0, 80), point(5, 95), point(10, 100)]);
  assert.equal(result.observedMinutes, 10);
  assert.equal(result.above90Minutes, 5);
  assert.equal(result.shareAbove90, 0.5);
  assert.equal(result.headroomPercent, 0);
  assert.equal(result.timeToLimitMinutes, 0);
  assert.equal(summarize([point(0, 90)]).shareAbove90, null);
  assert.equal(summarize([point(0, null), point(5, null), point(10, null)]).headroomPercent, null);
  assert.equal(summarize([point(0, 90), point(5, 95), point(10, null)]).shareAbove90, null);
  assert.equal(summarize([point(0, 90), point(5, 95), point(10, 100)], 5).shareAbove90, null);
  assert.equal(summarize([point(0, 90), point(30, 95), point(60, 90)], 60).observedMinutes, 0);
  const reset = summarize([point(0, 95, 3), point(5, 10), point(10, 20)]);
  assert.equal(reset.observedMinutes, 8);
  assert.equal(reset.above90Minutes, 3);
  assert.equal(reset.timeToLimitMinutes, null);
});

test("headroom expires and projections require a sustained rise before reset", () => {
  const result = summarize([point(0, 80), point(5, 85), point(10, 90)]);
  assert.equal(result.timeToLimitMinutes, 10);
  assert.equal(result.headroomPercent, 10);
  assert.equal(summarize([point(0, 80), point(5, 90), point(10, 85)]).timeToLimitMinutes, null);
  assert.equal(summarize([point(0, 10, 11), point(5, 11, 11), point(10, 12, 11)]).timeToLimitMinutes, null);
  assert.equal(summarize([point(0, 80), point(5, 85), point(10, 90)], 26).headroomPercent, null);
  assert.equal(summarize([point(0, 80), point(5, 85), point(10, 90)], 60).stale, true);
  assert.equal(summarize([point(10, 90)], 0).stale, true);
});

test("quota broadcasts deduplicate independently of token usage and keep profiles and limit IDs separate", async () => {
  await temporary(async (root) => {
    const active = join(root, "profile-a", "sessions"), archive = join(root, "profile-a", "archived_sessions"), other = join(root, "profile-b", "sessions");
    await mkdir(active, { recursive: true }); await mkdir(other, { recursive: true });
    const collector = await LimitsCollector.create({ home: root, claude: [], codex: [active, archive, other], dataDirectory: root });
    for (let n = 0; n < 3; n++) {
      collector.observe(join(active, "one.jsonl"), rateRecord(n * 5, 80 + n * 5), "session-a");
      collector.observe(join(archive, "two.jsonl"), rateRecord(n * 5, 80 + n * 5), "session-b");
    }
    collector.observe(join(other, "three.jsonl"), rateRecord(10, 30), "session-c");
    collector.observe(join(active, "one.jsonl"), rateRecord(10, 15, { limit_id: secret, plan_type: secret, credits: { balance: secret } }), "session-a");
    collector.observe(join(active, "one.jsonl"), rateRecord(10, -1), "session-a");
    collector.observe(join(active, "one.jsonl"), rateRecord(10, "90"), "session-a");
    collector.observe(join(active, "one.jsonl"), { timestamp: date(10), type: "event_msg", payload: { type: "task_complete", error: { codex_error_info: "usage_limit_exceeded", message: secret } } }, "session-a");
    const result = collector.finalize([], date(10), false);
    assert.equal(result.profiles.length, 2);
    const first = result.profiles[0]!;
    assert.equal(first.label, "Codex profile 1");
    assert.equal(first.planType, "pro");
    const primary = first.windows.find((w) => w.label === "Codex primary")!;
    assert.equal(primary.observations, 3);
    assert.equal(primary.duplicatesDiscarded, 3);
    assert.equal(first.windows.length, 2);
    assert.equal(first.limitHitCount, 1);
    assert.equal(first.sessionsWithLimitErrors, 1);
    assert.equal(result.profiles[1]!.windows[0]!.headroomPercent, 70);
    const serialized = JSON.stringify(result);
    for (const forbidden of [secret, '"session-a"', '"profile-a"', "/profile-a", root]) assert.equal(serialized.includes(forbidden), false);
  });
});

test("simultaneous conflicting snapshots resolve deterministically without averaging quota", async () => {
  await temporary(async (root) => {
    const build = async (values: number[]) => {
      const collector = await LimitsCollector.create({ home: root, claude: [], codex: [root], dataDirectory: root });
      for (const value of values) collector.observe(join(root, "file"), rateRecord(0, value), "session");
      return collector.finalize([], date(0), false).profiles[0]!.windows[0]!;
    };
    assert.deepEqual(await build([10, 90]), await build([90, 10]));
  });
});

test("Claude default/custom usage caches and Desktop accounts use verified shapes and ordinal labels", async () => {
  await temporary(async (root) => {
    const defaultRoot = join(root, ".claude", "projects"), custom = join(root, ".claude-private", "projects");
    await mkdir(defaultRoot, { recursive: true }); await mkdir(custom, { recursive: true });
    const cached = (used: number) => ({ cachedUsageUtilization: { fetchedAtMs: Date.parse(date(10)), accountUuid: secret,
      utilization: { five_hour: { utilization: used, resets_at: date(60), message: secret }, seven_day: null, extra_usage: { disclaimer: secret } } } });
    await writeFile(join(root, ".claude.json"), JSON.stringify(cached(20)));
    await writeFile(join(root, ".claude", ".claude.json"), JSON.stringify(cached(99)));
    await writeFile(join(root, ".claude-private", ".claude.json"), JSON.stringify(cached(40)));
    const desktop = join(root, "Library/Application Support/Claude"); await mkdir(desktop, { recursive: true });
    await writeFile(join(desktop, "plan-usage-history.json"), JSON.stringify({ version: 1, samples: [
      { t: Date.parse(date(0)), org: secret, u: { fh: 90, sd: 30, xu: 99 } },
      { t: Date.parse(date(5)), org: secret, u: { fh: 95, sd: 31 } },
      { t: Date.parse(date(10)), org: secret, u: { fh: 100, sd: 32 } },
      { t: Date.parse(date(10)), org: "another-private-org", u: { fh: 15, sd: 20 } },
    ] }));
    const collector = await LimitsCollector.create({ home: root, claude: [defaultRoot, custom], codex: [], includeDesktop: true, dataDirectory: root });
    collector.observe(join(custom, "file"), { timestamp: date(5), quotaLimits: { status: "rejected", rateLimitType: "five_hour", resetsAt: Date.parse(date(60)) / 1000, isUsingOverage: false, unexpected: secret }, apiErrorStatus: 429, error: secret }, "session");
    const result = collector.finalize([], date(10), false);
    assert.equal(result.profiles.length, 4);
    assert.equal(result.profiles[0]!.windows[0]!.headroomPercent, 80);
    assert.equal(result.profiles[1]!.windows[0]!.headroomPercent, 60);
    assert.equal(result.profiles[1]!.limitHitCount, 2);
    assert.equal(result.profiles[1]!.sessionsWithLimitErrors, 1);
    assert.equal(result.profiles[2]!.scope, "desktop-account");
    assert.equal(result.profiles[2]!.windows[0]!.observations, 3);
    assert.doesNotMatch(JSON.stringify(result), /private-content|another-private-org|\.claude-private|accountUuid|xu/);
    const isolated = await LimitsCollector.create({ home: root, claude: [custom], codex: [], dataDirectory: root });
    assert.equal(isolated.finalize([], date(10), false).profiles.length, 1);
  });
});

test("profile symlink aliases share identity; config is opt-in, validated and errors are generic", async () => {
  await temporary(async (root) => {
    const actual = join(root, "actual"), alias = join(root, "alias");
    await mkdir(join(actual, "sessions"), { recursive: true }); await symlink(actual, alias);
    await writeFile(join(root, "config.json"), JSON.stringify({ limitsCache: { profiles: [
      { provider: "codex", profile: 1, label: "Research", monthlyPriceUsd: 25, unknown: secret },
      { provider: "claude", profile: 1, label: `/${secret}`, monthlyPriceUsd: -1 },
    ] } }));
    const collector = await LimitsCollector.create({ home: root, claude: [], codex: [join(actual, "sessions"), join(alias, "sessions")], dataDirectory: root });
    collector.observe(join(actual, "sessions/file"), rateRecord(0), "one");
    collector.observe(join(alias, "sessions/file"), rateRecord(0), "two");
    const result = collector.finalize([], date(0), false);
    assert.equal(result.profiles.length, 1); assert.equal(result.profiles[0]!.label, "Research");
    assert.equal(result.profiles[0]!.windows[0]!.duplicatesDiscarded, 1);
    assert.ok(result.warnings.length); assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    await writeFile(join(root, "config.json"), secret);
    const warnings: string[] = [];
    assert.deepEqual(await readLimitsConfig(root, warnings), []);
    assert.equal(warnings.length, 1); assert.doesNotMatch(warnings.join(), new RegExp(secret));
    assert.equal(analyzeOptionsFrom(["--data-dir", root], { SESSION_ANALYTICS_DATA_DIR: "fallback" }).dataDir, root);
  });
});

test("large quota histories are bounded and expose retention and chart sampling", () => {
  const points = Array.from({ length: 20_100 }, (_, n) => ({ ...point(0, 95), timestamp: new Date(Date.parse(date(0)) + n * 1000).toISOString() }));
  const result = summarize(points, 400);
  assert.equal(result.observations, 20_000); assert.equal(result.timeline.length, 480);
  assert.equal(result.historyLimited, true); assert.equal(result.timelineSampled, true);
  assert.equal(result.latest.timestamp, points.at(-1)!.timestamp);
});

async function world(root: string) {
  const options: AnalyzeOptions = { claudeRoot: join(root, "claude/projects"), codexRoot: join(root, "codex/sessions"),
    codexArchiveRoot: join(root, "codex/archived_sessions"), cursorDatabasePath: join(root, "missing-cursor.db"), databasePath: join(root, "missing.db"), dataDir: join(root, "data") };
  const repo = join(root, "sample-repository");
  await Promise.all([mkdir(join(repo, ".git"), { recursive: true }), ...[options.claudeRoot!, options.codexRoot!, options.codexArchiveRoot!, options.dataDir!].map((p) => mkdir(p, { recursive: true }))]);
  return { options, repo };
}
const claudeId = "11111111-aaaa-4111-8111-111111111111";
function assistant(repo: string, id: string, minute: number, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { cwd: repo, sessionId: claudeId, uuid: `private-${id}-${minute}`, timestamp: date(minute), type: "assistant", ...extra,
    message: { id, role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: secret }], usage } };
}
const usage = (read: number, write = 0, output = 10, ttl = 5) => ({ input_tokens: 0, output_tokens: output,
  cache_read_input_tokens: read, cache_creation_input_tokens: write,
  cache_creation: { ephemeral_5m_input_tokens: ttl === 5 ? write : 0, ephemeral_1h_input_tokens: ttl === 60 ? write : 0 } });

test("streamed Claude cache usage is priced once, and re-cache flags respect TTL refresh and execution streams", async () => {
  await temporary(async (root) => {
    const { options, repo } = await world(root);
    const main = join(options.claudeRoot!, `${claudeId}.jsonl`);
    const compaction = { type: "system", subtype: "compact_boundary", timestamp: date(16), uuid: "compaction-one", compactMetadata: { trigger: "auto", preTokens: 180000, postTokens: 40000, content: secret }, content: secret };
    await writeFile(main, jsonl([
      assistant(repo, "one", 0, usage(0, 1000)),
      assistant(repo, "two", 4, usage(1000)),
      assistant(repo, "three", 7, usage(1000, 1000, 1), { diagnostics: { cache_miss_reason: { type: "tools_changed", content: secret } } }),
      assistant(repo, "three", 7, usage(1000, 1000, 200)),
      assistant(repo, "four", 15, usage(0, 1000)),
      compaction,
      assistant(repo, "five", 17, usage(0, 1000)),
      { type: "user", uuid: "human", timestamp: date(18), message: { role: "user", content: secret } },
      { type: "user", uuid: "tool-result", timestamp: date(19), message: { role: "user", content: [{ type: "tool_result", content: secret }] } },
      { ...compaction, uuid: "compaction-two", timestamp: date(20), compactMetadata: { trigger: "manual", preTokens: 160000 } },
    ]));
    const subdir = join(options.claudeRoot!, claudeId, "subagents"); await mkdir(subdir, { recursive: true });
    await writeFile(join(subdir, "agent-one.jsonl"), jsonl([assistant(repo, "sub", 14, usage(0, 1000, 50))]));
    const result = await analyzeMachineSessions(options);
    const session = result.sessions.find((s) => s.provider === "claude")!, metrics = session.limitsCache!;
    assert.equal(metrics.cache.requests, 6);
    assert.equal(metrics.cache.cacheWriteTokens, 5000);
    assert.equal(metrics.cache.cacheReadTokens, 2000);
    assert.equal(metrics.cache.breakRequests, 3);
    assert.equal(metrics.cache.reportedBreaks, 1);
    assert.equal(metrics.cache.heuristicBreaks, 2);
    assert.equal(metrics.cacheBreaks[0]!.reportedReason, "tools_changed");
    assert.deepEqual(metrics.cacheBreaks[1]!.heuristics, ["idle-ttl"]);
    assert.deepEqual(metrics.cacheBreaks[2]!.heuristics, ["compaction"]);
    // Reviewed card: 5k writes at $2.50/M + 2k reads at $0.20/M versus all 7k at $2/M.
    assert.ok(Math.abs(metrics.cache.netSavingsUsd - 0.0011) < 1e-10);
    assert.ok(Math.abs(metrics.cache.recacheWriteUsd - 0.0075) < 1e-10);
    assert.equal(metrics.compactions.length, 2);
    assert.equal(metrics.compactions[0]!.turnsSincePrevious, null);
    assert.equal(metrics.compactions[1]!.turnsSincePrevious, 1);
    assert.equal(metrics.compactions[1]!.postTokens, null);
    assert.ok(metrics.buckets.some((b) => b.executionKind === "subagent"));
    assert.doesNotMatch(JSON.stringify(result) + limitsCacheReport(result), new RegExp(`${secret}|${claudeId}|private-one|${repo}`));
  });
});

test("unknown cache TTLs do not generate idle flags, and long or mixed TTLs use the longer observed lifetime", () => {
  const collector = new CacheContextCollector();
  const tokens: TokenUsage = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 1000, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 1000, uncachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, nonReasoningOutputTokens: 0 };
  const add = (minute: number, ttl: number | null, model = "claude-sonnet-4-5") => collector.addRequest(model, tokens, undefined, null, date(minute), "top-level", { stream: "one", contextWindow: null, requestInputKnown: true, compactions: 0, reportedReason: null, ttlMinutes: ttl }, "claude");
  add(0, 60); add(30, 60); add(91, null); add(150, null); add(151, null, "claude-haiku-4-5");
  const result = collector.finalize();
  assert.deepEqual(result.cacheBreaks.map((b) => b.heuristics), [["idle-ttl"], ["model-switch"]]);
  assert.equal(result.cacheBreaks[0]!.writeUsd, null);
  assert.equal(result.cache.unknownTtlWriteRequests, 3);
  assert.equal(claudeRequestEvidence({ message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 } } } }, "s", 0).ttlMinutes, 60);
  assert.equal(claudeRequestEvidence({ diagnostics: { cache_miss_reason: { type: secret } } }, "s", 0).reportedReason, null);
});

test("context ratios pair input with each deduplicated request's window, exclude cumulative deltas, and keep unknown models unknown", async () => {
  await temporary(async (root) => {
    const { options, repo } = await world(root), id = "22222222-bbbb-4222-8222-222222222222";
    const token = (minute: number, input: number, window: number, total: number) => ({ type: "event_msg", timestamp: date(minute), payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, output_tokens: total / 100 }, last_token_usage: { input_tokens: input, cached_input_tokens: input / 2, output_tokens: 10 }, model_context_window: window }, rate_limits: recordRate(minute) } });
    const recordRate = (minute: number) => ({ primary: { used_percent: 80 + minute, window_minutes: 300, resets_at: Date.parse(date(60)) / 1000 }, limit_id: secret, plan_type: secret });
    const requests = [token(0, 180000, 200000, 180000), token(5, 600000, 1000000, 780000), token(10, 200000, 1000000, 980000)];
    await writeFile(join(options.codexRoot!, `${id}.jsonl`), jsonl([
      { type: "session_meta", timestamp: date(0), payload: { cwd: repo, id } },
      { type: "turn_context", timestamp: date(0), payload: { model: "gpt-5.5" } },
      requests[0], requests[0], requests[1], requests[2],
      { type: "event_msg", timestamp: date(11), payload: { type: "context_compacted" } },
      { type: "compacted", timestamp: date(11), payload: { content: secret } },
      { type: "event_msg", timestamp: date(11), payload: { type: "item_completed", item: { type: "ContextCompaction", id: secret } } },
      { type: "event_msg", timestamp: date(12), payload: { type: "token_count", info: { total_token_usage: { input_tokens: 990000, output_tokens: 9900 }, model_context_window: 1000000 } } },
    ]));
    const result = await analyzeMachineSessions(options), metrics = result.sessions[0]!.limitsCache!;
    assert.equal(metrics.context.eligibleRequests, 3);
    assert.equal(metrics.context.requests, 4);
    assert.equal(metrics.context.peakFill, 0.9);
    assert.equal(result.sessions[0]!.metrics.contextUtilizationPeak, 0.9);
    assert.equal(metrics.context.shareAbove40, 2 / 3);
    assert.equal(metrics.context.shareAbove60, 1 / 3);
    assert.equal(metrics.context.shareAbove80, 1 / 3);
    assert.equal(metrics.compactionCount, 1);
    assert.equal(metrics.cache.pricedRequests, 3);
    assert.ok(Math.abs(metrics.cache.netSavingsUsd - 3.555) < 1e-10); // 600K request gets its long-context input/cache multipliers.
    assert.equal(result.limitsCache!.profiles[0]!.windows[0]!.observations, 3);
    assert.equal(result.limitsCache!.profiles[0]!.windows[0]!.duplicatesDiscarded, 1);
    assert.equal(claudeContextWindow("claude-haiku-4-5-20251001"), 200000);
    assert.equal(claudeContextWindow("claude-opus-5"), 1000000);
    assert.equal(claudeContextWindow("claude-future-model"), null);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  });
});

test("subscriptions use request months, configured prices, coverage guards and a repository-scope label", async () => {
  await temporary(async (root) => {
    const { options, repo } = await world(root);
    await writeFile(join(options.dataDir!, "config.json"), JSON.stringify({ limitsCache: { profiles: [{ provider: "claude", profile: 1, label: "Personal", monthlyPriceUsd: 20 }] } }));
    const records = [27,28,29].map((day) => ({ ...assistant(repo, `request-${day}`, 0, usage(100000, 0, 1000)), timestamp: date(0, day) }));
    records.push({ ...assistant(repo, "october", 0, usage(100000, 0, 1000)), timestamp: "2026-10-01T10:00:00Z" });
    await writeFile(join(options.claudeRoot!, `${claudeId}.jsonl`), jsonl(records));
    const result = await analyzeMachineSessions(options), rows = result.limitsCache!.subscriptions;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.month, "2026-09"); assert.equal(rows[0]!.activeDays, 3);
    assert.ok(Math.abs(rows[0]!.apiEquivalentUsd - 0.09) < 1e-10);
    assert.ok(Math.abs(rows[0]!.leverage! - 0.0045) < 1e-10);
    assert.equal(rows[1]!.leverage, null);
    const selected = await analyzeRepositorySessions({ ...options, repositoryRoot: repo });
    assert.equal(selected.limitsCache!.subscriptions[0]!.scope, "selected-repository");
    const cli = await promisify(execFile)(process.execPath, ["src/cli.ts", "--claude-root", options.claudeRoot!, "--codex-root", options.codexRoot!, "--codex-archive-root", options.codexArchiveRoot!, "--database", options.databasePath!, "--cursor-database", options.cursorDatabasePath!, "--data-dir", options.dataDir!]);
    assert.match(cli.stdout, /Limits & cache/); assert.match(cli.stdout, /Personal/); assert.match(cli.stdout, /not an invoice/);
    assert.doesNotMatch(cli.stdout, new RegExp(`${secret}|${claudeId}|${repo}`));
    // Exercise the dependency-free browser aggregation without requiring a DOM.
    const { economicsForView } = await import(new URL("../src/public/views/limits-cache.js", import.meta.url).href);
    const view = economicsForView(result.sessions, { start: "2026-10-01", end: "2026-10-01", grouping: "model", execution: "all" });
    assert.equal(view.cache.requests, 1);
    assert.equal(view.months[0].month, "2026-10");
    assert.equal(economicsForView(result.sessions, { start: "2026-10-01", execution: "subagent" }).cache.requests, 0);
    assert.equal(economicsForView(result.sessions, { repositoryId: "not-selected" }).cache.requests, 0);
  });
});

test("write-only cache value can be negative; tiny denominators and unknown models stay unavailable", async () => {
  await temporary(async (root) => {
    const { options, repo } = await world(root);
    await writeFile(join(options.claudeRoot!, `${claudeId}.jsonl`), jsonl([assistant(repo, "write-only", 0, usage(0, 10000, 10, 60))]));
    const result = await analyzeMachineSessions(options), cache = result.sessions[0]!.limitsCache!.cache;
    assert.equal(cache.hitRatio, null); // A single request is too small for a comparative ratio.
    assert.equal(result.sessions[0]!.limitsCache!.context.shareAbove40, null);
    assert.ok(Math.abs(cache.netSavingsUsd + 0.02) < 1e-10); // 1h write is $4/M; no-cache input is $2/M.
    assert.equal(result.limitsCache!.subscriptions[0]!.monthlyPriceUsd, null);
    const unknown = assistant(repo, "unknown", 0, usage(10000));
    unknown.message.model = "unknown-reviewed-model";
    await writeFile(join(options.claudeRoot!, `${claudeId}.jsonl`), jsonl([unknown]));
    const second = await analyzeMachineSessions(options), economics = second.sessions[0]!.limitsCache!;
    assert.equal(economics.cache.pricedRequests, 0);
    assert.equal(economics.context.eligibleRequests, 0);
    assert.equal(economics.context.peakFill, null);
    assert.equal(second.limitsCache!.subscriptions[0]!.pricingCoverage, 0);
    assert.equal(second.limitsCache!.subscriptions[0]!.leverage, null);
    assert.match(limitsCacheReport(second), /No-cache comparison: N\/A/);
  });
});

test("bounded context and event details preserve exact peaks, threshold counts and totals", () => {
  const collector = new CacheContextCollector();
  for (let index = 0; index < 600; index++) {
    const input = index === 303 ? 190000 : 80000;
    const tokens: TokenUsage = { inputTokens: input, cachedInputTokens: input, cacheWriteInputTokens: 0,
      cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0, uncachedInputTokens: 0, outputTokens: 1,
      reasoningOutputTokens: 0, nonReasoningOutputTokens: 1 };
    collector.addRequest("claude-haiku-4-5", tokens, undefined, null, index === 0 ? null : date(index), "top-level",
      { stream: secret, requestInputKnown: true, contextWindow: 200000, compactions: index, reportedReason: "messages_changed", ttlMinutes: null }, "claude");
    collector.addCompaction(secret, "boundary", `${index}`, date(index), "top-level", index, { preTokens: input, postTokens: 20000, content: secret });
  }
  const result = collector.finalize();
  assert.equal(result.context.requests, 600);
  assert.equal(result.context.above40, 1);
  assert.equal(result.context.above80, 1);
  assert.equal(result.context.peakFill, 0.95);
  assert.equal(result.context.curveSampled, true);
  assert.ok(result.context.curve.length <= 240);
  assert.ok(result.context.curve.some((p) => p.fill === 0.95));
  assert.equal(result.cacheBreaks.length, 240); assert.equal(result.cacheBreaksSampled, true);
  assert.equal(result.cache.breakRequests, 600);
  assert.equal(result.compactionCount, 600); assert.equal(result.compactionsSampled, true);
  assert.equal(result.compactions.length, 240);
  assert.equal(result.compactions[0]!.turnsSincePrevious, null);
  assert.equal(result.compactions.at(-1)!.turnsSincePrevious, 1);
  assert.equal(result.buckets.find((b) => b.day === null)!.cache.requests, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("missing and zero plan prices never invent leverage, and invalid key targets are rejected", async () => {
  await temporary(async (root) => {
    const { options, repo } = await world(root);
    await writeFile(join(options.claudeRoot!, `${claudeId}.jsonl`), jsonl([27,28,29].map((day) => ({ ...assistant(repo, `m-${day}`, 0, usage(10000)), timestamp: date(0, day) }))));
    const snapshot = await analyzeMachineSessions(options);
    const profileKey = snapshot.limitsCache!.profiles[0]!.key;
    assert.equal(snapshot.limitsCache!.subscriptions[0]!.monthlyPriceUsd, null);
    assert.equal(snapshot.limitsCache!.subscriptions[0]!.leverage, null);
    await writeFile(join(options.dataDir!, "config.json"), JSON.stringify({ limitsCache: { profiles: [
      { provider: "claude", profile: 1, profileKey: secret, monthlyPriceUsd: 99 },
      { provider: "claude", profileKey, monthlyPriceUsd: 0 },
    ] } }));
    const collector = await LimitsCollector.create({ home: root, claude: [options.claudeRoot!], codex: [], dataDirectory: options.dataDir });
    const result = collector.finalize(snapshot.sessions, date(0), false);
    assert.equal(result.subscriptions[0]!.monthlyPriceUsd, 0);
    assert.equal(result.subscriptions[0]!.leverage, null);
    assert.equal(result.warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  });
});

test("replayed compaction boundaries and streamed 429 errors do not manufacture extra events or re-cache cost", async () => {
  await temporary(async (root) => {
    const { options, repo } = await world(root);
    const boundary = { type: "system", subtype: "compact_boundary", uuid: "replayed-boundary", timestamp: date(1), compactMetadata: { preTokens: 190000, postTokens: 40000 } };
    await writeFile(join(options.claudeRoot!, `${claudeId}.jsonl`), jsonl([
      assistant(repo, "one", 0, usage(0, 1000)), boundary,
      assistant(repo, "two", 2, usage(0, 1000)), { ...boundary, timestamp: date(3) },
      assistant(repo, "three", 4, usage(0, 1000)),
      { timestamp: date(5), type: "assistant", apiErrorStatus: 429, message: { id: secret, content: secret } },
      { timestamp: date(6), type: "assistant", apiErrorStatus: 429, message: { id: secret, content: secret } },
    ]));
    const snapshot = await analyzeMachineSessions(options), metrics = snapshot.sessions[0]!.limitsCache!;
    assert.equal(metrics.compactionCount, 1);
    assert.equal(metrics.cache.breakRequests, 1);
    assert.equal(snapshot.sessions[0]!.metrics.compactions, 1);
    assert.equal(metrics.cache.pricedBreakRequests, 1);
    assert.equal(snapshot.limitsCache!.profiles[0]!.limitHitCount, 1);
    assert.equal(snapshot.limitsCache!.profiles[0]!.limitHits[0]!.timestamp, date(5));
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
  });
});

test("zero last usage keeps cumulative totals but cannot invent a request context or cache saving", async () => {
  await temporary(async (root) => {
    const { options, repo } = await world(root), id = "22222222-bbbb-4222-8222-222222222222";
    await writeFile(join(options.codexRoot!, `${id}.jsonl`), jsonl([
      { type: "session_meta", timestamp: date(0), payload: { cwd: repo, id } },
      { type: "turn_context", timestamp: date(0), payload: { model: "gpt-5.5" } },
      ...[0, 1].map((n) => ({ type: "event_msg", timestamp: date(n), payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: 1000 + n * 600000, output_tokens: 10 },
        last_token_usage: { input_tokens: n ? 0 : 1000, output_tokens: n ? 0 : 10 }, model_context_window: 200000,
      } } })),
    ]));
    const snapshot = await analyzeMachineSessions(options), session = snapshot.sessions[0]!, metrics = session.limitsCache!;
    assert.equal(session.tokens.inputTokens, 601000);
    assert.equal(metrics.context.requests, 2);
    assert.equal(metrics.context.eligibleRequests, 1);
    assert.equal(metrics.context.peakFill, 0.005);
    assert.equal(session.metrics.contextUtilizationPeak, 0.005);
    assert.equal(metrics.cache.pricedRequests, 1);
    assert.equal(metrics.cache.pricedInputTokens, 1000);
    assert.equal(metrics.cache.cacheReadTokens, 0);
    assert.equal(metrics.cache.netSavingsUsd, 0);
  });
});

test("malformed model metadata never leaves any provider through JSON or terminal reports", async () => {
  await temporary(async (root) => {
    const fixture = await createSessionAnalyticsFixture(root);
    await plantMalformedModels(fixture);
    const snapshot = await analyzeMachineSessions({ ...fixture, dataDir: root });
    assert.doesNotMatch(JSON.stringify(snapshot), /SYNTHETIC-MODEL-SENTINEL/);
    for (const provider of ["claude", "codex", "cursor"]) assert.ok(snapshot.sessions.some((s) => s.provider === provider && s.models.some((m) => m.model === "<unknown>")));
    assert.equal(snapshot.summary.providerReportedSpendUsd, 1.48);
    const cli = await promisify(execFile)(process.execPath, ["src/cli.ts", "--claude-root", fixture.claudeRoot, "--codex-root", fixture.codexRoot,
      "--codex-archive-root", fixture.codexArchiveRoot, "--database", fixture.databasePath, "--cursor-database", fixture.cursorDatabasePath, "--data-dir", root]);
    assert.doesNotMatch(cli.stdout, /SYNTHETIC-MODEL-SENTINEL/);
  });
});

test("Claude request chronology compares instants across UTC offsets and ignores invalid dates", async () => {
  await temporary(async (root) => {
    const { options, repo } = await world(root);
    await writeFile(join(options.claudeRoot!, `${claudeId}.jsonl`), jsonl([
      { ...assistant(repo, "early", 0, usage(0, 1000)), timestamp: "2026-09-29T12:00:00+02:00" },
      assistant(repo, "later", 10, usage(0, 2000)),
      { ...assistant(repo, "undated", 20, usage(0, 3000)), timestamp: "not-a-date" },
    ]));
    const session = (await analyzeMachineSessions(options)).sessions[0]!, metrics = session.limitsCache!;
    assert.deepEqual(metrics.context.curve.map((p) => p.timestamp), [date(0), date(10), null]);
    assert.equal(metrics.cache.heuristicBreaks, 1);
    assert.deepEqual(metrics.cacheBreaks[0]!.heuristics, ["idle-ttl"]);
    assert.equal(session.firstEventAt, date(0));
    assert.equal(session.lastEventAt, date(10));
  });
});

test("Codex compactions reconcile duplicate representations and preserve disjoint formats after upgrades", async () => {
  await temporary(async (root) => {
    const { options, repo } = await world(root), id = "22222222-bbbb-4222-8222-222222222222";
    await writeFile(join(options.codexRoot!, `${id}.jsonl`), jsonl([
      { type: "session_meta", timestamp: date(0), payload: { cwd: repo, id } },
      { type: "event_msg", timestamp: date(0), payload: { type: "user_message", message: secret } },
      { type: "event_msg", timestamp: date(1), payload: { type: "context_compacted" } },
      { type: "compacted", timestamp: date(1), payload: { content: secret } },
      { type: "event_msg", timestamp: date(1), payload: { type: "item_completed", item: { type: "ContextCompaction", id: "boundary-a" } } },
      { type: "event_msg", timestamp: date(30), payload: { type: "user_message", message: secret } },
      { type: "event_msg", timestamp: date(61), payload: { type: "item_completed", item: { type: "ContextCompaction", id: "boundary-b" } } },
      { type: "event_msg", timestamp: date(62), payload: { type: "item_completed", item: { type: "ContextCompaction", id: "boundary-b" } } },
      { type: "compacted", timestamp: date(121), payload: { content: secret } },
    ]));
    const snapshot = await analyzeMachineSessions(options), session = snapshot.sessions[0]!, metrics = session.limitsCache!;
    assert.equal(metrics.compactionCount, 3);
    assert.equal(session.metrics.compactions, 3);
    assert.equal(snapshot.summary.compactions, 3);
    assert.deepEqual(metrics.compactions.map((p) => p.timestamp), [date(1), date(61), date(121)]);
    assert.deepEqual(metrics.compactions.map((p) => p.turnsSincePrevious), [null, 1, 0]);
  });
});

test("fresh numeric Claude headroom survives allowed statuses but not rejections or reset changes, including ties", async () => {
  await temporary(async (root) => {
    const claude = join(root, ".claude", "projects"); await mkdir(claude, { recursive: true });
    await writeFile(join(root, ".claude.json"), JSON.stringify({ cachedUsageUtilization: {
      fetchedAtMs: Date.parse(date(10)), utilization: { five_hour: { utilization: 40, resets_at: date(60) } },
    } }));
    for (const minute of [10, 11]) for (const status of ["allowed", "allowed_warning", "rejected"]) {
      const collector = await LimitsCollector.create({ home: root, claude: [claude], codex: [], dataDirectory: root });
      collector.observe(join(claude, "file"), { timestamp: date(minute), quotaLimits: { status, rateLimitType: "five_hour", resetsAt: date(60) } }, "session");
      const window = collector.finalize([], date(12), false).profiles[0]!.windows[0]!;
      assert.equal(window.headroomPercent, status === "rejected" ? null : 60, `${minute}: ${status}`);
      assert.equal(window.latest.status, status);
      assert.equal(window.latestNumeric!.timestamp, date(10));
      assert.equal(window.headroomExpiresAt, date(25));
      assert.equal(collector.finalize([], date(25), false).profiles[0]!.windows[0]!.headroomPercent, null);
    }
    for (const minute of [10, 11]) {
      const collector = await LimitsCollector.create({ home: root, claude: [claude], codex: [], dataDirectory: root });
      collector.observe(join(claude, "file"), { timestamp: date(minute), quotaLimits: { status: "allowed", rateLimitType: "five_hour", resetsAt: date(120) } }, "session");
      assert.equal(collector.finalize([], date(12), false).profiles[0]!.windows[0]!.headroomPercent, null);
    }
  });
});

test("snapshot-wide curve detail is bounded without changing request totals, peaks or date buckets", async () => {
  await temporary(async (root) => {
    const { options, repo } = await world(root);
    for (let s = 0; s < 140; s++) {
      const id = `11111111-aaaa-4111-8111-${String(s).padStart(12, "0")}`;
      await writeFile(join(options.claudeRoot!, `${id}.jsonl`), jsonl(Array.from({ length: 200 }, (_, n) => ({
        ...assistant(repo, `request-${n}`, n, usage(n === 100 ? 990000 : 1000)), sessionId: id,
      }))));
    }
    const snapshot = await analyzeMachineSessions(options);
    const curves = snapshot.sessions.map((s) => s.limitsCache!.context.curve);
    assert.equal(snapshot.sessions.length, 140);
    assert.ok(curves.reduce((count, curve) => count + curve.length, 0) <= 20000);
    for (const session of snapshot.sessions) {
      const metrics = session.limitsCache!;
      assert.equal(metrics.context.requests, 200);
      assert.equal(metrics.context.peakFill, 0.99);
      assert.equal(metrics.context.above80, 1);
      assert.equal(metrics.context.curveSampled, true);
      assert.equal(metrics.buckets.reduce((n, b) => n + b.cache.requests, 0), 200);
      assert.equal(metrics.context.curve[0]!.request, 1);
      assert.equal(metrics.context.curve.at(-1)!.request, 200);
      assert.ok(metrics.context.curve.some((p) => p.fill === 0.99));
    }
  });
});

test("compaction reconciliation retains distinct identities and marks undated cross-format evidence uncertain", () => {
  const collector = new CacheContextCollector();
  collector.addCompaction("stream", "legacy", "same", date(0), "top-level", 1);
  collector.addCompaction("stream", "item", "same", date(1), "top-level", 1, { preTokens: 90000 });
  collector.addCompaction("stream", "item", "different", date(0), "top-level", 1);
  const identified = collector.finalize();
  assert.equal(identified.compactionCount, 2);
  assert.equal(identified.compactions[0]!.preTokens, 90000);
  const undated = new CacheContextCollector();
  undated.addCompaction("stream", "legacy", "legacy-only", null, "top-level", 1);
  undated.addCompaction("stream", "item", "item-only", null, "top-level", 2);
  const result = undated.finalize();
  assert.equal(result.compactionCount, 2);
  assert.equal((result as unknown as { compactionCountExact: boolean }).compactionCountExact, false);
  assert.ok(result.compactions.every((p) => p.turnsSincePrevious === null));
  const ambiguous = new CacheContextCollector();
  ambiguous.addCompaction("stream", "item", "one", date(0), "top-level", 1);
  ambiguous.addCompaction("stream", "item", "two", date(0), "top-level", 2);
  ambiguous.addCompaction("stream", "legacy", null, date(0), "top-level", 2);
  assert.equal(ambiguous.finalize().compactionCount, 2);
  assert.equal(ambiguous.finalize().compactionCountExact, false);
  assert.ok(ambiguous.finalize().compactions.every((p) => p.turnsSincePrevious === null));
  for (const reverse of [false, true]) {
    const replayed = new CacheContextCollector();
    const records = [
      ["legacy", null, date(0)], ["item", "same", date(1)], ["item", "same", date(0)],
    ] as const;
    for (const [shape, id, at] of reverse ? [...records].reverse() : records) replayed.addCompaction("stream", shape, id, at, "top-level", 1);
    assert.equal(replayed.finalize().compactionCount, 1);
    assert.equal(replayed.finalize().compactions[0]!.timestamp, date(0));
  }
});

test("public model policy preserves bounded identifiers and rejects complete malformed values", () => {
  for (const value of ["gpt-6.1-sol", "claude-haiku-4-5-20251001", "unknown-reviewed-model", "custom_model"]) assert.equal(publicModel(value), value);
  for (const value of [null, {}, "", "..", "./model", "model/path", "~model", "user@host", "Error loading model", "gpt-5\u0000", "gpt-5\r", "x".repeat(97), "constructor", "__proto__"]) {
    // A plain identifier may name no rate; object prototype names must never
    // inherit a rate. Constructor itself is syntactically a valid identifier.
    assert.equal(publicModel(value), value === "constructor" ? "constructor" : "<unknown>");
  }
});

test("detail budgets smaller than session counts remain deterministic and preserve aggregate facts", () => {
  const sessions = Array.from({ length: 5 }, (_, index) => {
    const collector = new CacheContextCollector();
    const metrics = collector.finalize();
    metrics.context.peakFill = 0.9;
    metrics.context.curve = [0.1, 0.9, 0.2].map((fill, n) => ({ request: n + 1, timestamp: date(n), executionKind: "top-level", inputTokens: fill * 1000, windowTokens: 1000, fill }));
    return { sessionKey: `session-${index}`, limitsCache: metrics } as SessionAnalytics;
  });
  const reversed = structuredClone(sessions).reverse();
  boundContextDetail(sessions, 3); boundContextDetail(reversed, 3);
  assert.equal(sessions.reduce((n, s) => n + s.limitsCache!.context.curve.length, 0), 3);
  assert.deepEqual(sessions, reversed.reverse());
  for (const s of sessions) {
    assert.equal(s.limitsCache!.context.peakFill, 0.9);
    assert.equal(s.limitsCache!.context.curveSampled, true);
    assert.ok(s.limitsCache!.context.curve.every((p) => p.fill === 0.9));
  }
});
