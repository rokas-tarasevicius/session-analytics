import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { AnalyzeOptions, MachineAnalytics } from "./types.ts";
import { indexErrorMessage } from "./store/errors.ts";

export async function analyzeMachineSessionsIsolated(
  options: AnalyzeOptions,
): Promise<MachineAnalytics> {
  return await new Promise<MachineAnalytics>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=256", fileURLToPath(new URL("./analysis-worker.ts", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        void errorOutput;
        let message: string | null = null;
        try { message = indexErrorMessage((JSON.parse(output) as { analysisError?: unknown }).analysisError); } catch { /* No raw child error is forwarded. */ }
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
