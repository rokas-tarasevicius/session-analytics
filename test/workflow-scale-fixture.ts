import { WorkflowCollector } from "../src/metrics/workflow.ts";
import { summarizeWorkflow } from "../src/public/workflow-data.js";
import type { MachineAnalytics, SessionAnalytics, WorkflowInventory } from "../src/types.ts";

/** Synthetic only: roughly the reviewed machine's sessions, repositories and spans. */
export function workflowScaleFixture(size = 5052): { snapshot: MachineAnalytics; inventory: WorkflowInventory } {
  const base = Date.parse("2026-06-01T00:00:00Z"), iso = (time: number) => new Date(time).toISOString();
  const c = new WorkflowCollector("codex");
  c.observe({ type: "session_meta", timestamp: iso(base), payload: { source: "cli", cli_version: "0.140.0", originator: "codex_cli_rs" } }, 0);
  c.observe({ type: "event_msg", timestamp: iso(base), payload: { type: "user_message" } }, 1);
  c.tool(iso(base + 30_000), 4);
  c.observe({ type: "event_msg", timestamp: iso(base + 60_000), payload: { type: "task_complete", duration_ms: 60_000 } }, 2);
  const template = c.finish(base + 86_400_000);
  const sessions = Array.from({ length: size }, (_, index) => {
    const start = base + (index % 60) * 86_400_000 + Math.floor(index / 60) * 120_000;
    return {
      sessionKey: `synthetic-${index}`, repositoryId: `repo-${index % 125}`, provider: index % 2 ? "claude" : "codex", createdAt: iso(start),
      transcript: { status: "ok", snapshotWhileWorking: false }, skills: { "shared-skill": index % 3, "repo-skill": index % 5 },
      workflow: { ...template, time: { ...template.time, activeSpans: [{ start: iso(start), end: iso(start + 60_000) }, { start: iso(start + 90_000), end: iso(start + 120_000) }], activeMilliseconds: 90_000, observedSpanMilliseconds: 120_000, unclassifiedMilliseconds: 30_000 },
        mix: [{ at: iso(start), model: "gpt-test", effort: "high", cliVersion: index % 60 < 30 ? "0.140.0" : "0.141.0", entrypoint: "cli", originator: "codex_cli_rs" }],
        valueByHour: [{ hour: iso(Math.floor(start / 3_600_000) * 3_600_000), usd: .1 }], pricedRequests: 1, timestampedPricedRequests: 1,
      },
    } as unknown as SessionAnalytics;
  });
  const repositories = Array.from({ length: 126 }, (_, index) => ({ repository: { id: `repo-${index}`, name: `Synthetic ${index}` } }));
  const inventory: WorkflowInventory = { directoriesRead: 126, directoriesUnavailable: 0, historyFilesRead: 1, historyFilesUnavailable: 0, malformedHistoryRecords: 0,
    skills: ["claude", "codex"].flatMap((provider) => [{ name: "shared-skill", provider, repositoryId: null }, ...repositories.map((r) => ({ name: "repo-skill", provider, repositoryId: r.repository.id }))]) as WorkflowInventory["skills"],
  };
  const snapshot = { sessions, repositories, generatedAt: "2026-08-01T00:00:00Z" } as unknown as MachineAnalytics;
  snapshot.workflow = summarizeWorkflow(sessions, inventory, snapshot.generatedAt, repositories.map((r) => r.repository.id));
  return { snapshot, inventory };
}
