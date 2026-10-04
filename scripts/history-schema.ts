import type * as H from "../src/metrics/history-types.ts";
import { arr, en, i, n, nil, obj, ref, signed, type Schema } from "./metric-schema.ts";

export function historySchemas(): Record<string, Schema> {
  const day = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
  const month = { type: "string", pattern: "^\\d{4}-\\d{2}$" };
  return {
    HistoryUsageDay: obj<H.HistoryUsageDay>({ day, model: ref("HistoryModelId"), tokens: i, valueUsd: n }),
    HistoryStatistics: obj<H.HistoryStatistics>({ basis: en("claude-stream-snapshots-v5"), days: arr(obj<H.HistoryStatistics["days"][number]>({ day, model: ref("HistoryModelId"), tokens: i })) }),
    HistoryModelId: { type: "string", maxLength: 160, pattern: "^(<unknown>|(?:@cf/)?[A-Za-z][A-Za-z0-9._-]*(?:/[A-Za-z][A-Za-z0-9._-]*){0,2})$" },
    SessionHistory: obj<H.SessionHistory>({ days: arr(ref("HistoryUsageDay")), undatedTokens: i, undatedValueUsd: n }),
    HistoryReconciliation: obj<H.HistoryReconciliation>({ messageValueUsd: n, reportedUsd: nil(n), differenceUsd: nil(signed), relativeDifference: nil(signed), status: en("agrees", "differs", "partial", "unavailable"), receiptScope: en("complete", "partial", "unavailable"), messages: i, messagesWithoutUsage: i, messagesWithoutIdentity: i }),
    HistoryModelCoverage: obj<H.HistoryModelCoverage>({ model: ref("HistoryModelId"), statisticsDays: i, providerTokens: i, sessionTokens: i, sessionStatisticsTokens: i, gapTokens: i,
      possibleOverlapTokens: i, unattributedTokens: i, pricedUnattributedTokens: i, unattributedEstimateUsd: n, tokenMixSource: en("lifetime-model", "unavailable") }),
    HistoryProfileMonth: obj<H.HistoryProfileMonth>({ month, models: arr(ref("HistoryModelCoverage")) }),
    HistoryProfile: obj<H.HistoryProfile>({ profileKey: { type: "string", pattern: "^profile-[a-f0-9]{20}$" }, ordinal: i, status: en("available", "missing", "unsupported", "unreadable"),
      dailyTokensVersion: nil(i), statisticsThrough: nil(day), firstStatisticsDay: nil(day), firstTranscriptDay: nil(day), lifetimeTokens: i, sessionsWithoutStatisticsCounters: i, months: arr(ref("HistoryProfileMonth")) }),
    HistoryMonth: obj<H.HistoryMonth>({ month, sessionsWithDatedValue: i, statisticsCells: i, sessionEvidenceUsd: n, unattributedEstimateUsd: n, unattributedTokens: i, pricedUnattributedTokens: i, possibleOverlapTokens: i, recoveredMessageUsd: n }),
    HistoryCoverage: obj<H.HistoryCoverage>({ version: en(1), scope: en("machine"), profiles: arr(ref("HistoryProfile")), months: arr(ref("HistoryMonth")), undatedSessionValueUsd: n, unassignedProfileTokens: i }),
  };
}
