import assert from "node:assert/strict";
import test from "node:test";
import { agentLabels, buildVelocity, calendarDays } from "../src/public/velocity-data.js";
import { axisTicks } from "../src/public/chart-scale.js";
import { allocateSlots, providerKey, slotColor } from "../src/public/chart-colors.js";
import type { SessionAnalytics, VelocityEffort } from "../src/types.ts";

import { Element, documentFromHtml } from "./release-dom.ts";

const descendants = (node: Element): Element[] => node.children.flatMap((child) => [child, ...descendants(child)]);
const hasClass = (node: Element, name: string) => `${node.className} ${node.getAttribute("class") ?? ""}`.split(" ").includes(name);

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
    assert.equal(path.dataset["pattern"], repeated ? mode === "stacked" ? "diagonal" : "marker" : "solid", id);
    const swatch = legend.children.find((item) => item.dataset["series"] === id)!.querySelector(".chart-legend-swatch")!;
    assert.equal(swatch.style["--series-color"], color);
    assert.equal(swatch.dataset["mark"], mode === "stacked" ? "rect" : "line");
    assert.equal(swatch.dataset["pattern"], repeated ? mode === "stacked" ? "diagonal" : "marker" : "solid");
    if (mode === "stacked") {
      if (repeated) {
        const pattern = nodes.find((node) => node.tagName === "pattern" && path.getAttribute("fill") === `url(#${node.id})`);
        assert.ok(pattern, `${id}: stacked fill must reference a real texture`);
        assert.equal(pattern.querySelector("rect")!.getAttribute("fill"), color);
      } else assert.equal(path.getAttribute("fill"), color);
    } else assert.equal(path.getAttribute("stroke-dasharray"), "none");
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
    const group = container.querySelector("#velocity-group")!;
    assert.equal(group.value, "provider");
    assert.deepEqual(group.options.map((option) => option.textContent), ["Provider", "Agent", "Model", "Repository", "Execution kind", "Effort"]);
    const lead = container.querySelector(".velocity-lead")!;
    assert.equal(container.children[0], lead); assert.ok(container.children[1]!.classList.contains("filter-bar"));
    assert.ok(container.children[2]!.classList.contains("panel")); assert.equal(container.children[3], container.querySelector(".velocity-totals"));
    assert.deepEqual(lead.querySelectorAll(".kpi-label").map((node) => node.textContent.trim()), ["Avg per day", "Usage value"]);
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
    const sessions = ["claude-cli", "claude-sdk", "claude-general-purpose", "codex-cli", "codex-exec", "cursor"].map((agent, i) => ({
      provider: agent.startsWith("claude-") ? "claude" : agent.startsWith("codex-") ? "codex" : agent,
      repositoryId: "synthetic", repositoryName: "Synthetic", velocity: {
        dimensions: [{ agent, model: "synthetic", executionKind: "top-level", effort: "high" }],
        buckets: [["2026-09-01", 12, 0, [i + 1, 100, 100, 0, 0, 20, 0, 4, 0, 1, 120, 20, 100, 100]], ["2026-09-02", 12, 0, [20 - i, 100, 100, 0, 0, 20, 0, 4, 0, 1, 120, 20, 100, 100]]], undated: [],
      },
    })) as unknown as SessionAnalytics[];
    for (const mode of ["stacked", "lines", "cumulative"]) {
      const render = (selected: SessionAnalytics[], day: string) => {
        const data = buildVelocity(selected, { start: day, end: day, mode, group: "agent", limit: Infinity });
        const container = new Element("div");
        renderVelocityChart(container, data);
        const nodes = descendants(container);
        const paths = nodes.filter((node) => hasClass(node, mode === "stacked" ? "velocity-area" : "velocity-line"));
        const legend = nodes.find((node) => hasClass(node, "velocity-legend"))!;
        assert.equal(paths.length, data.series.length);
        const signature = (path: Element) => [path.getAttribute("stroke"), path.getAttribute("stroke-dasharray"), path.getAttribute("data-pattern")].join("|");
        assert.equal(new Set(paths.map(signature)).size, data.series.length, `${mode}: each visible agent must have a distinct encoding`);
        for (let i = 0; i < paths.length; i += 1) {
          const path = paths[i]!;
          const swatch = descendants(legend.children[i]!).find((node) => hasClass(node, "chart-legend-swatch"));
          assert.ok(swatch, "Legend must reproduce the area pattern or line marker");
          assert.equal(swatch.style["--series-color"], path.getAttribute("stroke"));
          assert.equal(swatch.dataset["mark"], mode === "stacked" ? "rect" : "line");
          assert.equal(swatch.dataset["pattern"], path.getAttribute("data-pattern") === "solid" ? "solid" : mode === "stacked" ? "diagonal" : "marker");
          if (mode === "stacked") {
            const reference = path.getAttribute("fill")!;
            if (reference.startsWith("url(#")) assert.ok(nodes.some((node) => node.tagName === "pattern" && reference === `url(#${node.getAttribute("id")})`));
          } else assert.equal(path.getAttribute("stroke-dasharray"), "none");
          if (path.dataset["series"] === "other") assert.equal(path.getAttribute("stroke"), "var(--provider-unknown)");
          else assert.match(path.getAttribute("stroke")!, /^var\(--provider-(claude|codex|cursor|copilot|opencode|gemini)-[0-3]\)$/);

        }
        return new Map(paths.map((path, i) => [data.series[i]!.id, signature(path)]));
      };
      const all = render(sessions, "2026-09-01");
      const reordered = render(sessions, "2026-09-02");
      const filtered = render(sessions.filter((session) => session.provider !== "claude"), "2026-09-02");
      for (const [id, encoding] of [...reordered, ...filtered]) assert.equal(encoding, all.get(id), `${id} must keep its encoding after rank/date/provider changes`);
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
    const { providerColor, slotColor } = await import("../src/public/chart-colors.js");
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
        // Each provider shows one model here, so it wears the brand shade (slot 0) of the provider that ran it.
        assert.equal(path.getAttribute("stroke"), group === "provider" ? providerColor(id) : slotColor(provider, 0), model);
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
        const widest = Math.max(...axisTicks(data.keys, data.granularity as "day" | "week", 12).map(({ label }) => label.length * 7)) + 24;
        const expected = axisTicks(data.keys, data.granularity as "day" | "week", Math.max(2, Math.min(7, Math.floor((width - left - 18 + 24) / widest))));
        assert.deepEqual(ticks.map((tick) => tick.textContent), expected.map((tick) => tick.label), label);
        assert.ok(extent(ticks[0]!)[0]! >= left - 1 && extent(ticks.at(-1)!)[1]! <= width, `${label}: ticks stay in the plot`);
        for (let index = 1; index < ticks.length; index += 1) assert.ok(extent(ticks[index - 1]!)[1]! < extent(ticks[index]!)[0]!, `${label}: ticks ${index - 1} and ${index} overlap`);
        if (granularity === "day") assert.equal(ticks.at(-1)!.textContent, "Sep 5", label);
      }
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

