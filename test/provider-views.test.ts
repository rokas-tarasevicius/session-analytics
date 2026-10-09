import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { emptySession, reportedModel, tokens } from "../src/providers/common.ts";
import type { ProviderEvidence, SessionAnalytics } from "../src/types.ts";

class Element {
  tag: string; children: Element[] = []; attributes: Record<string, string> = {}; dataset: Record<string, string> = {};
  style: Record<string, unknown> = { setProperty(name: string, value: string) { this[name] = value; } }; className = ""; value = ""; namespaceURI = "svg"; text = "";
  listeners: Record<string, () => void> = {};
  constructor(tag = "div") { this.tag = tag; }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(" "); }
  get childElementCount() { return this.children.length; }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.children = items; this.text = ""; }
  viewBox = { baseVal: { width: 680, height: 230 } };
  removeAttribute(key: string) { delete this.attributes[key]; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(name: string, listener: () => void) { this.listeners[name] = listener; }
  removeEventListener() {}
  querySelectorAll() { return []; }
  querySelector() { return new Element(); }
  classList = { add() {}, remove() {}, toggle() {} };
  getBoundingClientRect() { return { width: 680, height: 230 }; }
}
async function harness() {
  const providers = await import(new URL("../src/public/providers.js", import.meta.url).href);
  const elements = new Map<string, Element>();
  const document = { addEventListener() {}, querySelector: (s: string) => { if (!elements.has(s)) elements.set(s, new Element()); return elements.get(s); }, querySelectorAll: () => [], createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag), createTextNode: (text: string) => { const n = new Element("text"); n.textContent = text; return n; } };
  const viewModel = await import(new URL("../src/public/view-model.js", import.meta.url).href);
  const evidenceHelpers = await import(new URL("../src/public/evidence.js", import.meta.url).href);
  const exportHelpers = await import(new URL("../src/public/export-data.js", import.meta.url).href);
  const ui = await import(new URL("../src/public/ui.js", import.meta.url).href);
  const velocityData = await import(new URL("../src/public/velocity-data.js", import.meta.url).href);
  const tools = await import(new URL("../src/public/tools.js", import.meta.url).href);
  const toolsData = await import(new URL("../src/public/tools-data.js", import.meta.url).href);
  const charts = Object.assign({}, ...await Promise.all(["chart-colors", "chart-scale", "chart-legend"].map((name) => import(new URL(`../src/public/${name}.js`, import.meta.url).href))));
  const context = createContext({ renderHistoryCoverage() {}, ...charts, ...providers, ...viewModel, ...evidenceHelpers, ...exportHelpers, ...ui, ...velocityData, ...tools, ...toolsData, document, Intl, Set, Map, console, HTMLElement: Element,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) }, localStorage: { getItem: () => null }, URLSearchParams });
  let source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  source = source.replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, "").split("const urlParameters =")[0]!;
  // Shared components resolve `document` at call time, so the stub is exposed as the global for this harness.
  (globalThis as any).document = document;
  runInContext(source, context);
  return { elements, context, run: (js: string) => runInContext(js, context) };
}
const evidence = (overrides: Partial<ProviderEvidence> = {}): ProviderEvidence => ({ source: "conductor-result", fidelity: "summary", tokens: "reported", tools: "unavailable", turns: "unavailable", timing: "provider", usageUnit: "run", ...overrides });
function sample(e: ProviderEvidence | undefined, invalid = false): SessionAnalytics {
  const s = emptySession({ id: "test", path: "", cwd: null, createdAt: "2026-07-20T09:00:00Z", updatedAt: "2026-07-20T09:05:00Z" }, "claude", { repository: { id: "example", name: "Example" }, rateCard: { currency: "USD", effectiveDate: "2026-07-20", models: {} }, price: () => { throw Error("unused"); } }, e!);
  if (!e) delete s.evidence;
  if (invalid) s.transcript.status = "invalid";
  return s;
}
const descend = (node: Element): Element[] => [node, ...node.children.flatMap(descend)];

