import assert from "node:assert/strict";
import test from "node:test";
import { analysisStderr } from "../src/analysis-process.ts";
import { progressReporter, progressPrefix } from "../src/scan-progress.ts";
import type { AnalysisProgress } from "../src/types.ts";

test("worker progress is throttled by time, preserves phase changes and flushes its last count", () => {
  let now = 0;
  const lines: string[] = [];
  const reporter = progressReporter((line) => lines.push(line), () => now);
  reporter.update({ phase: "discover", done: 0, total: null });
  reporter.update({ phase: "discover", done: 0, total: 10 });
  reporter.update({ phase: "parse", done: 0, total: 10 });
  for (let done = 1; done <= 10; done++) {
    now += 50;
    reporter.update({ phase: "parse", done, total: 10 });
  }
  reporter.update({ phase: "combine", done: 10, total: 10 });
  reporter.finish();
  assert.deepEqual(lines.map((line) => JSON.parse(line.slice(progressPrefix.length))), [
    { phase: "discover", done: 0, total: null }, { phase: "parse", done: 0, total: 10 },
    { phase: "parse", done: 5, total: 10 }, { phase: "parse", done: 10, total: 10 },
    { phase: "combine", done: 10, total: 10 }, { phase: "combine", done: 10, total: 10 },
  ]);
  const privateProgress = { phase: "parse", done: 1, total: 2, path: "PRIVATE_SENTINEL" } as AnalysisProgress;
  reporter.update(privateProgress); reporter.finish();
  assert.doesNotMatch(lines.join(""), /PRIVATE_SENTINEL|path/);
});

test("stderr buffers complete lines, rejects malformed progress, and preserves diagnostics", () => {
  const progress: AnalysisProgress[] = [];
  let notices = 0;
  const stderr = analysisStderr({ onProgress: (value) => progress.push(value), onFullParse: () => notices++ });
  const valid = `${progressPrefix}{"phase":"parse","done":2,"total":3}\n`;
  stderr.write("ordinary diagnostic\n" + valid.slice(0, 24));
  assert.equal(progress.length, 0);
  stderr.write(valid.slice(24) + "session-analytics:full-");
  stderr.write("parse\nsession-analytics:full-parse\n");
  for (const payload of ["{", '{"phase":"PRIVATE_SENTINEL","done":0,"total":null}', '{"phase":"parse","done":-1,"total":2}', '{"phase":"parse","done":1.5,"total":2}', '{"phase":"parse","done":3,"total":2}', '{"phase":"parse","done":1,"total":2,"path":"PRIVATE_SENTINEL"}', 'null']) {
    stderr.write(`${progressPrefix}${payload}\n`);
  }
  stderr.write("FATAL ERROR: heap out of memory");
  assert.equal(stderr.finish(), "ordinary diagnostic\nFATAL ERROR: heap out of memory");
  assert.equal(notices, 1);
  assert.deepEqual(progress, [{ phase: "parse", done: 2, total: 3 }]);
});
