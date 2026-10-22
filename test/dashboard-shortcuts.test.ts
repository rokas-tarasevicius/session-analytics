import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { matchShortcut, shortcutHint, shortcutRegistry } from "../src/public/shortcuts.js";
import { providerIds } from "../src/public/providers.js";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

const keyEvent = (key: string) => ({ key, target: { tagName: "BODY" } });

test("every registry binding dispatches uniquely and supplies its palette hint", () => {
  const seen = new Set<string>();
  for (const item of shortcutRegistry) for (const binding of item.bindings) {
    const sequence = binding.keys.join(" ");
    assert.ok(!seen.has(sequence), sequence); seen.add(sequence);
    let pending: string | null = null;
    for (const key of binding.keys) {
      const event = key === "Mod+k" ? { ...keyEvent("k"), ctrlKey: true } : keyEvent(key);
      const match = matchShortcut(event, { pending });
      assert.ok(match, sequence);
      if (match.prefix) pending = match.prefix;
      else assert.deepEqual(match, { action: item.action, value: binding.value });
    }
    assert.ok(shortcutHint(item.id, binding.value).includes(sequence), sequence);
    const finalKey = binding.keys.at(-1)!;
    const event = finalKey === "Mod+k" ? { ...keyEvent("k"), metaKey: true } : keyEvent(finalKey);
    assert.equal(Boolean(matchShortcut(event, { enabled: false, pending })), binding.always, sequence);
  }
  assert.equal(shortcutRegistry.find((item) => item.id === "provider")!.bindings.length, Math.min(providerIds.length, 9));
});

test("typing, composition, held keys, and browser modifiers cannot fire character shortcuts", () => {
  for (const key of ["g", "p", "1", "t", "d", "r", "?", "/", "Escape", "["]) {
    for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
      assert.equal(matchShortcut({ key, target }), null, key);
      assert.equal(matchShortcut({ key, target }, { pending: "g" }), null, key);
    }
    for (const flag of ["defaultPrevented", "isComposing", "repeat", "altKey", "ctrlKey", "metaKey"]) assert.equal(matchShortcut({ ...keyEvent(key), [flag]: true }), null, `${key}: ${flag}`);
  }
  assert.deepEqual(matchShortcut({ key: "K", ctrlKey: true, target: { tagName: "INPUT", type: "text" } }), { action: "palette", value: null });
  assert.equal(matchShortcut({ key: "k", ctrlKey: true, altKey: true }), null);
  assert.equal(matchShortcut(keyEvent("x"), { pending: "g" }), null);
  assert.deepEqual(matchShortcut(keyEvent("Escape"), { pending: "g" }), { action: "clear", value: null });
});

test("documented global shortcuts exactly match the registry", async () => {
  const docs = await readFile(new URL("../docs/dashboard.md", import.meta.url), "utf8");
  const block = docs.split("<!-- global-shortcuts:start -->")[1]!.split("<!-- global-shortcuts:end -->")[0]!;
  const rows = block.trim().split("\n").slice(2);
  assert.deepEqual(rows, shortcutRegistry.map((item) => `| \`${shortcutHint(item.id)}\` | ${item.label} |`));
});

test("the help overlay and palette use registry labels and bindings", async () => {
  const { document, run } = await harness([sample()]);
  run("renderShortcutHelp()");
  const rows = document.querySelector("#shortcut-list")!.querySelectorAll("dt");
  assert.deepEqual(rows.map((row) => row.textContent), shortcutRegistry.map((item) => item.label));
  const views = run("paletteItems().filter(item => item.group === 'Views')");
  for (const item of views) {
    const view = item.keywords.split(" ")[1];
    assert.equal(item.hint, shortcutHint(`view-${view}`));
  }
});

test("global navigation shortcuts work from every dashboard view and Escape cancels a chord", async () => {
  const { document, run, fireKey } = await harness([sample()]);
  run("resetExportMenu = () => {}; snapshot.rateCard = {};");
  const views = shortcutRegistry.filter((item) => item.action === "view");
  for (const origin of views) for (const destination of views) {
    run(`switchView('${origin.bindings[0]!.value}')`);
    for (const key of destination.bindings[0]!.keys) fireKey(key);
    assert.equal(run("currentViewName()"), destination.bindings[0]!.value);
  }
  run("switchView('summary')");
  fireKey("g"); fireKey("Escape"); fireKey("v");
  assert.equal(run("currentViewName()"), "summary");
  const input = document.createElement("input"); input.type = "text";
  fireKey("g"); fireKey("s", input); fireKey("v");
  assert.equal(run("currentViewName()"), "summary");
});


test("composing or held Enter in the palette cannot run a command", async () => {
  const { document, run } = await harness([sample()]);
  run("openPalette(); renderPalette('Go to Tools')");
  const input = document.querySelector("#command-input")!;
  const keydown = input.listeners.get("keydown")!;
  for (const flag of ["isComposing", "repeat"]) {
    keydown({ key: "Enter", [flag]: true, preventDefault() { throw new Error("Composition must keep its default behavior"); } });
    assert.equal(run("currentViewName()"), "summary");
    assert.equal(document.querySelector("#command-palette")!.open, true);
  }
});
