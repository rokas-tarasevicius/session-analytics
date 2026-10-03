import type { ExecutionKind } from "../types.ts";

export interface CompactionEvidence {
  stream: string;
  shape: string;
  identity: string | null;
  timestamp: string | null;
  executionKind: ExecutionKind;
  turns: number;
  trigger: "auto" | "manual" | "unknown";
  preTokens: number | null;
  postTokens: number | null;
}

/** Reconcile boundaries, not whole representation groups. Raw identities stay internal.
 * Equal timestamps join different shapes only when explicit IDs do not conflict.
 * Undated/unmatched evidence is retained with uncertainty instead of guessed away.
 */
export function reconcileCompactions(points: CompactionEvidence[]) {
  const groups: Array<CompactionEvidence & { shapes: Set<string>; ambiguous: boolean }> = [];
  const byIdentity = new Map<string, typeof groups[number]>();
  const byTime = new Map<string, typeof groups>();
  let exact = true;
  // Resolve explicit IDs first, including replay timestamps, so anonymous
  // representations can join them regardless of file/format ordering.
  const ordered = [...points].sort((a,b) => Number(a.identity === null) - Number(b.identity === null) ||
    (a.timestamp ?? "\uffff").localeCompare(b.timestamp ?? "\uffff"));
  for (const point of ordered) {
    const id = point.identity === null ? null : JSON.stringify([point.stream, point.identity]);
    const time = point.timestamp === null ? null : JSON.stringify([point.stream, point.timestamp]);
    const simultaneous = time ? byTime.get(time) ?? [] : [];
    const matches = simultaneous.filter((g) => !g.shapes.has(point.shape) &&
      (point.identity === null || g.identity === null || point.identity === g.identity));
    const previous = (id ? byIdentity.get(id) : undefined) ?? matches[0];
    if (matches.length > 1 || point.timestamp === null) exact = false;
    if (matches.length > 1) for (const match of matches) match.ambiguous = true;
    if (previous) {
      previous.shapes.add(point.shape);
      previous.identity ??= point.identity;
      previous.timestamp ??= point.timestamp;
      if (point.timestamp && point.timestamp < previous.timestamp!) previous.timestamp = point.timestamp;
      previous.preTokens ??= point.preTokens;
      previous.postTokens ??= point.postTokens;
      if (previous.trigger === "unknown") previous.trigger = point.trigger;
      if (id) byIdentity.set(id, previous);
      if (time && !simultaneous.includes(previous)) { simultaneous.push(previous); byTime.set(time, simultaneous); }
    } else {
      const ambiguous = simultaneous.filter((g) => g.shapes.has(point.shape) && g.identity === null && point.identity === null);
      if (ambiguous.length) { exact = false; for (const group of ambiguous) group.ambiguous = true; }
      const group = { ...point, shapes: new Set([point.shape]), ambiguous: ambiguous.length > 0 };
      groups.push(group);
      if (id) byIdentity.set(id, group);
      if (time) { simultaneous.push(group); byTime.set(time, simultaneous); }
    }
  }
  groups.sort((a,b) => (a.timestamp ?? "\uffff").localeCompare(b.timestamp ?? "\uffff"));
  const previousByStream = new Map<string, typeof groups[number]>();
  const boundaries = groups.map((point) => {
    const previous = previousByStream.get(point.stream);
    previousByStream.set(point.stream, point);
    return { timestamp: point.timestamp, executionKind: point.executionKind, trigger: point.trigger,
      preTokens: point.preTokens, postTokens: point.postTokens,
      turnsSincePrevious: previous?.timestamp && point.timestamp && !previous.ambiguous && !point.ambiguous && point.turns >= previous.turns ? point.turns - previous.turns : null };
  });
  return { boundaries, exact };
}
