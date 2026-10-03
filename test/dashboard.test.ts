import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import * as lib from "../src/public/lib.js";

const publicRoot = join(dirname(fileURLToPath(import.meta.url)), "../src/public");

// ---------------------------------------------------------------------------
// A dependency-free DOM stub: enough of the element model for the dashboard
// script (createElement/NS, attributes, dataset, listeners, simple selectors).

type Listener = (event: Record<string, unknown>) => void;

class FakeText {
  parent: FakeElement | null = null;
  textContent: string;
  constructor(textContent: string) { this.textContent = textContent; }
}

class FakeElement {
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  children: Array<FakeElement | FakeText> = [];
  listeners = new Map<string, Listener[]>();
  parent: FakeElement | null = null;
  style: Record<string, string> & { setProperty: (name: string, value: string) => void };
  hidden = false; value = ""; checked = false; disabled = false; min = ""; max = ""; tabIndex = -1;
  type = ""; src = ""; alt = ""; href = ""; target = ""; rel = ""; title = ""; colSpan = 1;
  tagName: string; ownerDocument: FakeDocument;
  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName; this.ownerDocument = ownerDocument;
    const style: Record<string, string> = {};
    this.style = Object.assign(style, { setProperty: (name: string, value: string) => { style[name] = value; } });
  }
  get id(): string { return this.attributes.get("id") ?? ""; }
  get className(): string { return this.attributes.get("class") ?? ""; }
  set className(value: string) { this.attributes.set("class", value); }
  get classList() {
    const self = this;
    return {
      add: (name: string) => { const set = new Set(self.className.split(/\s+/).filter(Boolean)); set.add(name); self.className = [...set].join(" "); },
      remove: (name: string) => { self.className = self.className.split(/\s+/).filter((item) => item && item !== name).join(" "); },
      contains: (name: string) => self.className.split(/\s+/).includes(name),
    };
  }
  get textContent(): string { return this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.children = [new FakeText(String(value))]; }
  get elementChildren(): FakeElement[] { return this.children.filter((child): child is FakeElement => child instanceof FakeElement); }
  get childElementCount(): number { return this.elementChildren.length; }
  get firstElementChild(): FakeElement | null { return this.elementChildren[0] ?? null; }
  get options(): FakeElement[] { return this.elementChildren; }
  append(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const item of nodes) {
      const child = typeof item === "string" ? new FakeText(item) : item;
      child.parent = this; this.children.push(child);
    }
  }
  replaceChildren(...nodes: Array<FakeElement | FakeText>): void { this.children = []; this.append(...nodes); }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type: string, listener: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener)); }
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const payload = { key: "", preventDefault() {}, stopPropagation() {}, target: this, ...event };
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }
  focus(): void { this.ownerDocument.activeElement = this; this.dispatch("focus"); }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; this.dispatch("blur"); }
  getBoundingClientRect() { return { left: 0, top: 200, width: 900, height: 300, right: 900, bottom: 500 }; }
  scrollIntoView(): void {}
  contains(node: FakeElement | null): boolean {
    for (let cursor = node; cursor; cursor = cursor.parent) if (cursor === this) return true;
    return false;
  }
  closest(selector: string): FakeElement | null {
    for (let cursor: FakeElement | null = this; cursor; cursor = cursor.parent) if (cursor.matches(selector)) return cursor;
    return null;
  }
  matches(selector: string): boolean { return matchesCompound(this, selector.trim()); }
  querySelectorAll(selector: string): FakeNodeList {
    const parts = selector.trim().split(/\s+/);
    let candidates: FakeElement[] = [this];
    for (const part of parts) candidates = candidates.flatMap((scope) => descendants(scope).filter((element) => matchesCompound(element, part)));
    return new FakeNodeList([...new Set(candidates)]);
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
}

/** Mirrors a static NodeList: indexable and iterable with forEach and length, but none of the array methods. */
class FakeNodeList {
  [index: number]: FakeElement | undefined;
  readonly length: number;
  constructor(items: FakeElement[]) {
    items.forEach((item, index) => { this[index] = item; });
    this.length = items.length;
  }
  forEach(callback: (item: FakeElement, index: number) => void): void { for (let index = 0; index < this.length; index += 1) callback(this[index] as FakeElement, index); }
  *[Symbol.iterator](): Generator<FakeElement> { for (let index = 0; index < this.length; index += 1) yield this[index] as FakeElement; }
}

function descendants(element: FakeElement): FakeElement[] {
  const result: FakeElement[] = [];
  for (const child of element.elementChildren) { result.push(child, ...descendants(child)); }
  return result;
}

