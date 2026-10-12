import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { emptySession, reportedModel, tokens } from "../src/providers/common.ts";
import type { ProviderEvidence, SessionAnalytics } from "../src/types.ts";

class Element {
  tag: string; children: Element[] = []; attributes: Record<string, string> = {}; dataset: Record<string, string> = {};
  style: Record<string, unknown> = { setProperty(name: string, value: string) { this[name] = value; } }; className = ""; value = ""; namespaceURI = "svg"; text = "";
  listeners: Record<string, (event?: any) => void> = {};
  constructor(tag = "div") { this.tag = tag; }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(" "); }
  get childElementCount() { return this.children.length; }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.children = items; this.text = ""; }
  viewBox = { baseVal: { width: 680, height: 230 } };
  removeAttribute(key: string) { delete this.attributes[key]; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(name: string, listener: (event?: any) => void) { this.listeners[name] = listener; }
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
  const charts = Object.assign({}, ...await Promise.all(["format", "chart-colors", "chart-scale", "chart-legend"].map((name) => import(new URL(`../src/public/${name}.js`, import.meta.url).href))));
  const context = createContext({ renderHistoryCoverage() {}, ...charts, ...providers, ...viewModel, ...evidenceHelpers, ...exportHelpers, ...ui, ...velocityData, ...tools, ...toolsData, document, Intl, Set, Map, console, HTMLElement: Element,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) }, localStorage: { getItem: () => null }, URLSearchParams });
  let source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  source = source.replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, "").split("const urlParameters =")[0]!;
  // Shared components resolve `document` at call time, so the stub is exposed as the global for this harness.
  (globalThis as any).document = document;
  runInContext(source, context);
  runInContext('elements.repositoryFilter.value="all"; elements.windowStart.value=elements.windowStart.min="2026-07-20"; elements.windowEnd.value=elements.windowEnd.max="2026-07-20";', context);
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
  const native = ledger(sample(evidence({ usageUnit: "request" })), "claude-opus-5", 1, { calls: 2 }); native.costBasis = "api-list-price-equivalent";
  h.context["sessions"] = [summary, native]; h.run('renderModelCosts(elements.costModels, ledgerMoney(sessions, { start: "2026-07-20", end: "2026-07-20" }))');
  assert.match(h.elements.get("#cost-models")!.textContent, /2 sessions · 2 calls/);
  assert.match(h.elements.get("#cost-models")!.textContent, /\$2\.00/);
});

