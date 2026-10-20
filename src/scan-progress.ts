import type { AnalysisProgress } from "./types.ts";

export const progressPrefix = "session-analytics:progress ";

/** Reject anything beyond the small public vocabulary; never return worker-provided objects. */
export function parseProgress(serialized: string): AnalysisProgress | null {
  try {
    const value = JSON.parse(serialized) as Record<string, unknown> | null;
    if (!value || Object.keys(value).sort().join(",") !== "done,phase,total") return null;
    const { phase, done, total } = value;
    if (phase !== "discover" && phase !== "parse" && phase !== "combine") return null;
    if (typeof done !== "number" || !Number.isSafeInteger(done) || done < 0) return null;
    if (total !== null && (typeof total !== "number" || !Number.isSafeInteger(total) || total < done)) return null;
    return { phase, done, total };
  } catch { return null; }
}

/** Counters are cheap in the analyzer; only the worker formats/throttles their pipe output. */
export function progressReporter(write: (line: string) => unknown, clock: () => number = performance.now.bind(performance)) {
  let latest: AnalysisProgress | null = null, emittedPhase: AnalysisProgress["phase"] | null = null, emittedAt = -Infinity;
  const emit = () => {
    if (!latest) return;
    write(`${progressPrefix}${JSON.stringify({ phase: latest.phase, done: latest.done, total: latest.total })}\n`);
    emittedPhase = latest.phase; emittedAt = clock();
  };
  return {
    update(progress: AnalysisProgress) {
      latest = { phase: progress.phase, done: progress.done, total: progress.total };
      if (latest.phase !== emittedPhase || clock() - emittedAt >= 250) emit();
    },
    finish: emit,
  };
}