function matchesCompound(element: FakeElement, compound: string): boolean {
  const pattern = /([a-z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/giy;
  let match: RegExpExecArray | null; let consumed = 0;
  while ((match = pattern.exec(compound))) {
    consumed = pattern.lastIndex;
    const [, tag, id, className, attribute, attributeValue] = match;
    if (tag && element.tagName !== tag.toLowerCase()) return false;
    if (id && element.id !== id) return false;
    if (className && !element.classList.contains(className)) return false;
    if (attribute) {
      const dataKey = attribute.startsWith("data-") ? attribute.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) : null;
      const actual = dataKey && dataKey in element.dataset ? element.dataset[dataKey] : element.getAttribute(attribute);
      if (actual === null || actual === undefined) return false;
      if (attributeValue !== undefined && actual !== attributeValue) return false;
    }
  }
  return consumed === compound.length;
}

class FakeDocument {
  documentElement: FakeElement; body: FakeElement; activeElement: FakeElement | null = null;
  constructor() {
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.append(this.body);
  }
  createElement(tag: string): FakeElement { return new FakeElement(tag.toLowerCase(), this); }
  createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag, this); }
  createTextNode(text: string): FakeText { return new FakeText(text); }
  querySelector(selector: string): FakeElement | null { return this.body.querySelector(selector); }
  querySelectorAll(selector: string): FakeNodeList { return this.body.querySelectorAll(selector); }
}

const voidTags = new Set(["meta", "link", "input", "img", "br", "path", "rect", "circle", "line"]);