async function withDocument(run: (velocity: any, document: ReturnType<typeof documentFromHtml>) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), document = documentFromHtml("");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  try { run(await import(new URL("../src/public/velocity.js", import.meta.url).href), document); }
  finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

function historySession(model: string, start: string, end: string, value: (day: string) => number, priced = 1): SessionAnalytics {
  return {
    provider: "codex", repositoryId: model, repositoryName: model, createdAt: `${start}T00:00:00Z`,
    velocity: {
      dimensions: [{ agent: "codex-cli", model, executionKind: "top-level", effort: "high" }],
      buckets: calendarDays(start, end).map((day) => [day, 12, 0, [value(day), 100, 100, 0, 0, 20, 0, 4, 0, 1, 120 * priced, 20, 100, 100]]),
      undated: [],
    },
  } as unknown as SessionAnalytics;
}

test("Velocity allocates distinct model shades and keeps Cursor models in the Cursor family", async () => {
  await withDocument(({ renderVelocityChart }) => {
    const models = ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-fable-5-1", "gpt-5.5", "gpt-5.6-terra"];
    const sessions = models.map((model) => {
      const session = historySession(model, "2026-10-01", "2026-10-20", () => 10);
      session.provider = model.startsWith("claude") ? "claude" : "codex";
      return session;
    });
    const cursor = historySession("claude-opus-5", "2026-10-01", "2026-10-20", () => 10); cursor.provider = "cursor";
    sessions.push(cursor);
    const signatures = new Map<string, string>();
    for (const mode of ["stacked", "lines", "cumulative"]) {
      const data = buildVelocity(sessions, { start: "2026-10-01", end: "2026-10-20", group: "model", mode });
      const container = new Element(); renderVelocityChart(container, data);
      const paths = container.querySelectorAll(mode === "stacked" ? ".velocity-area" : ".velocity-line");
      assert.equal(new Set(paths.map((path) => path.getAttribute("stroke"))).size, 7);
      for (const path of paths) {
        const id = path.dataset["series"]!, color = path.getAttribute("stroke")!;
        if (mode === "stacked") signatures.set(id, color); else assert.equal(color, signatures.get(id));
        if (id.startsWith("cursor:")) assert.match(color, /--provider-cursor-[0-3]/);
        if (mode !== "stacked") assert.equal(path.getAttribute("stroke-dasharray"), "none");
      }
    }
  });
});

