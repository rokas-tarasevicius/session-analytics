// @ts-check
// Offset-free provider/database timestamps mean UTC, independent of local TZ/DST.
/** Few distinct days recur across millions of event timestamps. @type {Map<string, boolean>} */
const calendarDays = new Map();
const maxCachedDays = 100_000;
/** @param {string} date */
function validCalendarDay(date) {
  let valid = calendarDays.get(date);
  if (valid === undefined) {
    const day = Date.parse(`${date}T00:00:00Z`);
    valid = Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === date;
    if (calendarDays.size >= maxCachedDays) calendarDays.clear();
    calendarDays.set(date, valid);
  }
  return valid;
}
/** @param {unknown} value */
export function timestampMilliseconds(value) {
  if (typeof value !== "string") return NaN;
  const parts = /^(\d{4}-\d\d-\d\d)[T ](\d\d):(\d\d):(\d\d)(\.\d{1,9})?(Z|[+-]\d\d:\d\d)?$/.exec(value);
  if (!parts || parts[0] !== value || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) return NaN;
  if (!validCalendarDay(parts[1] ?? "")) return NaN;
  return Date.parse(`${parts[1]}T${parts[2]}:${parts[3]}:${parts[4]}${parts[5] || ""}${parts[6] || "Z"}`);
}
/** @param {unknown} value */
export function normalizeTimestamp(value) {
  const time = timestampMilliseconds(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
/** @param {string | null} first @param {string | null} last */
export function utcDayBounds(first, last) {
  return {
    start: first ? normalizeTimestamp(`${first}T00:00:00Z`) : null,
    end: last ? new Date(timestampMilliseconds(`${last}T00:00:00Z`) + 86_400_000).toISOString() : null,
  };
}
