import type { SessionAnalytics, WorkflowComparison, WorkflowConcurrency, WorkflowHistogram, WorkflowInventory, WorkflowSpan, WorkflowSummary } from "../types.ts";
export function histogram(values: number[]): WorkflowHistogram;
export function mergeHistograms(histograms: WorkflowHistogram[]): WorkflowHistogram;
export function concurrency(sessions: Array<{ spans: WorkflowSpan[] }>): WorkflowConcurrency;
export function compareVersions(sessions: SessionAnalytics[]): WorkflowComparison[];
export function summarizeWorkflow(sessions: SessionAnalytics[], inventory?: WorkflowInventory, asOf?: string, repositoryScope?: string[]): WorkflowSummary;
