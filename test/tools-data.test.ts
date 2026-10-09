import assert from "node:assert/strict";
import test from "node:test";
import { emptySession } from "../src/providers/common.ts";
import type { SessionAnalytics } from "../src/types.ts";

const { buildToolsView, toolProfile, toolsDays }: typeof import("../src/public/tools-data.js") =
  await import(new URL("../src/public/tools-data.js", import.meta.url).href);

function session(tools: Record<string, number>, overrides: Partial<SessionAnalytics> = {}): SessionAnalytics {
  const result = emptySession({ id: "synthetic", path: "", cwd: null, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:01:00Z" },
    "claude", { repository: { id: "a", name: "A" }, rateCard: { currency: "USD", effectiveDate: "2026-10-01", models: {} }, price: () => { throw Error("unused"); } },
    { source: "conductor-messages", fidelity: "message", tokens: "reported", tools: "observed", turns: "observed", timing: "provider", usageUnit: "request" });
  return Object.assign(result, { tools, metrics: { ...result.metrics, toolCalls: Object.values(tools).reduce((a, b) => a + b, 0) } }, overrides);
}
const unavailable = (tools: Record<string, number> = {}) => {
  const result = session(tools); result.evidence!.tools = "unavailable"; return result;
};

test("tools ranking sorts calls then names, with exact shares and distinct session/repository counts", () => {
  const sessions = [session({ Read: 6, Bash: 2 }), session({ Read: 4, Write: 2 }),
    session({ Read: 2, Bash: 2 }, { provider: "codex", repositoryId: "b", repositoryName: "B" }), session({})];
  const result = buildToolsView(sessions);
  assert.equal(result.totalCalls, 18); assert.equal(result.distinctTools, 3); assert.equal(result.callsPerSession, 4.5);
  assert.deepEqual(result.coverage, { eligible: 4, selected: 4 });
  assert.deepEqual(result.tools.map(({ name, calls, sessions, repositories }) => ({ name, calls, sessions, repositories })), [
    { name: "Read", calls: 12, sessions: 3, repositories: 2 }, { name: "Bash", calls: 4, sessions: 2, repositories: 2 },
    { name: "Write", calls: 2, sessions: 1, repositories: 1 },
  ]);
  assert.equal(result.tools[0]!.share, 12 / 18);
  assert.equal(result.tools.reduce((sum, tool) => sum + tool.share, 0), 1);
  assert.deepEqual(buildToolsView([session({ Z: 2, A: 2, Zero: 0 })]).tools.map((tool) => tool.name), ["A", "Z"]);
});

test("tools coverage excludes missing and invalid evidence without making it observed zero", () => {
  const invalid = session({ Invalid: 1000 }); invalid.transcript.status = "invalid";
  const missing = unavailable({ Missing: 1000 });
  const result = buildToolsView([missing, invalid, session({ Read: 8 }), session({})]);
  assert.deepEqual(result.coverage, { eligible: 2, selected: 4 });
  assert.equal(result.totalCalls, 8); assert.equal(result.callsPerSession, 4); assert.equal(result.eligibleSessions, 2);
  assert.deepEqual(result.tools.map((tool) => tool.name), ["Read"]);
  for (const selection of [[missing], [invalid], []]) {
    const none = buildToolsView(selection);
    assert.equal(none.totalCalls, null); assert.equal(none.distinctTools, null); assert.equal(none.callsPerSession, null);
    assert.deepEqual(none.tools, []);
    const profile = toolProfile(selection, "Read");
    assert.equal(profile.calls, null); assert.equal(profile.sessions, null); assert.equal(profile.repositories, null);
  }
  const zero = buildToolsView([session({})]);
  assert.equal(zero.totalCalls, 0); assert.equal(zero.distinctTools, 0); assert.equal(zero.callsPerSession, 0);
});

test("tools changes compare eligible totals, including increases, decreases, new tools and missing baselines", () => {
  const sessions = [session({ Up: 12, Down: 4, New: 2 })];
  const result = buildToolsView(sessions, { previousSessions: [session({ Up: 8, Down: 8 }), unavailable({ Up: 1000 })] });
  assert.deepEqual(result.tools.map((tool) => [tool.name, tool.previousCalls, tool.change]), [["Up", 8, 0.5], ["Down", 8, -0.5], ["New", 0, "new"]]);
  assert.equal(result.previousCalls, 16); assert.equal(result.change, 2 / 16);
  assert.deepEqual(result.previousCoverage, { eligible: 1, selected: 2 });
  for (const previousSessions of [null, [unavailable({ Up: 100 })]]) {
    const result = buildToolsView(sessions, { previousSessions });
    assert.equal(result.change, null); assert.equal(result.previousCalls, null);
    assert.ok(result.tools.every((tool) => tool.change === null && tool.previousCalls === null));
  }
  for (const previousSessions of [[], [session({})]]) {
    assert.equal(buildToolsView(sessions, { previousSessions }).tools[0]!.change, "new");
  }
  assert.equal(buildToolsView([session({})], { previousSessions: sessions }).change, -1);
  assert.equal(buildToolsView([unavailable()], { previousSessions: sessions }).change, null);
});

test("tool profile conserves calls across UTC days, providers and repositories", () => {
  const sessions = [session({ Read: 6, Bash: 2 }), session({ Read: 4 }, { createdAt: "2026-10-01T23:30:00-02:00" }),
    session({ Read: 2 }, { provider: "codex", repositoryId: "b", repositoryName: "B", createdAt: "2026-10-03T12:00:00Z" }),
    unavailable({ Read: 1000 }), session({})];
  const profile = toolProfile(sessions, "Read", { days: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"], repositoryNames: new Map([["a", "Named A"]]) });
  assert.equal(profile.calls, 12); assert.equal(profile.share, 12 / 14);
  assert.equal(profile.sessions, 3); assert.equal(profile.repositories, 2); assert.equal(profile.callsPerSession, 4);
  assert.deepEqual(profile.byDay.map((row) => row.calls), [6, 4, 2, 0]);
  assert.deepEqual(profile.byProvider.map((row) => [row.label, row.calls]), [["Codex", 2], ["Claude", 10]]);
  assert.deepEqual(profile.byRepository.map((row) => [row.name, row.calls]), [["Named A", 10], ["B", 2]]);
  for (const rows of [profile.byDay, profile.byProvider, profile.byRepository]) assert.equal(rows.reduce((sum, row) => sum + row.calls, 0), profile.calls);
  for (const rows of [profile.byProvider, profile.byRepository]) assert.equal(rows.reduce((sum, row) => sum + row.share, 0), 1);
  assert.equal(profile.undatedCalls, 0); assert.equal(profile.outsideDaysCalls, 0);
});

test("daily profile preserves unavailable evidence and accounts for unknown or unplotted starts", () => {
  const unknown = session({ Read: 3 }); unknown.transcript.startTimeKnown = false;
  const fileTime = session({ Read: 4 }); fileTime.evidence!.timing = "file-mtime";
  const sessions = [unavailable({ Read: 1000 }), unknown, fileTime,
    session({ Read: 2 }, { createdAt: "2026-10-02T12:00:00Z" }), session({ Read: 1 }, { createdAt: "invalid" })];
  const profile = toolProfile(sessions, "Read", { days: ["2026-10-01"] });
  assert.deepEqual(profile.byDay[0]!.coverage, { selected: 1, eligible: 0 });
  assert.equal(profile.calls, 10); assert.equal(profile.undatedCalls, 8); assert.equal(profile.outsideDaysCalls, 2);
  assert.equal(profile.byDay.reduce((sum, row) => sum + row.calls, profile.undatedCalls + profile.outsideDaysCalls), profile.calls);
});

test("all-time day range fills calendar gaps and caps at the latest 366 days", () => {
  assert.deepEqual(toolsDays([]), []);
  assert.deepEqual(toolsDays([session({}), session({}, { createdAt: "2026-10-03T12:00:00Z" })]), ["2026-10-01", "2026-10-02", "2026-10-03"]);
  const sessions = [session({ Read: 2 }, { createdAt: "2020-01-01T00:00:00Z" }), session({ Read: 4 })];
  const days = toolsDays(sessions);
  assert.equal(days.length, 366); assert.equal(days[0], "2025-10-01"); assert.equal(days.at(-1), "2026-10-01");
  const profile = toolProfile(sessions, "Read", { days });
  assert.equal(profile.calls, 6); assert.equal(profile.outsideDaysCalls, 2);
});

test("change labels follow the rounded value, never a signed zero", async () => {
  const { changeLabel } = await import(new URL("../src/public/tools.js", import.meta.url).href);
  assert.equal(changeLabel(null), "—"); assert.equal(changeLabel("new"), "new");
  assert.equal(changeLabel(0.004), "0%"); assert.equal(changeLabel(-0.004), "0%"); assert.equal(changeLabel(0), "0%");
  assert.equal(changeLabel(0.005), "+1%"); assert.equal(changeLabel(-0.12), "−12%"); assert.equal(changeLabel(1), "+100%");
});

test("invalid call counts never count, and zero-call names are not distinct tools", () => {
  const result = buildToolsView([session({ Read: 3, Bad: Number.NaN, Negative: -4, Infinite: Number.POSITIVE_INFINITY, Zero: 0 })]);
  assert.equal(result.totalCalls, 3); assert.equal(result.distinctTools, 1);
  assert.deepEqual(result.tools.map((tool) => tool.name), ["Read"]);
});

test("a provider without a label still appears in the profile split, so the split sums to the tool's calls", () => {
  const profile = toolProfile([session({ Read: 2 }), session({ Read: 3 }, { provider: "future" as SessionAnalytics["provider"] })], "Read", { days: ["2026-10-01"] });
  assert.deepEqual(profile.byProvider.map(({ provider, label, calls }) => ({ provider, label, calls })), [
    { provider: "claude", label: "Claude", calls: 2 }, { provider: "future", label: "future", calls: 3 },
  ]);
  assert.equal(profile.byProvider.reduce((sum, row) => sum + row.calls, 0), profile.calls);
});

test("all-time day range keeps exactly 366 days and clips the 367th", () => {
  const span = (first: string) => toolsDays([session({ Read: 1 }, { createdAt: `${first}T12:00:00Z` }), session({ Read: 1 })]);
  assert.equal(span("2025-10-01").length, 366); assert.equal(span("2025-10-01")[0], "2025-10-01");
  assert.equal(span("2025-09-30").length, 366); assert.equal(span("2025-09-30")[0], "2025-10-01");
  const undated = session({ Read: 1 }); undated.transcript.startTimeKnown = false;
  assert.deepEqual(toolsDays([undated]), []);
});

test("ranking providers are ordered by calls then provider order, with labels and conserved totals", () => {
  const result = buildToolsView([
    session({ Read: 4 }), session({ Read: 2 }), session({ Read: 6 }, { provider: "codex" }),
    session({ Read: 9 }, { provider: "opencode" }), session({ Read: 1 }, { provider: "future" as SessionAnalytics["provider"] }),
  ]);
  assert.deepEqual(result.tools[0]!.providers, [
    { provider: "opencode", label: "OpenCode", calls: 9 }, { provider: "codex", label: "Codex", calls: 6 },
    { provider: "claude", label: "Claude", calls: 6 }, { provider: "future", label: "future", calls: 1 },
  ]);
  assert.equal(result.tools[0]!.providers.reduce((sum, row) => sum + row.calls, 0), result.tools[0]!.calls);
});

test("row and total comparisons guard small baselines without hiding new or unavailable windows", () => {
  for (const [previousCalls, change, smallBaseline] of [[3, null, true], [5, 1, false], [0, "new", false], [null, null, false]] as const) {
    const result = buildToolsView([session({ Read: 10 })], { previousSessions: previousCalls === null ? null : [session({ Read: previousCalls })] });
    for (const comparison of [result, result.tools[0]!]) {
      assert.equal(comparison.previousCalls, previousCalls);
      assert.equal(comparison.change, change);
      assert.equal(comparison.smallBaseline, smallBaseline);
    }
  }
  const zero = buildToolsView([session({})], { previousSessions: [session({})] });
  assert.equal(zero.change, 0); assert.equal(zero.smallBaseline, false);
  const missing = buildToolsView([unavailable()], { previousSessions: [session({ Read: 3 })] });
  assert.equal(missing.change, null); assert.equal(missing.smallBaseline, false);
  const mixed = buildToolsView([session({ Read: 10, Edit: 10 })], { previousSessions: [session({ Read: 3, Edit: 5 })] });
  assert.equal(mixed.change, 1.5); assert.equal(mixed.smallBaseline, false);
  assert.equal(mixed.tools.find(row => row.name === "Read")!.smallBaseline, true);
});
