import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("review: aggregate retained-state and hashing budgets leave capped-worker heap headroom", async (t) => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=256", "--expose-gc", fileURLToPath(new URL("./reliability-stress-worker.ts", import.meta.url))], { timeout: 30_000 });
  const result = JSON.parse(stdout);
  assert.equal(result.truncated, true); assert.equal(result.calls, 2250);
  t.diagnostic(stdout.trim());
});