test("review: mixed reported/API cost stacks represent the displayed total", async () => {
  const h = await harness(), container = new Element(); h.context["container"] = container;
  h.run('renderCostRows(container, { total: 100, evidence: { known: 0, eligible: 0, unsupported: 0, complete: true }, providers: [{ provider: "claude", total: 100, unattributed: 90, models: [{ model: "claude-opus-5", value: 10 }], evidence: { known: 0, eligible: 0, unsupported: 0, complete: true } }] })');
  const bars = descend(container).filter((n) => n.tag === "i" && n.style["width"]);
  assert.equal(bars.reduce((n, b) => n + parseFloat(String(b.style["width"])), 0), 100);
  assert.equal(bars.find((b) => b.attributes["data-series"] === "claude:unattributed")!.style["width"], "90%");
  // The provider rows are followed by the window total they add up to.
  assert.match(container.textContent, /Total\s+\$100\.00/);
});

/** One ledger cell for `model` on 2026-07-20 carrying `value`, 100 input / 20 output tokens and `calls` model calls. */
function ledger(session: SessionAnalytics, model: string, value: number, { calls = 0, priced = 120 } = {}): SessionAnalytics {
  session.velocity = { dimensions: [{ agent: "claude-sdk", model, executionKind: "top-level", effort: "unknown" }], buckets: [["2026-07-20", 9, 0, [value, 100, 50, 50, 0, 20, 0, calls, 0, 0, priced, 0, 100, 0]]], undated: [] };
  return session;
}

test("review: Costs models show ledger calls and price coverage for mixed evidence", async () => {
  const h = await harness(); const summary = ledger(sample(evidence()), "claude-opus-5", 1); summary.costBasis = "provider-reported";
  const partial = ledger(sample(evidence()), "claude-opus-5", 1, { priced: 60 }); partial.costBasis = "provider-reported";
  h.context["sessions"] = [summary, partial]; h.run('renderModelCosts(elements.costModels, ledgerMoney(sessions, { start: "2026-07-20", end: "2026-07-20" }))');
  // Half of the second receipt's tokens are priced: 180 of 240 eligible tokens, so the row says 75% priced.
  assert.match(h.elements.get("#cost-models")!.textContent, /\$2.00.*75% priced/);
  assert.doesNotMatch(h.elements.get("#cost-models")!.textContent, /\b0 calls/, "run summaries have no request evidence, so no call count is implied");
  const native = ledger(sample(undefined), "claude-opus-5", 1, { calls: 2 }); native.costBasis = "api-list-price-equivalent";
  h.context["sessions"] = [summary, native]; h.run('renderModelCosts(elements.costModels, ledgerMoney(sessions, { start: "2026-07-20", end: "2026-07-20" }))');
  assert.match(h.elements.get("#cost-models")!.textContent, /2 sessions · 2 calls/);
  assert.match(h.elements.get("#cost-models")!.textContent, /\$2\.00/);
});

test("review: invalid and unavailable sessions never imply observed tools or complete repository coverage", async () => {
  const h = await harness(); const invalid = sample(undefined, true), activity = sample(evidence({ source: "cursor-transcript", fidelity: "activity-only", tokens: "unavailable", tools: "observed", usageUnit: "unavailable" }));
  h.context["sessions"] = [invalid, activity];
  assert.equal(h.run('providerEvidenceRows(sessions)[0].toolSessions'), 0);
  h.run('renderRepositoryTable([{repository:{id:"example",name:"Example"},summary:summarize(sessions),usage:{value:0,evidence:{known:0,eligible:0,unsupported:0,complete:true},available:false}}])');
  const output = h.elements.get("#repository-rows")!.textContent;
  // No activity ledger: the value is unavailable, not $0.00, and no priced share is claimed.
  assert.match(output, /—/); assert.doesNotMatch(output, /complete|N\/A|\$0\.00/); assert.match(output, /1\/2.*parsed/);
});

