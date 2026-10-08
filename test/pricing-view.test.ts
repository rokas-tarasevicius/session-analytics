import assert from "node:assert/strict";
import test from "node:test";

type Event = { target: Node; key?: string; stopped: boolean; stopPropagation: () => void };

// Small DOM contract double: exercise rendering and interaction without a browser/runtime dependency.
class Node {
  static active: Node | null = null;
  tag: string;
  textContent = "";
  className = "";
  children: Node[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  properties: Record<string, string> = {};
  style = { setProperty: (key: string, value: string) => { this.properties[key] = value; } };
  listeners: Record<string, ((event: Event) => void)[]> = {};
  href = "";
  target = "";
  rel = "";
  hidden = false;
  open = false;
  modalCalls = 0;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.textContent = ""; this.children = nodes; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(type: string, listener: (event: Event) => void) { (this.listeners[type] ??= []).push(listener); }
  dispatch(type: string, target = this, key?: string) {
    const event: Event = { target, key, stopped: false, stopPropagation() { this.stopped = true; } };
    for (const listener of this.listeners[type] ?? []) listener(event);
    return event;
  }
  showModal() { this.open = true; this.modalCalls++; }
  close() { this.open = false; this.dispatch("close"); }
  focus() { Node.active = this; }
  all(predicate: (node: Node) => boolean): Node[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap((node) => node.all(predicate))];
  }
  text(): string { return [this.textContent, ...this.children.map((node) => node.text())].join(" "); }
}

async function withDocument(run: (root: Node) => void | Promise<void>) {
  const globalWithDocument = globalThis as typeof globalThis & { document?: {
    createElement: (tag: string) => Node; createElementNS: (namespace: string, tag: string) => Node;
    getElementById: (id: string) => Node | undefined;
  } };
  const previous = globalWithDocument.document, root = new Node("main");
  globalWithDocument.document = {
    createElement: (tag) => new Node(tag), createElementNS: (_, tag) => new Node(tag),
    getElementById: (id) => root.all((node) => node.attributes.id === id)[0],
  };
  try { await run(root); } finally {
    Node.active = null;
    if (previous === undefined) delete globalWithDocument.document; else globalWithDocument.document = previous;
  }
}

const { renderPricingPanel, renderModelDetails } = await import(new URL("../src/public/pricing.js", import.meta.url).href);
const { pricingModelCards } = await import(new URL("../src/public/pricing-data.js", import.meta.url).href);
const historical = { source: "models.dev", kind: "api", snapshotDate: "2026-01-01T00:00:00.000Z",
  rateModel: "gpt-fixture", match: "exact", temporal: "oldest", assumptions: [] as string[] };
const rate = { provider: "openai", inputPerMillion: 5, cachedInputPerMillion: 0.075, outputPerMillion: 30,
  longContext: { thresholdInputTokens: 200000, inputMultiplier: 2, outputMultiplier: 1.5 } };
const rateCard = { effectiveDate: "2026-01-01", pricing: { policy: "reviewed-first", offline: true, stale: true,
  warnings: [], refreshAfterDays: 7, sources: [{ source: "models.dev", ageDays: 8.5, models: 20, stale: true,
    fetchedAt: "2026-01-01T00:00:00.000Z", url: "https://models.dev/api.json" }] }, models: [
  { model: "gpt-fixture", rate, source: "https://models.dev/api.json", provenance: historical },
  { model: "claude-unused", rate: { ...rate, provider: "anthropic" }, source: null, provenance: { ...historical, source: "reviewed", kind: "fallback" } },
] };
const sessions = [{ provider: "codex", costBasis: "api-list-price-equivalent", id: "private-session-id", path: "/private/session.json",
  text: "private transcript text", models: [
    { model: "gpt-fixture", inputTokens: 200, outputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 20,
      totalUsd: 410.57, upperEstimateUsd: 450, calls: 3, priced: true, pricing: [historical] },
    { model: "unknown", inputTokens: 100, outputTokens: 0, totalUsd: 0, calls: 1, priced: false, pricing: [] },
  ] }, { provider: "cursor", costBasis: "provider-reported", models: [{ model: "cursor-excluded", inputTokens: 900 }] }];
