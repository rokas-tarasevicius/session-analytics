import { historyReport } from "./report/history.ts";
import { AnalysisHeapLimitError, analyzeMachineSessionsIsolated } from "./analysis-process.ts";
import { analysisBooleanFlags, analysisValueFlags, analyzeOptionsFrom, pricingHelp, argument } from "./options.ts";
import { outcomeReport } from "./metrics/outcomes-report.ts";
import { workflowReport } from "./report/workflow.ts";
import { assertSnapshotOptions, reportShare, reportInteropFailure, shareValueFlags } from "./interop/cli.ts";
import { loadMachineSnapshot } from "./interop/snapshot.ts";
import { InteropError } from "./interop/error.ts";
import { brand } from "./brand.ts";
import { version } from "./version.ts";
import { coveredValue, metricCoverage, metricEligible, type Metric } from "./public/providers.js";

import { limitsCacheReport } from "./metrics/limits-report.ts";

const valueFlags = new Set([...analysisValueFlags, ...shareValueFlags]);
const booleanFlags = new Set([...analysisBooleanFlags, "--exclude-hidden", "--help", "--include-hidden", "--json", "--share", "--version", "--no-additional-providers", "--offline"]);
import { reliabilityReport } from "./metrics/reliability-report.ts";
import { indexErrorCode, indexErrorMessage } from "./store/errors.ts";
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (!flag?.startsWith("--") || (!valueFlags.has(flag) && !booleanFlags.has(flag))) {
    process.stderr.write(`Unknown session analytics argument: ${flag ?? "<missing>"}\n`);
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

Options:
  --json                 Print the content-free snapshot as JSON
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
  --database PATH        Override the optional Conductor metadata database
  --codex-root PATH      Override the Codex transcript root
  --codex-archive-root PATH Override the archived Codex transcript root
  --claude-root PATH     Override the Claude transcript root
  --cursor-database PATH Override the Cursor local history database
  --cursor-sdk-root PATH Override the Conductor Cursor SDK store
  --cursor-transcript-root PATH Override Cursor's projects directory
  --copilot-root PATH    Override Copilot's session-state directory
  --opencode-database PATH Override the OpenCode SQLite database
  --gemini-root PATH     Override Gemini's tmp directory
  --no-additional-providers Disable new-source discovery (explicit paths still apply)
  --rate-card PATH       Override the reviewed rate card
${pricingHelp}
  --reliability-content-rules Enable local content rules for errors, shell classes and behavior (P2)
  --no-reliability-content-rules Disable those rules, including when enabled by environment

  --outcomes-git         Opt in to bounded local Git outcome correlation
  --outcomes-github      Opt in to GitHub PR state queries through authenticated gh
  --no-outcomes-git      Disable Git enrichment (overrides environment)
  --no-outcomes-github   Disable GitHub enrichment (overrides environment)
  --workflow-content-rules Enable local Claude interruption marker counts (P2)
  --no-workflow-content-rules Disable those rules, including an environment opt-in
  --no-index             Full scan without reading or writing the index
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

let analyzeOptions;
try { analyzeOptions = analyzeOptionsFrom(process.argv, process.env); }
catch { process.stderr.write("Invalid pricing configuration.\n"); process.exit(2); }

try {
  assertSnapshotOptions(process.argv);
  if (!process.argv.includes("--share") && shareValueFlags.slice(1).some((flag) => process.argv.includes(flag))) throw new InteropError("Sharing options require --share.");
  if (process.argv.includes("--share")) {
    await reportShare(process.argv);
  }
} catch (error) { reportInteropFailure(error); process.exit(1); }
const snapshotFile = argument(process.argv, "--snapshot");
let analytics;
try { analytics = process.argv.includes("--share") ? null : await (snapshotFile ? loadMachineSnapshot(snapshotFile) : analyzeMachineSessionsIsolated(analyzeOptions)); }
catch (error) {
  process.stderr.write(`${indexErrorMessage(indexErrorCode(error)) ?? (error instanceof AnalysisHeapLimitError ? error.message : "Session analysis could not be completed.")}\n`);
  process.exit(1);
}

if (analytics?.rateCard.pricing?.stale && !analytics.rateCard.pricing.offline) {
  process.stderr.write(`Pricing cache is stale or missing. Run ${brand.command} rates update to refresh public prices.\n`);
}
const metricValue = (value: number, metric: Metric, format = compactNumber, sessions = analytics?.sessions ?? []): string => coveredValue(value, metricCoverage(sessions, metric), format);

if (analytics && process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(analytics, null, 2)}\n`);
} else if (analytics) {
  process.stdout.write(`${brand.name} · all locally evidenced repositories\n`);
  process.stdout.write(`Generated: ${analytics.generatedAt}\n`);
  process.stdout.write(
    `Repositories: ${analytics.summary.repositoriesWithSessions}/${analytics.summary.repositories} with sessions\n`,
  );
  process.stdout.write(
    `Sessions: ${analytics.summary.analyzedSessions}/${analytics.summary.sessions} analyzed\n`,
  );
  const summarySessions = analytics.sessions.filter((session) => session.evidence?.fidelity === "summary").length;
  const activitySessions = analytics.sessions.filter((session) => session.evidence?.fidelity === "activity-only").length;
  const fileDates = analytics.sessions.filter((session) => session.evidence?.timing === "file-mtime").length;
  if (summarySessions || activitySessions) process.stdout.write(`Evidence: ${summarySessions}/${analytics.summary.sessions} summary-only, ${activitySessions}/${analytics.summary.sessions} activity-only; ${fileDates} file-modification dates (start unknown). Unavailable metrics are N/A.\n`);
  const partial = analytics.sessions.filter((session) => session.evidence?.accounting === "partial").length;
  if (partial) process.stdout.write(`Accounting: ${partial}/${analytics.sessions.length} sessions have partial retained totals.\n`);
  process.stdout.write("\nRepository comparison\n");
  for (const repository of [...analytics.repositories].sort(
    (left, right) => right.summary.estimatedSpendUsd - left.summary.estimatedSpendUsd,
  )) {
    const sessions = analytics.sessions.filter((s) => s.repositoryId === repository.repository.id);
    process.stdout.write(
      `${metricValue(repository.summary.estimatedSpendUsd, "cost", dollars, sessions).padStart(10)}  ` +
        `${String(repository.summary.sessions).padStart(4)} sessions  ` +
        `${metricValue(repository.summary.totalInputTokens, "tokens", compactNumber, sessions).padStart(7)} input  ` +
        `${repository.repository.name}\n`,
    );
  }
  process.stdout.write(
    `Priced usage value: ${metricValue(analytics.summary.estimatedSpendUsd, "cost", dollars)} (not an invoice)\n` +
      `  API list-price equivalent: ${metricValue(analytics.summary.apiEquivalentSpendUsd, "apiCost", dollars)}\n` +
      `  Provider-reported local value: ${metricValue(analytics.summary.providerReportedSpendUsd, "reportedCost", dollars)}\n` +
      `  Sub-agent contribution: ${metricValue(analytics.summary.subagentSpendUsd, "cost", dollars, analytics.sessions.filter((s) => ["subagent", "mixed"].includes(s.executionKind)))}\n`,
  );
  process.stdout.write(
    `Tokens: ${metricValue(analytics.summary.totalInputTokens, "tokens")} input, ` +
      `${metricValue(analytics.summary.outputTokens, "tokens")} output\n`,
  );
  process.stdout.write(
    `Cache reads: ${analytics.summary.cacheReadRatio !== null ? metricValue(analytics.summary.cacheReadRatio, "tokens", (value) => `${(value * 100).toFixed(1)}%`) : "N/A"}; ` +
      `tools: ${metricValue(analytics.summary.toolCalls, "tools")}; ` +
      `compactions: ${metricValue(analytics.sessions.filter((s) => metricEligible(s, "compactions")).reduce((n, s) => n + s.metrics.compactions, 0), "compactions")}\n`,
  );
  process.stdout.write(historyReport(analytics));
  process.stdout.write(limitsCacheReport(analytics));
  process.stdout.write(outcomeReport(analytics.sessions));
  if (analytics.workflow) process.stdout.write(workflowReport(analytics.workflow, analytics.repositories));
  process.stdout.write("\nTop sessions by priced usage value\n");
  for (const session of analytics.sessions.filter((s) => metricEligible(s, "cost"))
    .sort((left, right) => right.cost.totalUsd - left.cost.totalUsd)
    .slice(0, 15)) {
    const model = session.models.map(({ model: name }) => name).join(", ") || "unknown model";
    process.stdout.write(
      `${dollars(session.cost.totalUsd).padStart(10)}  ${session.provider.padEnd(6)}  ` +
        `${model.padEnd(20).slice(0, 20)}  Session ${session.sessionKey}\n`,
    );
  }
  process.stdout.write(reliabilityReport(analytics.sessions));
  if (analytics.warnings.length > 0) {
    process.stdout.write("\nWarnings\n");
    for (const warning of analytics.warnings) process.stdout.write(`- ${warning}\n`);
  }
}
