import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { SessionAnalytics } from "../types.ts";
import type { LimitHitKind, LimitProfile, LimitProvider, LimitSample, LimitSource, LimitWindow, LimitsCacheAnalytics, ProfileConfig, SubscriptionMonth } from "./limits-cache-types.ts";
import { CONTEXT_TABLE_REVIEWED_AT } from "./context-windows.ts";
import { defaultDataDirectory, optionalJson, readLimitsConfig } from "./limits-config.ts";
import { boolean, FRESHNESS_MINUTES, key, MAX_OBSERVATIONS, MIN_INPUT_TOKENS, MIN_OBSERVED_MINUTES, MIN_REQUESTS, nonnegative, oneOf, percent, record, sample, timestamp } from "./limits-utils.ts";

interface WindowState {
  key: string;
  label: string;
  windowMinutes: number | null;
  observations: Map<string, LimitSample>;
  duplicatesDiscarded: number;
  historyLimited: boolean;
}
interface ProfileState {
  key: string;
  provider: LimitProvider;
  ordinal: number;
  label: string;
  scope: LimitProfile["scope"];
  planType: LimitProfile["planType"];
  planObservedAt: string | null;
  credits: LimitProfile["credits"];
  windows: Map<string, WindowState>;
  hits: Map<string, { timestamp: string; kind: LimitHitKind }>;
  hitSessions: Set<string>;
  config: ProfileConfig | undefined;
}

export function summarizeLimitWindow(state: Pick<WindowState, "key" | "label" | "windowMinutes" | "duplicatesDiscarded" | "historyLimited">, samples: LimitSample[], now: number): LimitWindow {
  const ordered = [...samples].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const points = ordered.slice(-MAX_OBSERVATIONS);
  const latest = points.at(-1)!;
  const age = (now - Date.parse(latest.timestamp)) / 60_000;
  const stale = age < 0 || age >= FRESHNESS_MINUTES || !!latest.resetsAt && Date.parse(latest.resetsAt) <= now;
  let observedMinutes = 0, above90Minutes = 0;
  for (let index = 1; index < points.length; index++) {
    const before = points[index - 1]!, after = points[index]!;
    if (before.usedPercent === null || after.usedPercent === null) continue;
    const start = Date.parse(before.timestamp), end = Date.parse(after.timestamp);
    if (end > now || start > now) continue;
    if (end - start > FRESHNESS_MINUTES * 60_000) continue;
    const minutes = Math.max(0, Math.min(end, before.resetsAt ? Date.parse(before.resetsAt) : end) - start) / 60_000;
    observedMinutes += minutes;
    if (before.usedPercent >= 90) above90Minutes += minutes;
  }
  let timeToLimitMinutes: number | null = null;
  const recent = points.slice(-3);
  if (!stale && latest.usedPercent !== null && latest.usedPercent >= 100) timeToLimitMinutes = 0;
  else if (!stale && latest.resetsAt && recent.length === 3 && recent.every((p) => p.resetsAt === latest.resetsAt && p.usedPercent !== null)) {
    const first = recent[0]!, middle = recent[1]!;
    const minutes = (Date.parse(latest.timestamp) - Date.parse(first.timestamp)) / 60_000;
    const growth = latest.usedPercent! - first.usedPercent!;
    const contiguous = (Date.parse(middle.timestamp) - Date.parse(first.timestamp)) <= FRESHNESS_MINUTES * 60_000 && (Date.parse(latest.timestamp) - Date.parse(middle.timestamp)) <= FRESHNESS_MINUTES * 60_000;
    if (minutes >= MIN_OBSERVED_MINUTES && growth > 0 && middle.usedPercent! >= first.usedPercent! && latest.usedPercent! >= middle.usedPercent! && contiguous) {
      const estimate = (100 - latest.usedPercent!) * minutes / growth;
      // This is a projection from the last observation, not invented usage since it.
      if (Date.parse(latest.timestamp) + estimate * 60_000 <= Date.parse(latest.resetsAt)) timeToLimitMinutes = estimate;
    }
  }
  return { key: state.key, label: state.label, windowMinutes: state.windowMinutes,
    observations: points.length, duplicatesDiscarded: state.duplicatesDiscarded,
    historyLimited: state.historyLimited || ordered.length > MAX_OBSERVATIONS,
    timelineSampled: points.length > 480, timeline: sample(points, 480), latest, stale,
    headroomPercent: stale || latest.usedPercent === null ? null : 100 - latest.usedPercent,
    timeToLimitMinutes, observedMinutes, above90Minutes,
    shareAbove90: observedMinutes >= MIN_OBSERVED_MINUTES && points.filter((p) => p.usedPercent !== null && Date.parse(p.timestamp) <= now).length >= MIN_REQUESTS ? above90Minutes / observedMinutes : null };
}

