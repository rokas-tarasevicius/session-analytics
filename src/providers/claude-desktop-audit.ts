import { join } from "node:path";
import { desktopIdentityMatches, desktopMetadataPath } from "./claude-desktop.ts";
import { jsonLines, record, text, safeTime, zeroTokens, modelName } from "./common.ts";
import type { TokenUsage, ExecutionKind } from "../types.ts";

interface NativeUsage { stream: string; model: string; usage: TokenUsage; timestamp: string | null }
interface Interval { id: string; version: string; start: string; ids: Set<string>; result: Record<string, unknown> | null }
export interface DesktopSupplement { model: string; usage: TokenUsage; timestamp: string; executionKind: ExecutionKind }
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
function counters(value: unknown): { input: number; read: number; write: number; output: number } | null {
  const r = record(value); if (!r) return null;
  const values = ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "outputTokens"].map(k => count(r[k]));
  if (values.some(v => v === null)) return null;
  return { input: values[0]!, read: values[1]!, write: values[2]!, output: values[3]! };
}

/** Conservative legacy Desktop reconciliation; ambiguous scopes never modify native evidence. */
export async function desktopSupplements(mainPath: string, sessionId: string | null, native: ReadonlyMap<string, NativeUsage>): Promise<DesktopSupplement[]> {
  if (!sessionId || !await desktopIdentityMatches(mainPath, sessionId)) return [];
  // modelUsage includes child work; this bounded proposal supports main-only stores.
  if ([...native.values()].some(n => n.stream !== mainPath)) return [];
  const metadata = desktopMetadataPath(mainPath)!;
  const intervals: Interval[] = [], seenInit = new Set<string>(), seenResult = new Set<string>();
  let active: Interval | null = null;
  try {
    for await (const row of jsonLines(join(metadata.slice(0, -5), "audit.jsonl"))) {
      if (!row) return [];
      if (row["type"] === "system" && row["subtype"] === "init") {
        const uuid = text(row["uuid"]), start = safeTime(row["_audit_timestamp"]);
        const version = text(row["claude_code_version"]), match = /^2\.1\.(\d+)$/.exec(version ?? "");
        // v2.1.277 changed resume counters to carry prior-session totals.
        if (!uuid || !start || !match || Number(match[1]) >= 277 || row["session_id"] !== sessionId || seenInit.has(uuid)) return [];
        seenInit.add(uuid); active = { id: uuid, version: version!, start, ids: new Set(), result: null }; intervals.push(active);
        continue;
      }
      if (!active || row["session_id"] !== sessionId) continue;
      if (row["type"] === "assistant") {
        if (row["parent_tool_use_id"]) return [];
        const id = text(record(row["message"])?.["id"]); if (!id) return []; active.ids.add(id);
      }
      if (row["type"] === "result") {
        const id = text(row["uuid"]); if (!id || row["is_error"] !== false) return [];
        if (seenResult.has(id)) continue;
        seenResult.add(id); active.result = row; // latest cumulative snapshot within this init interval
      }
    }
  } catch { return []; }
  const result: DesktopSupplement[] = [], claimed = new Set<string>();
  for (const interval of intervals) {
    const r = interval.result, end = safeTime(r?.["_audit_timestamp"]);
    if (!r || !end || !interval.ids.size || end < interval.start || interval.start.slice(0, 10) !== end.slice(0, 10)) return [];
    const main = { input: 0, read: 0, write: 0, output: 0 }, models = new Set<string>();
    for (const id of interval.ids) {
      const n = native.get(id);
      if (!n || claimed.has(id) || !n.timestamp || n.timestamp.slice(0, 10) !== end.slice(0, 10)) return [];
      claimed.add(id); models.add(n.model); main.input += n.usage.uncachedInputTokens;
      main.read += n.usage.cachedInputTokens; main.write += n.usage.cacheWriteInputTokens; main.output += n.usage.outputTokens;
    }
    if (models.size !== 1) return [];
    const mainModel = [...models][0]!, modelUsage = record(r["modelUsage"]), usage = record(r["usage"]);
    const mainReceipt = counters(modelUsage?.[mainModel]);
    if (!modelUsage || !usage || !mainReceipt || mainReceipt.input !== main.input || mainReceipt.read !== main.read || mainReceipt.write !== main.write || mainReceipt.output < main.output ||
        count(usage["input_tokens"]) !== main.input || count(usage["cache_read_input_tokens"]) !== main.read || count(usage["cache_creation_input_tokens"]) !== main.write || count(usage["output_tokens"]) !== mainReceipt.output) return [];
    for (const [rawModel, raw] of Object.entries(modelUsage)) {
      const model = modelName(rawModel), observed = counters(raw);
      if (model === "<unknown>" || !observed) return [];
      const supplement = zeroTokens();
      if (model === mainModel) supplement.outputTokens = observed.output - main.output;
      else {
        // Cached/unattributed native models need a broader reconciliation design.
        if ([...native.values()].some(n => n.model === model) || observed.read || observed.write) return [];
        supplement.inputTokens = supplement.uncachedInputTokens = observed.input;
        supplement.outputTokens = observed.output;
      }
      // No separately exposed thinking counter: output classification is unknown.
      if (supplement.inputTokens + supplement.outputTokens) result.push({ model, usage: supplement, timestamp: end, executionKind: model === mainModel ? "top-level" : "unknown" });
    }
  }
  return result;
}
