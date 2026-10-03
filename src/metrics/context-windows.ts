/** Reviewed 2026-10-02 against https://platform.claude.com/docs/en/build-with-claude/context-windows.
 * These are API model capacities, not evidence of a harness's configured budget.
 * Only explicit models/dated aliases match; unknown models stay unknown.
 */
export const CONTEXT_TABLE_REVIEWED_AT = "2026-10-02";
const capacities: Record<string, number> = {
  "claude-opus-5-5": 1_000_000, "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000, "claude-opus-4-7": 1_000_000, "claude-opus-4-6": 1_000_000,
  "claude-sonnet-5-5": 1_000_000, "claude-sonnet-5": 1_000_000, "claude-sonnet-4-6": 1_000_000,
  "claude-fable-5-1": 1_000_000, "claude-fable-5": 1_000_000,
  "claude-mythos-5-1": 1_000_000, "claude-mythos-5": 1_000_000, "claude-mythos-preview": 1_000_000,
  "claude-opus-4-5": 200_000, "claude-opus-4-1": 200_000, "claude-opus-4": 200_000,
  "claude-sonnet-4-5": 200_000, "claude-sonnet-4": 200_000, "claude-haiku-4-5": 200_000,
};
export function claudeContextWindow(model: string): number | null {
  return capacities[model.replace(/-\d{8}$/, "")] ?? null;
}
