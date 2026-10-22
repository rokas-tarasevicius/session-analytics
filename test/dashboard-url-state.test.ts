import assert from "node:assert/strict";
import test from "node:test";
import { parseUrlState, serializeUrlState } from "../src/public/url-state.js";
import { shortcutRegistry } from "../src/public/shortcuts.js";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

const views = shortcutRegistry.filter((item) => item.action === "view").map((item) => item.bindings[0]!.value!);
const options = { views, presets: ["7", "30", "90", "all", "custom"] };

test("every registered view round-trips URL window, repository and provider state", () => {
  for (const view of views) for (const window of options.presets) for (const providers of [null, [], ["codex", "claude"]]) {
    const state = { view, window, start: window === "custom" ? "2026-09-01" : null, end: window === "custom" ? "2026-09-30" : null, repo: "synthetic-repository", providers };
    const parsed = parseUrlState(serializeUrlState(state, "?theme=dark&density=comfortable&open=help&keep=1"), options);
    assert.deepEqual({ view: parsed.view, window: parsed.window ?? "30", start: parsed.start, end: parsed.end, repo: parsed.repo, providers: parsed.providers }, state);
    assert.equal(parsed.theme, null); assert.equal(parsed.density, null); assert.equal(parsed.open, null);
    assert.match(serializeUrlState(state, "?keep=1"), /keep=1/);
  }
});

test("unknown provider links fall back safely and mixed lists keep only registered providers", () => {
  assert.equal(parseUrlState("?providers=missing", options).providers, null);
  assert.deepEqual(parseUrlState("?providers=missing,codex,codex", options).providers, ["codex"]);
  assert.deepEqual(parseUrlState("?providers=none", options).providers, []);
  assert.equal(parseUrlState("?view=unknown&window=unknown", options).view, null);
});

test("history restoration degrades an unknown repository and providers to the complete view", async () => {
  const { context, run } = await harness([sample()]);
  Object.assign(context["window"], { location: { search: "?view=tools&repo=missing&providers=missing" } });
  run("resetExportMenu = () => {}; populateRepositories(); urlReady = true; restoreUrlState()");
  assert.equal(run("currentViewName()"), "tools");
  assert.equal(run("elements.repositoryFilter.value"), "all");
  assert.equal(run("viewProviderFilters.tools.has('claude')"), true);
});
