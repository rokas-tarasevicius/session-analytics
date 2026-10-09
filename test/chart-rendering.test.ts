import assert from "node:assert/strict";
import test from "node:test";
import { renderLegend } from "../src/public/chart-legend.js";
import { modelSlots, providerColor, slotColor } from "../src/public/chart-colors.js";
import { Element } from "./release-dom.ts";
import { harness, sample, withLedger } from "./validation/aggregation-ui-harness.ts";

const percent = (node: Element) => parseFloat(node.style["width"]);
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("cost provider stacks share the 191:576 scale, run high to low and show model shades plus unattributed value", async () => {
  const codex = withLedger(sample(), [["gpt-5-mini", 150], ["gpt-5", 0], ["<unknown>", 41]]), claude = withLedger(sample(), [["claude-opus-4.6", 400], ["claude-sonnet-4.6", 176]]);
  codex.provider = "codex";
  const { document, run } = await harness([codex, claude]);
  run("renderCosts(activeView())");
  const container = document.querySelector("#provider-cost-models")!;
  const stacks = container.querySelectorAll(".cost-stack");
  const length = (stack: Element) => stack.children.reduce((sum, part) => sum + percent(part), 0);
  // Providers are sorted by value, high to low, whatever the registry order.
  near(length(stacks[1]!) / length(stacks[0]!), 191 / 576);
  near(length(stacks[1]!), 191 / 576 * 100); near(length(stacks[0]!), 100);
  assert.deepEqual(stacks[1]!.children.map((bar) => bar.dataset.series), ["codex:gpt-5-mini", "codex:unattributed"]);
  assert.equal(stacks[1]!.children[0]!.style.background, "var(--provider-codex-2)", "gpt-5 (standard tier) holds the brand shade; mini keeps its two-step distance");
  assert.equal(stacks[0]!.children[0]!.style.background, "var(--provider-claude-0)");
  assert.equal(stacks[0]!.children[1]!.style.background, "var(--provider-claude-1)");
  assert.match(stacks[1]!.children[1]!.style.background, /repeating-linear-gradient.*var\(--muted\)/);
  assert.equal(stacks[1]!.getAttribute("role"), "img");
  assert.match(stacks[1]!.getAttribute("aria-label")!, /No model evidence: \$41.00 \(21.5% of provider\)/);
  assert.match((stacks[1] as Element & { title: string }).title, /gpt-5-mini: \$150.00 \(78.5% of provider\)/);
  // A total line closes the list; the provider rows add up to it.
  assert.match(container.querySelectorAll(".cost-stack-total")[0]!.textContent, /Total\s+\$767\.00/);
  assert.equal(container.querySelectorAll(".chart-legend-item").length, 0);
});

