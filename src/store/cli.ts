import { analyzeMachineSessionsIsolated } from "../analysis-process.ts";
import { brand } from "../brand.ts";
import { analysisBooleanFlags, analysisValueFlags, analyzeOptionsFrom, argument } from "../options.ts";
import { indexPath, indexStatus, pruneIndex, resetIndex } from "./database.ts";

const [action, ...args] = process.argv.slice(2);
function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`); process.exit(code);
}
if (!action || action === "--help" || args.includes("--help")) {
  process.stdout.write(`Usage: ${brand.command} index <action> [options]

  status [--json]       Show schema, retained history counts, and the last ingest statistics
  path                 Print the local index database path (management output only)
  rebuild              Discard the old index and scan the configured sources again
  prune --before DATE  Remove sessions last active before YYYY-MM-DD (UTC); keep this retention floor

All actions accept --data-dir PATH or SESSION_ANALYTICS_DATA_DIR.
Rebuild accepts the same provider and rate-card options as report. Rebuild resets the retention floor
and loses source-deleted history; --no-index bypasses the index for dashboard/report.
`);
  process.exit(0);
}
if (!["status", "path", "rebuild", "prune"].includes(action)) fail("Unknown index action. Use index --help.");
const valueFlags = new Set(action === "rebuild" ? analysisValueFlags.filter((flag) => !flag.startsWith("--repo-")) : ["--data-dir", ...(action === "prune" ? ["--before"] : [])]);
const booleanFlags = new Set(action === "status" ? ["--json"] : action === "rebuild" ? [...analysisBooleanFlags.filter((flag) => flag !== "--no-index"), "--exclude-hidden", "--include-hidden"] : []);
for (let i = 0; i < args.length; i += 1) {
  const flag = args[i] as string;
  if (valueFlags.has(flag)) {
    if (!args[i + 1] || args[i + 1]?.startsWith("--")) fail("An index option requires a value. Use index --help.");
    i += 1;
  } else if (!booleanFlags.has(flag)) fail("Unknown index option. Use index --help.");
}
const options = analyzeOptionsFrom(args, process.env);
try {
  if (action === "path") process.stdout.write(`${indexPath(options)}\n`);
  else if (action === "prune") {
    const before = argument(args, "--before");
    if (!before) fail("Prune requires --before YYYY-MM-DD.");
    process.stdout.write(`Pruned ${pruneIndex(before, options)} indexed sessions. The retention floor applies to future indexed scans.\n`);
  } else {
    if (action === "rebuild") {
      resetIndex(options);
      await analyzeMachineSessionsIsolated({ ...options, noIndex: false });
    }
    const status = indexStatus(options);
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    else {
      process.stdout.write(`Index: ${status.state}\nSchema: ${status.schemaVersion ?? "none"}\nSessions: ${status.sessions} (${status.sourceDeletedSessions} source-deleted)\nEvidence files: ${status.evidenceFiles}\nSource scopes: ${status.scopes}\nDatabase bytes: ${status.databaseBytes}\n`);
      if (status.lastScan) process.stdout.write(`Last ingest: ${status.lastScan.completedAt}; ${status.lastScan.reusedSessions} reused, ${status.lastScan.parsedSessions} parsed, ${status.lastScan.retainedSessions} retained; ${status.lastScan.elapsedMilliseconds} ms\n`);
    }
    if (status.state === "corrupt" || status.state === "incompatible") process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  fail(message.startsWith("The local index") || message.startsWith("Prune requires")
    ? message : "Index operation failed without exposing local error details. Use --no-index to bypass it.", 1);
}
