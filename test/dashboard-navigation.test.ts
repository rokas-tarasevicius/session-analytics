import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

const views = ["summary", "velocity", "costs", "pricing", "tools", "activity"];

test("dashboard navigation, stepping, palette and shortcut help share the six-view order", async () => {
  const { document, run } = await harness([]);
  run("snapshot = null");
  assert.deepEqual(document.querySelectorAll("[data-view-button]").map((button) => button.dataset.viewButton), views);
  assert.deepEqual([...run("viewOrder")], views);
  assert.deepEqual(document.querySelectorAll(".nav-section").map((group) => [group.getAttribute("aria-label"), group.querySelectorAll("[data-view-button]").map((button) => button.dataset.viewButton)]), [
    ["Overview", ["summary", "velocity"]], ["Economics", ["costs", "pricing"]], ["Usage", ["tools", "activity"]],
  ]);
  assert.deepEqual([...run("paletteItems().filter(item => item.group === 'Views').map(item => item.keywords)")], views.map((view) => `view ${view}`));
  const chords = run("viewChords");
  assert.deepEqual(Object.values(chords), views);
  for (const key of ["m", "d", "r", "l", "w", "k", "o", "i"]) assert.equal(chords[key], undefined);
  assert.equal(chords.a, "activity");
  run("switchView('summary')");
  for (const expected of [...views.slice(1), "summary"]) {
    run("stepView(1)");
    assert.equal(run("currentViewName()"), expected);
  }
  run("stepView(-1)");
  assert.equal(run("currentViewName()"), "activity");
  const html = await readFile(new URL("../src/public/index.html", import.meta.url), "utf8");
  const help = html.slice(html.indexOf('<dialog class="help"'));
  assert.deepEqual([...help.matchAll(/<dt>([^<]+)<\/dt>/g)].slice(0, views.length).map((match) => match[1]!.toLowerCase()), views);
  assert.equal(document.querySelectorAll("[data-view-panel]").length, views.length);
  const icons = new Set([...html.matchAll(/<symbol id="i-([^"]+)"/g)].map((match) => match[1]));
  assert.ok(icons.has("models"));
  assert.ok(document.querySelector('[data-export="models"]'));
  assert.ok(document.querySelector("#model-spend"));
  for (const item of run("paletteItems()")) assert.ok(icons.has(item.icon), item.icon);
  for (const match of html.matchAll(/href="#i-([^"]+)"/g)) assert.ok(icons.has(match[1]), match[1]);
});

test("old Models URLs and preferences open Costs, with valid URLs taking precedence", async () => {
  const { context, run } = await harness([]); run("snapshot = null");
  const app = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  const startup = app.slice(app.indexOf("const initialUrl ="), app.indexOf("const resetExportMenu = installExportMenu"));
  for (const [query, preference, expected] of [
    ["view=models", "activity", "costs"], ["", "models", "costs"], ["view=tools", "models", "tools"],
    ["view=unknown", "models", "costs"], ["view=unknown", "unknown", "summary"],
  ]) {
    context.query = query; context.localStorage = { getItem: () => preference, setItem() {} };
    run(`{ const urlParameters = new URLSearchParams(query); ${startup} switchView(viewPanels.some(({ dataset }) => dataset.viewPanel === storedView) ? storedView : "summary"); }`);
    assert.equal(run("currentViewName()"), expected);
  }
});

test("dashboard defaults to 30 observed days and URL windows override without persisting", async () => {
  const old = sample(), recent = sample();
  old.createdAt = "2026-07-01T12:00:00Z";
  recent.createdAt = "2026-10-01T12:00:00Z";
  const { document, context, run } = await harness([old, recent]);
  assert.equal(run("windowPreset"), "30");
  assert.equal(document.querySelector('[data-window-preset="30"]')!.getAttribute("aria-pressed"), "true");
  assert.equal(document.querySelector('[data-window-preset="all"]')!.getAttribute("aria-pressed"), "false");
  const stored: string[] = [];
  context.localStorage = { getItem: () => null, setItem: (key: string) => stored.push(key) };
  const app = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  const startup = app.slice(app.indexOf("setWindowPreset(initialUrl.window"), app.indexOf("void load(false);"));
  for (const [query, preset, start] of [
    ["", "30", "2026-09-02"], ["window=all", "all", "2026-07-01"],
    ["window=7", "7", "2026-09-25"], ["window=90", "90", "2026-07-04"],
    ["window=invalid", "30", "2026-09-02"], ["", "30", "2026-09-02"],
  ]) {
    context.query = query;
    run(`{ const initialUrl = parseUrlState(query, { views: viewOrder, presets: windowPresets, aliases: viewAliases }); ${startup} } configureWindow();`);
    assert.equal(run("windowPreset"), preset);
    assert.equal(document.querySelector(`[data-window-preset="${preset}"]`)!.getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector("#window-start")!.value, start);
    assert.equal(document.querySelector("#window-end")!.value, "2026-10-01");
  }
  run("setWindowPreset('invalid')");
  assert.equal(run("windowPreset"), "30");
  assert.deepEqual(stored, []);
});

test("the 30-day default excludes unknown starts and limits view exports to the window", async () => {
  const old = sample(), recent = sample(), undated = sample();
  old.createdAt = "2026-07-01T12:00:00Z";
  recent.createdAt = "2026-10-01T12:00:00Z";
  undated.transcript.startTimeKnown = false;
  const { document, run } = await harness([old, recent, undated]);
  run("resetExportMenu = () => {}; configureWindow(); renderSummary(activeView())");
  assert.equal(run("windowPreset"), "30");
  assert.match(document.querySelector("#metric-session-note")!.textContent, /1 unknown starts excluded/);
  assert.equal(run("filterSnapshot(snapshot, { ...selectedWindow() }).sessions.length"), 1);
  run("applyWindowPreset('all', { render: false }); renderSummary(activeView())");
  assert.match(document.querySelector("#metric-session-note")!.textContent, /1 unknown starts included/);
  assert.equal(run("filterSnapshot(snapshot, { ...selectedWindow() }).sessions.length"), 3);
});

test("scope caption distinguishes Velocity activity dates from session-start views", async () => {
  const { document, run } = await harness([sample()]);
  run("currentViewName = () => 'velocity'; renderSharedView(activeView())");
  assert.match(document.querySelector("#scope-description")!.textContent, /Activity observed during .* \(/);
  assert.doesNotMatch(document.querySelector("#scope-description")!.textContent, /Sessions started/);
  run("currentViewName = () => 'costs'; renderSharedView(activeView())");
  assert.match(document.querySelector("#scope-description")!.textContent, /Sessions started during .*\(UTC\); whole-session totals/);
});
