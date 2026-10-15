import { analyzeMachineSessions } from "../analyzer.ts";
import type { AnalyzeOptions } from "../types.ts";
import { indexErrorCode } from "../store/errors.ts";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
try {
  const options = JSON.parse(input) as AnalyzeOptions;
  const analytics = await analyzeMachineSessions(options);
  process.stdout.write(JSON.stringify({ analytics }));
} catch (error) {
  process.stdout.write(JSON.stringify({ analysisError: indexErrorCode(error) }));
  process.exitCode = 1;
}
