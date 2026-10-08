import { analyzeMachineSessions } from "../analyzer.ts";
import type { AnalyzeOptions } from "../types.ts";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
try {
  const options = JSON.parse(input) as AnalyzeOptions;
  const analytics = await analyzeMachineSessions(options);
  process.stdout.write(JSON.stringify({ analytics }));
} catch {
  process.exitCode = 1;
}