const modelButtons = (root: Node) => root.all((node) => node.tag === "button" && node.dataset.focusKey?.startsWith("pricing:model:") === true);
const toggleButton = (root: Node) => root.all((node) => node.dataset.focusKey === "pricing:unused")[0]!;
const byClass = (root: Node, name: string) => root.all((node) => node.className.split(" ").includes(name));
const usage = (model: string, value: number, tokens: number, calls = 1) => ({ model, totalUsd: value,
  inputTokens: tokens, outputTokens: 0, priced: true, pricing: [historical], calls });
const rankingSessions = [{ provider: "codex", costBasis: "api-list-price-equivalent", models: [
  usage("gpt-a", 4, 500), usage("gpt-b", 10, 100), usage("gpt-z", 10, 200),
] }];

test("Pricing panel keeps freshness, guarded coverage, privacy and empty-selection evidence", async () => {
  await withDocument((root) => {
    const panel = new Node("div"); root.append(panel);
    renderPricingPanel(panel, rateCard, sessions);
    const rendered = panel.text();
    assert.match(rendered, /8\.5d/); assert.match(rendered, /75\.0%/); assert.match(rendered, /300 \/ 400 observed tokens/);
    assert.match(rendered, /API-equivalent value is not an invoice/);
    assert.match(rendered, /Offline · cached prices · reviewed card effective 2026-01-01/);
    assert.match(rendered, /Cards are ordered by API-equivalent usage value in the selection, then observed tokens/);
    assert.match(rendered, /Provider-reported usage \(for example Cursor\) does not use a rate card and is not shown here/);
    assert.doesNotMatch(rendered, /cursor-excluded|private-session-id|\/private\/session.json|private transcript text/);
    assert.equal(panel.all((node) => node.attributes.role === "status").length, 1);
    const link = panel.all((node) => node.tag === "a")[0]!;
    assert.equal(link.textContent, "Public price list ↗"); assert.equal(link.href, "https://models.dev/api.json");
    assert.equal(link.target, "_blank"); assert.equal(link.rel, "noreferrer");
    const [button, unknown] = modelButtons(panel);
    assert.ok(button); assert.ok(unknown);
    assert.match(button.text(), /\$5\.00 in · \$30\.00 out \/ 1M/); assert.match(button.text(), /\$410\.57/);
    assert.match(button.text(), /300 tokens · 3 calls/);
    assert.match(button.attributes["aria-label"]!, /gpt-fixture, Codex: \$410\.57 usage value, input \$5\.00 \/ output \$30\.00 per 1M tokens\. Show pricing details/);
    assert.equal(button.attributes.type, "button"); assert.equal(button.attributes["aria-haspopup"], "dialog");
    assert.equal(button.attributes["aria-controls"], "pricing-model-dialog");
    assert.equal(button.dataset.focusKey, "pricing:model:gpt-fixture");
    assert.equal(button.properties["--card-accent"], "var(--provider-codex)");
    assert.match(unknown.text(), /No matching rate/); assert.match(unknown.text(), /0% of tokens priced/); assert.match(unknown.text(), /No usage value: unpriced/); assert.match(unknown.attributes["aria-label"]!, /no usage value \(unpriced\)/);
    assert.equal(toggleButton(panel).textContent, "Show 1 unused models");
    const list = panel.all((node) => node.tag === "ul")[0]!;
    assert.equal(list.attributes.role, "list"); assert.ok(list.children.every((node) => node.tag === "li" && node.children.length === 1));
    assert.equal(panel.all((node) => node.tag === "table").length, 0);

    renderPricingPanel(panel, rateCard, []);
    assert.match(panel.text(), /—/); assert.match(panel.text(), /No API-priced tokens in this selection/);
    assert.match(panel.text(), /No API-priced model usage in this selection\. Provider-reported values do not use a rate card\./);
    assert.doesNotMatch(panel.text(), /gpt-fixture/); assert.equal(toggleButton(panel).textContent, "Show 2 unused models");
    renderPricingPanel(panel, {}, []);
    assert.match(panel.text(), /Pricing source details are unavailable for this snapshot/);
  });
});

test("pricingModelCards orders by usage value, then tokens, calls and model ID", () => {
  const data = pricingModelCards(rateCard, rankingSessions);
  assert.deepEqual(data.used.map((card: { model: string }) => card.model), ["gpt-z", "gpt-b", "gpt-a"]);
  assert.equal(data.maxValue, 10); assert.equal(data.maxTokens, 500);
  const tied = pricingModelCards(rateCard, [{ ...rankingSessions[0], models: [
    usage("gpt-z", 10, 100, 1), usage("gpt-b", 10, 100, 2), usage("gpt-a", 10, 100, 2),
  ] }]);
  assert.deepEqual(tied.used.map((card: { model: string }) => card.model), ["gpt-a", "gpt-b", "gpt-z"]);
});

