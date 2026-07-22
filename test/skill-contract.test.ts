import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, "../skills/conductor-session-analytics");
const skill = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");
const metrics = readFileSync(
  resolve(skillRoot, "references/metrics-catalog.md"),
  "utf8",
);
const rateCard = JSON.parse(
  readFileSync(resolve(skillRoot, "references/rate-cards.json"), "utf8"),
) as {
  effectiveDate?: string;
  models?: Record<string, { source?: string }>;
};
const manifest = JSON.parse(
  readFileSync(resolve(here, "../skillpack.json"), "utf8"),
) as { skills?: string[]; unit_tests?: string[] };
test("ships session analytics as a separate manifest-listed skill", () => {
  assert.ok(manifest.skills?.includes("skills/conductor-session-analytics"));
  assert.ok(
    manifest.unit_tests?.includes(
      "skills/conductor-session-analytics/scripts/*.test.ts",
    ),
  );
  assert.match(skill, /union of active and archived global Codex transcripts, Claude Code plus Claude Desktop local-agent transcripts, Cursor's local composer and bubble history/);
  assert.match(skill, /Omit database-only stubs rather than guessing or double-counting them/);
  assert.match(skill, /node \.agents\/skills\/conductor-session-analytics\/scripts\/server\.ts --open/);
});

test("enforces a content-free localhost-only interface", () => {
  assert.match(skill, /without returning prompts, reasoning, tool arguments, tool results/);
  assert.match(skill, /binds only to `127\.0\.0\.1`/);
  assert.match(skill, /Do not bind the dashboard to a LAN address/);
  assert.match(skill, /returns no transcript content/);
  assert.match(metrics, /must not return prompts, messages, reasoning/);
});

test("preserves model-specific accounting and estimate caveats", () => {
  assert.match(skill, /process-wide snapshot/);
  assert.match(skill, /deduplicate repeated assistant response IDs/);
  assert.match(skill, /reasoning-output tokens as part of output/);
  assert.match(skill, /API-equivalent estimates/);
  assert.match(metrics, /cache-write upper estimate/i);
  assert.match(rateCard.effectiveDate ?? "", /^\d{4}-\d{2}-\d{2}$/);
  for (const model of Object.values(rateCard.models ?? {})) {
    assert.match(model.source ?? "", /^https:\/\//);
  }
});

test("routes causal claims to a separate bounded forensic workflow", () => {
  assert.match(skill, /separate, explicitly scoped forensic workflow/);
  assert.match(skill, /operational proxies rather than verified outcomes/);
  assert.match(skill, /without declaring their cause/);
  assert.match(skill, /Do not call task completion “success,” cost “value,”/);
});
