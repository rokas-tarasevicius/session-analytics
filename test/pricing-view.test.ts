import assert from "node:assert/strict";
import test from "node:test";
import { harness, sample, withLedger } from "./validation/aggregation-ui-harness.ts";

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
const { ageLabel, pricingCardView, pricingModelCards } = await import(new URL("../src/public/pricing-data.js", import.meta.url).href);
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
// Cards read the activity ledger for the selected dates: every fixture session carries the cells its model usage implies.
const window = { start: "2026-01-02", end: "2026-01-02" };
type Usage = { model: string; totalUsd?: number; upperEstimateUsd?: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
  cacheWriteInputTokens?: number; calls?: number; priced?: boolean; pricing?: unknown[]; pricingCoverage?: { eligibleTokens: number; pricedTokens: number } };
function ledgered<T extends { models: Usage[] }>(session: T, day = window.start) {
  const cells = session.models.map((usage, index) => {
    const input = usage.inputTokens ?? 0, output = usage.outputTokens ?? 0, cached = usage.cachedInputTokens ?? 0, write = usage.cacheWriteInputTokens ?? 0;
    const priced = usage.pricingCoverage?.pricedTokens ?? (usage.priced ? input + output : 0);
    return [day, 12, index, [usage.totalUsd ?? 0, input, input - cached - write, cached, write, output, 0, usage.calls ?? 0, 0, 0, priced, 0, input, 0]];
  });
  const total = session.models.reduce((sum, usage) => sum + (usage.totalUsd ?? 0), 0);
  const upper = session.models.reduce((sum, usage) => sum + (usage.upperEstimateUsd ?? usage.totalUsd ?? 0), 0);
  return { evidence: { source: "claude-jsonl", fidelity: "message", tokens: "reported", usageUnit: "request" }, ...session, sessionKey: `session-${day}-${session.models.map(({ model }) => model).join("-")}`, cost: { totalUsd: total, upperEstimateUsd: upper },
    velocity: { dimensions: session.models.map(({ model }) => ({ agent: "codex-cli", model, executionKind: "top-level", effort: "unknown" })), buckets: cells, undated: [] } };
}
const sessions = [ledgered({ provider: "codex", costBasis: "api-list-price-equivalent", id: "private-session-id", path: "/private/session.json",
  text: "private transcript text", models: [
    { model: "gpt-fixture", inputTokens: 200, outputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 20,
      totalUsd: 410.57, upperEstimateUsd: 450, calls: 3, priced: true, pricing: [historical] },
    { model: "unknown", inputTokens: 100, outputTokens: 0, totalUsd: 0, calls: 1, priced: false, pricing: [] },
  ] }), { provider: "cursor", costBasis: "provider-reported", models: [{ model: "cursor-excluded", inputTokens: 900 }], cost: { totalUsd: 5, upperEstimateUsd: 5 },
  // Cursor's database value has no request time: it is undated and never a card.
  velocity: { dimensions: [{ agent: "cursor", model: "<unknown>", executionKind: "top-level", effort: "unknown" }], buckets: [], undated: [[0, [5, 900, 900, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]] } }];
const modelButtons = (root: Node) => root.all((node) => node.tag === "button" && node.dataset.focusKey?.startsWith("pricing:model:") === true);
const toggleButton = (root: Node) => root.all((node) => node.dataset.focusKey === "pricing:unused")[0]!;
const byClass = (root: Node, name: string) => root.all((node) => node.className.split(" ").includes(name));
const usage = (model: string, value: number, tokens: number, calls = 1) => ({ model, totalUsd: value,
  inputTokens: tokens, outputTokens: 0, priced: true, pricing: [historical], calls });
const rankingSessions = [ledgered({ provider: "codex", costBasis: "api-list-price-equivalent", models: [
  usage("gpt-a", 4, 500), usage("gpt-b", 10, 100), usage("gpt-z", 10, 200),
] })];

test("a model without call evidence shows — calls", async () => {
  const make = (provider: "cursor" | "claude", calls: number, unit: "run" | "request" | "session") => {
    const session = withLedger(sample(), [["synthetic", 3]], { day: window.start, calls });
    session.provider = provider; session.costBasis = "api-list-price-equivalent";
    session.evidence!.usageUnit = unit;
    return session;
  };
  const cursor = make("cursor", 0, "run"), claude = make("claude", 3, "request"), zero = make("claude", 0, "request");
  // A recovered receipt-floor session keeps a session usage unit but its positive recorded count is evidence.
  const recovered = make("claude", 2, "session");
  for (const [session, expected] of [[cursor, "—"], [claude, "3"], [zero, "0"], [recovered, "2"]] as const) {
    await withDocument((root) => {
      const data = pricingModelCards(rateCard, [session], window), card = data.used[0];
      assert.match(pricingCardView(card, data).detail, new RegExp(`${expected} calls$`));
      renderModelDetails(root, card, rateCard);
      const row = root.all((node) => node.tag === "div" && node.children[0]?.tag === "dt" && node.children[0].textContent === "Calls")[0]!;
      assert.equal(row.children[1]!.textContent, expected);
      for (const calls of [null, undefined]) {
        renderModelDetails(root, { ...card, usage: { ...card.usage, calls } }, rateCard);
        assert.match(root.text(), /Calls —/);
      }
    });
    const { document, context, run } = await harness([session]);
    context["costSession"] = session;
    run(`renderModelCosts(elements.costModels, ledgerMoney([costSession], ${JSON.stringify(window)}))`);
    assert.match(document.querySelector("#cost-models")!.textContent, new RegExp(`${expected} calls`));
  }
});

test("Pricing panel keeps freshness, guarded coverage, privacy and empty-selection evidence", async () => {
  await withDocument((root) => {
    const panel = new Node("div"); root.append(panel);
    renderPricingPanel(panel, rateCard, sessions, window);
    const rendered = panel.text();
    assert.match(rendered, /8 days old/); assert.match(rendered, /75\.0%/); assert.match(rendered, /300 \/ 400 eligible tokens priced/);
    assert.match(rendered, /Cards add up to \$410\.57 API-equivalent value\. With \$0\.00 provider-reported value, which has no rate card, that is the \$410\.57 usage value/);
    assert.match(rendered, /API-equivalent value is not an invoice/);
    assert.match(rendered, /Cached prices only; no public price requests · reviewed card effective 1 Jan 2026/);
    assert.match(rendered, /Cards are per provider and model, ordered by usage value for these dates, then observed tokens/);
    assert.match(rendered, /Provider-reported usage \(for example Cursor\) does not use a rate card and is not shown here/);
    assert.doesNotMatch(rendered, /cursor-excluded|private-session-id|\/private\/session.json|private transcript text/);
    assert.equal(panel.all((node) => node.attributes.role === "status").length, 1);
    assert.deepEqual(byClass(panel, "kpi-label").map((node) => node.textContent), ["Pricing coverage", "models.dev prices", "Price updates"]);
    assert.equal(byClass(panel, "kpi")[0]!.className, "kpi accent");
    assert.match(byClass(panel, "kpi-note")[1]!.textContent, /^20 models · stale or missing$/);
    const reconciliation = byClass(panel, "pricing-reconciliation")[0]!;
    assert.equal(reconciliation.tag, "p"); assert.equal(reconciliation.className, "chart-note pricing-reconciliation");
    assert.equal(reconciliation.textContent, "$410.57 API-equivalent · $0.00 reported · $410.57 total");
    const content = byClass(panel, "pricing-content")[0]!;
    assert.equal(content.children[content.children.indexOf(byClass(panel, "kpi-grid")[0]!) + 1], reconciliation);
    assert.match(byClass(panel, "evidence")[0]!.text(), /Cards add up to \$410\.57 API-equivalent value/);
    assert.match(byClass(panel, "evidence")[0]!.text(), /20 models · stale or missing · fetched /);
    assert.equal(byClass(panel, "kicker").length, 0);
    const link = panel.all((node) => node.tag === "a")[0]!;
    assert.equal(link.textContent, "Public price list ↗"); assert.equal(link.href, "https://models.dev/api.json");
    assert.equal(link.target, "_blank"); assert.equal(link.rel, "noreferrer");
    const [button, unknown] = modelButtons(panel);
    assert.ok(button); assert.ok(unknown);
    assert.match(button.text().replace(/\s+/g, " "), /\$5\.00 in · \$30\.00 out \/ 1M/); assert.match(button.text(), /\$410\.57/);
    assert.match(button.text(), /300 tokens · 3 calls/);
    assert.match(button.attributes["aria-label"]!, /gpt-fixture, Codex: \$410\.57 API-equivalent value, input \$5\.00 \/ output \$30\.00 per 1M tokens\. Show pricing details/);
    assert.equal(button.attributes.type, "button"); assert.equal(button.attributes["aria-haspopup"], "dialog");
    assert.equal(button.attributes["aria-controls"], "pricing-model-dialog");
    assert.equal(button.dataset.focusKey, "pricing:model:codex:gpt-fixture");
    assert.equal(button.properties["--card-accent"], "var(--provider-codex)");
    assert.match(unknown.text(), /No matching rate/); assert.match(unknown.text(), /0% of tokens priced/); assert.match(unknown.text(), /No usage value: unpriced/); assert.match(unknown.attributes["aria-label"]!, /no usage value \(unpriced\)/);
    assert.equal(toggleButton(panel).textContent, "Show 1 unused models");
    const list = panel.all((node) => node.tag === "ul")[0]!;
    assert.equal(list.attributes.role, "list"); assert.ok(list.children.every((node) => node.tag === "li" && node.children.length === 1));
    assert.equal(panel.all((node) => node.tag === "table").length, 0);

    renderPricingPanel(panel, rateCard, []);
    assert.match(panel.text(), /—/); assert.match(panel.text(), /No eligible tokens in this selection/);
    assert.match(panel.text(), /No API-priced model usage in this selection\. Provider-reported values do not use a rate card\./);
    assert.doesNotMatch(panel.text(), /gpt-fixture/); assert.equal(toggleButton(panel).textContent, "Show 2 unused models");
    renderPricingPanel(panel, {}, []);
    assert.match(panel.text(), /Pricing source details are unavailable for this snapshot/);
  });
});

test("pricingModelCards orders by usage value, then tokens, calls and model ID", () => {
  const data = pricingModelCards(rateCard, rankingSessions, window);
  assert.deepEqual(data.used.map((card: { model: string }) => card.model), ["gpt-z", "gpt-b", "gpt-a"]);
  assert.equal(data.cardTokens, 800);
  assert.equal("maxValue" in data, false); assert.equal("maxTokens" in data, false);
  const tied = pricingModelCards(rateCard, [ledgered({ ...rankingSessions[0]!, models: [
    usage("gpt-z", 10, 100, 1), usage("gpt-b", 10, 100, 2), usage("gpt-a", 10, 100, 2),
  ] })], window);
  assert.deepEqual(tied.used.map((card: { model: string }) => card.model), ["gpt-a", "gpt-b", "gpt-z"]);
});

test("Model cards retain usage ordering and show shares of total value, falling back to total observed tokens", async () => {
  await withDocument((root) => {
    renderPricingPanel(root, rateCard, rankingSessions, window);
    assert.deepEqual(modelButtons(root).map((button) => button.dataset.focusKey), ["pricing:model:codex:gpt-z", "pricing:model:codex:gpt-b", "pricing:model:codex:gpt-a"]);
    let bars = byClass(root, "pricing-bar");
    assert.deepEqual(bars.map((bar) => bar.children[0]!.properties.width), [`${10 / 24 * 100}%`, `${10 / 24 * 100}%`, `${4 / 24 * 100}%`]);
    assert.equal(bars[2]!.attributes.role, "img"); assert.equal(bars[2]!.attributes["aria-label"], "17% of the API-equivalent value on these cards");
    assert.equal(byClass(root, "pricing-share-label")[2]!.text().replace(/\s+/g, " ").trim(), "17% of API-equivalent value");
    renderPricingPanel(root, rateCard, [ledgered({ ...rankingSessions[0]!, models: [usage("gpt-a", 0, 50), usage("gpt-b", 0, 100)] })], window);
    bars = byClass(root, "pricing-bar");
    assert.deepEqual(bars.map((bar) => bar.children[0]!.properties.width), [`${100 / 150 * 100}%`, `${50 / 150 * 100}%`]);
    assert.equal(bars[1]!.attributes["aria-label"], "33% of the observed tokens on these cards");
    renderPricingPanel(root, rateCard, [ledgered({ ...rankingSessions[0]!, models: [
      { ...usage("gpt-a", 0, 100), pricingCoverage: { eligibleTokens: 100, pricedTokens: 82 } },
    ] })], window);
    assert.match(modelButtons(root)[0]!.text(), /82% of tokens priced/);
    renderPricingPanel(root, rateCard, [ledgered({ ...rankingSessions[0]!, models: [usage("gpt-a", 0, 0), usage("gpt-b", 0, 10)] })], window);
    assert.equal(byClass(root, "pricing-bar")[0]!.children[0]!.properties.width, "100%");
    // No value and no tokens in the selected dates (a tool-only cell, say): no card for that model.
    assert.deepEqual(modelButtons(root).map((button) => button.dataset.focusKey), ["pricing:model:codex:gpt-b"]);
    // Another day's usage is outside the window: the card disappears rather than showing whole-session value.
    renderPricingPanel(root, rateCard, [ledgered({ ...rankingSessions[0]!, models: [usage("gpt-a", 4, 500)] }, "2026-01-01")], window);
    assert.equal(modelButtons(root).length, 0);
  });
});

test("Model details show precise current prices, long-context rates and historical provenance", async () => {
  await withDocument((root) => {
    const { used, unused } = pricingModelCards(rateCard, sessions, window);
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
    renderPricingPanel(root, rateCard, sessions, window);
    const toggle = toggleButton(root);
    assert.equal(toggle.attributes["aria-expanded"], "false");
    assert.equal(toggle.attributes["aria-controls"], "pricing-unused-models");
    toggle.dispatch("click");
    assert.equal(toggle.textContent, "Hide unused models"); assert.equal(toggle.attributes["aria-expanded"], "true");
    const unused = byClass(root, "pricing-card-unused")[0]!;
    assert.match(unused.text(), /Not used in this selection/); assert.equal(byClass(unused, "pricing-bar").length, 0);
    assert.deepEqual(unused.children.map((node) => node.className), ["pricing-provider", "pricing-model", "pricing-price", "pricing-caption"]);
    assert.equal(unused.children[3]!.tag, "span");
    assert.equal(byClass(root, "pricing-grid-unused")[0]!.attributes.role, "list");
    assert.equal(unused.properties["--card-accent"], "var(--provider-claude)");
    unused.dispatch("click");
    const dialog = root.all((node) => node.tag === "dialog")[0]!;
    assert.equal(dialog.open, true); assert.equal(dialog.modalCalls, 1);
    assert.equal(dialog.attributes.id, "pricing-model-dialog"); assert.equal(dialog.className, "help pricing-dialog");
    assert.equal(dialog.attributes["aria-labelledby"], "pricing-model-title");
    assert.match(dialog.text(), /claude-unused/);
    assert.equal(dialog.dispatch("keydown", dialog, "Escape").stopped, true);
    dialog.dispatch("click", dialog.children[0]); assert.equal(dialog.open, true);
    renderPricingPanel(root, rateCard, sessions, window);
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

test("ageLabel rounds snapshot ages down at hour and day boundaries", () => {
  for (const [days, label] of [
    [null, null], [NaN, null], [Infinity, null], [-Infinity, null], [0, "under an hour"], [0.01, "under an hour"],
    [1 / 24, "1 hour"], [0.05, "1 hour"], [0.5, "12 hours"], [0.99, "23 hours"],
    [1, "1 day"], [1.99, "1 day"], [2, "2 days"], [8.5, "8 days"],
  ]) assert.equal(ageLabel(days), label);
});

test("pricingCardView formats rates, values, counts and total shares without changing accessible names", () => {
  const { used } = pricingModelCards(rateCard, sessions, window);
  const card = { ...used[0], usage: { ...used[0].usage, valueUsd: 1234.56, tokens: 214282360, calls: 2435 } };
  const view = pricingCardView(card, { api: 2469.12, cardTokens: 428564720 });
  assert.deepEqual(view.prices, ["$5.00 in", "$30.00 out / 1M"]);
  assert.equal(view.value, "$1,234.56"); assert.equal(view.caption, "API-equivalent value · activity-dated");
  assert.equal(view.detail, "214,282,360 tokens · 2,435 calls");
  assert.equal(view.badge, null);
  assert.deepEqual(view.share, { value: 0.5, text: "50%", label: "of API-equivalent value", aria: "50% of the API-equivalent value on these cards" });
  assert.equal(view.ariaLabel, "gpt-fixture, Codex: $1,234.56 API-equivalent value, input $5.00 / output $30.00 per 1M tokens. Show pricing details");
  assert.deepEqual(pricingCardView(card, { api: 0, cardTokens: 428564720 }).share,
    { value: 0.5, text: "50%", label: "of observed tokens", aria: "50% of the observed tokens on these cards" });
  const tiny = { ...card, usage: { ...card.usage, valueUsd: 0.004, tokens: 1 } };
  assert.equal(pricingCardView(tiny, { api: 1, cardTokens: 1 }).share.text, "<1%");
  assert.equal(pricingCardView(tiny, { api: 0, cardTokens: 1000 }).share.text, "<1%");
  assert.equal(pricingCardView({ ...tiny, usage: { ...tiny.usage, valueUsd: 0.005 } }, { api: 1, cardTokens: 1 }).share.text, "1%");
  assert.deepEqual(pricingCardView(card, { api: 0, cardTokens: 0 }).share,
    { value: 0, text: "0%", label: "of observed tokens", aria: "0% of the observed tokens on these cards" });
  assert.equal(pricingCardView(card, { api: 1, cardTokens: 1 }).share.value, 1);
  assert.equal(pricingCardView({ ...tiny, usage: { ...tiny.usage, valueUsd: -1 } }, { api: 1, cardTokens: 1 }).share.value, 0);
  assert.deepEqual(pricingCardView({ ...card, rate: { ...rate, inputPerMillion: 0.1234 } }, { api: 1, cardTokens: 1 }).prices,
    ["$0.1234 in", "$30.00 out / 1M"]);
});

test("pricingCardView preserves incomplete coverage, unavailable rates and unused states", () => {
  const data = pricingModelCards(rateCard, sessions, window), card = data.used[0];
  for (const [coverage, badge] of [[0.989, "98% of tokens priced"], [0.29, "29% of tokens priced"], [0, "0% of tokens priced"]]) {
    assert.equal(pricingCardView({ ...card, usage: { ...card.usage, coverage } }, data).badge, badge);
  }
  for (const coverage of [1, null]) {
    assert.equal(pricingCardView({ ...card, priced: false, usage: { ...card.usage, coverage } }, data).badge, "Incomplete rates");
  }
  const missing = pricingCardView(data.used[1], data);
  assert.equal(missing.prices, null); assert.equal(missing.value, "—"); assert.equal(missing.caption, "No usage value: unpriced");
  assert.equal(missing.ariaLabel, "unknown, Codex: no usage value (unpriced), No matching rate. Show pricing details");
  const historicalOnly = pricingCardView({ ...card, rate: null }, data);
  assert.equal(historicalOnly.prices, null); assert.equal(historicalOnly.value, "$410.57");
  assert.equal(historicalOnly.caption, "API-equivalent value · activity-dated");
  assert.equal(historicalOnly.ariaLabel, "gpt-fixture, Codex: $410.57 API-equivalent value, No matching rate. Show pricing details");
  const zeroPriced = pricingCardView({ ...card, usage: { ...card.usage, valueUsd: 0 } }, data);
  assert.equal(zeroPriced.value, "$0.00"); assert.equal(zeroPriced.caption, "API-equivalent value · activity-dated");
  const unused = pricingCardView(data.unused[0], data);
  assert.equal(unused.value, null); assert.equal(unused.share, null); assert.equal(unused.detail, null); assert.equal(unused.badge, null);
  assert.equal(unused.caption, "Not used in this selection");
  assert.equal(unused.ariaLabel, "claude-unused, Claude: Not used in this selection, input $5.00 / output $30.00 per 1M tokens. Show pricing details");
});

test("Every used card keeps seven aligned rows with one section subtitle and an accessible share", async () => {
  await withDocument((root) => {
    renderPricingPanel(root, rateCard, sessions, window);
    for (const button of modelButtons(root)) {
      assert.deepEqual(button.children.map((node) => node.className), ["pricing-provider", "pricing-model", "pricing-price",
        "pricing-value", "pricing-detail", "pricing-share", "pricing-badge-slot"]);
      assert.deepEqual(button.children.map((node) => node.tag), ["span", "span", "span", "strong", "small", "span", "span"]);
      assert.deepEqual(byClass(button, "pricing-share")[0]!.children.map((node) => node.className), ["pricing-share-label", "pricing-bar"]);
    }
    assert.equal(root.text().split("API-equivalent value · activity-dated").length - 1, 1);
    assert.match(byClass(modelButtons(root)[1]!, "pricing-detail")[0]!.text(), /No usage value: unpriced/);
    const [complete, missing] = modelButtons(root);
    const empty = byClass(complete!, "pricing-badge-slot")[0]!;
    assert.equal(empty.children.length, 0); assert.equal(empty.attributes["aria-hidden"], "true");
    const badge = byClass(missing!, "pricing-badge-slot")[0]!;
    assert.equal(badge.attributes["aria-hidden"], undefined); assert.equal(badge.children[0]!.className, "pricing-badge");
    assert.equal(badge.children[0]!.tag, "small");
    const price = byClass(complete!, "pricing-price")[0]!;
    assert.deepEqual(price.children.map((node) => node.textContent), ["$5.00 in", "·", "$30.00 out / 1M"]);
    assert.equal(price.children[1]!.className, "pricing-sep"); assert.equal(price.children[1]!.attributes["aria-hidden"], "true");
    assert.deepEqual(byClass(missing!, "pricing-price")[0]!.children.map((node) => node.textContent), ["No matching rate"]);
  });
});

test("Stale online pricing offers one refresh action; offline, pinned and warning-only notices do not", async () => {
  await withDocument((root) => {
    let refreshes = 0;
    const options = { onRefresh: () => { refreshes++; } }, online = { ...rateCard, pricing: { ...rateCard.pricing, offline: false } };
    renderPricingPanel(root, online, sessions, window, options);
    const notice = byClass(root, "notice")[0]!;
    assert.equal(notice.tag, "aside"); assert.equal(notice.attributes.role, "status");
    assert.equal(root.all((node) => node.attributes.role === "status").length, 1);
    assert.match(notice.text(), /Pricing evidence needs a refresh/);
    assert.match(notice.text().replace(/\s+/g, " "), /prices fetched in the background since the dashboard started, or run session-analytics rates update/);
    assert.equal(notice.all((node) => node.tag === "code")[0]!.textContent, "session-analytics rates update");
    const buttons = notice.all((node) => node.tag === "button");
    assert.equal(buttons.length, 1); assert.equal(buttons[0]!.textContent, "Refresh snapshot");
    assert.ok(buttons[0]!.className.split(" ").includes("button")); assert.equal(buttons[0]!.attributes.type, "button");
    assert.equal(buttons[0]!.dataset.focusKey, "pricing:refresh");
    buttons[0]!.dispatch("click"); assert.equal(refreshes, 1);
    assert.match(root.text(), /Automatic/); assert.match(root.text(), /Checked after the dashboard starts · reviewed card effective 1 Jan 2026/);
    renderPricingPanel(root, online, sessions, window);
    assert.equal(byClass(root, "notice")[0]!.all((node) => node.tag === "button").length, 0);
    renderPricingPanel(root, rateCard, sessions, window, options);
    assert.equal(byClass(root, "notice")[0]!.all((node) => node.tag === "button").length, 0);
    assert.match(byClass(root, "notice")[0]!.text().replace(/\s+/g, " "), /Offline mode prevents public price requests\. Run session-analytics rates update with offline mode off, then refresh\./);
    assert.equal(byClass(root, "notice")[0]!.all((node) => node.tag === "code")[0]!.textContent, "session-analytics rates update");
    renderPricingPanel(root, { ...online, pricing: { ...online.pricing, policy: "reviewed-only" } }, sessions, window, options);
    assert.equal(byClass(root, "notice")[0]!.all((node) => node.tag === "button").length, 0);
    assert.deepEqual(byClass(root, "kpi-label").map((node) => node.textContent), ["Pricing coverage", "Price updates"]);
    assert.match(root.text(), /Pinned/); assert.match(root.text(), /Reviewed card only; public sources bypassed · reviewed card effective 1 Jan 2026/);
    renderPricingPanel(root, { ...online, pricing: { ...online.pricing, stale: false, warnings: ["rejected-models"] } }, sessions, window, options);
    assert.match(byClass(root, "notice")[0]!.text(), /Pricing evidence has warnings/);
    assert.equal(byClass(root, "notice")[0]!.all((node) => node.tag === "button").length, 0);
    assert.equal(refreshes, 1);
  });
});

test("Snapshot KPIs show human ages, absent snapshots and UTC reviewed dates", async () => {
  await withDocument((root) => {
    for (const [ageDays, label] of [[0.01, "Under an hour old"], [0.5, "12 hours old"], [1, "1 day old"], [2, "2 days old"], [null, "—"]]) {
      renderPricingPanel(root, { ...rateCard, effectiveDate: "2026-10-02T00:00:00Z", pricing: { ...rateCard.pricing,
        sources: [{ ...rateCard.pricing.sources[0], ageDays, fetchedAt: ageDays === null ? null : "2026-01-01T00:00:00Z" }] } }, sessions, window);
      assert.equal(byClass(root, "pricing-freshness")[0]!.children[1]!.textContent, label);
      assert.match(root.text(), /reviewed card effective 2 Oct 2026/);
      const freshness = byClass(root, "pricing-freshness")[0]!.text();
      if (ageDays === null) { assert.match(freshness, /No cached snapshot/); assert.match(byClass(root, "evidence")[0]!.text(), /stale or missing · not cached/); assert.doesNotMatch(freshness, /fetched/); }
      else assert.match(byClass(root, "evidence")[0]!.text(), /· fetched \d/);
    }
    renderPricingPanel(root, { ...rateCard, effectiveDate: "undated" }, sessions, window);
    assert.match(root.text(), /reviewed card effective undated/);
  });
});

test("Pricing reuses the dialog supplied by index.html", async () => {
  await withDocument((root) => {
    const panel = new Node("div"), dialog = new Node("dialog");
    dialog.setAttribute("id", "pricing-model-dialog"); root.append(panel, dialog);
    renderPricingPanel(panel, rateCard, sessions, window);
    modelButtons(panel)[0]!.dispatch("click");
    assert.equal(root.all((node) => node.tag === "dialog").length, 1); assert.equal(dialog.open, true);
    const previous = modelButtons(panel)[0];
    renderPricingPanel(panel, rateCard, sessions, window);
    assert.notEqual(modelButtons(panel)[0], previous);
    dialog.close(); assert.equal(Node.active, modelButtons(panel)[0]);
    assert.equal(dialog.listeners.close!.length, 1);
  });
});

test("pricing freshness and model detail date-times use the snapshot timezone", async () => {
  await withDocument(async (root) => {
    const panel = new Node("div"); root.append(panel);
    renderPricingPanel(panel, rateCard, sessions, { ...window, timeZone: "America/Los_Angeles" });
    assert.match(byClass(panel, "evidence")[0]!.text(), /fetched 31 Dec 2025, 16:00/);
    const button = modelButtons(panel)[0]!;
    button.dispatch("click");
    const dialog = root.all((node) => node.attributes.id === "pricing-model-dialog")[0]!;
    assert.match(dialog.text(), /31 Dec 2025, 16:00/);
    assert.doesNotMatch(dialog.text(), /1 Jan 2026, 00:00/);
  });
});

test("date-only pricing provenance dates render as calendar dates, not 1970", async () => {
  await withDocument((root) => {
    const data = pricingModelCards(rateCard, sessions, window);
    const card = data.used.find((item: { current: unknown }) => item.current) ?? data.used[0]!;
    const current = { ...(card.current ?? {}), snapshotDate: "2026-10-02" };
    renderModelDetails(root, { ...card, current }, rateCard, "America/Los_Angeles");
    assert.match(root.text(), /2 Oct 2026/);
    assert.doesNotMatch(root.text(), /1970|Invalid Date/);
  });
});
