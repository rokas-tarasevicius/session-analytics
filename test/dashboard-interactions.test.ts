// Regression tests for dashboard shell interactions: palette ranking, custom windows, URL state, shortcut targets,
// provider shortcuts, the export menu's Escape handling and the shared in-flight refresh.
import assert from "node:assert/strict";
import test from "node:test";

import { installExportMenu, openExportMenu } from "../src/public/export-menu.js";
import { parseUrlState, serializeUrlState } from "../src/public/url-state.js";
import {
  clampWindow, isTextEntryTarget, presentProviders, providerShortcutTarget, rankPaletteItems, resolveCustomWindow, singleFlight, validDay,
} from "../src/public/view-model.js";
import type { SessionAnalytics } from "../src/types.ts";
import { Element, documentFromHtml } from "./release-dom.ts";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

const views = ["summary", "velocity", "costs", "pricing", "tools", "activity"];
const presets = ["7", "30", "90", "all", "custom"];

test("palette ranks exact, prefix, word-start, substring, then subsequence matches and drops weak fuzzy matches", async () => {
  const { run } = await harness([sample()]);
  run("resetExportMenu = () => {}");
  const labels = (query: string) => [...run(`rankPaletteItems(paletteItems(), ${JSON.stringify(query)}).map((item) => item.label)`)] as string[];
  // "help" used to list "Switch to dark theme" first through a subsequence of its keywords.
  assert.deepEqual(labels("help"), ["Keyboard shortcuts"]);
  assert.equal(labels("export")[0], "Export view…");
  assert.equal(labels("refresh")[0], "Refresh snapshot");
  assert.equal(labels("Go to Costs")[0], "Go to Costs");
  assert.equal(labels("synthetic")[0], "Focus Synthetic");
  assert.deepEqual(labels("zzzz"), []);
  assert.equal(labels("").length, (run("paletteItems().length") as number));

  const item = (label: string, group = "G", keywords = "") => ({ group, keywords, label });
  const items = [item("Mapping the stack", "A"), item("Stacked bars", "B"), item("Open stack", "C"), item("stack", "D"), item("Instacks", "E"), item("s t a c k", "F")];
  assert.deepEqual(rankPaletteItems(items, "stack").map(({ label }) => label), ["stack", "Stacked bars", "Mapping the stack", "Open stack", "Instacks"]);
  // A subsequence-only match survives when nothing matches more strongly.
  assert.deepEqual(rankPaletteItems([item("Switch to dark theme"), item("Summary")], "sdt").map(({ label }) => label), ["Switch to dark theme"]);
  // Items stay grouped: a group follows its best item, and items within a group follow their own scores.
  const grouped = rankPaletteItems([item("Hide Claude", "Providers", "provider claude"), item("Go to Costs", "Views", "view costs"), item("Claude rates", "Providers", "claude")], "claude");
  assert.deepEqual(grouped.map(({ label }) => label), ["Claude rates", "Hide Claude"]);
});

