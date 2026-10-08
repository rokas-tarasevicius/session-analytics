import { boundedTimestamp } from "./bounded-time.ts";

interface CompactionEvidence {
  stream: string;
  shape: string;
  identity: string | null;
  timestamp: string | null;
}

/** Counts compaction boundaries across the several shapes a provider can record for one event.
 * Raw identities stay internal. Equal timestamps join different shapes only when explicit IDs
 * do not conflict; undated or unmatched evidence is counted rather than guessed away.
 */
export class CompactionCounter {
  private points: CompactionEvidence[] = [];

  add(stream: string, shape: string, identity: string | null, at: unknown): void {
    this.points.push({ stream, shape, identity, timestamp: boundedTimestamp(at) });
  }

  count(): number {
    const groups: Array<CompactionEvidence & { shapes: Set<string> }> = [];
    const byIdentity = new Map<string, typeof groups[number]>();
    const byTime = new Map<string, typeof groups>();
    // Resolve explicit IDs first, including replay timestamps, so anonymous
    // representations can join them regardless of file/format ordering.
    const ordered = [...this.points].sort((a, b) => Number(a.identity === null) - Number(b.identity === null) ||
      (a.timestamp ?? "￿").localeCompare(b.timestamp ?? "￿"));
    for (const point of ordered) {
      const id = point.identity === null ? null : JSON.stringify([point.stream, point.identity]);
      const time = point.timestamp === null ? null : JSON.stringify([point.stream, point.timestamp]);
      const simultaneous = time ? byTime.get(time) ?? [] : [];
      const matches = simultaneous.filter((g) => !g.shapes.has(point.shape) &&
        (point.identity === null || g.identity === null || point.identity === g.identity));
      const previous = (id ? byIdentity.get(id) : undefined) ?? matches[0];
      if (previous) {
        previous.shapes.add(point.shape);
        previous.identity ??= point.identity;
        previous.timestamp ??= point.timestamp;
        if (point.timestamp && point.timestamp < previous.timestamp!) previous.timestamp = point.timestamp;
        if (id) byIdentity.set(id, previous);
        if (time && !simultaneous.includes(previous)) { simultaneous.push(previous); byTime.set(time, simultaneous); }
      } else {
        const group = { ...point, shapes: new Set([point.shape]) };
        groups.push(group);
        if (id) byIdentity.set(id, group);
        if (time) { simultaneous.push(group); byTime.set(time, simultaneous); }
      }
    }
    return groups.length;
  }
}
