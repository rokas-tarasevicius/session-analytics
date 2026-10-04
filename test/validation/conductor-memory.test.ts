import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("recovered history groups retain exact accounting within a 96 MB worker heap", { timeout: 120_000 }, async () => {
  const child = spawn(process.execPath, ["--max-old-space-size=96", new URL("../conductor-memory-worker.ts", import.meta.url).pathname], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.setEncoding("utf8").on("data", value => { output += value; });
  child.stderr.setEncoding("utf8").on("data", value => { errors += value; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, errors);
  assert.deepEqual(JSON.parse(output), { sessions: 120, calls: 144_000, inputTokens: 14_400_000, outputTokens: 144_000 });
});