/** Collects only allowlisted metadata during the existing streaming transcript pass. */
export class LimitsCollector {
  private profiles = new Map<string, ProfileState>();
  private roots: Array<{ root: string; profile: ProfileState }> = [];
  private config: ProfileConfig[] = [];
  readonly warnings: string[] = [];

  static async create(options: { claude: string[]; codex: string[]; home: string; dataDirectory?: string; includeDesktop?: boolean }): Promise<LimitsCollector> {
    const result = new LimitsCollector();
    result.config = await readLimitsConfig(options.dataDirectory ?? defaultDataDirectory(), result.warnings);
    for (const provider of ["claude", "codex"] as const) {
      for (const root of options[provider]) {
        const profileRoot = ["projects", "sessions", "archived_sessions"].includes(basename(root)) ? dirname(root) : root;
        let canonical = resolve(profileRoot);
        try { canonical = await realpath(profileRoot); } catch { /* Missing evidence is normal. */ }
        const profile = result.profile(provider, `directory:${canonical}`);
        result.roots.push({ root: resolve(root), profile });
        if (provider === "claude" && basename(root) === "projects") {
          const defaultProfile = resolve(profileRoot) === resolve(options.home, ".claude");
          const file = defaultProfile ? join(options.home, ".claude.json") : join(profileRoot, ".claude.json");
          const json = record(await optionalJson(file, result.warnings, "Optional Claude usage cache"));
          result.cachedUsage(profile, json?.["cachedUsageUtilization"]);
        }
      }
    }
    if (options.includeDesktop) {
      const json = record(await optionalJson(join(options.home, "Library/Application Support/Claude/plan-usage-history.json"), result.warnings, "Optional Claude Desktop usage history"));
      if (Array.isArray(json?.["samples"])) {
        for (const raw of json["samples"]) {
          const point = record(raw), at = timestamp(point?.["t"]), usage = record(point?.["u"]);
          if (!at || !usage || typeof point?.["org"] !== "string" || point["org"].length > 256) continue;
          const profile = result.profile("claude", `desktop:${point["org"]}`, "desktop-account");
          for (const [name, minutes, field] of [["five-hour", 300, "fh"], ["seven-day", 10080, "sd"]] as const) {
            const used = percent(usage[field]);
            if (used !== null) result.add(profile, name, name, minutes, { timestamp: at, usedPercent: used, resetsAt: null, status: null, source: "claude-desktop", usingOverage: null });
          }
        }
      }
    }
    return result;
  }

  private profile(provider: LimitProvider, identity: string, scope: LimitProfile["scope"] = "profile"): ProfileState {
    const profileKey = `profile-${key(`${provider}:${identity}`)}`;
    const existing = this.profiles.get(profileKey);
    if (existing) return existing;
    const ordinal = [...this.profiles.values()].filter((p) => p.provider === provider).length + 1;
    const config = this.config.find((p) => p.provider === provider && (p.profileKey ? p.profileKey === profileKey : p.profile === ordinal));
    const profile: ProfileState = { key: profileKey, provider, ordinal,
      label: config?.label ?? `${provider === "claude" ? "Claude" : "Codex"}${scope === "desktop-account" ? " Desktop" : ""} profile ${ordinal}`,
      scope, config, planType: null, planObservedAt: null, credits: null, windows: new Map(), hits: new Map(), hitSessions: new Set() };
    this.profiles.set(profileKey, profile);
    return profile;
  }

  profileKey(path: string): string | null { return this.forPath(path)?.key ?? null; }

  private forPath(path: string): ProfileState | undefined {
    const full = resolve(path);
    return this.roots.filter(({ root }) => full === root || full.startsWith(`${root}${sep}`)).sort((a, b) => b.root.length - a.root.length)[0]?.profile;
  }

