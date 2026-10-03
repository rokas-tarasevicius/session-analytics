import type { SessionOutcomes } from "./outcome-types.ts";

type Source = SessionOutcomes["lineSource"];
type Counts = { added: number; removed: number };
type Position = { sequence: number; time: number | null };
type Edit = Position & { counts: Counts | null; source: Source };
type Snapshot = Position & Counts & { source: Source };
interface Stream {
  edits: Edit[];
  snapshot: Snapshot | null;
  highAdded: number;
  highRemoved: number;
  reset: boolean;
}
interface Measurement extends Counts {
  measured: boolean;
  partial: boolean;
  sources: Set<Source>;
}
const empty = (): Measurement => ({ added: 0, removed: 0, measured: false, partial: false, sources: new Set() });
const time = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

// File order establishes chronology only within the same stream. Equal or
// absent timestamps across files cannot establish snapshot coverage.
function relation(position: Position, owner: string, snapshot: Snapshot, scope: string): number | null {
  const dated = position.time !== null && snapshot.time !== null ? Math.sign(position.time - snapshot.time) : null;
  if (owner !== scope) return dated === 0 ? null : dated;
  const ordered = Math.sign(position.sequence - snapshot.sequence);
  return dated !== null && dated !== 0 && dated !== ordered ? null : ordered;
}

/** Numeric line observations under private stream keys; no patch text or source records. */
export class OutcomeLines {
  private streams = new Map<string, Stream>();
  private sequence = 0;
  private edits = 0;
  private replayedAcrossStreams = false;
  truncated = false;

  private stream(key: string): Stream | null {
    let stream = this.streams.get(key);
    if (!stream) {
      if (this.streams.size >= 100_000) { this.truncated = true; return null; }
      stream = { edits: [], snapshot: null, highAdded: 0, highRemoved: 0, reset: false };
      this.streams.set(key, stream);
    }
    return stream;
  }

  edit(owner: string, timestamp: unknown, counts: Counts | null, source: Source): void {
    if (this.edits >= 100_000) { this.truncated = true; return; }
    const stream = this.stream(owner);
    if (!stream) return;
    stream.edits.push({ sequence: ++this.sequence, time: time(timestamp), counts, source });
    this.edits += 1;
  }

  snapshot(owner: string, timestamp: unknown, added: number, removed: number, source: Source): void {
    const stream = this.stream(owner);
    if (!stream) return;
    const snapshot = { sequence: ++this.sequence, time: time(timestamp), added, removed, source };
    const previous = stream.snapshot;
    stream.reset ||= previous !== null && (added < previous.added || removed < previous.removed ||
      (snapshot.time !== null && previous.time !== null && snapshot.time < previous.time));
    stream.highAdded = Math.max(stream.highAdded, added);
    stream.highRemoved = Math.max(stream.highRemoved, removed);
    stream.snapshot = snapshot;
  }

  replay(): void { this.replayedAcrossStreams = true; }

  private measure(scope: string, streams: Iterable<[string, Stream]>): Measurement {
    const result = empty();
    const source = this.streams.get(scope)!;
    const snapshot = source.snapshot;
    let knownAdded = 0, knownRemoved = 0, coveredAdded = 0, coveredRemoved = 0;
    if (snapshot) {
      result.added = snapshot.added; result.removed = snapshot.removed;
      result.measured = true; result.partial = source.reset;
      result.sources.add(snapshot.source);
    }
    for (const [owner, stream] of streams) for (const edit of stream.edits) {
      knownAdded += edit.counts?.added ?? 0; knownRemoved += edit.counts?.removed ?? 0;
      const order = snapshot ? relation(edit, owner, snapshot, scope) : 1;
      if (order === null) result.partial = true;
      else if (order < 0) {
        coveredAdded += edit.counts?.added ?? 0; coveredRemoved += edit.counts?.removed ?? 0;
      } else if (!edit.counts) result.partial = true;
      else {
        result.added += edit.counts.added; result.removed += edit.counts.removed;
        result.measured = true; result.sources.add(edit.source);
      }
    }
    if (snapshot) {
      // Contradictory/reset counters and ambiguous overlaps are lower bounds,
      // never grounds to erase measured edits or to add the whole patch sum.
      result.partial ||= coveredAdded > snapshot.added || coveredRemoved > snapshot.removed;
      if (knownAdded > result.added || knownRemoved > result.removed) {
        for (const [, stream] of streams) for (const edit of stream.edits) if (edit.counts) result.sources.add(edit.source);
      }
      result.added = Math.max(result.added, source.highAdded, knownAdded);
      result.removed = Math.max(result.removed, source.highRemoved, knownRemoved);
    }
    return result;
  }

  project(): Pick<SessionOutcomes, "linesAdded" | "linesRemoved" | "lineCoverage" | "lineSource"> {
    let result = empty();
    const main = this.streams.get("main");
    if (main?.snapshot) {
      // Parent cost-state is composite. Add only edits proven to follow it;
      // never sum child cumulative totals into a parent cumulative total.
      result = this.measure("main", this.streams);
      for (const [owner, stream] of this.streams) {
        if (owner === "main" || !stream.snapshot) continue;
        const child = this.measure(owner, [[owner, stream]]);
        const order = relation(stream.snapshot, owner, main.snapshot, "main");
        result.partial ||= order === null || order > 0 || child.added > result.added || child.removed > result.removed;
        result.added = Math.max(result.added, child.added);
        result.removed = Math.max(result.removed, child.removed);
      }
    } else {
      const overlapping = this.replayedAcrossStreams && [...this.streams.values()].some((stream) => stream.snapshot);
      let knownAdded = 0, knownRemoved = 0;
      for (const [owner, stream] of this.streams) {
        const measured = this.measure(owner, [[owner, stream]]);
        result.added = overlapping ? Math.max(result.added, measured.added) : result.added + measured.added;
        result.removed = overlapping ? Math.max(result.removed, measured.removed) : result.removed + measured.removed;
        result.measured ||= measured.measured; result.partial ||= measured.partial || overlapping;
        for (const source of measured.sources) result.sources.add(source);
        for (const edit of stream.edits) { knownAdded += edit.counts?.added ?? 0; knownRemoved += edit.counts?.removed ?? 0; }
      }
      result.added = Math.max(result.added, knownAdded); result.removed = Math.max(result.removed, knownRemoved);
    }
    return {
      linesAdded: result.measured ? result.added : null, linesRemoved: result.measured ? result.removed : null,
      lineCoverage: !result.measured ? "unavailable" : result.partial || this.truncated ? "partial" : "complete",
      lineSource: result.sources.size > 1 ? "mixed" : [...result.sources][0] ?? "unavailable",
    };
  }
}
