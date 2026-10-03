import type { MachineAnalytics, SessionAnalytics, SessionProvider, WorkflowSummary } from "../types.ts";
export interface WorkflowWorker {
  onmessage: ((event: { data: { id: number; result?: WorkflowSummary; error?: boolean } }) => void) | null;
  onerror: (() => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}
export function createWorkflowScope(options?: { workerFactory?: () => WorkflowWorker; yieldTask?: () => Promise<void>; batchSize?: number; cacheLimit?: number }): {
  get(snapshot: MachineAnalytics, sessions: SessionAnalytics[], repositoryIds: string[], provider?: SessionProvider | "all"): WorkflowSummary | Promise<WorkflowSummary>;
  dispose(): void;
};
