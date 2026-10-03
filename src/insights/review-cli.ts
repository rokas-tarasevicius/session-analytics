import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brand } from "../brand.ts";
import { version } from "../version.ts";
import { analyzeOptionsFrom, argument } from "../options.ts";
import { parseCommandArguments } from "./arguments.ts";
import type { ReviewRequest, ReviewResult } from "./review.ts";

async function isolatedReview(request: ReviewRequest): Promise<ReviewResult> {
  return await new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(process.execPath, ["--max-old-space-size=256", fileURLToPath(new URL("./review-worker.ts", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], detached: grouped });
    let output = "";
    const fail = () => {
      // Terminate the owned worker group, including an in-flight CLI, on deadline/cancellation.
      try { if (grouped && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
      reject(new Error("Session review failed."));
    };
    process.once("SIGINT", fail); process.once("SIGTERM", fail);
    const timer = setTimeout(fail, 300_000); timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; if (output.length > 65_536) fail(); });
    child.stderr.on("data", () => {}); child.stdin.on("error", fail); child.once("error", fail);
    child.once("close", (code) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", fail); process.removeListener("SIGTERM", fail);
      if (code !== 0) { fail(); return; }
      try { resolve(JSON.parse(output) as ReviewResult); } catch { fail(); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

try {
  const argv = process.argv.slice(2);
  const parsed = parseCommandArguments(argv, ["--session", "--via"], ["--send-content", "--json"]);
  if (parsed.has("--help")) process.stdout.write(`${brand.name} ${version}
Usage: ${brand.command} review --session KEY --via claude|codex [--send-content] [--json] [analysis options]

P3 content review, off by default. KEY is a 12-character hashed session key from
report --json. Runs content-free detectors, then selects at most three flagged
windows from the main Claude or Codex transcript (12 prose excerpts, 1000 characters each).
Tool arguments, results, commands in tool blocks, and reasoning blocks are omitted.

Default: dry-run prints ONLY sizes, rule IDs and redaction counts. No CLI is invoked.
--send-content explicitly permits THIS RUN to send the redacted excerpts via your own
claude -p or codex exec. This flag has no environment equivalent. Redaction is best
effort: remaining prose may contain sensitive details. Your CLI's provider retention
and billing apply. A no-flags/no-excerpts result never invokes a CLI.

--json prints the preview and allowlisted assessment labels. No raw model response
is displayed. An absent or malformed assessment is unknown. No files are edited.
All shared source/repository options and --insights-config PATH are supported.
`);
  else if (parsed.has("--version")) process.stdout.write(`${version}\n`);
  else {
    const sessionKey = argument(argv, "--session") ?? "", via = argument(argv, "--via");
    if (!/^[a-f0-9]{12}$/.test(sessionKey) || (via !== "claude" && via !== "codex")) throw new Error("Invalid review request.");
    const result = await isolatedReview({ options: analyzeOptionsFrom(argv, process.env), sessionKey, via, sendContent: parsed.has("--send-content") });
    if (parsed.has("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      const p = result.preview;
      process.stdout.write(`P3 session review · ${p.mode} · Session ${p.sessionKey} · via ${p.via}\n${p.note}\nRules: ${p.flaggedRules.join(", ") || "none"}\nSelected: ${p.spans} spans, ${p.excerpts} excerpts, ${p.contentBytes} content bytes, ${p.promptBytes} prompt bytes\nRedactions: ${Object.entries(p.redactions).map(([key, value]) => `${key}=${value}`).join(", ")}\nOmitted blocks: ${p.omittedBlocks}; truncated: ${p.truncated}\n`);
      if (!p.excerpts) process.stdout.write("No bounded flagged context is available; no content sent. Assessment: unknown.\n");
      if (result.result) process.stdout.write(`Assessment: ${result.result.assessment}; confidence: ${result.result.confidence}; suggestion: ${result.result.suggestion}\n`);
    }
  }
} catch {
  process.stderr.write("Review could not be completed. Check the session key, configuration and CLI availability; use --help. No raw provider error is displayed.\n");
  process.exitCode = 2;
}