test("review: invalid and unavailable sessions never imply observed tools or complete repository coverage", async () => {
  const h = await harness(); const invalid = sample(undefined, true), activity = sample(evidence({ source: "cursor-transcript", fidelity: "activity-only", tokens: "unavailable", tools: "observed", usageUnit: "unavailable" }));
  h.context["sessions"] = [invalid, activity];
  assert.equal(h.run('providerEvidenceRows(sessions)[0].toolSessions'), 0);
  h.run('snapshot={sessions}; renderRepositoryTable([{repository:{id:"example",name:"Example"},summary:summarize(sessions),usage:{value:0,evidence:{known:0,eligible:0,unsupported:0,complete:true},available:false}}])');
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
    h.run('snapshot={sessions}; renderLine=()=>{}; renderDonut=()=>{}; renderProviderEvidence=()=>{}; constRepo={repository:{id:"example",name:"Example"}}; view={activity:buildVelocity(sessions,{start:"",end:"",group:"repository"}),sessions,dailySessions:sessions,scopeSessions:sessions,repositories:[repositoryAggregate(constRepo,sessions)],summary:{...summarize(sessions),repositories:1,repositoriesWithSessions:1,workingSnapshots:0},topTools:namedTotals(sessions,"tools"),warnings:[]}; renderSummary(view); renderCoverageSummary(view)');
    // Values stay bare; the eligible/selected share moves to the coverage badge beside the value.
    assert.equal(h.elements.get("#metric-input")!.textContent, sessions.includes(summary) ? "100" : "—");
    const selected = `${sessions.length} selected ${sessions.length === 1 ? "session" : "sessions"}`;
    assert.equal(h.elements.get("#metric-input-coverage")!.textContent.trim(), sessions.includes(summary) ? sessions.length === 2 ? "1/2 1 of 2 selected sessions provide token evidence" : "" : `No token evidence in ${selected}`);
    // The headline is the activity-dated ledger shared with Velocity. A provider-reported summary has no
    // activity dates, so the headline is unavailable and its whole-session value is disclosed, not hidden.
    assert.equal(h.elements.get("#metric-spend")!.textContent, "—");
    assert.equal(h.elements.get("#metric-spend-coverage")!.textContent.trim(), "No session in this selection has activity dates");
    const note = h.elements.get("#coverage-usage-note")!.textContent;
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
  h.run('snapshot={sessions}; windowPreset="all"; view={sessions,repositories:[]}; renderActiveAnalyticsView=renderTools; renderTools(view)');
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
  assert.equal(h.elements.get("#chart-announcer")!.textContent, "Showing profile for tool_1: 14 calls, 11.7% of calls");
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
  h.run('elements.windowStart.value="2026-07-20"; elements.windowStart.min="2026-07-01"; elements.windowEnd.value="2026-07-20"; viewProviderFilters.tools=new Set(["claude"]); snapshot={sessions:scopeSessions}; view={sessions,scopeSessions,repositories:[]}; renderTools(view)');
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
  h.run('snapshot={sessions}; windowPreset="all"; view={sessions,repositories:[]}; renderTools(view)');
  const container = h.elements.get("#tools-view")!;
  const columns = descend(container).filter((node) => node.className === "tools-column");
  assert.deepEqual(columns.map((column) => column.children[0]!.style["height"]), ["25%", "0%", "100%"]);
  assert.match(columns[1]!.attributes["aria-label"]!, /— no tool evidence/);
  assert.doesNotMatch(columns[1]!.attributes["aria-label"]!, /0 calls/);
  first.transcript.startTimeKnown = false; last.transcript.startTimeKnown = false;
  h.run("renderTools(view)");
  const trend = descend(container).find((node) => node.className === "tools-trend")!;
  assert.match(trend.textContent, /— No tool evidence/);
  assert.match(trend.textContent, /10 undated calls excluded/);
  assert.doesNotMatch(trend.textContent, /0 calls plotted/);
});

test("Tools labels providers, explains guarded changes and announces the selected profile", async () => {
  const h = await harness(), native = sample(undefined), before = sample(undefined);
  native.tools = { Read: 10 }; before.tools = { Read: 3 };
  const container = new Element(); h.context["target"] = container; h.context["sessions"] = [native]; h.context["previous"] = [before];
  h.run('announcements=[]; renderToolsView(target,{sessions,previousSessions:previous,days:["2026-07-20"],announce:text=>announcements.push(text)})');
  assert.match(container.textContent, /Top tools/); assert.doesNotMatch(container.textContent, /Ranked by calls|Tool ranking/);
  assert.ok(descend(container).some(n => n.tag === "th" && n.textContent === "Provider"));
  const providers = descend(container).find(n => n.dataset["label"] === "Provider")!;
  assert.match(providers.textContent, /Claude/); assert.equal(providers.attributes["title"], "Claude 10 calls");
  const change = descend(container).find(n => n.dataset["label"] === "Change")!;
  assert.equal(change.textContent, "— small baseline");
  assert.equal(change.attributes["title"], "Previous window: 3 calls, below the 5-call minimum for a percentage");
  assert.match(container.textContent, /Small baseline \(3 calls\)/);
  assert.match(container.textContent, /All 10 calls came from Claude\./);
  assert.match(container.textContent, /100% of calls/);
  assert.equal(descend(container).filter(n => n.className === "kicker").length, 0);
  const button = descend(container).find(n => n.className === "tools-select")!;
  assert.equal(button.attributes["aria-label"], "Show tool profile for Read (Claude)");
  button.listeners["click"]!();
  assert.equal(h.run('announcements[0]'), "Showing profile for Read: 10 calls, 100% of calls");
  const second = sample(undefined), third = sample(undefined); second.provider = "opencode"; third.provider = "codex";
  second.tools = { Read: 2 }; third.tools = { Read: 1 }; h.context["sessions"] = [native, second, third];
  h.run('renderToolsView(target,{sessions,days:["2026-07-20"]})');
  const multi = descend(container).find(n => n.dataset["label"] === "Provider")!;
  assert.match(multi.children[0]!.textContent, /3 providers/);
  assert.doesNotMatch(multi.children[0]!.textContent, /Claude|OpenCode|Codex/);
  assert.equal(multi.attributes["title"], "Claude 10 calls, OpenCode 2 calls, Codex 1 call");
  assert.equal(multi.children[1]!.className, "sr-only");
  assert.equal(multi.children[1]!.textContent, multi.attributes["title"]);
  assert.equal(descend(container).find(n => n.className === "tools-select")!.attributes["aria-label"], "Show tool profile for Read (Claude, OpenCode, Codex)");
  assert.doesNotMatch(container.textContent, /All 13 calls came from/);
});

