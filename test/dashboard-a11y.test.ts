import assert from "node:assert/strict";
import test from "node:test";
import { Element } from "./release-dom.ts";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

test("fleet rows expose a native repository button and select once when its click bubbles", async () => {
  const { context, document, run } = await harness([sample()]);
  const selections: string[] = [];
  context["selectRepository"] = (id: string) => selections.push(id);
  run('elements.repositoryFilter.value = "synthetic"; renderRepositoryTable(activeView().repositories)');
  const row = document.querySelector("#repository-rows")!.children[0]!;
  const cell = row.children[0]!;
  const button = cell.querySelector("button.row-link")!;
  assert.ok(button);
  assert.equal(button.type, "button");
  assert.equal(button.textContent, "Synthetic");
  assert.equal(button.dataset["focusKey"], "table:synthetic");
  assert.equal(cell.querySelector("small"), null);
  assert.match((button as any).title, /^Synthetic · ID [a-z0-9]{8}$/i);
  assert.equal(button.getAttribute("aria-label"), (button as any).title);
  assert.equal(row.getAttribute("role"), null);
  assert.equal(row.getAttribute("tabindex"), null);
  assert.equal("tabIndex" in row, false);
  assert.match(row.getAttribute("aria-label")!, /^Synthetic · ID [a-z0-9]{8} · 1 session · .*top-level/i);
  assert.equal(row.dataset["focusKey"], undefined);
  assert.equal(row.dataset["rowLink"], "true");
  assert.equal(row.listeners.has("keydown"), false);
  assert.equal(row.getAttribute("aria-current"), "true");
  assert.equal(button.getAttribute("aria-current"), "true");
  button.listeners.get("click")!({ target: button });
  row.listeners.get("click")!({ target: button });
  assert.deepEqual(selections, ["synthetic"]);
  row.listeners.get("click")!({ target: cell });
  assert.deepEqual(selections, ["synthetic", "synthetic"]);
  run('elements.repositoryFilter.value = "all"; renderRepositoryTable(activeView().repositories)');
  const unselected = document.querySelector("#repository-rows")!.children[0]!;
  assert.equal(unselected.getAttribute("aria-current"), null);
  assert.equal(unselected.querySelector("button.row-link")!.getAttribute("aria-current"), null);
});

test("coverage fractions retain their screen-reader sentence without a hover tooltip", async () => {
  const { run } = await harness([]);
  const badge = run('coverageBadge({eligible:1,selected:2}, "token evidence")') as Element;
  assert.equal(badge.tagName, "small");
  assert.equal(badge.className, "coverage");
  assert.equal(badge.getAttribute("aria-label"), null);
  assert.equal(badge.getAttribute("title"), null);
  assert.equal(badge.children.length, 2);
  assert.equal(badge.children[0]!.tagName, "span");
  assert.equal(badge.children[0]!.textContent, "1/2");
  assert.equal(badge.children[0]!.getAttribute("aria-hidden"), "true");
  assert.equal(badge.querySelector("span.sr-only")!.textContent, "1 of 2 selected sessions provide token evidence");
  assert.equal(run('coverageBadge({eligible:2,selected:2}, "token evidence")'), null);
  assert.equal(run('coverageBadge({eligible:0,selected:0}, "token evidence")'), null);
});

test("selectable bar names include formatted values and only the coverage that is displayed", async () => {
  const { context, run } = await harness([]);
  const container = new Element(); context["container"] = container;
  const selections: string[] = [];
  context["onSelect"] = (item: { name: string }) => selections.push(item.name);
  for (const [coverage, what, description] of [
    [null, null, "$10.00"],
    [{ eligible: 1, selected: 2 }, "priced value", "$10.00, 1 of 2 selected sessions provide priced value"],
    [{ eligible: 1, selected: 2 }, null, "$10.00, 1 of 2 selected sessions provide evidence"],
    [{ eligible: 0, selected: 2 }, "priced value", "not available, 0 of 2 selected sessions provide priced value"],
    [{ eligible: 2, selected: 2 }, "priced value", "$10.00"],
    [{ eligible: 0, selected: 0 }, "priced value", "not available"],
  ] as const) {
    context["items"] = [{ name: "Synthetic", value: 10, coverage, what }];
    run("renderBars(container, items, money, 9, onSelect)");
    const button = container.querySelector("button.bar-row.repository-link")!;
    assert.equal(button.getAttribute("aria-label"), `Synthetic, ${description}. Focus this repository`);
    button.listeners.get("click")!();
  }
  assert.deepEqual(selections, Array(6).fill("Synthetic"));
  run("renderBars(container, items, money)");
  assert.equal(container.children[0]!.tagName, "div");
  assert.equal(container.children[0]!.getAttribute("aria-label"), null);
});

test("coverage and repository scope names retain their visible labels as state changes", async () => {
  const { document, run } = await harness([sample()]);
  const coverage = document.querySelector("#coverage-button")!;
  for (const count of [2, 1, 0]) {
    run(`renderWarnings(${JSON.stringify(Array(count).fill("Coverage note"))})`);
    assert.equal(coverage.getAttribute("aria-label"), `Coverage: ${count} notes`);
    assert.equal(document.querySelector("#coverage-label")!.textContent, count ? `Coverage · ${count}` : "Coverage");
    assert.equal(coverage.getAttribute("title"), "Data coverage");
  }
  const scope = document.querySelector("#scope-chip")!;
  run('elements.repositoryFilter.value = "synthetic"; renderSharedView(activeView())');
  assert.equal(scope.getAttribute("aria-label"), "Synthetic: clear repository focus");
  assert.equal(document.querySelector("#scope-chip-label")!.textContent, "Synthetic");
  assert.equal(scope.hidden, false);
  run('elements.repositoryFilter.value = "all"; renderSharedView(activeView())');
  assert.equal(scope.getAttribute("aria-label"), "Clear repository focus");
  assert.equal(scope.hidden, true);
});
