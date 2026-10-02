import assert from "node:assert/strict";
import test from "node:test";
import { renderReliability } from "../src/public/reliability-view.js";
import { ReliabilityCollector } from "../src/metrics/reliability.ts";
import type { SessionAnalytics } from "../src/types.ts";

// Exercises DOM text and filter interactions without pretending to test browser layout.
class Element {
  tag: string;
  textContent = "";
  value = "";
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
  focused = false;
  constructor(tag: string) { this.tag = tag; }
  append(...elements: Element[]): void { this.children.push(...elements); }
  replaceChildren(): void { this.children = []; }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  addEventListener(key: string, callback: () => void): void { this.listeners.set(key, callback); }
  focus(): void { this.focused = true; }
  querySelector(tag: string): Element | undefined {
    for (const child of this.children) { if (child.tag === tag) return child; const match = child.querySelector(tag); if (match) return match; }
    return undefined;
  }
  get text(): string { return [this.textContent, ...this.children.map((c) => c.text)].join(" "); }
}

test("Reliability view renders coverage, filters agents, preserves focus and handles missing evidence", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  try {
    const c = new ReliabilityCollector({ contentRules: false, secret: null });
    for (let i = 0; i < 5; i++) {
      c.add({ id: String(i), name: "Read", cwd: "/synthetic", started: null });
      c.result(String(i), { outcome: i ? "success" : "error", error: i ? null : "not_found", durationMs: 10 });
    }
    // The view consumes only provider/repository identity and the optional namespace.
    const sessions = [
      { provider: "claude", repositoryId: "repo-a", repositoryName: "Sample <script> repository", reliability: c.finish() },
      { provider: "cursor", repositoryId: "repo-b", repositoryName: "Other repository" },
    ] as SessionAnalytics[];
    const container = new Element("section");
    renderReliability(container, sessions);
    assert.match(container.text, /20\.0%/);
    assert.match(container.text, /5\/5/);
    assert.match(container.text, /1\/2 sessions supported/);
    assert.match(container.text, /Enable --reliability-content-rules/);
    assert.match(container.text, /Sample <script> repository/);
    assert.equal(container.querySelector("script"), undefined, "names are rendered as text, never HTML");
    assert.match(container.text, /not verdicts/);
    const select = container.querySelector("select")!;
    select.value = "cursor"; select.listeners.get("change")!();
    assert.match(container.text, /Cursor reliability is not yet supported/);
    assert.match(container.text, /0\/1 sessions supported/);
    assert.doesNotMatch(container.text, /20\.0%/);
    assert.equal(container.querySelector("select")?.focused, true);
    const current = container.querySelector("select")!;
    current.value = "all"; current.listeners.get("change")!();
    renderReliability(container, []);
    assert.match(container.text, /0\/0 sessions supported/);
    assert.match(container.text, /No evidence in the selected scope/);
    assert.doesNotMatch(container.text, /NaN|Infinity|undefined/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