test("custom windows keep a cleared bound, swap a reversed range and clamp to the observed history", async () => {
  const bounds = { min: "2026-08-01", max: "2026-09-30" };
  assert.deepEqual(resolveCustomWindow({ ...bounds, start: "2026-09-01", end: "", previousStart: "2026-08-10", previousEnd: "2026-09-10" }), { adjusted: [], end: "2026-09-10", start: "2026-09-01" });
  assert.deepEqual(resolveCustomWindow({ ...bounds, start: "", end: "2026-09-20", previousStart: "2026-08-10", previousEnd: "2026-09-10" }), { adjusted: [], end: "2026-09-20", start: "2026-08-10" });
  assert.deepEqual(resolveCustomWindow({ ...bounds, start: "2026-09-20", end: "2026-09-02" }), { adjusted: ["swapped"], end: "2026-09-20", start: "2026-09-02" });
  assert.deepEqual(resolveCustomWindow({ ...bounds, start: "2030-01-01", end: "2030-02-01" }), { adjusted: ["clamped"], end: "2026-09-30", start: "2026-09-30" });
  assert.deepEqual(resolveCustomWindow({ ...bounds, start: "2026-02-30", end: "2026-09-02", previousStart: "2026-08-05" }), { adjusted: ["invalid-start"], end: "2026-09-02", start: "2026-08-05" });
  assert.deepEqual(resolveCustomWindow({ ...bounds, start: "", end: "" }), { adjusted: [], end: "2026-09-30", start: "2026-08-01" });
  assert.deepEqual(clampWindow({ ...bounds, start: "2026-09-20", end: "2026-09-02" }), { end: "2026-09-20", start: "2026-09-02" });
  assert.equal(validDay("2026-02-29"), null); assert.equal(validDay("2028-02-29"), "2028-02-29"); assert.equal(validDay("2026-9-1"), null);

  const { document, run } = await harness([sample()]);
  run("resetExportMenu = () => {}; applyWindowPreset('custom', { render: false }); applyCustomRange('2026-09-10', '2026-09-20')");
  const start = document.querySelector("#window-start")!, end = document.querySelector("#window-end")!, note = document.querySelector("#window-note")!;
  assert.equal(run("windowPreset"), "custom");
  // Clearing the end date while editing neither wipes the start nor re-renders; leaving the field restores it.
  end.value = ""; run("applyCustomWindow()");
  assert.equal(start.value, "2026-09-10"); assert.equal(end.value, "");
  run("restoreWindowInputs()");
  assert.deepEqual([start.value, end.value], ["2026-09-10", "2026-09-20"]);
  start.value = "2026-09-25"; end.value = "2026-09-12"; run("applyCustomWindow()");
  assert.deepEqual([start.value, end.value], ["2026-09-12", "2026-09-25"]);
  assert.equal(note.hidden, false); assert.match(note.textContent, /swapped/);
  start.value = "2026-01-01"; end.value = "2027-01-01"; run("applyCustomWindow()");
  assert.deepEqual([start.value, end.value], ["2026-09-01", "2026-10-03"]);
  assert.match(note.textContent, /Adjusted to the observed history, 2026-09-01 to 2026-10-03/);
  start.value = "2026-09-15"; end.value = "2026-09-16"; run("applyCustomWindow()");
  assert.equal(note.hidden, true);
  run("applyWindowPreset('7')");
  assert.equal(note.hidden, true);
});

test("a window without sessions or activity routes to the empty state and offers a wider window", async () => {
  const session = sample();
  const { document, run } = await harness([session]);
  run("resetExportMenu = () => {}; applyWindowPreset('custom', { render: false }); applyCustomRange('2026-09-05', '2026-09-06')");
  const status = document.querySelector("#view-status")!;
  assert.equal(run("windowEmpty"), true);
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /No sessions started or were active during 2026-09-05 through 2026-09-06/);
  assert.equal(document.querySelector('[data-view-panel="summary"]')!.hidden, true);
  const action = status.querySelectorAll("button").find((button) => button.textContent.trim() === "Show all time")!;
  action.listeners.get("click")!();
  assert.equal(run("windowPreset"), "all");
  assert.equal(run("windowEmpty"), false);
  assert.equal(status.hidden, true);
  assert.equal(document.querySelector('[data-view-panel="summary"]')!.hidden, false);
});

