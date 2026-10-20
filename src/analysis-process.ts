import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { AnalysisProgress, AnalyzeOptions, MachineAnalytics } from "./types.ts";
import { workerExitMessage } from "./store/errors.ts";
import { analysisEnvironment } from "./options.ts";
import { track } from "./processes.ts";
import { parseProgress, progressPrefix } from "./scan-progress.ts";
import { moduleUrl } from "./module-url.ts";

/** Machine-wide history with thousands of indexed sessions peaks well above 256 MB. */
export const analysisHeapLimitMegabytes = 1024;

export class AnalysisHeapLimitError extends Error {
  readonly stage: "analysis" | "serialization";
  constructor(stage: "analysis" | "serialization") {
    super(`Session analysis exceeded its ${analysisHeapLimitMegabytes} MB worker heap limit.`);
    this.stage = stage;
  }
}

/** The worker's stderr line when its index parses every session again. */
export const fullParseSignal = "session-analytics:full-parse";
export const fullParseNotice = "Parsing all session history once (a first scan, or a new version or price list); on a large history this can take several minutes.";

/** One line for a person at a terminal; a pipe, a file, a scheduled or a remote run hears nothing. */
export function noticeFullParse(stream: { isTTY?: boolean; write(text: string): unknown } = process.stderr): void {
  if (stream.isTTY) stream.write(`${fullParseNotice}\n`);
}

/** Line-buffer worker signals separately from diagnostics used for exit classification. */
export function analysisStderr(hooks: { onFullParse?: () => void; onProgress?: (progress: AnalysisProgress) => void }) {
  let buffer = "", diagnostics = "", noticed = false;
  const line = (value: string) => {
    if (value.trimEnd() === fullParseSignal) {
      if (!noticed) { noticed = true; hooks.onFullParse?.(); }
    } else if (value.startsWith(progressPrefix)) {
      const progress = parseProgress(value.slice(progressPrefix.length));
      if (progress) hooks.onProgress?.(progress);
    } else diagnostics += value;
  };
  return {
    write(chunk: string) {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        line(buffer.slice(0, end + 1)); buffer = buffer.slice(end + 1);
      }
    },
    finish() { if (buffer) { line(buffer); buffer = ""; } return diagnostics; },
  };
}

/** Analyze this machine in a worker process with its own heap; `onFullParse` hears once when its index parses everything. */
export async function analyzeMachineSessionsIsolated(
  options: AnalyzeOptions,
  { onFullParse = () => noticeFullParse(), onProgress }: { onFullParse?: () => void; onProgress?: (progress: AnalysisProgress) => void } = {},
): Promise<MachineAnalytics> {
  return await new Promise<MachineAnalytics>((resolve, reject) => {
    const child = track(spawn(
      process.execPath,
      [`--max-old-space-size=${analysisHeapLimitMegabytes}`, fileURLToPath(moduleUrl("./analysis-worker.ts", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"], env: analysisEnvironment(options) },
    ));
    let output = "";
    const stderr = analysisStderr({ onFullParse, onProgress });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => stderr.write(chunk));
    child.once("error", () => reject(new Error("Session analysis process could not be started.")));
    // A failed worker can close stdin before the options have drained; close below classifies its failure.
    child.stdin.on("error", () => {});
    child.once("close", (code) => {
      const errorOutput = stderr.finish();
      if (code !== 0) {
        const message = workerExitMessage(output, errorOutput);
        if (!message && /heap out of memory|allocation failed.*heap/i.test(errorOutput)) {
          reject(new AnalysisHeapLimitError(output.startsWith("{") ? "serialization" : "analysis"));
          return;
        }
        reject(new Error(message ?? "Session analysis process exited before returning a result."));
        return;
      }
      try {
        resolve(JSON.parse(output) as MachineAnalytics);
      } catch {
        reject(new Error("Session analysis process returned an invalid result."));
      }
    });
    child.stdin.end(JSON.stringify(options));
  });
}
