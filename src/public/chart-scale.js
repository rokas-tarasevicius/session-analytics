/** @param {number[]} values */
export function scaleMaximum(values) {
  return values.reduce((maximum, value) => Number.isFinite(value) && value > maximum ? value : maximum, 0);
}

/** @param {number} value @param {number} maximum */
export function barPercent(value, maximum) {
  return Number.isFinite(value) && Number.isFinite(maximum) && value > 0 && maximum > 0 ? Math.min(100, value / maximum * 100) : 0;
}

/** @param {number[]} parts @param {number} maximum */
export function stackPercents(parts, maximum) { return parts.map((value) => barPercent(value, maximum)); }

/** Uniform integer steps; short daily windows label each day when there is room.
 * @param {number} count @param {number} capacity @param {boolean} [hour]
 */
export function axisTickIndexes(count, capacity, hour = false) {
  if (count < 1) return [];
  if (count === 1) return [0];
  const limit = Math.max(1, Math.floor(capacity));
  if (limit === 1) return [hour ? 0 : count - 1];
  const step = hour ? 6 * Math.ceil(4 / limit) : Math.max(1, Math.ceil((count - 1) / (Math.min(limit, count <= 14 ? count : 5) - 1)));
  const first = hour ? 0 : (count - 1) % step;
  return Array.from({ length: Math.floor((count - 1 - first) / step) + 1 }, (_, i) => first + i * step);
}
