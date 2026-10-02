import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildInsights } from "../src/insights/engine.ts";
import { context, sessions } from "./insights-fixtures.ts";

// A small DOM double exercises the actual renderer's controls and request races.
// It deliberately does not claim layout or screenshot coverage.
class Element {
  tag: string;
  className = "";
  id = "";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  listeners = new Map<string, () => void>();
  private text = "";
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(" "); }
  set textContent(value: string) { this.text = value; }
  classList = { add: (name: string) => { this.className += ` ${name}`; } };
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(...children: Element[]): void { this.text = ""; this.children = children; }
  addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
  click(): void { this.listeners.get("click")?.(); }
  focus(): void { /* Focus is not layout-tested by this double. */ }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())]; }
  querySelector(selector: string): Element | undefined {
    const [first, rest] = selector.split(" ");
    const match = this.all().find((element) => {
      if (first!.startsWith(".")) return element.className.split(" ").includes(first!.slice(1));
      const id = first!.match(/^\[data-insight-id="(.+)"\]$/)?.[1];
      return id ? element.dataset["insightId"] === id : element.tag === first;
    });
    return rest ? match?.querySelector(rest) : match;
  }
}

test("Insights renderer dismisses, snoozes, restores, handles storage failure and ignores stale filter responses", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = { document: globals["document"], window: globals["window"], fetch: globals["fetch"] };
  const stateSource = await readFile(new URL("../src/public/views/insights-state.js", import.meta.url), "utf8");
  const stateUrl = `data:text/javascript;base64,${Buffer.from(stateSource).toString("base64")}`;
  const source = (await readFile(new URL("../src/public/views/insights.js", import.meta.url), "utf8")).replace('"./insights-state.js"', JSON.stringify(stateUrl));
  const { renderInsights } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as { renderInsights: (root: Element, options: object) => Promise<void> };
  let stored = "{}";
  const requests: string[] = [];
  const report = buildInsights(sessions(20), context(), "2026-10-01T12:00:00Z");
  report.cards[0]!.names = ["<img src=x onerror=private>" ];
  const options = { generatedAt: report.generatedAt, repositoryId: null, from: "", through: "", repositories: [] };
  const root = new Element("div");
  const buttons = () => root.all().filter((element) => element.tag === "button");
  const click = (label: string) => { const button = buttons().find((element) => element.textContent === label); assert.ok(button, label); button.click(); };
  try {
    globals["document"] = { createElement: (tag: string) => new Element(tag) };
    globals["window"] = { localStorage: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } } };
    globals["fetch"] = async (url: string) => { requests.push(url); return { ok: true, json: async () => report }; };
    await renderInsights(root, options);
    assert.equal(root.attributes["aria-busy"], "false");
    assert.equal(root.all().filter((element) => element.tag === "article").length, report.cards.length);
    assert.match(root.textContent, /<img src=x onerror=private>/);
    assert.equal(root.all().filter((element) => element.tag === "img").length, 0);
    click("Dismiss"); assert.match(stored, /dismissed/);
    assert.equal(root.all().filter((element) => element.tag === "article").length, report.cards.length - 1);
    click("Show dismissed / snoozed"); click("Restore");
    assert.deepEqual(JSON.parse(stored), {});
    click("Hide dismissed / snoozed"); click("Snooze 7 days");
    assert.equal(typeof Object.values(JSON.parse(stored))[0], "number");
    click("Show dismissed / snoozed"); click("Restore");
    let resolveSlow!: (response: unknown) => void;
    globals["fetch"] = (url: string) => { requests.push(url); return new Promise((resolve) => { resolveSlow = resolve; }); };
    const slow = renderInsights(root, { ...options, repositoryId: "discovered-demo", from: "2026-09-02", through: "2026-09-05" });
    assert.equal(root.attributes["aria-busy"], "true");
    await renderInsights(root, options); // Return to the cached selection before the request resolves.
    assert.equal(root.attributes["aria-busy"], "false");
    resolveSlow({ ok: true, json: async () => ({ ...report, cards: [] }) }); await slow;
    assert.equal(root.all().filter((element) => element.tag === "article").length, report.cards.length);
    assert.match(requests.at(-1)!, /repo-id=discovered-demo&from=2026-09-02&through=2026-09-05/);
    globals["window"] = { get localStorage() { throw new Error("blocked"); } };
    click("Dismiss"); assert.match(root.textContent, /current page only/);
    globals["fetch"] = async () => { throw new Error("secret-network-error"); };
    await renderInsights(root, { ...options, generatedAt: "new-snapshot" });
    assert.match(root.textContent, /Insights could not be loaded/); assert.doesNotMatch(root.textContent, /secret-network-error/);
    assert.ok(buttons().some((element) => element.textContent === "Retry insights"));
  } finally { Object.assign(globals, original); }
});
