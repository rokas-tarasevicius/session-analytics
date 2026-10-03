// @ts-check
// Public vocabulary shared by ingestion, schema generation, and browser exports.
export const repositoryKeyPattern = "^(conductor|discovered)-[a-f0-9]{20}$";
export const metadataPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
// Model registries may namespace IDs; absolute/relative paths and URL syntax fail.
export const modelPattern = "^(<unknown>|(?:@cf/)?[A-Za-z][A-Za-z0-9._-]*(?:/[A-Za-z][A-Za-z0-9._-]*){0,2})$";
/** @type {ReadonlyArray<import("../types.ts").SessionStatus>} */
export const sessionStatuses = ["idle", "working", "completed", "failed", "error", "interrupted", "cancelled", "pending", "unknown"];
export const filteredWarning = "Filtered export: entire sessions selected by start date; coverage is recomputed for the selection. API-equivalent value is not an invoice.";
export const sharedEvidenceCaveat = "Totals are observed lower bounds and may include running and partially parsed sessions. Pricing coverage measures rates for observed tokens, not evidence completeness.";
export const discoveryWarnings = [
  "A provider transcript root is missing.",
  "A provider transcript root could not be read.",
  "Cursor local session history could not be read.",
  "Cursor local session history is missing.",
  "Evidence changed during analysis; unstable index groups were deferred until the next scan.",
  "A provider evidence fallback could not be read; canonical sessions were retained.",
  "A provider evidence session could not be read; other sessions were retained.",
  "A provider evidence store could not be read or has an unsupported schema.",
];
export const fixedWarnings = [
  ...discoveryWarnings, filteredWarning,
  "Source availability could not be checked; showing the last indexed facts.",
  "Source-deleted history retains the pricing and parser results from its last successful ingest.",
  "Legacy activity dates could not be verified; history is kept until its source can be read again.",
  "Workflow projection is unavailable; accounting was retained.",
  "A provider evidence fallback could not be read; canonical sessions were retained.",
  "Cursor SDK tool events were unavailable; run summaries were retained.",
  "Malformed Cursor SDK records were skipped.",
  "Cursor SDK usage is aggregated by run. Model request counts and daily cost attribution are unavailable; one started run counts as one observed turn.",
  "Aggregate usage has no per-request context sizes; the upper estimate applies the long-context premium to all usage.",
  "Cache-write TTL is unavailable; the ordinary estimate uses the default write rate and the upper estimate allows the configured one-hour write rate.",
  "Recovered from Conductor result receipts. Tools, human turns, model request counts, and daily cost attribution are unavailable. Reported value is not an invoice.",
  "Accounting is partial: retained receipts do not prove disjoint process epochs or complete resumed history. Ambiguous cumulative snapshots are not added; zeroed crash results cannot erase earlier evidence.",
  "Turn-local usage is separate from cumulative model usage. SDK turns, durations, and denial totals are unavailable across multiple receipts because their scopes are not established.",
  "Conductor rows disagree on repository attribution; the recovered identity is grouped as unassigned.",
  "Reported model allocations differ from the reported total; the SDK result total remains authoritative.",
  "Malformed OpenCode message records were skipped.",
  "OpenCode step counters are priced at reviewed API rates, with assistant snapshots used only where step counters are absent. OpenCode's own cost estimate is not added again.",
  "Malformed or oversized Gemini records were skipped; accounting is partial.",
  "Gemini metrics describe retained chat history; rewound or removed messages are excluded. Models without reviewed rates remain unpriced.",
  "Malformed Copilot events were skipped.",
  "Copilot persisted events provide activity counts. Per-call usage events are ephemeral; tokens and USD value are unavailable. Premium-request multipliers and AI credits are not dollar costs.",
  "The evidence does not establish a unique repository path; this session is grouped as unassigned.",
  "A provider evidence session could not be read; other sessions were retained.",
  "A provider evidence store could not be read or has an unsupported schema.",
  "Malformed Cursor transcript records were skipped.",
  "Activity-only Cursor transcript: tokens, model, cost, and event times are unavailable. The displayed date is the file modification time, not session start; duration is unavailable.",

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
  `^${count} sessions include source-deleted history; facts and prices are from their last successful ingest\\.$`,
  `^${count} malformed JSONL records were skipped\\.$`,
  `^${count} malformed JSONL records were skipped (?:in the primary transcript|in child transcripts)\\.$`,
  `^${count} inherited assistant records are owned by earlier sessions and excluded here\\.$`,
  `^${count} assistant records lack provable request ownership; their usage and cost are excluded\\. Accounting is partial\\.$`,
  `^Some token classes have estimated or unavailable rates for ${modelPattern.slice(1, -1)}\\.$`,
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
  const retained = sessions.filter(({ transcript }) => transcript.sourceDeleted).length;
  const unavailable = sessions.some(({ transcript }) => transcript.warnings.includes("Source availability could not be checked; showing the last indexed facts."));
  const unsupported = sessions.filter(({ transcript }) => transcript.status === "unsupported").length;
  return [
    ...(retained ? [`${retained} sessions include source-deleted history; facts and prices are from their last successful ingest.`] : []),
    ...(unavailable ? ["Source availability could not be checked; showing the last indexed facts."] : []),
    ...(legacy ? [`${legacy} legacy session${legacy === 1 ? "" : "s"} cannot be correlated because Conductor recorded no provider session ID.`] : []),
    ...(unmatched ? [`${unmatched} session${unmatched === 1 ? "" : "s"} have a provider ID but no validated local transcript.`] : []),
    ...(unpriced ? [`${unpriced} sessions include models without a rate card.`] : []),
    ...(unsupported ? [`${unsupported} session${unsupported === 1 ? "" : "s"} have unsupported provider evidence.`] : []),
  ];
}
