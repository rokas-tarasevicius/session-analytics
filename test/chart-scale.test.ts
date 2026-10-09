import assert from "node:assert/strict";
import test from "node:test";
import { axisTicks, barPercent, evenTicks, formatAxisDate, formatAxisMoney, formatShare, linearTicks, scaleMaximum, spansYears, stackPercents } from "../src/public/chart-scale.js";

test("money axes use whole-dollar steps of 1, 2, 2.5 or 5 x 10^k and fall back to cents only below $2", () => {
  const axis = (maximum: number) => { const { step, ticks } = linearTicks(maximum, { whole: true }); return ticks.map((tick) => formatAxisMoney(tick, step)); };
  assert.deepEqual(axis(146.5), ["$0", "$50", "$100", "$150"]);
  assert.deepEqual(axis(160), ["$0", "$50", "$100", "$150", "$200"]);
  assert.deepEqual(axis(37), ["$0", "$10", "$20", "$30", "$40"]);
  assert.deepEqual(axis(9), ["$0", "$5", "$10"], "2.5 is skipped where it would not be a whole dollar");
  assert.deepEqual(axis(3), ["$0", "$1", "$2", "$3"]);
  assert.deepEqual(axis(1834), ["$0", "$500", "$1K", "$1.5K", "$2K"]);
  assert.deepEqual(axis(0.3), ["$0.00", "$0.10", "$0.20", "$0.30"]);
  assert.deepEqual(axis(0.004), ["$0.000", "$0.001", "$0.002", "$0.003", "$0.004"]);
  for (const maximum of [0.004, 0.3, 3, 9, 37, 146.5, 999, 1834, 12500, 4_500_000]) {
    const { step, ticks, maximum: top } = linearTicks(maximum, { whole: true });
    assert.ok(top >= maximum && ticks[0] === 0 && ticks.length >= 2 && ticks.length <= 6, `${maximum}`);
    for (let index = 1; index < ticks.length; index += 1) assert.ok(Math.abs(ticks[index]! - ticks[index - 1]! - step) < 1e-9);
    if (maximum >= 2) assert.ok(Number.isInteger(step), `${maximum}: whole-dollar step`);
    assert.match(String(Math.round(step / 10 ** Math.floor(Math.log10(step)) * 10) / 10), /^(1|2|2\.5|5)$/);
  }
  assert.ok(linearTicks(0, { whole: true }).ticks.length > 1, "an all-zero chart still has an axis");
  assert.deepEqual(linearTicks(4_500_000).ticks, [0, 2_000_000, 4_000_000, 6_000_000]);
});

