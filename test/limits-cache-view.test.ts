import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { LimitsCollector } from "../src/metrics/limits.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

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
    const snapshot = await analyzeMachineSessions({ ...fixture, dataDirectory: directory });
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
    Date.now = () => Date.parse("2026-07-20T10:26:00Z");
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
