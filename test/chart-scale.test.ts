import assert from "node:assert/strict";
import test from "node:test";
import { axisTickIndexes, barPercent, scaleMaximum, stackPercents } from "../src/public/chart-scale.js";

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


test("calendar ticks use a constant integer stride without rounded fractional jumps", () => {
  assert.deepEqual(axisTickIndexes(7, 7), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(axisTickIndexes(14, 14), Array.from({ length: 14 }, (_, i) => i));
  assert.deepEqual(axisTickIndexes(24, 5, true), [0, 6, 12, 18]);
  assert.deepEqual(axisTickIndexes(24, 3, true), [0, 12]);
  assert.deepEqual(axisTickIndexes(0, 5), []);
  for (const count of [7, 14, 18, 30, 90]) for (const room of [1, 2, 3, 5]) {
    const ticks = axisTickIndexes(count, room);
    assert.ok(ticks.length <= room);
    const gaps = ticks.slice(1).map((value, i) => value - ticks[i]!);
    assert.ok(new Set(gaps).size <= 1);
    assert.equal(ticks.at(-1), count - 1);
  }
});
