import { analyzeMachineSessions } from "../analyzer.ts";
import type { AnalyzeOptions } from "../types.ts";
import { readInventory } from "./inventory.ts";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
try {
  const options = JSON.parse(input) as AnalyzeOptions;
  const analytics = await analyzeMachineSessions(options);
  const inventory = await readInventory(options);
  process.stdout.write(JSON.stringify({ analytics, inventory }));
} catch {
  process.exitCode = 1;
}
