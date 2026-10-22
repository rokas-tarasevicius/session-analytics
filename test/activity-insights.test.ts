import assert from "node:assert/strict";
import test from "node:test";
import { activityInsights } from "../src/public/activity-insights.js";
import { sessionsInRange } from "../src/public/view-model.js";

const start = (createdAt: string | null) => ({ createdAt });

test("start-day streaks count distinct consecutive calendar dates, not sessions or elapsed work", () => {
  const sessions = ["2026-10-19T09:00:00Z", "2026-10-19T09:30:00Z", "2026-10-19T17:00:00Z", "2026-10-20T09:00:00Z", "2026-10-21T17:00:00Z", "2026-10-23T17:00:00Z"].map(start);
  assert.deepEqual(activityInsights(sessions.reverse()), {
    activeDays: 4, longestStreak: 3,
    busiestHour: { starts: 3, indexes: [9, 17] },
    busiestWeekday: { starts: 3, indexes: [0] },
  });
});

test("all peak ties are retained in clock-hour and Monday-first order", () => {
  assert.deepEqual(activityInsights([start("2026-10-20T23:00:00Z"), start("2026-10-19T00:00:00Z")]), {
    activeDays: 2, longestStreak: 2,
    busiestHour: { starts: 1, indexes: [0, 23] },
    busiestWeekday: { starts: 1, indexes: [0, 1] },
  });
});

test("missing timing evidence has no streak or peak, rather than a measured zero", () => {
  for (const sessions of [[], [start(null), start("invalid"), start("2026-02-30T09:00:00Z")]]) {
    assert.deepEqual(activityInsights(sessions), { activeDays: 0, longestStreak: null, busiestHour: null, busiestWeekday: null });
  }
});

test("unknown and file-mtime starts cannot bridge a streak or create peaks", () => {
  const sessions = [start("2026-10-19T09:00:00Z"), start("2026-10-21T09:00:00Z"),
    { ...start("2026-10-20T09:00:00Z"), transcript: { startTimeKnown: false } },
    { ...start("2026-10-20T09:00:00Z"), evidence: { timing: "file-mtime" } }];
  assert.deepEqual(activityInsights(sessions), {
    activeDays: 2, longestStreak: 1,
    busiestHour: { starts: 2, indexes: [9] }, busiestWeekday: { starts: 1, indexes: [0, 2] },
  });
});

test("timezone conversion changes dates, hours and weekdays together", () => {
  const sessions = [start("2026-10-18T23:30:00Z"), start("2026-10-19T00:30:00Z")];
  assert.equal(activityInsights(sessions, "UTC").activeDays, 2);
  assert.deepEqual(activityInsights(sessions, "Europe/London"), {
    activeDays: 1, longestStreak: 1,
    busiestHour: { starts: 1, indexes: [0, 1] }, busiestWeekday: { starts: 2, indexes: [0] },
  });
  assert.deepEqual(activityInsights(sessions, "America/New_York"), {
    activeDays: 1, longestStreak: 1,
    busiestHour: { starts: 1, indexes: [19, 20] }, busiestWeekday: { starts: 2, indexes: [6] },
  });
});

test("calendar streaks cross both daylight-saving transitions and year boundaries", () => {
  for (const dates of [["2026-03-28", "2026-03-29", "2026-03-30"], ["2026-10-24", "2026-10-25", "2026-10-26"], ["2025-12-31", "2026-01-01", "2026-01-02"]]) {
    assert.equal(activityInsights(dates.map((day) => start(`${day}T12:00:00Z`)), "Europe/London").longestStreak, 3);
  }
});

test("window clipping never extends a streak with starts outside the selected local dates", () => {
  const sessions = [18, 19, 20, 21, 22].map((day) => start(`2026-10-${day}T23:30:00Z`));
  const selected = sessionsInRange(sessions, "2026-10-20", "2026-10-21", "Europe/London");
  assert.equal(activityInsights(selected, "Europe/London").longestStreak, 2);
  assert.equal(activityInsights(sessions, "Europe/London").longestStreak, 5);
});

test("repeated local hours count starts without duplicating the active calendar day", () => {
  const result = activityInsights([start("2026-10-25T00:30:00Z"), start("2026-10-25T01:30:00Z")], "Europe/London");
  assert.equal(result.activeDays, 1);
  assert.deepEqual(result.busiestHour, { starts: 2, indexes: [1] });
});

test("insights preserve inputs and project only numeric timing aggregates", () => {
  const sessions = [{ ...start("2026-10-19T09:00:00Z"), content: "PRIVATE_CONTENT_SENTINEL", path: "/PRIVATE_PATH_SENTINEL", id: "PRIVATE_ID_SENTINEL" }];
  const before = JSON.stringify(sessions);
  const result = activityInsights(sessions);
  assert.equal(JSON.stringify(sessions), before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_.*SENTINEL/);
});
