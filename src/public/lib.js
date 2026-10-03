// Pure helpers for the dashboard: formatting, chart arithmetic, keyboard
// resolution and the narrative lede. Nothing here touches the DOM, so the
// same code runs under node:test (see test/dashboard.test.ts).

export const numberWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export const compact = new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" });
export const integer = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const currency = new Intl.NumberFormat("en-US", { currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2, style: "currency" });
const shortDateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const longDateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });

export const money = (value) => currency.format(value || 0);
export const percent = (value) => value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
export const share = (value) => `${Math.round(value * 100)}%`;
export const spelled = (value) => value < numberWords.length ? numberWords[value] : integer.format(value);
export const plural = (value, singular, pluralForm = `${singular}s`) => value === 1 ? singular : pluralForm;
export const shortDate = (day) => shortDateFormat.format(new Date(`${day}T00:00:00`));
export const longDate = (day) => longDateFormat.format(new Date(`${day}T00:00:00`));

/** Axis maximum rounded up to four clean ticks. */
export function niceMaximum(maximum) {
  const roughTick = Math.max(0.001, maximum) / 4;
  const tickMagnitude = 10 ** Math.floor(Math.log10(roughTick));
  return Math.ceil(roughTick / tickMagnitude) * tickMagnitude * 4;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Resolve a key press on the daily chart to the next day index, "hide", or
 * null when the key is not handled. Home and End always resolve to the first
 * and last day; arrows start from the nearest end when no day is active.
 */
export function nextChartIndex(key, activeIndex, length) {
  if (length <= 0) return null;
  if (key === "Escape") return "hide";
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const step = key === "ArrowRight" ? 1 : -1;
  if (activeIndex < 0) return step > 0 ? 0 : length - 1;
  return Math.max(0, Math.min(length - 1, activeIndex + step));
}

/** The day with the highest summed value across the given provider keys, or null. */
export function peakDay(items, providers) {
  let peak = null;
  for (const item of items) {
    const value = providers.reduce((sum, provider) => sum + (item[provider] || 0), 0);
    if (value > 0 && (!peak || value > peak.value)) peak = { name: item.name, value };
  }
  return peak;
}

/** Opening phrase of the lede for the selected window. */
export function windowPhrase({ start, end, min, max, preset }) {
  if (!start || !end) return "In this window";
  if (preset === "7" || preset === "30" || preset === "90") return `In the last ${preset} days`;
  const whole = start === min && end === max;
  if (start === end) return whole ? `On ${longDate(start)}, the only observed day,` : `On ${longDate(start)},`;
  return whole ? `Across every observed day, ${shortDate(start)} to ${shortDate(end)},` : `Between ${shortDate(start)} and ${shortDate(end)},`;
}

/**
 * The front-page lede as an array of parts: `{ text }` runs and
 * `{ strong, className? }` figures. `peak` must come from the same
 * window-clipped daily series the chart draws.
 */
export function ledeParts({ summary, selectedName, phrase, valueByProvider, providerLabels, busiest, peak }) {
  const text = (value) => ({ text: value });
  const strong = (value, className) => (className ? { strong: value, className } : { strong: value });
  if (summary.sessions === 0) {
    return [text(`${phrase.replace(/,$/, "")}, no sessions started${selectedName ? ` in ${selectedName}` : ""}. Widen the window or choose another repository.`)];
  }
  const parts = [
    text(`${phrase} ${selectedName ? `agents working in ${selectedName}` : "your agents"} ran `),
    strong(`${integer.format(summary.sessions)} ${plural(summary.sessions, "session")}`),
  ];
  if (!selectedName) parts.push(text(` across ${spelled(summary.repositoriesWithSessions)} ${plural(summary.repositoriesWithSessions, "repository", "repositories")}`));
  parts.push(text(", processing "), strong(`${compact.format(summary.totalInputTokens)} input tokens`), text(" and writing "), strong(`${compact.format(summary.outputTokens)} output tokens`));
  if (summary.apiEquivalentSpendUsd > 0) {
    parts.push(text(" for an API-equivalent value of "), strong(money(summary.apiEquivalentSpendUsd), "value"), text(". "));
    const ranked = ["claude", "codex"].map((provider) => ({ provider, value: valueByProvider[provider] || 0 })).filter(({ value }) => value > 0).sort((left, right) => right.value - left.value);
    if (ranked.length === 2) parts.push(text(`${providerLabels[ranked[0].provider]} carried `), strong(share(ranked[0].value / summary.apiEquivalentSpendUsd)), text(` of that value and ${providerLabels[ranked[1].provider]} `), strong(share(ranked[1].value / summary.apiEquivalentSpendUsd)));
    else if (ranked.length === 1) parts.push(text(`${providerLabels[ranked[0].provider]} carried all of it`));
    if ((valueByProvider.cursor || 0) > 0) parts.push(text(`; Cursor reported a further ${money(valueByProvider.cursor)} on its own basis`));
    parts.push(text(". "));
  } else if (summary.providerReportedSpendUsd > 0) {
    parts.push(text("; Cursor reported "), strong(money(summary.providerReportedSpendUsd), "value"), text(" of provider-measured value. "));
  } else {
    parts.push(text(" with no priced activity. "));
  }
  const clauses = [];
  if (busiest) clauses.push([strong(busiest.name), text(` was the busiest repository with ${integer.format(busiest.sessions)} ${plural(busiest.sessions, "session")}`)]);
  if (peak) clauses.push([text(`${clauses.length ? "the" : "The"} highest-value day was `), strong(longDate(peak.name)), text(` at ${money(peak.value)}`)]);
  clauses.forEach((clause, index) => {
    if (index > 0) parts.push(text(", and "));
    parts.push(...clause);
  });
  if (clauses.length) parts.push(text("."));
  return parts;
}
