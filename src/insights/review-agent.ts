import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ReviewAssessment {
  assessment: "unknown" | "expected" | "worth-review";
  confidence: "low" | "medium" | "high";
  suggestion: "none" | "compare-similar-task" | "check-context" | "check-cache" | "check-delegation";
}
const unknown = (): ReviewAssessment => ({ assessment: "unknown", confidence: "low", suggestion: "none" });
const schema = {
  type: "object", additionalProperties: false,
  properties: {
    assessment: { type: "string", enum: ["unknown", "expected", "worth-review"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    suggestion: { type: "string", enum: ["none", "compare-similar-task", "check-context", "check-cache", "check-delegation"] },
  }, required: ["assessment", "confidence", "suggestion"],
};

/** Agent output is untrusted too: no arbitrary model prose is returned. */
export function projectAssessment(value: unknown): ReviewAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown();
  const item = value as Record<string, unknown>;
  if (!schema.properties.assessment.enum.includes(String(item["assessment"])) || !schema.properties.confidence.enum.includes(String(item["confidence"])) || !schema.properties.suggestion.enum.includes(String(item["suggestion"]))) return unknown();
  return { assessment: item["assessment"] as ReviewAssessment["assessment"], confidence: item["confidence"] as ReviewAssessment["confidence"], suggestion: item["suggestion"] as ReviewAssessment["suggestion"] };
}

function parseAgentOutput(output: string): ReviewAssessment {
  const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
  let selected: unknown = parse(output);
  for (const line of output.split("\n")) {
    const event = parse(line) as Record<string, unknown> | null;
    if (!event || typeof event !== "object") continue;
    if (event["structured_output"]) selected = event["structured_output"];
    else if (event["type"] === "result" && typeof event["result"] === "string") selected = parse(event["result"]);
    else if (event["type"] === "item.completed") {
      const item = event["item"] as Record<string, unknown> | undefined;
      if (item?.["type"] === "agent_message" && typeof item["text"] === "string") selected = parse(item["text"]);
    }
  }
  return projectAssessment(selected);
}

export async function invokeReviewAgent(via: "claude" | "codex", prompt: string, sendContent: boolean, timeoutMilliseconds = 120_000): Promise<ReviewAssessment> {
  if (!sendContent) throw new Error("Content review requires explicit authorization.");
  if (!prompt || Buffer.byteLength(prompt) > 60_000) throw new Error("No bounded review context is available.");
  const directory = await mkdtemp(join(tmpdir(), "session-review-"));
  try {
    const args = via === "claude"
      ? ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-session-persistence"]
      : ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "-c", 'approval_policy="never"', "-c", "features.shell_tool=false", "-c", "features.exec_tool=false", "-c", "features.multi_agent=false", "-c", "mcp_servers={}", "-c", 'web_search="disabled"', "-"];
    return await new Promise<ReviewAssessment>((resolve, reject) => {
      const child = spawn(via, args, { cwd: directory, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1" } });
      let output = "", bytes = 0, failed = false;
      const fail = () => { if (!failed) { failed = true; child.kill("SIGKILL"); reject(new Error("The review CLI failed, timed out, or returned too much output.")); } };
      const timer = setTimeout(fail, timeoutMilliseconds); timer.unref();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 65_536) fail(); else output += chunk; });
      // Drain, never echo provider errors, local paths or model prose.
      child.stderr.on("data", () => {});
      child.stdin.on("error", fail);
      child.once("error", fail);
      child.once("close", (code) => { clearTimeout(timer); if (failed) return; if (code !== 0) fail(); else resolve(parseAgentOutput(output)); });
      child.stdin.end(prompt);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
