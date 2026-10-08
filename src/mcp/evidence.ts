import type { McpPricingDay, McpSessionEvidence } from "./types.ts";
import { McpActivityCollector } from "./activity.ts";

/** Called during the existing streaming pass. Only lifecycle states and priced-token counters are kept. */
export class McpEvidenceCollector {
  private activity = new McpActivityCollector();
  private pricing = new Map<string, McpPricingDay>();
  private undatedTokens = 0;

  /** Called only for the same deduplicated usage priced by the analyzer. */
  usage(day: string, eligibleTokens: number, priced: boolean | number): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) {
      this.undatedTokens += eligibleTokens; return;
    }
    const item = this.pricing.get(day) ?? { day, eligibleTokens: 0, pricedTokens: 0 };
    item.eligibleTokens += eligibleTokens;
    item.pricedTokens += typeof priced === "boolean" ? priced ? eligibleTokens : 0 : Math.min(eligibleTokens, Math.max(0, priced));
    this.pricing.set(day, item);
  }

  claude(raw: Record<string, unknown>, source = "claude"): void {
    this.activity.claude(raw, source);
  }

  codex(raw: Record<string, unknown>): void {
    this.activity.codex(raw);
  }

  finish(working = false): McpSessionEvidence {
    return {
      activityState: this.activity.finish(working),
      pricingByDay: [...this.pricing.values()].sort((a, b) => a.day.localeCompare(b.day)),
      undatedTokens: this.undatedTokens,
    };
  }
}
