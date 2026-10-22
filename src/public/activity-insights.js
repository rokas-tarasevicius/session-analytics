import { activityGrid, sessionStartDay } from "./view-model.js";
import { shiftDay } from "./velocity-data.js";

/** All tied positive peaks, in clock-hour or Monday-first order; no evidence has no winner. */
function peak(values) {
  const starts = Math.max(0, ...values);
  return starts ? { starts, indexes: values.flatMap((value, index) => value === starts ? [index] : []) } : null;
}

/** Session-start rhythm for an already filtered selection, using the heatmap's timing evidence. */
export function activityInsights(sessions, timeZone = "UTC") {
  const { grid } = activityGrid(sessions, timeZone);
  const days = [...new Set(sessions.map((session) => sessionStartDay(session, timeZone)).filter((day) => day !== null))].sort();
  let longestStreak = 0, streak = 0, previous = null;
  for (const day of days) {
    streak = previous !== null && shiftDay(previous, 1) === day ? streak + 1 : 1;
    longestStreak = Math.max(longestStreak, streak);
    previous = day;
  }
  return {
    activeDays: days.length,
    longestStreak: days.length ? longestStreak : null,
    busiestHour: peak(Array.from({ length: 24 }, (_, hour) => grid.reduce((total, row) => total + row[hour], 0))),
    busiestWeekday: peak(grid.map((row) => row.reduce((total, starts) => total + starts, 0))),
  };
}
