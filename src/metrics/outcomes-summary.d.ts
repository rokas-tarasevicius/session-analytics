import type { SessionAnalytics } from "../types.ts";
import type { OutcomeSummary } from "./outcome-types.ts";
export function summarizeOutcomes(sessions: readonly SessionAnalytics[]): OutcomeSummary;
