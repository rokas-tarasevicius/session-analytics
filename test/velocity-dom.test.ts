import assert from "node:assert/strict";
import test from "node:test";
import { agentLabels, buildVelocity } from "../src/public/velocity-data.js";
import type { SessionAnalytics } from "../src/types.ts";

import { Element, documentFromHtml } from "./release-dom.ts";

const descendants = (node: Element): Element[] => node.children.flatMap((child) => [child, ...descendants(child)]);
const hasClass = (node: Element, name: string) => `${node.className} ${node.getAttribute("class") ?? ""}`.split(" ").includes(name);

test("Velocity leads with value cards before filters and keeps them independent of the plotted metric", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentFromHtml("") });
  try {
    const { renderVelocity, formatMetric } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    const sessions = ["claude", "codex"].map((provider, i) => ({
      provider, createdAt: "2026-08-01T12:00:00Z", repositoryId: "synthetic", repositoryName: "Synthetic", velocity: {
        dimensions: [{ agent: `${provider}-cli`, model: "synthetic", executionKind: "top-level", effort: "unknown" }],
        buckets: [["2026-09-01", 12, 0, [i + 2, 100, 100, 0, 0, 20, 0, 4, 0, 0, i ? 100 : 120, 20, 100, 100]], ["2026-09-03", 12, 0, [i + 2, 100, 100, 0, 0, 20, 0, 4, 0, 0, 120, 20, 100, 100]]],
        undated: [[0, [100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]],
      },
    })) as unknown as SessionAnalytics[];
    const container = new Element(), context = { start: "2026-09-01", end: "2026-09-04", generatedAt: "2026-09-04T12:00:00Z", timeZone: "Europe/London" };
    renderVelocity(container, sessions, context);
    const lead = container.querySelector(".velocity-lead")!;
    assert.equal(container.children[0], lead); assert.ok(container.children[1]!.classList.contains("filter-bar"));
    assert.ok(container.children[2]!.classList.contains("panel")); assert.equal(container.children[3], container.querySelector(".velocity-totals"));
    assert.deepEqual(lead.querySelectorAll(".kpi-label").map((node) => node.textContent.trim()), ["Average price", "Usage value"]);
    assert.ok(lead.children[0]!.classList.contains("accent"));
    const total = buildVelocity(sessions, { ...context, metric: "value" }).totals[0]!;
    const assertLead = (value: number) => assert.equal(lead.querySelectorAll("strong")[1]!.textContent.trim(), formatMetric(value, "value"));
    assertLead(total); assert.equal(lead.querySelector("strong")!.textContent.trim(), "$5.00");
    assert.match(lead.textContent, /per active day · 2 of 4 days active · \$2.50 per calendar day/);
    assert.match(lead.textContent, /4 calendar days · API-equivalent · partially observed/);
    assert.equal(container.querySelectorAll(".velocity-totals")[0]!.children.length, 3);
    assert.doesNotMatch(container.textContent, /Selected period/);
    const metric = container.querySelector("#velocity-metric")!, granularity = container.querySelector("#velocity-granularity")!;
    const change = (control: Element, value: string) => { control.value = value; control.listeners.get("change")!(); };
    change(metric, "input"); assertLead(total);
    assert.equal(container.querySelector("[data-velocity-total]")!.textContent.trim(), "400");
    assert.match(container.querySelector(".panel-meta")!.textContent, /Total\s+400\s+· 2026-09-01 → 2026-09-04 · Europe\/London/);
    for (const value of ["week", "month", "hour", "day"]) { change(granularity, value); assertLead(total); }
    change(metric, "value");
    for (const value of ["week", "month", "hour", "day"]) { change(granularity, value); assertLead(total); }
    change(container.querySelector("#velocity-mode")!, "cumulative"); assertLead(total);
    const codex = container.querySelector('[data-provider="codex"]')!.querySelector("input")!;
    codex.checked = false; codex.listeners.get("change")!(); assertLead(4);
    assert.match(lead.textContent, /6 of 7 providers/); assert.doesNotMatch(lead.textContent, /partially observed/);
    renderVelocity(container, sessions, { ...context, end: "2026-09-02" }); assertLead(2);
    assert.match(lead.textContent, /1 of 2 days active · \$1.00 per calendar day/);
    const claude = container.querySelector('[data-provider="claude"]')!.querySelector("input")!;
    claude.checked = false; claude.listeners.get("change")!(); assertLead(0);
    assert.equal(lead.querySelector("strong")!.textContent.trim(), "—");
    assert.match(lead.textContent, /No days with positive usage value/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("agent SVG encodings are unique, stable under filtering and reproduced in the legend", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_namespace: string, tag: string) => new Element(tag),
  } });
  try {
    const { renderVelocityChart } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    const sessions = Object.keys(agentLabels).map((agent, i) => ({
      provider: agent.startsWith("claude-") ? "claude" : agent.startsWith("codex-") ? "codex" : "cursor",
      repositoryId: "synthetic", repositoryName: "Synthetic", velocity: {
        dimensions: [{ agent, model: "synthetic", executionKind: "top-level", effort: "high" }],
        buckets: [["2026-09-01", 12, 0, [i + 1, 100, 100, 0, 0, 20, 0, 4, 0, 1, 120, 20, 100, 100]], ["2026-09-02", 12, 0, [16 - i, 100, 100, 0, 0, 20, 0, 4, 0, 1, 120, 20, 100, 100]]], undated: [],
      },
    })) as unknown as SessionAnalytics[];
    for (const mode of ["stacked", "lines", "cumulative"]) {
      const render = (selected: SessionAnalytics[], day: string) => {
        const data = buildVelocity(selected, { start: day, end: day, mode, group: "agent" });
        const container = new Element("div");
        renderVelocityChart(container, data);
        const nodes = descendants(container);
        const paths = nodes.filter((node) => hasClass(node, mode === "stacked" ? "velocity-area" : "velocity-line"));
        const legend = nodes.find((node) => hasClass(node, "velocity-legend"))!;
        assert.equal(paths.length, data.series.length);
        const signature = (path: Element) => [path.getAttribute("stroke"), path.getAttribute("stroke-dasharray"), path.getAttribute("data-pattern")].join("|");
        assert.equal(new Set(paths.map(signature)).size, data.series.length, `${mode}: each supported agent must have a distinct encoding`);
        for (let i = 0; i < paths.length; i += 1) {
          const path = paths[i]!;
          const swatch = descendants(legend.children[i]!).find((node) => hasClass(node, "chart-legend-swatch"));
          assert.ok(swatch, "Legend must reproduce the area pattern or line dash");
          assert.equal(swatch.style["--series-color"], path.getAttribute("stroke"));
          assert.equal(swatch.dataset["mark"], mode === "stacked" ? "rect" : "line");
          assert.equal(swatch.dataset["pattern"], path.getAttribute("data-pattern") === "solid" ? "solid" : mode === "stacked" ? "diagonal" : "dashed");
          if (mode === "stacked") {
            const reference = path.getAttribute("fill")!;
            if (reference.startsWith("url(#")) assert.ok(nodes.some((node) => node.tagName === "pattern" && reference === `url(#${node.getAttribute("id")})`));
          } else assert.equal(path.getAttribute("stroke-dasharray"), swatch.dataset["pattern"] === "dashed" ? "6 3" : "none");
          assert.match(path.getAttribute("stroke")!, /^var\(--provider-(claude|codex|cursor)-[0-3]\)$/);

        }
        return new Map(paths.map((path, i) => [data.series[i]!.id, signature(path)]));
      };
      const all = render(sessions, "2026-09-01");
      const filtered = render(sessions.filter((_, i) => i % 3 !== 0), "2026-09-02");
      for (const [id, encoding] of filtered) assert.equal(encoding, all.get(id), `${id} must keep its encoding after rank/date/provider changes`);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("Velocity provider and model groups use shared brand colours and reciprocal legend focus", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (tag: string) => new Element(tag), createElementNS: (_namespace: string, tag: string) => new Element(tag),
  } });
  try {
    const { renderVelocityChart } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    const { providerColor, modelColor } = await import("../src/public/chart-colors.js");
    const sessions = ["claude", "codex", "gemini"].map((provider, i) => ({
      provider, repositoryId: "synthetic", repositoryName: "Synthetic", velocity: {
        dimensions: [{ agent: `${provider}-cli`, model: ["claude-opus-4.6", "gpt-5-mini", "gemini-3-flash"][i], executionKind: "top-level", effort: "high" }],
        buckets: [["2026-09-01", 12, 0, [i + 1, 100, 100, 0, 0, 20, 0, 4, 0, 1, 120, 20, 100, 100]]], undated: [],
      },
    })) as unknown as SessionAnalytics[];
    for (const group of ["provider", "model"]) {
      const data = buildVelocity(sessions, { start: "2026-09-01", end: "2026-09-01", mode: "lines", group });
      const container = new Element(); renderVelocityChart(container, data);
      const svg = container.querySelector("svg")!, paths = svg.querySelectorAll(".velocity-line");
      assert.equal(paths.length, 3);
      for (const path of paths) {
        const id = path.dataset["series"]!;
        const [provider, model] = id.split(":");
        assert.equal(path.getAttribute("stroke"), group === "provider" ? providerColor(id) : modelColor(provider, model));
      }
      const button = container.querySelector(".chart-legend-item")!;
      button.listeners.get("focus")!();
      assert.equal(svg.getAttribute("data-highlight"), button.dataset["series"]);
      const point = svg.querySelector("circle")!;
      assert.ok(point.dataset["series"], "single-bucket points link to the same legend");
      point.listeners.get("pointerenter")!();
      assert.equal(svg.getAttribute("data-highlight"), point.dataset["series"]);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
