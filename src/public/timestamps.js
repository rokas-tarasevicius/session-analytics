// @ts-check
// Offset-free provider/database timestamps mean UTC, independent of local TZ/DST.
/** @param {unknown} value */
export function timestampMilliseconds(value) {
  if (typeof value !== "string") return NaN;
  const parts = /^(\d{4}-\d\d-\d\d)[T ](\d\d):(\d\d):(\d\d)(\.\d{1,9})?(Z|[+-]\d\d:\d\d)?$/.exec(value);
  if (!parts || parts[0] !== value || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) return NaN;
  const day = Date.parse(`${parts[1]}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== parts[1]) return NaN;
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
