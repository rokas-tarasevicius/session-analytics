import assert from "node:assert/strict";
import test from "node:test";
import { OutcomeCollector } from "../../src/metrics/outcomes.ts";
import { matchesSchema, snapshotSchema } from "../../src/interop/schema.ts";
import type { SessionDatabaseRow } from "../../src/types.ts";

const row: SessionDatabaseRow = { agent_type: "claude", branch: "synthetic-branch", conductor_session_id: "synthetic-session", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:01:00Z", database_model: null, default_branch: "main", is_hidden: 0, provider_session_id: "synthetic-provider-session", repository_id: "discovered-aaaaaaaaaaaaaaaaaaaa", repository_name: "Synthetic", repository_remote: "https://github.com/example/synthetic.git", root_path: "/synthetic/repo", status: "idle", title: "synthetic-title", workspace_name: "synthetic-workspace", workspace_path: "/synthetic/workspace", outcome_workspace_id: "synthetic-workspace", outcome_pr_present: 1 };

test("AGG-009: every pseudonymous reference emitted by the outcome collector is accepted by snapshot schema", () => {
  const collector = new OutcomeCollector(row);
  collector.observeClaude({ type: "pr-link", prUrl: "https://github.com/example/synthetic/pull/42", prNumber: 42, prRepository: "example/synthetic" });
  for (const [id, gitOperation] of [["unknown-pr", { pr: { action: "created" } }], ["unknown-commit", { commit: { kind: "committed" } }]] as const) {
    collector.observeClaude({ type: "user", uuid: id, toolUseResult: { gitOperation }, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false }] } });
  }
  const result = collector.project();
  assert.equal(result.links.length, 5, "fixture exercises branch, workspace-pr, pr, pr-event, commit-event namespaces");
  assert.ok(result.links.every(link => !link.ref.includes("synthetic")), "only hash namespaces leave collector");
  assert.equal(matchesSchema(result, { $ref: "#/$defs/SessionOutcomes", $defs: snapshotSchema.$defs }), true);
});
