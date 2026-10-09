import assert from "node:assert/strict";
import test from "node:test";
import { renderLegend } from "../src/public/chart-legend.js";
import { modelColor, providerColor } from "../src/public/chart-colors.js";
import { reportedModel } from "../src/providers/common.ts";
import { Element } from "./release-dom.ts";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

const percent = (node: Element) => parseFloat(node.style["width"]);
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("cost provider stacks share the 191:576 scale and show model shades plus unattributed value", async () => {
  const codex = sample(), claude = sample(); codex.provider = "codex";
  codex.cost.totalUsd = 191; codex.models = [reportedModel("gpt-5-mini", codex.tokens, 150), reportedModel("gpt-5", codex.tokens, 0)];
  claude.cost.totalUsd = 576; claude.models = [reportedModel("claude-opus-4.6", claude.tokens, 400), reportedModel("claude-sonnet-4.6", claude.tokens, 176)];
  const { document, run } = await harness([claude, codex]);
  run("renderCosts(activeView())");
  const container = document.querySelector("#provider-cost-models")!;
  const stacks = container.querySelectorAll(".cost-stack");
  const length = (stack: Element) => stack.children.reduce((sum, part) => sum + percent(part), 0);
  near(length(stacks[0]!) / length(stacks[1]!), 191 / 576);
  near(length(stacks[0]!), 191 / 576 * 100); near(length(stacks[1]!), 100);
  assert.deepEqual(stacks[0]!.children.map((bar) => bar.dataset.series), ["codex:gpt-5-mini", "codex:unattributed"]);
  assert.equal(stacks[0]!.children[0]!.style.background, modelColor("codex", "gpt-5-mini"));
  assert.equal(stacks[1]!.children[0]!.style.background, modelColor("claude", "claude-opus-4.6"));
  assert.equal(stacks[1]!.children[1]!.style.background, modelColor("claude", "claude-sonnet-4.6"));
  assert.match(stacks[0]!.children[1]!.style.background, /repeating-linear-gradient.*var\(--muted\)/);
  assert.equal(stacks[0]!.getAttribute("role"), "img");
  assert.match(stacks[0]!.getAttribute("aria-label")!, /No model evidence: \$41.00 \(21.5% of provider\)/);
  assert.match((stacks[0] as Element & { title: string }).title, /gpt-5-mini: \$150.00 \(78.5% of provider\)/);
  assert.equal(container.querySelectorAll(".chart-legend-item").length, 0);
});

test("Costs model rows share one scale across providers, use model shades, and keep token dollars in tooltips", async () => {
  const claude = sample(), codex = sample(); codex.provider = "codex";
  claude.cost.totalUsd = 576; claude.models = [reportedModel("claude-opus-4.6", claude.tokens, 576)];
  codex.cost.totalUsd = 191; codex.models = [reportedModel("gpt-5-mini", codex.tokens, 191)];
  codex.models[0]!.inputUsd = 100; codex.models[0]!.cachedInputUsd = 50; codex.models[0]!.outputUsd = 41;
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
  assert.match(row.textContent, /1 session · 100 in \/ 20 out tokens/);
  assert.doesNotMatch(row.textContent, /\b0 calls/, "a zero call count is not shown as evidence");
  assert.doesNotMatch(row.textContent, /Cache read|Cache write|\$100.00|\$50.00/);
  assert.match(row.querySelector(".cost-model-track")!.getAttribute("aria-label")!, /Input: \$100.00, Cache read: \$50.00, Cache write: \$0.00, Output: \$41.00/);
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
  const source = sample(); source.models[0]!.priced = false;
  const { document, run } = await harness([source]); run("renderCosts(activeView())");
  const models = document.querySelector("#cost-models")!;
  const rows = models.querySelectorAll(".cost-model-row");
  assert.match(rows[0]!.textContent, /unpriced/); assert.match(rows[1]!.textContent, /No model evidence.*\$4.00.*40.0%/);
  const fills = models.querySelectorAll(".cost-model-track").map((track) => track.children[0]!);
  near(percent(fills[1]!) / percent(fills[0]!), 4 / 6);
  assert.match(fills[1]!.style.background, /var\(--muted\)/);
  run("renderCosts({ sessions: [], summary: summarize([]) })");
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
