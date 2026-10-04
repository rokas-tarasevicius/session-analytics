import type { MachineAnalytics, SessionAnalytics } from "../types.ts";
import { validModelId } from "../public/model-id.js";

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
const validDay = (value: string) => /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validMonth = (value: string) => validDay(`${value}-01`);
const validModel = (value: string) => value === "<unknown>" || validModelId(value);

/** Schemas enforce the field boundary; these checks enforce the accounting boundary. */
export function validSessionHistory(session: SessionAnalytics): boolean {
  if (session.historyStatistics) {
    if (session.provider !== "claude") return false;
    const keys = new Set<string>();
    for (const row of session.historyStatistics.days) {
      const key = `${row.day}:${row.model}`;
      if (!validDay(row.day) || !validModel(row.model) || keys.has(key)) return false;
      keys.add(key);
    }
  }
  const history = session.history, comparison = session.conductor?.reconciliation;
  if (comparison?.outputTokensRecovered !== undefined && comparison.outputTokensRecovered > session.tokens.outputTokens) return false;
  const floor = comparison?.receiptFloorApplied === true;
  if (floor ? session.evidence?.source !== "conductor-result" : session.evidence?.source !== "conductor-messages") return !history && !comparison;
  if (!comparison || (floor ? history || session.costBasis !== "provider-reported" || comparison.reportedUsd === null ||
      !close(comparison.reportedUsd, session.cost.totalUsd) || comparison.messageValueUsd >= session.cost.totalUsd :
      !history || !close(comparison.messageValueUsd, session.cost.totalUsd)) || comparison.messages !== session.metrics.assistantMessages ||
      comparison.messagesWithoutIdentity > comparison.messages || comparison.messagesWithoutUsage > comparison.messages) return false;
  if (comparison.reportedUsd === null) {
    if (comparison.receiptScope !== "unavailable" || comparison.status !== "unavailable" || comparison.differenceUsd !== null || comparison.relativeDifference !== null) return false;
  } else {
    if (comparison.receiptScope === "unavailable" || comparison.differenceUsd === null || !close(comparison.differenceUsd, comparison.messageValueUsd - comparison.reportedUsd)) return false;
    if (comparison.reportedUsd === 0 ? comparison.relativeDifference !== null : comparison.relativeDifference === null || !close(comparison.relativeDifference, comparison.differenceUsd / comparison.reportedUsd)) return false;
    const partial = floor || comparison.receiptScope === "partial" || comparison.messagesWithoutIdentity > 0 || comparison.messagesWithoutUsage > 0 || session.pricedTokenCoverage !== 1;
    const status = partial ? "partial" : Math.abs(comparison.differenceUsd) <= Math.max(0.01, comparison.reportedUsd * 0.01) ? "agrees" : "differs";
    if (comparison.status !== status) return false;
  }
  if (floor) return true;
  if (!history) return false;
  const keys = new Set<string>(), costs = new Map<string, number>();
  let tokens = history.undatedTokens, value = history.undatedValueUsd;
  for (const row of history.days) {
    const key = `${row.day}:${row.model}`;
    if (!validDay(row.day) || !validModel(row.model) || keys.has(key)) return false;
    keys.add(key); tokens += row.tokens; value += row.valueUsd;
    costs.set(row.day, (costs.get(row.day) ?? 0) + row.valueUsd);
  }
  if (tokens !== session.tokens.inputTokens + session.tokens.outputTokens || !close(value, session.cost.totalUsd)) return false;
  for (const [day, usd] of costs) if (!close(usd, session.spendByDay[day] ?? 0)) return false;
  for (const [day, usd] of Object.entries(session.spendByDay)) if (!close(usd, costs.get(day) ?? 0)) return false;
  return true;
}

