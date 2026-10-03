import type { SessionAnalytics } from "../types.ts";
import type { SessionLimitsCache } from "./limits-cache-types.ts";

export const MAX_CONTEXT_CURVE_POINTS = 20_000;
type Curve = SessionLimitsCache["context"]["curve"];

/** Keep bin maxima and endpoints; tiny allocations retain the global peak first. */
export function sampleContextCurve(curve: Curve, maximum: number): Curve {
  if (curve.length <= maximum) return curve;
  if (maximum === 0) return [];
  if (maximum < 3) {
    const peak = curve.reduce((a,b) => a.fill >= b.fill ? a : b);
    return [...new Set(maximum === 1 ? [peak] : [curve[0]!, peak === curve[0] ? curve.at(-1)! : peak])].sort((a,b) => a.request - b.request);
  }
  const maxima = Array.from({ length: maximum - 2 }, (_, index) => {
    const begin = Math.floor(index * curve.length / (maximum - 2)), end = Math.floor((index + 1) * curve.length / (maximum - 2));
    let peak = curve[begin]!;
    for (let i = begin + 1; i < end; i++) if (curve[i]!.fill > peak.fill) peak = curve[i]!;
    return peak;
  });
  return [...new Set([curve[0]!, ...maxima, curve.at(-1)!])].sort((a,b) => a.request - b.request);
}

/** Equal per-session allocations, redistributing unused slots from short curves.
 * Deterministic under discovery reordering. Buckets/counters are never sampled.
 */
export function boundContextDetail(sessions: SessionAnalytics[], maximum = MAX_CONTEXT_CURVE_POINTS): void {
  const rows = sessions.filter((s) => s.limitsCache?.context.curve.length).sort((a,b) => a.sessionKey.localeCompare(b.sessionKey));
  if (rows.reduce((n, s) => n + s.limitsCache!.context.curve.length, 0) <= maximum) return;
  const budgets = new Map(rows.map((s) => [s, 0]));
  let remaining = Math.max(0, Math.floor(maximum));
  while (remaining > 0) {
    let allocated = 0;
    for (const session of rows) {
      if (!remaining) break;
      const budget = budgets.get(session)!;
      if (budget >= session.limitsCache!.context.curve.length) continue;
      budgets.set(session, budget + 1); remaining--; allocated++;
    }
    if (!allocated) break;
  }
  for (const session of rows) {
    const context = session.limitsCache!.context;
    if (context.curve.length > budgets.get(session)!) {
      context.curve = sampleContextCurve(context.curve, budgets.get(session)!);
      context.curveSampled = true;
    }
  }
}
