import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionAnalytics, TokenUsage } from "../types.ts";
import type { HistoryCoverage, HistoryModelCoverage, HistoryMonth, HistoryProfile } from "./history-types.ts";
import { key } from "./limits-utils.ts";
import { projectModelId } from "../public/model-id.js";
import { record, zeroTokens, type RecordValue } from "../providers/common.ts";
import { resolveRate, type PricingCatalog } from "../pricing/catalog.ts";
import { priceUsage } from "../pricing/usage.ts";

const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
function day(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
}
interface Cell { profile: HistoryProfile; day: string; model: string; provider: number; session: number; statisticsSession: number; gap: number; overlap: number; mix: TokenUsage | null }
interface Statistics { profile: HistoryProfile; cells: Cell[] }

async function statistics(root: string, ordinal: number): Promise<Statistics> {
  const directory = basename(root) === "projects" ? dirname(root) : root;
  let canonical = resolve(directory);
  try { canonical = await realpath(directory); } catch { /* Missing profile is normal. */ }
  const profile: HistoryProfile = { profileKey: `profile-${key(`claude:directory:${canonical}`)}`, ordinal,
    status: "missing", dailyTokensVersion: null, statisticsThrough: null, firstStatisticsDay: null, firstTranscriptDay: null, lifetimeTokens: 0, sessionsWithoutStatisticsCounters: 0, months: [] };
  const cells: Cell[] = [];
  let data: RecordValue | null;
  try {
    const path = join(directory, "stats-cache.json");
    if ((await stat(path)).size > 8 * 1024 * 1024) { profile.status = "unsupported"; return { profile, cells }; }
    data = record(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    profile.status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    return { profile, cells };
  }
  profile.dailyTokensVersion = integer(data?.["dailyModelTokensVersion"]);
  profile.statisticsThrough = day(data?.["lastComputedDate"]);
  const daily = data?.["dailyModelTokens"], lifetime = record(data?.["modelUsage"]);
  // v5 sums the four physical token classes in EVERY streamed block. Compare
  // against the same observation basis, never just deduplicated priced requests.
  if (profile.dailyTokensVersion !== 5 || !Array.isArray(daily) || daily.length > 20_000 || Object.keys(lifetime ?? {}).length > 256) {
    profile.status = "unsupported"; return { profile, cells };
  }
  profile.status = "available";
  const mixtures = new Map<string, TokenUsage>();
  for (const [rawModel, raw] of Object.entries(lifetime ?? {})) {
    const model = projectModelId(rawModel), item = record(raw);
    if (model === "<unknown>" || !item) continue;
    const values = ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "outputTokens"].map((field) => integer(item[field]));
    if (values.some((value) => value === null)) continue;
    const [input, read, write, output] = values as [number, number, number, number];
    const total = input + read + write + output;
    if (!Number.isSafeInteger(total) || total <= 0) continue;
    profile.lifetimeTokens += total;
    mixtures.set(model, { ...zeroTokens(), inputTokens: input + read + write, uncachedInputTokens: input, cachedInputTokens: read,
      cacheWriteInputTokens: write, outputTokens: output, nonReasoningOutputTokens: output });
  }
  const unique = new Map<string, Cell>();
  for (const raw of daily) {
    const item = record(raw), at = day(item?.["date"]), models = record(item?.["tokensByModel"]);
    if (!at || !models || Object.keys(models).length > 256 || profile.statisticsThrough && at > profile.statisticsThrough) continue;
    for (const [rawModel, rawTokens] of Object.entries(models)) {
      const model = projectModelId(rawModel), tokens = integer(rawTokens);
      if (model === "<unknown>" || tokens === null) continue;
      const id = `${at}:${model}`, previous = unique.get(id);
      // Repeated rows are snapshots, not additive daily intervals.
      if (!previous || tokens > previous.provider) unique.set(id, { profile, day: at, model, provider: tokens, session: 0, statisticsSession: 0, gap: 0, overlap: 0, mix: mixtures.get(model) ?? null });
    }
  }
  cells.push(...[...unique.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model)));
  profile.firstStatisticsDay = cells[0]?.day ?? null;
  return { profile, cells };
}

