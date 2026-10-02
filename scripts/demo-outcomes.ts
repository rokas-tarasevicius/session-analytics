import { createHash } from "node:crypto";

/** Synthetic provider-shaped evidence only. No GitHub or local history is consulted. */
export function demoClaudeOutcomes(sessionId: string, repository: string, cwd: string, timestamp: string): unknown[] {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  const seed = Number.parseInt(digest.slice(0, 6), 16);
  const base = { sessionId, cwd, timestamp, gitBranch: `demo/change-${digest.slice(0, 6)}` };
  const records: unknown[] = [];
  if (seed % 10 < 2) return records;
  const added = 12 + seed % 180, removed = seed % 65;
  records.push({ ...base, type: "user", uuid: `demo-edit-${digest}`, toolUseResult: {
    structuredPatch: [{ oldLines: removed, newLines: added, lines: [...Array.from({ length: removed }, () => "-synthetic removed line"), ...Array.from({ length: added }, () => "+synthetic added line")] }],
  }, message: { content: [{ type: "tool_result", tool_use_id: `demo-edit-${digest}`, content: "[synthetic edit]" }] } });
  if (seed % 3 === 0) records.push({ ...base, type: "cost-state", totalLinesAdded: added, totalLinesRemoved: removed });
  if (seed % 10 < 4) return records;
  const number = 1 + seed % 90, url = `https://github.com/demo-example/${repository}/pull/${number}`;
  const operation = (suffix: string, gitOperation: unknown) => ({ ...base, type: "user", uuid: `demo-${suffix}-${digest}`, toolUseResult: { gitOperation },
    message: { content: [{ type: "tool_result", tool_use_id: `demo-${suffix}-${digest}`, content: "[synthetic Git result]" }] } });
  records.push(operation("commit", { commit: { kind: "committed", sha: digest.slice(0, 40), branch: base.gitBranch } }));
  if (seed % 10 < 6) return records;
  records.push(operation("push", { push: { branch: base.gitBranch } }), operation("create", { pr: { number, url, action: "created" } }),
    { ...base, type: "pr-link", prNumber: number, prRepository: `demo-example/${repository}`, prUrl: url });
  if (seed % 4 !== 0) records.push(operation("merge", { pr: { number, url, action: "merged" } }));
  else {
    records.push(operation("pr-edit", { pr: { number, url, action: "edited" } }));
    if (seed % 8 === 0) records.push(operation("pr-close", { pr: { number, url, action: "closed" } }));
  }
  return records;
}

export function demoCodexGit(id: string): { branch: string; commit_hash: string } {
  return { branch: `demo/change-${id.slice(0, 8)}`, commit_hash: createHash("sha256").update(id).digest("hex").slice(0, 40) };
}

export function demoCodexFileChange(id: string) {
  return { type: "item_completed", item: { id: `edit-${id}`, type: "FileChange", status: "completed",
    changes: { "src/synthetic.ts": { type: "update", unified_diff: "--- a/src/synthetic.ts\n+++ b/src/synthetic.ts\n@@ -1,2 +1,3 @@\n unchanged\n-old line\n+new line\n+added line\n" } } } };
}
