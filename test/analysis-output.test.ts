import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { writeAnalysisSnapshot } from "../src/analysis-output.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

test("streamed worker output is identical JSON under backpressure, including absent optional fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "analysis-output-"));
  try {
    const snapshot = await analyzeMachineSessions({ ...await createSessionAnalyticsFixture(root), offline: true });
    snapshot.mcpContext = undefined;
    let actual = "", writes = 0;
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
      actual += String(chunk); writes++; setImmediate(callback);
    } });
    await writeAnalysisSnapshot(snapshot, output);
    assert.ok(writes > snapshot.sessions.length);
    assert.equal(actual, JSON.stringify(snapshot));
    assert.doesNotMatch(actual, /content-is-not-returned|secret-command|secret-path/);
    output.end();
  } finally { await rm(root, { recursive: true, force: true }); }
});