test("review: actual summary and Tools rendering distinguish unavailable, observed zero and partial totals", async () => {
  const h = await harness();
  const activity = sample(evidence({ source: "cursor-transcript", fidelity: "activity-only", tokens: "unavailable", tools: "observed", usageUnit: "unavailable" })); activity.provider = "cursor";
  const summary = sample(evidence()); summary.tokens = tokens(100, 0, 0, 20); summary.models = [reportedModel("claude-opus-5", summary.tokens, 1)]; summary.cost.totalUsd = 1; summary.cost.upperEstimateUsd = 1; summary.costBasis = "provider-reported";
  const invalid = sample(undefined, true); invalid.tokens = tokens(999, 0, 0, 999); invalid.metrics.toolCalls = 999; invalid.tools = { Read: 999 };
  for (const sessions of [[activity], [summary], [invalid], [summary, activity]]) {
    h.context["sessions"] = sessions;
    h.run('snapshot={sessions}; renderLine=()=>{}; renderDonut=()=>{}; renderProviderEvidence=()=>{}; constRepo={repository:{id:"example",name:"Example"}}; view={activity:buildVelocity(sessions,{start:"",end:"",group:"repository"}),sessions,dailySessions:sessions,scopeSessions:sessions,repositories:[repositoryAggregate(constRepo,sessions)],summary:{...summarize(sessions),repositories:1,repositoriesWithSessions:1,workingSnapshots:0},topTools:namedTotals(sessions,"tools"),warnings:[]}; renderSummary(view)');
    // Values stay bare; the eligible/selected share moves to the coverage badge beside the value.
    assert.equal(h.elements.get("#metric-input")!.textContent, sessions.includes(summary) ? "100" : "—");
    const selected = `${sessions.length} selected ${sessions.length === 1 ? "session" : "sessions"}`;
    assert.equal(h.elements.get("#metric-input-coverage")!.textContent.trim(), sessions.includes(summary) ? sessions.length === 2 ? "1/2 1 of 2 selected sessions provide token evidence" : "" : `No token evidence in ${selected}`);
    // The headline is the activity-dated ledger shared with Velocity. A provider-reported summary has no
    // activity dates, so the headline is unavailable and its whole-session value is disclosed, not hidden.
    assert.equal(h.elements.get("#metric-spend")!.textContent, "—");
    assert.equal(h.elements.get("#metric-spend-coverage")!.textContent.trim(), "");
    const note = h.elements.get("#metric-spend-note")!.textContent;
    if (sessions.includes(summary)) assert.match(note, /\$1\.00 in \d older-snapshot sessions? without activity dates/);
    assert.equal(h.elements.get("#metric-tools")!.textContent, sessions.includes(activity) ? "0" : "—");
    assert.equal(h.elements.get("#metric-tools-coverage")!.textContent.trim(), sessions.includes(activity) ? sessions.length === 2 ? "1/2 1 of 2 selected sessions provide tool evidence" : "" : `No tool evidence in ${selected}`);
    assert.equal(h.elements.get("#metric-compactions")!.textContent, "—");
    h.run('renderTools(view)');
    const renderedTools = h.elements.get("#tools-view")!;
    const callsKpi = descend(renderedTools).find((node) => node.className === "kpi")!;
    assert.equal(callsKpi.children.find((node) => node.tag === "strong")!.textContent, sessions.includes(activity) ? "0" : "—");
    if (!sessions.includes(activity)) {
      assert.match(renderedTools.textContent, /—/);
      assert.doesNotMatch(renderedTools.textContent, /0 calls|999/);
    }
    if (sessions.length === 2) assert.match(renderedTools.textContent, /1\/2/);
  }
});

test("Tools ranking selects and retains a profile, expands, and resets when the selected tool disappears", async () => {
  const h = await harness(), native = sample(undefined);
  native.tools = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`tool_${i}`, 15 - i]));
  native.metrics.toolCalls = 120;
  h.context["sessions"] = [native];
  h.run('windowPreset="all"; view={sessions,repositories:[]}; renderActiveAnalyticsView=renderTools; renderTools(view)');
  const container = h.elements.get("#tools-view")!;
  const buttons = () => descend(container).filter((node) => node.className === "tools-select");
  assert.equal(buttons().length, 12); assert.equal(h.run("toolsSelectedName"), "tool_0");
  // The All window has no previous period: the KPI says so and every Change cell is an em dash, never 0%.
  assert.match(container.textContent, /Effective calls in this selection/); assert.doesNotMatch(container.textContent, /vs previous window/);
  const changeCells = descend(container).filter((node) => node.tag === "tr").slice(1).map((row) => row.children.at(-1)!.textContent);
  assert.equal(changeCells.length, 12); assert.ok(changeCells.every((cell) => cell === "—"));
  assert.equal(buttons()[0]!.attributes["aria-pressed"], "true");
  buttons()[1]!.listeners["click"]!();
  assert.equal(h.run("toolsSelectedName"), "tool_1");
  assert.equal(buttons()[1]!.attributes["aria-pressed"], "true");
  assert.equal(buttons()[1]!.dataset["focusKey"], "tools:tool:tool_1");
  descend(container).find((node) => node.dataset["focusKey"] === "tools:toggle")!.listeners["click"]!();
  assert.equal(buttons().length, 15); assert.match(container.textContent, /Show fewer/);
  buttons()[14]!.listeners["click"]!();
  descend(container).find((node) => node.dataset["focusKey"] === "tools:toggle")!.listeners["click"]!();
  assert.equal(buttons().length, 12); assert.equal(h.run("toolsSelectedName"), "tool_14");
  h.run("renderTools(view)"); assert.equal(h.run("toolsSelectedName"), "tool_14");
  delete native.tools["tool_14"];
  h.run("renderTools(view)"); assert.equal(h.run("toolsSelectedName"), "tool_0");
  for (const chart of descend(container).filter((node) => node.attributes["role"] === "img")) assert.ok(chart.attributes["aria-label"]);
  const fills = descend(container).filter((node) => node.className === "bar-track tools-bar").map((node) => node.children[0]!);
  assert.equal(fills[0]!.style["width"], "100%"); assert.equal(fills[1]!.style["width"], `${14 / 15 * 100}%`);
  assert.match(container.textContent, /no cost or duration of their own/);
});

