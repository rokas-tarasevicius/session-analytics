import { analyzeMachineSessions } from "./analyzer.ts";
import type { AnalyzeOptions } from "./types.ts";
import { indexErrorCode } from "./store/errors.ts";

let serializedInput = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) serializedInput += chunk;
const options = JSON.parse(serializedInput) as AnalyzeOptions;
try {
  process.stdout.write(JSON.stringify(await analyzeMachineSessions(options)));
} catch (error) {
  process.stdout.write(JSON.stringify({ analysisError: indexErrorCode(error) ?? "analysis-unavailable" }));
  process.exitCode = 1;
}
