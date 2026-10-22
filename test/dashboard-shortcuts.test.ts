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
    assert.ok(shortcutHint(item.id, binding.value).includes(sequence.replace("Mod+k", "Mod+K")), sequence);
    const finalKey = binding.keys.at(-1)!;
    const event = finalKey === "Mod+k" ? { ...keyEvent("k"), metaKey: true } : keyEvent(finalKey);
    assert.equal(Boolean(matchShortcut(event, { enabled: false, pending })), binding.always, sequence);
  }
  assert.equal(shortcutRegistry.find((item) => item.id === "provider")!.bindings.length, Math.min(providerIds.length, 9));
});

test("duplicate bindings fail at module load and identify both shortcuts", async () => {
  const moduleUrl = new URL("../src/public/shortcuts.js", import.meta.url);
  const source = await readFile(moduleUrl, "utf8");
  const duplicate = source.replace('view("Summary", "s", "summary"),', 'view("Summary", "s", "summary"), view("Conflicting", "s", "conflicting"),');
  assert.notEqual(duplicate, source, "the duplicate fixture must change the module");
  const standalone = duplicate.replace(/from "(\.\/[^"]+)"/g, (_, path: string) => `from "${new URL(path, moduleUrl).href}"`);
  await assert.rejects(import(`data:text/javascript,${encodeURIComponent(standalone)}`), /Duplicate shortcut binding "g s": view-summary and view-conflicting/);
});

test("typing, composition, held keys, and browser modifiers cannot fire character shortcuts", () => {
  for (const key of ["g", "p", "1", "t", "d", "r", "?", "/", "Escape", "["]) {
    for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
      assert.equal(matchShortcut({ key, target }), null, key);
      assert.equal(matchShortcut({ key, target }, { pending: "g" }), null, key);
    }
    assert.equal(matchShortcut({ ...keyEvent(key), keyCode: 229, isComposing: false }), null, `${key}: IME commit boundary`);
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
  assert.equal(shortcutHint("palette"), "Mod+K or /");
  const rows = block.trim().split("\n").slice(2);
  assert.deepEqual(rows, shortcutRegistry.map((item) => `| \`${shortcutHint(item.id)}\` | ${item.label} |`));
});

test("the help overlay and palette use registry labels and bindings", async () => {
  const { document, run } = await harness([sample()]);
  run("renderShortcutHelp()");
  const rows = document.querySelector("#shortcut-list")!.querySelectorAll("dt");
  assert.deepEqual(rows.map((row) => row.textContent), shortcutRegistry.map((item) => item.label));
  const paletteRow = rows.find((row) => row.textContent === "Command palette")?.parentElement;
  assert.equal(paletteRow?.querySelector("dd")?.textContent.trim().replace(/\s+/g, " "), "Ctrl K or /");
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
  for (const flags of [{ isComposing: true }, { keyCode: 229, isComposing: false }, { keyCode: 229, isComposing: true }, { repeat: true }]) {
    keydown({ key: "Enter", ...flags, preventDefault() { throw new Error("Composition must keep its default behavior"); } });
    assert.equal(run("currentViewName()"), "summary");
    assert.equal(document.querySelector("#command-palette")!.open, true);
  }
  run("resetExportMenu = () => {}; snapshot.rateCard = {};");
  keydown({ key: "Enter", preventDefault() {} });
  assert.equal(run("currentViewName()"), "tools");
  assert.equal(document.querySelector("#command-palette")!.open, false);
});


test("bare slash respects open dialogs and only opens the palette outside them", async () => {
  const { document, run, fireKey } = await harness([sample()]);
  for (const [open, id] of [["openHelp", "help-overlay"], ["openCoverage", "coverage-dialog"], ["openMachines", "machines-dialog"]]) {
    run(`${open}()`);
    fireKey("/", document.querySelector(`#${id}`)!);
    assert.equal(document.querySelector(`#${id}`)!.open, true, `${id} stays open`);
    assert.equal(document.querySelector("#command-palette")!.open, false, `${id} blocks slash`);
    document.querySelector(`#${id}`)!.close();
  }
  fireKey("/");
  assert.equal(document.querySelector("#command-palette")!.open, true);
});
