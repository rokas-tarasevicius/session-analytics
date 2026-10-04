import type { HistoryStatistics } from "./history-types.ts";
import { projectModelId } from "../public/model-id.js";
import type { RecordValue } from "../providers/common.ts";

/** Match Claude dailyModelTokens v5: every assistant block, not one per response.
 * This counter is NEVER used for session pricing or request counts. */
export class HistoryStatisticsCollector {
  private days = new Map<string, HistoryStatistics["days"][number]>();
  add(at: string | null, rawModel: unknown, usage: RecordValue | null): void {
    const model = projectModelId(rawModel);
    if (!at || model === "<unknown>" || !usage) return;
    let tokens = 0;
    for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
      const n = usage[key];
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) tokens += n;
    }
    if (!tokens || !Number.isSafeInteger(tokens)) return;
    const day = at.slice(0, 10), key = `${day}:${model}`;
    const row = this.days.get(key) ?? { day, model, tokens: 0 };
    row.tokens += tokens; this.days.set(key, row);
  }
  finish(): HistoryStatistics {
    return { basis: "claude-stream-snapshots-v5", days: [...this.days.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model)) };
  }
}