/** Builds the static dashboard tree from index.html (well-formed markup, no scripting). */
function parseHtml(html: string, document: FakeDocument): void {
  const body = html.slice(html.indexOf("<body"));
  const tokens = body.matchAll(/<\/([\w-]+)>|<([\w-]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g);
  const stack: FakeElement[] = [];
  for (const token of tokens) {
    const [, closing, opening, attributeText, selfClosing, text] = token;
    if (closing) { stack.pop(); continue; }
    if (opening) {
      if (opening === "body") { stack.push(document.body); continue; }
      const element = document.createElement(opening);
      for (const attribute of (attributeText ?? "").matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
        const [, name, value = ""] = attribute;
        element.setAttribute(name as string, value);
        if (name === "checked") element.checked = true;
        if (name === "hidden") element.hidden = true;
        if (name === "type") element.type = value;
        if (name === "value") element.value = value;
      }
      stack.at(-1)?.append(element);
      if (!selfClosing && !voidTags.has(opening)) stack.push(element);
      continue;
    }
    if (text && text.trim()) stack.at(-1)?.append(new FakeText(text.trim()));
  }
}

// ---------------------------------------------------------------------------
// Synthetic snapshot in the shape the dashboard reads from /api/analytics.

interface SessionSpec { provider: "claude" | "codex" | "cursor"; repository: string; createdAt: string; spendByDay: Record<string, number>; tools?: Record<string, number> }

function session({ provider, repository, createdAt, spendByDay, tools = { Read: 3, Bash: 1 } }: SessionSpec) {
  const totalUsd = Object.values(spendByDay).reduce((sum, value) => sum + value, 0);
  const reported = provider === "cursor";
  return {
    cost: { cacheWriteUsd: reported ? 0 : totalUsd * .1, cachedInputUsd: reported ? 0 : totalUsd * .4, inputUsd: reported ? 0 : totalUsd * .2, outputUsd: reported ? 0 : totalUsd * .3, totalUsd, upperEstimateUsd: totalUsd * 1.1 },
    costBasis: reported ? "provider-reported" : "api-list-price-equivalent",
    costByExecution: { subagentUsd: 0, topLevelUsd: totalUsd, unknownUsd: 0 }, costComplete: true, createdAt, effort: "medium", executionKind: "top-level",
    metrics: { compactions: 1, durationMilliseconds: 600_000, toolCalls: Object.values(tools).reduce((sum, value) => sum + value, 0) },
    models: [{ model: `${provider}-model`, calls: 4, priced: true, totalUsd, inputTokens: 1000, outputTokens: 200, cacheWriteUsd: 0, cachedInputUsd: 0, inputUsd: totalUsd, outputUsd: 0, upperEstimateUsd: totalUsd }],
    pricedTokenCoverage: 1, provider, repositoryId: `repo-${repository}`, repositoryName: repository, sessionKey: `${repository}-${createdAt}`, skillEvidence: "explicit", skills: { "code-review": 1 }, spendByDay,
    tokens: { cacheWrite1hInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWriteInputTokens: 100, cachedInputTokens: 700, inputTokens: 1000, nonReasoningOutputTokens: 200, outputTokens: 200, reasoningOutputTokens: 0, uncachedInputTokens: 200 },
    tools, transcript: { files: 1, snapshotWhileWorking: false, status: "ok", warnings: [] }, transportTools: {},
  };
}

function snapshotOf(sessions: ReturnType<typeof session>[]) {
  const names = [...new Set(sessions.map(({ repositoryName }) => repositoryName))];
  return {
    generatedAt: "2026-09-10T10:00:00.000Z",
    rateCard: { currency: "USD", effectiveDate: "2026-09-01", models: [{ model: "claude-model", source: "https://example.test/rates" }] },
    repositories: names.map((name) => ({ repository: { id: `repo-${name}`, name } })),
    sessions, spendByDay: {}, spendByModel: [], summary: {}, topTools: [], warnings: [],
  };
}

const defaultSessions = [
  session({ provider: "claude", repository: "acme-web", createdAt: "2026-09-01T09:00:00.000Z", spendByDay: { "2026-09-01": 1, "2026-09-08": 99 }, tools: { Read: 4, Edit: 2 } }),
  session({ provider: "codex", repository: "acme-web", createdAt: "2026-09-03T14:00:00.000Z", spendByDay: { "2026-09-03": 5 }, tools: { exec_command: 3 } }),
  session({ provider: "claude", repository: "billing-api", createdAt: "2026-09-05T11:00:00.000Z", spendByDay: { "2026-09-05": 7 }, tools: { Read: 1 } }),
  session({ provider: "cursor", repository: "billing-api", createdAt: "2026-09-06T11:00:00.000Z", spendByDay: { "2026-09-06": 2 }, tools: {} }),
];

// ---------------------------------------------------------------------------
// Boot the real app.js inside a VM with the stub DOM.

async function boot({ sessions = defaultSessions, search = "", storage = new Map<string, string>() } = {}) {
  const document = new FakeDocument();
  parseHtml(await readFile(join(publicRoot, "index.html"), "utf8"), document);
  const source = (await readFile(join(publicRoot, "app.js"), "utf8")).replace(/^import \{([\s\S]*?)\} from "\.\/lib\.js";/m, "const {$1} = __lib;");
  assert.ok(source.startsWith("const {"), "the lib import must be rewritten for the VM");
  let fetches = 0;
  const context: Record<string, unknown> = {
    __lib: lib, console, document, setTimeout, clearTimeout, URLSearchParams,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    fetch: async () => { fetches += 1; return { ok: true, status: 200, json: async () => structuredClone(snapshotOf(sessions)) }; },
    Option: class extends FakeElement { constructor(text: string, value: string) { super("option", document); this.textContent = text; this.value = value; } },
  };
  context.window = Object.assign(context, { location: { search }, innerWidth: 1440, matchMedia: () => ({ matches: false }) });
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "app.js" });
  await delay(20);
  const $ = (selector: string) => { const element = document.querySelector(selector); assert.ok(element, `missing ${selector}`); return element; };
  return { $, document, storage, fetchCount: () => fetches, settle: () => delay(20) };
}

// ---------------------------------------------------------------------------
// Pure helpers

test("nextChartIndex resolves Home/End absolutely and arrows from the nearest end", () => {
  assert.equal(lib.nextChartIndex("Home", -1, 10), 0);
  assert.equal(lib.nextChartIndex("End", -1, 10), 9);
  assert.equal(lib.nextChartIndex("Home", 5, 10), 0);
  assert.equal(lib.nextChartIndex("ArrowRight", -1, 10), 0);
  assert.equal(lib.nextChartIndex("ArrowLeft", -1, 10), 9);
  assert.equal(lib.nextChartIndex("ArrowLeft", 0, 10), 0);
  assert.equal(lib.nextChartIndex("ArrowRight", 9, 10), 9);
  assert.equal(lib.nextChartIndex("Escape", 3, 10), "hide");
  assert.equal(lib.nextChartIndex("Tab", 3, 10), null);
  assert.equal(lib.nextChartIndex("Home", -1, 0), null);
  assert.equal(lib.nextChartIndex("End", -1, 1), 0);
});