test("Velocity overflow agents use sparse hollow points and folded Other stays neutral", async () => {
  await withDocument(({ renderVelocityChart }) => {
    const agents = Object.keys(agentLabels).filter((id) => id.startsWith("claude-")).slice(0, 5);
    const sessions = agents.map((agent, i) => {
      const session = historySession("claude-opus-5", "2026-09-01", "2026-10-09", () => i + 1);
      session.provider = "claude"; session.velocity!.dimensions[0]!.agent = agent as any; return session;
    });
    const data = buildVelocity(sessions, { start: "2026-09-01", end: "2026-10-09", group: "agent", mode: "lines" });
    const container = new Element(); renderVelocityChart(container, data);
    const paths = container.querySelectorAll(".velocity-line"), repeated = paths.filter((path) => path.dataset["pattern"] === "marker");
    assert.ok(repeated.length > 0);
    const agentOrder = Object.keys(agentLabels);
    const slots = allocateSlots(agents.map((id, index) => ({ id, provider: providerKey(id.split("-")[0]), preferred: index % 4, order: agentOrder.indexOf(id) })));
    for (const path of paths) {
      const id = path.dataset["series"]!, slot = slots.get(id)!;
      assert.equal(path.getAttribute("stroke"), slotColor(slot.provider, slot.slot));
      assert.equal(path.getAttribute("stroke-dasharray"), "none");
    }
    for (const path of repeated) {
      const points = container.querySelectorAll("circle").filter((point) => point.dataset["series"] === path.dataset["series"]);
      const stride = Math.ceil(data.keys.length / 16);
      const indices = data.keys.map((_, i) => i).filter((i) => i % stride === 0 || i === data.keys.length - 1);
      assert.equal(points.length, indices.length);
      assert.ok(points.every((point) => point.getAttribute("r") === "3" && point.getAttribute("fill") === "var(--surface)"));
      assert.equal(points.at(-1)!.getAttribute("cx"), "1022");
    }
    const extra = historySession("gpt-5.5", "2026-09-01", "2026-10-09", () => 10);
    renderVelocityChart(container, buildVelocity([...sessions, extra, historySession("another-model", "2026-09-01", "2026-10-09", () => 5)].map((session, i) => { if (i === 6) session.velocity!.dimensions[0]!.agent = "codex-review"; return session; }), { start: "2026-09-01", end: "2026-10-09", group: "agent", mode: "lines" }));
    const other = container.querySelectorAll(".velocity-line").find((path) => path.dataset["series"] === "other")!;
    assert.equal(other.getAttribute("stroke"), "var(--provider-unknown)");
    assert.equal(other.dataset["pattern"], "solid");
  });
});

