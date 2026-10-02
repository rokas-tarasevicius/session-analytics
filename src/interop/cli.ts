import { InteropError } from "./error.ts";
import { analyzeMachineSessionsIsolated } from "../analysis-process.ts";
import { brand } from "../brand.ts";
import { analysisValueFlags, analyzeOptionsFrom, argument } from "../options.ts";
import { readJsonFile, writeNewFile, writeNewFiles } from "./files.ts";
import { exportFiles, type ExportFormat } from "./exports.ts";
import { otlpEndpoint, postOtlp } from "./otlp.ts";
import { loadMachineSnapshot } from "./snapshot.ts";
import { defaultShareKeyPath, loadShareKey, mergeSharedSnapshots, readAliases, shareSnapshot } from "./sharing.ts";
import type { SharedSnapshot } from "../types.ts";

export const shareValueFlags = ["--snapshot", "--min-sessions", "--share-key-file", "--share-aliases"];

export function assertSnapshotOptions(argv: string[]): void {
  if (argv.includes("--snapshot") && (analysisValueFlags.some((flag) => argv.includes(flag)) || argv.includes("--exclude-hidden") || argv.includes("--include-hidden"))) throw new InteropError("Snapshot input cannot be combined with analysis flags.");
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
  const snapshot = path ? await loadMachineSnapshot(path) : await analyzeMachineSessionsIsolated(analyzeOptionsFrom(argv, process.env));
  const shared = shareSnapshot(snapshot, secret, minimum, aliases);
  process.stderr.write("Share preview: stdout is the entire aggregate payload. No data has been sent. Review aliases and counts before sharing this file.\n");
  process.stdout.write(`${JSON.stringify(shared, null, 2)}\n`);
}

export async function runInterop(command: "export" | "merge", argv: string[]): Promise<void> {
  const valueFlags = new Set(command === "export" ? [...analysisValueFlags, "--format", "--out", "--snapshot", "--otlp-endpoint"] : ["--out"]);
  const booleanFlags = new Set(command === "export" ? ["--help", "--exclude-hidden", "--include-hidden"] : ["--help"]);
  const inputs: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (command === "merge" && !flag.startsWith("-")) { inputs.push(flag); continue; }
    if ((!valueFlags.has(flag) && !booleanFlags.has(flag)) || seen.has(flag)) throw new InteropError("Unknown or repeated interchange argument.");
    seen.add(flag);
    if (valueFlags.has(flag)) {
      if (!argv[index + 1] || argv[index + 1]!.startsWith("--")) throw new InteropError("An interchange argument requires a value.");
      index++;
    }
  }
  if (argv.includes("--help")) {
    process.stdout.write(command === "export" ? `${brand.command} export --format csv|ndjson|otlp-json --out DIR [analysis options | --snapshot FILE]\n  --otlp-endpoint URL  Explicitly POST otlp-logs.json to this full /v1/logs URL after saving locally.\n` : `${brand.command} merge FILE... [--out FILE]\nCombine disjoint shared sources using the same threshold; stdout is the default. Existing files are never overwritten.\n`);
    return;
  }
  if (command === "merge") {
    if (!inputs.length) throw new InteropError("Merge requires shared snapshot files.");
    let result: SharedSnapshot | undefined;
    // Release each input after folding it, rather than retaining every file at once.
    for (const path of inputs) {
      const next = await readJsonFile(path);
      result = mergeSharedSnapshots(result ? [result, next] : [next]);
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
  const snapshot = input ? await loadMachineSnapshot(input) : await analyzeMachineSessionsIsolated(analyzeOptionsFrom(argv, process.env));
  const files = exportFiles(snapshot, format);
  await writeNewFiles(output, files);
  process.stderr.write(`Saved ${Object.keys(files).join(", ")}. API-equivalent value is not an invoice.\n`);
  if (endpoint) {
    await postOtlp(endpoint, files["otlp-logs.json"]!);
    process.stderr.write("OTLP collector acknowledged the saved payload.\n");
  }
}

/** Fixed error text only; filesystem and remote errors may contain private data. */
export function reportInteropFailure(error?: unknown): void {
  process.stderr.write(error instanceof InteropError && error.message ? `${error.message}\n` : "Interchange failed: the input or output file could not be accessed safely.\n");
  process.exitCode = 1;
}