function estimate(cell: Cell, count: number, rates: PricingCatalog): { usd: number; pricedTokens: number } {
  if (!count) return { usd: 0, pricedTokens: 0 };
  const selected = resolveRate(rates, cell.model, `${cell.day}T12:00:00Z`), mix = cell.mix;
  if (!selected || !mix) return { usd: 0, pricedTokens: 0 };
  const total = mix.inputTokens + mix.outputTokens;
  // Price the lifetime class proportions at ordinary request rates; aggregate
  // volume is never passed as a fictitious long-context request. No costUSD use.
  const priced = priceUsage(selected.rate, mix, 0);
  return { usd: priced.cost.totalUsd * count / total, pricedTokens: Math.floor(count * priced.pricedTokens / total) };
}

/** Independent of repository totals. Native dated evidence and unknown-profile
 * recovery share one UTC day/model overlap pool, consumed at most once. */
export async function collectHistoryCoverage(roots: string[], sessions: SessionAnalytics[], rates: PricingCatalog, discovery?: { home: string; override?: string }): Promise<HistoryCoverage> {
  const result: HistoryCoverage = { version: 1, scope: "machine", profiles: [], months: [], undatedSessionValueUsd: 0, unassignedProfileTokens: 0 };
  const stores: Statistics[] = [], seen = new Set<string>();
  const candidates = [...roots];
  if (discovery) {
    const profiles = [join(discovery.home, ".claude"), join(discovery.home, ".config", "claude"), ...(discovery.override ? [discovery.override] : [])];
    try {
      for (const entry of (await readdir(discovery.home, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".claude-") && (entry.isDirectory() || entry.isSymbolicLink())) profiles.push(join(discovery.home, entry.name));
      }
    } catch { /* Existing roots still describe available evidence. */ }
    for (const profile of profiles) {
      // Stats can outlive even the projects directory. Explicit transcript roots
      // never enter this discovery path, keeping demos/narrowed scans isolated.
      try { if ((await stat(join(profile, "stats-cache.json"))).isFile()) candidates.push(join(profile, "projects")); } catch { /* Optional store. */ }
    }
  }
  for (const root of candidates) {
    const store = await statistics(root, stores.length + 1);
    if (seen.has(store.profile.profileKey)) continue;
    seen.add(store.profile.profileKey); stores.push(store);
  }
  const evidence = new Map<string, number>(), statisticsEvidence = new Map<string, number>(), unknown = new Map<string, number>(), months = new Map<string, HistoryMonth>();
  const month = (id: string) => {
    let row = months.get(id);
    if (!row) { row = { month: id, sessionsWithDatedValue: 0, statisticsCells: 0, sessionEvidenceUsd: 0, unattributedEstimateUsd: 0, unattributedTokens: 0, pricedUnattributedTokens: 0, possibleOverlapTokens: 0, recoveredMessageUsd: 0 }; months.set(id, row); }
    return row;
  };
  const profiles = new Map(stores.map(({ profile }) => [profile.profileKey, profile]));
  for (const session of sessions) {
    let datedValue = 0;
    const datedMonths = new Set<string>();
    for (const [at, value] of Object.entries(session.spendByDay)) if (day(at)) { month(at.slice(0, 7)).sessionEvidenceUsd += value; datedValue += value; datedMonths.add(at.slice(0, 7)); }
    for (const at of datedMonths) month(at).sessionsWithDatedValue++;
    result.undatedSessionValueUsd += Math.max(0, session.cost.totalUsd - datedValue);
    if (session.provider !== "claude") continue;
    const profileKey = session.limitsCache?.profileKey, profile = profileKey ? profiles.get(profileKey) : null;
    if (profile) {
      const first = day(session.firstEventAt?.slice(0, 10));
      if (!session.transcript.sourceDeleted && first && (!profile.firstTranscriptDay || first < profile.firstTranscriptDay)) profile.firstTranscriptDay = first;
      for (const bucket of session.limitsCache?.buckets ?? []) if (bucket.day && day(bucket.day)) {
        const id = `${profileKey}:${bucket.day}:${bucket.model}`;
        evidence.set(id, (evidence.get(id) ?? 0) + bucket.observedTokens);
      }
      // Older source-deleted index facts cannot reconstruct stream redundancy;
      // their deduplicated counters provide only a conservative subtraction.
      if (!session.historyStatistics && session.limitsCache?.buckets.length) profile.sessionsWithoutStatisticsCounters++;
      const statistics = session.historyStatistics?.days ?? (session.limitsCache?.buckets ?? []).flatMap((b) => b.day ? [{ day: b.day, model: b.model, tokens: b.observedTokens }] : []);
      for (const bucket of statistics) {
        const id = `${profileKey}:${bucket.day}:${bucket.model}`;
        statisticsEvidence.set(id, (statisticsEvidence.get(id) ?? 0) + bucket.tokens);
      }
    } else if (session.history) {
      for (const bucket of session.history.days) {
        result.unassignedProfileTokens += bucket.tokens;
        month(bucket.day.slice(0, 7)).recoveredMessageUsd += bucket.valueUsd;
      }
      result.unassignedProfileTokens += session.history.undatedTokens;
    }
    // Selecting the higher receipt basis must not discard retained SDK stream
    // overlap evidence or create a new apparent statistics gap.
    if (!profile) for (const bucket of session.historyStatistics?.days ?? session.history?.days ?? []) {
      const id = `${bucket.day}:${bucket.model}`;
      unknown.set(id, (unknown.get(id) ?? 0) + bucket.tokens);
    }
  }
  const byDayModel = new Map<string, Cell[]>();
  for (const { cells } of stores) for (const cell of cells) {
    cell.session = evidence.get(`${cell.profile.profileKey}:${cell.day}:${cell.model}`) ?? 0;
    cell.statisticsSession = statisticsEvidence.get(`${cell.profile.profileKey}:${cell.day}:${cell.model}`) ?? 0;
    cell.gap = Math.max(0, cell.provider - cell.statisticsSession);
    const id = `${cell.day}:${cell.model}`, group = byDayModel.get(id) ?? [];
    group.push(cell); byDayModel.set(id, group);
  }
  for (const [id, group] of byDayModel) {
    const totalGap = group.reduce((n, cell) => n + cell.gap, 0), reserve = Math.min(totalGap, unknown.get(id) ?? 0);
    if (!reserve) continue;
    // Proportional reservation is uncertainty, not profile attribution. Largest
    // remainders keep integer operands and exact conservation across profiles.
    for (const cell of group) cell.overlap = Math.floor(reserve * cell.gap / totalGap);
    let remainder = reserve - group.reduce((n, cell) => n + cell.overlap, 0);
    for (const cell of [...group].sort((a, b) => (reserve * b.gap / totalGap - b.overlap) - (reserve * a.gap / totalGap - a.overlap) || a.profile.profileKey.localeCompare(b.profile.profileKey))) {
      if (remainder-- <= 0) break;
      cell.overlap++;
    }
  }
  for (const { profile, cells } of stores) {
    const profileMonths = new Map<string, Map<string, HistoryModelCoverage>>();
    for (const cell of cells) {
      const id = cell.day.slice(0, 7), models = profileMonths.get(id) ?? new Map<string, HistoryModelCoverage>();
      profileMonths.set(id, models);
      const row = models.get(cell.model) ?? { model: cell.model, statisticsDays: 0, providerTokens: 0, sessionTokens: 0, sessionStatisticsTokens: 0, gapTokens: 0, possibleOverlapTokens: 0,
        unattributedTokens: 0, pricedUnattributedTokens: 0, unattributedEstimateUsd: 0, tokenMixSource: cell.mix ? "lifetime-model" : "unavailable" };
      const remainder = cell.gap - cell.overlap, value = estimate(cell, remainder, rates), global = month(id);
      row.statisticsDays++; row.providerTokens += cell.provider; row.sessionTokens += cell.session; row.gapTokens += cell.gap;
      row.sessionStatisticsTokens += cell.statisticsSession;
      row.possibleOverlapTokens += cell.overlap; row.unattributedTokens += remainder;
      row.pricedUnattributedTokens += value.pricedTokens; row.unattributedEstimateUsd += value.usd;
      global.unattributedTokens += remainder; global.pricedUnattributedTokens += value.pricedTokens;
      global.statisticsCells++;
      global.unattributedEstimateUsd += value.usd; global.possibleOverlapTokens += cell.overlap;
      models.set(cell.model, row);
    }
    profile.months = [...profileMonths].map(([month, models]) => ({ month, models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model)) })).sort((a, b) => a.month.localeCompare(b.month));
    result.profiles.push(profile);
  }
  result.months = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return result;
}
