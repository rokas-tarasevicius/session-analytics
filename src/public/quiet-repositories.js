import { ledgerCells } from "./velocity-data.js";
import { sessionStartDay, validDay } from "./view-model.js";

/** Repositories with dated evidence before the window and none inside it.
 * Occupied ledger cells count even when their usage value is zero or unpriced.
 * Unknown starts and undated activity cannot establish a day; future activity
 * never changes a historical window's last observed day. Inputs are unchanged.
 */
export function quietRepositories(repositories, sessions, { start, end, timeZone = "UTC" }) {
  if (!validDay(start) || !validDay(end) || start > end) return [];
  const observations = new Map();
  for (const session of sessions) {
    let observed = observations.get(session.repositoryId);
    if (!observed) {
      observed = { lastActiveDay: null, active: false };
      observations.set(session.repositoryId, observed);
    }
    const record = (day) => {
      if (!day || day > end) return;
      if (day >= start) observed.active = true;
      else if (!observed.lastActiveDay || day > observed.lastActiveDay) observed.lastActiveDay = day;
    };
    record(sessionStartDay(session, timeZone));
    for (const [day] of ledgerCells(session.velocity)) if (validDay(day)) record(day);
  }
  const rows = [];
  for (const { repository } of repositories) {
    const observed = observations.get(repository.id);
    if (observed?.lastActiveDay && !observed.active) rows.push({
      id: repository.id, name: repository.name, lastActiveDay: observed.lastActiveDay,
    });
  }
  return rows.sort((a, b) => b.lastActiveDay.localeCompare(a.lastActiveDay) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
