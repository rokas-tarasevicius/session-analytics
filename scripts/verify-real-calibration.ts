/** Independent arithmetic over native snapshots and raw SDK oracle pairs. */
type Row = Record<string, any>;
export function calibrationSummary(snapshot: Row, pairs: Row[], excluded: ReadonlySet<string> = new Set()) {
  const native = new Map<string, Row[]>();
  for (const s of snapshot.sessions) if (s.provider === 'claude' && !s.evidence && s.transcript.files > 0 && !s.transcript.sourceDeleted && !excluded.has(s.sessionKey)) {
    const group = native.get(s.sessionKey) ?? []; group.push(s); native.set(s.sessionKey, group);
  }
  const result = { version: 1, basis: 'paired-surviving-native', pairedSessions: 0, comparedSessions: 0, excludedSessions: 0,
    receiptFloorSessions: 0, aboveNativeSessions: 0, minimumNativeValueUsd: 1, nativeValueUsd: 0, recoveredValueUsd: 0,
    aggregateValueRatio: null as number | null, medianValueRatio: null as number | null, p10ValueRatio: null as number | null, p90ValueRatio: null as number | null };
  const seen = new Set<string>(), ratios: number[] = [];
  for (const pair of pairs) {
    if (seen.has(pair.sessionKey) || !Number.isFinite(pair.valueUsd) || pair.valueUsd < 0 || typeof pair.receiptFloorApplied !== 'boolean') throw new Error('Invalid independent calibration pair.');
    seen.add(pair.sessionKey);
    const matches = native.get(pair.sessionKey); if (!matches) continue;
    result.pairedSessions++;
    const n = matches[0]!;
    if (matches.length !== 1 || n.transcript.completeness !== 'complete' || n.transcript.liveness === 'active' || n.transcript.snapshotWhileWorking || n.costBasis !== 'api-list-price-equivalent' || n.pricedTokenCoverage !== 1 || n.cost.totalUsd < 1) {
      result.excludedSessions++; continue;
    }
    result.comparedSessions++; result.nativeValueUsd += n.cost.totalUsd; result.recoveredValueUsd += pair.valueUsd;
    result.receiptFloorSessions += Number(pair.receiptFloorApplied);
    result.aboveNativeSessions += Number(pair.valueUsd > n.cost.totalUsd + Math.max(.01, n.cost.totalUsd * .01));
    ratios.push(pair.valueUsd / n.cost.totalUsd);
  }
  ratios.sort((a, b) => a - b);
  if (ratios.length >= 5) {
    const quantile = (fraction: number) => { const position = (ratios.length - 1) * fraction, lower = Math.floor(position); return ratios[lower]! + (ratios[Math.ceil(position)]! - ratios[lower]!) * (position - lower); };
    result.aggregateValueRatio = result.recoveredValueUsd / result.nativeValueUsd;
    result.medianValueRatio = quantile(.5); result.p10ValueRatio = quantile(.1); result.p90ValueRatio = quantile(.9);
  }
  return result;
}
export function sameCalibration(actual: Row, expected: Row): boolean {
  return !!actual && Object.keys(actual).length === Object.keys(expected).length && Object.keys(expected).every(field => actual[field] === expected[field] ||
    typeof actual[field] === 'number' && typeof expected[field] === 'number' && /Usd$|Ratio$/.test(field) && Math.abs(actual[field] - expected[field]) <= 1e-8 + Math.abs(expected[field]) * 1e-12);
}
export function proveCalibration(before: Row, after: Row, beforePairs: Row[], afterPairs: Row[], excluded: ReadonlySet<string>) {
  const a = calibrationSummary(before, beforePairs), b = calibrationSummary(after, afterPairs);
  const stableA = calibrationSummary(before, beforePairs, excluded), stableB = calibrationSummary(after, afterPairs, excluded);
  if (!sameCalibration(before.historyCoverage.recoveryCalibration, a) || !sameCalibration(after.historyCoverage.recoveryCalibration, b) || !sameCalibration(stableA, stableB)) return null;
  return { stable: stableA, excludedSessionKeys: [...excluded].filter(key => beforePairs.some(p=>p.sessionKey===key) || afterPairs.some(p=>p.sessionKey===key)).sort() };
}