test("URL state round-trips view, window, custom dates and repository, and drops one-shot parameters", () => {
  const options = { views, presets, aliases: { models: "costs" } };
  const states = [
    { view: "summary", window: "30", start: null, end: null, repo: null },
    { view: "costs", window: "7", start: null, end: null, repo: "conductor-0123456789abcdef" },
    { view: "velocity", window: "custom", start: "2026-09-01", end: "2026-09-14", repo: null },
    { view: "activity", window: "all", start: null, end: null, repo: "repo-id" },
  ];
  for (const state of states) {
    const search = serializeUrlState(state);
    const parsed = parseUrlState(search, options);
    assert.deepEqual({ view: parsed.view, window: parsed.window ?? "30", start: parsed.start, end: parsed.end, repo: parsed.repo }, state, search);
  }
  // The default window is implied; the view is always written; dates only accompany a custom window.
  assert.equal(serializeUrlState({ view: "summary", window: "30" }), "?view=summary");
  assert.equal(serializeUrlState({ view: "tools", window: "7", start: "2026-09-01", end: "2026-09-07" }), "?view=tools&window=7");
  // One-shot instructions are removed and unrelated parameters survive.
  assert.equal(serializeUrlState({ view: "costs", window: "90" }, "?open=palette&theme=dark&density=comfortable&debug=1&view=summary"), "?view=costs&window=90&debug=1");
  const loaded = parseUrlState("?view=models&window=custom&start=2026-09-01&end=2026-09-31&open=palette&theme=dark&density=roomy", options);
  assert.deepEqual(loaded, { view: "costs", window: "custom", start: "2026-09-01", end: null, repo: null, open: "palette", theme: "dark", density: null });
  assert.equal(parseUrlState("?start=2026-09-01&end=2026-09-07", options).window, "custom");
  assert.deepEqual(parseUrlState("?view=nope&window=12", options), { view: null, window: null, start: null, end: null, repo: null, open: null, theme: null, density: null });
});

test("dashboard writes view, window and repository changes to history and restores them on Back", async () => {
  const other = sample(); other.repositoryId = "second";
  const { context, run } = await harness([sample(), other]);
  const entries: Array<{ mode: string; url: string }> = [];
  const location = { pathname: "/", search: "?view=summary", hash: "" };
  const record = (mode: string) => (_state: unknown, _title: string, url: string) => {
    entries.push({ mode, url });
    const query = url.indexOf("?");
    location.search = query < 0 ? "" : url.slice(query);
  };
  (context["window"] as Record<string, unknown>)["history"] = { pushState: record("push"), replaceState: record("replace") };
  (context["window"] as Record<string, unknown>)["location"] = location;
  (context["window"] as Record<string, unknown>)["scrollTo"] = () => {};
  run(`resetExportMenu = () => {}; snapshot.repositories.push({ repository: { id: "second", name: "Second" }, warnings: [] }); populateRepositories(); urlReady = true`);
  run("switchView('costs')");
  run("applyWindowPreset('7')");
  run("selectRepository('second', { scroll: false })");
  run("applyWindowPreset('custom', { render: false }); applyCustomRange('2026-09-10', '2026-09-12')");
  assert.deepEqual(entries, [
    { mode: "push", url: "/?view=costs" },
    { mode: "push", url: "/?view=costs&window=7" },
    { mode: "push", url: "/?view=costs&window=7&repo=second" },
    { mode: "replace", url: "/?view=costs&window=custom&start=2026-09-10&end=2026-09-12&repo=second" },
  ]);
  // Back to an earlier entry restores it without writing history.
  location.search = "?view=summary&window=90";
  run("restoreUrlState()");
  assert.equal(run("currentViewName()"), "summary");
  assert.equal(run("windowPreset"), "90");
  assert.equal(run("elements.repositoryFilter.value"), "all");
  assert.equal(entries.length, 4);
  location.search = "?view=costs&window=custom&start=2026-09-10&end=2026-09-12&repo=Second";
  run("restoreUrlState()");
  assert.deepEqual([run("currentViewName()"), run("windowPreset"), run("elements.windowStart.value"), run("elements.windowEnd.value"), run("elements.repositoryFilter.value")], ["costs", "custom", "2026-09-10", "2026-09-12", "second"]);
  assert.equal(entries.length, 4);
});

test("single-key shortcuts are suppressed only for text entry", () => {
  for (const type of ["text", "search", "email", "number", "date", "url", "password", ""]) assert.equal(isTextEntryTarget({ tagName: "INPUT", type }), true, type);
  for (const type of ["checkbox", "radio", "button", "submit", "range", "color"]) assert.equal(isTextEntryTarget({ tagName: "INPUT", type }), false, type);
  assert.equal(isTextEntryTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTextEntryTarget({ tagName: "SELECT" }), true);
  assert.equal(isTextEntryTarget({ tagName: "DIV", isContentEditable: true }), true);
  for (const tagName of ["BUTTON", "SUMMARY", "DIV", "svg", "A"]) assert.equal(isTextEntryTarget({ tagName }), false, tagName);
  assert.equal(isTextEntryTarget(null), false);
});

