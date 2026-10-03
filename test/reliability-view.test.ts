import assert from "node:assert/strict";
import test from "node:test";
import { renderReliability } from "../src/public/reliability-view.js";
import { ReliabilityCollector } from "../src/metrics/reliability.ts";
import type { SessionAnalytics } from "../src/types.ts";
import { emptyStats, latencyFrom } from "../src/public/reliability-data.js";

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

test("review: 5,050-session Reliability filtering stays within an interaction budget", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  try {
    const base = new ReliabilityCollector({ contentRules: false, secret: null }).finish();
    const sessions = Array.from({ length: 5050 }, (_, i) => ({
      provider: i % 3 === 0 ? "claude" : "codex", repositoryId: `repo-${i % 125}`, repositoryName: `Synthetic repository ${i % 125}`,
      reliability: { ...base, tools: Array.from({ length: 24 }, (_, j) => ({
        ...emptyStats(), name: `synthetic_tool_${j}`, toolClass: j % 2 ? "read" : "shell", calls: 30,
        outcomes: { success: 20, error: 5, unknown: 5, timeout: 0, interrupted: 0, denied: 0 },
        latency: latencyFrom(Array.from({ length: 24 }, (_, k) => (k + 1) * (j + 1) * 100)),
      })) },
    })) as SessionAnalytics[];
    const container = new Element("section");
    const start = performance.now(); renderReliability(container, sessions);
    const cold = performance.now() - start;
    assert.match(container.text, /Showing 50 of 125 repositories/);
    container.querySelector("button")!.listeners.get("click")!();
    assert.match(container.text, /Showing 100 of 125 repositories/);
    container.querySelector("button")!.listeners.get("click")!();
    assert.match(container.text, /Showing 125 of 125 repositories/);
    const timings: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now(); renderReliability(container, sessions.slice()); timings.push(performance.now() - start);
    }
    const select = container.querySelector("select")!;
    select.value = "claude";
    const filtered = performance.now(); select.listeners.get("change")!(); const filterMs = performance.now() - filtered;
    assert.match(container.text, /1,212,480/); // 1,684 Claude sessions * 24 calls * 30 observations.
    const current = container.querySelector("select")!; current.value = "all";
    const back = performance.now(); current.listeners.get("change")!(); const backMs = performance.now() - back;
    assert.match(container.text, /3,636,000/);
    t.diagnostic(JSON.stringify({ sessions: sessions.length, toolGroups: 121200, coldMs: Math.round(cold), warmMs: timings.map(Math.round), filterMs: Math.round(filterMs), backMs: Math.round(backMs) }));
    assert.ok(Math.max(...timings, backMs) < 150, "unchanged scopes and returning to all agents must reuse aggregation within 150 ms");
    // A new snapshot must invalidate summaries even when the scope length is unchanged.
    const replaced = sessions.map((s) => ({ ...s, reliability: base }));
    renderReliability(container, replaced); assert.doesNotMatch(container.text, /3,636,000/);
    renderReliability(container, sessions.slice(0, 10)); assert.match(container.text, /10\/10 sessions supported/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
