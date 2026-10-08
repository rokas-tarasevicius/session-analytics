import { record, text, finite, type RecordValue } from "./common.ts";

interface Candidate { path: string; paths?: string[]; timestamp: string | null }
interface Owner { path: string; firstPath: string; firstFile: string; files?: Set<string>; output: number; total: number; reasoning: number | null; ttl: number; input: number; cached: number; writes: number; duplicate: boolean }

/** Duplicated message IDs mapped to their owning main path. */
export class ClaudeUsageOwners extends Map<string, string> {
  private readonly sharedFiles = new Set<string>();
  private readonly visitedFiles = new Set<string>();

  visited(file: string): void { this.visitedFiles.add(file); }

  own(id: string, owner: string, files: Iterable<string>): void {
    this.set(id, owner);
    for (const file of files) this.sharedFiles.add(file);
  }

  /** Whether any of these files observes a message another session also records, or could: a file
   * this pass did not read completely is unknown whenever any message is shared. */
  sharedBy(paths: Iterable<string>): boolean {
    for (const path of paths) if (this.sharedFiles.has(path) || (this.size > 0 && !this.visitedFiles.has(path))) return true;
    return false;
  }
}

/** Select one complete physical message observation across resumed session copies.
 * Private identities and paths stay inside the analysis process. Only duplicate
 * IDs remain in the returned map; ordinary messages retain the existing path.
 */
export async function buildClaudeUsageOwners(
  candidates: readonly Candidate[],
  pathsFor: (mainPath: string) => Promise<string[]>,
  visit: (path: string, visitor: (record: RecordValue, line: number) => void) => Promise<void>,
): Promise<ClaudeUsageOwners> {
  const observed = new Map<string, Owner>();
  const owners = new ClaudeUsageOwners();
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
          // Most messages appear once; only a repeated ID pays for a file set.
          if (previous) (previous.files ??= new Set([previous.firstFile])).add(path);
          const duplicate = !!previous && (previous.duplicate || previous.firstPath !== candidate.path);
          const sameCounters = previous && input === previous.input && cached === previous.cached && writes === previous.writes;
          const richer = sameCounters && ((reasoning ?? 0) > (previous.reasoning ?? 0) || ttl > previous.ttl);
          if (!previous || output > previous.output || (output === previous.output && total > 0 &&
            (previous.total === 0 || richer || (reasoning !== null && previous.reasoning === null)))) {
            observed.set(id, { path: candidate.path, firstPath: previous?.firstPath ?? candidate.path, firstFile: previous?.firstFile ?? path,
              ...(previous?.files ? { files: previous.files } : {}), output, total, reasoning, ttl, input, cached, writes, duplicate });
          } else if (duplicate) previous.duplicate = true;
        });
        owners.visited(path);
      } catch { /* The regular per-session parser retains read/parse diagnostics. */ }
    }
  }
  for (const [id, owner] of observed) if (owner.duplicate) owners.own(id, owner.path, owner.files ?? [owner.firstFile]);
  return owners;
}