test("Model cards retain usage ordering and scale bars by value, falling back to observed tokens", async () => {
  await withDocument((root) => {
    renderPricingPanel(root, rateCard, rankingSessions);
    assert.deepEqual(modelButtons(root).map((button) => button.dataset.focusKey), ["pricing:model:gpt-z", "pricing:model:gpt-b", "pricing:model:gpt-a"]);
    let bars = byClass(root, "pricing-bar");
    assert.deepEqual(bars.map((bar) => bar.children[0]!.properties.width), ["100%", "100%", "40%"]);
    assert.equal(bars[2]!.attributes.role, "img"); assert.equal(bars[2]!.attributes["aria-label"], "40% of the top model's usage value");
    renderPricingPanel(root, rateCard, [{ ...rankingSessions[0], models: [usage("gpt-a", 0, 50), usage("gpt-b", 0, 100)] }]);
    bars = byClass(root, "pricing-bar");
    assert.deepEqual(bars.map((bar) => bar.children[0]!.properties.width), ["100%", "50%"]);
    assert.equal(bars[1]!.attributes["aria-label"], "50% of the top model's observed tokens");
    renderPricingPanel(root, rateCard, [{ ...rankingSessions[0], models: [
      { ...usage("gpt-a", 0, 100), pricingCoverage: { eligibleTokens: 100, pricedTokens: 82 } },
    ] }]);
    assert.match(modelButtons(root)[0]!.text(), /82% of tokens priced/);
    renderPricingPanel(root, rateCard, [{ ...rankingSessions[0], models: [usage("gpt-a", 0, 0)] }]);
    assert.equal(byClass(root, "pricing-bar")[0]!.children[0]!.properties.width, "0%");
  });
});

test("Model details show precise current prices, long-context rates and historical provenance", async () => {
  await withDocument((root) => {
    const { used, unused } = pricingModelCards(rateCard, sessions);
    renderModelDetails(root, used[0], rateCard);
    assert.match(root.text(), /Cached input \$0\.075/); assert.match(root.text(), /Output \$30\.00/);
    assert.match(root.text(), /Long-context pricing/); assert.match(root.text(), /Above 200,000 input tokens \$10\.00 \$45\.00/);
    assert.match(root.text(), /Public API price list/); assert.match(root.text(), /Exact match/);
    assert.match(root.text(), /models\.dev \/ api/); assert.match(root.text(), /Oldest available \(later than request\)/);
    assert.match(root.text(), /None/); assert.match(root.text(), /Reviewed card effective 2026-01-01/);
    assert.match(root.text(), /Usage value \$410\.57/); assert.match(root.text(), /Upper estimate \$450\.00/);
    assert.match(root.text(), /300 \/ 300 observed tokens \(100\.0%\)/);
    assert.match(root.text(), /Calls 3/); assert.match(root.text(), /Sessions 1/);
    assert.match(root.text(), /Input tokens 200/); assert.match(root.text(), /Cached input tokens 80/);
    assert.match(root.text(), /Cache write tokens 20/); assert.match(root.text(), /Output tokens 100/);
    const link = root.all((node) => node.tag === "a")[0]!;
    assert.equal(link.textContent, "Rate source ↗"); assert.equal(link.href, "https://models.dev/api.json");
    assert.equal(link.target, "_blank"); assert.equal(link.rel, "noreferrer");

    renderModelDetails(root, used[1], rateCard);
    assert.match(root.text(), /No matching rate/); assert.match(root.text(), /Incomplete token-class coverage/);
    assert.match(root.text(), /0 \/ 100 observed tokens \(0\.0%\)/);
    assert.doesNotMatch(root.text(), /Upper estimate/);

    const current = { ...historical, source: "reviewed", kind: "reviewed", match: "alias", rateModel: "gpt-priced",
      assumptions: ["cache-read-at-input", "/private/unknown-assumption"] };
    renderModelDetails(root, { ...used[0], current, priced: false, source: "javascript:alert(1)",
      provenance: [historical, { ...historical, temporal: "undated" }, { ...historical, temporal: "at-or-before" }],
      rate: { ...rate, contextTiers: [{ aboveInputTokens: 500000, inputPerMillion: 0.1234, outputPerMillion: 0.5 }] },
    }, rateCard);
    assert.match(root.text(), /Reviewed override \(pinned\)/); assert.match(root.text(), /Alias match · gpt-priced/);
    assert.match(root.text(), /Cache read: estimated at input rate; Derived cache rate/);
    assert.doesNotMatch(root.text(), /\/private\/unknown-assumption/);
    assert.match(root.text(), /Latest; request time unavailable/); assert.match(root.text(), /At or before request/);
    assert.match(root.text(), /Some tokens use estimated or unavailable rates/); assert.match(root.text(), /Incomplete token-class coverage/);
    assert.match(root.text(), /Above 500,000 input tokens \$0\.1234 \$0\.50/);
    assert.equal(root.all((node) => node.tag === "a").length, 0);
    renderModelDetails(root, unused[0], rateCard);
    assert.match(root.text(), /Bundled reviewed card \(fallback\)/); assert.match(root.text(), /Not used in this selection/);
    assert.doesNotMatch(root.text(), /Rates applied to this usage|Pricing coverage|Usage value/);
  });
});

