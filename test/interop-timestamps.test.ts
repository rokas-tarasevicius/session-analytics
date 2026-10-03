import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { normalizeTimestamp, timestampMilliseconds, utcDayBounds } from "../src/public/timestamps.js";

test("review: UTC normalization handles offsets, fractions, midnight and calendar validity", () => {
  for (const value of ["2026-07-20 14:00:00", "2026-07-20T14:00:00", "2026-07-20T16:00:00+02:00", "2026-07-20T09:00:00-05:00"]) {
    assert.equal(normalizeTimestamp(value), "2026-07-20T14:00:00.000Z");
  }
  assert.equal(normalizeTimestamp("2026-07-21T00:30:00.123456+02:00"), "2026-07-20T22:30:00.123Z");
  for (const value of ["2026-02-29T12:00:00Z", "2026-07-32T12:00:00Z", "2026-07-20T24:00:00Z", "2026-07-20T00:00:60Z", "2026-07-20T14:00:00Z\n", "secret-path"]) assert.ok(Number.isNaN(timestampMilliseconds(value)));
  assert.deepEqual(utcDayBounds("2026-07-20", "2026-07-20"), { start: "2026-07-20T00:00:00.000Z", end: "2026-07-21T00:00:00.000Z" });
});

test("review: offset-free inputs and inclusive date labels are independent of local DST", () => {
  const script = `
    import { normalizeTimestamp, utcDayBounds } from './src/public/timestamps.js';
    import { selectSessions } from './src/public/export-data.js';
    const days = ['2026-03-29', '2026-10-25', '2026-03-08', '2026-11-01'];
    console.log(JSON.stringify(days.map(day => {
      const bounds = utcDayBounds(day, day);
      return { time: normalizeTimestamp(day + ' 01:30:00'), hours: (Date.parse(bounds.end)-Date.parse(bounds.start))/3600000,
        retained: selectSessions([{createdAt: day+' 00:00:00'}, {createdAt: day+'T23:59:59.999999Z'}, {createdAt: bounds.end}], bounds).length };
    })));
  `;
  let expected: unknown;
  for (const zone of ["UTC", "Europe/London", "America/New_York"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ: zone } });
    assert.equal(child.status, 0, child.stderr);
    const value = JSON.parse(child.stdout);
    assert.ok(value.every((row: any) => row.hours === 24 && row.retained === 2 && row.time.endsWith("T01:30:00.000Z")));
    if (expected) assert.deepEqual(value, expected); else expected = value;
  }
});