  private add(profile: ProfileState, windowKey: string, label: string, minutes: number | null, point: LimitSample): void {
    if (point.usedPercent === null && point.status === null) return;
    let window = profile.windows.get(windowKey);
    if (!window) {
      window = { key: windowKey, label, windowMinutes: minutes, observations: new Map(), duplicatesDiscarded: 0, historyLimited: false };
      profile.windows.set(windowKey, window);
    }
    const previous = window.observations.get(point.timestamp);
    if (previous) {
      window.duplicatesDiscarded++;
      // Deterministic, conservative resolution of conflicting simultaneous snapshots.
      if ((previous.usedPercent ?? -1) > (point.usedPercent ?? -1) ||
        previous.usedPercent === point.usedPercent && JSON.stringify(previous) >= JSON.stringify(point)) return;
    }
    window.observations.set(point.timestamp, point);
    if (window.observations.size > MAX_OBSERVATIONS * 2) {
      window.observations = new Map([...window.observations].sort(([a], [b]) => b.localeCompare(a)).slice(0, MAX_OBSERVATIONS));
      window.historyLimited = true;
    }
  }

  private cachedUsage(profile: ProfileState, raw: unknown): void {
    const cached = record(raw), at = timestamp(cached?.["fetchedAtMs"]), usage = record(cached?.["utilization"]);
    if (!at || !usage) return;
    for (const [field, minutes] of [["five_hour", 300], ["seven_day", 10080], ["seven_day_opus", 10080], ["seven_day_sonnet", 10080]] as const) {
      const window = record(usage[field]), used = percent(window?.["utilization"]);
      if (used !== null) this.add(profile, field.replaceAll("_", "-"), field.replaceAll("_", "-"), minutes, {
        timestamp: at, usedPercent: used, resetsAt: timestamp(window?.["resets_at"]), status: null, source: "claude-cache", usingOverage: null });
    }
  }

  observe(path: string, raw: Record<string, unknown>, sessionIdentity: string): void {
    const profile = this.forPath(path), at = timestamp(raw["timestamp"]);
    if (!profile || !at) return;
    const payload = record(raw["payload"]);
    if (profile.provider === "codex" && raw["type"] === "event_msg" && payload?.["type"] === "token_count") {
      const limits = record(payload["rate_limits"]);
      if (limits) {
        const plan = oneOf(limits["plan_type"], ["free", "go", "plus", "pro", "team", "business", "enterprise", "edu", "unknown"] as const);
        if (plan && (!profile.planObservedAt || at >= profile.planObservedAt)) { profile.planType = plan; profile.planObservedAt = at; }
        const credits = record(limits["credits"]);
        if (credits && (!profile.credits || at >= profile.credits.observedAt)) {
          const rawBalance = credits["balance"];
          const balance = typeof rawBalance === "string" && /^\d{1,12}(\.\d{1,8})?$/.test(rawBalance) ? Number(rawBalance) : nonnegative(rawBalance);
          profile.credits = { observedAt: at, hasCredits: boolean(credits["has_credits"]), unlimited: boolean(credits["unlimited"]), balance };
        }
        const limitId = typeof limits["limit_id"] === "string" ? limits["limit_id"].slice(0, 512) : "codex";
        const label = limitId === "codex" ? "Codex" : "Additional limit";
        for (const name of ["primary", "secondary"] as const) {
          const window = record(limits[name]);
          const minutes = nonnegative(window?.["window_minutes"]);
          const used = percent(window?.["used_percent"]);
          if (used === null) continue;
          const duration = minutes !== null && minutes > 0 && minutes <= 525600 ? minutes : null;
          this.add(profile, `limit-${key(limitId)}:${name}:${duration ?? "unknown"}`, `${label} ${name}`, duration,
            { timestamp: at, usedPercent: used, resetsAt: timestamp(window?.["resets_at"]), status: null, source: "codex-transcript", usingOverage: null });
        }
      }
    }
    if (profile.provider === "claude") {
      const quota = record(raw["quotaLimits"]);
      const type = oneOf(quota?.["rateLimitType"], ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const);
      const status = oneOf(quota?.["status"], ["allowed", "allowed_warning", "rejected"] as const);
      if (type && quota) this.add(profile, type.replaceAll("_", "-"), type.replaceAll("_", "-"), type === "five_hour" ? 300 : 10080,
        { timestamp: at, usedPercent: null, resetsAt: timestamp(quota["resetsAt"]), status, source: "claude-quota", usingOverage: boolean(quota["isUsingOverage"]) });
      if (status === "rejected") this.hit(profile, at, "quota-rejected");
    }
    const error = record(payload?.["error"]);
    const rawErrorIdentity = profile.provider === "claude" ? record(raw["message"])?.["id"] ?? raw["uuid"] : payload?.["turn_id"];
    const errorIdentity = typeof rawErrorIdentity === "string" && rawErrorIdentity.length <= 512 ? rawErrorIdentity : undefined;
    if (profile.provider === "claude" && (raw["apiErrorStatus"] === 429 || record(raw["error"])?.["status"] === 429)) this.hit(profile, at, "http-429", sessionIdentity, errorIdentity);
    if (profile.provider === "codex" && raw["type"] === "event_msg" && error?.["codex_error_info"] === "usage_limit_exceeded") this.hit(profile, at, "usage-limit-exceeded", sessionIdentity, errorIdentity);
  }

