import assert from "node:assert/strict";
import test from "node:test";

import {
  donutGradient,
  donutStops,
  layoutEndLabels,
  nearestIndex,
  positionAt,
  sharePercent,
} from "../src/public/chart-geometry.js";

// The daily chart plots 60 days across a 774-unit plot starting at x=64 (viewBox units).
const left = 64;
const plotWidth = 774;

test("positionAt centres a single item and spreads the rest across the plot", () => {
  assert.equal(positionAt(0, left, plotWidth, 1), 451);
  assert.equal(positionAt(0, left, plotWidth, 60), 64);
  assert.equal(positionAt(59, left, plotWidth, 60), 838);
});

test("nearestIndex snaps an SVG-space x to the nearest plotted day and clamps to the range", () => {
  assert.equal(nearestIndex(left, left, plotWidth, 60), 0);
  assert.equal(nearestIndex(left + plotWidth, left, plotWidth, 60), 59);
  assert.equal(nearestIndex(positionAt(3, left, plotWidth, 60) + 2, left, plotWidth, 60), 3);
  assert.equal(nearestIndex(positionAt(3, left, plotWidth, 60) - 5, left, plotWidth, 60), 3);
  assert.equal(nearestIndex(-500, left, plotWidth, 60), 0);
  assert.equal(nearestIndex(5_000, left, plotWidth, 60), 59);
  assert.equal(nearestIndex(300, left, plotWidth, 1), 0);
});

test("layoutEndLabels separates labels that converge on the baseline without leaving the plot", () => {
  const laid = layoutEndLabels([234, 234], 22, 234, 14);
  assert.deepEqual(laid.map(({ y }) => y), [220, 234]);
  assert.deepEqual(laid.map(({ moved }) => moved), [true, false]);
});

test("layoutEndLabels leaves separated labels alone and clamps strays into the bounds", () => {
  assert.deepEqual(layoutEndLabels([100, 150], 22, 234, 14).map(({ y, moved }) => [y, moved]), [[100, false], [150, false]]);
  assert.deepEqual(layoutEndLabels([10, 12, 300], 22, 234, 14).map(({ y }) => y), [22, 36, 234]);
  assert.deepEqual(layoutEndLabels([230, 110, 232], 22, 234, 14).map(({ y }) => y), [220, 110, 234]);
  assert.deepEqual(layoutEndLabels([], 22, 234, 14), []);
});

test("donutStops keeps a painted slice for a tiny nonzero share and stays inside 0–100", () => {
  const stops = donutStops([{ name: "codex", share: 99.9 }, { name: "claude", share: 0 }, { name: "cursor", share: 0.1 }]);
  assert.deepEqual(stops.map(({ name }) => name), ["codex", "cursor"]);
  const cursor = stops[1];
  assert.ok(cursor && cursor.end > cursor.start, "the 0.1% share keeps a visible arc");
  for (const stop of stops) assert.ok(stop.start >= 0 && stop.start <= stop.end && stop.end <= 100);
  const [first, second] = stops;
  assert.ok(first && second && first.end <= second.start, "slices stay ordered");
  assert.deepEqual(donutStops([{ name: "claude", share: 100 }]), [{ name: "claude", start: 0, end: 100 }]);
  assert.deepEqual(donutStops([]), []);
});

test("donutGradient paints surface gaps only between slices", () => {
  const gradient = donutGradient([{ name: "codex", start: 0.4, end: 49.6 }, { name: "claude", start: 50.4, end: 99.6 }]);
  assert.equal(
    gradient,
    "conic-gradient(var(--surface) 0% 0.4%, var(--codex) 0.4% 49.6%, var(--surface) 49.6% 50.4%, var(--claude) 50.4% 99.6%, var(--surface) 99.6% 100%)",
  );
  assert.equal(donutGradient([{ name: "claude", start: 0, end: 100 }]), "conic-gradient(var(--claude) 0% 100%)");
});

test("sharePercent never reports a nonzero share as 0%", () => {
  assert.equal(sharePercent(1, 1000), "<1%");
  assert.equal(sharePercent(0, 10), "0%");
  assert.equal(sharePercent(158, 328), "48%");
  assert.equal(sharePercent(3, 0), "0%");
});
