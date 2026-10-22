import { historyReport } from "./report/history.ts";
import { abbreviateLabels, reportTable, reportWidth, wrapReport } from "./report/format.ts";
import { AnalysisHeapLimitError } from "./analysis-process.ts";
import { analysisBooleanFlags, analysisValueFlags, analyzeOptionsFrom, assertRemoteAnalysis, machineHelp, OptionError, optionErrorMessage, pricingHelp, sourceHelp, argument, remoteBooleanFlags, remoteHelp, remoteValueFlags, type RemoteOptions } from "./options.ts";
import { remoteFor } from "./machines/config.ts";
import { stopOnOutputError, stopOnSignals, stopping } from "./processes.ts";
import { analyzeMachines } from "./remote.ts";
import { localIdentity } from "./machines/identity.ts";
import { assertSnapshotOptions, reportShare, reportInteropFailure, shareValueFlags } from "./interop/cli.ts";
import { loadMachineSnapshot } from "./interop/snapshot.ts";
import { InteropError } from "./interop/error.ts";
import { brand } from "./brand.ts";
import { version } from "./version.ts";
import { coveredValue, metricCoverage, metricEligible, type Metric } from "./public/providers.js";
import { localMachine, machineAge, machineReasons, machineTally, machineWarningSources } from "./public/machines.js";
import type { MachineAnalytics, MachineStatus } from "./types.ts";

const valueFlags = new Set([...analysisValueFlags, ...remoteValueFlags, ...shareValueFlags]);
const booleanFlags = new Set([...analysisBooleanFlags, ...remoteBooleanFlags, "--exclude-hidden", "--help", "--include-hidden", "--json", "--share", "--strict", "--identify-machine", "--version", "--no-additional-providers", "--offline"]);
import { indexErrorCode, indexErrorMessage } from "./store/errors.ts";
stopOnOutputError();
// A repeated value would otherwise be silently first-wins; only --remote adds up.
const given = new Set<string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (flag && valueFlags.has(flag) && flag !== "--remote" && given.has(flag)) {
    process.stderr.write(`Give ${flag} once.\n`);
    process.exit(2);
  }
  if (flag) given.add(flag);
  if (!flag?.startsWith("--") || (!valueFlags.has(flag) && !booleanFlags.has(flag))) {
    process.stderr.write("Unknown session analytics argument. Run session-analytics report --help.\n");
    process.exit(2);
  }
  if (valueFlags.has(flag)) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      process.stderr.write(`Session analytics argument ${flag} requires a value.\n`);
      process.exit(2);
    }
    index += 1;
  }
}

if (process.argv.includes("--help")) {
  process.stdout.write(`${brand.name} ${version}

Usage: ${brand.command} report [options]

By default, unions all local Codex, Claude, and Cursor session evidence across the machine. Conductor metadata is optional enrichment and hidden metadata records are included.
Also discovers Copilot CLI, OpenCode, Gemini CLI, Cursor SDK/transcript stores, and retained Conductor result summaries. Evidence fidelity is labeled.

Text wraps to the terminal width (COLUMNS overrides it; default 80 when piped).

Options:
  --json                 Print the content-free snapshot as JSON
  --strict               Exit 3 when another machine was not read now (failed, or only its last good snapshot was used)
  --identify-machine     With --json --no-remote: list this machine with a hash of its machine ID and account,
                         so a reading machine can tell when it reaches the same one twice
  --snapshot FILE        Read a versioned snapshot instead of scanning local stores
  --share                Preview aggregate-only sharing JSON; no network request
  --min-sessions N       Minimum distinct sessions per shared repository (default 5, minimum 2)
  --share-key-file FILE  Private machine key (created if absent); keep it local
  --share-aliases FILE   JSON map of local repository IDs to explicit shared aliases
  --exclude-hidden       Exclude hidden optional repository/session metadata
  --repo-id ID           Narrow to one stable repository ID
  --repo-name NAME       Narrow to one uniquely named repository
  --repo-root PATH       Narrow by canonical repository root
  --repo-remote URL      Narrow by canonical Git remote
${sourceHelp}${pricingHelp}${machineHelp}${remoteHelp}  --no-index             Full scan without reading or writing the index
  --version              Print the version
  --help                 Show this help
`);
  process.exit(0);
}
if (process.argv.includes("--version")) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" }).format(
    value,
  );
}

