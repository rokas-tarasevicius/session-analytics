import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { toolDefinitions } from "../src/mcp/tools.ts";
import { sessionStatuses } from "../src/public/evidence.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const skill = readFileSync(resolve(projectRoot, "skills/session-analytics/SKILL.md"), "utf8");
const metrics = readFileSync(resolve(projectRoot, "docs/metrics.md"), "utf8");
const privacy = readFileSync(resolve(projectRoot, "docs/privacy.md"), "utf8");
const rateCard = JSON.parse(
  readFileSync(resolve(projectRoot, "data/rate-cards.json"), "utf8"),
) as {
  effectiveDate?: string;
  models?: Record<string, {
    cacheReadPerMillion?: number;
    cacheWrite1hPerMillion?: number;
    cacheWrite5mPerMillion?: number;
    inputPerMillion?: number;
    outputPerMillion?: number;
    provider?: string;
    source?: string;
  }>;
};

test("ships an agent skill that names every evidence store", () => {
  assert.match(skill, /^name: session-analytics$/m);
  assert.match(skill, /Codex: `~\/\.codex\/sessions\/` and `~\/\.codex\/archived_sessions\/`/);
  assert.match(skill, /Claude Code: `~\/\.claude\/projects\/`, every additional `~\/\.claude-\*\/projects\/` profile/);
  assert.match(skill, /Cursor: `~\/Library\/Application Support\/Cursor/);
  assert.match(skill, /Provider stores define the scan/);
  assert.match(skill, /Conductor is optional enrichment and is never required/);
});

test("provider descriptions cover every supported provider", () => {
  const packageMetadata = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as { description: string };
  const description = skill.match(/^description: (.+)$/m)?.[1] ?? "";
  const contract = skill.split("## Contract")[1]?.split("## Phase 1")[0] ?? "";
  for (const provider of ["Claude Code", "Codex", "Cursor", "Copilot CLI", "OpenCode", "Gemini CLI"]) {
    for (const text of [packageMetadata.description, description, contract]) assert.ok(text.includes(provider), provider);
  }
  assert.doesNotMatch(packageMetadata.description, /reliability/i);
});

test("documented MCP providers match the published tool schema", () => {
  const schema = toolDefinitions.find(({ name }) => name === "usage_summary")!.inputSchema;
  assert.ok("provider" in schema.properties);
  const providers = schema.properties.provider.enum;
  const mcp = readFileSync(resolve(projectRoot, "docs/mcp.md"), "utf8");
  const filter = mcp.split("- `provider`: ")[1]?.split("\n")[0] ?? "";
  const comparison = mcp.split("| `compare_agents` | ")[1]?.split("\n")[0] ?? "";
  const metricComparison = metrics.split("`compare_agents.agents[]` always contains ")[1]?.split(" totals/profiles")[0] ?? "";
  for (const text of [filter, comparison, metricComparison]) {
    assert.deepEqual([...text.matchAll(/`([a-z]+)`/g)].map((match) => match[1]), providers);
  }
});

test("the Session field manifest has one continuous row per field and current status labels", () => {
  const section = privacy.split("### Session (`SessionAnalytics`)")[1]?.split("### Session metrics")[0] ?? "";
  const rows = [...section.matchAll(/^\| `([^`]+)` \| (.+) \| P[01](?:\/P1)? \|$/gm)];
  const fields = rows.map((row) => row[1]);
  assert.ok(fields.length > 0);
  assert.equal(new Set(fields).size, fields.length);
  const first = section.indexOf("| Field |");
  const last = section.lastIndexOf("| P0 |");
  assert.ok(section.slice(first, last).split("\n").every((line) => line.startsWith("|")));
  const status = rows.find((row) => row[1] === "status")![2]!;
  assert.deepEqual([...status.split(";")[0]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]), sessionStatuses);
  for (const field of ["provider", "effort", "transcript.snapshotWhileWorking", "transcript.warnings[]", "transcript.sourceDeleted", "transcript.startTimeKnown"]) {
    assert.ok(fields.includes(field), field);
  }
});

test("launches through one automatic idempotent command", () => {
  assert.match(skill, /immediately run exactly one command/);
  assert.match(skill, /```bash\nsession-analytics\n```/);
  assert.match(skill, /Do not ask the user to run commands/);
  assert.match(skill, /safe to rerun/);
});

test("enforces a content-free localhost-only interface", () => {
  assert.match(skill, /never return transcript content, prompts, reasoning, tool arguments or results/);
  assert.match(skill, /bound to `127\.0\.0\.1`/);
  assert.match(skill, /bind to a LAN address/);
  assert.match(skill, /Do not return transcript content/);
  assert.match(metrics, /must not return prompts, messages, reasoning/);
});

test("preserves model-specific accounting and estimate caveats", () => {
  assert.match(skill, /deduplicate broadcast counters, streamed message snapshots, repeated messages, subagent traces/);
  assert.match(skill, /API list-price equivalents/);
  assert.match(metrics, /process-wide `total_token_usage` snapshot/);
  assert.match(metrics, /deduplicate assistant `message\.id` values/);
  assert.match(metrics, /reasoning output remains included in output pricing/);
  assert.match(metrics, /cache-write upper estimate/i);
  assert.match(rateCard.effectiveDate ?? "", /^\d{4}-\d{2}-\d{2}$/);
  for (const model of Object.values(rateCard.models ?? {})) {
    assert.match(model.source ?? "", /^https:\/\//);
  }
  assert.deepEqual(rateCard.models?.["claude-opus-5"], {
    provider: "claude",
    inputPerMillion: 5,
    cacheReadPerMillion: 0.5,
    cacheWrite5mPerMillion: 6.25,
    cacheWrite1hPerMillion: 10,
    outputPerMillion: 25,
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
  });
  assert.match(metrics, /Claude Opus 5 entry uses Anthropic's standard global API rates/);
});

test("routes causal claims to a separate bounded forensic workflow", () => {
  assert.match(skill, /separately scoped forensic workflow/);
  assert.match(skill, /do not prove quality, success, causation, or value delivered/);
  assert.match(metrics, /Tool call counts do not prove useful work, failure, or causal responsibility/);
  assert.match(metrics, /successful or failed outcome/);
});