test("Tools trend uses named columns, roving focus and dismissible evidence tooltips", async () => {
  const h = await harness(), first = sample(undefined), missing = sample(evidence());
  first.tools = { Read: 8 }; missing.createdAt = "2026-07-21T09:00:00Z";
  const container = new Element(); h.context["target"] = container; h.context["sessions"] = [first, missing];
  h.run('renderToolsView(target,{sessions,days:["2026-07-20","2026-07-21","2026-07-22"]})');
  const chart = descend(container).find(n => n.className === "tools-columns")!;
  assert.equal(chart.attributes["role"], "group");
  const columns = chart.children;
  assert.ok(columns.every(n => n.attributes["role"] === "img" && !n.attributes["title"]));
  assert.deepEqual(columns.map(n => n.attributes["tabindex"]), ["-1", "-1", "0"]);
  assert.equal(columns[1]!.attributes["aria-label"], "2026-07-21: — no tool evidence (0/1 sessions carry tool evidence)");
  const tooltip = descend(container).find(n => n.className === "tools-tooltip")!;
  for (const column of columns) (column as any).focus = () => column.listeners["focus"]!();
  const key = (column: Element, key: string) => column.listeners["keydown"]!({ key, preventDefault() {}, stopPropagation() {} });
  key(columns[2]!, "ArrowLeft");
  assert.equal(columns[1]!.attributes["tabindex"], "0");
  assert.match(tooltip.textContent, /Tue,? 21 Jul 2026 — no tool evidence 0 of 1 sessions carry tool evidence/);
  key(columns[1]!, "Home"); assert.equal(columns[0]!.attributes["tabindex"], "0");
  assert.match(tooltip.textContent, /8 calls 1 of 1 sessions carry tool evidence/);
  key(columns[0]!, "End"); assert.match(tooltip.textContent, /0 calls No session starts/);
  key(columns[2]!, "Escape"); assert.equal((tooltip as any).hidden, true);
  columns[0]!.listeners["pointerenter"]!(); assert.equal((tooltip as any).hidden, false);
  columns[0]!.listeners["pointerleave"]!(); assert.equal((tooltip as any).hidden, true);
  columns[0]!.listeners["focus"]!(); columns[0]!.listeners["blur"]!(); assert.equal((tooltip as any).hidden, true);
  const trend = descend(container).find(n => n.className === "tools-trend")!;
  (trend as any).getBoundingClientRect = () => ({ top: 100, left: 100, width: 300 });
  (tooltip as any).getBoundingClientRect = () => ({ width: 120, height: 60 });
  (columns[0] as any).getBoundingClientRect = () => ({ top: 200, bottom: 340, left: 100, width: 10 });
  columns[0]!.listeners["pointerenter"]!();
  assert.equal(tooltip.dataset["side"], "above"); assert.equal(tooltip.style["left"], "0px"); assert.equal(tooltip.style["top"], "30px");
  (columns[2] as any).getBoundingClientRect = () => ({ top: 10, bottom: 150, left: 390, width: 10 });
  columns[2]!.listeners["pointerenter"]!();
  assert.equal(tooltip.dataset["side"], "below"); assert.equal(tooltip.style["left"], "180px"); assert.equal(tooltip.style["top"], "60px");
});