  private hit(profile: ProfileState, at: string, kind: LimitHitKind, sessionIdentity?: string, errorIdentity?: string): void {
    const identity = errorIdentity && sessionIdentity ? key(`${sessionIdentity}:${kind}:${errorIdentity}`) : `${at}:${kind}`;
    const previous = profile.hits.get(identity);
    if (!previous || at < previous.timestamp) profile.hits.set(identity, { timestamp: at, kind });
    if (sessionIdentity) profile.hitSessions.add(key(sessionIdentity));
  }

  finalize(sessions: SessionAnalytics[], generatedAt: string, selectedRepository: boolean): LimitsCacheAnalytics {
    const now = Date.parse(generatedAt);
    const usedProfiles = new Set(sessions.map((s) => s.limitsCache?.profileKey));
    const profiles = [...this.profiles.values()].filter((p) => usedProfiles.has(p.key) || p.windows.size || p.hits.size);
    const subscriptions: SubscriptionMonth[] = [];
    for (const profile of profiles) {
      const months = new Map<string, { value: number; priced: number; tokens: number; days: Set<string> }>();
      for (const session of sessions) {
        if (session.limitsCache?.profileKey !== profile.key || session.costBasis !== "api-list-price-equivalent") continue;
        for (const bucket of session.limitsCache.buckets) {
          if (!bucket.day) continue;
          const month = bucket.day.slice(0, 7), value = months.get(month) ?? { value: 0, priced: 0, tokens: 0, days: new Set<string>() };
          value.tokens += bucket.observedTokens;
          value.priced += bucket.pricedTokens;
          value.value += bucket.apiEquivalentUsd;
          value.days.add(bucket.day);
          months.set(month, value);
        }
      }
      for (const [month, value] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
        const price = profile.config?.monthlyPriceUsd ?? null;
        const coverage = value.tokens > 0 ? value.priced / value.tokens : null;
        subscriptions.push({ profileKey: profile.key, month, apiEquivalentUsd: value.value, monthlyPriceUsd: price,
          leverage: price !== null && price > 0 && coverage === 1 && value.days.size >= 3 ? value.value / price : null,
          observedTokens: value.tokens, pricedTokens: value.priced, pricingCoverage: coverage, activeDays: value.days.size,
          partialMonth: month === generatedAt.slice(0, 7), scope: selectedRepository ? "selected-repository" : "all-repositories" });
      }
    }
    return {
      profiles: profiles.map((p) => ({ key: p.key, provider: p.provider, ordinal: p.ordinal, label: p.label, scope: p.scope,
        planType: p.planType, planObservedAt: p.planObservedAt, credits: p.credits,
        windows: [...p.windows.values()].sort((a,b) => a.key.localeCompare(b.key)).map((w) => summarizeLimitWindow(w, [...w.observations.values()], now)),
        limitHits: sample([...p.hits.values()].sort((a,b) => a.timestamp.localeCompare(b.timestamp)), 480),
        limitHitCount: p.hits.size, sessionsWithLimitErrors: p.hitSessions.size })),
      subscriptions, warnings: [...new Set(this.warnings)],
      policy: { freshnessMinutes: FRESHNESS_MINUTES, maximumObservationGapMinutes: FRESHNESS_MINUTES,
        minimumObservedMinutes: MIN_OBSERVED_MINUTES, minimumRequests: MIN_REQUESTS, minimumInputTokens: MIN_INPUT_TOKENS,
        contextTableReviewedAt: CONTEXT_TABLE_REVIEWED_AT },
    };
  }
}
