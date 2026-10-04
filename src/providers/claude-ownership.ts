import { record, text, finite, type RecordValue } from "./common.ts";

interface Candidate { path: string; paths?: string[]; timestamp: string | null }
interface Owner { path: string; firstPath: string; output: number; total: number; reasoning: number | null; ttl: number; input: number; cached: number; writes: number; duplicate: boolean }

/** Select one complete physical message observation across resumed session copies.
 * Private identities and paths stay inside the analysis process. Only duplicate
 * IDs remain in the returned map; ordinary messages retain the existing path.
 */
export async function buildClaudeUsageOwners(
  candidates: readonly Candidate[],
  pathsFor: (mainPath: string) => Promise<string[]>,
  visit: (path: string, visitor: (record: RecordValue, line: number) => void) => Promise<void>,
): Promise<ReadonlyMap<string, string>> {
  const observed = new Map<string, Owner>();
  for (const candidate of [...candidates].sort((a, b) => (a.timestamp ?? "\uffff").localeCompare(b.timestamp ?? "\uffff") || a.path.localeCompare(b.path))) {
    let paths: string[];
    try { paths = [...new Set((await Promise.all((candidate.paths ?? [candidate.path]).map(pathsFor))).flat())]; } catch { continue; }
    for (const path of paths) {
      try {
        await visit(path, (event) => {
          if (event["type"] !== "assistant") return;
          const message = record(event["message"]), usage = record(message?.["usage"]);
          if (event["isApiErrorMessage"] === true || message?.["model"] === "<synthetic>") return;
          const id = text(message?.["id"]) ?? text(event["uuid"]);
          if (!id || !usage) return;
          const output = finite(usage["output_tokens"]) ?? 0;
          const total = output + (finite(usage["input_tokens"]) ?? 0) + (finite(usage["cache_read_input_tokens"]) ?? 0) +
            (finite(usage["cache_creation_input_tokens"]) ?? 0);
          const reasoning = finite(record(usage["output_tokens_details"])?.["thinking_tokens"]);
          const input = finite(usage["input_tokens"]) ?? 0, cached = finite(usage["cache_read_input_tokens"]) ?? 0;
          const ttlRecord = record(usage["cache_creation"]);
          const ttl = (finite(ttlRecord?.["ephemeral_5m_input_tokens"]) ?? 0) + (finite(ttlRecord?.["ephemeral_1h_input_tokens"]) ?? 0);
          const writes = Math.max(finite(usage["cache_creation_input_tokens"]) ?? 0, ttl);
          const previous = observed.get(id);
          const duplicate = !!previous && (previous.duplicate || previous.firstPath !== candidate.path);
          const sameCounters = previous && input === previous.input && cached === previous.cached && writes === previous.writes;
          const richer = sameCounters && ((reasoning ?? 0) > (previous.reasoning ?? 0) || ttl > previous.ttl);
          if (!previous || output > previous.output || (output === previous.output && total > 0 &&
            (previous.total === 0 || richer || (reasoning !== null && previous.reasoning === null)))) {
            observed.set(id, { path: candidate.path, firstPath: previous?.firstPath ?? candidate.path, output, total, reasoning, ttl, input, cached, writes, duplicate });
          } else if (duplicate) previous.duplicate = true;
        });
      } catch { /* The regular per-session parser retains read/parse diagnostics. */ }
    }
  }
  return new Map([...observed].filter(([, owner]) => owner.duplicate).map(([id, owner]) => [id, owner.path]));
}
