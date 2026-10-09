// Type surface of url-state.js for the node:test URL state test (tsc runs strict on test/).
export interface UrlState {
  view: string | null;
  window: string | null;
  start: string | null;
  end: string | null;
  repo: string | null;
  open: "palette" | "help" | null;
  theme: "dark" | "light" | null;
  density: "compact" | "comfortable" | null;
}
export const stateKeys: readonly string[];
export const oneShotKeys: readonly string[];
export const defaultWindow: string;
export function parseUrlState(search: string, options?: { views?: readonly string[]; presets?: readonly string[]; aliases?: Record<string, string> }): UrlState;
export function serializeUrlState(state: Partial<Pick<UrlState, "view" | "window" | "start" | "end" | "repo">>, search?: string): string;
