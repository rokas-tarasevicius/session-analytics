import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

const views = ["summary", "velocity", "costs", "models", "pricing", "tools", "activity"];

test("dashboard navigation, stepping, palette and shortcut help share the seven-view order", async () => {
  const { document, run } = await harness([]);
  run("snapshot = null");
  assert.deepEqual(document.querySelectorAll("[data-view-button]").map((button) => button.dataset.viewButton), views);
  assert.deepEqual([...run("viewOrder")], views);
  assert.deepEqual(document.querySelectorAll(".nav-section").map((group) => [group.getAttribute("aria-label"), group.querySelectorAll("[data-view-button]").map((button) => button.dataset.viewButton)]), [
    ["Overview", ["summary", "velocity"]], ["Economics", ["costs", "models", "pricing"]], ["Usage", ["tools", "activity"]],
  ]);
  assert.deepEqual([...run("paletteItems().filter(item => item.group === 'Views').map(item => item.keywords)")], views.map((view) => `view ${view}`));
  const chords = run("viewChords");
  assert.deepEqual(Object.values(chords), views);
  for (const key of ["d", "r", "l", "w", "k", "o", "i"]) assert.equal(chords[key], undefined);
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
  for (const item of run("paletteItems()")) assert.ok(icons.has(item.icon), item.icon);
  for (const match of html.matchAll(/href="#i-([^"]+)"/g)) assert.ok(icons.has(match[1]), match[1]);
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
  const startup = app.slice(app.indexOf("const urlWindow ="), app.indexOf("void load(false);"));
  for (const [query, preset, start] of [
    ["", "30", "2026-09-02"], ["window=all", "all", "2026-07-01"],
    ["window=7", "7", "2026-09-25"], ["window=90", "90", "2026-07-04"],
    ["window=invalid", "30", "2026-09-02"], ["", "30", "2026-09-02"],
  ]) {
    context.query = query;
    run(`{ const urlParameters = new URLSearchParams(query); ${startup} } configureWindow();`);
    assert.equal(run("windowPreset"), preset);
    assert.equal(document.querySelector(`[data-window-preset="${preset}"]`)!.getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector("#window-start")!.value, start);
    assert.equal(document.querySelector("#window-end")!.value, "2026-10-01");
  }
  run("setWindowPreset('invalid')");
  assert.equal(run("windowPreset"), "30");
  assert.deepEqual(stored, []);
});
