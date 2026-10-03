import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { emptySession, reportedModel, tokens } from "../src/providers/common.ts";
import type { ProviderEvidence, SessionAnalytics } from "../src/types.ts";

class Element {
  tag: string; children: Element[] = []; attributes: Record<string, string> = {}; dataset: Record<string, string> = {};
  style: Record<string, unknown> = { setProperty() {} }; className = ""; value = ""; namespaceURI = "svg"; text = "";
  constructor(tag = "div") { this.tag = tag; }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(" "); }
  get childElementCount() { return this.children.length; }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.children = items; this.text = ""; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener() {}
  querySelectorAll() { return []; }
}
async function harness() {
  const providers = await import(new URL("../src/public/providers.js", import.meta.url).href);
  const elements = new Map<string, Element>();
  const document = { querySelector: (s: string) => { if (!elements.has(s)) elements.set(s, new Element()); return elements.get(s); }, querySelectorAll: () => [], createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag), createTextNode: (text: string) => { const n = new Element("text"); n.textContent = text; return n; } };
  const context = createContext({ ...providers, document, Intl, Set, Map, console });
  let source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  source = source.replace(/^import[^\n]+\n/, "").split('elements.refresh.addEventListener("click"')[0]!;
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
  h.run('renderCostRows(container, [{ name: "Mixed", cost: { total: 10, reported: 90, input: 10, cached: 0, write: 0, output: 0 } }])');
  const bars = descend(container).filter((n) => n.tag === "i" && n.style["width"]);
  assert.equal(bars.reduce((n, b) => n + parseFloat(String(b.style["width"])), 0), 100);
  assert.equal(bars.find((b) => b.dataset["component"] === "reported")!.style["width"], "90%");
});

test("review: distributions label zero/one/sufficient eligible denominators and draw only sufficient series", async () => {
  const h = await harness(), container = new Element(); h.context["container"] = container;
  h.run('snapshot = { repositories: [{repository:{id:"a"}},{repository:{id:"b"}},{repository:{id:"c"}}] }; renderDistributionChart(container, [{id:"a", name:"Missing", sessions:Array(100).fill(null)}, {id:"b",name:"Tiny",sessions:[2]}, {id:"c",name:"Observed",sessions:[1,2,3,4,5]}], x=>x, String)');
  assert.equal(descend(container).filter((n) => n.tag === "polyline").length, 1);
  assert.match(container.textContent, /Missing.*N\/A.*0\/100/); assert.match(container.textContent, /Tiny.*1\/1.*minimum 5/); assert.match(container.textContent, /Observed.*5\/5/);
});

test("review: models display N/A requests for run summaries and coverage for mixed evidence", async () => {
  const h = await harness(); const summary = sample(evidence()); summary.tokens = tokens(100, 0, 0, 20); summary.models = [reportedModel("claude-opus-5", summary.tokens, 1)]; summary.costBasis = "provider-reported";
  h.context["sessions"] = [summary]; h.run('modelMetric="calls"; renderModels({sessions})');
  assert.match(h.elements.get("#models-by-provider")!.textContent, /N\/A/); assert.doesNotMatch(h.elements.get("#models-by-provider")!.textContent, /0 calls/);
  const native = sample(undefined); native.models = [{ ...summary.models[0]!, calls: 2 }]; native.tokens = summary.tokens; native.costBasis = "api-list-price-equivalent";
  h.context["sessions"] = [summary, native]; h.run('renderModels({sessions})'); assert.match(h.elements.get("#models-by-provider")!.textContent, /2 calls.*1\/2/);
});

test("review: invalid and unavailable sessions never imply observed tools or complete repository coverage", async () => {
  const h = await harness(); const invalid = sample(undefined, true), activity = sample(evidence({ source: "cursor-transcript", fidelity: "activity-only", tokens: "unavailable", tools: "observed", usageUnit: "unavailable" }));
  h.context["sessions"] = [invalid, activity];
  assert.equal(h.run('providerEvidenceRows(sessions)[0].toolSessions'), 0);
  h.run('renderRepositoryTable([{repository:{id:"example",name:"Example"},summary:summarize(sessions)}])');
  const output = h.elements.get("#repository-rows")!.textContent;
  assert.match(output, /N\/A/); assert.doesNotMatch(output, /complete/); assert.match(output, /1\/2.*parsed/);
});

test("review: actual summary and Tools rendering distinguish unavailable, observed zero and partial totals", async () => {
  const h = await harness();
  const activity = sample(evidence({ source: "cursor-transcript", fidelity: "activity-only", tokens: "unavailable", tools: "observed", usageUnit: "unavailable" })); activity.provider = "cursor";
  const summary = sample(evidence()); summary.tokens = tokens(100, 0, 0, 20); summary.models = [reportedModel("claude-opus-5", summary.tokens, 1)]; summary.cost.totalUsd = 1; summary.cost.upperEstimateUsd = 1; summary.costBasis = "provider-reported";
  const invalid = sample(undefined, true); invalid.tokens = tokens(999, 0, 0, 999); invalid.metrics.toolCalls = 999; invalid.tools = { Read: 999 };
  for (const sessions of [[activity], [summary], [invalid], [summary, activity]]) {
    h.context["sessions"] = sessions;
    h.run('renderLine=()=>{}; renderDonut=()=>{}; renderProviderEvidence=()=>{}; constRepo={repository:{id:"example",name:"Example"}}; view={sessions,dailySessions:sessions,repositories:[repositoryAggregate(constRepo,sessions)],summary:{...summarize(sessions),repositories:1,repositoriesWithSessions:1,workingSnapshots:0},topTools:namedTotals(sessions,"tools"),spendByModel:mergeModels(sessions),warnings:[]}; renderSummary(view)');
    assert.equal(h.elements.get("#metric-input")!.textContent, sessions.includes(summary) ? sessions.length === 2 ? "100 · 1/2 sessions" : "100" : "N/A");
    assert.equal(h.elements.get("#metric-spend")!.textContent, sessions.includes(summary) ? sessions.length === 2 ? "$1.00 · 1/2 sessions" : "$1.00" : "N/A");
    assert.equal(h.elements.get("#metric-tools")!.textContent, sessions.includes(activity) ? sessions.length === 2 ? "0 · 1/2 sessions" : "0" : "N/A");
    assert.equal(h.elements.get("#metric-compactions")!.textContent, "N/A");
    h.run('renderNamedDistribution({view,field:"tools",keyContainer:elements.toolsKey,tableContainer:elements.toolsByRepository,detailContainer:elements.toolsDetail,detailTitle:elements.toolsDetailTitle,providerScope:"tools"})');
    if (!sessions.includes(activity)) {
      assert.match(h.elements.get("#tools-by-repository")!.textContent, /N\/A/);
      assert.match(h.elements.get("#tools-detail")!.textContent, /N\/A/);
    }
  }
});
