import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { LimitsCollector } from "../src/metrics/limits.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";
import { plantMalformedModels } from "./model-privacy-fixture.ts";

// A small DOM contract harness keeps this interaction test dependency-free.
// It checks actual rendering/control callbacks, not layout or browser CSS behavior.
class Element {
  tag: string;
  children: Element[] = [];
  textContent = "";
  className = "";
  id = "";
  value = "";
  scope = "";
  attributes: Record<string, string> = {};
  listeners = new Map<string, () => void>();
  constructor(tag: string) { this.tag = tag; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(event: string, callback: () => void) { this.listeners.set(event, callback); }
  querySelector(tag: string): Element | undefined { return this.descendants().find((e) => e.tag === tag); }
  descendants(): Element[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  focus() { focused = this; }
  change(value: string) { this.value = value; this.listeners.get("change")?.(); }
  text(): string { return [this.textContent, ...this.children.map((child) => child.text())].join(" "); }
}
let focused: Element | null = null;
class OptionElement extends Element {
  constructor(text: string, value: string) { super("option"); this.textContent = text; this.value = value; }
}

test("Limits & cache renders evidence and handles profile, grouping, execution and empty-date selections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "limits-view-"));
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals["document"], originalOption = globals["Option"];
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-07-20T10:10:00Z");
  let cleanup: (() => void) | undefined;
  const container = new Element("section");
  const byId = (id: string) => container.descendants().find((e) => e.id === id);
  globals["document"] = { createElement: (tag: string) => new Element(tag), createElementNS: (_namespace: string, tag: string) => new Element(tag), getElementById: byId };
  globals["Option"] = OptionElement;
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    await plantMalformedModels(fixture);
    const snapshot = await analyzeMachineSessions({ ...fixture, dataDir: directory });
    const quotas = await LimitsCollector.create({ home: directory, codex: [fixture.codexRoot], claude: [fixture.claudeRoot], dataDirectory: directory });
    for (const minute of [0,5,10]) quotas.observe(join(fixture.codexRoot, "file"), { type: "event_msg", timestamp: `2026-07-20T10:${String(minute).padStart(2,"0")}:00Z`, payload: { type: "token_count", rate_limits: { primary: { used_percent: 70 + minute, window_minutes: 300, resets_at: 1784548800 } } } }, "fixture");
    snapshot.limitsCache = quotas.finalize(snapshot.sessions, "2026-07-20T10:10:00Z", false);
    const { clearLimitsCacheView, renderLimitsCache } = await import(new URL("../src/public/views/limits-cache.js", import.meta.url).href);
    cleanup = () => clearLimitsCacheView(container);
    renderLimitsCache(container, snapshot, {});
    assert.match(container.text(), /Account-wide headroom/);
    assert.match(container.text(), /Cache economics/);
    assert.match(container.text(), /Subscription comparison/);
    assert.ok(container.descendants().some((e) => e.tag === "svg" && e.attributes["role"] === "img"));
    const codexProfile = snapshot.limitsCache.profiles.find((p) => p.provider === "codex")!;
    byId("lc-profile")!.change(codexProfile.key);
    assert.match(container.text(), /Headroom at last observation/);
    assert.match(container.text(), /20.0%/);
    byId("lc-group")!.change("model");
    assert.doesNotMatch(container.text(), /SYNTHETIC-MODEL-SENTINEL/);
    assert.equal(byId("lc-group")!.value, "model");
    assert.equal(focused, byId("lc-group"));
    byId("lc-trend")!.change(byId("lc-trend")!.children[1]!.value);
    assert.notEqual(byId("lc-trend")!.value, "all");
    byId("lc-execution")!.change("subagent");
    assert.equal(byId("lc-execution")!.value, "subagent");
    assert.doesNotMatch(container.text(), /NaN|Infinity|undefined|secret-command|secret-path|content-is-not-returned/);
    renderLimitsCache(container, snapshot, { start: "2099-01-01", end: "2099-01-02" });
    assert.match(container.text(), /No request-level cache evidence/);
    assert.match(container.text(), /No dated API-equivalent usage/);
    assert.match(container.text(), /20.0%/); // Account-wide quota ignores the date/repository controls.
    assert.equal(byId("lc-session"), undefined);
    // Later allowed evidence must not extend the numeric sample's expiry.
    codexProfile.windows[0]!.latest = { ...codexProfile.windows[0]!.latest, timestamp: "2026-07-20T10:11:00Z", usedPercent: null, status: "allowed" };
    Date.now = () => Date.parse("2026-07-20T10:25:30Z");
    renderLimitsCache(container, snapshot, {});
    assert.match(container.text(), /Headroom unavailable · stale snapshot/);
    renderLimitsCache(container, { ...snapshot, limitsCache: undefined }, {});
    assert.match(container.text(), /unavailable in this snapshot/);
  } finally {
    cleanup?.(); Date.now = originalNow;
    if (originalDocument === undefined) delete globals["document"]; else globals["document"] = originalDocument;
    if (originalOption === undefined) delete globals["Option"]; else globals["Option"] = originalOption;
    await rm(directory, { recursive: true, force: true });
  }
});

