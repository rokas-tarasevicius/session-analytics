import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

export const outcomeSentinels = ["outcome-private-content", "outcome-private-branch", "outcome-private-title", "outcome-private-owner", "outcome-private-path", "987654321", "a".repeat(40), "b".repeat(40)];

export async function createOutcomeFixture(root: string) {
  const fixture = await createSessionAnalyticsFixture(root);
  const claudeId = "22222222-2222-4222-8222-222222222222";
  const claudePath = join(fixture.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", `${claudeId}.jsonl`);
  const base = { sessionId: claudeId, cwd: "/fixtures/workspaces/conductor/claude-workspace", gitBranch: "outcome-private-branch", timestamp: "2026-07-20T12:10:00Z",
    prAssociationsComplete: "outcome-private-content", coverage: "outcome-private-content", incompleteEvidenceSessions: "outcome-private-content" };
  const prUrl = "https://github.com/outcome-private-owner/outcome-private-repository/pull/987654321";
  const result = (id: string, output: unknown) => ({ ...base, type: "user", uuid: id, toolUseResult: output, message: { content: [{ type: "tool_result", tool_use_id: id, content: "outcome-private-content" }] } });
  const records = [
    result("outcome-edit", { structuredPatch: [{ lines: ["-outcome-private-content", "+outcome-private-content", "+synthetic added"], oldLines: 1, newLines: 2 }], filePath: "outcome-private-path" }),
    { ...base, type: "cost-state", totalLinesAdded: 20, totalLinesRemoved: 5, totalCostUSD: 9999 },
    result("outcome-commit", { gitOperation: { commit: { sha: "a".repeat(40), kind: "committed", branch: base.gitBranch } }, stdout: "outcome-private-content" }),
    result("outcome-pr", { gitOperation: { pr: { number: 987654321, url: prUrl, action: "created" } } }),
    { ...base, type: "pr-link", prUrl, prRepository: "outcome-private-owner/outcome-private-repository", prNumber: 987654321 },
    result("outcome-merge", { gitOperation: { pr: { number: 987654321, url: prUrl, action: "merged" } } }),
  ];
  await appendFile(claudePath, `\n${records.map((record) => JSON.stringify(record)).join("\n")}\n${JSON.stringify(records.at(-1))}\n`);
  // Locate the fixture rollout independently of its timestamp spelling.
  const { readdir } = await import("node:fs/promises");
  const paths = await readdir(join(fixture.codexRoot, "2026/07/20"));
  const actualCodexPath = paths.find((path) => path.includes("11111111-1111-4111-8111-111111111111"));
  if (!actualCodexPath) throw new Error("Synthetic Codex rollout is missing.");
  const path = join(fixture.codexRoot, "2026/07/20", actualCodexPath);
  const content = (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const meta = content.find((record) => record["type"] === "session_meta");
  if (meta) (meta["payload"] as Record<string, unknown>)["git"] = { commit_hash: "b".repeat(40), branch: base.gitBranch, repository_url: prUrl };
  content.push({ type: "event_msg", timestamp: "2026-07-20T10:10:00Z", payload: { type: "item_completed", item: { id: "outcome-private-change", type: "FileChange", status: "completed", changes: { "outcome-private-path": { type: "update", unified_diff: "@@ -1 +1,2 @@\n-outcome-private-content\n+outcome-private-content\n+synthetic\n" } } } } });
  await writeFile(path, `${content.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const db = new DatabaseSync(fixture.databasePath);
  db.exec("ALTER TABLE workspaces ADD COLUMN pr_title TEXT; ALTER TABLE workspaces ADD COLUMN derived_status TEXT; ALTER TABLE workspaces ADD COLUMN archive_commit TEXT;");
  db.prepare("UPDATE workspaces SET pr_title = ?, derived_status = ?, archive_commit = ?").run("outcome-private-title", "merged", "a".repeat(40));
  db.close();
  const cursor = new DatabaseSync(fixture.cursorDatabasePath);
  const current = cursor.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get("composerData:cursor-fixture") as { value: string };
  const composer = JSON.parse(current.value) as Record<string, unknown>;
  composer["totalLinesAdded"] = 15; composer["totalLinesRemoved"] = 3; composer["title"] = "outcome-private-title";
  cursor.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?").run(JSON.stringify(composer), "composerData:cursor-fixture"); cursor.close();
  return fixture;
}
