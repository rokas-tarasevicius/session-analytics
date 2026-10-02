import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AnalyzeOptions } from "../types.ts";
import type { McpSnapshot } from "./types.ts";

/** Raw local data remains inside a capped worker. Disconnects and deadlines reap it. */
export async function loadSnapshot(options: AnalyzeOptions, signal: AbortSignal): Promise<McpSnapshot> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=256", fileURLToPath(new URL("./worker.ts", import.meta.url))], {
      stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32",
    });
    const chunks: Buffer[] = [];
    let bytes = 0, failed = false;
    const stop = (): void => {
      failed = true;
      // The worker owns a new process group, including its Cursor child. Reap
      // that entire group on timeout/disconnect, never unrelated processes.
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Already exited; close will settle the promise. */ }
    };
    const timeout = setTimeout(stop, 180_000);
    timeout.unref();
    signal.addEventListener("abort", stop, { once: true });
    child.stdin.on("error", stop);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) stop();
      else if (!failed) chunks.push(chunk);
    });
    child.once("error", () => { failed = true; });
    child.once("close", (code) => {
      clearTimeout(timeout); signal.removeEventListener("abort", stop);
      if (failed || code !== 0) { reject(new Error("Snapshot unavailable.")); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as McpSnapshot); }
      catch { reject(new Error("Snapshot unavailable.")); }
    });
    child.stdin.end(JSON.stringify(options));
  });
}
