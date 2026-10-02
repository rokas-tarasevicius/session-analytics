#!/usr/bin/env node
/** Reproducible analysis timing. Only numeric summaries leave this process, even for --machine. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeMachineSessionsIsolated } from "../src/analysis-process.ts";
import { indexStatus } from "../src/store/database.ts";
import type { AnalyzeOptions, MachineAnalytics } from "../src/types.ts";

const args = process.argv.slice(2);
const machine = args.length === 1 && args[0] === "--machine";
const demoRoot = args.length === 2 && args[0] === "--demo-root" ? resolve(args[1] as string) : null;
if (!machine && !demoRoot) {
  process.stderr.write("Usage: node scripts/benchmark-index.ts --demo-root PATH | --machine\nUse a synthetic dataset retained by node scripts/demo.ts report --keep.\n");
  process.exit(2);
}
const temporary = await mkdtemp(join(tmpdir(), "session-analytics-index-benchmark-"));
const options: AnalyzeOptions = {
  dataDir: join(temporary, "index"), includeHidden: true, noIndex: false,
  ...(demoRoot ? {
    claudeRoot: join(demoRoot, "claude", "projects"),
    codexRoot: join(demoRoot, "codex", "sessions"),
    codexArchiveRoot: join(demoRoot, "codex", "archived_sessions"),
    cursorDatabasePath: join(demoRoot, "cursor", "User", "globalStorage", "state.vscdb"),
    databasePath: join(demoRoot, "conductor-not-present.db"),
  } : {}),
};
async function timed(noIndex: boolean): Promise<{ snapshot: MachineAnalytics; milliseconds: number }> {
  const start = performance.now();
  const snapshot = await analyzeMachineSessionsIsolated({ ...options, noIndex });
  return { snapshot, milliseconds: Math.round(performance.now() - start) };
}
function stable(snapshot: MachineAnalytics): Omit<MachineAnalytics, "generatedAt"> {
  const { generatedAt, ...rest } = snapshot; void generatedAt; return rest;
}
try {
  // On the real machine this is one cold ingest and one incremental launch, never a third full scan.
  const baseline = demoRoot ? await timed(true) : null;
  const cold = await timed(false), coldStats = indexStatus(options).lastScan;
  const warm = await timed(false), warmStats = indexStatus(options).lastScan;
  if (baseline) {
    try { assert.deepEqual(stable(cold.snapshot), stable(baseline.snapshot)); assert.deepEqual(stable(warm.snapshot), stable(baseline.snapshot)); }
    catch { throw new Error("Benchmark parity failed."); }
  }
  process.stdout.write(JSON.stringify({
    fullScanMilliseconds: baseline?.milliseconds ?? null,
    coldMilliseconds: cold.milliseconds, warmMilliseconds: warm.milliseconds,
    coldToWarmSpeedup: Number((cold.milliseconds / Math.max(1, warm.milliseconds)).toFixed(2)),
    parityVerified: Boolean(baseline),
    sessionsCold: cold.snapshot.summary.sessions, sessionsWarm: warm.snapshot.summary.sessions,
    repositoriesCold: cold.snapshot.summary.repositories, repositoriesWarm: warm.snapshot.summary.repositories,
    coldIngest: coldStats, warmIngest: warmStats,
  }, null, 2) + "\n");
} catch {
  process.stderr.write("Index benchmark failed; no local history or error details were emitted.\n");
  process.exitCode = 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
