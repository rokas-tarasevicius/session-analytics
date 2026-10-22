import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

test("Activity insights follow repository, provider and window selection and label every tie", async () => {
  const sessions = ["2026-09-28T09:00:00Z", "2026-09-29T09:00:00Z", "2026-09-30T17:00:00Z", "2026-09-28T17:00:00Z"].map((createdAt, index) => {
    const session = sample(); session.createdAt = createdAt;
    if (index === 1) session.provider = "codex";
    if (index === 3) { session.repositoryId = "other"; session.repositoryName = "Other"; }
    return session;
  });
  const { document, run } = await harness(sessions, { timeZone: "UTC", repositories: [{ id: "synthetic", name: "Synthetic" }, { id: "other", name: "Other" }] });
  run("switchView('activity')");
  const insights = document.querySelector("#activity-insights")!;
  const values = () => insights.querySelectorAll("strong").map((element) => element.textContent);
  assert.equal(insights.hidden, false);
  assert.equal(document.querySelector("#activity-insights-note")!.hidden, false);
  assert.match(readFileSync(new URL("../src/public/index.html", import.meta.url), "utf8"), /id="activity-insights-note" hidden>Known session-start dates; not continuous work or a current streak/);
  assert.match(readFileSync(new URL("../src/public/index.html", import.meta.url), "utf8"), /Activity streaks count known session-start dates in the selected window, not continuous work or a current streak/);
  assert.deepEqual(values(), ["3 days", "09:00–09:59", "Monday"]);
  assert.match(insights.textContent, /2 hours tied/);
  assert.match(insights.textContent, /Tied: 09:00–09:59, 17:00–17:59/);
  run("elements.repositoryFilter.value = 'synthetic'; renderView()");
  assert.doesNotMatch(insights.textContent, /2 hours tied/);
  assert.match(insights.textContent, /3 weekdays tied/);
  run("viewProviderFilters.activity = new Set(['claude']); renderActivity(activeView())");
  assert.deepEqual(values(), ["1 day", "09:00–09:59", "Monday"]);
  assert.match(insights.textContent, /2 active days/);
  run("elements.windowStart.value = elements.windowEnd.value = '2026-09-30'; renderActivity(activeView())");
  assert.deepEqual(values(), ["1 day", "17:00–17:59", "Wednesday"]);
  assert.match(insights.textContent, /1 active day/);
});

test("Activity clears and hides insights when all providers are switched off", async () => {
  const { document, run } = await harness([sample()]);
  run("switchView('activity')");
  const insights = document.querySelector("#activity-insights")!;
  assert.equal(insights.children.length, 3);
  run("viewProviderFilters.activity.clear(); renderActivity(activeView())");
  assert.equal(insights.hidden, true);
  assert.equal(document.querySelector("#activity-insights-note")!.hidden, true);
  assert.equal(insights.children.length, 0);
  assert.match(document.querySelector("#activity-status")!.textContent, /No providers selected/);
});

test("Activity has no zero-day streak or arbitrary winner without known provider starts", async () => {
  const session = sample(); session.transcript.startTimeKnown = false;
  const { document, run } = await harness([session]);
  run("elements.windowStart.value = elements.windowEnd.value = ''; renderActivity(activeView())");
  assert.equal(document.querySelector("#activity-insights")!.hidden, true);
  assert.equal(document.querySelector("#activity-insights-note")!.hidden, true);
  assert.equal(document.querySelector("#activity-insights")!.children.length, 0);
  assert.match(document.querySelector("#activity-status")!.textContent, /No known session starts/);
});

test("Activity KPIs and both peak tie sets follow the machine toggle", async () => {
  const sessions = ["2026-09-28T09:00:00Z", "2026-09-29T17:00:00Z", "2026-09-30T17:00:00Z"].map((createdAt, index) => {
    const session = sample(); session.createdAt = createdAt;
    session.machine = index === 1 ? "remote" : "local";
    session.sessionKey = String(index).padStart(12, "0");
    return session;
  });
  const { document, run } = await harness(sessions, { timeZone: "UTC" });
  run(`fixture.rateCard = { effectiveDate: '2026-10-01', models: [] }; fixture.machines = [
    { key: 'local', label: 'laptop', state: 'ok', sessions: 2, repositories: 1 },
    { key: 'remote', label: 'server', state: 'ok', sessions: 1, repositories: 1 }
  ]; render(fixture); switchView('activity')`);
  const insights = document.querySelector("#activity-insights")!;
  const values = () => insights.querySelectorAll("strong").map((element) => element.textContent);
  assert.deepEqual(values(), ["3 days", "17:00–17:59", "Monday"]);
  assert.match(insights.textContent, /3 active days/);
  assert.match(insights.textContent, /3 weekdays tied/);
  assert.match(insights.textContent, /Tied: Monday, Tuesday, Wednesday/);
  run("setMachine('remote', false)");
  assert.deepEqual(values(), ["1 day", "09:00–09:59", "Monday"]);
  assert.match(insights.textContent, /2 active days/);
  assert.match(insights.textContent, /2 weekdays tied/);
  assert.match(insights.textContent, /Tied: Monday, Wednesday/);
  assert.match(insights.textContent, /2 hours tied/);
  assert.match(insights.textContent, /Tied: 09:00–09:59, 17:00–17:59/);
  assert.doesNotMatch(insights.textContent, /Tuesday/);
  // A single machine can also be selected, and restoring both restores their peaks.
  run("setMachine('local', false); setMachine('remote', true)");
  assert.deepEqual(values(), ["1 day", "17:00–17:59", "Tuesday"]);
  run("setMachine('local', true)");
  assert.deepEqual(values(), ["3 days", "17:00–17:59", "Monday"]);
  assert.match(insights.textContent, /3 active days/);
});

test("no start today leaves the historical longest streak intact before and after day end", async () => {
  const sessions = [28, 29, 30].map((day) => {
    const session = sample(); session.createdAt = `2026-09-${day}T09:00:00Z`; return session;
  });
  const { document, run } = await harness(sessions, { timeZone: "UTC", generatedAt: "2026-10-01T12:00:00Z", end: "2026-10-01" });
  run("switchView('activity')");
  const insights = document.querySelector("#activity-insights")!;
  const assertHistoricalRun = () => {
    assert.equal(insights.querySelector("strong")!.textContent, "3 days");
    assert.match(insights.textContent, /3 active days/);
    assert.equal(document.querySelector("#activity-insights-note")!.hidden, false);
  };
  assertHistoricalRun();
  run("fixture.rateCard = { effectiveDate: '2026-10-01', models: [] }; fixture.generatedAt = '2026-10-02T00:01:00Z'; render(fixture)");
  assertHistoricalRun();
});
