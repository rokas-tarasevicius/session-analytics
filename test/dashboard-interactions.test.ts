// Regression tests for dashboard shell interactions: palette ranking, custom windows, URL state, shortcut targets,
// provider shortcuts, the export menu's Escape handling and the shared in-flight refresh.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { installExportMenu, openExportMenu } from "../src/public/export-menu.js";
import { parseUrlState, serializeUrlState } from "../src/public/url-state.js";
import {
  clampWindow, isTextEntryTarget, presentProviders, providerShortcutTarget, rankPaletteItems, resolveCustomWindow, singleFlight, validDay,
} from "../src/public/view-model.js";
import type { SessionAnalytics } from "../src/types.ts";
import { Element, documentFromHtml } from "./release-dom.ts";
import { harness, sample, withLedger } from "./validation/aggregation-ui-harness.ts";

const views = ["summary", "velocity", "costs", "pricing", "tools", "activity"];
const presets = ["7", "30", "90", "all", "custom"];

test("the harness fires g v through the dashboard keydown handler", async () => {
  const { run, fireKey } = await harness([sample()]);
  fireKey("g"); fireKey("v");
  assert.equal(run("currentViewName()"), "velocity");
});

test("fleet row tooltips retain repository IDs and execution counts for screen readers", async () => {
  const { document, run } = await harness([withLedger(sample(), [["model-synthetic", 10]])]);
  run("renderRepositoryTable(activeView().repositories)");
  const row = document.querySelector("#repository-rows")!.querySelector("tr")!;
  const button = row.querySelector("button.row-link")!;
  const details = run("'Synthetic · ID ' + repositoryKey('synthetic')");
  const breakdown = run("executionBreakdown(activeView().repositories[0].summary)");
  assert.equal(button.getAttribute("aria-label"), details);
  assert.equal((button as any).title, details);
  assert.equal(row.getAttribute("aria-label"), `${details} · 1 session · ${breakdown}`);
  assert.equal((row.children[1] as any).title, breakdown);
  assert.equal(row.children[1]!.getAttribute("aria-label"), `1 · ${breakdown}`);
  assert.equal(row.children[0]!.querySelector("small"), null);
  assert.equal(row.children[1]!.querySelector("small"), null);
  assert.equal(row.children.length, 8);
});

test("shared snapshot ignores view, window and provider shortcuts", async () => {
  const { context, document, run, fireKey } = await harness([sample()]);
  context["sharedFixture"] = { kind: "shared", sources: [], minimumSessions: 5,
    summary: { sessions: 5 }, repositories: [{ repository: "repo-synthetic", sessions: 5, apiEquivalentSpendUsd: 1,
      providerReportedSpendUsd: 0, inputTokens: 100, outputTokens: 20, priceableTokens: 120, pricedTokens: 120 }] };
  run("render(sharedFixture); elements.windowStart.value = elements.windowEnd.value = elements.windowStart.min = elements.windowEnd.max = ''");
  assert.equal(run("snapshot"), null);
  assert.equal(run("exportSelection() === sharedFixture"), true);
  const assertHidden = () => {
    assert.ok(document.querySelectorAll("[data-view-panel]").every((panel) => panel.hidden));
    assert.equal(document.querySelector("#shared-snapshot")!.hidden, false);
    assert.equal(document.querySelector(".scope-line")!.hidden, true);
    assert.equal(document.querySelector("#help-button")!.hidden, true);
  };
  for (const action of ["switchView('velocity')", "stepView(1)", "applyWindowPreset('7')", "toggleProvider('claude')"]) {
    assert.doesNotThrow(() => run(action)); assertHidden();
  }
  for (const key of ["1", "2", "3", "4", "[", "]", "g", "v", "/"]) {
    assert.doesNotThrow(() => fireKey(key)); assertHidden();
  }
  assert.equal(document.querySelector("#command-palette")!.open, true);
  assert.equal(run("paletteItems().some((item) => ['Views', 'Repositories'].includes(item.group))"), false);
  assert.doesNotMatch(document.querySelector("#command-list")!.textContent, /Go to|Focus undefined|Focus repo/);
  assert.equal((document.querySelector(".wordmark") as any).href, "#shared-snapshot");
  document.querySelector(".wordmark")!.listeners.get("click")!({ button: 0, preventDefault() { assert.fail("shared anchor should navigate normally"); } });
  assertHidden();
  context["fetch"] = async () => { throw new TypeError("Failed to fetch"); };
  await assert.doesNotReject(async () => { await run("loadSnapshot(true)"); });
  assertHidden();
  assert.equal(run("exportSelection() === sharedFixture"), true);
  assert.equal(document.querySelector("#error-message")!.textContent, "The local server did not answer (Failed to fetch). You are looking at the previous shared snapshot.");
  run("fixture.rateCard = { effectiveDate: '2026-10-01', models: [] }; render(fixture)");
  assert.equal(run("sharedSnapshot"), null);
  for (const selector of [".topbar-controls", ".view-nav", ".repo-nav", ".scope-line", "#help-button"]) assert.equal(document.querySelector(selector)!.hidden, false);
  assert.equal((document.querySelector(".wordmark") as any).href, "?view=summary");
});

