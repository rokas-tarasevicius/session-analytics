import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

// Regression: a consumer such as head may close its pipe before the JSON report drains.
test("report exits quietly when its stdout pipe is closed", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "report-pipe-"));
  try {
    const snapshot = await analyzeMachineSessions({ ...await createSessionAnalyticsFixture(root), offline: true });
    const path = join(root, "snapshot.json");
    await writeFile(path, JSON.stringify(snapshot));
    for (const [entry, args] of [
      ["../bin/session-analytics.ts", ["report"]],
      ["../src/cli.ts", []],
    ] as Array<[string, string[]]>) {
      const child = spawn(process.execPath, [fileURLToPath(new URL(entry, import.meta.url)), ...args, "--json", "--snapshot", path], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      const closed = once(child, "close");
      child.stdout.destroy();
      const [code, signal] = await closed;
      assert.equal(signal, null);
      assert.equal(code, 0, stderr);
      assert.equal(stderr, "");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
