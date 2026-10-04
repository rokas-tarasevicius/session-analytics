import type { SessionAnalytics } from "../types.ts";
import type { RecoveryCalibration } from "./history-types.ts";

export interface RecoveryComparison {
  sessionKey: string;
  cost: { totalUsd: number };
  conductor?: { reconciliation?: { receiptFloorApplied?: boolean } };
}

/** Survival is a selection effect, not an accuracy guarantee for deleted history.
 * Compare the exact production fallback with present native accounting. Keep
 * zero/tiny, active and partial native denominators outside the ratio cohort. */
export function calibrateRecovery(native: SessionAnalytics[], recovered: RecoveryComparison[]): RecoveryCalibration {
  const byKey = new Map<string, SessionAnalytics[]>();
  for (const s of native) if (s.provider === "claude" && !s.evidence && s.transcript.files > 0 && !s.transcript.sourceDeleted) {
    const group = byKey.get(s.sessionKey) ?? []; group.push(s); byKey.set(s.sessionKey, group);
  }
  const result: RecoveryCalibration = { version: 1, basis: "paired-surviving-native", pairedSessions: 0, comparedSessions: 0,
    excludedSessions: 0, receiptFloorSessions: 0, aboveNativeSessions: 0, minimumNativeValueUsd: 1,
    nativeValueUsd: 0, recoveredValueUsd: 0, aggregateValueRatio: null, medianValueRatio: null, p10ValueRatio: null, p90ValueRatio: null };
  const ratios: number[] = [], seen = new Set<string>();
  for (const r of recovered) {
    const matches = byKey.get(r.sessionKey);
    if (!matches || seen.has(r.sessionKey)) continue;
    seen.add(r.sessionKey); result.pairedSessions++;
    const n = matches[0]!;
    if (matches.length !== 1 || n.transcript.completeness !== "complete" || n.transcript.liveness === "active" || n.transcript.snapshotWhileWorking ||
        n.costBasis !== "api-list-price-equivalent" || n.pricedTokenCoverage !== 1 || n.cost.totalUsd < result.minimumNativeValueUsd) {
      result.excludedSessions++; continue;
    }
    result.comparedSessions++;
    result.receiptFloorSessions += Number(r.conductor?.reconciliation?.receiptFloorApplied === true);
    result.aboveNativeSessions += Number(r.cost.totalUsd > n.cost.totalUsd + Math.max(0.01, n.cost.totalUsd * 0.01));
    result.nativeValueUsd += n.cost.totalUsd; result.recoveredValueUsd += r.cost.totalUsd;
    ratios.push(r.cost.totalUsd / n.cost.totalUsd);
  }
  // A handful of large sessions must not become a seemingly precise accuracy claim.
  if (ratios.length >= 5) {
    ratios.sort((a, b) => a - b);
    const quantile = (q: number) => {
      const index = (ratios.length - 1) * q, lo = Math.floor(index), hi = Math.ceil(index);
      return ratios[lo]! + (ratios[hi]! - ratios[lo]!) * (index - lo);
    };
    result.aggregateValueRatio = result.recoveredValueUsd / result.nativeValueUsd;
    result.medianValueRatio = quantile(0.5); result.p10ValueRatio = quantile(0.1); result.p90ValueRatio = quantile(0.9);
  }
  return result;
}
