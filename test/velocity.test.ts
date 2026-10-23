import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { analyzeMachineSessionsIsolated } from "../src/analysis-process.ts";
import { claudeEntrypoint, claudeSubagentType, codexOriginator, codexSource, counterExposed, localClock, VelocityAccumulator, velocityDimension, velocityEffort, zeroVelocity } from "../src/metrics/velocity.ts";
import { averagePrice, buildVelocity, calendarDays, comparisonSpan, guardedDelta, localDay, metricDefinitions, periodKey, shiftDay, topMovers, velocityIndicators } from "../src/public/velocity-data.js";
import type { SessionAnalytics, SessionVelocity, VelocityValues } from "../src/types.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";
import { addUnsafeVelocityModels, unsafeVelocityModels } from "./velocity-fixtures.ts";
import { Element, documentFromHtml } from "./release-dom.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8 * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const sumCells = (velocity: SessionVelocity): number[] => {
  const result = zeroVelocity();
  for (const values of [...velocity.buckets.map((cell) => cell[3]), ...velocity.undated.map((cell) => cell[1])]) for (let i = 0; i < result.length; i += 1) result[i]! += values[i]!;
  return result;
};
const jsonl = (records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

test("invalid model labels cannot cross the isolated projection from usage-free or tool-only sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocity-model-privacy-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const added = await addUnsafeVelocityModels(fixture);
    const data = await analyzeMachineSessionsIsolated(fixture);
    assert.equal(data.sessions.filter((session) => session.models.length === 0).length, added);
    assert.doesNotMatch(JSON.stringify(data), /velocity-model-SENTINEL/);
    for (const session of data.sessions.filter((session) => session.models.length === 0)) {
      assert.ok(session.velocity?.dimensions.every((dimension) => dimension.model === "<unknown>"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("every velocity producer validates bounded model IDs, including accumulator fallback dimensions", () => {
  for (const model of unsafeVelocityModels) {
    const dimension = velocityDimension("codex", {}, "top-level", model, null);
    assert.equal(dimension.model, "<unknown>");
    const accumulator = new VelocityAccumulator();
    accumulator.tool(null, { ...dimension, model });
    assert.doesNotMatch(JSON.stringify(accumulator.finish(null, dimension)), /velocity-model-SENTINEL/);
  }
  for (const model of ["claude-opus-5", "gpt-6.1-sol", "unpriced-test-model", "model_A-20261003", "<unknown>"]) {
    assert.equal(velocityDimension("claude", {}, "top-level", model, null).model, model);
  }
});

test("invalid usage and Codex fallback model labels stay internal in every provider projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocity-model-usage-"));
  try {
    const model = unsafeVelocityModels[0]!;
    const fixture = await createSessionAnalyticsFixture(root, model);
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await writeFile(join(fixture.codexRoot, `rollout-${id}.jsonl`), jsonl([
      { timestamp: "2026-09-01T12:00:00Z", type: "session_meta", payload: { id, cwd: fixture.repositoryRoot, source: "cli" } },
      { timestamp: "2026-09-01T12:01:00Z", type: "event_msg", payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: 3456, output_tokens: 345 }, last_token_usage: { input_tokens: 123, output_tokens: 12 },
      } } },
      // The earlier unknown-model request uses this file's sole model as fallback.
      { type: "turn_context", payload: { model } },
    ]));
    const db = new DatabaseSync(fixture.cursorDatabasePath);
    try {
      for (const row of db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all()) {
        const composer = JSON.parse(String(row.value));
        composer.usageData = { [model]: { costInCents: 100 } };
        db.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?").run(JSON.stringify(composer), String(row.key));
      }
    } finally { db.close(); }
    const data = await analyzeMachineSessionsIsolated(fixture);
    assert.doesNotMatch(JSON.stringify(data), /velocity-model-SENTINEL/);
    for (const provider of ["claude", "codex", "cursor"]) {
      assert.ok(data.sessions.some((session) => session.provider === provider && session.models.some((item) => item.model === "<unknown>")), `${provider} retains usage under an unknown public model`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("global start dates reject missing and timezone-free timestamps consistently across browser zones", () => {
  const source = new URL("../src/public/velocity-data.js", import.meta.url).href;
  const stamps = ["2026-07-20 23:30:00", "2026-07-20T23:30:00", "2026-07-20", null, "", "invalid", "2026-07-20T23:30:00Z", "2026-07-20T23:30:00+01:00", "2026-07-21T00:30:00+01:00"];
  for (const TZ of ["Europe/London", "America/Los_Angeles", "Asia/Kathmandu"]) {
    const code = `import {localDay, sessionStartWindow} from ${JSON.stringify(source)};
      const stamps = ${JSON.stringify(stamps)}, sessions = [...stamps.map((createdAt, id) => ({createdAt, id})), {id:9}];
      const options = {start:'2026-07-20', end:'2026-07-20', timeZone:'Europe/London'};
      console.log(JSON.stringify({days:stamps.map(stamp => localDay(stamp, options.timeZone)),
        first:sessionStartWindow(sessions, options),
        second:sessionStartWindow(sessions, {...options, start:'2026-07-21', end:'2026-07-21'})}));`;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ }, encoding: "utf8" }));
    assert.deepEqual(result.days, [null, null, null, null, null, null, "2026-07-21", "2026-07-20", "2026-07-21"]);
    assert.deepEqual(result.first.sessions.map((item: { id: number }) => item.id), [7]);
    assert.deepEqual(result.second.sessions.map((item: { id: number }) => item.id), [6, 8]);
    assert.equal(result.first.undatedStarts, 7); assert.equal(result.second.undatedStarts, 7);
  }
});

