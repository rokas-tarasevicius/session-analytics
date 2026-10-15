import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AnalysisHeapLimitError, analysisHeapLimitMegabytes } from "../analysis-process.ts";
import type { AnalyzeOptions } from "../types.ts";
import { analysisEnvironment } from "../options.ts";
import { moduleUrl } from "../module-url.ts";
import { workerExitMessage } from "../store/errors.ts";
import type { McpSnapshot } from "./types.ts";

/** Only the tail of the worker's stderr is kept: enough to recognise a V8 heap abort, never forwarded. */
const STDERR_TAIL_BYTES = 16 * 1024;
const heapOutOfMemory = /heap out of memory|allocation failed.*heap/i;

/** A scan that has not finished by then is killed and reported as unavailable. */
export const SNAPSHOT_DEADLINE_MS = 300_000;

/** Test seam: a different worker script or heap cap. Production callers omit it. */
export interface SnapshotWorker { script?: URL; heapLimitMegabytes?: number }

/** Raw local data remains inside a capped worker. Disconnects and deadlines reap it. */
export async function loadSnapshot(options: AnalyzeOptions, signal: AbortSignal, worker: SnapshotWorker = {}): Promise<McpSnapshot> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const script = worker.script ?? moduleUrl("./worker.ts", import.meta.url);
    const child = spawn(process.execPath, [`--max-old-space-size=${worker.heapLimitMegabytes ?? analysisHeapLimitMegabytes}`, fileURLToPath(script)], {
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: analysisEnvironment(options),
    });
    const chunks: Buffer[] = [];
    let bytes = 0, failed = false, stderrTail = "";
    const stop = (): void => {
      failed = true;
      // The worker owns a new process group, including its Cursor child. Reap
      // that entire group on timeout/disconnect, never unrelated processes.
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Already exited; close will settle the promise. */ }
    };
    const timeout = setTimeout(stop, SNAPSHOT_DEADLINE_MS);
    timeout.unref();
    signal.addEventListener("abort", stop, { once: true });
    child.stdin.on("error", stop);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024 * 1024) stop();
      else if (!failed) chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES); });
    child.once("error", () => { failed = true; });
    child.once("close", (code) => {
      clearTimeout(timeout); signal.removeEventListener("abort", stop);
      // Only fixed messages are surfaced (heap limit, index state, a worker that could not start); raw child output never is.
      if (!failed && code !== 0 && heapOutOfMemory.test(stderrTail)) { reject(new AnalysisHeapLimitError(bytes > 0 ? "serialization" : "analysis")); return; }
      if (failed || code !== 0) { reject(new Error((!failed && workerExitMessage(Buffer.concat(chunks).toString("utf8"), stderrTail)) || "Snapshot unavailable.")); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as McpSnapshot); }
      catch { reject(new Error("Snapshot unavailable.")); }
    });
    child.stdin.end(JSON.stringify(options));
  });
}
