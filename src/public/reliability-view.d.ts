import type { SessionAnalytics } from "../types.ts";
/** DOM rendering is browser-owned; Node tests provide a minimal element harness. */
export function renderReliability(container: unknown, sessions: SessionAnalytics[]): void;