test("provider shortcuts count through the providers present in the snapshot", async () => {
  const sessions = ["gemini", "claude", "copilot", "claude"].map((provider) => ({ provider }));
  assert.deepEqual(presentProviders(sessions), ["claude", "copilot", "gemini"]);
  assert.equal(providerShortcutTarget("1", ["claude", "copilot", "gemini"]), "claude");
  assert.equal(providerShortcutTarget("3", ["claude", "copilot", "gemini"]), "gemini");
  assert.equal(providerShortcutTarget("4", ["claude", "copilot", "gemini"]), null);
  assert.equal(providerShortcutTarget("0", ["claude"]), null);
  assert.equal(providerShortcutTarget("x", ["claude"]), null);
  const all = ["codex", "claude", "cursor", "copilot", "opencode", "gemini", "unsupported"];
  assert.equal(providerShortcutTarget("7", all), "unsupported");

  const claude = sample(), gemini = sample(); gemini.provider = "gemini" as SessionAnalytics["provider"];
  const { document, run } = await harness([claude, gemini]);
  run("resetExportMenu = () => {}; renderLine = () => {}");
  assert.deepEqual([...run("snapshotProviders()")], ["claude", "gemini"]);
  const chip = document.querySelector('[data-provider-filter="gemini"]')!;
  assert.equal(chip.checked, true);
  run("toggleProvider(providerShortcutTarget('2', snapshotProviders()))");
  assert.equal(chip.checked, false);
  // The palette lists the same providers with the same numbers; absent providers have no entry.
  const providers = run("paletteItems().filter((item) => item.group === 'Providers').map((item) => item.label + ' ' + item.hint)") as string[];
  assert.deepEqual([...providers], ["Hide Claude in the daily chart p 1", "Show Gemini CLI in the daily chart p 2"]);
  run("toggleProvider('codex')");
  assert.equal(document.querySelector('[data-provider-filter="codex"]')!.checked, true);
  // Tools and Activity keep their own selections, listing only present providers.
  run("currentViewName = () => 'tools'; renderViewProviderFilters(elements.toolsProviderFilters, 'tools')");
  assert.deepEqual(document.querySelector("#tools-provider-filters")!.querySelectorAll("label").map((label) => label.dataset["provider"]), ["claude", "gemini"]);
});