test("velocity reconciles every provider's dated plus undated counters with the existing ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocity-ledger-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const data = await analyzeMachineSessions(fixture);
    assert.equal(data.velocity?.version, 1);
    assert.equal(data.velocity?.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    for (const session of data.sessions) {
      assert.ok(session.velocity);
      const values = sumCells(session.velocity);
      near(values[0]!, session.cost.totalUsd);
      for (const [index, field] of [[1, "inputTokens"], [2, "uncachedInputTokens"], [3, "cachedInputTokens"], [4, "cacheWriteInputTokens"], [5, "outputTokens"], [6, "reasoningOutputTokens"]] as const) near(values[index]!, session.tokens[field]);
      assert.equal(values[7], session.metrics.modelCalls);
      assert.equal(values[8], session.metrics.toolCalls);
      assert.equal(values[9], 1);
      const execution = { "top-level": 0, subagent: 0, unknown: 0 };
      for (const [,, index, value] of session.velocity.buckets) execution[session.velocity.dimensions[index]!.executionKind] += value[0];
      for (const [index, value] of session.velocity.undated) execution[session.velocity.dimensions[index]!.executionKind] += value[0];
      near(execution["top-level"], session.costByExecution.topLevelUsd);
      near(execution.subagent, session.costByExecution.subagentUsd);
      near(execution.unknown, session.costByExecution.unknownUsd);
      if (session.provider === "cursor") {
        assert.equal(session.velocity.buckets.reduce((n, cell) => n + cell[3][0], 0), 0, "Never put undated provider cost on the session start day");
        assert.ok(session.velocity.undated.length);
        assert.equal(values[10], 0, "Cursor tokens have no attributable model price");
      }
    }
    const serialized = JSON.stringify(data);
    assert.doesNotMatch(serialized, /content-is-not-returned|secret-command|secret-path|secret-skill-args|conductor-codex|22222222-2222/);
    const modelTotal = data.sessions.reduce((total, session) => total + sumCells(session.velocity!)[7]!, 0);
    assert.equal(modelTotal, data.sessions.reduce((total, session) => total + session.metrics.modelCalls, 0));
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("agent identity is a fixed enum, never a free-text originator, attribution or effort", () => {
  const sentinel = "private-agent-/secret-path-and-title";
  assert.equal(claudeEntrypoint("sdk-ts"), "sdk"); assert.equal(claudeEntrypoint("local-agent"), "desktop");
  assert.equal(claudeEntrypoint(sentinel), "unknown"); assert.equal(claudeSubagentType(sentinel), "other");
  assert.equal(claudeSubagentType("Explore"), "explore");
  assert.equal(codexSource({ subagent: { thread_spawn: { parent_thread_id: sentinel } } }), "subagent");
  assert.equal(codexSource(sentinel), "unknown"); assert.equal(codexOriginator(sentinel), "unknown");
  assert.equal(codexOriginator("codex_exec"), "exec"); assert.equal(velocityEffort(sentinel), "unknown");
  assert.equal(counterExposed(-1), false); assert.equal(counterExposed("10"), false);
  assert.equal(counterExposed(Number.NaN), false); assert.equal(counterExposed(0), true);
  assert.equal(localClock(sentinel), null); assert.equal(localClock("2026-10-01T12:00:00"), null);
});

test("local buckets respect TZ, midnight, fractional offsets, and both sides of DST", () => {
  const source = new URL("../src/metrics/velocity.ts", import.meta.url).href;
  const stamps = ["2026-10-01T23:30:00Z", "2026-03-08T09:30:00Z", "2026-03-08T10:30:00Z", "2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"];
  for (const [zone, expected] of [
    ["UTC", [["2026-10-01", 23], ["2026-03-08", 9], ["2026-03-08", 10], ["2026-11-01", 8], ["2026-11-01", 9]]],
    ["America/Los_Angeles", [["2026-10-01", 16], ["2026-03-08", 1], ["2026-03-08", 3], ["2026-11-01", 1], ["2026-11-01", 1]]],
    ["Asia/Kathmandu", [["2026-10-02", 5], ["2026-03-08", 15], ["2026-03-08", 16], ["2026-11-01", 14], ["2026-11-01", 15]]],
    ["Europe/London", [["2026-10-02", 0], ["2026-03-08", 9], ["2026-03-08", 10], ["2026-11-01", 8], ["2026-11-01", 9]]],
  ] as const) {
    const code = `import {localClock} from ${JSON.stringify(source)}; console.log(JSON.stringify(${JSON.stringify(stamps)}.map(localClock)));`;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ: zone }, encoding: "utf8" })) as Array<{ day: string; hour: number }>;
    assert.deepEqual(result.map(({ day, hour }) => [day, hour]), expected);
    for (let i = 0; i < stamps.length; i += 1) assert.equal(localDay(stamps[i]!, zone), result[i]?.day);
  }
  assert.equal(localDay("2026-02-01T00:00:00Z", "America/Los_Angeles"), "2026-01-31");
  assert.deepEqual(calendarDays("2024-02-28", "2024-03-01"), ["2024-02-28", "2024-02-29", "2024-03-01"]);
  assert.equal(periodKey("2026-01-01", "week"), "2025-12-29");
  assert.equal(periodKey("2026-01-01", "month"), "2026-01");
});

