import assert from "node:assert/strict";
import test from "node:test";
import { machineView } from "../src/public/machines.js";
import { repositoryDisplaySnapshot } from "../src/public/view-model.js";
import { harness, sample, withLedger } from "./validation/aggregation-ui-harness.ts";

test("duplicate repository labels follow hashed IDs across usage order, refresh and filters without changing exports", async () => {
  const first = withLedger(sample(), [["synthetic", 1]]), second = withLedger(sample(), [["synthetic", 2]]);
  first.repositoryId = "repo-a"; second.repositoryId = "repo-b";
  first.repositoryName = second.repositoryName = "same-name";
  // Usage order and source order both differ from the stable ordinal order.
  const { run, document } = await harness([second, first], { repositories: [{ id: "repo-b", name: "same-name" }, { id: "repo-a", name: "same-name" }] });
  run("fixture.rateCard = { effectiveDate: '2026-10-01', models: [] }; render(fixture)");
  assert.deepEqual(Array.from(run("snapshot.repositories.map(({ repository }) => repository.name)")), ["same-name · 2", "same-name"]);
  assert.deepEqual(Array.from(run("snapshot.sessions.map(session => session.repositoryName)")), ["same-name · 2", "same-name"]);
  assert.equal(run("repositoryFromParameter('same-name').repository.id"), "repo-b", "plain names keep the original first-match behavior");
  assert.equal(run("repositoryFromParameter('repo-a').repository.name"), "same-name");
  assert.equal(run("repositoryFromParameter('repo-b').repository.name"), "same-name · 2");
  assert.equal(run("JSON.stringify(exportSelection().snapshot).includes('same-name · 2')"), false);
  run("wideLayout.matches = true; renderRepositoryNav(); renderPalette('same-name')");
  for (const id of ["repo-a", "repo-b"]) assert.equal(run(`document.querySelector('#repository-list [data-repository="${id}"]').title`), "another checkout with the same name");
  assert.match(document.querySelector("#command-list")!.textContent, /Focus same-name · 2/);
  assert.ok(document.querySelectorAll(".palette-option").every((option) => (option as unknown as { title: string }).title === "another checkout with the same name"));
  assert.match(document.querySelector("#repository-rows")!.textContent, /same-name · 2/);
  assert.match(document.querySelector("#repo-spend")?.textContent ?? run("elements.repositorySpend.textContent"), /same-name · 2/);
  run("fixture.repositories.reverse(); fixture.sessions.reverse(); render(fixture)");
  assert.equal(run("repositoryFromParameter('repo-b').repository.name"), "same-name · 2");
  assert.equal(run("fixture.repositories.every(({ repository }) => repository.name === 'same-name')"), true);
  const projected = run("snapshot");
  assert.equal(repositoryDisplaySnapshot(projected).repositories[0].repository.name, "same-name", "already projected labels are not suffixed again");
});


test("machine filtering keeps the ordinal assigned by the full snapshot", () => {
  const snapshot = repositoryDisplaySnapshot({
    repositories: [{ repository: { id: "a", name: "tmp" } }, { repository: { id: "b", name: "tmp" } }],
    sessions: [{ repositoryId: "a", repositoryName: "tmp", machine: "first" }, { repositoryId: "b", repositoryName: "tmp", machine: "second" }],
    machines: [{ key: "first" }, { key: "second" }],
  });
  const filtered = machineView(snapshot as unknown as Parameters<typeof machineView>[0], new Set(["second"]));
  assert.equal(filtered.repositories[0]!.repository.name, "tmp · 2");
  assert.equal(filtered.sessions[0]!.repositoryName, "tmp · 2");
});