test("peakDay, median and niceMaximum behave on edge cases", () => {
  assert.deepEqual(lib.peakDay([{ name: "a", claude: 1, codex: 2 }, { name: "b", claude: 4, codex: 0 }], ["claude", "codex"]), { name: "b", value: 4 });
  assert.equal(lib.peakDay([{ name: "a", claude: 0 }], ["claude"]), null);
  assert.equal(lib.median([]), null);
  assert.equal(lib.median([3, 1, 2]), 2);
  assert.equal(lib.median([4, 1, 2, 3]), 2.5);
  assert.equal(lib.niceMaximum(36), 36);
  assert.equal(lib.niceMaximum(37), 40);
  assert.ok(lib.niceMaximum(0) > 0);
});

test("ledeParts names the highest-value day from the series it is given and handles empty windows", () => {
  const summary = { sessions: 3, repositoriesWithSessions: 2, totalInputTokens: 3000, outputTokens: 600, apiEquivalentSpendUsd: 13, providerReportedSpendUsd: 2 };
  const parts = lib.ledeParts({ summary, selectedName: null, phrase: "In the last 7 days", valueByProvider: { claude: 8, codex: 5, cursor: 2 }, providerLabels: { claude: "Claude", codex: "Codex", cursor: "Cursor" }, busiest: { name: "acme-web", sessions: 2 }, peak: { name: "2026-09-05", value: 7 } });
  const text = parts.map((part) => part.text ?? part.strong).join("");
  assert.match(text, /^In the last 7 days your agents ran 3 sessions across two repositories/);
  assert.match(text, /Claude carried 62% of that value and Codex 38%; Cursor reported a further \$2\.00/);
  assert.match(text, /acme-web was the busiest repository with 2 sessions, and the highest-value day was 5 September at \$7\.00\./);
  assert.ok(parts.some((part) => part.strong === "$13.00" && part.className === "value"));
  const empty = lib.ledeParts({ summary: { ...summary, sessions: 0 }, selectedName: "infra", phrase: "Between 1 Sept and 2 Sept,", valueByProvider: {}, providerLabels: {}, busiest: null, peak: null });
  assert.equal(empty[0]?.text, "Between 1 Sept and 2 Sept, no sessions started in infra. Widen the window or choose another repository.");
});

test("windowPhrase distinguishes presets, whole ranges, custom ranges and single days", () => {
  const bounds = { min: "2026-08-01", max: "2026-09-30" };
  assert.equal(lib.windowPhrase({ ...bounds, start: "2026-09-01", end: "2026-09-30", preset: "30" }), "In the last 30 days");
  assert.match(lib.windowPhrase({ ...bounds, start: "2026-08-01", end: "2026-09-30", preset: "all" }), /^Across every observed day, 1 Aug to 30 Sept,$/);
  assert.match(lib.windowPhrase({ ...bounds, start: "2026-08-05", end: "2026-09-10", preset: "custom" }), /^Between 5 Aug and 10 Sept,$/);
  assert.equal(lib.windowPhrase({ ...bounds, start: "2026-09-03", end: "2026-09-03", preset: "custom" }), "On 3 September,");
});

// ---------------------------------------------------------------------------
// Browser behaviour under the stub DOM

test("the lede clips the highest-value day to the selected window, matching the daily chart", async () => {
  const { $, settle } = await boot();
  assert.match($("#lede").textContent, /highest-value day was 8 September at \$99\.00/);
  $("#window-start").value = "2026-09-01"; $("#window-end").value = "2026-09-01";
  $("#window-start").dispatch("change"); await settle();
  assert.match($("#lede").textContent, /^On 1 September, your agents ran 1 session/);
  assert.match($("#lede").textContent, /highest-value day was 1 September at \$1\.00\./);
  assert.doesNotMatch($("#lede").textContent, /8 September/);
  const tableDays = [...$("#daily-table-wrap").querySelectorAll("tbody tr")].map((row) => row.elementChildren[0]?.textContent);
  assert.deepEqual(tableDays, ["1 September"]);
});

test("rerendering the daily chart never accumulates keyboard handlers, and Home/End read the first and last day", async () => {
  const { $, document, settle } = await boot();
  const chart = $("#daily-spend"), status = $("#daily-status");
  const keydownCount = () => chart.listeners.get("keydown")?.length ?? 0;
  assert.equal(keydownCount(), 1);
  const claudeToggle = $('[data-provider-filter="claude"]');
  for (let round = 0; round < 4; round += 1) { claudeToggle.checked = !claudeToggle.checked; claudeToggle.dispatch("change"); await settle(); }
  assert.equal(claudeToggle.checked, true);
  assert.equal(keydownCount(), 1, "handlers are bound once, not per render");
  assert.equal(chart.getAttribute("role"), "group");
  assert.equal(chart.getAttribute("aria-describedby"), "daily-status");
  chart.focus();
  assert.match(status.textContent, /^8 September: Claude \$99\.00, Codex \$0\.00/, "focus announces the last day");
  chart.dispatch("keydown", { key: "Home" });
  assert.match(status.textContent, /^1 September: Claude \$1\.00, Codex \$0\.00/);
  chart.dispatch("keydown", { key: "Escape" });
  chart.dispatch("keydown", { key: "End" });
  assert.match(status.textContent, /^8 September:/);
  chart.dispatch("keydown", { key: "ArrowLeft" });
  assert.match(status.textContent, /^7 September:/);
  assert.equal(document.activeElement, chart);
});

