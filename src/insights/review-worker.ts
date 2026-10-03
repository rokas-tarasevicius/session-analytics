import { reviewSession } from "./review.ts";
import type { ReviewRequest } from "./review.ts";

try {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 65_536) throw new Error("Invalid request."); }
  process.stdout.write(JSON.stringify(await reviewSession(JSON.parse(input) as ReviewRequest)));
} catch {
  process.stderr.write("Session review could not be completed.\n");
  process.exitCode = 1;
}