test("Unused models stay expanded across renders and the fallback dialog restores replacement-card focus", async () => {
  await withDocument((root) => {
    renderPricingPanel(root, rateCard, sessions);
    const toggle = toggleButton(root);
    assert.equal(toggle.attributes["aria-expanded"], "false");
    assert.equal(toggle.attributes["aria-controls"], "pricing-unused-models");
    toggle.dispatch("click");
    assert.equal(toggle.textContent, "Hide unused models"); assert.equal(toggle.attributes["aria-expanded"], "true");
    const unused = byClass(root, "pricing-card-unused")[0]!;
    assert.match(unused.text(), /Not used in this selection/); assert.equal(byClass(unused, "pricing-bar").length, 0);
    assert.equal(unused.properties["--card-accent"], "var(--provider-claude)");
    unused.dispatch("click");
    const dialog = root.all((node) => node.tag === "dialog")[0]!;
    assert.equal(dialog.open, true); assert.equal(dialog.modalCalls, 1);
    assert.equal(dialog.attributes.id, "pricing-model-dialog"); assert.equal(dialog.className, "help pricing-dialog");
    assert.equal(dialog.attributes["aria-labelledby"], "pricing-model-title");
    assert.match(dialog.text(), /claude-unused/);
    assert.equal(dialog.dispatch("keydown", dialog, "Escape").stopped, true);
    dialog.dispatch("click", dialog.children[0]); assert.equal(dialog.open, true);
    renderPricingPanel(root, rateCard, sessions);
    assert.equal(toggleButton(root).attributes["aria-expanded"], "true");
    assert.equal(root.all((node) => node.tag === "dialog").length, 1); assert.equal(dialog.open, true);
    const replacement = byClass(root, "pricing-card-unused")[0]!;
    assert.notEqual(replacement, unused);
    const close = dialog.all((node) => node.attributes["aria-label"] === "Close")[0]!;
    assert.equal(close.all((node) => node.tag === "use")[0]!.attributes.href, "#i-close");
    close.dispatch("click"); assert.equal(dialog.open, false); assert.equal(Node.active, replacement);
    modelButtons(root)[0]!.dispatch("click"); dialog.dispatch("click");
    assert.equal(dialog.open, false); assert.equal(Node.active, modelButtons(root)[0]);
    renderPricingPanel(root, rateCard, []);
    assert.equal(byClass(root, "pricing-card-unused").length, 2);
    toggleButton(root).dispatch("click");
    assert.equal(toggleButton(root).textContent, "Show 2 unused models");
    assert.equal(root.all((node) => node.attributes.id === "pricing-unused-models")[0]!.hidden, true);
  });
});

test("Pricing reuses the dialog supplied by index.html", async () => {
  await withDocument((root) => {
    const panel = new Node("div"), dialog = new Node("dialog");
    dialog.setAttribute("id", "pricing-model-dialog"); root.append(panel, dialog);
    renderPricingPanel(panel, rateCard, sessions);
    modelButtons(panel)[0]!.dispatch("click");
    assert.equal(root.all((node) => node.tag === "dialog").length, 1); assert.equal(dialog.open, true);
    const previous = modelButtons(panel)[0];
    renderPricingPanel(panel, rateCard, sessions);
    assert.notEqual(modelButtons(panel)[0], previous);
    dialog.close(); assert.equal(Node.active, modelButtons(panel)[0]);
    assert.equal(dialog.listeners.close!.length, 1);
  });
});
