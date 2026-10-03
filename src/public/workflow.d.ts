import type { MachineAnalytics, RepositoryRollup, SessionAnalytics } from "../types.ts";
export function renderWorkflow(view: { sessions: SessionAnalytics[]; repositories: RepositoryRollup[] }, snapshot: MachineAnalytics): Promise<void>;
export function clearWorkflow(): void;
