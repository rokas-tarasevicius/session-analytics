import { isDeepStrictEqual } from "node:util";

/** Derived-index failures must not be classified as invalid provider evidence. */
export class IndexParityError extends Error {
  constructor() {
    super("The local index failed a consistency check.");
    this.name = "IndexParityError";
  }
}

/** Progress is committed with the facts, never on a failed scan. */
export function rotatingSample(keys: Iterable<string>, after: string, maximum: number): string[] {
  const sorted = [...new Set(keys)].sort();
  let start = sorted.findIndex((key) => key > after);
  if (start < 0) start = 0;
  return [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, maximum);
}

export function assertIndexParity(expected: unknown, actual: unknown): void {
  if (!isDeepStrictEqual(expected, actual)) throw new IndexParityError();
}
