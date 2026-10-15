import { analyzeMachineSessions } from "./analyzer.ts";
import type { AnalyzeOptions } from "./types.ts";
import { indexErrorCode } from "./store/errors.ts";
import { writeAnalysisSnapshot } from "./analysis-output.ts";
import { stopOnSignals } from "./processes.ts";

// A parent that stops this worker stops its Cursor worker too, rather than leave it scanning.
stopOnSignals();

let serializedInput = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) serializedInput += chunk;
const options = JSON.parse(serializedInput) as AnalyzeOptions;
try {
  await writeAnalysisSnapshot(await analyzeMachineSessions(options), process.stdout);
} catch (error) {
  process.stdout.write(JSON.stringify({ analysisError: indexErrorCode(error) ?? "analysis-unavailable" }));
  process.exitCode = 1;
}
