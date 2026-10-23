import type { SessionLike } from "./view-model.js";

export interface ActivityPeak {
  starts: number;
  /** All tied indexes, ascending; weekday indexes start at Monday. */
  indexes: number[];
}
export interface ActivityInsights {
  activeDays: number;
  /** Consecutive calendar dates with known starts inside the supplied selection; null without evidence. */
  longestStreak: number | null;
  busiestHour: ActivityPeak | null;
  busiestWeekday: ActivityPeak | null;
}
export function activityInsights(sessions: SessionLike[], timeZone?: string): ActivityInsights;
