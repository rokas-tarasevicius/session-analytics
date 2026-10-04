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
  viewBox = { baseVal: { width: 680, height: 230 } };
  removeAttribute(key: string) { delete this.attributes[key]; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener() {}
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
  const context = createContext({ renderHistoryCoverage() {}, ...providers, ...viewModel, ...evidenceHelpers, ...exportHelpers, ...ui, document, Intl, Set, Map, console, HTMLElement: Element,
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
  assert.match(h.elements.get("#models-by-provider")!.textContent, /—/); assert.doesNotMatch(h.elements.get("#models-by-provider")!.textContent, /0 calls|N\/A/);
  const native = sample(undefined); native.models = [{ ...summary.models[0]!, calls: 2 }]; native.tokens = summary.tokens; native.costBasis = "api-list-price-equivalent";
  h.context["sessions"] = [summary, native]; h.run('renderModels({sessions})'); assert.match(h.elements.get("#models-by-provider")!.textContent, /2 calls.*1\/2/);
});

test("review: invalid and unavailable sessions never imply observed tools or complete repository coverage", async () => {
  const h = await harness(); const invalid = sample(undefined, true), activity = sample(evidence({ source: "cursor-transcript", fidelity: "activity-only", tokens: "unavailable", tools: "observed", usageUnit: "unavailable" }));
  h.context["sessions"] = [invalid, activity];
  assert.equal(h.run('providerEvidenceRows(sessions)[0].toolSessions'), 0);
  h.run('renderRepositoryTable([{repository:{id:"example",name:"Example"},summary:summarize(sessions)}])');
  const output = h.elements.get("#repository-rows")!.textContent;
  assert.match(output, /—/); assert.doesNotMatch(output, /complete|N\/A/); assert.match(output, /1\/2.*parsed/);
});

test("review: actual summary and Tools rendering distinguish unavailable, observed zero and partial totals", async () => {
  const h = await harness();
  const activity = sample(evidence({ source: "cursor-transcript", fidelity: "activity-only", tokens: "unavailable", tools: "observed", usageUnit: "unavailable" })); activity.provider = "cursor";
  const summary = sample(evidence()); summary.tokens = tokens(100, 0, 0, 20); summary.models = [reportedModel("claude-opus-5", summary.tokens, 1)]; summary.cost.totalUsd = 1; summary.cost.upperEstimateUsd = 1; summary.costBasis = "provider-reported";
  const invalid = sample(undefined, true); invalid.tokens = tokens(999, 0, 0, 999); invalid.metrics.toolCalls = 999; invalid.tools = { Read: 999 };
  for (const sessions of [[activity], [summary], [invalid], [summary, activity]]) {
    h.context["sessions"] = sessions;
    h.run('snapshot={sessions}; renderLine=()=>{}; renderDonut=()=>{}; renderProviderEvidence=()=>{}; constRepo={repository:{id:"example",name:"Example"}}; view={sessions,dailySessions:sessions,repositories:[repositoryAggregate(constRepo,sessions)],summary:{...summarize(sessions),repositories:1,repositoriesWithSessions:1,workingSnapshots:0},topTools:namedTotals(sessions,"tools"),spendByModel:mergeModels(sessions),warnings:[]}; renderSummary(view)');
    // Values stay bare; the eligible/selected share moves to the coverage badge beside the value.
    assert.equal(h.elements.get("#metric-input")!.textContent, sessions.includes(summary) ? "100" : "—");
    const selected = `${sessions.length} selected ${sessions.length === 1 ? "session" : "sessions"}`;
    assert.equal(h.elements.get("#metric-input-coverage")!.textContent.trim(), sessions.includes(summary) ? sessions.length === 2 ? "1/2" : "" : `No token evidence in ${selected}`);
    assert.equal(h.elements.get("#metric-spend")!.textContent, sessions.includes(summary) ? "$1.00" : "—");
    assert.equal(h.elements.get("#metric-spend-coverage")!.textContent.trim(), sessions.includes(summary) ? sessions.length === 2 ? "1/2" : "" : `No priced or reported value in ${selected}`);
    assert.equal(h.elements.get("#metric-tools")!.textContent, sessions.includes(activity) ? "0" : "—");
    assert.equal(h.elements.get("#metric-tools-coverage")!.textContent.trim(), sessions.includes(activity) ? sessions.length === 2 ? "1/2" : "" : `No tool evidence in ${selected}`);
    assert.equal(h.elements.get("#metric-compactions")!.textContent, "—");
    h.run('renderNamedDistribution({view,field:"tools",keyContainer:elements.toolsKey,tableContainer:elements.toolsByRepository,detailContainer:elements.toolsDetail,detailTitle:elements.toolsDetailTitle,providerScope:"tools"})');
    if (!sessions.includes(activity)) {
      assert.match(h.elements.get("#tools-by-repository")!.textContent, /—/);
      assert.match(h.elements.get("#tools-detail")!.textContent, /—/);
    }
  }
});