test("Costs model rows share one scale across providers, use model shades, and keep token classes in tooltips", async () => {
  const claude = withLedger(sample(), [["claude-opus-4.6", 576]]), codex = withLedger(sample(), [["gpt-5-mini", 191]]);
  codex.provider = "codex";
  const { context, document, run } = await harness([claude, codex]);
  run("renderCosts(activeView())");
  const models = document.querySelector("#cost-models")!;
  const fills = models.querySelectorAll(".cost-model-track").map((track) => track.children[0]!);
  assert.deepEqual(fills.map((fill) => fill.dataset.series), ["claude:claude-opus-4.6", "codex:gpt-5-mini"]);
  near(percent(fills[1]!) / percent(fills[0]!), 191 / 576);
  assert.equal(fills[0]!.style.background, "var(--provider-claude-0)");
  assert.equal(fills[1]!.style.background, "var(--provider-codex-0)", "a provider's only model wears its brand colour");
  const row = models.querySelectorAll(".cost-model-row")[1]!;
  assert.match(row.textContent, /24.9%/);
  assert.match(row.textContent, /1 session · 100 in \/ 20 out tokens/);
  assert.doesNotMatch(row.textContent, /\b0 calls/, "a zero call count is not shown as evidence");
  assert.doesNotMatch(row.textContent, /cache read|cache write/);
  assert.match(row.querySelector(".cost-model-track")!.getAttribute("aria-label")!, /Provider-reported\..*Input 100, cache read 50, cache write 0, output 20 tokens/);
  assert.equal(document.querySelector("#repository-cost-components"), null);
  assert.equal(document.querySelector('[data-view-panel="models"]'), null);
  const container = new Element(); context.container = container;
  run('renderBars(container, [{name:"large",value:1000},{name:"tiny",value:0.001},{name:"zero",value:0}], String)');
  const bars = container.querySelectorAll("i"); near(percent(bars[1]!), 0.0001); assert.equal(percent(bars[2]!), 0);
  assert.ok(bars.every((bar) => bar.style["--series-color"] === "var(--chart-neutral)"));
  // Summary's model mix uses the same per-provider shades as Costs: distinct for opus-5/opus-4-8, brand for a lone Gemini row.
  run('renderBars(container, [{name:"a",value:3,provider:"claude",model:"claude-opus-5"},{name:"b",value:2,provider:"claude",model:"claude-opus-4-8"},{name:"c",value:1,provider:"gemini",model:"claude-sonnet-5"}], String)');
  assert.deepEqual(container.querySelectorAll("i").map((bar) => bar.style["--series-color"]), ["var(--provider-claude-0)", "var(--provider-claude-1)", "var(--provider-gemini-0)"]);
  run('clearInactiveAnalyticsViews("summary")');
  assert.equal(models.childElementCount, 0);
  assert.equal(document.querySelector("#provider-cost-models")!.childElementCount, 0);
});

test("Costs shows unattributed rows on the model scale, unpriced evidence, and empty states", async () => {
  const source = withLedger(sample(), [["model-synthetic", 6]], { priced: false });
  const unattributed = withLedger(sample(), [["<unknown>", 4]]);
  const { document, run } = await harness([source, unattributed]); run("renderCosts(activeView())");
  const models = document.querySelector("#cost-models")!;
  const rows = models.querySelectorAll(".cost-model-row");
  assert.match(rows[0]!.textContent, /unpriced/); assert.match(rows[1]!.textContent, /No model evidence.*\$4.00.*40.0%/);
  const fills = models.querySelectorAll(".cost-model-track").map((track) => track.children[0]!);
  near(percent(fills[1]!) / percent(fills[0]!), 4 / 6);
  assert.match(fills[1]!.style.background, /var\(--muted\)/);
  // 120 of 240 eligible tokens are priced; the share rounds down and is the Pricing view's figure too.
  assert.equal(document.querySelector("#cost-coverage")!.textContent, "50.0%");
  run("renderCosts({ sessions: [], scopeSessions: [], summary: summarize([]) })");
  for (const id of ["#provider-cost-models", "#cost-models"]) assert.match(document.querySelector(id)!.textContent, /No priced activity in this view./);
});

test("Tools view keeps one neutral ranking scale and colours only the provider split by brand", async () => {
  const claude = sample(), codex = sample(); codex.provider = "codex";
  claude.evidence!.tools = codex.evidence!.tools = "observed";
  claude.tools = { Read: 100, Edit: 91 }; codex.tools = { Read: 400, Edit: 176 };
  const { document, run } = await harness([claude, codex]);
  run('renderTools({ sessions:snapshot.sessions, scopeSessions:snapshot.sessions, repositories:[{repository:{id:"synthetic",name:"Synthetic"}}] })');
  const view = document.querySelector("#tools-view")!;
  const ranking = view.querySelector(".tools-ranking")!.querySelectorAll(".tools-bar").map((track) => track.children[0]!);
  near(percent(ranking[1]!) / percent(ranking[0]!), 267 / 500);
  assert.ok(ranking.every((fill) => !fill.style["--series-color"]), "ranking bars stay on the neutral fill");
  const byProvider = view.querySelectorAll(".tools-breakdown")[0]!;
  const fills = byProvider.querySelectorAll(".tools-bar").map((track) => track.children[0]!);
  assert.deepEqual(fills.map((fill) => fill.style["--series-color"]), [providerColor("codex"), providerColor("claude")]);
  near(percent(fills[0]!), 80); near(percent(fills[1]!), 20);
});

