import { normalizeTimestamp } from "./timestamps.js";

const integers = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const decimals = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const compactNumbers = new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" });
const dollars = new Map();
const dates = new Map();
const percentages = new Map();
const alternatives = new Intl.ListFormat("en", { style: "long", type: "disjunction" });

export const integer = (value) => integers.format(value);
export const decimal = (value) => decimals.format(value);
export const compact = (value) => compactNumbers.format(value);

/** Table values keep cents; rates and sub-cent activity may request more precision. */
export function money(value, maximumFractionDigits = 2) {
  let formatter = dollars.get(maximumFractionDigits);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits });
    dollars.set(maximumFractionDigits, formatter);
  }
  return formatter.format(value || 0);
}

/** Compact labels share Summary's rounding at the $10 and $1,000 boundaries. */
export function moneyAxis(value) {
  const amount = value || 0;
  if (amount === 0) return "$0";
  if (amount > 0 && amount < 0.01) return money(amount, 6);
  if (Math.round(amount) >= 1000) return `$${compact(Math.max(1000, amount))}`;
  return `$${amount.toFixed(Math.round(amount * 100) >= 1000 ? 0 : 2)}`;
}

export function percent(value, digits = 1, minimumFractionDigits = digits) {
  if (value === null || value === undefined) return "N/A";
  if (minimumFractionDigits === digits) return `${(value * 100).toFixed(digits)}%`;
  const key = `${digits}:${minimumFractionDigits}`;
  let formatter = percentages.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en", { minimumFractionDigits, maximumFractionDigits: digits });
    percentages.set(key, formatter);
  }
  return `${formatter.format(value * 100)}%`;
}

function dateFormatter(key, options, locale = "en-GB") {
  let formatter = dates.get(key);
  if (!formatter) { formatter = new Intl.DateTimeFormat(locale, options); dates.set(key, formatter); }
  return formatter;
}

// Calendar keys already name a day in the snapshot's timezone. Format them as UTC
// calendar dates so the viewer's timezone cannot shift an axis or range by a day.
const calendarDate = (day) => new Date(`${day}T00:00:00Z`);
export const dayLabel = (day) => dateFormatter("dayLabel", { day: "numeric", month: "short", timeZone: "UTC" }).format(calendarDate(day));
export const dateLabel = (day) => dateFormatter("dateLabel", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(calendarDate(day));
export const fullDate = (day) => dateFormatter("fullDate", { dateStyle: "full", timeZone: "UTC" }).format(calendarDate(day));
export const toolDayLabel = (day) => dateFormatter("toolDayLabel", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(calendarDate(day));
export const monthLabel = (month) => dateFormatter("monthLabel", { month: "short", year: "numeric", timeZone: "UTC" }).format(calendarDate(`${month}-01`));

export function dateRange(start, end) {
  if (start === end) return dateLabel(start);
  return `${start.slice(0, 4) === end.slice(0, 4) ? dayLabel(start) : dateLabel(start)} – ${dateLabel(end)}`;
}

export function timeLabel(value, timeZone = "UTC") {
  return dateFormatter(`time:${timeZone}`, { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(normalizeTimestamp(value)));
}

export function dateTime(value, timeZone = "UTC") {
  if (!value) return "Unknown time";
  return dateFormatter(`dateTime:${timeZone}`, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(normalizeTimestamp(value)));
}

// Parts retain the existing calendar and Activity attribution rules.
export const calendarParts = (date, timeZone) => dateFormatter(`calendar:${timeZone}`, { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA").formatToParts(date);
export const weekdayHourParts = (date, timeZone) => dateFormatter(`weekdayHour:${timeZone}`, { timeZone, weekday: "short", hour: "2-digit", hourCycle: "h23" }, "en-US").formatToParts(date);
export const disjunction = (values) => alternatives.format(values);

// Instants (Unix seconds) shown in a named timezone, for limit meters and reset times.
const wholeDollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const wholeMoney = (value) => wholeDollars.format(value || 0);
const instant = (seconds) => new Date(seconds * 1000);
export const weekdayTime = (seconds, timeZone = "UTC") => dateFormatter(`weekdayTime:${timeZone}`, { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(instant(seconds));
export const dayMonth = (seconds, timeZone = "UTC") => dateFormatter(`dayMonth:${timeZone}`, { timeZone, day: "numeric", month: "short" }).format(instant(seconds));
export const weekdayDate = (seconds, timeZone = "UTC") => dateFormatter(`weekdayDate:${timeZone}`, { timeZone, weekday: "short", day: "numeric" }).format(instant(seconds));
/** The activity-ledger cell key (`YYYY-MM-DD|hour`) for an instant in a timezone. */
export function zonedHourKey(seconds, timeZone = "UTC") {
  const parts = Object.fromEntries(dateFormatter(`hourKey:${timeZone}`, { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }, "en-CA").formatToParts(instant(seconds)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}|${Number(parts.hour)}`;
}
