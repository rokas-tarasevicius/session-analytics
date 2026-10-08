import assert from "node:assert/strict";
import test from "node:test";
import { renderLegend } from "../src/public/chart-legend.js";
import { providerColor } from "../src/public/chart-colors.js";
import { reportedModel } from "../src/providers/common.ts";
import { Element } from "./release-dom.ts";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

const percent = (node: Element) => parseFloat(node.style["width"]);
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("cost stacks retain the 191:576 ratio, provider shades, component totals and zero omission", async () => {
  const { context, run } = await harness([]);
  const container = new Element(); context.container = container;
  run(`renderCostRows(container, [
    { name: "Codex", provider: "codex", cost: { total: 191, reported: 0, input: 100, cached: 50, write: 0, output: 41 } },
    { name: "Claude", provider: "claude", cost: { total: 576, reported: 0, input: 400, cached: 100, write: 0, output: 76 } }
  ])`);
  const stacks = container.querySelectorAll(".cost-stack");
  const length = (stack: Element) => stack.children.reduce((sum, part) => sum + percent(part), 0);
  near(length(stacks[0]!) / length(stacks[1]!), 191 / 576);
  near(length(stacks[0]!), 191 / 576 * 100);
  near(length(stacks[1]!), 100);
  assert.equal(stacks[0]!.children[0]!.style["background"], "var(--provider-codex)");
  assert.equal(stacks[1]!.children[0]!.style["background"], "var(--provider-claude)");
  const legend = container.querySelectorAll(".chart-legend-item");
  assert.deepEqual(legend.map((item) => item.dataset["series"]), ["input", "cached", "output"]);
  assert.match(legend[0]!.textContent, /500\.00/);
  legend[1]!.listeners.get("focus")!();
  assert.equal(container.querySelector(".cost-stack-list")!.getAttribute("data-highlight"), "cached");
});

test("models share a maximum across providers and ordinary bars are neutral with no width floor", async () => {
  const claude = sample(), codex = sample(); codex.provider = "codex";
  claude.models = [reportedModel("claude-opus-4.6", claude.tokens, 576)];
  codex.models = [reportedModel("gpt-5-mini", codex.tokens, 191)];
  const { context, document, run } = await harness([claude, codex]);
  run("renderModels({ sessions: snapshot.sessions })");
  const fills = document.querySelector("#models-by-provider")!.querySelectorAll(".model-track").map((track) => track.children[0]!);
  const byId = new Map(fills.map((fill) => [fill.dataset["series"], fill]));
  near(percent(byId.get("codex:gpt-5-mini")!) / percent(byId.get("claude:claude-opus-4.6")!), 191 / 576);
  assert.equal(byId.get("claude:claude-opus-4.6")!.style["--series-color"], "var(--provider-claude-0)");
  assert.equal(byId.get("codex:gpt-5-mini")!.style["--series-color"], "var(--provider-codex-3)");
  const container = new Element(); context.container = container;
  run('renderBars(container, [{name:"large",value:1000},{name:"tiny",value:0.001},{name:"zero",value:0}], String)');
  const bars = container.querySelectorAll("i"); near(percent(bars[1]!), 0.0001); assert.equal(percent(bars[2]!), 0);
  assert.ok(bars.every((bar) => bar.style["--series-color"] === "var(--chart-neutral)"));
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
  assert.deepEqual(legend.children.map((item) => item.dataset["series"]), providers.toReversed());
  assert.match(legend.textContent, /OpenCode/);
  const first = legend.children[0]!; first.listeners.get("focus")!();
  assert.equal(donut.getAttribute("data-highlight"), "unsupported");
  assert.equal(paths[0]!.getAttribute("data-series-active"), "true");
  paths[1]!.listeners.get("pointerenter")!();
  assert.equal(legend.children[1]!.getAttribute("aria-current"), "true");
  paths[1]!.listeners.get("pointerleave")!();
  assert.equal(donut.getAttribute("data-highlight"), "unsupported", "pointer leave restores keyboard focus");
  first.listeners.get("blur")!(); assert.equal(donut.getAttribute("data-highlight"), null);
  const day = { name: "2026-10-01", ...Object.fromEntries(providers.map((provider, i) => [provider, i + 1])) };
  run(`renderLine(${JSON.stringify([day])})`);
  const chart = document.querySelector("#daily-spend")!;
  assert.deepEqual(chart.querySelectorAll(".trend-line").map((line) => line.dataset["series"]), providers.toReversed());
  for (const mark of chart.querySelector("svg")!.querySelectorAll("[data-series]")) {
    // The dashboard CSP blocks inline style attributes; colour must arrive through CSSOM.
    assert.equal(mark.getAttribute("style"), null);
    assert.equal(mark.style["--series-color"], providerColor(mark.dataset["series"]));
  }
  assert.equal(chart.querySelectorAll(".chart-legend-item").length, 7);
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
  assert.equal(container.children[0]!.getAttribute("aria-label"), `${label}: $2 (25.0%)`);
  container.children[0]!.listeners.get("focus")!(); assert.equal(target.getAttribute("data-highlight"), "unsafe");
  renderLegend(container, [], { target });
  assert.equal(target.getAttribute("data-highlight"), null); assert.equal(mark.getAttribute("data-series-active"), null);
});
