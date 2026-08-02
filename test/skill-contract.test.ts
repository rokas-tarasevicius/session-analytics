import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, "../skills/machine-session-analytics");
const skill = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");
const bootstrap = readFileSync(resolve(here, "../runbooks/bootstrap.md"), "utf8");
const metrics = readFileSync(
  resolve(skillRoot, "references/metrics-catalog.md"),
  "utf8",
);
const rateCard = JSON.parse(
  readFileSync(resolve(skillRoot, "references/rate-cards.json"), "utf8"),
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
const manifest = JSON.parse(
  readFileSync(resolve(here, "../skillpack.json"), "utf8"),
) as { skills?: string[]; unit_tests?: string[] };
test("ships session analytics as a separate manifest-listed skill", () => {
  assert.ok(manifest.skills?.includes("skills/machine-session-analytics"));
  assert.ok(
    manifest.unit_tests?.includes(
      "skills/machine-session-analytics/scripts/*.test.ts",
    ),
  );
  assert.match(skill, /Codex: `~\/\.codex\/sessions\/` and `~\/\.codex\/archived_sessions\/`/);
  assert.match(skill, /Claude Code: `~\/\.claude\/projects\/`/);
  assert.match(skill, /Cursor: `~\/Library\/Application Support\/Cursor/);
  assert.match(skill, /node \.agents\/skills\/machine-session-analytics\/scripts\/server\.ts --open/);
  assert.match(skill, /Provider stores define the scan/);
  assert.match(skill, /Conductor is optional enrichment and is never required/);
});

test("launches through one automatic idempotent command", () => {
  assert.match(skill, /immediately run exactly one command/);
  assert.match(skill, /Do not ask the user to run commands/);
  assert.match(skill, /safe to rerun/);
  assert.doesNotMatch(skill, /node \.agents\/skills\/machine-session-analytics\/scripts\/cli\.ts/);
  assert.match(bootstrap, /No manual bootstrap or preprocessing is required/);
  assert.equal(
    bootstrap.match(/node \.agents\/skills\/machine-session-analytics\/scripts\/server\.ts --open/g)?.length,
    1,
  );
});

test("enforces a content-free localhost-only interface", () => {
  assert.match(skill, /never return transcript content, prompts, reasoning, tool arguments or results/);
  assert.match(skill, /bound to `127\.0\.0\.1`/);
  assert.match(skill, /bind to a LAN address/);
  assert.match(skill, /Do not return transcript content/);
  assert.match(metrics, /must not return prompts, messages, reasoning/);
});

test("preserves model-specific accounting and estimate caveats", () => {
  assert.match(skill, /deduplicate broadcast counters, repeated messages, subagent traces/);
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
