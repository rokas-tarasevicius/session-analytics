import assert from "node:assert/strict";
import test from "node:test";
import { providerIds } from "../src/public/providers.js";
import { parseUrlState, serializeUrlState } from "../src/public/url-state.js";
import { harness, sample, withLedger } from "./validation/aggregation-ui-harness.ts";

const views = ["summary", "velocity", "costs", "pricing", "subscription", "tools", "activity"];
const presets = ["7", "30", "90", "all", "custom"];

// Regression: provider selections were missing from URLs and disappeared on reload/Back.
// Found by /qa on 2026-10-20; evidence: the red/green run of this file.
test("URL state round-trips every provider subset with every view, window and focus", () => {
  for (let mask = 0; mask < 2 ** providerIds.length; mask++) {
    const providers = providerIds.filter((_, index) => mask & 2 ** index);
    for (const view of views) for (const window of presets) for (const repo of [null, "opaque-synthetic"]) {
      const state = { view, window, start: window === "custom" ? "2026-10-01" : null, end: window === "custom" ? "2026-10-02" : null, repo, providers };
      const parsed = parseUrlState(serializeUrlState(state), { views, presets });
      assert.deepEqual(parsed.providers, providers);
      assert.equal(parsed.view, view); assert.equal(parsed.window ?? "30", window); assert.equal(parsed.repo, repo);
      assert.equal(parsed.start, state.start); assert.equal(parsed.end, state.end);
    }
  }
  assert.equal(parseUrlState("?providers=/synthetic-private-path", { views, presets }).providers, null);
  assert.deepEqual(parseUrlState("?providers=claude,claude,codex", { views, presets }).providers, ["codex", "claude"]);
});

function browserHistory(context: Record<string, any>, search = "?view=summary") {
  const location = { pathname: "/", search, hash: "#main" };
  const entries: string[] = [];
  const record = (_state: unknown, _title: string, url: string) => {
    entries.push(url);
    location.search = url.slice(url.indexOf("?"), url.indexOf("#") < 0 ? undefined : url.indexOf("#"));
  };
  Object.assign(context["window"], { location, history: { pushState: record, replaceState: record } });
  return { location, entries };
}

test("provider toggles in every filtered view write history, restore on Back and apply URL filters", async () => {
  for (const view of ["summary", "velocity", "tools", "activity"]) {
    const claude = withLedger(sample(), [["synthetic", 1]]), codex = withLedger(sample(), [["synthetic", 2]]); codex.provider = "codex";
    const { context, document, run } = await harness([claude, codex]);
    const { location, entries } = browserHistory(context);
    run(`fixture.rateCard = { effectiveDate: '2026-10-01', models: [] }; render(fixture); switchView('${view}');`);
    const before = location.search;
    const selector = view === "summary" ? '[data-provider-filter="codex"]' : view === "velocity" ? '#velocity-view .provider-key [data-provider="codex"] input' : `[data-focus-key="filter:${view}:codex"]`;
    const chip = document.querySelector(selector)!;
    chip.checked = false; chip.listeners.get("change")!();
    assert.equal(new URLSearchParams(location.search).get("providers"), "claude", view);
    assert.ok(entries.at(-1)!.endsWith("#main"));
    location.search = before; run("restoreUrlState()");
    assert.equal(run("providerShown(providerScope(), 'codex')"), true, `${view}: Back`);
    location.search = `?view=${view}&providers=none`;
    run("restoreUrlState()");
    assert.equal(run("providerShown(providerScope(), 'codex')"), false);
    assert.equal(run("providerShown(providerScope(), 'claude')"), false);
    assert.doesNotThrow(() => run("openPalette()"));
    assert.match(document.querySelector("#command-list")!.textContent, /Show Codex/);
  }
});

test("refresh removes vanished repository focus and clamps custom dates in the URL", async () => {
  const { context, run } = await harness([withLedger(sample(), [["synthetic", 1]])]);
  const { location } = browserHistory(context);
  run("fixture.rateCard = { effectiveDate: '2026-10-01', models: [] }; render(fixture); selectRepository('synthetic', { scroll: false }); applyWindowPreset('custom', { render: false }); applyCustomRange('2026-09-30', '2026-10-01')");
  assert.equal(new URLSearchParams(location.search).get("repo"), "synthetic");
  run("render({ ...fixture, repositories: [], sessions: [] })");
  assert.equal(run("selectedRepository()"), null);
  const parameters = new URLSearchParams(location.search);
  assert.equal(parameters.has("repo"), false);
  assert.equal(parameters.get("start"), "2026-10-03");
  assert.equal(parameters.get("end"), "2026-10-03");
});