test("a keyboard provider toggle closes the export menu", async () => {
  const claude = withLedger(sample(), [["synthetic", 2]]), codex = withLedger(sample(), [["synthetic", 3]]); codex.provider = "codex";
  const { context, document, run, fireKey } = await harness([claude, codex]);
  let selections = 0;
  context["fixedSelection"] = () => { selections++; return { kind: "machine", sessions: [] }; };
  run("resetExportMenu = installExportMenu(fixedSelection)");
  const menu = document.querySelector("#export-menu")!, description = document.querySelector("#export-description")!;
  for (const view of ["summary", "velocity", "tools", "activity"]) {
    run(`switchView('${view}')`);
    const chip = view === "velocity" ? document.querySelector('#velocity-view .provider-key [data-provider="codex"] input') : null;
    if (chip) Object.assign(chip, { click() { chip.checked = !chip.checked; chip.listeners.get("change")!(); } });
    menu.open = true; menu.listeners.get("toggle")!();
    assert.notEqual(description.textContent, "");
    fireKey("p"); fireKey("1");
    assert.equal(menu.open, false, view); assert.equal(description.textContent, "", view);
    assert.ok(menu.querySelectorAll("[data-export]").every((button) => button.disabled));
    const count = selections;
    menu.querySelector('[data-export="json"]')!.listeners.get("click")!();
    assert.equal(selections, count, "closed menu discarded its preview");
    if (chip) assert.equal(chip.checked, false, "the actual Velocity chip changed");
  }
});

test("an export download rejects a selection changed since its preview", async () => {
  const { context, document, run } = await harness([]);
  context["selection"] = { snapshot: { kind: "machine", sessions: [] }, basis: "All providers" };
  run("resetExportMenu = installExportMenu(() => selection)");
  const menu = document.querySelector("#export-menu")!;
  menu.open = true; menu.listeners.get("toggle")!();
  run("selection.basis = 'Claude only'");
  menu.querySelector('[data-export="json"]')!.listeners.get("click")!();
  assert.equal(menu.open, false); assert.equal(document.querySelector("#export-description")!.textContent, "");
  assert.equal(document.querySelector("#export-status")!.textContent, "Selection changed; reopen Export");
  assert.ok(menu.querySelectorAll("[data-export]").every((button) => button.disabled));
});

test("refresh failure composes a sentence with snapshot timezone labels to agree across views", async () => {
  const { context, document, run } = await harness([sample()]);
  assert.equal(run("describeLoadError(new TypeError('Failed to fetch'))"), "The local server did not answer (Failed to fetch).");
  assert.equal(run("describeLoadError(new TypeError('Failed to fetch.'))"), "The local server did not answer (Failed to fetch).");
  assert.equal(run("describeLoadError(new Error('HTTP 500'))"), "The analysis failed (HTTP 500).");
  context["fetch"] = async () => { throw new TypeError("Failed to fetch."); };
  await run("loadSnapshot(true)");
  assert.equal(document.querySelector("#error-banner")!.dataset["tone"], "warn");
  assert.equal(document.querySelector("#error-title")!.textContent, "Couldn't refresh");
  assert.equal(document.querySelector("#error-message")!.textContent, "The local server did not answer (Failed to fetch). You are looking at the snapshot from 3 Oct 2026, 13:00.");
  assert.match(document.querySelector("#generated-at")!.textContent, / · stale$/);
  assert.equal(document.querySelector("#sync-label")!.textContent, "Stale · 13:00");
  assert.equal(document.querySelector("#error-retry")!.hidden, false);
  context["fetch"] = async () => ({ ok: false, status: 500, json: async () => ({ error: "Analysis failed." }) });
  await run("loadSnapshot(true)");
  assert.match(document.querySelector("#error-message")!.textContent, /^The analysis failed \(HTTP 500\)\. Analysis failed\. You are looking at the snapshot from /);
  run("snapshot = null");
  context["fetch"] = async () => ({ ok: false, status: 502, json: async () => ({ error: "Session analysis exceeded its 1024 MB worker heap limit." }) });
  await run("loadSnapshot()");
  assert.equal(document.querySelector("#error-title")!.textContent, "No snapshot yet");
  assert.equal(document.querySelector("#error-message")!.textContent, "The local analysis did not finish. The analysis failed (HTTP 502). Session analysis exceeded its 1024 MB worker heap limit. Retry, or check the terminal running the dashboard.");
  assert.equal(document.querySelector("#error-retry")!.hidden, false);
});

