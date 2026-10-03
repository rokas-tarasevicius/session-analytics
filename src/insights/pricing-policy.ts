import type { NextTierModels } from "./types.ts";

/** Scenario tiers for the bundled rate card, not capability rankings or live model discovery.
 * Apply exactly one edge. Missing models never cause a fallback to the cheapest rate. */
export const defaultNextTierModels: NextTierModels = {
  claude: {
    "claude-fable-5": "claude-opus-5",
    "claude-fable-5-1": "claude-opus-5-5",
    "claude-opus-4-6": "claude-sonnet-5",
    "claude-opus-4-8": "claude-sonnet-5",
    "claude-opus-5": "claude-sonnet-5",
    "claude-opus-5-5": "claude-sonnet-5-5",
    "claude-sonnet-5": "claude-haiku-4-5-20251001",
    "claude-sonnet-5-5": "claude-haiku-4-5-20251001",
  },
  codex: {
    "gpt-6-astra": "gpt-6.1-sol",
    "gpt-6-sol": "gpt-5.4-mini",
    "gpt-6.1-sol": "gpt-5.4-mini",
    "gpt-5.6-sol": "gpt-5.6-terra",
    "gpt-5.6-terra": "gpt-5.4-mini",
    "gpt-5.5": "gpt-5.4",
    "gpt-5.4": "gpt-5.4-mini",
    "gpt-5.3-codex": "gpt-5.4-mini",
  },
};
