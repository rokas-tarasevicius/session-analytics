import { analyzeMachineSessions } from "./analyzer.ts";
import type { AnalyzeOptions } from "./types.ts";
import { indexErrorCode } from "./store/errors.ts";
import { writeAnalysisSnapshot } from "./analysis-output.ts";
import { stopOnSignals } from "./processes.ts";
import { progressReporter } from "./scan-progress.ts";
import { fullParseSignal } from "./analysis-process.ts";

// A parent that stops this worker stops its Cursor worker too, rather than leave it scanning.
stopOnSignals();

let serializedInput = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) serializedInput += chunk;
const options = JSON.parse(serializedInput) as AnalyzeOptions;
const progress = progressReporter((line) => process.stderr.write(line));
try {
  // The parent reads this line on stderr and decides whether a person should hear about it.
  const snapshot = await analyzeMachineSessions(options, {
    onFullParse: () => process.stderr.write(`${fullParseSignal}\n`), onProgress: progress.update,
  });
  progress.finish();
  await writeAnalysisSnapshot(snapshot, process.stdout);
} catch (error) {
  process.stdout.write(JSON.stringify({ analysisError: indexErrorCode(error) ?? "analysis-unavailable" }));
  process.exitCode = 1;
}
