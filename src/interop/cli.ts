import { InteropError } from "./error.ts";
import { brand } from "../brand.ts";
import { analysisBooleanFlags, analysisValueFlags, analyzeOptionsFrom, argument, assertRemoteAnalysis, OptionError, remoteBooleanFlags, remoteHelp, remoteValueFlags } from "../options.ts";
import { remoteFor } from "../machines/config.ts";
import { stopOnSignals, stopping } from "../processes.ts";
import { analyzeMachines } from "../remote.ts";
import { analyzeMachineSessionsIsolated } from "../analysis-process.ts";
import { readJsonFile, writeNewFile, writeNewFiles } from "./files.ts";
import { exportFiles, type ExportFormat } from "./exports.ts";
import { otlpEndpoint, postOtlp } from "./otlp.ts";
import { loadMachineSnapshot, validateSnapshot } from "./snapshot.ts";
import { combineSnapshots } from "./combine.ts";
import { defaultShareKeyPath, loadShareKey, mergeSharedSnapshots, readAliases, shareSnapshot } from "./sharing.ts";
import type { MachineAnalytics, SharedSnapshot } from "../types.ts";
import { sharedEvidenceCaveat } from "../public/evidence.js";

export const shareValueFlags = ["--snapshot", "--min-sessions", "--share-key-file", "--share-aliases"];

export function assertSnapshotOptions(argv: string[]): void {
  if (argv.includes("--snapshot") && ([...analysisValueFlags, ...analysisBooleanFlags, ...remoteValueFlags].some((flag) => argv.includes(flag)) || argv.includes("--exclude-hidden") || argv.includes("--include-hidden"))) throw new InteropError("Snapshot input cannot be combined with analysis flags.");
}

/** This machine plus other machines, unless the result describes this machine alone. Progress goes to stderr; stdout stays the payload. */
async function analyzeFrom(argv: string[], thisMachineOnly = false): Promise<MachineAnalytics> {
  const options = analyzeOptionsFrom(argv, process.env);
  if (thisMachineOnly) return await analyzeMachineSessionsIsolated(options);
  const remote = remoteFor(argv, process.env, options, (line) => process.stderr.write(`${line}\n`));
  assertRemoteAnalysis(options, remote);
  stopOnSignals();
  return await analyzeMachines(options, remote, (line) => process.stderr.write(`${line}\n`));
}

export async function reportShare(argv: string[]): Promise<void> {
  assertSnapshotOptions(argv);
  const rawMinimum = argument(argv, "--min-sessions") ?? "5";
  const minimum = Number(rawMinimum);
  if (!/^\d+$/.test(rawMinimum) || !Number.isSafeInteger(minimum) || minimum < 2) throw new InteropError("--min-sessions must be an integer of at least 2.");
  const keyPath = argument(argv, "--share-key-file") ?? process.env["SESSION_ANALYTICS_SHARE_KEY_FILE"] ?? defaultShareKeyPath();
  const secret = await loadShareKey(keyPath);
  const aliasPath = argument(argv, "--share-aliases");
  const aliases = aliasPath ? await readAliases(aliasPath) : {};
  const path = argument(argv, "--snapshot");
  // One source ID covers what is shared, so other machines share their own and merge detects overlap.
  const snapshot = path ? await loadMachineSnapshot(path) : await analyzeFrom(argv, true);
  if ((snapshot.machines?.length ?? 0) > 1) throw new InteropError("This snapshot combines several machines; share from each machine and merge the shared files.");
  const shared = shareSnapshot(snapshot, secret, minimum, aliases);
  process.stderr.write("Share preview: stdout is the entire aggregate payload. No data has been sent. Review aliases and counts before sharing this file.\n");
  process.stderr.write(`${sharedEvidenceCaveat}\n`);
  process.stdout.write(`${JSON.stringify(shared, null, 2)}\n`);
}