test("a view requested through the URL is shown but not persisted, and the theme hook does not persist either", async () => {
  const { $, storage } = await boot({ search: "?view=costs&theme=dark" });
  assert.equal($('[data-view-panel="costs"]').hidden, false);
  assert.equal($('[data-view-panel="summary"]').hidden, true);
  assert.equal(storage.has("session-analytics-view"), false);
  assert.equal(storage.has("session-analytics-theme"), false);
  $('[data-view-button="models"]').dispatch("click");
  assert.equal(storage.get("session-analytics-view"), "models");
});

test("share matrices print 0% in a readable token and keep focus on the selected repository button", async () => {
  const { $, document, settle } = await boot({ search: "?view=tools" });
  const zero = [...$("#tools-by-repository").querySelectorAll('td.cell span[data-zero="true"]')];
  assert.ok(zero.length > 0, "a repository with an unused tool family renders a zero cell");
  assert.ok(zero.every((cell) => cell.textContent === "0%"));
  const buttons = $("#tools-by-repository").querySelectorAll("button[data-repository]");
  const second = buttons[1]; assert.ok(second);
  second.focus(); second.dispatch("click"); await settle();
  assert.equal(document.activeElement?.dataset.repository, second.dataset.repository, "focus survives the rerender");
  assert.equal($("#tools-detail-title").textContent, second.textContent);
});

test("the cost ledger keeps a provider-reported column and a textual composition for every row", async () => {
  const { $ } = await boot({ search: "?view=costs" });
  const headers = [...$("#repository-cost-components").querySelectorAll("th")].map((cell) => cell.textContent);
  assert.deepEqual(headers, ["", "Composition", "Input", "Output", "Cache read", "Cache write", "Provider-reported", "Total"]);
  const billing = [...$("#repository-cost-components").querySelectorAll("tbody tr")].find((row) => row.textContent.includes("billing-api"));
  assert.ok(billing);
  assert.match(billing.textContent, /Mixed basis/);
  assert.match(billing.elementChildren[6]?.textContent ?? "", /\$2\.00/);
  const stack = billing.querySelector(".cost-stack");
  assert.match(stack?.getAttribute("aria-label") ?? "", /^Composition: Input \d+%, Output \d+%, Cache read \d+%, Cache write \d+%, Provider-reported \d+%$/);
});

test("provider toggles and comparison options are updated in place so focus is not lost", async () => {
  const { $, document, settle } = await boot({ search: "?view=activity" });
  const toggle = $("#activity-provider-filters").querySelectorAll("input")[0]; assert.ok(toggle);
  toggle.focus(); toggle.checked = false; toggle.dispatch("change"); await settle();
  assert.equal(document.activeElement, toggle, "the toggle element survives the rerender");
  assert.equal($("#activity-provider-filters").querySelectorAll("input")[0], toggle);
  $('[data-view-button="distributions"]').dispatch("click"); await settle();
  const option = $("#distribution-repository-options").querySelectorAll("input")[0]; assert.ok(option);
  option.focus(); option.checked = false; option.dispatch("change"); await settle();
  assert.equal(document.activeElement, option);
  assert.equal(option.checked, false, "an explicit deselection is not repopulated");
});

test("refreshing keeps the selected repository and the repository ledger links are native buttons", async () => {
  const { $, settle, fetchCount } = await boot();
  const link = $("#repository-rows").querySelector("button.row-link"); assert.ok(link);
  assert.equal($("#repository-rows").querySelector("tr")?.getAttribute("role"), null);
  $("#repository-filter").value = "repo-billing-api"; $("#repository-filter").dispatch("change"); await settle();
  assert.match($("#lede").textContent, /agents working in billing-api ran 2 sessions/);
  $("#refresh-button").dispatch("click"); await settle();
  assert.equal(fetchCount(), 2);
  assert.equal($("#repository-filter").value, "repo-billing-api");
  assert.match($("#lede").textContent, /agents working in billing-api/);
});
