import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Synthetic account-wide quota follows a shared clock across all demo repositories. */
export function demoRateLimits(time: number) {
  if (time > Date.now()) return null;
  const primaryDuration = 300 * 60_000, secondaryDuration = 10080 * 60_000;
  return { limit_id: "codex", plan_type: "pro", primary: {
    used_percent: Math.round((time % primaryDuration) / primaryDuration * 98), window_minutes: 300,
    resets_at: Math.floor((Math.floor(time / primaryDuration) + 1) * primaryDuration / 1000),
  }, secondary: {
    used_percent: Math.round((time % secondaryDuration) / secondaryDuration * 82), window_minutes: 10080,
    resets_at: Math.floor((Math.floor(time / secondaryDuration) + 1) * secondaryDuration / 1000),
  }, credits: { has_credits: false, unlimited: false, balance: "0" } };
}

/** Fixtures only: explicit demo plan prices are not defaults or recommendations. */
export function writeLimitsDemo(options: { root: string; claudeRoot: string; codexRoot: string; repository: string; now: number }): void {
  const { root, claudeRoot, codexRoot, repository, now } = options;
  const data = join(root, "analytics-data"); mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({ limitsCache: { profiles: [
    { provider: "claude", profile: 1, label: "Claude demo profile", monthlyPriceUsd: 50 },
    { provider: "codex", profile: 1, label: "Codex demo profile", monthlyPriceUsd: 35 },
  ] } }));
  writeFileSync(join(dirname(claudeRoot), ".claude.json"), JSON.stringify({ cachedUsageUtilization: {
    fetchedAtMs: now, accountUuid: "synthetic-account", utilization: {
      five_hour: { utilization: 64, resets_at: new Date(now + 80 * 60_000).toISOString() },
      seven_day: { utilization: 42, resets_at: new Date(now + 2 * 86400_000).toISOString() },
    },
  } }));
  const id = "aaaa0000-0000-4000-8000-000000000001";
  const records: unknown[] = [{ type: "session_meta", timestamp: new Date(now - 60 * 60_000).toISOString(), payload: { id, cwd: repository, source: "cli" } }];
  for (let index = 0; index <= 12; index++) {
    const time = now - (12 - index) * 5 * 60_000, limits = demoRateLimits(time)!;
    limits.primary.used_percent = 44 + index * 4;
    limits.primary.resets_at = Math.floor((now + 80 * 60_000) / 1000);
    records.push({ type: "event_msg", timestamp: new Date(time).toISOString(), payload: { type: "token_count", info: null, rate_limits: limits } });
  }
  writeFileSync(join(codexRoot, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