test("day ticks step evenly back from the latest day, switch to month starts on long ranges and carry the year across years", () => {
  const days = (start: string, length: number) => Array.from({ length }, (_, i) => { const date = new Date(`${start}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + i); return date.toISOString().slice(0, 10); });
  const labels = (keys: string[], maxTicks = 6, granularity: "day" | "week" | "month" | "hour" = "day") => axisTicks(keys, granularity, maxTicks).map(({ label }) => label);
  const month = days("2026-09-10", 30);
  assert.deepEqual(labels(month), ["Sep 11", "Sep 18", "Sep 25", "Oct 2", "Oct 9"], "7-day steps ending on the latest day");
  assert.deepEqual(labels(month, 3), ["Sep 11", "Sep 25", "Oct 9"]);
  assert.deepEqual(labels(month, 2), ["Sep 10", "Oct 9"], "a phone axis still gets two ticks: first and last");
  assert.deepEqual(labels(days("2026-10-03", 7), 2), ["Oct 3", "Oct 9"]);
  assert.deepEqual(labels(days("2026-10-01", 7), 3), ["Oct 1", "Oct 4", "Oct 7"]);
  const ticks = axisTicks(month, "day", 6).map(({ index }) => index);
  for (let i = 1; i < ticks.length; i += 1) assert.equal(ticks[i]! - ticks[i - 1]!, 7);
  assert.deepEqual(labels(days("2026-10-03", 7)), ["Oct 3", "Oct 5", "Oct 7", "Oct 9"]);
  assert.deepEqual(labels(days("2026-07-12", 90)), ["Aug", "Sep", "Oct"], "month starts on a 90-day range");
  assert.deepEqual(labels(days("2025-12-20", 30)), ["Dec 21, 2025", "Dec 28, 2025", "Jan 4, 2026", "Jan 11, 2026", "Jan 18, 2026"]);
  assert.deepEqual(labels(days("2025-10-10", 365)), ["Nov 2025", "Jan 2026", "Mar 2026", "May 2026", "Jul 2026", "Sep 2026"]);
  assert.deepEqual(labels(["2026-09-01"]), ["Sep 1"]);
  assert.deepEqual(labels(["2025-11", "2025-12", "2026-01"], 6, "month"), ["Nov 2025", "Dec 2025", "Jan 2026"]);
  assert.deepEqual(labels(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"], 3, "week"), ["Sep 7", "Sep 21", "Oct 5"]);
  assert.deepEqual(labels(Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")), 6, "hour"), ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"]);
  assert.deepEqual(evenTicks(0, 6), []);
  assert.equal(spansYears(["2025-12-31", "2026-01-01"]), true); assert.equal(spansYears(["2026-01-01", "2026-12-31"]), false);
  assert.equal(formatAxisDate("2026-09-10"), "Sep 10"); assert.equal(formatAxisDate("2026-09-10", { withYear: true }), "Sep 10, 2026");
});

test("shares never round a nonzero part to 0.0% or a partial whole to 100.0%", () => {
  assert.equal(formatShare(0), "0%");
  assert.equal(formatShare(0.00001), "<0.1%"); assert.equal(formatShare(0.0009), "<0.1%");
  assert.equal(formatShare(0.001), "0.1%"); assert.equal(formatShare(0.4012), "40.1%");
  assert.equal(formatShare(0.9995), ">99.9%"); assert.equal(formatShare(1), "100%");
  assert.equal(formatShare(null), "N/A"); assert.equal(formatShare(Number.NaN), "N/A");
});

test("bar widths are proportional with no minimum, invalid or negative widths", () => {
  assert.equal(barPercent(50, 200), 25);
  assert.equal(barPercent(0, 200), 0);
  assert.ok(Math.abs(barPercent(0.001, 1000) - 0.0001) < 1e-15);
  for (const value of [-1, NaN, Infinity, -Infinity]) assert.equal(barPercent(value, 200), 0);
  for (const maximum of [0, -1, NaN, Infinity]) assert.equal(barPercent(5, maximum), 0);
  assert.equal(barPercent(300, 200), 100);
});

test("scale maximum ignores non-finite, zero and negative values without padding", () => {
  assert.equal(scaleMaximum([191, 576, -10, Infinity, NaN]), 576);
  assert.equal(scaleMaximum([0, -1, Infinity, NaN]), 0);
  assert.equal(scaleMaximum([]), 0);
  assert.equal(scaleMaximum([0.001]), 0.001);
});

test("stacks share a maximum: 191 and 576 remain in the ratio 191:576", () => {
  const rows = [[100, 50, 41], [400, 100, 76]];
  const total = (parts: number[]) => parts.reduce((sum, value) => sum + value, 0);
  const maximum = scaleMaximum(rows.map(total));
  const lengths = rows.map((row) => total(stackPercents(row, maximum)));
  assert.ok(Math.abs(lengths[0]! - 191 / 576 * 100) < 1e-12);
  assert.equal(lengths[1], 100);
  assert.ok(Math.abs(lengths[0]! / lengths[1]! - 191 / 576) < 1e-12);
  assert.deepEqual(stackPercents([0, -1, NaN, Infinity], maximum), [0, 0, 0, 0]);
});
