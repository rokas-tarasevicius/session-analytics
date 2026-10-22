import assert from "node:assert/strict";
import test from "node:test";
import { quietRepositories } from "../src/public/quiet-repositories.js";

const window = { start: "2026-10-12", end: "2026-10-18", timeZone: "UTC" };
const repository = (id: string, name = id) => ({ repository: { id, name } });
const cell = (day: string) => [day, 12, 0, Array(14).fill(0)];
const session = (repositoryId: string, createdAt: string | null, days: string[] = [], sessionDated: string[] = []) => ({
  repositoryId, createdAt,
  velocity: { buckets: days.map(cell), sessionDated: sessionDated.map(cell), undated: [], dimensions: [{}] },
});

test("quiet repositories require earlier evidence and no evidence on either inclusive window boundary", () => {
  const repositories = ["quiet", "start", "end", "future", "empty"].map((id) => repository(id));
  const sessions = [
    session("quiet", "2026-10-01T12:00:00Z", ["2026-10-11"]),
    session("start", "2026-10-01T12:00:00Z", [window.start]),
    session("end", "2026-10-01T12:00:00Z", [window.end]),
    session("future", "2026-10-19T12:00:00Z", ["2026-10-20"]),
  ];
  assert.deepEqual(quietRepositories(repositories, sessions, window), [
    { id: "quiet", name: "quiet", lastActiveDay: "2026-10-11" },
  ]);
});

test("last active day merges sessions and session-dated cells without leaking future dates or requiring priced value", () => {
  const sessions = [
    session("quiet", "2026-10-02T12:00:00Z", ["2026-10-03", "2026-10-20"], ["2026-10-09"]),
    session("quiet", "2026-10-10T12:00:00Z"),
    session("session-dated", "2026-10-01T12:00:00Z", [], ["2026-10-14"]),
  ];
  assert.deepEqual(quietRepositories([repository("quiet"), repository("session-dated")], sessions, window), [
    { id: "quiet", name: "quiet", lastActiveDay: "2026-10-10" },
  ]);
});

test("known starts use the snapshot timezone, including daylight-saving calendar boundaries", () => {
  const sessions = [session("london", "2026-10-11T23:30:00Z")];
  assert.equal(quietRepositories([repository("london")], sessions, window).length, 1);
  assert.equal(quietRepositories([repository("london")], sessions, { ...window, timeZone: "Europe/London" }).length, 0);
  const autumn = { start: "2026-10-26", end: "2026-10-26", timeZone: "Europe/London" };
  assert.equal(quietRepositories([repository("london")], [session("london", "2026-10-25T23:30:00Z")], autumn)[0]?.lastActiveDay, "2026-10-25");
});

test("unknown starts, file mtimes and undated activity cannot establish an active day", () => {
  const sessions = [
    { ...session("unknown", "2026-10-01T12:00:00Z"), transcript: { startTimeKnown: false } },
    { ...session("mtime", "2026-10-01T12:00:00Z"), evidence: { timing: "file-mtime" } },
    { repositoryId: "undated", createdAt: null, velocity: { buckets: [], undated: [[0, [99]]] } },
    session("invalid", "not a timestamp", ["2026-02-30", "not a day"]),
    { repositoryId: "ledgerless", createdAt: "2026-10-01T12:00:00Z" },
  ];
  const rows = quietRepositories(sessions.map((s) => repository(s.repositoryId)), sessions, window);
  assert.deepEqual(rows, [{ id: "ledgerless", name: "ledgerless", lastActiveDay: "2026-10-01" }]);
});

test("rows follow repository scope, sort by most recent activity, and project only existing public fields", () => {
  const repositories = [repository("z", "Same"), repository("a", "Same"), repository("older"), repository("out-of-scope")];
  const sessions = [session("z", null, ["2026-10-11"]), session("a", null, ["2026-10-11"]), session("older", null, ["2026-10-09"])];
  const unsafe = { ...repository("z", "Same"), privatePath: "/PRIVATE-SENTINEL", repository: { id: "z", name: "Same", rawId: "RAW-SENTINEL" } };
  const before = JSON.stringify(sessions);
  const rows = quietRepositories([unsafe, ...repositories.slice(1)], sessions, window);
  assert.deepEqual(rows.map((row) => row.id), ["a", "z", "older"]);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE-SENTINEL|RAW-SENTINEL/);
  assert.equal(JSON.stringify(sessions), before);
  assert.deepEqual(quietRepositories([repository("a")], sessions, window), [{ id: "a", name: "a", lastActiveDay: "2026-10-11" }]);
});

test("empty, invalid and reversed windows have no quiet repositories", () => {
  const repositories = [repository("quiet")], sessions = [session("quiet", null, ["2026-10-01"])];
  for (const dates of [{ start: "", end: window.end }, { start: "2026-02-30", end: window.end }, { start: window.end, end: window.start }]) {
    assert.deepEqual(quietRepositories(repositories, sessions, dates), []);
  }
  assert.deepEqual(quietRepositories(repositories, [], window), []);
});

test("Summary lists last observed dates, focuses with a button and clears rows for all history", async () => {
  const { harness, sample, withLedger } = await import("./validation/aggregation-ui-harness.ts");
  const quiet = withLedger(sample(), [["synthetic", 0]], { day: "2026-10-10" });
  quiet.createdAt = "2026-10-01T12:00:00Z";
  const active = withLedger(sample(), [["synthetic", 2]], { day: "2026-10-12" });
  active.repositoryId = "active"; active.repositoryName = "Active";
  const { document, run } = await harness([quiet, active], {
    repositories: [{ id: "synthetic", name: "Synthetic" }, { id: "active", name: "Active" }],
    start: "2026-10-01", end: "2026-10-18",
  });
  run("populateRepositories(); windowPreset = 'custom'; setWindowInputs('2026-10-12', '2026-10-18'); renderView()");
  const panel = document.querySelector("#quiet-repositories")!;
  const list = document.querySelector("#quiet-repository-list")!;
  assert.equal(panel.hidden, false);
  assert.equal(document.querySelector("#quiet-repository-count")!.textContent, "1 quiet");
  const button = list.querySelector("button")!;
  assert.match(button.textContent, /Synthetic.*Last observed 10 Oct 2026/);
  assert.match(button.getAttribute("aria-label")!, /Focus Synthetic/);
  assert.equal(button.dataset.focusKey, "quiet:synthetic");
  button.listeners.get("click")!();
  assert.equal(run("elements.repositoryFilter.value"), "synthetic");
  assert.equal(document.querySelector('[data-view-panel="summary"]')!.hidden, true, "charts use the existing empty state");
  assert.equal(panel.hidden, false, "quiet repository details remain available in an empty window");
  run("windowPreset = 'all'; renderView()");
  assert.equal(panel.hidden, true); assert.equal(list.children.length, 0);
  run("windowPreset = 'custom'; setWindowInputs('2026-10-10', '2026-10-18'); renderView()");
  assert.equal(panel.hidden, true, "no matches does not add an empty panel to Summary");
  assert.equal(list.querySelector("button"), null);
  run("setWindowInputs('2026-10-12', '2026-10-18'); switchView('velocity')");
  assert.equal(panel.hidden, true, "other views hide the Summary insight");
  run("selectRepository('all', { scroll: false }); setWindowInputs('2026-10-15', '2026-10-18'); switchView('summary')");
  assert.equal(document.querySelector('[data-view-panel="summary"]')!.hidden, true);
  assert.equal(panel.hidden, false, "an entirely empty window still lists previously active repositories");
  assert.equal(list.querySelectorAll("button").length, 2);
});
