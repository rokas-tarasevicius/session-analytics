import { record, text, finite, type RecordValue } from "./common.ts";
import { mapConcurrent } from "../concurrency.ts";

interface Candidate { path: string; paths?: string[]; timestamp: string | null }
interface Owner { path: string; firstPath: string; firstFile: string; files?: Set<string>; output: number; total: number; reasoning: number | null; ttl: number; input: number; cached: number; writes: number; duplicate: boolean }

/** One assistant usage observation from one file, in file order. The key is the
 * message ID, or its keyed hash when the private index supplies the key. */
export type ClaudeUsageObservation = [key: string, output: number, total: number, reasoning: number | null, ttl: number, input: number, cached: number, writes: number];
/** `complete` is false when the file could not be read to its end; its earlier observations still count. */
export interface ClaudeObservationRead { observations: ClaudeUsageObservation[]; complete: boolean }
/** The private index replays unchanged files' observations instead of re-reading them. */
export interface ClaudeOwnershipCache {
  key(id: string): string;
  prefetch(paths: string[]): Promise<void>;
  observations(path: string, read: () => Promise<ClaudeObservationRead>): Promise<ClaudeObservationRead>;
}

/** Duplicated message IDs (or their keyed hashes) mapped to their owning main path. */
export class ClaudeUsageOwners extends Map<string, string> {
  private readonly sharedFiles = new Set<string>();
  private readonly visitedFiles = new Set<string>();
  private readonly keyOf: (id: string) => string;

  constructor(keyOf: (id: string) => string = (id) => id) { super(); this.keyOf = keyOf; }

  visited(file: string): void { this.visitedFiles.add(file); }

  own(key: string, owner: string, files: Iterable<string>): void {
    this.set(key, owner);
    for (const file of files) this.sharedFiles.add(file);
  }

  /** The owning main path of a raw message ID, if another session also records it. */
  ownerOf(id: string): string | undefined { return this.size ? this.get(this.keyOf(id)) : undefined; }

  /** Whether any of these files observes a message another session also records, or could: a file
   * this pass did not read completely is unknown whenever any message is shared. */
  sharedBy(paths: Iterable<string>): boolean {
    for (const path of paths) if (this.sharedFiles.has(path) || (this.size > 0 && !this.visitedFiles.has(path))) return true;
    return false;
  }
}

/** Extract one file's usage observations. Repeating the immediately previous observation of the
 * same message in the same file cannot change the selection below, so such repeats are dropped. */
async function readObservations(
  path: string,
  visit: (path: string, visitor: (record: RecordValue, line: number) => void) => Promise<void>,
  key: (id: string) => string,
): Promise<ClaudeObservationRead> {
  const observations: ClaudeUsageObservation[] = [];
  const latest = new Map<string, ClaudeUsageObservation>();
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
      const previous = latest.get(id);
      const observation: ClaudeUsageObservation = [previous?.[0] ?? key(id), output, total, reasoning, ttl, input, cached, writes];
      if (previous && previous.every((value, index) => value === observation[index])) return;
      latest.set(id, observation); observations.push(observation);
    });
    return { observations, complete: true };
  } catch { return { observations, complete: false }; } // The regular per-session parser retains read/parse diagnostics.
}

const PATH_CONCURRENCY = 16;

/** Select one complete physical message observation across resumed session copies.
 * Private identities and paths stay inside the analysis process. Only duplicate
 * IDs remain in the returned map; ordinary messages retain the existing path.
 */
export async function buildClaudeUsageOwners(
  candidates: readonly Candidate[],
  pathsFor: (mainPath: string) => Promise<string[]>,
  visit: (path: string, visitor: (record: RecordValue, line: number) => void) => Promise<void>,
  cache?: ClaudeOwnershipCache | null,
): Promise<ClaudeUsageOwners> {
  const key = cache ? (id: string) => cache.key(id) : (id: string) => id;
  const observed = new Map<string, Owner>();
  const owners = new ClaudeUsageOwners(key);
  const ordered = [...candidates].sort((a, b) => (a.timestamp ?? "￿").localeCompare(b.timestamp ?? "￿") || a.path.localeCompare(b.path));
  const evidence = await mapConcurrent(ordered, PATH_CONCURRENCY, async (candidate) => {
    try { return [...new Set((await Promise.all((candidate.paths ?? [candidate.path]).map(pathsFor))).flat())]; } catch { return null; }
  });
  await cache?.prefetch(evidence.flatMap((paths) => paths ?? []));
  for (const [position, candidate] of ordered.entries()) {
    const paths = evidence[position];
    if (!paths) continue;
    for (const path of paths) {
      const read = () => readObservations(path, visit, key);
      const { observations, complete } = cache ? await cache.observations(path, read) : await read();
      for (const [id, output, total, reasoning, ttl, input, cached, writes] of observations) {
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
      }
      if (complete) owners.visited(path);
    }
  }
  for (const [id, owner] of observed) if (owner.duplicate) owners.own(id, owner.path, owner.files ?? [owner.firstFile]);
  return owners;
}