export async function runInterop(command: "export" | "merge", argv: string[]): Promise<void> {
  const valueFlags = new Set(command === "export" ? [...analysisValueFlags, ...remoteValueFlags, "--format", "--out", "--snapshot", "--otlp-endpoint"] : ["--out"]);
  const booleanFlags = new Set(command === "export" ? [...analysisBooleanFlags, ...remoteBooleanFlags, "--help", "--exclude-hidden", "--include-hidden", "--strict"] : ["--help"]);
  const inputs: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (command === "merge" && !flag.startsWith("-")) { inputs.push(flag); continue; }
    if ((!valueFlags.has(flag) && !booleanFlags.has(flag)) || (seen.has(flag) && flag !== "--remote")) throw new InteropError("Unknown or repeated interchange argument.");
    seen.add(flag);
    if (valueFlags.has(flag)) {
      if (!argv[index + 1] || argv[index + 1]!.startsWith("--")) throw new InteropError("An interchange argument requires a value.");
      index++;
    }
  }
  if (argv.includes("--help")) {
    process.stdout.write(command === "export" ? `${brand.command} export --format csv|ndjson|otlp-json --out DIR [analysis options | --snapshot FILE]\n  --otlp-endpoint URL  Explicitly POST otlp-logs.json to this full /v1/logs URL after saving locally.\n  --strict             Exit 3 after saving when another machine was not read now\n${remoteHelp}` : `${brand.command} merge FILE... [--out FILE]\nCombine disjoint shared sources using the same threshold, or full snapshots from several machines\n(create each with report --json --portable-ids --time-zone ZONE). stdout is the default. Existing files are never overwritten.\n`);
    return;
  }
  if (command === "merge") {
    if (!inputs.length) throw new InteropError("Merge requires snapshot files.");
    const shared = (value: unknown): boolean => Boolean(value && typeof value === "object" && "kind" in value);
    const mixed = (): never => { throw new InteropError("Merge inputs must be all full snapshots or all shared snapshots."); };
    let result: SharedSnapshot | MachineAnalytics | undefined;
    const first = await readJsonFile(inputs[0]!);
    if (shared(first)) {
      // Release each input after folding it, rather than retaining every file at once.
      for (const [index, path] of inputs.entries()) {
        const next = index ? await readJsonFile(path) : first;
        if (!shared(next)) mixed();
        result = mergeSharedSnapshots(result ? [result, next] : [next]);
      }
    } else {
      // Full snapshots keep their sessions, which deduplicate only against the complete union.
      const snapshots = [validateSnapshot(first)];
      for (const path of inputs.slice(1)) {
        const next = await readJsonFile(path);
        if (shared(next)) mixed();
        snapshots.push(validateSnapshot(next));
      }
      result = combineSnapshots(snapshots);
    }
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    const output = argument(argv, "--out");
    if (output) await writeNewFile(output, serialized); else process.stdout.write(serialized);
    return;
  }
  assertSnapshotOptions(argv);
  const format = argument(argv, "--format") as ExportFormat | undefined;
  const output = argument(argv, "--out");
  if (!format || !["csv", "ndjson", "otlp-json"].includes(format) || !output) throw new InteropError("Export requires --format csv|ndjson|otlp-json and --out DIR.");
  const rawEndpoint = argument(argv, "--otlp-endpoint");
  if (rawEndpoint && format !== "otlp-json") throw new InteropError("--otlp-endpoint requires --format otlp-json.");
  const endpoint = rawEndpoint ? otlpEndpoint(rawEndpoint) : null;
  const input = argument(argv, "--snapshot");
  const snapshot = input ? await loadMachineSnapshot(input) : await analyzeFrom(argv);
  const files = exportFiles(snapshot, format);
  await writeNewFiles(output, files);
  process.stderr.write(`Saved ${Object.keys(files).join(", ")}. API-equivalent value is not an invoice.\n`);
  if (endpoint) {
    await postOtlp(endpoint, files["otlp-logs.json"]!);
    process.stderr.write("OTLP collector acknowledged the saved payload.\n");
  }
  const unread = (snapshot.machines ?? []).filter(({ state }) => state === "failed" || state === "stale");
  if (argv.includes("--strict") && unread.length) {
    process.stderr.write(`--strict: ${unread.map(({ label }) => label).join(", ")} ${unread.length === 1 ? "was" : "were"} not read now; exiting with 3.\n`);
    process.exitCode = 3;
  }
}

/** Fixed error text only; filesystem and remote errors may contain private data. */
export function reportInteropFailure(error?: unknown): void {
  // A signal stopped the work; its handler sets the exit code.
  if (stopping()) return;
  process.stderr.write((error instanceof InteropError || error instanceof OptionError) && error.message ? `${error.message}\n` : "Interchange failed: the input or output file could not be accessed safely.\n");
  process.exitCode = 1;
}
