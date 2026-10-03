import assert from "node:assert/strict";
import test from "node:test";

// Small DOM contract double: exercise the real renderer without a browser/runtime dependency.
class Node {
  tag: string;
  textContent = "";
  children: Node[] = [];
  attributes: Record<string, string> = {};
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  text(): string { return [this.textContent, ...this.children.map((node) => node.text())].join(" "); }
}

test("Pricing panel renders source age, historical provenance, guarded coverage and empty selections", async () => {
  const globalWithDocument = globalThis as typeof globalThis & { document?: { createElement: (tag: string) => Node } };
  const previous = globalWithDocument.document;
  globalWithDocument.document = { createElement: (tag) => new Node(tag) };
  try {
    const moduleUrl = new URL("../src/public/pricing.js", import.meta.url).href;
    const { renderPricingPanel } = await import(moduleUrl);
    const panel = new Node("div");
    const card = { effectiveDate: "2026-01-01", pricing: { policy: "reviewed-first", offline: true, stale: true,
      warnings: [], refreshAfterDays: 7, sources: [{ source: "models.dev", ageDays: 8.5, models: 20, stale: true,
        fetchedAt: "2026-01-01T00:00:00.000Z", url: "https://models.dev/api.json" }] } };
    const sessions = [{ costBasis: "api-list-price-equivalent", models: [{ model: "gpt-fixture", inputTokens: 200,
      outputTokens: 100, priced: true, pricing: [{ source: "models.dev", kind: "api", snapshotDate: "2026-01-01T00:00:00.000Z",
        temporal: "oldest", assumptions: [] }] }, { model: "unknown", inputTokens: 100, outputTokens: 0, priced: false, pricing: [] }] },
      { costBasis: "provider-reported", models: [{ model: "cursor-excluded", inputTokens: 900 }] }];
    renderPricingPanel(panel, card, sessions);
    const rendered = panel.text();
    assert.match(rendered, /8\.5d/); assert.match(rendered, /75\.0%/); assert.match(rendered, /300 \/ 400 observed tokens/);
    assert.match(rendered, /models.dev \/ api/); assert.match(rendered, /Oldest available \(later than request\)/);
    assert.match(rendered, /No matching rate/); assert.match(rendered, /API-equivalent value is not an invoice/);
    assert.doesNotMatch(rendered, /cursor-excluded/);
    assert.ok(panel.children.some((node) => node.attributes.role === "status"));
    renderPricingPanel(panel, card, []);
    assert.match(panel.text(), /—/); assert.match(panel.text(), /No API-priced tokens in this selection/); assert.match(panel.text(), /No API-priced model usage/);
    assert.doesNotMatch(panel.text(), /gpt-fixture/);
  } finally {
    if (previous === undefined) delete globalWithDocument.document; else globalWithDocument.document = previous;
  }
});