test("donut and daily lines draw every provider in legend order, using brand colours", async () => {
  const { document, run } = await harness([]);
  const providers = ["codex", "claude", "cursor", "copilot", "opencode", "gemini", "unsupported"];
  run(`renderDonut(${JSON.stringify(providers.flatMap((provider, i) => Array.from({ length: i + 1 }, () => ({ provider }))))})`);
  const donut = document.querySelector("#provider-donut")!;
  const paths = donut.querySelectorAll("path");
  assert.deepEqual(paths.map((path) => path.dataset["series"]), providers.toReversed());
  for (const path of paths) assert.equal(path.getAttribute("fill"), providerColor(path.dataset["series"]));
  const legend = document.querySelector("#provider-legend")!;
  const entries = legend.querySelectorAll('[role="listitem"]');
  assert.equal(legend.getAttribute("role"), "list");
  assert.equal(entries.length, providers.length);
  assert.deepEqual(entries.map((item) => item.dataset["series"]), providers.toReversed());
  for (const entry of entries) {
    assert.equal(entry.tagName, "div");
    assert.equal(entry.getAttribute("tabindex"), null);
    assert.equal(entry.listeners.has("focus"), false);
    assert.equal(entry.listeners.has("blur"), false);
  }
  assert.match(legend.textContent, /OpenCode/);
  const first = entries[0]!; first.listeners.get("pointerenter")!();
  assert.equal(donut.getAttribute("data-highlight"), "unsupported");
  assert.equal(paths[0]!.getAttribute("data-series-active"), "true");
  assert.equal(first.getAttribute("data-active"), "true");
  assert.equal(first.getAttribute("aria-current"), null);
  first.listeners.get("pointerleave")!();
  assert.equal(donut.getAttribute("data-highlight"), null);
  assert.equal(paths[0]!.getAttribute("data-series-active"), null);
  assert.equal(first.getAttribute("data-active"), null);
  paths[1]!.listeners.get("pointerenter")!();
  assert.equal(entries[1]!.getAttribute("data-active"), "true");
  assert.equal(paths[1]!.getAttribute("data-series-active"), "true");
  paths[1]!.listeners.get("pointerleave")!();
  assert.equal(donut.getAttribute("data-highlight"), null);
  assert.equal(entries[1]!.getAttribute("data-active"), null);
  assert.equal(paths[1]!.getAttribute("data-series-active"), null);
  const day = { name: "2026-10-01", ...Object.fromEntries(providers.map((provider, i) => [provider, i + 1])) };
  run(`renderLine(${JSON.stringify([day])})`);
  const chart = document.querySelector("#daily-spend")!;
  assert.deepEqual(chart.querySelectorAll(".trend-line").map((line) => line.dataset["series"]), providers.toReversed());
  for (const mark of chart.querySelector("svg")!.querySelectorAll("[data-series]")) {
    // The dashboard CSP blocks inline style attributes; colour must arrive through CSSOM.
    assert.equal(mark.getAttribute("style"), null);
    assert.equal(mark.style["--series-color"], providerColor(mark.dataset["series"]));
  }
  assert.equal(chart.querySelectorAll('div.chart-legend-item[role="listitem"]').length, 7);
  // Without a measured width the chart keeps its 900-unit fallback; at a phone's width it is drawn in CSS pixels with three date ticks in the shared format.
  assert.equal(chart.querySelector("svg")!.getAttribute("viewBox"), "0 0 900 272");
  const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"].map((name) => ({ ...day, name }));
  Object.assign(chart, { clientWidth: 390 });
  run(`renderLine(${JSON.stringify(days)})`);
  const narrow = chart.querySelector("svg")!;
  assert.equal(narrow.getAttribute("viewBox"), "0 0 390 220");
  assert.deepEqual(narrow.querySelectorAll(".axis-label").filter((label) => label.getAttribute("y") === "208").map((label) => label.textContent), ["Oct 1", "Oct 4", "Oct 7"], "three shared-format date ticks at even steps");
});