function dollars(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

stopOnSignals();
let analyzeOptions;
// A saved snapshot never scans, and a share describes this machine alone, so neither reads other machines.
let remote: RemoteOptions = { machines: [], timeoutMs: 0, digest: null, local: "this machine" };
try {
  analyzeOptions = analyzeOptionsFrom(process.argv, process.env);
  if (process.argv.includes("--share") && (process.argv.includes("--remote") || process.argv.includes("--machines"))) {
    throw new OptionError("report --share describes this machine only; share from each machine and merge the files.");
  }
  if (!argument(process.argv, "--snapshot") && !process.argv.includes("--share")) {
    remote = remoteFor(process.argv, process.env, analyzeOptions, (line) => process.stderr.write(`${line}\n`));
    assertRemoteAnalysis(analyzeOptions, remote);
  }
  if (process.argv.includes("--identify-machine") && (!process.argv.includes("--json") || !process.argv.includes("--no-remote") || argument(process.argv, "--snapshot") || process.argv.includes("--share"))) {
    throw new OptionError("--identify-machine describes this machine's own scan; use it with --json --no-remote.");
  }
} catch (error) { process.stderr.write(`${optionErrorMessage(error)}\n`); process.exit(2); }

try {
  assertSnapshotOptions(process.argv);
  if (!process.argv.includes("--share") && shareValueFlags.slice(1).some((flag) => process.argv.includes(flag))) throw new InteropError("Sharing options require --share.");
  if (process.argv.includes("--share")) {
    await reportShare(process.argv);
  }
} catch (error) { reportInteropFailure(error); process.exit(1); }
const snapshotFile = argument(process.argv, "--snapshot");
let analytics: MachineAnalytics | null;
const started = performance.now();
try { analytics = process.argv.includes("--share") ? null : await (snapshotFile ? loadMachineSnapshot(snapshotFile) : analyzeMachines(analyzeOptions, remote, (line) => process.stderr.write(`${line}\n`))); }
catch (error) {
  // A signal stopped the analysis; its handler exits once the children are gone.
  if (stopping()) await new Promise(() => {});
  process.stderr.write(`${indexErrorMessage(indexErrorCode(error)) ?? (error instanceof AnalysisHeapLimitError ? error.message : "Session analysis could not be completed.")}\n`);
  process.exit(1);
}

if (analytics?.rateCard.pricing?.stale && !analytics.rateCard.pricing.offline) {
  process.stderr.write(`Pricing cache is stale or missing. Run ${brand.command} rates update to refresh public prices.\n`);
}
const metricValue = (value: number, metric: Metric, format = compactNumber, sessions = analytics?.sessions ?? []): string => coveredValue(value, metricCoverage(sessions, metric), format);

if (analytics && process.argv.includes("--identify-machine")) {
  analytics = { ...analytics, machines: [{ key: localMachine, label: remote.local, state: "ok" as const, sessions: analytics.summary.sessions, repositories: analytics.summary.repositories,
    readAt: analytics.generatedAt, durationMs: Math.round(performance.now() - started), version, identity: localIdentity() }] };
}
const machines = analytics?.machines && analytics.machines.length > 1 ? analytics.machines : null;

/** Which machines the report covers, with counts and timing, and each one not read now with its reason and fix. */
function machineLines(list: MachineStatus[]): string {
  const width = Math.max(...list.map(({ label }) => label.length)), { ok, stale, reading, total } = machineTally(list);
  const lines = [`Machines: ${ok} of ${total} read now${stale ? `, ${stale} from a last good snapshot` : ""}${reading ? `, ${reading} still reading when this snapshot was made` : ""}`];
  for (const machine of list) {
    const reason = machine.reason ? machineReasons[machine.reason] : "", counts = `${machine.sessions} sessions, ${machine.repositories} repositories`;
    lines.push(`  ${machine.label.padEnd(width)}  ${machine.state === "failed" ? `not read: ${reason}`
      : machine.state === "stale" ? `${reason}; its last good snapshot from ${machineAge(machine.readAt) ?? "an earlier read"} (${counts})`
      : machine.state === "reading" ? (machine.readAt ? `still reading; its last good snapshot from ${machineAge(machine.readAt) ?? "an earlier read"} (${counts})` : "still reading; not included")
      : `${counts}${machine.durationMs !== null ? ` in ${(machine.durationMs / 1000).toFixed(1)} s` : ""}${reason ? ` (${reason})` : ""}`}`);
    if (machine.fix) lines.push(`    Fix: ${machine.fix}`);
  }
  return `${lines.join("\n")}\n`;
}

if (analytics && process.argv.includes("--json")) {
  // A reading machine's runtime answers compactly; a person or a file gets the indented form.
  process.stdout.write(`${JSON.stringify(analytics, null, process.argv.includes("--identify-machine") ? undefined : 2)}\n`);
} else if (analytics) {
  const width = reportWidth(process.env, process.stdout.columns);
  const write = (text: string): void => { process.stdout.write(wrapReport(text, width)); };
  // A machine still reading when a saved dashboard snapshot was made counts with its last good snapshot, like a stale one.
  const shown = ({ state, readAt }: MachineStatus): boolean => state === "ok" || state === "stale" || (state === "reading" && readAt !== null);
  const counted = machines?.filter(shown).map(({ label, state }) => state === "ok" ? label : `${label} (${state})`) ?? [];
  const missing = machines?.filter((machine) => !shown(machine)).map(({ label }) => label) ?? [];
  const names = counted.length > 1 ? `${counted.slice(0, -1).join(", ")} and ${counted.at(-1)}` : counted[0];
  write(`${brand.name} · ${machines ? `${names}${missing.length ? ` (not read: ${missing.join(", ")})` : ""}` : "all locally evidenced repositories"}\n`);
  write(`Generated: ${analytics.generatedAt}\n`);
  if (machines) write(machineLines(machines));
  write(
    `Repositories: ${analytics.summary.repositoriesWithSessions}/${analytics.summary.repositories} with sessions\n`,
  );
  write(
    `Sessions: ${analytics.summary.analyzedSessions}/${analytics.summary.sessions} analyzed\n`,
  );
  const summarySessions = analytics.sessions.filter((session) => session.evidence?.fidelity === "summary").length;
  const activitySessions = analytics.sessions.filter((session) => session.evidence?.fidelity === "activity-only").length;
  const fileDates = analytics.sessions.filter((session) => session.evidence?.timing === "file-mtime").length;
  if (summarySessions || activitySessions) write(`Evidence: ${summarySessions}/${analytics.summary.sessions} summary-only, ${activitySessions}/${analytics.summary.sessions} activity-only; ${fileDates} file-modification dates (start unknown). Unavailable metrics are N/A.\n`);
  const partial = analytics.sessions.filter((session) => session.evidence?.accounting === "partial").length;
  if (partial) write(`Accounting: ${partial}/${analytics.sessions.length} sessions have partial retained totals.\n`);
  write("\nRepository comparison\n");
  const repositoryRows = [...analytics.repositories].sort(
    (left, right) => right.summary.estimatedSpendUsd - left.summary.estimatedSpendUsd,
  ).map((repository) => {
    const sessions = analytics.sessions.filter((s) => s.repositoryId === repository.repository.id);
    return [repository.repository.name, String(repository.summary.sessions),
      metricValue(repository.summary.estimatedSpendUsd, "cost", dollars, sessions),
      metricValue(repository.summary.totalInputTokens, "tokens", compactNumber, sessions)];
  });
  write(reportTable(["Repository", "Sessions", "Priced value", "Input tokens"], repositoryRows, width, [1, 2, 3]));
  write(
    `Priced usage value: ${metricValue(analytics.summary.estimatedSpendUsd, "cost", dollars)} (not an invoice)\n` +
      `  API list-price equivalent: ${metricValue(analytics.summary.apiEquivalentSpendUsd, "apiCost", dollars)}\n` +
      `  Provider-reported local value: ${metricValue(analytics.summary.providerReportedSpendUsd, "reportedCost", dollars)}\n` +
      `  Sub-agent contribution: ${metricValue(analytics.summary.subagentSpendUsd, "cost", dollars, analytics.sessions.filter((s) => ["subagent", "mixed"].includes(s.executionKind)))}\n`,
  );
  write(
    `Tokens: ${metricValue(analytics.summary.totalInputTokens, "tokens")} input, ` +
      `${metricValue(analytics.summary.outputTokens, "tokens")} output\n`,
  );
  write(
    `Cache reads: ${analytics.summary.cacheReadRatio !== null ? metricValue(analytics.summary.cacheReadRatio, "tokens", (value) => `${(value * 100).toFixed(1)}%`) : "N/A"}; ` +
      `tools: ${metricValue(analytics.summary.toolCalls, "tools")}; ` +
      `compactions: ${metricValue(analytics.sessions.filter((s) => metricEligible(s, "compactions")).reduce((n, s) => n + s.metrics.compactions, 0), "compactions")}\n`,
  );
  write(historyReport(analytics));
  write("\nTop sessions by priced usage value\n");
  const topSessions = analytics.sessions.filter((s) => metricEligible(s, "cost"))
    .sort((left, right) => right.cost.totalUsd - left.cost.totalUsd)
    .slice(0, 15);
  const modelLabels = abbreviateLabels(topSessions.map((session) => session.models.map(({ model }) => model).join(", ") || "unknown model"), 20);
  const sessionRows = topSessions.map((session, index) => [session.sessionKey, dollars(session.cost.totalUsd), session.provider, modelLabels[index]!]);
  write(reportTable(["Session", "Priced value", "Provider", "Model"], sessionRows, width, [1]));
  if (analytics.warnings.length > 0) {
    write("\nWarnings\n");
    for (const warning of machineWarningSources(analytics.machines, analytics.warnings)) write(`- ${warning}\n`);
  }
}
const unread = machines?.filter(({ state }) => state !== "ok") ?? [];
if (process.argv.includes("--strict") && unread.length) {
  process.stderr.write(`--strict: ${unread.map(({ label }) => label).join(", ")} ${unread.length === 1 ? "was" : "were"} not read now; exiting with 3.\n`);
  process.exitCode = 3;
}