test("Velocity tooltip and accessible readout sort bucket values and inspect with pointer and keyboard", async () => {
  await withDocument(({ renderVelocityChart }, document) => {
    const sessions = categorySessions("repository", ["first", "second", "third"]);
    const data = buildVelocity(sessions, { start: "2026-09-01", end: "2026-09-03", group: "repository", mode: "lines" });
    data.rolling = [1, 2, null]; data.rollingPartial = [false, true, false];
    data.series[0]!.values[1] = 0;
    const container = Object.assign(new Element(), { clientWidth: 390 });
    renderVelocityChart(container, data, { rolling: true });
    const svg = container.querySelector("svg")!, tooltip = container.querySelector(".velocity-tooltip")!, readout = () => container.querySelector(".velocity-readout")!;
    assert.equal(tooltip.hidden, true); assert.equal(tooltip.getAttribute("aria-hidden"), "true");
    assert.equal(readout().tagName, "dl"); assert.equal(readout().querySelectorAll("dt").length, 4);
    const inspection = container.querySelector(".velocity-inspection")!;
    assert.equal(inspection.getAttribute("aria-live"), "polite"); assert.equal(inspection.getAttribute("aria-atomic"), "true");
    const key = (key: string) => svg.listeners.get("keydown")!({ key, preventDefault() {} });
    svg.listeners.get("focus")!(); assert.equal(tooltip.hidden, false);
    key("Home"); assert.match(tooltip.textContent, /Tue, Sep 1, 2026/);
    const values = () => tooltip.querySelectorAll(".tip-row").map((row) => row.querySelector("strong")?.textContent.trim());
    assert.deepEqual(values(), ["$3.00", "$2.00", "$1.00", "$1.00"]);
    key("ArrowRight");
    assert.equal(tooltip.querySelectorAll(".tip-row").length, 3, "zero-valued series is omitted, average remains");
    assert.match(tooltip.textContent, /7-day average.*\$2.00\s+· partial/);
    assert.equal(readout().querySelectorAll("dt").length, 4, "readout keeps zero-valued series");
    assert.ok(readout().querySelectorAll("dt")[2]!.classList.contains("muted"));
    svg.listeners.get("pointerleave")!(); assert.equal(tooltip.hidden, true, "leaving the chart hides the tooltip; the readout keeps the selection");
    key("ArrowLeft"); assert.equal(tooltip.hidden, false, "the keyboard brings it back");
    svg.listeners.get("blur")!(); assert.equal(tooltip.hidden, true);
    svg.listeners.get("pointermove")!({ clientX: 200 }); assert.equal(tooltip.hidden, false);
    svg.listeners.get("pointerleave")!(); assert.equal(tooltip.hidden, true);
    Object.assign(tooltip, { offsetWidth: 220 });
    key("End"); assert.match(tooltip.textContent, /No activity/);
    assert.ok(parseFloat(tooltip.style.left) + 220 <= 390, "rightmost tooltip flips within the container");
    assert.match(tooltip.style.top, /^\d+px$/);
    svg.listeners.get("click")!({ clientX: 200 }); assert.equal(tooltip.hidden, false);
    assert.equal(document.activeElement, document.body, "test does not depend on browser layout");
  });
});