test("compaction-only sessions and trailing event days render without usage rows and obey event filters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compaction-view-"));
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals["document"], originalOption = globals["Option"];
  const container = new Element("section");
  const byId = (id: string) => container.descendants().find((e) => e.id === id);
  globals["document"] = { createElement: (tag: string) => new Element(tag), createElementNS: (_namespace: string, tag: string) => new Element(tag), getElementById: byId };
  globals["Option"] = OptionElement;
  let cleanup: (() => void) | undefined;
  try {
    const snapshot = await analyzeMachineSessions({ ...await createSessionAnalyticsFixture(directory), dataDir: directory });
    for (const session of snapshot.sessions) if (session.limitsCache) session.limitsCache.compactions = [];
    const session = snapshot.sessions.find((s) => s.provider === "claude")!;
    session.limitsCache!.compactions = [{ timestamp: "2026-07-21T10:00:00.000Z", executionKind: "top-level", trigger: "manual", preTokens: 180000, postTokens: 40000, turnsSincePrevious: null }];
    const only = structuredClone(session);
    only.sessionKey = "compaction-only"; only.limitsCache!.buckets = [];
    only.limitsCache!.compactions[0]!.timestamp = "2026-07-22T10:00:00.000Z";
    snapshot.sessions.push(only);
    const { clearLimitsCacheView, renderLimitsCache, economicsForView } = await import(new URL("../src/public/views/limits-cache.js", import.meta.url).href);
    cleanup = () => clearLimitsCacheView(container);
    for (const [day, key] of [["2026-07-21", session.sessionKey], ["2026-07-22", only.sessionKey]]) {
      const options = { start: day, end: day, repositoryId: session.repositoryId };
      assert.equal(economicsForView(snapshot.sessions, options).sessionRows.length, 0);
      renderLimitsCache(container, snapshot, options);
      byId("lc-execution")!.change("all");
      assert.match(container.text(), /No request-level cache evidence/);
      assert.doesNotMatch(container.text(), /No dated compaction boundaries/);
      assert.ok(container.text().includes(key!));
      byId("lc-execution")!.change("subagent");
      assert.match(container.text(), /No dated compaction boundaries/);
      renderLimitsCache(container, snapshot, { ...options, repositoryId: "excluded" });
      byId("lc-execution")!.change("all");
      assert.match(container.text(), /No dated compaction boundaries/);
    }
  } finally {
    cleanup?.();
    if (originalDocument === undefined) delete globals["document"]; else globals["document"] = originalDocument;
    if (originalOption === undefined) delete globals["Option"]; else globals["Option"] = originalOption;
    await rm(directory, { recursive: true, force: true });
  }
});

// Execute the actual shared-control functions without booting unrelated dashboard panels.
async function appFunction(name: string, globals: Record<string, unknown>) {
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  const fn = source.match(new RegExp(`function ${name}\\([^]*?\\n}`))?.[0];
  assert.ok(fn, `Missing shared control ${name}`);
  return runInNewContext(`(${fn})`, globals);
}

test("shared date bounds include trailing compactions even for sessions without usage", async () => {
  const elements = { windowStart: { min: "", max: "", value: "" }, windowEnd: { min: "", max: "", value: "" }, windowPreset: { value: "" } };
  const observedRange = await appFunction("observedRange", { snapshot: { sessions: [
    { createdAt: "2026-09-29T10:00:00Z", spendByDay: {}, limitsCache: { buckets: [], compactions: [{ timestamp: "2026-09-30T10:00:00.000Z" }], cacheBreaks: [] } },
  ] } });
  assert.equal(observedRange().maximum, "2026-09-30");
  assert.equal(observedRange().minimum, "2026-09-29");
});

test("shared scope caption distinguishes request and event dates from session starts and account quotas", async () => {
  const elements = { retentionNote: { hidden: true, textContent: "" }, scope: { textContent: "" }, scopeChip: { hidden: true }, scopeChipLabel: { textContent: "" } };
  let view = "limits-cache";
  const render = await appFunction("renderSharedView", { elements, selectedRepository: () => null,
    renderRepositoryNav() {}, currentViewName: () => view, windowCaption: () => "2026-10-01 through 2026-10-03" });
  render({ summary: {} });
  assert.match(elements.scope.textContent, /Request.*dates.*2026-10-01/);
  assert.match(elements.scope.textContent, /[Qq]uota.*account-wide/);
  assert.doesNotMatch(elements.scope.textContent, /Sessions started/);
  view = "costs"; render({ summary: {} });
  assert.match(elements.scope.textContent, /Sessions started during 2026-10-01/);
});
