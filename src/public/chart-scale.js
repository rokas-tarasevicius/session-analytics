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

/** A share as a percentage that never rounds a nonzero part to "0.0%" or a partial whole to "100.0%".
 * @param {number | null | undefined} share */
export function formatShare(share) {
  if (share === null || share === undefined || !Number.isFinite(share)) return "N/A";
  if (share <= 0) return "0%";
  if (share < 0.001) return "<0.1%";
  if (share >= 1) return "100%";
  if (share > 0.999) return ">99.9%";
  return `${(share * 100).toFixed(1)}%`;
}

const round = (value) => Math.round(value * 1e10) / 1e10;

/**
 * A zero-based linear axis with about `count` equal steps of 1, 2, 2.5 or 5 × 10^k. With `whole`, the step is a whole
 * number once the maximum reaches 2 (whole dollars: $0, $50, $100 rather than $37.50 steps); smaller maxima keep
 * fractional steps so a few cents still get an axis.
 * @param {number} maximum @param {{ count?: number, whole?: boolean }} [options]
 * @returns {{ maximum: number, step: number, ticks: number[] }}
 */
export function linearTicks(maximum, { count = 4, whole = false } = {}) {
  const top = Number.isFinite(maximum) && maximum > 0 ? maximum : 0;
  const rough = (top || (whole ? 1 : 0.001)) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const integers = whole && top >= 2;
  let step = magnitude * 10;
  for (const factor of [1, 2, 2.5, 5, 10]) {
    const candidate = round(factor * magnitude);
    if (integers && !Number.isInteger(candidate)) continue;
    if (candidate >= rough - 1e-12) { step = candidate; break; }
  }
  if (integers) step = Math.max(1, step);
  const steps = Math.max(1, Math.ceil(round(top / step)));
  const ticks = Array.from({ length: steps + 1 }, (_, index) => round(index * step));
  return { maximum: ticks.at(-1), step, ticks };
}

const compactMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
/** An axis label in US dollars: whole dollars for whole steps ("$40", "$1.5K"), cents for fractional steps ("$0.25").
 * @param {number} value @param {number} step */
export function formatAxisMoney(value, step) {
  if (Math.abs(value) >= 1000) return compactMoney.format(value);
  if (step >= 1) return `$${Math.round(value)}`;
  return `$${value.toFixed(Math.min(6, Math.max(2, Math.ceil(-Math.log10(step) - 1e-9))))}`;
}

const tickCount = (length, step) => Math.floor((length - 1) / step) + 1;
/** The first of `steps` giving between two and `limit` ticks, or null. */
const fittingStep = (length, limit, steps) => steps.find((step) => tickCount(length, step) >= 2 && tickCount(length, step) <= limit) ?? null;
/** @param {number} length @param {number} step @param {"start" | "end"} anchor */
function stepIndices(length, step, anchor) {
  const indices = [];
  if (anchor === "start") for (let index = 0; index < length; index += step) indices.push(index);
  else for (let index = length - 1; index >= 0; index -= step) indices.unshift(index);
  return indices;
}

/**
 * Indices of at most `maxTicks` evenly spaced ticks over `length` keys, using the first step from `steps` that gives at
 * least two ticks, else an even step that does. Ticks are anchored on the last key (the latest date is labelled) or,
 * with `anchor: "start"`, on the first.
 * @param {number} length @param {number} maxTicks @param {{ steps?: number[], anchor?: "start" | "end" }} [options]
 */
export function evenTicks(length, maxTicks, { steps = [1, 2, 3, 7, 14], anchor = "end" } = {}) {
  if (length <= 0) return [];
  if (length === 1) return [0];
  const limit = Math.max(2, Math.floor(maxTicks));
  return stepIndices(length, fittingStep(length, limit, steps) ?? Math.ceil((length - 1) / (limit - 1)), anchor);
}

/**
 * Tick indices for calendar days (YYYY-MM-DD, ascending, consecutive): every 1, 2, 3, 7 or 14 days counted back from
 * the last day; longer ranges tick on month starts every 1, 2, 3, 6 or 12 months (`months: true`); a range that fits
 * neither gets an even step between its first and last day.
 * @param {string[]} days @param {number} [maxTicks] @returns {{ indices: number[], months: boolean }}
 */
export function dayTicks(days, maxTicks = 6) {
  const limit = Math.max(2, Math.floor(maxTicks));
  if (days.length <= 1 || fittingStep(days.length, limit, [1, 2, 3, 7, 14]) !== null) return { indices: evenTicks(days.length, limit), months: false };
  const starts = days.map((day, index) => [day, index]).filter(([day]) => day.endsWith("-01"));
  for (const months of [1, 2, 3, 6, 12]) {
    const picked = starts.filter(([day]) => (Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1) % months === 0);
    if (picked.length >= 2 && picked.length <= limit) return { indices: picked.map(([, index]) => index), months: true };
  }
  return { indices: evenTicks(days.length, limit, { steps: [] }), months: false };
}

/** True when the keys (dates or months) cover more than one calendar year. @param {string[]} keys */
export function spansYears(keys) { return keys.length > 1 && keys[0].slice(0, 4) !== keys.at(-1).slice(0, 4); }

const axisFormats = new Map();
/**
 * The dashboard's one axis date format: "Sep 10" for a day and "Sep" for a month key ("2026-09"), with the year
 * ("Dec 28, 2025", "Dec 2025") when the axis spans years.
 * @param {string} key @param {{ withYear?: boolean }} [options]
 */
export function formatAxisDate(key, { withYear = false } = {}) {
  const month = /^\d{4}-\d{2}$/.test(key);
  const name = `${month ? "m" : "d"}${withYear ? "y" : ""}`;
  let format = axisFormats.get(name);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { month: "short", ...(month ? {} : { day: "numeric" }), ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
    axisFormats.set(name, format);
  }
  const date = new Date(`${month ? `${key}-01` : key}T12:00:00Z`);
  return Number.isFinite(date.valueOf()) ? format.format(date) : key;
}

/**
 * Labelled x-axis ticks for a time chart: days (even day steps, or month starts on long ranges), weeks (keys are
 * Monday dates), months ("YYYY-MM") or the 24 clock hours. Dates carry the year when the axis spans years.
 * @param {string[]} keys @param {"day" | "week" | "month" | "hour"} granularity @param {number} [maxTicks]
 * @returns {Array<{ index: number, label: string }>}
 */
export function axisTicks(keys, granularity = "day", maxTicks = 6) {
  if (granularity === "hour") return evenTicks(keys.length, maxTicks, { steps: [1, 2, 3, 4, 6, 12], anchor: "start" }).map((index) => ({ index, label: `${keys[index]}:00` }));
  const withYear = spansYears(keys);
  if (granularity === "week" || granularity === "month") {
    const steps = granularity === "week" ? [1, 2, 4, 8, 13, 26, 52] : [1, 2, 3, 6, 12];
    return evenTicks(keys.length, maxTicks, { steps }).map((index) => ({ index, label: formatAxisDate(keys[index], { withYear }) }));
  }
  const { indices, months } = dayTicks(keys, maxTicks);
  return indices.map((index) => ({ index, label: formatAxisDate(months ? keys[index].slice(0, 7) : keys[index], { withYear }) }));
}
