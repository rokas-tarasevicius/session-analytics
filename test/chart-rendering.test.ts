import assert from "node:assert/strict";
import test from "node:test";
import { renderLegend } from "../src/public/chart-legend.js";
import { modelColor, providerColor } from "../src/public/chart-colors.js";
import { reportedModel } from "../src/providers/common.ts";
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
  assert.equal(stacks[1]!.children[0]!.style.background, modelColor("codex", "gpt-5-mini"));
  assert.equal(stacks[0]!.children[0]!.style.background, modelColor("claude", "claude-opus-4.6"));
  assert.equal(stacks[0]!.children[1]!.style.background, modelColor("claude", "claude-sonnet-4.6"));
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
  assert.equal(fills[0]!.style.background, modelColor("claude", "claude-opus-4.6"));
  assert.equal(fills[1]!.style.background, modelColor("codex", "gpt-5-mini"));
  const row = models.querySelectorAll(".cost-model-row")[1]!;
  assert.match(row.textContent, /24.9%/);
  assert.match(row.textContent, /1 session · — calls · 100 in \/ 20 out tokens/);
  assert.doesNotMatch(row.textContent, /\b0 calls/, "missing call evidence is not shown as zero");
  assert.doesNotMatch(row.textContent, /cache read|cache write/);
  assert.match(row.querySelector(".cost-model-track")!.getAttribute("aria-label")!, /Provider-reported\..*Input 100, cache read 50, cache write 0, output 20 tokens/);
  assert.equal(document.querySelector("#repository-cost-components"), null);
  assert.equal(document.querySelector('[data-view-panel="models"]'), null);
  const container = new Element(); context.container = container;
  run('renderBars(container, [{name:"large",value:1000},{name:"tiny",value:0.001},{name:"zero",value:0}], String)');
  const bars = container.querySelectorAll("i"); near(percent(bars[1]!), 0.0001); assert.equal(percent(bars[2]!), 0);
  assert.ok(bars.every((bar) => bar.style["--series-color"] === "var(--chart-neutral)"));
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
  run("for (const input of providerFilters) input.closest('.chip').hidden = false");
  const day = { name: "2026-10-01", ...Object.fromEntries(providers.map((provider, i) => [provider, i + 1])) };
  run(`renderLine(${JSON.stringify([day, { ...day, name: "2026-10-02" }, { ...day, name: "2026-10-03" }])})`);
  const chart = document.querySelector("#daily-spend")!;
  assert.deepEqual(chart.querySelectorAll(".trend-line").map((line) => line.dataset["series"]), providers.toReversed());
  for (const mark of chart.querySelector("svg")!.querySelectorAll("[data-series]")) {
    // The dashboard CSP blocks inline style attributes; colour must arrive through CSSOM.
    assert.equal(mark.getAttribute("style"), null);
    assert.equal(mark.style["--series-color"], providerColor(mark.dataset["series"]));
  }
  assert.equal(chart.querySelectorAll('div.chart-legend-item[role="listitem"]').length, 7);
  // Without a measured width the chart keeps its 900-unit fallback; at a phone's width it is drawn in CSS pixels with daily ticks when they fit.
  assert.equal(chart.querySelector("svg")!.getAttribute("viewBox"), "0 0 900 272");
  const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"].map((name) => ({ ...day, name }));
  Object.assign(chart, { clientWidth: 390 });
  run(`renderLine(${JSON.stringify(days)})`);
  const narrow = chart.querySelector("svg")!;
  assert.equal(narrow.getAttribute("viewBox"), "0 0 390 220");
  assert.deepEqual(narrow.querySelectorAll(".axis-label").filter((label) => label.getAttribute("y") === "208").map((label) => label.textContent), ["1 Oct", "2 Oct", "3 Oct", "4 Oct", "5 Oct", "6 Oct", "7 Oct"]);
});

test("daily readout exposes exact day values without hover and retains inspection through keyboard and pointer use", async () => {
  const { document, run } = await harness([]);
  run("for (const input of providerFilters) input.closest('.chip').hidden = false");
  const days = [
    { name: "2025-12-30", claude: 10.25, codex: 1.01 },
    { name: "2025-12-31", claude: 0, codex: 0 },
    { name: "2026-01-01", claude: 20.50, codex: 2.02 },
    { name: "2026-01-02", claude: 30.75, codex: 3.03 },
  ];
  run(`renderLine(${JSON.stringify(days)})`);
  const chart = document.querySelector("#daily-spend")!;
  const svg = chart.querySelector("svg")!, readout = chart.querySelector(".chart-readout")!;
  const title = () => readout.querySelector(".tip-title")!.textContent;
  assert.equal(svg.getAttribute("role"), "group");
  assert.equal(svg.getAttribute("aria-describedby"), readout.id);
  assert.match(svg.getAttribute("aria-label")!, /Home and End/);
  assert.equal(readout.hidden, false);
  assert.match(title(), /2 January 2026/);
  assert.deepEqual(readout.querySelectorAll("strong").map((value) => value.textContent), ["$30.75", "$3.03"]);
  const key = (name: string) => {
    let prevented = false, stopped = false;
    svg.listeners.get("keydown")!({ key: name, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    return { prevented, stopped };
  };
  assert.equal(key("Home").prevented, true);
  assert.match(title(), /30 December 2025/);
  key("ArrowLeft"); assert.match(title(), /30 December 2025/);
  key("ArrowRight"); assert.match(title(), /31 December 2025/);
  assert.deepEqual(readout.querySelectorAll("strong").map((value) => value.textContent), ["$0.00", "$0.00"]);
  assert.match(document.querySelector("#chart-announcer")!.textContent, /31 December 2025.*Claude.*\$0.00/);
  // Leaving the plot or moving focus to the legend does not take away the values.
  svg.listeners.get("pointerleave")?.(); svg.listeners.get("blur")?.();
  assert.equal(readout.hidden, false);
  assert.deepEqual(key("Escape"), { prevented: true, stopped: true });
  assert.equal(readout.hidden, true);
  assert.deepEqual(key("Escape"), { prevented: false, stopped: false });
  key("ArrowRight"); assert.match(title(), /1 January 2026/);
  key("Escape");
  svg.listeners.get("focus")!();
  assert.equal(readout.hidden, false); assert.match(title(), /1 January 2026/);
  svg.listeners.get("pointermove")!({ clientX: 886 }); assert.match(title(), /2 January 2026/);
  svg.listeners.get("click")!({ clientX: 52 }); assert.match(title(), /30 December 2025/);
  key("End"); key("ArrowRight"); assert.match(title(), /2 January 2026/);
  // A resize redraw can restore by calendar day, including a zero-activity day.
  run(`renderLine(${JSON.stringify(days)}, "2025-12-31")`);
  assert.match(chart.querySelector(".tip-title")!.textContent, /31 December 2025/);
  run("renderLine([])");
  assert.equal(chart.querySelector(".chart-readout"), null);
  assert.match(chart.textContent, /Nothing to plot/);
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