test("Velocity uses whole-dollar axes and identifies partial and unavailable rolling averages outside the legend", async () => {
  await withDocument(({ renderVelocityChart }) => {
    const session = historySession("gpt-5.3-codex-spark", "2026-10-01", "2026-10-20", () => 150, 0.9);
    const data = buildVelocity([session], { start: "2026-10-01", end: "2026-10-20", group: "provider" });
    const container = new Element(); renderVelocityChart(container, data, { rolling: true });
    assert.ok(container.querySelectorAll(".axis-label").some((node) => node.textContent === "$50"));
    assert.ok(container.querySelectorAll(".axis-label").filter((node) => node.textContent.startsWith("$")).every((node) => !node.textContent.includes(".")));
    const key = container.querySelector(".velocity-average-key")!;
    assert.equal(key.tagName, "p"); assert.equal(key.parentElement, container); assert.match(key.textContent, /7-day average of the total · faded where partly priced/);
    assert.equal(key.querySelector(".chart-legend-swatch")!.dataset["pattern"], "dashed");
    assert.ok(container.querySelectorAll(".velocity-average-partial").length > 0);
    const first = data.rolling.findIndex((value) => value !== null);
    data.rollingPartial = data.rolling.map((_, i) => i === first + 1);
    renderVelocityChart(container, data, { rolling: true });
    assert.equal(container.querySelectorAll(".velocity-average").length, 2, "complete and partial segments are separate");
    assert.equal((container.querySelector(".velocity-average-partial")!.getAttribute("d")!.match(/ L/g) ?? []).length, 2, "both segments touching the partial point fade");
    data.rolling = data.rolling.map(() => null);
    renderVelocityChart(container, data, { rolling: true });
    assert.equal(container.querySelectorAll(".velocity-average").length, 0);
    assert.match(container.querySelector(".velocity-average-key")!.textContent, /needs seven observed days with at least 75% of tokens priced/);
    data.metric = "input";
    renderVelocityChart(container, data, { rolling: true });
    assert.match(container.querySelector(".velocity-average-key")!.textContent, /75% metric evidence/);
    data.missingSessions = 1;
    renderVelocityChart(container, data, { rolling: true });
    assert.match(container.querySelector(".velocity-average-key")!.textContent, /refresh: some sessions have no activity ledger/);
    data.series = [];
    renderVelocityChart(container, data, { rolling: true });
    assert.equal(container.querySelector("svg"), null);
    assert.match(container.querySelector(".velocity-average-key")!.textContent, /refresh: some sessions have no activity ledger/);
  });
});

test("Velocity comparison and projection cards show partial causes and specific unavailable reasons", async () => {
  await withDocument(({ renderVelocity }) => {
    const sessions = [historySession("gpt-5.3-codex-spark", "2026-08-01", "2026-10-09", () => 10, 0.9)];
    const context = { start: "2026-09-10", end: "2026-10-09", generatedAt: "2026-10-09T12:00:00Z", timeZone: "Europe/London" };
    const container = new Element(); renderVelocity(container, sessions, context);
    const cards = container.querySelector(".velocity-totals")!.children;
    for (const card of cards) {
      assert.ok(card.querySelector("strong")!.querySelector(".velocity-partial"));
      assert.match(card.querySelector(".velocity-cause")!.textContent, /1 model with unpriced tokens: gpt-5.3-codex-spark/);
      assert.doesNotMatch(card.querySelector(".kpi-note")!.textContent, /partially priced/);
    }
    assert.match(container.textContent, /Projected by 2026-10-31.*partial/);
    assert.match(container.textContent, /at least 75% metric evidence/);
    renderVelocity(container, sessions, { ...context, end: "2026-10-01" });
    assert.match(container.querySelector(".velocity-totals")!.children[2]!.textContent, /Only for a window that includes today/);
    const short = [historySession("gpt-5.5", "2026-10-01", "2026-10-09", () => 10)];
    renderVelocity(container, short, context);
    assert.match(container.querySelector(".velocity-totals")!.children[2]!.textContent, /8 of 14 baseline days observed; all 14 needed/);
    renderVelocity(container, short, { ...context, end: "2026-10-01", generatedAt: "2026-10-01T12:00:00Z" });
    assert.match(container.textContent, /No month-end projection/);
    assert.match(container.textContent, /No completed day this month yet\./);
    assert.doesNotMatch(container.textContent, /Needs a 14-day baseline with complete evidence/);
  });
});

