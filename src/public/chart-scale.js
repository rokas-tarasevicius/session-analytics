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