test("Tools provider empty states preserve the profile selection and can restore every provider", async () => {
  const h = await harness(), first = sample(undefined), other = sample(undefined); first.tools = { Read: 8 }; other.provider = "cursor";
  h.context["sessions"] = [first]; h.context["allSessions"] = [first, other];
  h.run('snapshot={sessions:allSessions}; windowPreset="all"; toolsSelectedName="Read"; view={sessions,repositories:[]}; activeView=()=>view; renderActiveAnalyticsView=renderTools; viewProviderFilters.tools=new Set(); renderTools(view)');
  const container = h.elements.get("#tools-view")!;
  assert.match(container.textContent, /No providers selected/);
  assert.match(container.textContent, /Every provider is switched off for this view, so there are no tool calls to show/);
  assert.equal(h.run("toolsSelectedName"), "Read");
  descend(container).find(n => n.dataset["focusKey"] === "tools:select-all-providers")!.listeners["click"]!();
  assert.equal(h.run("viewProviderFilters.tools.size"), 2);
  assert.match(container.textContent, /All 8 calls came from Claude/);
  h.run('viewProviderFilters.tools=new Set(["cursor"]); renderTools(view)');
  assert.match(container.textContent, /No sessions from the selected providers/);
  assert.match(container.textContent, /None of the 1 sessions in this window came from Cursor/);
  assert.ok(descend(container).some(n => n.textContent === "Select all providers"));
});

test("Tools reveals the replacement profile after selection and respects reduced motion", async () => {
  const h = await harness(), native = sample(undefined); native.tools = { Read: 10 };
  const container = new Element(); h.context["target"] = container; h.context["sessions"] = [native];
  const browser = globalThis as any, previousHeight = browser.innerHeight, previousMedia = browser.matchMedia;
  let reduced = false, top = 900, selections = 0;
  const scrolls: Array<{ block: string; behavior: string }> = [];
  const replacement = { getBoundingClientRect: () => ({ top }), scrollIntoView: (options: { block: string; behavior: string }) => scrolls.push(options) };
  const document = browser.document;
  browser.innerHeight = 1000; browser.matchMedia = () => ({ matches: reduced });
  document.getElementById = (id: string) => { assert.equal(id, "tools-profile"); assert.ok(selections > 0); return replacement; };
  h.context["select"] = () => { selections++; };
  try {
    h.run('renderToolsView(target,{sessions,days:["2026-07-20"],onSelect:select})');
    const button = descend(container).find(n => n.className === "tools-select")!;
    button.listeners["click"]!(); assert.deepEqual(scrolls.pop(), { block: "start", behavior: "smooth" });
    reduced = true; top = 20;
    button.listeners["click"]!(); assert.deepEqual(scrolls.pop(), { block: "start", behavior: "auto" });
    top = 300; button.listeners["click"]!(); assert.equal(scrolls.length, 0);
    assert.equal(selections, 3);
  } finally {
    if (previousHeight === undefined) delete browser.innerHeight; else browser.innerHeight = previousHeight;
    if (previousMedia === undefined) delete browser.matchMedia; else browser.matchMedia = previousMedia;
    delete document.getElementById;
  }
});