test("hour cells aggregate requests, keep dimensions distinct, and quarantine missing timestamps", () => {
  const accumulator = new VelocityAccumulator();
  const dimension = velocityDimension("claude", { claudeEntrypoint: "cli" }, "top-level", "model-a", "high");
  const tokens = zeroVelocity(); tokens[1] = 30; tokens[7] = 1;
  for (let i = 0; i < 100; i += 1) accumulator.add("2026-10-02T10:00:00Z", dimension, tokens);
  accumulator.tool("2026-10-02T10:01:00Z", dimension);
  accumulator.add("secret-timestamp", dimension, tokens);
  accumulator.add("2026-10-02T10:00:00Z", { ...dimension, executionKind: "subagent" }, tokens);
  const result = accumulator.finish("2026-10-01T23:00:00Z", dimension);
  assert.equal(result.buckets.length, 3);
  assert.equal(result.dimensions.length, 2);
  assert.equal(result.undated[0]?.[1][1], 30);
  assert.equal(sumCells(result)[7], 102);
  assert.equal(sumCells(result)[9], 1);
  assert.doesNotMatch(JSON.stringify(result), /secret-timestamp/);
});

test("streamed Claude usage and subagents retain per-event models, agents, effort and timezone dates", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocity-claude-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const path = join(fixture.claudeRoot, "synthetic");
    await mkdir(join(path, id, "subagents"), { recursive: true });
    const assistant = (timestamp: string | null, output: number, extra: Record<string, unknown> = {}) => ({
      cwd: fixture.repositoryRoot, sessionId: id, type: "assistant", entrypoint: "sdk-ts", effort: "high", timestamp,
      message: { id: "stream-a", model: "claude-opus-5", usage: { input_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 3, output_tokens: output, output_tokens_details: { thinking_tokens: 2 } }, content: [{ type: "tool_use", id: "tool-a", name: "Read", input: { file_path: "velocity-secret-path" } }, { type: "text", text: "velocity-private-message" }] }, ...extra,
    });
    await writeFile(join(path, `${id}.jsonl`), jsonl([
      assistant("2026-10-01T22:59:00Z", 3), assistant("2026-10-02T01:00:00Z", 30),
      assistant(null, 2, { entrypoint: "velocity-secret-originator", attributionAgent: "velocity-secret-subagent", message: { id: "undated-b", model: "unpriced-model", usage: { input_tokens: 22, output_tokens: 2 }, content: [{ type: "text", text: "velocity-secret-response" }] } }),
    ]));
    await writeFile(join(path, id, "subagents", "agent-a.jsonl"), jsonl([assistant("2026-10-02T12:00:00Z", 7, { attributionAgent: "Explore", effort: "low", message: { id: "child-b", model: "claude-opus-5", usage: { input_tokens: 4, output_tokens: 7 }, content: [] } })]));
    const data = await analyzeMachineSessions(fixture);
    const session = data.sessions.find((session) => session.tokens.inputTokens === 89)!;
    assert.ok(session?.velocity);
    assert.equal(session.velocity.buckets.filter((cell) => cell[3][7]).length, 2);
    const parent = session.velocity.buckets.find((cell) => cell[3][5] === 30)!;
    assert.equal(parent[0], localClock("2026-10-01T22:59:00Z")?.day);
    assert.equal(parent[3][7], 1); assert.equal(sumCells(session.velocity)[8], 1);
    assert.equal(session.velocity.dimensions[parent[2]]?.agent, "claude-sdk");
    const child = session.velocity.dimensions.find((dimension) => dimension.executionKind === "subagent")!;
    assert.equal(child.agent, "claude-explore"); assert.equal(child.effort, "low");
    assert.equal(session.agentIdentity?.claudeSubagentType, "explore");
    assert.equal(session.velocity.undated[0]?.[1][1], 22);
    assert.equal(session.velocity.undated[0]?.[1][10], 0);
    assert.doesNotMatch(JSON.stringify(data), /velocity-secret|velocity-private|aaaaaaaa-aaaa/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Small synthetic public snapshots exercise the exact browser aggregation module.
function synthetic(dailyValues: Array<[string, number]>, options: { agent?: string; model?: string; repository?: string } = {}): SessionAnalytics {
  const values = (value: number): VelocityValues => [value, value * 100, value * 50, value * 40, value * 10, value * 20, value * 5, 4, 6, 1, value * 120, value * 20, value * 100, value * 100];
  return {
    provider: "claude", repositoryId: options.repository ?? "repo-one", repositoryName: options.repository ?? "Synthetic repository", sessionKey: "synthetic-key", createdAt: "2020-01-01T00:00:00Z",
    velocity: { dimensions: [{ agent: options.agent ?? "claude-cli", model: options.model ?? "synthetic-model", executionKind: "top-level", effort: "high" }], buckets: dailyValues.map(([day, value]) => [day, 12, 0, values(value)]), undated: [[0, values(2)]] },
  } as SessionAnalytics;
}

test("averagePrice uses dated value and only positive-value days, with a separate calendar average", () => {
  const sessions = [synthetic([["2026-09-30", 500], ["2026-10-01", 4], ["2026-10-01", 2], ["2026-10-02", 0], ["2026-10-04", 6], ["2026-10-05", 100]])];
  const data = buildVelocity(sessions, { start: "2026-10-01", end: "2026-10-04", metric: "value" });
  assert.deepEqual(averagePrice(data), { total: 12, days: 4, activeDays: 2, perActiveDay: 6, perCalendarDay: 3 });
  const idle = buildVelocity([synthetic([["2026-10-01", 0]])], { start: "2026-10-01", end: "2026-10-04", metric: "value" });
  assert.deepEqual(averagePrice(idle), { total: 0, days: 4, activeDays: 0, perActiveDay: null, perCalendarDay: 0 });
  const empty = buildVelocity([], { start: "2026-10-04", end: "2026-10-01", metric: "value" });
  assert.deepEqual(averagePrice(empty), { total: 0, days: 0, activeDays: 0, perActiveDay: null, perCalendarDay: null });
});

test("all dimensions, token classes and granularities conserve totals within the activity window", () => {
  const sessions = Array.from({ length: 12 }, (_, i) => synthetic([["2026-09-30", 500], ["2026-10-01", i + 1], ["2026-10-03", 10], ["2026-10-04", 100]], { repository: `synthetic-${i}`, model: `model-${i}` }));
  for (const metric of Object.keys(metricDefinitions) as Array<keyof typeof metricDefinitions>) {
    for (const group of ["agent", "provider", "model", "repository", "execution", "effort"]) {
      for (const granularity of ["day", "week", "month", "hour"]) {
        const data = buildVelocity(sessions, { start: "2026-10-01", end: "2026-10-03", metric, group, granularity });
        near(data.series.reduce((n, series) => n + series.total, 0), data.totals[metricDefinitions[metric].index]!);
        near(data.series.reduce((n, series) => n + series.values.reduce((sum, value) => sum + value, 0), 0), data.totals[metricDefinitions[metric].index]!);
        assert.equal(data.daily[1]?.total, 0);
        assert.equal(data.contributingSessions, 12, "Sessions predating the range must still contribute their in-window activity");
        if (group === "model" || group === "repository") assert.match(data.series.at(-1)?.label ?? "", /Other/);
      }
    }
  }
  const cumulative = buildVelocity(sessions, { start: "2026-10-01", end: "2026-10-03", mode: "cumulative" });
  near(cumulative.series.reduce((n, series) => n + series.values.at(-1)!, 0), 198);
});

test("rolling average includes zero days but never invents prehistory; short baselines stay N/A", () => {
  const data = buildVelocity([synthetic([["2026-10-01", 7], ["2026-10-07", 7]])], { start: "2026-09-28", end: "2026-10-08" });
  assert.equal(data.rolling[6], null);
  assert.equal(data.rolling[9], 2);
  assert.equal(data.rolling[10], 1);
  assert.equal(guardedDelta(20, 0, "value", 8), null);
  assert.equal(guardedDelta(20, 1, "value", 2), null);
  assert.equal(guardedDelta(20, 1, "sessions"), null);
  assert.equal(guardedDelta(12, 6, "tools"), 1);
});

test("rolling average covers the first six days from prior history", async () => {
  const options = { start: "2026-09-01", end: "2026-09-30" };
  const history = comparisonSpan(options.end, options.end);
  const session = synthetic(calendarDays(history.start, options.end).map((day) => [day, day < options.start ? 14 : 7]));
  const comparisonData = buildVelocity([session], history);
  const data = buildVelocity([session], { ...options, rollingHistory: comparisonData });
  assert.deepEqual(data.rolling.slice(0, 7), [13, 12, 11, 10, 9, 8, 7]);
  assert.equal(data.rolling.length, 30);
  assert.equal(data.totals[0], 210, "Prior history changes the average, not the selected total");
  assert.ok(data.rolling.every((value) => value !== null));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentFromHtml("") });
  try {
    const { renderVelocity } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    // Exercise the renderer's existing comparison build, including a window longer than its default span.
    for (const start of [options.start, "2026-06-10"]) {
      const container = new Element();
      const activity = start === options.start ? session : synthetic(calendarDays("2026-05-01", options.end).map((day) => [day, 14]));
      renderVelocity(container, [activity], { ...options, start, generatedAt: "2026-09-30T12:00:00Z", timeZone: "UTC", providers: ["claude"] });
      const svg = container.querySelector(".velocity-chart")!.querySelector("svg")!;
      assert.ok(svg.querySelector(".velocity-average")!.getAttribute("d")!.startsWith(`M${svg.querySelector(".grid-line")!.getAttribute("x1")},`), "The rolling line starts at the first plotted day");
      svg.listeners.get("keydown")!({ key: "Home", preventDefault() {} });
      assert.match(container.querySelector(".velocity-inspection")!.textContent, new RegExp(`7-day average: \\$${start === options.start ? "13" : "14"}\\.00`));
      assert.ok(container.querySelector(".velocity-average-key"));
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("rolling history preserves prehistory and incomplete-evidence gaps at the window edge", () => {
  const options = { start: "2026-09-01", end: "2026-09-07" };
  const history = comparisonSpan(options.end, options.end);
  const fresh = synthetic([[options.start, 7]]);
  const freshData = buildVelocity([fresh], { ...options, rollingHistory: buildVelocity([fresh], history) });
  assert.deepEqual(freshData.rolling, [null, null, null, null, null, null, 1]);
  const partial = synthetic(calendarDays("2026-08-01", options.end).map((day) => [day, 7]));
  partial.velocity!.buckets.find(([day]) => day === "2026-08-31")![3][10] = 0;
  const partialData = buildVelocity([partial], { ...options, rollingHistory: buildVelocity([partial], history) });
  assert.deepEqual(partialData.rolling, [null, null, null, null, null, null, 7]);
});

test("a few unpriced tokens mark the rolling week partial instead of breaking the line", async () => {
  const options = { start: "2026-09-01", end: "2026-09-14" };
  const history = comparisonSpan(options.end, options.end);
  const session = synthetic(calendarDays("2026-08-01", options.end).map((day) => [day, 7]));
  const priced = (day: string) => session.velocity!.buckets.find(([bucket]) => bucket === day)![3];
  priced("2026-09-03")[10] -= 1;
  const data = buildVelocity([session], { ...options, rollingHistory: buildVelocity([session], history) });
  assert.ok(data.rolling.every((value) => value === 7), "One unpriced token keeps every week above the evidence floor");
  assert.deepEqual(data.rollingPartial, calendarDays(options.start, options.end).map((day) => day >= "2026-09-03" && day <= "2026-09-09"));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentFromHtml("") });
  try {
    const { renderVelocityChart } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    const container = new Element();
    renderVelocityChart(container, data, { rolling: true });
    const svg = container.querySelector("svg")!;
    assert.equal(svg.querySelector(".velocity-average")!.getAttribute("d")!.match(/M/g)!.length, 1, "The line has no gaps");
    svg.listeners.get("keydown")!({ key: "Home", preventDefault() {} });
    assert.match(container.querySelector(".velocity-inspection")!.textContent, /7-day average: \$7\.00(?! · partially)/);
    for (let step = 0; step < 4; step += 1) svg.listeners.get("keydown")!({ key: "ArrowRight", preventDefault() {} });
    assert.match(container.querySelector(".velocity-inspection")!.textContent, /7-day average: \$7\.00 · partially priced/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
  // A whole unpriced day leaves its weeks below the floor (6 of 7 days priced), so they stay N/A.
  priced("2026-09-12")[10] = 0;
  const weak = buildVelocity([session], { ...options, rollingHistory: buildVelocity([session], history) });
  assert.deepEqual(weak.rolling.slice(-4), [7, null, null, null]);
});

test("rolling average key is absent when every value is null", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentFromHtml("") });
  try {
    const { renderVelocityChart } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    const session = synthetic([["2026-09-01", 7]]), container = new Element();
    for (const mode of ["lines", "stacked"]) {
      const short = buildVelocity([session], { start: "2026-09-01", end: "2026-09-06", mode });
      assert.ok(short.rolling.every((value) => value === null));
      renderVelocityChart(container, short, { rolling: true });
      assert.equal(container.querySelector(".velocity-average-key"), null);
      assert.equal(container.querySelector(".velocity-average"), null);
      const complete = buildVelocity([session], { start: "2026-09-01", end: "2026-09-07", mode });
      renderVelocityChart(container, complete, { rolling: true });
      assert.equal(container.querySelector(".velocity-average-key")!.textContent, "Dashed: total · rolling 7-day average");
      renderVelocityChart(container, complete, { rolling: false });
      assert.equal(container.querySelector(".velocity-average-key"), null);
      assert.equal(container.querySelector(".velocity-average"), null);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("comparisons use matched complete dates; projection and burn expose their denominators", () => {
  const dates = calendarDays("2026-08-01", "2026-09-20");
  const session = synthetic(dates.map((day) => [day, day === "2026-09-20" ? 1 : 10]));
  const data = buildVelocity([session], { start: "2026-08-01", end: "2026-09-20" });
  const indicators = velocityIndicators(data, "2026-09-20");
  assert.equal(indicators.completeThrough, "2026-09-19");
  assert.equal(indicators.week.current.days, 6); assert.equal(indicators.week.previous.days, 6);
  assert.equal(indicators.week.current.value, 60); assert.equal(indicators.week.delta, 0);
  assert.equal(indicators.month.current.days, 19); assert.equal(indicators.month.previous.days, 19);
  assert.equal(indicators.burn.ratio, 0.1); assert.equal(indicators.burn.days, 14);
  assert.equal(indicators.projection?.value, 300); assert.equal(indicators.projection?.low, 300);
  assert.equal(indicators.projection?.sampleDays, 14); assert.equal(indicators.projection?.remainingDays, 11);
  const spike = synthetic(dates.map((day) => [day, day === "2026-09-20" ? 99 : 10]));
  const spikeProjection = velocityIndicators(buildVelocity([spike], { start: "2026-08-01", end: "2026-09-20" }), "2026-09-20").projection;
  assert.equal(spikeProjection?.value, 389, "A busy partial day adds observed usage without erasing future full-day projection");
  const clipped = buildVelocity([session], { start: "2026-09-18", end: "2026-09-20" });
  const missing = velocityIndicators(clipped, "2026-09-20");
  assert.equal(missing.projection, null); assert.equal(missing.burn.ratio, null); assert.equal(missing.week.delta, null);
  const historical = velocityIndicators(data, "2026-10-02");
  assert.equal(historical.burn.today, null); assert.equal(historical.completeThrough, "2026-09-20");
  const monday = velocityIndicators(buildVelocity([session], { start: "2026-08-01", end: "2026-09-14" }), "2026-09-14");
  assert.equal(monday.week.rolledBack, true, "A Monday compares the week that just finished");
  assert.equal(monday.week.current.days, 7); assert.equal(monday.week.delta, 0);
});

test("month comparisons handle unequal months and projections retain an honest nonzero scenario band", () => {
  const sessions = [synthetic(calendarDays("2024-01-01", "2024-03-31").map((day, i) => [day, i % 3 === 0 ? 1 : 20]))];
  const data = buildVelocity(sessions, { start: "2024-01-01", end: "2024-03-31" });
  const result = velocityIndicators(data, "2024-03-31");
  assert.equal(result.month.current.days, 29); assert.equal(result.month.previous.days, 29);
  assert.ok(result.projection && result.projection.low <= result.projection.value && result.projection.high >= result.projection.value);
  const short = velocityIndicators(buildVelocity([synthetic([["2024-03-01", 1], ["2024-03-07", 1]])], { start: "2024-03-01", end: "2024-03-08" }), "2024-03-08");
  assert.equal(short.projection, null, "Fewer than three active days cannot forecast");
});

test("movers rank absolute increases and guard each group's denominator", () => {
  const previous = calendarDays("2026-09-01", "2026-09-07"), current = calendarDays("2026-09-08", "2026-09-14");
  const sessions = [synthetic([...previous.map((day): [string, number] => [day, 1]), ...current.map((day): [string, number] => [day, 5])]), synthetic(current.map((day) => [day, 2]), { model: "new-model", repository: "new-repo", agent: "claude-sdk" })];
  const movers = topMovers(sessions, { start: "2026-09-01", end: "2026-09-14", metric: "value" }, "2026-09-15");
  assert.equal(movers.available, true); assert.equal(movers.rows[0]?.increase, 28);
  assert.equal(movers.rows.find((row) => row.label === "new-repo")?.delta, null);
  assert.equal(topMovers(sessions, { start: "2026-09-02", end: "2026-09-14", metric: "value" }, "2026-09-15").available, false);
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
});

test("Codex changes source, execution, model and effort without reassigning earlier usage or copying identity content", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocity-codex-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const context = (timestamp: string, model: string, effort: string) => ({ timestamp, type: "turn_context", payload: { model, effort } });
    const counter = (timestamp: string | null, input: number, output: number, lastInput: number, lastOutput: number) => ({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 0, reasoning_output_tokens: 0 }, last_token_usage: { input_tokens: lastInput, output_tokens: lastOutput, cached_input_tokens: 0, reasoning_output_tokens: 0 } } } });
    const call = { timestamp: "2026-10-01T23:58:00Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "private-call-id", name: "exec", input: 'await tools.exec_command({cmd:"private-velocity-command"}); await tools.read_file({path:"private-velocity-path"});' } };
    await writeFile(join(fixture.codexRoot, `rollout-${id}.jsonl`), jsonl([
      { timestamp: "2026-10-01T23:55:00Z", type: "session_meta", payload: { cwd: fixture.repositoryRoot, id, source: "review", originator: "private-velocity-originator", agent_nickname: "private-velocity-nickname" } },
      context("2026-10-01T23:56:00Z", "gpt-5.6-sol", "high"), call, call,
      counter("2026-10-01T23:59:00Z", 1234, 124, 1234, 124), counter("2026-10-01T23:59:00Z", 1234, 124, 1234, 124),
      { timestamp: "2026-10-02T00:00:00Z", type: "session_meta", payload: { source: { subagent: { thread_spawn: { parent_thread_id: "private-velocity-parent" } } }, originator: "codex_exec" } },
      context("2026-10-02T00:01:00Z", "unpriced-test-model", "low"), counter("2026-10-02T00:02:00Z", 2234, 224, 1000, 100),
      counter(null, 3234, 324, 1000, 100),
    ]));
    const data = await analyzeMachineSessions(fixture);
    const session = data.sessions.find((session) => session.tokens.inputTokens === 3234)!;
    assert.ok(session?.velocity);
    assert.equal(session.executionKind, "mixed"); assert.equal(session.metrics.modelCalls, 3);
    assert.equal(session.agentIdentity?.codexSource, "review"); assert.equal(session.agentIdentity?.codexOriginator, "unknown");
    const top = session.velocity.dimensions.find((dimension) => dimension.executionKind === "top-level")!;
    const subagent = session.velocity.dimensions.find((dimension) => dimension.executionKind === "subagent")!;
    assert.deepEqual([top.agent, top.model, top.effort], ["codex-review", "gpt-5.6-sol", "high"]);
    assert.deepEqual([subagent.agent, subagent.model, subagent.effort], ["codex-subagent", "unpriced-test-model", "low"]);
    assert.equal(sumCells(session.velocity)[7], 3); assert.equal(sumCells(session.velocity)[8], 2);
    assert.equal(session.velocity.undated[0]?.[1][1], 1000);
    assert.doesNotMatch(JSON.stringify(data), /private-velocity|private-call-id|bbbbbbbb-bbbb/);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("coverage denominators exclude providers for which a split or API price is not applicable", () => {
  const cursor = synthetic([["2026-10-01", 2]]);
  cursor.provider = "cursor";
  // Real Cursor cells have input/output and tools, but none of these split counters.
  for (const cell of cursor.velocity!.buckets) { cell[3][0] = 0; cell[3][3] = 0; cell[3][4] = 0; cell[3][6] = 0; for (let i = 10; i < 14; i += 1) cell[3][i] = 0; }
  const data = buildVelocity([cursor], { start: "2026-10-01", end: "2026-10-01" });
  assert.deepEqual(data.coverage, { priceTokens: 0, cacheReadInput: 0, cacheWriteInput: 0, reasoningOutput: 0 });
  const codex = synthetic([["2026-10-01", 3]]); codex.provider = "codex";
  const mixed = buildVelocity([cursor, codex], { start: "2026-10-01", end: "2026-10-01" });
  assert.equal(mixed.coverage.cacheWriteInput, 0); assert.equal(mixed.coverage.priceTokens, 360);
  const claude = synthetic([["2026-10-01", 4]]);
  const all = buildVelocity([cursor, codex, claude], { start: "2026-10-01", end: "2026-10-01" });
  assert.equal(all.coverage.cacheWriteInput, 400); assert.equal(all.coverage.priceTokens, 840);
});

test("missing metric evidence cannot become a decline, burn rate, rolling average or forecast", () => {
  const options = { start: "2026-08-01", end: "2026-09-20" };
  for (const [metric, numerator, counter] of [["value", 10, 0], ["reasoning", 11, 6], ["cacheRead", 12, 3], ["uncached", 12, 2], ["cacheWrite", 13, 4]] as const) {
    for (const gap of ["week", "today", "historical"] as const) {
      const session = synthetic(calendarDays(options.start, options.end).map((day) => [day, 10]));
      for (const [day,,, values] of session.velocity!.buckets) {
        if ((gap === "week" && day >= "2026-09-14") || (gap === "today" && day === options.end) || (gap === "historical" && day === "2026-09-02")) {
          values[numerator] = 0; values[counter] = 0;
        }
      }
      const data = buildVelocity([session], { ...options, metric });
      const result = velocityIndicators(data, options.end);
      if (gap === "week") {
        assert.equal(result.week.delta, null, `${metric}: missing fields are not a 100% decline`);
        assert.equal(result.burn.ratio, null);
        assert.equal(data.rolling.at(-1), null);
        const eligible = metric === "value" ? 7200 : metric === "reasoning" ? 1200 : 6000;
        assert.deepEqual(result.week.current.evidence, { known: 0, eligible, unsupported: 0, complete: false });
        assert.deepEqual(result.week.previous.evidence, { known: eligible, eligible, unsupported: 0, complete: true });
        assert.equal(data.allSeries[0]?.evidence.known, data.evidence.known);
        assert.equal(data.daily.at(-1)?.evidence.complete, false);
      }
      if (gap === "today") assert.equal(result.burn.ratio, null, `${metric}: today's partial evidence also blocks burn`);
      assert.equal(result.projection, null, `${metric}: ${gap} evidence gap invalidates month-end scenarios`);
      const workload = velocityIndicators(buildVelocity([session], { ...options, metric: "input" }), options.end);
      assert.equal(workload.week.delta, 0, "Input workload has not declined");
    }
  }
});

test("movers cannot rank telemetry recovery or partially observed growth as a measured increase", () => {
  const options = { start: "2026-09-01", end: "2026-09-14" };
  for (const [metric, numerator, counter] of [["value", 10, 0], ["reasoning", 11, 6], ["cacheRead", 12, 3], ["cacheWrite", 13, 4]] as const) {
    for (const gap of ["previous", "current"] as const) {
      const session = synthetic(calendarDays(options.start, options.end).map((day) => [day, day >= "2026-09-08" ? 20 : 10]));
      for (const [day,,, values] of session.velocity!.buckets) {
        if ((gap === "previous" && day < "2026-09-08") || (gap === "current" && day === "2026-09-09")) {
          values[numerator] = 0; values[counter] = 0;
        }
      }
      const movers = topMovers([session], { ...options, metric }, "2026-09-15");
      assert.equal(movers.rows.length, 0, `${metric}: ${gap} evidence gap must not rank as growth`);
      assert.equal(movers.excludedGroups, 3);
    }
  }
});

test("observed zeroes and inactive dates can support declines while equal partial coverage cannot", () => {
  const options = { start: "2026-08-01", end: "2026-09-20" };
  const measured = synthetic(calendarDays(options.start, options.end).map((day) => [day, 30]));
  for (const [day,,, values] of measured.velocity!.buckets) if (day >= "2026-09-14") values[6] = 0;
  const knownZero = velocityIndicators(buildVelocity([measured], { ...options, metric: "reasoning" }), options.end);
  assert.equal(knownZero.week.delta, -1, "A separately recorded zero is valid evidence");
  assert.equal(knownZero.burn.ratio, 0);
  const idle = synthetic(calendarDays(options.start, "2026-09-13").map((day) => [day, 10]));
  assert.equal(velocityIndicators(buildVelocity([idle], options), options.end).week.delta, -1);
  const partial = synthetic(calendarDays(options.start, options.end).map((day) => [day, 10]));
  for (const cell of partial.velocity!.buckets) cell[3][10] /= 2;
  const result = velocityIndicators(buildVelocity([partial], options), options.end);
  assert.equal(result.week.delta, null); assert.equal(result.burn.ratio, null); assert.equal(result.projection, null);
  const cursor = synthetic(calendarDays(options.start, options.end).map((day) => [day, 10])); cursor.provider = "cursor";
  const unsupported = velocityIndicators(buildVelocity([cursor], { ...options, metric: "uncached" }), options.end);
  assert.equal(unsupported.week.delta, null); assert.equal(unsupported.burn.ratio, null); assert.equal(unsupported.projection, null);
});

test("Codex cumulative coverage follows the charged counters and requires both endpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocity-codex-coverage-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const cases: Array<{ tool: string; knownInput: number; knownOutput: number }> = [];
    let sequence = 0;
    for (const last of [undefined, {}, { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_output_tokens: 0 }]) {
      for (const [before, after] of [[false, false], [false, true], [true, false], [true, true]]) {
        const n = ++sequence;
        const id = `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
        const tool = `coverage_probe_${n}`;
        const record = (step: number, exposed: boolean | undefined) => ({ timestamp: `2026-09-01T12:0${step}:00Z`, type: "event_msg", payload: { type: "token_count", info: {
          total_token_usage: { input_tokens: n * 1000 + step * 100, output_tokens: n * 100 + step * 10, ...(exposed ? { cached_input_tokens: 0, reasoning_output_tokens: 0 } : {}) },
          ...(last === undefined ? {} : { last_token_usage: last }),
        } } });
        await writeFile(join(fixture.codexRoot, `rollout-${id}.jsonl`), jsonl([
          { timestamp: "2026-09-01T12:00:00Z", type: "session_meta", payload: { id, cwd: fixture.repositoryRoot, source: "cli" } },
          { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
          { type: "response_item", payload: { type: "function_call", call_id: tool, name: tool, arguments: "{}" } },
          record(1, before), record(2, after),
        ]));
        cases.push({ tool, knownInput: before && after ? 100 : 0, knownOutput: before && after ? 10 : 0 });
      }
    }
    const data = await analyzeMachineSessions(fixture);
    for (const { tool, knownInput, knownOutput } of cases) {
      const session = data.sessions.find((session) => session.tools[tool])!;
      const values = sumCells(session.velocity!);
      assert.equal(values[1], 100); assert.equal(values[5], 10);
      assert.equal(values[12], knownInput, `${tool}: cache coverage belongs to the cumulative difference`);
      assert.equal(values[11], knownOutput, `${tool}: reasoning coverage belongs to the cumulative difference`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Velocity defaults to Provider and every grouping folds series beyond the top six without losing accounting", () => {
  const providers = ["claude", "codex", "cursor", "copilot", "opencode", "gemini", "unsupported"] as const;
  const agents = ["claude-cli", "claude-sdk", "claude-desktop", "claude-explore", "claude-plan", "claude-general-purpose", "codex-cli", "codex-desktop", "codex-exec"];
  const efforts = ["low", "medium", "high", "xhigh", "minimal", "none", "max", "ultra", "unknown"];
  const sessions = efforts.map((effort, i) => {
    const session = synthetic([["2026-10-01", i + 1], ["2026-10-02", 1]], { agent: agents[i], model: `model-${i}`, repository: `repo-${i}` });
    session.provider = providers[i % providers.length]!;
    session.velocity!.dimensions[0]!.effort = effort as SessionVelocity["dimensions"][number]["effort"];
    session.velocity!.dimensions[0]!.executionKind = ["top-level", "subagent", "unknown"][i % 3] as SessionVelocity["dimensions"][number]["executionKind"];
    return session;
  });
  const options = { start: "2026-10-01", end: "2026-10-02" };
  const defaults = buildVelocity(sessions, options);
  assert.equal(defaults.group, "provider");
  assert.deepEqual(defaults.series.map(({ id }) => id), buildVelocity(sessions, { ...options, group: "provider" }).series.map(({ id }) => id));
  for (const group of ["provider", "agent", "model", "repository", "execution", "effort"]) {
    for (const mode of ["lines", "stacked", "cumulative"]) {
      const data = buildVelocity(sessions, { ...options, group, mode });
      const remainder = data.allSeries.slice(6);
      assert.equal(data.series.length, Math.min(7, data.allSeries.length), `${group}/${mode}`);
      assert.deepEqual(data.series.slice(0, 6).map(({ id }) => id), data.allSeries.slice(0, 6).map(({ id }) => id));
      if (remainder.length) {
        const other = data.series.at(-1)!;
        assert.equal(other.id, "other"); assert.equal(other.label, `Other (${remainder.length})`);
        assert.equal(other.calls, remainder.reduce((n, series) => n + series.calls, 0));
        assert.equal(other.sessions, remainder.reduce((n, series) => n + series.sessions, 0));
        for (let index = 0; index < 14; index++) near(other.sums[index]!, remainder.reduce((n, series) => n + series.sums[index]!, 0));
        for (const key of ["known", "eligible", "unsupported"] as const) near(other.evidence[key], remainder.reduce((n, series) => n + series.evidence[key], 0));
      }
      near(data.series.reduce((n, series) => n + series.total, 0), data.totals[0]!);
      near(data.series.reduce((n, series) => n + (mode === "cumulative" ? series.values.at(-1)! : series.values.reduce((sum, value) => sum + value, 0)), 0), data.totals[0]!);
    }
  }
});