test("Tools compares the same provider selection and combines excess repositories without losing calls", async () => {
  const h = await harness();
  const sessions = Array.from({ length: 10 }, (_, i) => {
    const item = sample(undefined); item.tools = { Read: 10 - i }; item.repositoryId = `repo_${i}`; item.repositoryName = `Repo ${i}`;
    item.createdAt = "2026-07-20T09:00:00Z"; return item;
  });
  const previous = sample(undefined); previous.tools = { Read: 50 }; previous.createdAt = "2026-07-19T09:00:00Z";
  const excluded = sample(undefined); excluded.provider = "codex"; excluded.tools = { Read: 1000 }; excluded.createdAt = previous.createdAt;
  h.context["sessions"] = sessions; h.context["scopeSessions"] = [...sessions, previous, excluded];
  h.run('elements.windowStart.value="2026-07-20"; elements.windowStart.min="2026-07-01"; elements.windowEnd.value="2026-07-20"; viewProviderFilters.tools=new Set(["claude"]); view={sessions,scopeSessions,repositories:[]}; renderTools(view)');
  const container = h.elements.get("#tools-view")!;
  assert.match(container.textContent, /\+10% vs previous window/);
  assert.match(container.textContent, /Other 3/);
  assert.doesNotMatch(container.textContent, /1,000/);
  const repositories = descend(container).find((node) => node.className === "tools-breakdown" && node.textContent.startsWith("By repository"))!;
  const widths = descend(repositories).filter((node) => node.className === "bar-track tools-bar").map((node) => parseFloat(String(node.children[0]!.style["width"])));
  assert.equal(widths.length, 9); assert.ok(Math.abs(widths.reduce((sum, width) => sum + width, 0) - 100) < 1e-10);
  h.run('clearInactiveAnalyticsViews("summary")');
  assert.equal(container.textContent, "");
});

test("Tools daily columns start at zero and unavailable days never present zero calls", async () => {
  const h = await harness(), first = sample(undefined), last = sample(undefined), missing = sample(evidence());
  first.tools = { Read: 2 }; last.tools = { Read: 8 };
  first.createdAt = "2026-07-20T09:00:00Z"; missing.createdAt = "2026-07-21T09:00:00Z"; last.createdAt = "2026-07-22T09:00:00Z";
  h.context["sessions"] = [first, missing, last];
  h.run('windowPreset="all"; view={sessions,repositories:[]}; renderTools(view)');
  const container = h.elements.get("#tools-view")!;
  const columns = descend(container).filter((node) => node.className === "tools-column");
  assert.deepEqual(columns.map((column) => column.children[0]!.style["height"]), ["25%", "0%", "100%"]);
  assert.match(columns[1]!.attributes["title"]!, /— no tool evidence/);
  assert.doesNotMatch(columns[1]!.attributes["title"]!, /0 calls/);
  first.transcript.startTimeKnown = false; last.transcript.startTimeKnown = false;
  h.run("renderTools(view)");
  const trend = descend(container).find((node) => node.className === "tools-trend")!;
  assert.match(trend.textContent, /— No tool evidence/);
  assert.match(trend.textContent, /10 calls have no known session-start day/);
  assert.doesNotMatch(trend.textContent, /0 calls plotted/);
});
