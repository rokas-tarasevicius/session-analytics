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
  value = "";
  readOnly = false;
  open = false;
  focused = false;
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
  toggle(): void { this.open = !this.open; this.listeners.get("toggle")?.(); }
  input(value: string): void { this.value = value; this.listeners.get("input")?.(); }
  focus(): void { this.focused = true; } // Records the target; no browser keyboard/layout claim.
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

test("grouped renderer bounds tables, filters/drills scopes, persists independent rule/scope decisions and ignores stale responses", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = { document: globals["document"], window: globals["window"], fetch: globals["fetch"] };
  const stateSource = await readFile(new URL("../src/public/views/insights-state.js", import.meta.url), "utf8");
  const stateUrl = `data:text/javascript;base64,${Buffer.from(stateSource).toString("base64")}`;
  const source = (await readFile(new URL("../src/public/views/insights.js", import.meta.url), "utf8")).replace('"./insights-state.js"', JSON.stringify(stateUrl));
  const { renderInsights } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as { renderInsights: (root: Element, options: object) => Promise<void> };
  let stored = "{}", drilled = "";
  const requests: string[] = [];
  const selected = sessions(20); selected[0]!.cost.totalUsd = 20;
  const report = buildInsights(selected, context(), "2026-10-01T12:00:00Z");
  const sample = report.items.find((item) => item.rule === "session-outlier")!;
  const group = report.groups.find((item) => item.rule === "session-outlier")!;
  const rows = Array.from({ length: 1_101 }, (_, i) => ({ ...sample, id: `insight-${i.toString(16).padStart(20, "0")}`, scope: { ...sample.scope, sessionKey: i.toString(16).padStart(12, "0") }, session: { startedAt: "2026-09-02T06:30:00.000Z", models: ["claude-premium"] } }));
  rows[0]!.names = ["<img src=x onerror=private>"];
  group.itemIds = rows.map((item) => item.id);
  report.items = [...rows, ...report.items.filter((item) => item.rule !== "session-outlier")];
  const hiddenLast = rows.at(-1)!.id;
  stored = JSON.stringify({ [hiddenLast]: "dismissed" });
  const options = { generatedAt: report.generatedAt, repositoryId: null, from: "", through: "", repositories: [], onSelectRepository: (id: string) => { drilled = id; } };
  const root = new Element("div");
  const buttons = () => root.all().filter((element) => element.tag === "button");
  const click = (label: string) => { const button = buttons().find((element) => element.textContent === label); assert.ok(button, label); button.click(); };
  const scopeRows = () => root.all().filter((element) => element.tag === "tr" && element.dataset["insightId"]);
  const articles = () => root.all().filter((element) => element.tag === "article");
  const openScopes = () => { const details = root.all().find((element) => element.className === "insight-scopes")!; if (!details.open) details.toggle(); };
  try {
    globals["document"] = { createElement: (tag: string) => new Element(tag) };
    globals["window"] = { localStorage: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } } };
    globals["fetch"] = async (url: string) => { requests.push(url); return { ok: true, json: async () => report }; };
    await renderInsights(root, options);
    assert.equal(root.attributes["aria-busy"], "false");
    assert.equal(articles().length, report.groups.length);
    assert.equal(scopeRows().length, 0, "Collapsed groups do not build hidden tables");
    openScopes(); assert.equal(scopeRows().length, 10);
    assert.ok(root.all().some((e) => e.tag === "summary" && /Full evidence and guardrails/.test(e.textContent)));
    assert.match(root.textContent, /2026-09-02.*claude-premium/);
    const command = root.all().find((e) => e.className === "insight-review-command")!;
    assert.equal(command.readOnly, true);
    assert.match(command.value, /^session-analytics review --session [a-f0-9]{12} --via claude$/);
    assert.doesNotMatch(command.value, /--send-content/);
    click("Show 10 more scopes"); assert.equal(scopeRows().length, 20); assert.equal(scopeRows()[10]!.focused, true);
    assert.match(root.textContent, /<img src=x onerror=private>/);
    assert.equal(root.all().filter((e) => e.tag === "img").length, 0);
    const search = root.all().find((e) => e.className === "insight-scope-filter")!;
    search.input(rows[500]!.scope.sessionKey); assert.equal(scopeRows().length, 1);
    assert.equal(scopeRows()[0]!.dataset["insightId"], rows[500]!.id);
    search.input("no such repository"); assert.equal(scopeRows().length, 0);
    search.input(""); assert.equal(scopeRows().length, 10);
    click("Filter to repository"); assert.equal(drilled, sample.scope.repositoryId);
    click("Dismiss scope"); assert.equal(JSON.parse(stored)[rows[0]!.id], "dismissed");
    assert.equal(articles().length, report.groups.length); assert.equal(scopeRows().length, 10);
    assert.match(root.textContent, /summary includes their evidence/);
    click("Show dismissed / snoozed"); click("Restore scope");
    assert.equal(scopeRows()[0]!.dataset["insightId"], hiddenLast);
    click("Restore scope"); assert.deepEqual(JSON.parse(stored), {});
    click("Hide dismissed / snoozed"); click("Snooze scope 7 days");
    assert.equal(typeof JSON.parse(stored)[rows[0]!.id], "number");
    click("Snooze rule 7 days");
    assert.equal(typeof JSON.parse(stored)[group.ruleDecisionId], "number");
    assert.equal(articles().length, report.groups.length - 1);
    click("Show dismissed / snoozed"); click("Restore rule");
    assert.ok(JSON.parse(stored)[rows[0]!.id], "Restoring a rule does not restore its independently snoozed scope");
    click("Restore scope"); assert.deepEqual(JSON.parse(stored), {});
    click("Hide dismissed / snoozed"); click("Dismiss rule");
    assert.equal(JSON.parse(stored)[group.ruleDecisionId], "dismissed");
    click("Show dismissed / snoozed"); click("Restore rule"); click("Hide dismissed / snoozed");
    const filter = root.all().find((e) => e.tag === "select")!;
    filter.value = "session-outlier"; filter.listeners.get("change")!(); assert.equal(articles().length, 1);
    const reset = root.all().find((e) => e.tag === "select")!; reset.value = ""; reset.listeners.get("change")!();
    let resolveSlow!: (response: unknown) => void;
    globals["fetch"] = (url: string) => { requests.push(url); return new Promise((resolve) => { resolveSlow = resolve; }); };
    const slow = renderInsights(root, { ...options, repositoryId: "discovered-demo", from: "2026-09-02", through: "2026-09-05" });
    assert.equal(root.attributes["aria-busy"], "true");
    await renderInsights(root, options);
    assert.equal(root.attributes["aria-busy"], "false");
    resolveSlow({ ok: true, json: async () => ({ ...report, groups: [], items: [] }) }); await slow;
    assert.equal(articles().length, report.groups.length);
    assert.match(requests.at(-1)!, /repo-id=discovered-demo&from=2026-09-02&through=2026-09-05/);
    globals["window"] = { get localStorage() { throw new Error("blocked"); } };
    click("Dismiss rule"); assert.match(root.textContent, /current page only/);
    // Future rules/scopes still cannot expand the default machine view past ten cards.
    const many = { ...report, groups: Array.from({ length: 13 }, (_, index) => ({ ...group, id: `insight-group-${index.toString(16).padStart(20, "0")}`, ruleDecisionId: `insight-rule-${index.toString(16).padStart(20, "0")}` })) };
    globals["fetch"] = async () => ({ ok: true, json: async () => many });
    await renderInsights(root, { ...options, generatedAt: "many-groups" });
    assert.equal(articles().length, 10); assert.equal(scopeRows().length, 0);
    click("Show 3 more insights"); assert.equal(articles().length, 13); assert.equal(articles()[10]!.focused, true);
    globals["fetch"] = async () => { throw new Error("secret-network-error"); };
    await renderInsights(root, { ...options, generatedAt: "new-snapshot" });
    assert.match(root.textContent, /Insights could not be loaded/); assert.doesNotMatch(root.textContent, /secret-network-error/);
    assert.ok(buttons().some((element) => element.textContent === "Retry insights"));
  } finally { Object.assign(globals, original); }
});
