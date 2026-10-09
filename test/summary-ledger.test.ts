import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { Element } from "./release-dom.ts";

// Summary's usage-value KPI, delta, badge and sidebar read Velocity's activity ledger. These run the
// production functions from app.js unchanged, with deterministic DOM collaborators.
const ui: Record<string, unknown> = await import(new URL("../src/public/ui.js", import.meta.url).href);
const viewModel: Record<string, unknown> = await import(new URL("../src/public/view-model.js", import.meta.url).href);
const velocityData: Record<string, unknown> = await import(new URL("../src/public/velocity-data.js", import.meta.url).href);
const source = fs.readFileSync(new URL("../src/public/app.js", import.meta.url), "utf8");
function productionFunctions(names: string[], context: Record<string, unknown>) {
  const code = names.map((name) => { const start = source.indexOf(`function ${name}(`); return source.slice(start, source.indexOf("\nfunction ", start + 1)); }).join("\n");
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

const bucket = (day: string, value: number, priced = 1) => [day, 12, 0, [value, 100, 100, 0, 0, 20, 0, 4, 0, 0, 120 * priced, 0, 100, 0]];
const session = (repositoryId: string, cells: unknown[]) => ({
  provider: "claude", repositoryId, repositoryName: repositoryId, createdAt: "2026-08-01T12:00:00Z", spendByDay: {}, tokens: { inputTokens: 1, outputTokens: 1 }, metrics: { toolCalls: 0, compactions: 0 },
  velocity: { dimensions: [{ agent: "claude-cli", model: "m", executionKind: "top-level", effort: "unknown" }], buckets: cells, undated: [] },
});
const days = (start: string, end: string) => (velocityData.calendarDays as (a: string, b: string) => string[])(start, end);

function harness(sessions: unknown[], { preset = "7", start = "2026-09-08", end = "2026-09-14", min = "2026-08-01", max = "2026-09-14" } = {}) {
  const elementMap: Record<string, Element> = {};
  const lookup = (key: string) => elementMap[key] ??= new Element();
  const elements = new Proxy({}, { get: (_target, key) => lookup(String(key)) }) as Record<string, Element>;
  const windowStart = elements.windowStart!, windowEnd = elements.windowEnd!;
  windowStart.value = start; windowStart.min = min; windowEnd.value = end; windowEnd.max = max;
  const deltas: Record<string, unknown> = {};
  const repositories = [...new Set((sessions as Array<{ repositoryId: string }>).map(({ repositoryId }) => repositoryId))].map((id) => ({ repository: { id, name: id } }));
  const context = productionFunctions(["renderSummary", "spendDelta", "renderRepositoryNav", "windowDays", "velocityContext", "snapshotTimeZone", "pricedBadge", "executionBreakdown", "subagentValue"], {
    ...ui, ...viewModel, ...velocityData, elements, $: lookup, windowPreset: preset, Map, Set, Intl,
    snapshot: { generatedAt: "2026-09-15T09:00:00Z", velocity: { timeZone: "UTC" }, sessions, repositories },
    wideLayout: { matches: true, addEventListener() {} }, navCache: { key: null }, navHoverListeners: new Set(), navDirty: false,
    node: (tag: string, text?: string, className?: string) => { const e = new Element(tag); e.textContent = text ?? ""; e.className = className ?? ""; return e; },
    svgNode: (tag: string) => new Element(tag), icon: () => new Element("svg"), clear: (e: Element) => e.replaceChildren(),
    money: (v: number) => `$${v.toFixed(2)}`, shortMoney: (v: number) => `$${v.toFixed(2)}`, percent: String, integer: new Intl.NumberFormat("en"), compact: new Intl.NumberFormat("en"),
    renderHistoryCoverage() {}, renderMetricValue() {}, renderSparkline() {}, renderLine() {}, dailyProviderSpend() {}, renderDonut() {}, renderBars() {}, renderRepositoryTable() {}, renderWarnings() {}, selectRepository() {},
    renderDelta: (e: Element, delta: unknown) => { deltas[Object.entries(elementMap).find(([, v]) => v === e)![0]] = delta; },
  });
  const render = () => {
    // activeView's ledger pass: grouped by repository over the scope for the window.
    const window = (context.velocityContext as () => { start: string; end: string })();
    const activity = (velocityData.buildVelocity as (s: unknown[], o: unknown) => unknown)(sessions, { start: window.start, end: window.end, group: "repository", metric: "value" });
    const view = { activity, summary: { topLevelSessions: 0, subagentSessions: 0, coverage: { cost: {}, apiCost: {}, reportedCost: {}, tokens: {}, tools: { eligible: 1 }, compactions: {} } }, sessions, scopeSessions: sessions, dailySessions: sessions, repositories: [], topTools: [], warnings: [] };
    (context.renderSummary as (v: unknown) => void)(view);
  };
  return { context, elements, lookup, deltas, render };
}

test("the Summary delta compares activity-dated value with the preceding window, including earlier starts", () => {
  const sessions = [session("repo-a", [...days("2026-09-01", "2026-09-07").map((d) => bucket(d, 10)), ...days("2026-09-08", "2026-09-14").map((d) => bucket(d, 15))])];
  const h = harness(sessions);
  h.render();
  assert.equal(h.lookup("spend").textContent, "$105.00");
  const delta = h.deltas["#metric-spend-delta"] as { direction: string; text: string };
  assert.equal(delta.direction, "up"); assert.match(delta.text, /50\.0% vs previous 7d/);
  const short = harness([session("repo-a", days("2026-09-08", "2026-09-14").map((d) => bucket(d, 15)))], { min: "2026-09-01" });
  short.render();
  assert.equal(short.deltas["#metric-spend-delta"], null, "An unobserved prior window is not a 100% increase");
});

test("a partially priced window shows its priced share and a partial delta", () => {
  const sessions = [session("repo-a", [...days("2026-09-01", "2026-09-07").map((d) => bucket(d, 10)), ...days("2026-09-08", "2026-09-14").map((d) => bucket(d, 10, 0.95))])];
  const h = harness(sessions);
  h.render();
  assert.equal(h.lookup("spendCoverage").textContent.trim(), "95% priced");
  assert.match((h.deltas["#metric-spend-delta"] as { text: string }).text, /· partial$/);
  const half = harness([session("repo-a", days("2026-09-01", "2026-09-14").map((d) => bucket(d, 10, 0.5)))]);
  half.render();
  assert.equal(half.lookup("spendCoverage").textContent.trim(), "50% priced");
  assert.equal(half.deltas["#metric-spend-delta"], null, "Below 75% priced the change is not shown");
});

test("a quiet window shows $0.00 while a scope with no activity ledger shows a dash", () => {
  const gemini = { provider: "gemini", repositoryId: "repo-a", createdAt: "2026-09-10T10:00:00Z", cost: { totalUsd: 2 }, evidence: { source: "gemini-chat" }, tokens: { inputTokens: 0, outputTokens: 0 }, metrics: { toolCalls: 0, compactions: 0 } };
  const quiet = harness([session("repo-a", [bucket("2026-08-02", 5)]), gemini]);
  quiet.render();
  assert.equal(quiet.lookup("spend").textContent, "$0.00");
  assert.match(quiet.lookup("spendNote").textContent, /across all time, \$0\.00 undated and \$2\.00 in 1 older-snapshot session without activity dates \(refresh to include\)/);
  const none = harness([gemini]);
  none.render();
  assert.equal(none.lookup("spend").textContent, "—");
  const stale = harness([session("repo-a", days("2026-09-01", "2026-09-14").map((d) => bucket(d, 10))), { provider: "claude", repositoryId: "repo-a", createdAt: "2026-09-10T10:00:00Z", tokens: { inputTokens: 0, outputTokens: 0 }, metrics: { toolCalls: 0, compactions: 0 } }]);
  stale.render();
  assert.equal(stale.lookup("spendCoverage").textContent.trim(), "partial");
  assert.match(stale.lookup("spendNote").textContent, /1 session need a refresh/);
});

test("the sidebar totals match the Summary KPI, also when the window inputs are cleared", () => {
  const sessions = [session("repo-a", days("2026-09-01", "2026-09-14").map((d) => bucket(d, 10))), session("repo-b", days("2026-09-10", "2026-09-14").map((d) => bucket(d, 3)))];
  for (const window of [{}, { start: "", end: "", preset: "custom" }]) {
    const h = harness(sessions, window);
    h.render();
    (h.context.renderRepositoryNav as () => void)();
    const navCache = h.context.navCache as { total: number; rows: Array<{ id: string; value: number; series: number[] }> };
    assert.equal(`$${navCache.total.toFixed(2)}`, h.lookup("spend").textContent);
    assert.equal(navCache.rows.find(({ id }) => id === "repo-b")?.value, 15);
    assert.equal(navCache.rows[0]?.series.length, (h.context.windowDays as () => string[])().length);
  }
});

test("session-dated value counts in the Summary KPI and its note says how much", () => {
  const receipt = { ...session("repo-a", []), velocity: { dimensions: [{ agent: "claude-sdk", model: "m", executionKind: "unknown", effort: "unknown" }], buckets: [], undated: [], sessionDated: [bucket("2026-09-12", 4)] } };
  const h = harness([session("repo-a", days("2026-09-08", "2026-09-14").map((d) => bucket(d, 10))), receipt]);
  h.render();
  assert.equal(h.lookup("spend").textContent, "$74.00");
  assert.match(h.lookup("spendNote").textContent, /includes \$4\.00 session-dated \(1 session without request times, dated by last activity\)/);
  const plain = harness([session("repo-a", days("2026-09-08", "2026-09-14").map((d) => bucket(d, 10)))]);
  plain.render();
  assert.doesNotMatch(plain.lookup("spendNote").textContent, /session-dated/);
});