test("Velocity movers show signed decreases, New and guarded percentages with evidence in the name", async () => {
  await withDocument(({ renderVelocity }) => {
    const sessions = [
      historySession("decrease", "2026-09-01", "2026-10-09", (day) => day < "2026-10-02" ? 10 : 2, 0.9),
      historySession("new-model", "2026-09-01", "2026-10-09", (day) => day < "2026-10-02" ? 0 : 5),
      historySession("small-base", "2026-09-01", "2026-10-09", (day) => day < "2026-10-02" ? 0.05 : 2),
    ];
    const container = new Element();
    renderVelocity(container, sessions, { start: "2026-09-10", end: "2026-10-09", generatedAt: "2026-10-09T12:00:00Z", timeZone: "UTC" });
    const table = container.querySelector(".velocity-movers")!;
    assert.deepEqual(table.querySelector("thead")!.querySelectorAll("th").map((cell) => cell.textContent), ["Dimension", "Name", "Previous 7 days", "Last 7 days", "Change", "%"]);
    const rows = table.querySelector("tbody")!.children;
    assert.ok(rows.some((row) => row.children[4]!.textContent === "−$56.00" && row.children[5]!.textContent.includes("▼ 80%")));
    assert.ok(rows.some((row) => row.children[5]!.textContent.trim() === "New"));
    assert.ok(rows.some((row) => /—.*Base under \$1/.test(row.children[5]!.textContent)));
    assert.ok(rows.some((row) => row.children[1]!.querySelector(".velocity-partial")));
    for (const row of rows) {
      assert.match((row.children[1] as Element & { title: string }).title, /^Evidence: .* → /);
      assert.match(row.children[1]!.querySelector(".sr-only")!.textContent, /^Evidence: /);
    }
    assert.match(container.textContent, /Largest changes/);
    assert.match(container.textContent, /Oct 2–8 vs Sep 25–Oct 1 · last 7 completed days versus the 7 before · usage value\./);
    assert.match(container.textContent, /below 75% metric evidence/);
    assert.match(container.textContent, /Percentages need a prior value of at least \$1/);
  });
});

test("Velocity inspection uses full calendar dates for every granularity and cumulative totals", async () => {
  await withDocument(({ renderVelocityChart }) => {
    const session = historySession("gpt-5.5", "2026-10-05", "2026-10-09", () => 5);
    for (const [granularity, title] of [["day", "Fri, Oct 9, 2026"], ["week", "Week of Oct 5, 2026"], ["month", "October 2026"], ["hour", "23:00–23:59"]]) {
      const data = buildVelocity([session], { start: "2026-10-05", end: "2026-10-09", group: "provider", granularity });
      const container = new Element(); renderVelocityChart(container, data);
      assert.ok(container.querySelector(".velocity-inspection")!.querySelector("strong")!.textContent.startsWith(title!));
      const svg = container.querySelector("svg")!;
      svg.listeners.get("focus")!();
      assert.ok(container.querySelector(".tip-title")!.textContent.startsWith(title!));
      assert.ok(svg.querySelectorAll(".axis-label").every((label) => !label.textContent.includes("Week of")));
    }
    const data = buildVelocity([session], { start: "2026-10-05", end: "2026-10-09", group: "provider", mode: "cumulative" });
    const container = new Element(); renderVelocityChart(container, data, { rolling: true });
    assert.match(container.querySelector(".velocity-inspection")!.textContent, /Fri, Oct 9, 2026 · cumulative \$25.00/);
    assert.equal(container.querySelector(".velocity-average-key"), null);
    container.querySelector("svg")!.listeners.get("focus")!();
    assert.match(container.querySelector(".tip-title")!.textContent, /cumulative \$25.00/);
  });
});
