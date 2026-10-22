import { compact, dateLabel, dateRange, integer } from "../src/public/format.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { Element } from "./release-dom.ts";

// Summary's usage-value KPI, delta, badge and sidebar read Velocity's activity ledger. These run the
// production functions from app.js unchanged, with deterministic DOM collaborators.
const ui: Record<string, unknown> = await import(new URL("../src/public/ui.js", import.meta.url).href);
const providers: Record<string, unknown> = await import(new URL("../src/public/providers.js", import.meta.url).href);
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
  const context = productionFunctions(["renderSummary", "renderCoverageSummary", "appendSourceChecks", "spendDelta", "renderRepositoryNav", "windowDays", "velocityContext", "snapshotTimeZone", "pricedBadge", "executionBreakdown", "subagentValue"], {
    ...ui, ...providers, ...viewModel, ...velocityData, elements, $: lookup, windowPreset: preset, Map, Set, Intl,
    snapshot: { generatedAt: "2026-09-15T09:00:00Z", velocity: { timeZone: "UTC" }, sessions, repositories },
    fullSnapshot: null, renderMachineSpend() {}, wideLayout: { matches: true, addEventListener() {} }, navCache: { key: null }, navHoverListeners: new Set(), navDirty: false,
    node: (tag: string, text?: string, className?: string) => { const e = new Element(tag); e.textContent = text ?? ""; e.className = className ?? ""; return e; },
    svgNode: (tag: string) => new Element(tag), icon: () => new Element("svg"), clear: (e: Element) => e.replaceChildren(),
    money: (v: number) => `$${v.toFixed(2)}`, shortMoney: (v: number) => `$${v.toFixed(2)}`, percent: String, integer, compact,
    selectedRepository: () => null, repositorySessions: (id: string) => (sessions as Array<{ repositoryId: string }>).filter((s) => s.repositoryId === id), emptyState() {}, dateLabel, dateRange, renderHistoryCoverage() {}, renderMetricValue() {}, renderSparkline() {}, renderLine() {}, dailyProviderSpend() {}, renderDonut() {}, renderBars() {}, renderRepositoryTable() {}, renderWarnings() {}, selectRepository() {},
    renderDelta: (e: Element, delta: unknown) => { deltas[Object.entries(elementMap).find(([, v]) => v === e)![0]] = delta; },
  });
  const render = () => {
    // activeView's ledger pass: grouped by repository over the scope for the window.
    const window = (context.velocityContext as () => { start: string; end: string })();
    const activity = (velocityData.buildVelocity as (s: unknown[], o: unknown) => unknown)(sessions, { start: window.start, end: window.end, group: "repository", metric: "value" });
    const view = { activity, summary: { topLevelSessions: 0, subagentSessions: 0, coverage: { cost: {}, apiCost: {}, reportedCost: {}, tokens: {}, tools: { eligible: 1 }, compactions: {} } }, sessions, scopeSessions: sessions, dailySessions: sessions, repositories: [], topTools: [], warnings: [] };
    (context.renderSummary as (v: unknown) => void)(view);
    (context.renderCoverageSummary as (v: unknown) => void)(view);
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
  assert.equal(half.deltas["#metric-spend-delta"], null, "Below 90% priced the change is not shown");
});