test("Velocity provider chips list present providers and count N of M against them", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentFromHtml("") });
  try {
    const { renderVelocity } = await import(new URL("../src/public/velocity.js", import.meta.url).href);
    const sessions = ["claude", "codex"].map((provider) => ({
      provider, createdAt: "2026-09-01T12:00:00Z", repositoryId: "synthetic", repositoryName: "Synthetic", velocity: {
        dimensions: [{ agent: `${provider}-cli`, model: "synthetic", executionKind: "top-level", effort: "unknown" }],
        buckets: [["2026-09-01", 12, 0, [2, 100, 100, 0, 0, 20, 0, 4, 0, 0, 120, 20, 100, 100]]], undated: [],
      },
    })) as unknown as SessionAnalytics[];
    const container = new Element(), context = { start: "2026-09-01", end: "2026-09-02", generatedAt: "2026-09-02T12:00:00Z", timeZone: "UTC", providers: ["codex", "claude"] };
    renderVelocity(container, sessions, context);
    const chips = () => container.querySelectorAll(".chip").map((label) => label.dataset["provider"]);
    assert.deepEqual(chips(), ["codex", "claude"]);
    const lead = container.querySelector(".velocity-lead")!;
    assert.doesNotMatch(lead.textContent, /of \d+ providers/);
    const codex = container.querySelector('[data-provider="codex"]')!.querySelector("input")!;
    codex.checked = false; codex.listeners.get("change")!();
    assert.match(lead.textContent, /1 of 2 providers/);
    // A refreshed snapshot with another provider rebuilds the chips and keeps the earlier choice.
    renderVelocity(container, sessions, { ...context, providers: ["codex", "claude", "gemini"] });
    assert.deepEqual(chips(), ["codex", "claude", "gemini"]);
    assert.equal(container.querySelector('[data-provider="codex"]')!.querySelector("input")!.checked, false);
    assert.match(lead.textContent, /2 of 3 providers/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

class MenuNode extends EventTarget {
  dataset: Record<string, string> = {};
  disabled = false; hidden = false; open = false; focused = false; textContent = "";
  children: MenuNode[] = [];
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  querySelectorAll(): MenuNode[] { return this.children.filter((child) => child.dataset["export"]); }
  querySelector(): MenuNode { return this.children[0]!; }
  focus(): void { this.focused = true; }
}

test("Escape closes the export menu without reaching the dashboard's Escape shortcut; outside presses close it", async () => {
  const document = new MenuNode(), menu = new MenuNode(), status = new MenuNode(), description = new MenuNode(), summary = new MenuNode(), outside = new MenuNode();
  const buttons = ["json", "sessions", "daily", "models", "tools", "shared"].map((kind) => { const button = new MenuNode(); button.dataset["export"] = kind; return button; });
  menu.children = [summary, ...buttons];
  Object.assign(document, { querySelector: (selector: string) => ({ "#export-menu": menu, "#export-status": status, "#export-description": description })[selector] });
  const original = (globalThis as Record<string, unknown>)["document"];
  (globalThis as Record<string, unknown>)["document"] = document;
  try {
    let selection: unknown = null, failed = false;
    installExportMenu(() => selection as never, { unavailableMessage: () => failed ? "Nothing to export: the analysis failed." : "The snapshot is still loading." });
    const open = () => { menu.open = true; menu.dispatchEvent(new Event("toggle")); };
    const escape = () => { const event = new Event("keydown", { cancelable: true }); Object.defineProperty(event, "key", { value: "Escape" }); document.dispatchEvent(event); return event; };

    open();
    assert.equal(description.textContent, "The snapshot is still loading.");
    failed = true; open();
    assert.equal(description.textContent, "Nothing to export: the analysis failed.");
    assert.ok(buttons.every((button) => button.disabled));

    selection = { kind: "machine", sessions: [] };
    open();
    const handled = escape();
    // The dashboard's own keydown handler returns early for handled events, so repository focus survives.
    assert.equal(handled.defaultPrevented, true);
    assert.equal(menu.open, false);
    assert.equal(summary.focused, true);
    assert.equal(escape().defaultPrevented, false, "a closed menu leaves Escape to the dashboard");

    open();
    const inside = new Event("pointerdown"); Object.defineProperty(inside, "target", { value: buttons[0] });
    document.dispatchEvent(inside);
    assert.equal(menu.open, true);
    const away = new Event("pointerdown"); Object.defineProperty(away, "target", { value: outside });
    document.dispatchEvent(away);
    assert.equal(menu.open, false);

    open();
    const blur = new Event("focusout"); Object.defineProperty(blur, "relatedTarget", { value: outside });
    menu.dispatchEvent(blur);
    assert.equal(menu.open, false, "moving focus to another control closes it");

    // The palette's Export entry opens the menu and focuses the first available download.
    for (const button of buttons) button.focused = false;
    openExportMenu();
    assert.equal(menu.open, true);
    menu.dispatchEvent(new Event("toggle"));
    assert.equal(buttons[0]!.focused, true);
  } finally {
    (globalThis as Record<string, unknown>)["document"] = original;
  }
});

test("refreshes share one in-flight request and start again once it settles", async () => {
  let calls = 0, release: () => void = () => {};
  const load = singleFlight(async (refresh: boolean) => { calls += 1; await new Promise<void>((resolve) => { release = resolve; }); return refresh; });
  const first = load(true), second = load(true), third = load(false);
  assert.equal(first, second); assert.equal(second, third);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
  const next = load(false);
  assert.notEqual(next, first);
  assert.equal(calls, 2);
  release(); await next;
  const failing = singleFlight(async () => { calls += 1; throw new Error("analysis failed"); });
  await assert.rejects(failing(), /analysis failed/);
  await assert.rejects(failing(), /analysis failed/);
  assert.equal(calls, 4, "a rejected load does not block the next attempt");
});