test("a scan longer than one request is polled until it answers, and only the first request refreshes", async () => {
  const { context, document, run } = await harness([sample()]);
  run("fixture.rateCard = { effectiveDate: '2026-10-01', models: [] }");
  const fixture = run("fixture"), urls: string[] = [];
  context["fetch"] = async (url: string) => {
    urls.push(url);
    return urls.length < 3 ? { ok: true, status: 202, json: async () => ({ pending: true }) } : { ok: true, status: 200, json: async () => fixture };
  };
  await run("loadSnapshot(true)");
  assert.deepEqual(urls, ["/api/analytics?refresh=1&wait=10", "/api/analytics?wait=10", "/api/analytics?wait=10"]);
  assert.equal(document.querySelector("#error-banner")!.hidden, true);
  assert.equal(document.querySelector("#sync-context")!.dataset["state"], "live");
});

test("Escape cancels an armed g chord and dashboard statuses are live regions", async () => {
  const { document, run, fireKey } = await harness([sample()]);
  fireKey("g"); assert.equal(run("pendingChord"), "g");
  fireKey("Escape"); assert.equal(run("pendingChord"), null);
  fireKey("v"); assert.equal(run("currentViewName()"), "summary");
  fireKey("g");
  const input = Object.assign(new Element("INPUT"), { type: "search" });
  fireKey("Escape", input); assert.equal(run("pendingChord"), null);
  fireKey("g");
  const menu = document.querySelector("#export-menu")!; menu.open = true;
  assert.equal(fireKey("Escape").defaultPrevented, true);
  assert.equal(run("pendingChord"), null);
  assert.equal(document.querySelector("#sync-context")!.getAttribute("role"), "status");
  assert.equal(document.querySelector("#view-status")!.getAttribute("aria-live"), "polite");
});

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
  assert.match(note.textContent, /Clamped to history · 1 Sept – 3 Oct 2026/);
  start.value = "2026-09-15"; end.value = "2026-09-16"; run("applyCustomWindow()");
  assert.equal(note.hidden, true);
  run("applyWindowPreset('7')");
  assert.equal(note.hidden, true);
});