export function validHistoryCoverage(snapshot: MachineAnalytics): boolean {
  const history = snapshot.historyCoverage;
  if (!history) return true;
  const calibration = history.recoveryCalibration;
  if (calibration) {
    const c = calibration;
    if (c.comparedSessions + c.excludedSessions !== c.pairedSessions || c.receiptFloorSessions > c.comparedSessions || c.aboveNativeSessions > c.comparedSessions ||
        c.minimumNativeValueUsd !== 1 || c.nativeValueUsd < c.comparedSessions * c.minimumNativeValueUsd) return false;
    if (!c.comparedSessions && (c.nativeValueUsd !== 0 || c.recoveredValueUsd !== 0)) return false;
    const ratios = [c.aggregateValueRatio, c.p10ValueRatio, c.medianValueRatio, c.p90ValueRatio];
    if (c.comparedSessions < 5) { if (ratios.some(r => r !== null)) return false; }
    else if (ratios.some(r => r === null) || !close(c.aggregateValueRatio!, c.recoveredValueUsd / c.nativeValueUsd) || c.p10ValueRatio! > c.medianValueRatio! || c.medianValueRatio! > c.p90ValueRatio!) return false;
  }
  const profiles = new Set<string>(), totals = new Map<string, { tokens: number; priced: number; overlap: number; usd: number; cells: number }>();
  for (const profile of history.profiles) {
    if (profiles.has(profile.profileKey) || [profile.firstStatisticsDay, profile.firstTranscriptDay, profile.statisticsThrough].some((day) => day !== null && !validDay(day))) return false;
    profiles.add(profile.profileKey);
    const months = new Set<string>();
    for (const month of profile.months) {
      if (!validMonth(month.month) || months.has(month.month) || profile.status !== "available") return false;
      months.add(month.month);
      const models = new Set<string>(), total = totals.get(month.month) ?? { tokens: 0, priced: 0, overlap: 0, usd: 0, cells: 0 };
      for (const model of month.models) {
        if (!validModel(model.model) || models.has(model.model) || model.gapTokens < Math.max(0, model.providerTokens - model.sessionStatisticsTokens) || model.gapTokens > model.providerTokens ||
            model.unattributedTokens + model.possibleOverlapTokens !== model.gapTokens || model.pricedUnattributedTokens > model.unattributedTokens) return false;
        models.add(model.model); total.tokens += model.unattributedTokens; total.priced += model.pricedUnattributedTokens;
        total.overlap += model.possibleOverlapTokens; total.usd += model.unattributedEstimateUsd; total.cells += model.statisticsDays;
      }
      totals.set(month.month, total);
    }
  }
  const dated = new Map<string, { usd: number; count: number; recovered: number }>();
  let undated = 0, unassigned = 0;
  for (const session of snapshot.sessions) {
    let usd = 0;
    const seen = new Set<string>();
    for (const [day, value] of Object.entries(session.spendByDay)) {
      const month = day.slice(0, 7), row = dated.get(month) ?? { usd: 0, count: 0, recovered: 0 };
      row.usd += value; row.count += Number(!seen.has(month)); seen.add(month); usd += value; dated.set(month, row);
    }
    for (const bucket of session.history?.days ?? []) {
      const month = bucket.day.slice(0, 7), row = dated.get(month) ?? { usd: 0, count: 0, recovered: 0 };
      row.recovered += bucket.valueUsd; unassigned += bucket.tokens; dated.set(month, row);
    }
    unassigned += session.history?.undatedTokens ?? 0;
    undated += Math.max(0, session.cost.totalUsd - usd);
  }
  if (!close(undated, history.undatedSessionValueUsd) || unassigned !== history.unassignedProfileTokens) return false;
  const months = new Set<string>();
  for (const month of history.months) {
    if (!validMonth(month.month) || months.has(month.month)) return false;
    months.add(month.month);
    const stats = totals.get(month.month), evidence = dated.get(month.month);
    if (month.unattributedTokens !== (stats?.tokens ?? 0) || month.pricedUnattributedTokens !== (stats?.priced ?? 0) || month.possibleOverlapTokens !== (stats?.overlap ?? 0) ||
      month.statisticsCells !== (stats?.cells ?? 0) || !close(month.unattributedEstimateUsd, stats?.usd ?? 0) || !close(month.sessionEvidenceUsd, evidence?.usd ?? 0) ||
      month.sessionsWithDatedValue !== (evidence?.count ?? 0) || !close(month.recoveredMessageUsd, evidence?.recovered ?? 0)) return false;
  }
  return [...totals.keys(), ...dated.keys()].every((month) => months.has(month));
}
