import assert from "node:assert/strict";
import test from "node:test";
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
  assert.deepEqual(values(), ["3 days", "09:00–09:59", "Monday"]);
  assert.match(insights.textContent, /2 hours tied/);
  assert.match(insights.textContent, /Tied: 09:00–09:59, 17:00–17:59/);
  run("elements.repositoryFilter.value = 'synthetic'; renderView()");
  assert.doesNotMatch(insights.textContent, /2 hours tied/);
  assert.match(insights.textContent, /3 weekdays tied/);
  run("viewProviderFilters.activity = new Set(['claude']); renderActivity(activeView())");
  assert.deepEqual(values(), ["1 day", "09:00–09:59", "Monday"]);
  assert.match(insights.textContent, /2 active days in this window/);
  run("elements.windowStart.value = elements.windowEnd.value = '2026-09-30'; renderActivity(activeView())");
  assert.deepEqual(values(), ["1 day", "17:00–17:59", "Wednesday"]);
  assert.match(insights.textContent, /1 active day in this window/);
});

test("Activity clears and hides insights when all providers are switched off", async () => {
  const { document, run } = await harness([sample()]);
  run("switchView('activity')");
  const insights = document.querySelector("#activity-insights")!;
  assert.equal(insights.children.length, 3);
  run("viewProviderFilters.activity.clear(); renderActivity(activeView())");
  assert.equal(insights.hidden, true);
  assert.equal(insights.children.length, 0);
  assert.match(document.querySelector("#activity-status")!.textContent, /No providers selected/);
});

test("Activity has no zero-day streak or arbitrary winner without known provider starts", async () => {
  const session = sample(); session.transcript.startTimeKnown = false;
  const { document, run } = await harness([session]);
  run("elements.windowStart.value = elements.windowEnd.value = ''; renderActivity(activeView())");
  assert.equal(document.querySelector("#activity-insights")!.hidden, true);
  assert.equal(document.querySelector("#activity-insights")!.children.length, 0);
  assert.match(document.querySelector("#activity-status")!.textContent, /No known session starts/);
});