test("a quiet window shows $0.00 while a scope with no activity ledger shows a dash", () => {
  const gemini = { provider: "gemini", repositoryId: "repo-a", createdAt: "2026-09-10T10:00:00Z", cost: { totalUsd: 2 }, evidence: { source: "gemini-chat" }, tokens: { inputTokens: 0, outputTokens: 0 }, metrics: { toolCalls: 0, compactions: 0 } };
  const quiet = harness([session("repo-a", [bucket("2026-08-02", 5)]), gemini]);
  quiet.render();
  assert.equal(quiet.lookup("spend").textContent, "$0.00");
  assert.match(quiet.lookup("coverageUsageNote").textContent, /across all time, \$0\.00 undated and \$2\.00 in 1 older-snapshot session without activity dates \(refresh to include\)/);
  const none = harness([gemini]);
  none.render();
  assert.equal(none.lookup("spend").textContent, "—");
  const stale = harness([session("repo-a", days("2026-09-01", "2026-09-14").map((d) => bucket(d, 10))), { provider: "claude", repositoryId: "repo-a", createdAt: "2026-09-10T10:00:00Z", tokens: { inputTokens: 0, outputTokens: 0 }, metrics: { toolCalls: 0, compactions: 0 } }]);
  stale.render();
  assert.equal(stale.lookup("spendCoverage").textContent.trim(), "partial");
  assert.match(stale.lookup("coverageUsageNote").textContent, /1 session need a refresh/);
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

test("session-dated value counts in the Summary KPI and Coverage says how much", () => {
  const receipt = { ...session("repo-a", []), velocity: { dimensions: [{ agent: "claude-sdk", model: "m", executionKind: "unknown", effort: "unknown" }], buckets: [], undated: [], sessionDated: [bucket("2026-09-12", 4)] } };
  const h = harness([session("repo-a", days("2026-09-08", "2026-09-14").map((d) => bucket(d, 10))), receipt]);
  h.render();
  assert.equal(h.lookup("spend").textContent, "$74.00");
  assert.match(h.lookup("coverageUsageNote").textContent, /includes \$4\.00 session-dated \(1 session without request times, dated by last activity\)/);
  const plain = harness([session("repo-a", days("2026-09-08", "2026-09-14").map((d) => bucket(d, 10)))]);
  plain.render();
  assert.doesNotMatch(plain.lookup("coverageUsageNote").textContent, /session-dated/);
});

test("a focused repository keeps provider values and a full-fleet comparator on the same ledgers", async () => {
  const { harness: dashboard, sample, withLedger } = await import("./validation/aggregation-ui-harness.ts");
  const make = (id: string, provider: "claude" | "codex", value: number, executionKind = "top-level") => {
    const s = withLedger(sample(), [["synthetic", value]], { day: "2026-09-30", executionKind });
    s.repositoryId = id; s.repositoryName = id; s.provider = provider;
    if (executionKind === "subagent") s.executionKind = "subagent";
    return s;
  };
  const sessions = [make("data-pipeline", "claude", 11.90, "subagent"), make("data-pipeline", "codex", 5), make("other", "claude", 20)];
  const { document, run } = await dashboard(sessions, { repositories: [{ id: "data-pipeline", name: "data-pipeline" }, { id: "other", name: "other" }], start: "2026-09-13", end: "2026-10-12" });
  run("populateRepositories(); selectRepository('data-pipeline', { scroll: false })");
  assert.equal(document.querySelector("#scope-description")!.textContent, "data-pipeline · 2 sessions · 13 Sept – 12 Oct 2026 (Europe/London)");
  assert.equal(document.querySelector("#repository-spend-title")!.textContent, "Usage value by provider");
  assert.equal(document.querySelector("#repository-tokens-title")!.textContent, "Request input by provider");
  assert.deepEqual(document.querySelector("#repository-spend")!.querySelectorAll(".bar-label").map((e) => e.textContent.trim()), ["Claude $11.90", "Codex $5.00"]);
  assert.equal(document.querySelector("#repository-tokens")!.querySelectorAll(".bar-row").length, 2);
  assert.equal(document.querySelector("#repository-subagent-spend")!.hidden, true);
  assert.equal(document.querySelector("#repository-subagent-spend")!.children.length, 0);
  assert.equal(document.querySelector("#subagent-note")!.textContent, "Sub-agent value $11.90 · 1 sub-agent session");
  assert.equal(document.querySelector("#comparison-title")!.textContent, "data-pipeline vs fleet");
  const rows = document.querySelector("#repository-rows")!.querySelectorAll("tr");
  assert.equal(rows.length, 2); assert.equal(rows[0]!.getAttribute("aria-current"), "true");
  assert.deepEqual(rows.map((e) => [e.children[0]!.textContent.trim(), e.children[1]!.textContent.trim(), e.children[2]!.textContent.trim()]), [["data-pipeline", "2", "$16.90"], ["All repositories", "3", "$36.90"]]);
  assert.equal(rows[1]!.className, "fleet-total"); assert.equal(rows[1]!.querySelector("button"), null);
  assert.equal(document.querySelector("#metric-spend")!.textContent, "$16.90");
  const hint = document.querySelector("#repository-table-hint")!;
  assert.equal(hint.textContent.trim().replace(/\s+/g, " "), "Showing data-pipeline · Clear focus");
  hint.querySelector("button")!.listeners.get("click")!();
  assert.equal(run("elements.repositoryFilter.value"), "all");
  assert.equal(document.querySelector("#comparison-title")!.textContent, "Repositories");
  assert.equal(document.querySelector("#repository-spend-title")!.textContent, "Usage value by repository");
  assert.equal(document.querySelector("#repository-subagent-spend")!.hidden, false);
  assert.equal(document.querySelector("#subagent-note")!.hidden, true);
  assert.equal(document.querySelector("#metric-spend")!.textContent, "$36.90");
});

test("quiet repository panels collapse and the Show them footer reveals unchanged fleet rows", async () => {
  const { harness: dashboard, sample, withLedger } = await import("./validation/aggregation-ui-harness.ts");
  const active = withLedger(sample(), [["synthetic", 0.15]], { day: "2026-07-24" });
  active.createdAt = "2026-07-24T12:00:00Z";
  const quiet = withLedger(sample(), [["synthetic", 9]], { day: "2026-07-01" });
  quiet.createdAt = "2026-07-01T12:00:00Z"; quiet.repositoryId = "quiet"; quiet.repositoryName = "Quiet";
  const repositories = [{ id: "synthetic", name: "Synthetic" }, { id: "quiet", name: "Quiet" }, { id: "empty", name: "Empty" }];
  const { document, run } = await dashboard([active, quiet], { repositories, start: "2026-07-01", end: "2026-07-30" });
  run("windowPreset = 'custom'; setWindowInputs('2026-07-24', '2026-07-24'); renderView()");
  for (const id of ["repository-spend", "repository-tokens"]) {
    const panel = document.querySelector(`#${id}`)!;
    assert.equal(panel.querySelectorAll(".bar-row").length, 1);
    assert.equal(panel.querySelector(".empty-line")!.textContent, "2 repositories had no activity in this window");
  }
  assert.equal(document.querySelector("#repository-rows")!.querySelectorAll("tr").length, 1);
  const footer = document.querySelector("#repository-footer")!;
  assert.equal(footer.textContent.trim().replace(/\s+/g, " "), "2 repositories without sessions · Show them");
  footer.querySelector("button")!.listeners.get("click")!();
  const rows = document.querySelector("#repository-rows")!.querySelectorAll("tr");
  assert.deepEqual(rows.map((e) => [e.children[0]!.textContent.trim(), e.children[1]!.textContent.trim(), e.children[2]!.textContent.trim()]), [["Synthetic", "1", "$0.15"], ["Quiet", "0", "$0.00"], ["Empty", "0", "—"]]);
  assert.equal(footer.children.length, 0);
  assert.equal(document.querySelector("#metric-spend")!.textContent, "$0.15");
  run("tableSort = { key: 'name', direction: 'ascending' }; renderRepositoryTable(activeView().repositories)");
  assert.equal(document.querySelector("#repository-rows")!.querySelectorAll("tr").length, 3, "sorting preserves expansion");
  run("setWindowInputs('2026-07-25', '2026-07-25'); renderRepositoryTable(activeView().repositories)");
  assert.match(footer.textContent, /3 repositories without sessions/);
});

test("activity from an earlier start stays in repository panels and behind the fleet footer", async () => {
  const { harness: dashboard, sample, withLedger } = await import("./validation/aggregation-ui-harness.ts");
  const session = withLedger(sample(), [["synthetic", 2]], { day: "2026-07-24" });
  session.createdAt = "2026-07-01T12:00:00Z";
  const { document, run } = await dashboard([session], { start: "2026-07-01", end: "2026-07-30" });
  run("windowPreset = 'custom'; setWindowInputs('2026-07-24', '2026-07-24'); renderView()");
  assert.equal(document.querySelector("#metric-spend")!.textContent, "$2.00");
  const bars = document.querySelector("#repository-spend")!;
  assert.equal(bars.querySelectorAll(".bar-row").length, 1);
  assert.match(bars.textContent, /\$2.00/); assert.equal(bars.querySelector(".empty-line"), null);
  assert.match(document.querySelector("#repository-rows")!.textContent, /No repositories with sessions in this window/);
  const footer = document.querySelector("#repository-footer")!;
  assert.match(footer.textContent, /1 repository without sessions/);
  footer.querySelector("button")!.listeners.get("click")!();
  assert.equal(document.querySelector("#repository-rows")!.querySelector("tr")!.children[2]!.textContent.trim(), "$2.00");
});

test("a focused repository with ledger-less sub-agent sessions shows a dash, not a measured zero", async () => {
  const { harness: dashboard, sample, withLedger } = await import("./validation/aggregation-ui-harness.ts");
  const ledgered = withLedger(sample(), [["synthetic", 5]], { day: "2026-09-30" });
  ledgered.repositoryId = "data-pipeline"; ledgered.repositoryName = "data-pipeline";
  const subagent = sample();
  subagent.repositoryId = "data-pipeline"; subagent.repositoryName = "data-pipeline"; subagent.executionKind = "subagent";
  delete (subagent as { velocity?: unknown }).velocity;
  const { document, run } = await dashboard([ledgered, subagent], { repositories: [{ id: "data-pipeline", name: "data-pipeline" }], start: "2026-09-13", end: "2026-10-12" });
  run("populateRepositories(); selectRepository('data-pipeline', { scroll: false })");
  assert.equal(document.querySelector("#subagent-note")!.textContent, "Sub-agent value — · 1 sub-agent session · no activity dates");
  assert.equal(document.querySelector("#metric-spend")!.textContent, "$5.00");
});


test("Costs never presents wholly unpriced model, provider or total value as free", async () => {
  const { harness: dashboard, sample, withLedger } = await import("./validation/aggregation-ui-harness.ts");
  for (const priced of [false, true]) {
    const session = withLedger(sample(), [["unpriced-or-zero-rate", 0]], { priced });
    const { document, run } = await dashboard([session]);
    run("renderCosts(activeView())");
    const models = document.querySelector("#cost-models")!;
    const model = models.querySelector(".cost-model-row")!;
    const providers = document.querySelector("#provider-cost-models")!;
    assert.equal(model.querySelector("strong")!.textContent.trim(), priced ? "$0.00" : "— 0% priced");
    assert.equal(model.querySelector(".cost-model-share")!.textContent, priced ? "0.0%" : "—");
    assert.equal(document.querySelector("#cost-total")!.textContent, priced ? "$0.00" : "—");
    if (!priced) {
      assert.match(model.textContent, /unpriced/);
      assert.doesNotMatch((model as Element & { title: string }).title, /\$0\.00|0\.0% of total/);
      assert.doesNotMatch(providers.textContent, /\$0\.00/);
      assert.doesNotMatch(document.querySelector("#cost-reconciliation")!.textContent, /^\$0\.00/);
    }
  }
});