test("legend keeps safe wrapping text and order, drops only numeric zero and resets highlights", async () => {
  await harness([]);
  const target = new Element(), container = new Element(), mark = new Element("path");
  mark.setAttribute("data-series", "unsafe"); target.append(mark);
  const label = '<img src=x onerror="alert(1)">';
  renderLegend(container, [
    { id: "zero", label: "Zero", color: "red", value: 0, mark: "rect" },
    { id: "unsafe", label, color: "blue", value: 2, valueLabel: "$2", share: 0.25, mark: "rect" },
    { id: "unknown", label: "No total", color: "grey", mark: "line" },
  ], { target });
  assert.equal(container.children.length, 2); assert.equal(container.querySelectorAll("img").length, 0);
  const entries = container.querySelectorAll('div[role="listitem"]');
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.getAttribute("aria-label"), `${label}: $2 (25.0%)`);
  entries[0]!.listeners.get("pointerenter")!(); assert.equal(target.getAttribute("data-highlight"), "unsafe");
  renderLegend(container, [], { target });
  assert.equal(target.getAttribute("data-highlight"), null); assert.equal(mark.getAttribute("data-series-active"), null);
});

test("Costs shares adjusted model slots across charts, fits direct labels and links hover in both directions", async () => {
  const names = ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5", "claude-haiku-3"];
  const original = modelSlots(names.map((model) => ({ id: `claude:${model}`, provider: "claude", model })));
  const overflow = names.find((model) => original.get(`claude:${model}`)!.overflow)!;
  const neighbour = names.find((model) => model !== overflow && original.get(`claude:${model}`)!.slot === original.get(`claude:${overflow}`)!.slot)!;
  const ordered = [neighbour, overflow, ...names.filter((model) => model !== neighbour && model !== overflow)];
  const claude = withLedger(sample(), ordered.map((model, i) => [model, [40, 30, 20, 8, 1.999, 0.001][i]!]));
  const cursor = withLedger(sample(), [["claude-opus-5", 10]]); cursor.provider = "cursor";
  const { document, context, run } = await harness([claude, cursor]);
  const frames: Array<() => void> = [];
  context.requestAnimationFrame = (callback: () => void) => frames.push(callback);
  run("renderCosts(activeView())");
  const providers = document.querySelector("#provider-cost-models")!, models = document.querySelector("#cost-models")!;
  const bars = providers.querySelectorAll(".cost-stack")[0]!.children;
  const fills = models.querySelectorAll(".cost-model-track").map((track) => track.children[0]!);
  assert.deepEqual(bars.map((bar) => bar.dataset.series), ordered.map((model) => `claude:${model}`));
  const color = (bar: Element) => bar.style.background.match(/var\(--provider-[^)]+\)/)![0] as string;
  for (const bar of providers.querySelectorAll(".cost-stack").flatMap((stack) => stack.children)) {
    const fill = fills.find((fill) => fill.dataset.series === bar.dataset.series)!;
    assert.equal(fill.style.background, bar.style.background, `${bar.dataset.series}: same slot and texture in both views`);
    assert.equal(bar.querySelectorAll(".cost-segment-label").length, percent(bar) >= 8 ? 1 : 0);
    assert.equal(bar.getAttribute("style"), null);
    if (bar.dataset.series!.startsWith("cursor:")) assert.match(bar.style.background, /--provider-cursor-/);
  }
  for (let i = 1; i < bars.length; i += 1) assert.notEqual(color(bars[i]!), color(bars[i - 1]!), "adjacent segments never repeat a shade");
  const repeated = bars.find((bar) => bar.dataset.series === `claude:${overflow}`)!;
  assert.match(repeated.style.background, /repeating-linear-gradient/);
  assert.notEqual(color(repeated), slotColor("claude", original.get(`claude:${overflow}`)!.slot), "the fixture exercises adjacency correction");
  const labelled = bars.filter((bar) => bar.querySelector(".cost-segment-label"));
  labelled.forEach((bar, i) => {
    const label = bar.querySelector(".cost-segment-label")!;
    Object.assign(bar, { clientWidth: i === 0 ? 300 : i === 1 ? 120 : 20 });
    Object.defineProperty(label, "scrollWidth", { get: () => label.textContent.includes(" · ") ? 150 : 100 });
  });
  assert.equal(frames.length, 1); frames.shift()!();
  assert.match(labelled[0]!.querySelector(".cost-segment-label")!.textContent, /40.0%/);
  assert.doesNotMatch(labelled[1]!.querySelector(".cost-segment-label")!.textContent, /%/);
  assert.equal(labelled[1]!.querySelector(".cost-segment-label")!.hidden, false);
  assert.equal(labelled[2]!.querySelector(".cost-segment-label")!.hidden, true);
  const key = providers.querySelector(".cost-key")!;
  assert.match(key.textContent, /Each segment is one model, largest first/); assert.match(key.textContent, /Extra models share a shade, hatched/);
  assert.doesNotMatch(key.textContent, /No model evidence/);
  assert.equal(providers.querySelectorAll('[role="listitem"]').length, 0);
  const tiny = bars.at(-1)!;
  assert.match((tiny as Element & { title: string }).title, /\(<0.1% of Claude\)/);
  const tinyRow = models.querySelectorAll(".cost-model-row").find((row) => row.dataset.series === tiny.dataset.series)!;
  assert.equal(tinyRow.querySelector(".cost-model-share")!.textContent, "<0.1%");
  assert.match((tinyRow as Element & { title: string }).title, /<0.1% of total/);
  for (const source of [repeated, tinyRow]) {
    const id = source.dataset.series;
    source.listeners.get("pointerenter")!();
    for (const container of [providers, models]) {
      assert.equal(container.getAttribute("data-highlight"), id);
      for (const mark of container.querySelectorAll("[data-series]")) assert.equal(mark.getAttribute("data-series-active"), mark.dataset.series === id ? "true" : null);
    }
    const activeRow = models.querySelectorAll(".cost-model-row").find((row) => row.dataset.series === id)!;
    assert.equal(activeRow.getAttribute("data-active"), "true");
    source.listeners.get("pointerleave")!();
    for (const container of [providers, models]) {
      assert.equal(container.getAttribute("data-highlight"), null);
      assert.ok(container.querySelectorAll("[data-series]").every((mark) => mark.getAttribute("data-series-active") === null));
    }
    assert.equal(activeRow.getAttribute("data-active"), null);
  }
});

test("Costs shows only relevant hatch keys, refits labels after resizing and formats tiny legend shares", async () => {
  const source = withLedger(sample(), [["claude-opus-5", 100], ["<unknown>", 10]]);
  const { context, document, run } = await harness([source]);
  let resized: (() => void) | undefined;
  const original = context.redrawOnResize;
  context.redrawOnResize = (_container: Element, render: () => void) => { resized = render; };
  run("renderCosts(activeView())");
  const container = document.querySelector("#provider-cost-models")!;
  const key = container.querySelector(".cost-key")!;
  assert.match(key.textContent, /No model evidence/); assert.doesNotMatch(key.textContent, /Extra models/);
  const first = container.querySelector(".cost-segment-label")!;
  first.hidden = true; resized!();
  assert.notEqual(container.querySelector(".cost-segment-label"), first);
  assert.equal(container.querySelector(".cost-segment-label")!.hidden, false);
  context.redrawOnResize = original;
  const legend = new Element(), target = new Element();
  renderLegend(legend, [{ id: "tiny", label: "Tiny", color: "grey", value: 0.001, share: 0.00001, mark: "rect" }], { target });
  assert.equal(legend.querySelector(".chart-legend-share")!.textContent, "<0.1%");
});