test("a window without sessions or activity offers a wider window with shared date labels to agree across views", async () => {
  const session = sample();
  const { document, run } = await harness([session]);
  run("resetExportMenu = () => {}; applyWindowPreset('custom', { render: false }); applyCustomRange('2026-09-05', '2026-09-06')");
  const status = document.querySelector("#view-status")!;
  assert.equal(run("windowEmpty"), true);
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /No sessions started or were active during 5 Sept – 6 Sept 2026/);
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

test("Antigravity-only daily value is selected, plotted and toggleable", async () => {
  const session = withLedger(sample(), [["model-synthetic", 10]]);
  session.provider = "antigravity";
  const { document, run } = await harness([session]);
  assert.ok(document.querySelector('[data-provider-filter="antigravity"]')!.checked);
  assert.ok([...run("activeProviders()")].includes("antigravity"));
  run("renderLine(dailyProviderSpend(activeView().dailySessions))");
  const chart = document.querySelector("#daily-spend")!;
  assert.match(chart.textContent, /Antigravity/);
  assert.doesNotMatch(chart.textContent, /Nothing to plot|Choose at least one provider/);
  run("toggleProvider('antigravity')");
  assert.equal(document.querySelector('[data-provider-filter="antigravity"]')!.checked, false);
  assert.match(chart.textContent, /No daily priced activity|Choose at least one provider/);
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
    assert.match(container.querySelector(".evidence")!.textContent, /1 of 2 providers/);
    // A refreshed snapshot with another provider rebuilds the chips and keeps the earlier choice.
    renderVelocity(container, sessions, { ...context, providers: ["codex", "claude", "gemini"] });
    assert.deepEqual(chips(), ["codex", "claude", "gemini"]);
    assert.equal(container.querySelector('[data-provider="codex"]')!.querySelector("input")!.checked, false);
    assert.match(container.querySelector(".evidence")!.textContent, /2 of 3 providers/);
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

test("Summary, Velocity and Tools share axis labels while money totals retain cents", async () => {
  const session = withLedger(sample(), [["model-synthetic", 120]], { day: "2026-09-13" });
  session.createdAt = "2026-09-13T12:00:00Z";
  const cells = session.velocity!.buckets;
  cells[0]![3][0] = 40;
  cells.push(["2026-09-14", 12, 0, [...cells[0]![3]]], ["2026-09-15", 12, 0, [...cells[0]![3]]]);
  session.evidence!.tools = "observed"; session.tools = { Read: 3 }; session.metrics.toolCalls = 3;
  const { document, run } = await harness([session], { start: "2026-09-13", end: "2026-10-12", timeZone: "America/Los_Angeles" });
  run("renderSummary(activeView())");
  const daily = document.querySelector("#daily-spend")!;
  const summaryAxis = daily.querySelectorAll("text").map((node) => node.textContent);
  assert.ok(summaryAxis.includes("18 Sept")); assert.ok(summaryAxis.includes("12 Oct")); assert.ok(summaryAxis.includes("$40"));
  const legend = daily.querySelector(".chart-legend")!;
  assert.equal(legend.dataset["layout"], "list");
  assert.deepEqual(legend.querySelectorAll(".chart-legend-value").map((node) => node.textContent), ["$120.00"]);
  assert.equal(document.querySelector("#metric-spend")!.textContent, "$120.00");
  run("currentViewName = () => 'velocity'; renderActiveAnalyticsView(activeView())");
  const velocityAxis = document.querySelector(".velocity-chart")!.querySelectorAll(".axis-label").map((node) => node.textContent);
  assert.ok(velocityAxis.includes("18 Sept")); assert.ok(velocityAxis.includes("12 Oct")); assert.ok(velocityAxis.includes("$40"));
  assert.deepEqual(document.querySelector(".velocity-legend")!.querySelectorAll(".chart-legend-value").map((node) => node.textContent), ["$120.00"]);
  run("currentViewName = () => 'tools'; renderActiveAnalyticsView(activeView())");
  assert.deepEqual(document.querySelector(".tools-trend-axis")!.children.map((node) => node.textContent), ["13 Sept", "12 Oct"]);
  run("renderSharedView(activeView())");
  assert.match(document.querySelector("#scope-description")!.textContent, /America\/Los_Angeles/);
});

test("refresh status says Refreshing… for full, shared and first-load retries", async () => {
  for (const mode of ["full", "shared", "retry"]) {
    const { context, document, run } = await harness([sample()]);
    if (mode !== "full") run(`snapshot = null; sharedSnapshot = ${mode === "shared" ? "{ kind: 'shared' }" : "null"}`);
    let reject!: (error: Error) => void;
    context["fetch"] = () => new Promise((_resolve, rejectRequest) => { reject = rejectRequest; });
    const pending = run("loadSnapshot(true)");
    assert.equal(document.querySelector("#sync-label")!.textContent, "Refreshing…", mode);
    assert.equal(document.querySelector("#sync-context")!.dataset["state"], "loading");
    reject(new TypeError("Failed to fetch"));
    await pending;
    assert.notEqual(document.querySelector("#sync-label")!.textContent, "Refreshing…");
    assert.equal(document.querySelector("#refresh-button")!.disabled, false);
  }
});

test("range adjustments and unavailable KPI reasons are visible without hovering", async () => {
  const { context, document, run } = await harness([]);
  context["sampleWithoutLedger"] = sample();
  context["sampleWithLedger"] = withLedger(sample(), [["synthetic", 3]]);
  run("showWindowNote(['clamped', 'swapped'])");
  const note = document.querySelector("#window-note")!;
  assert.equal(note.getAttribute("title"), null);
  assert.equal(note.querySelector(".sr-only"), null);
  assert.match(note.textContent, /Clamped to history.*dates were swapped/);
  run("setValue(elements.spend, 0, { eligible: 0, selected: 1 }, money, { reason: 'No activity dates in this selection', slot: elements.spendCoverage })");
  assert.equal(document.querySelector("#metric-spend-coverage")!.textContent, "No activity dates in this selection");
  run("fixture.sessions = [sampleWithoutLedger]; sessionsByRepository = groupByRepository(fixture.sessions); renderSummary(activeView()); renderCosts(activeView())");
  for (const id of ["metric-spend-coverage", "cost-total-coverage", "cost-api-total-coverage", "cost-provider-total-coverage"]) assert.equal(document.querySelector(`#${id}`)!.textContent, "No session in this selection has activity dates", id);
  run("fixture.sessions = [sampleWithLedger]; sessionsByRepository = groupByRepository(fixture.sessions); renderSummary(activeView()); renderCosts(activeView())");
  for (const id of ["metric-spend-coverage", "cost-total-coverage", "cost-api-total-coverage", "cost-provider-total-coverage"]) assert.equal(document.querySelector(`#${id}`)!.textContent, "", `${id}: available figures clear the reason`);
});

test("Summary has six KPIs, noun-phrase titles and short notes with full explanations in Coverage", async () => {
  const session = withLedger(sample(), [["synthetic", 10]], { sessionDated: true });
  const { document, run } = await harness([session]);
  run("renderView()");
  const summary = document.querySelector('[data-view-panel="summary"]')!;
  const html = await readFile(new URL("../src/public/index.html", import.meta.url), "utf8");
  const summaryHtml = html.split('data-view-panel="summary"')[1]!.split('data-view-panel="activity"')[0]!;
  assert.deepEqual([...summaryHtml.matchAll(/class="kpi-label"[^>]*>([^<]+)</g)].map((match) => match[1]), [
    "Usage value", "Sessions analyzed", "Request input processed", "Output tokens", "Effective tools", "Compactions",
  ]);
  assert.equal(summary.querySelectorAll(".kicker").length, 0);
  for (const id of ["metric-live", "metric-live-note", "metric-repositories", "metric-repository-note"]) assert.equal(document.querySelector(`#${id}`), null);
  for (const title of ["Sessions by provider", "Usage value by model", "Sub-agent value", "Repositories"]) {
    assert.match(summaryHtml, new RegExp(`<h2[^>]*>${title}</h2>`), title);
  }
  assert.match(html, /id="activity-repositories-panel"[^]*?<h2>Sessions by repository<\/h2>/);
  assert.match(summaryHtml, /Explicit sub-agent evidence · lower bound/);
  assert.equal(document.querySelector("#metric-spend-note")!.textContent, "Activity-dated. Not an invoice.");
  assert.deepEqual([...summaryHtml.matchAll(/class="chart-note">([^<]+)</g)].map((match) => match[1]), [
    "Activity-dated. Not an invoice.", "Explicit sub-agent evidence · lower bound", "Activity-dated · each session counted once", "Activity-dated value · session-start counters",
  ]);
  const coverage = html.split('id="coverage-dialog"')[1]!.split("</dialog>")[0]!;
  assert.match(document.querySelector("#coverage-usage-note")!.textContent, /includes \$10.00 session-dated.*dated by last activity/);
  assert.match(coverage, /undated value, such as Cursor's provider-reported value/);
  assert.match(coverage, /rows add up to the Usage value KPI/);
  assert.match(coverage, /Other columns: sessions started in the window/);
  assert.match(coverage, /Request input includes repeated context/);
  assert.match(document.querySelector("#scope-description")!.textContent, /1 session · 1 Oct 2026 · Synthetic · Claude · \$10.00/);
});

test("snapshot status shows live counts after load and follows the selected window", async () => {
  const live = withLedger(sample(), [["synthetic", 10]]);
  live.transcript.snapshotWhileWorking = true;
  const { context, document, run } = await harness([live]);
  context["fetch"] = async () => ({ ok: true, json: async () => run("({...fixture, rateCard: {effectiveDate: '2026-10-01', models: []}})") });
  await run("loadSnapshot()");
  assert.equal(document.querySelector("#sync-label")!.textContent, "Local snapshot ready · 1 session in progress");
  assert.equal(document.querySelector("#rate-card-date")!.textContent, "Rate card effective 1 Oct 2026");
  run("windowPreset = 'custom'; elements.windowStart.value = elements.windowEnd.value = '2026-09-01'; renderView()");
  assert.equal(document.querySelector("#sync-label")!.textContent, "Local snapshot ready");
  run("elements.sync.dataset.state = 'loading'; elements.syncLabel.textContent = 'Refreshing…'; renderView()");
  assert.equal(document.querySelector("#sync-label")!.textContent, "Refreshing…");
  context["fetch"] = async () => ({ ok: true, json: async () => ({ kind: "shared", sources: [], minimumSessions: 5, summary: { sessions: 0 }, repositories: [] }) });
  await run("loadSnapshot()");
  assert.equal(document.querySelector("#sync-label")!.textContent, "Local snapshot ready", "shared aggregates cannot establish a live count");
});

test("a one-session window names its scope and offers Show 30d instead of charts", async () => {
  const session = withLedger(sample(), [["synthetic", 0.15]], { day: "2026-07-24" });
  session.createdAt = "2026-07-24T12:00:00Z"; session.repositoryName = "data-pipeline";
  const { document, run } = await harness([session], { repositories: [{ id: "synthetic", name: "data-pipeline" }], start: "2026-07-01", end: "2026-07-30" });
  run("populateRepositories(); windowPreset = 'custom'; setWindowInputs('2026-07-24', '2026-07-24'); renderView()");
  assert.equal(document.querySelector("#scope-description")!.textContent, "1 session · 24 Jul 2026 · data-pipeline · Claude · $0.15");
  const daily = document.querySelector("#daily-spend")!;
  assert.equal(daily.querySelector("svg"), null);
  assert.deepEqual(daily.querySelectorAll(".chart-legend-value").map((e) => e.textContent), ["$0.15"]);
  assert.match(daily.textContent, /Only 24 Jul has activity · widen the window for a trend/);
  const donut = document.querySelector("#provider-donut")!;
  assert.equal(donut.querySelector("svg"), null); assert.equal(donut.textContent.trim(), "1 session · Claude");
  assert.equal(document.querySelector("#provider-legend")!.hidden, true);
  assert.match(document.querySelector("#repository-subagent-spend")!.textContent, /No sub-agent sessions on 24 Jul 2026\./);
  daily.querySelector("button")!.listeners.get("click")!();
  assert.equal(run("windowPreset"), "30");
  assert.equal(document.querySelector("#window-start")!.value, "2026-07-01");
  assert.equal(document.querySelector("#window-end")!.value, "2026-07-30");
  assert.equal(document.querySelector("#metric-spend")!.textContent, "$0.15");
});

test("two active days use a legend while three restore the daily SVG and provider ring", async () => {
  const sessions = ["24", "25", "26"].map((day, index) => {
    const s = withLedger(sample(), [["synthetic", index + 1]], { day: `2026-07-${day}` });
    s.createdAt = `2026-07-${day}T12:00:00Z`; if (index === 2) s.provider = "codex";
    return s;
  });
  const { document, run } = await harness(sessions, { start: "2026-07-01", end: "2026-07-30" });
  run("windowPreset = 'custom'; setWindowInputs('2026-07-01', '2026-07-25'); renderView()");
  assert.equal(document.querySelector("#daily-spend")!.querySelector("svg"), null);
  assert.match(document.querySelector("#daily-spend")!.textContent, /Only 24 Jul and 25 Jul have activity/);
  assert.equal(document.querySelector("#metric-spend")!.textContent, "$3.00");
  run("setWindowInputs('2026-07-01', '2026-07-26'); renderView()");
  assert.ok(document.querySelector("#daily-spend")!.querySelector("svg"));
  assert.ok(document.querySelector("#provider-donut")!.querySelector("svg"));
  assert.equal(document.querySelector("#provider-legend")!.hidden, false);
  assert.equal(document.querySelector("#metric-spend")!.textContent, "$6.00");
});

test("unknown-start notes count only fallback dates in the selected window", async () => {
  const unknown = (date: string) => { const s = sample(); s.createdAt = date; s.transcript.startTimeKnown = false; return s; };
  const { document, run } = await harness([sample(), unknown("2026-07-24T22:30:00Z"), unknown("2026-07-24T23:30:00Z"), unknown("2026-08-24T12:00:00Z"), unknown("")], { start: "2026-07-01", end: "2026-10-03" });
  run("windowPreset = 'custom'; setWindowInputs('2026-07-24', '2026-07-24'); renderCoverageSummary(activeView())");
  assert.match(document.querySelector("#coverage-session-note")!.textContent, /1 unknown starts excluded/);
  run("setWindowInputs('2026-07-26', '2026-07-26'); renderCoverageSummary(activeView())");
  assert.doesNotMatch(document.querySelector("#coverage-session-note")!.textContent, /unknown starts/);
  run("windowPreset = 'all'; renderCoverageSummary(activeView())");
  assert.match(document.querySelector("#coverage-session-note")!.textContent, /4 unknown starts included/);
});

test("an earlier-started contributor keeps the fleet caption for a one-session window", async () => {
  const earlier = withLedger(sample(), [["synthetic", 100]], { day: "2026-07-24" });
  earlier.createdAt = "2026-07-10T12:00:00Z"; earlier.repositoryId = "other"; earlier.repositoryName = "other";
  const started = withLedger(sample(), [["synthetic", 2]], { day: "2026-07-24" });
  started.createdAt = "2026-07-24T12:00:00Z"; started.repositoryId = "synthetic"; started.repositoryName = "data-pipeline";
  const { document, run } = await harness([earlier, started], { repositories: [{ id: "synthetic", name: "data-pipeline" }, { id: "other", name: "other" }], start: "2026-07-01", end: "2026-07-30" });
  run("populateRepositories(); windowPreset = 'custom'; setWindowInputs('2026-07-24', '2026-07-24'); renderView()");
  const scope = document.querySelector("#scope-description")!.textContent;
  assert.doesNotMatch(scope, /^1 session ·/, "the $102 of activity is not one session's");
  assert.match(scope, /^2 repositories · 1 with sessions\./);
  assert.equal(document.querySelector("#metric-spend")!.textContent, "$102.00");
});


test("Summary, Velocity, Tools and Activity chips share registry labels, marks and order", async () => {
  const { providerIds, providerLabels } = await import("../src/public/providers.js");
  const sessions = providerIds.map((provider) => { const s = withLedger(sample(), [["synthetic", 1]]); s.provider = provider; return s; });
  const { document, run } = await harness(sessions);
  run("switchView('velocity'); renderViewProviderFilters(elements.toolsProviderFilters, 'tools'); renderViewProviderFilters(elements.activityProviderFilters, 'activity')");
  const rows = [document.querySelector("#daily-provider-filters")!, document.querySelector("#tools-provider-filters")!, document.querySelector("#activity-provider-filters")!, document.querySelector("#velocity-view")!.querySelector(".provider-key")!];
  for (const row of rows) {
    assert.deepEqual(row.querySelectorAll("label").map((label) => label.dataset["provider"]), providerIds, row.id || "velocity");
    assert.deepEqual(row.querySelectorAll("label").map((label) => label.children.at(-1)!.textContent), providerIds.map((id) => providerLabels[id]));
    assert.equal(row.querySelectorAll("label").every((label) => label.children.length === 3), true);
  }
  const summary = rows[0]!;
  assert.deepEqual(summary.querySelectorAll("input").map((input) => input.dataset["providerFilter"]), providerIds);
  assert.deepEqual(summary.querySelectorAll("input").map((input) => input.getAttribute("aria-label")), providerIds.map((id) => `${id === "unsupported" ? "Unsupported provider" : providerLabels[id]} daily usage`));
  assert.deepEqual(summary.querySelectorAll(".mark").map((mark) => mark.textContent), ["CP", "OC", "G", "AG", "?"]);
});


test("multi-machine ready status names sessions in progress and omits zero", async () => {
  const { document, run } = await harness([sample()]);
  run("fullSnapshot = {machines: [{state: 'ok'}, {state: 'ok'}]}; showReady({summary: {workingSnapshots: 3}})");
  assert.equal(document.querySelector("#sync-label")!.textContent, "2 of 2 machines ready · 3 sessions in progress");
  run("showReady({summary: {workingSnapshots: 0}})");
  assert.equal(document.querySelector("#sync-label")!.textContent, "2 of 2 machines ready");
});
