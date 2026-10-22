import assert from "node:assert/strict";
import test from "node:test";

import type { Element } from "./release-dom.ts";
import { harness, sample, withLedger } from "./validation/aggregation-ui-harness.ts";

function fixtures() {
  const known = withLedger(sample(), [["synthetic", 10]]);
  const other = withLedger(sample(), [["synthetic", 3]], { day: "2026-10-01", sessionDated: true });
  other.provider = "codex";
  other.repositoryId = "other";
  const unknown = sample();
  unknown.transcript.startTimeKnown = false;
  assert.ok(unknown.evidence);
  unknown.evidence.timing = "file-mtime";
  const retained = withLedger(sample(), [["synthetic", 2]]);
  retained.transcript.sourceDeleted = true;
  return [known, other, unknown, retained];
}

// Include DOM structure, text, accessibility attributes, classes, styles and live control state; omit event closures.
function dom(element: Element): unknown {
  return {
    tag: element.tagName, text: element.ownText, attributes: element.attributes, dataset: element.dataset,
    className: element.className, style: element.style, hidden: element.hidden, value: element.value,
    checked: element.checked, disabled: element.disabled, children: element.children.map(dom),
  };
}

const repositories = [{ id: "synthetic", name: "Synthetic" }, { id: "other", name: "Other" }];

test("cached dashboard models preserve snapshot JSON and rendered DOM/text through filters and navigation", async () => {
  const exercise = async (fresh: boolean) => {
    const { run, document } = await harness(fixtures(), { repositories });
    const snapshot = run("JSON.stringify(snapshot)");
    // The reference is the original model builder, without memoization.
    if (fresh) run("activeView = buildActiveView");
    run("resetExportMenu = () => {}; populateRepositories()");
    const states: string[] = [];
    const capture = () => {
      assert.equal(run("JSON.stringify(snapshot)"), snapshot);
      assert.equal(run("JSON.stringify(activeView())"), run("JSON.stringify(buildActiveView())"));
      states.push(JSON.stringify(dom(document.body)));
    };
    for (const action of [
      "switchView('activity')",
      "toggleProvider('claude')",
      "toggleProvider('codex')",
      "toggleProvider('claude')",
      "switchView('costs')",
      "switchView('tools')",
      "toggleProvider('claude')",
      "switchView('velocity')",
      "switchView('summary')",
      "toggleProvider('claude')",
      "elements.windowStart.value = '2026-10-01'; renderView()",
      "elements.repositoryFilter.value = 'other'; renderView()",
      "setWindowPreset('all'); renderView()",
      "elements.repositoryFilter.value = 'all'; switchView('activity')",
      "setWindowPreset('custom'); setWindowInputs('2026-10-02', '2026-10-03'); renderView()",
    ]) {
      run(action);
      capture();
    }
    // Also exercise the actual chip change closure (separate from keyboard provider shortcuts).
    run("setWindowPreset('all'); renderView()");
    const input = document.querySelector('#activity-provider-filters input')!;
    input.checked = !input.checked;
    input.listeners.get("change")!();
    capture();
    return states;
  };
  assert.deepEqual(await exercise(false), await exercise(true));
});

test("dashboard model reuse invalidates on every data and window input, including same-timestamp refreshes", async () => {
  const { run } = await harness(fixtures(), { repositories });
  run("populateRepositories(); globalThis.previous = activeView()");
  assert.equal(run("activeView() === previous"), true);
  run("viewProviderFilters.activity.clear(); viewProviderFilters.tools.clear()");
  assert.equal(run("activeView() === previous"), true);
  for (const change of [
    "elements.repositoryFilter.value = 'other'",
    "elements.windowStart.value = '2026-09-30'",
    "elements.windowEnd.value = '2026-10-01'",
    "setWindowPreset('all')",
    "setWindowPreset('30')",
    "elements.windowStart.value = ''; elements.windowStart.min = '2026-09-20'",
    "elements.windowEnd.value = ''; elements.windowEnd.max = '2026-10-02'",
    "snapshot = { ...snapshot, warnings: ['Session start time is unavailable.'] }",
    "sessionsByRepository = groupByRepository(snapshot.sessions)",
    "fullSnapshot = { ...snapshot, machines: [] }",
  ]) {
    run(change);
    assert.equal(run("activeView() === previous"), false, change);
    assert.equal(run("JSON.stringify(activeView())"), run("JSON.stringify(buildActiveView())"), change);
    run("previous = activeView()");
    assert.equal(run("activeView() === previous"), true, change);
  }
  // A machine selection replaces the projected snapshot and grouping, even if generatedAt stays the same.
  run("snapshot = { ...snapshot, sessions: [] }; sessionsByRepository = groupByRepository(snapshot.sessions)");
  assert.equal(run("activeView().summary.sessions"), 0);
  assert.equal(run("activeView() === previous"), false);
});

test("cached machine warnings keep the fresh builder's relative ages as time advances", async () => {
  const { run } = await harness(fixtures(), { repositories });
  run(`
    globalThis.clock = Date.parse('2026-10-03T12:00:35Z');
    const readMachineWarnings = machineWarnings;
    machineWarnings = (machines, warnings) => readMachineWarnings(machines, warnings, clock);
    fullSnapshot = { machines: [
      { label: 'Synthetic local', state: 'ok', readAt: '2026-10-03T12:00:35Z' },
      { label: 'Synthetic remote', state: 'stale', readAt: '2026-10-03T12:00:35Z' },
      { label: 'Synthetic reading', state: 'reading', readAt: '2026-10-03T12:00:35Z' }
    ] };
    globalThis.previous = activeView();
  `);
  assert.match(run("JSON.stringify(previous.warnings)"), /just now/);
  assert.equal(run("activeView() === previous"), true);
  // The boundary is relative to readAt, rather than the start of a wall-clock minute.
  run("clock += 120_000");
  assert.match(run("JSON.stringify(activeView().warnings)"), /2 min ago/);
  assert.equal(run("JSON.stringify(activeView())"), run("JSON.stringify(buildActiveView())"));
  assert.equal(run("activeView() === previous"), false);
});
