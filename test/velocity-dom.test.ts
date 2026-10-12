import assert from "node:assert/strict";
import test from "node:test";
import { agentLabels, buildVelocity } from "../src/public/velocity-data.js";
import type { SessionAnalytics, VelocityEffort } from "../src/types.ts";

import { Element, documentFromHtml } from "./release-dom.ts";
import { sample, withLedger } from "./validation/aggregation-ui-harness.ts";

const descendants = (node: Element): Element[] => node.children.flatMap((child) => [child, ...descendants(child)]);
const hasClass = (node: Element, name: string) => `${node.className} ${node.getAttribute("class") ?? ""}`.split(" ").includes(name);

test("lead cards show a dash when no session has a ledger", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentFromHtml("") });
  try {
    const { renderVelocity } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    const container = new Element(), context = { start: "2026-09-30", end: "2026-10-01", generatedAt: "2026-10-01T12:00:00Z", timeZone: "Europe/London" };
    const missing = sample(), ledgered = withLedger(sample(), [["synthetic", 3]]);
    const usage = () => container.querySelector(".velocity-lead")!.children[1]!;
    renderVelocity(container, [missing], context);
    assert.equal(usage().querySelector("strong")!.textContent, "—");
    assert.equal(usage().querySelector("strong")!.getAttribute("aria-label"), "No session in this selection has activity dates");
    assert.match(usage().querySelector(".kpi-reason")!.textContent, /No session in this selection has activity dates/);
    renderVelocity(container, [ledgered, missing], context);
    assert.equal(usage().querySelector("strong")!.textContent, "$3.00");
    assert.match(usage().querySelector(".coverage")!.textContent, /partial.*1\/2/);
    assert.match(usage().textContent, /1 of 2 selected sessions provide activity dates/);
    renderVelocity(container, [withLedger(sample(), [["synthetic", 0]])], context);
    assert.equal(usage().querySelector("strong")!.textContent, "$0.00", "an observed zero is available");
    assert.equal(usage().querySelector(".coverage"), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

function categorySessions(group: string, ids: string[]): SessionAnalytics[] {
  return ids.map((id, i) => ({
    provider: "claude", repositoryId: id, repositoryName: id, velocity: {
      dimensions: [{ agent: "claude-cli", model: "synthetic", executionKind: group === "execution" ? id : "top-level", effort: group === "effort" ? id : "unknown" }],
      buckets: [
        ["2026-09-01", 12, 0, [i + 1, 100, 100, 0, 0, 20, 0, 4, 0, 1, 120, 20, 100, 100]],
        ["2026-09-02", 12, 0, [ids.length - i, 100, 100, 0, 0, 20, 0, 4, 0, 1, 120, 20, 100, 100]],
      ], undated: [],
    },
  })) as unknown as SessionAnalytics[];
}

function assertCategoryEncodings(container: Element, mode: string, slots: Map<string, number | null>) {
  const nodes = descendants(container);
  const paths = container.querySelectorAll(mode === "stacked" ? ".velocity-area" : ".velocity-line");
  const legend = container.querySelector(".velocity-legend")!;
  assert.equal(paths.length, slots.size);
  const signatures = new Map<string, string>();
  for (const path of paths) {
    const id = path.dataset["series"]!;
    assert.ok(slots.has(id), `expected series ${id}`);
    const slot = slots.get(id)!;
    const color = slot === null ? "var(--provider-unknown)" : `var(--category-${slot % 4})`;
    const repeated = slot !== null && slot >= 4;
    assert.equal(path.getAttribute("stroke"), color, id);
    assert.equal(path.dataset["pattern"], repeated ? "diagonal" : "solid", id);
    const swatch = legend.children.find((item) => item.dataset["series"] === id)!.querySelector(".chart-legend-swatch")!;
    assert.equal(swatch.style["--series-color"], color);
    assert.equal(swatch.dataset["mark"], mode === "stacked" ? "rect" : "line");
    assert.equal(swatch.dataset["pattern"], repeated ? mode === "stacked" ? "diagonal" : "dashed" : "solid");
    if (mode === "stacked") {
      if (repeated) {
        const pattern = nodes.find((node) => node.tagName === "pattern" && path.getAttribute("fill") === `url(#${node.id})`);
        assert.ok(pattern, `${id}: stacked fill must reference a real texture`);
        assert.equal(pattern.querySelector("rect")!.getAttribute("fill"), color);
      } else assert.equal(path.getAttribute("fill"), color);
    } else assert.equal(path.getAttribute("stroke-dasharray"), repeated ? "6 3" : "none");
    const point = nodes.find((node) => node.tagName === "circle" && node.dataset["series"] === id)!;
    assert.equal(point.getAttribute("stroke"), color);
    assert.equal(point.getAttribute("fill"), mode === "stacked" ? path.getAttribute("fill") : repeated ? "var(--surface)" : color);
    signatures.set(id, [color, path.getAttribute("stroke-dasharray"), path.dataset["pattern"]].join("|"));
  }
  for (const node of nodes) assert.doesNotMatch(JSON.stringify([node.attributes, node.style]), /--velocity-/);
  return signatures;
}

test("Velocity repositories use four solid categorical slots, textured repeats and a grey Other", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentFromHtml("") });
  try {
    const { renderVelocityChart } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    const sessions = categorySessions("repository", Array.from({ length: 9 }, (_, i) => `repo-${i}`));
    for (const mode of ["stacked", "lines", "cumulative"]) {
      const data = buildVelocity(sessions, { start: "2026-09-01", end: "2026-09-01", mode, group: "repository" });
      assert.equal(data.series.length, 8);
      assert.equal(data.series.at(-1)!.label, "Other (2)");
      const container = new Element(); renderVelocityChart(container, data);
      const signatures = assertCategoryEncodings(container, mode, new Map(data.series.map((series, i) => [series.id, series.id === "other" ? null : i])));
      assert.equal(new Set(signatures.values()).size, 8, "all seven repositories and Other have distinct encodings");
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("Velocity execution and effort identities keep their categorical colour and texture across ranks and filters", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentFromHtml("") });
  try {
    const { renderVelocityChart } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    const effortSlots = { low: 0, medium: 1, high: 2, xhigh: 3, minimal: 4, none: 5, max: 6, ultra: 7, unknown: null } satisfies Record<VelocityEffort, number | null>;
    for (const [group, mapping] of Object.entries({ execution: { "top-level": 0, subagent: 1, unknown: null }, effort: effortSlots })) {
      const slots = new Map<string, number | null>(Object.entries(mapping));
      const sessions = categorySessions(group, [...slots.keys()]);
      for (const mode of ["stacked", "lines", "cumulative"]) {
        const render = (selected: SessionAnalytics[], day: string) => {
          const data = buildVelocity(selected, { start: day, end: day, mode, group });
          const container = new Element(); renderVelocityChart(container, data);
          return assertCategoryEncodings(container, mode, new Map(data.series.map((series) => [series.id, slots.get(series.id)!])));
        };
        const all = render(sessions, "2026-09-01");
        assert.equal(new Set(all.values()).size, slots.size);
        const reordered = render(sessions, "2026-09-02");
        assert.notDeepEqual([...reordered.keys()], [...all.keys()], "fixture must change spend rank");
        const filtered = render(sessions.filter((_, i) => i % 2 === 0), "2026-09-02");
        for (const result of [reordered, filtered]) for (const [id, encoding] of result) assert.equal(encoding, all.get(id), `${group}: ${id} retains its encoding`);
      }
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("Velocity reserves grey for unknown categories and uses the ramp for future non-brand groups", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentFromHtml("") });
  try {
    const { renderVelocityChart } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    const neutral = ["Other", "unknown", "<unknown>", "not recorded", "Unknown execution"];
    const sessions = categorySessions("repository", [...neutral, "recorded"]);
    for (const group of ["repository", "future-group"]) for (const mode of ["stacked", "lines", "cumulative"]) {
      const data = buildVelocity(sessions, { start: "2026-09-01", end: "2026-09-01", mode, group: "repository" });
      data.group = group;
      const container = new Element(); renderVelocityChart(container, data);
      assertCategoryEncodings(container, mode, new Map(data.series.map((series, i) => [series.id, neutral.includes(series.id) ? null : i])));
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

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
    assert.match(lead.textContent, /4 calendar days · API-equivalent and provider-reported · partially observed/);
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
    claude.checked = false; claude.listeners.get("change")!();
    assert.equal(lead.querySelectorAll("strong")[1]!.textContent.trim(), "—");
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
      provider: agent.startsWith("claude-") ? "claude" : agent.startsWith("codex-") ? "codex" : agent,
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
          assert.match(path.getAttribute("stroke")!, /^var\(--provider-(claude|codex|cursor|copilot|opencode|gemini)-[0-3]\)$/);

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

test("Velocity provider and model groups use shared brand colours and reciprocal legend hover", async () => {
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
      const item = container.querySelector('.chart-legend-item[role="listitem"]')!;
      item.listeners.get("pointerenter")!();
      assert.equal(svg.getAttribute("data-highlight"), item.dataset["series"]);
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

test("Velocity keeps CSS-pixel chart dimensions and fits its axis labels on narrow charts", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentFromHtml("") });
  try {
    const { renderVelocityChart } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    // Axis text is drawn at CSS-pixel size; 7 px per mono character is the estimate the chart uses.
    const extent = (node: Element) => {
      const x = Number(node.getAttribute("x")), width = node.textContent.length * 7, anchor = node.getAttribute("text-anchor");
      return anchor === "end" ? [x - width, x] : anchor === "middle" ? [x - width / 2, x + width / 2] : [x, x + width];
    };
    const cases = [
      { granularity: "day", start: "2026-09-01", end: "2026-09-05" },
      { granularity: "week", start: "2026-06-01", end: "2026-09-27" },
    ];
    for (const { granularity, start, end } of cases) {
      const data = buildVelocity(categorySessions("repository", ["repo-a"]), { start, end, group: "repository", granularity });
      for (const width of [280, 390, 480, 800, 1040]) for (const compactView of [false, true]) {
        const container = Object.assign(new Element(), { clientWidth: width });
        renderVelocityChart(container, data, { compactView });
        const svg = container.querySelector("svg")!;
        const height = compactView ? (width < 560 ? 240 : 290) : (width < 560 ? 260 : 330);
        const label = `${granularity} at ${width}px${compactView ? " (compact)" : ""}`;
        assert.equal(svg.getAttribute("viewBox"), `0 0 ${width} ${height}`, label);
        const left = Number(svg.querySelector(".grid-line")!.getAttribute("x1"));
        const yLabels = svg.querySelectorAll(".axis-label").filter((node) => node.getAttribute("y") !== String(height - 12));
        for (const node of yLabels) assert.ok(extent(node)[0]! >= 0, `${label}: y label ${node.textContent} is clipped`);
        const ticks = svg.querySelectorAll(".axis-label").filter((node) => node.getAttribute("y") === String(height - 12));
        assert.ok(ticks.length >= 1 && ticks.length <= 5, label);
        assert.ok(extent(ticks[0]!)[0]! >= left - 1 && extent(ticks.at(-1)!)[1]! <= width, `${label}: ticks stay in the plot`);
        for (let index = 1; index < ticks.length; index += 1) assert.ok(extent(ticks[index - 1]!)[1]! < extent(ticks[index]!)[0]!, `${label}: ticks ${index - 1} and ${index} overlap`);
        if (width >= (granularity === "week" ? 1040 : 800)) assert.equal(ticks.length, 5, label);
        if (granularity === "day") assert.equal(ticks.at(-1)!.textContent, "2026-09-05", label);
      }
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
