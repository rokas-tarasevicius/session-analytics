// @ts-check
// Public vocabulary shared by ingestion, schema generation, and browser exports.
export const repositoryKeyPattern = "^(conductor|discovered)-[a-f0-9]{20}$";
export const metadataPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
// Model registries may namespace IDs; absolute/relative paths and URL syntax fail.
export const modelPattern = "^(<unknown>|[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,127})?)$";
/** @type {ReadonlyArray<import("../types.ts").SessionStatus>} */
export const sessionStatuses = ["idle", "working", "completed", "failed", "error", "interrupted", "cancelled", "pending", "unknown"];
export const filteredWarning = "Filtered export: entire sessions selected by start date; coverage is recomputed for the selection. API-equivalent value is not an invoice.";
export const sharedEvidenceCaveat = "Totals are observed lower bounds and may include running and partially parsed sessions. Pricing coverage measures rates for observed tokens, not evidence completeness.";
export const discoveryWarnings = [
  "A provider transcript root is missing.",
  "A provider transcript root could not be read.",
  "Cursor local session history could not be read.",
];
export const fixedWarnings = [
  ...discoveryWarnings, filteredWarning,
  "Transcript ID matched, but its recorded working directory did not.",
  "Transcript filename matched, but provider metadata validation failed.",
  "No cumulative Codex token counter was found.",
  "Codex does not expose cache-write tokens separately; the upper estimate treats all uncached input as cache writes.",
  "Some Claude responses do not expose thinking tokens separately; they remain included in output.",
  "Provider history did not record a stable model ID; those tokens are excluded from API-equivalent spend coverage.",
  "Discovered directly from the machine-wide provider transcript store.",
  "Recovered from a unique working-directory and start-time match in the provider transcript store.",
  "Cursor usage value is read from the provider-reported local cost record; it is not inferred from a third-party rate card.",
  "Cursor retained session metadata without a provider-reported local cost record; no usage value is inferred.",
  "Cursor retained the session header and usage summary, but not detailed local conversation metrics.",
  "Conductor has no provider session ID.",
  "Unsupported Conductor agent type.",
  "Transcript parsing failed without exposing local error details.",
  "Some provider metadata was omitted because it was not a bounded public identifier.",
  "Cache-write totals were reconciled from the recorded TTL breakdown.",
];
const count = "[1-9][0-9]{0,15}";
export const warningPatterns = [
  `^${count} malformed JSONL records were skipped\\.$`,
  `^${count} cumulative token counter reset(?: was|s were) re-baselined as a new observed segment\\.$`,
  `^${count} repeated process-wide token snapshot(?: was|s were) excluded from this session\\.$`,
  `^${count} token event(?: lacks|s lack) per-request usage; only deltas between snapshots this session observed were counted\\.$`,
  `^${count} process-wide counter baseline(?: was|s were) excluded because the requests inside it were not observed by this session\\.$`,
  `^${count} legacy sessions? cannot be correlated because Conductor recorded no provider session ID\\.$`,
  `^${count} sessions? have a provider ID but no validated local transcript\\.$`,
  `^${count} sessions? include models without a rate card\\.$`,
  `^${count} sessions? have unsupported provider evidence\\.$`,
  `^No rate card is configured for ${modelPattern.slice(1, -1)}\\.$`,
];
const expressions = warningPatterns.map((pattern) => new RegExp(pattern));
/** @param {string} value */
export function approvedWarning(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (fixedWarnings.includes(value)) return true;
  const leadingCount = /^([0-9]+) /.exec(value);
  return (!leadingCount || Number.isSafeInteger(Number(leadingCount[1]))) && expressions.some((pattern) => pattern.test(value));
}

// Keep source-wide failures even when the missing evidence has no session rows.
/** @param {string[]} warnings */
export function scanWarnings(warnings) {
  return warnings.flatMap((warning) => {
    if (discoveryWarnings.includes(warning)) return [warning];
    // Older analyzers joined these two fixed messages across provider profiles.
    if (warning === `${discoveryWarnings[0]} ${discoveryWarnings[1]}` || warning === `${discoveryWarnings[1]} ${discoveryWarnings[0]}`) return discoveryWarnings.slice(0, 2);
    return [];
  });
}

/** @param {import("../types.ts").SessionAnalytics[]} sessions */
export function coverageWarnings(sessions) {
  const missing = sessions.filter(({ transcript }) => transcript.status === "missing");
  const legacy = missing.filter(({ transcript }) => transcript.warnings.includes("Conductor has no provider session ID.")).length;
  const unmatched = missing.length - legacy;
  const unpriced = sessions.filter(({ costComplete }) => !costComplete).length;
  const unsupported = sessions.filter(({ transcript }) => transcript.status === "unsupported").length;
  return [
    ...(legacy ? [`${legacy} legacy session${legacy === 1 ? "" : "s"} cannot be correlated because Conductor recorded no provider session ID.`] : []),
    ...(unmatched ? [`${unmatched} session${unmatched === 1 ? "" : "s"} have a provider ID but no validated local transcript.`] : []),
    ...(unpriced ? [`${unpriced} sessions include models without a rate card.`] : []),
    ...(unsupported ? [`${unsupported} session${unsupported === 1 ? "" : "s"} have unsupported provider evidence.`] : []),
  ];
}
