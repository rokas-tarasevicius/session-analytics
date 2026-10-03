// Pure chart geometry helpers for the dashboard. No DOM, no dependencies; covered by test/chart-geometry.test.ts.

/** X position of item `index` of `count` spread evenly across the plot; a single item sits at the centre. */
export function positionAt(index, left, plotWidth, count) {
  return count === 1 ? left + plotWidth / 2 : left + (index / (count - 1)) * plotWidth;
}

/** Index of the item nearest to an SVG-space x, clamped to the plotted range. */
export function nearestIndex(x, left, plotWidth, count) {
  if (count <= 1) return 0;
  const index = Math.round(((x - left) / plotWidth) * (count - 1));
  return Math.max(0, Math.min(count - 1, index));
}

/**
 * Lay out direct end labels inside [min, max] with at least `gap` between neighbours.
 * Labels are first clamped into the bounds and pushed apart downwards; any overflow past `max`
 * is then propagated back upwards so the group stays inside the plot. Returns, in input order,
 * `{ y, moved }` where `moved` reports a label that left its line end and needs a leader.
 */
export function layoutEndLabels(targets, min, max, gap) {
  const order = targets.map((target, index) => ({ index, target, y: Math.min(max, Math.max(min, target)) }))
    .sort((a, b) => a.target - b.target || a.index - b.index);
  for (let i = 1; i < order.length; i += 1) order[i].y = Math.max(order[i].y, order[i - 1].y + gap);
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const limit = i === order.length - 1 ? max : order[i + 1].y - gap;
    if (order[i].y > limit) order[i].y = limit;
  }
  const result = new Array(targets.length);
  for (const item of order) result[item.index] = { y: item.y, moved: Math.abs(item.y - item.target) > 1 };
  return result;
}

/**
 * Donut segments as ordered [start, end] percentages with a surface-coloured gap on each side.
 * The gap is capped relative to the segment so a small nonzero share always keeps a painted slice,
 * and every stop stays inside 0–100.
 */
export function donutStops(segments, gap = 0.8) {
  const visible = segments.filter(({ share }) => share > 0);
  const stops = [];
  let cursor = 0;
  for (const { name, share } of visible) {
    const inset = visible.length > 1 ? Math.min(gap / 2, share / 4) : 0;
    const start = Math.min(100, cursor + inset);
    const end = Math.min(100, Math.max(start, cursor + share - inset));
    stops.push({ name, start, end });
    cursor = Math.min(100, cursor + share);
  }
  return stops;
}

/** conic-gradient() for donut stops; segment names map to `--<name>` colour tokens. */
export function donutGradient(stops, surface = "var(--surface)") {
  const parts = [];
  let cursor = 0;
  for (const { name, start, end } of stops) {
    if (start > cursor) parts.push(`${surface} ${cursor}% ${start}%`);
    parts.push(`var(--${name}) ${start}% ${end}%`);
    cursor = end;
  }
  if (cursor < 100) parts.push(`${surface} ${cursor}% 100%`);
  return `conic-gradient(${parts.join(", ")})`;
}

/** Whole-percent share label that never reports a nonzero share as 0%. */
export function sharePercent(value, total) {
  if (!total || value <= 0) return "0%";
  const share = (value / total) * 100;
  return share < 1 ? "<1%" : `${Math.round(share)}%`;
}
