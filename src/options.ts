import type { AnalyzeOptions, PricingPolicy, PricingSource } from "./types.ts";
import { pricingConfiguration } from "./pricing/catalog.ts";

/** Analysis options shared by the dashboard and the report: flag, then `SESSION_ANALYTICS_*` variable. */
const analysisSettings: Array<[keyof AnalyzeOptions, string, string]> = [
  ["dataDir", "--data-dir", "DATA_DIR"],
  ["claudeRoot", "--claude-root", "CLAUDE_ROOT"],
  ["codexArchiveRoot", "--codex-archive-root", "CODEX_ARCHIVE_ROOT"],
  ["codexRoot", "--codex-root", "CODEX_ROOT"],
  ["cursorDatabasePath", "--cursor-database", "CURSOR_DATABASE"],
  ["cursorSdkRoot", "--cursor-sdk-root", "CURSOR_SDK_ROOT"],
  ["cursorTranscriptRoot", "--cursor-transcript-root", "CURSOR_TRANSCRIPT_ROOT"],
  ["copilotRoot", "--copilot-root", "COPILOT_ROOT"],
  ["opencodeDatabasePath", "--opencode-database", "OPENCODE_DATABASE"],
  ["geminiRoot", "--gemini-root", "GEMINI_ROOT"],
  ["databasePath", "--database", "CONDUCTOR_DATABASE"],
  ["rateCardPath", "--rate-card", "RATE_CARD"],
  ["repositoryId", "--repo-id", "REPO_ID"],
  ["repositoryName", "--repo-name", "REPO_NAME"],
  ["repositoryRemote", "--repo-remote", "REPO_REMOTE"],
  ["repositoryRoot", "--repo-root", "REPO_ROOT"],
];

export const analysisValueFlags = [...analysisSettings.map(([, flag]) => flag), "--pricing-policy", "--pricing-sources", "--pricing-max-age-days"];
export const pricingHelp = `  --offline              Disable public pricing requests (cached prices still work)
  --data-dir PATH        Override the per-user analytics data directory
  --pricing-policy MODE  reviewed-first (default), api-first, or reviewed-only
  --pricing-sources LIST Ordered sources: models.dev,litellm (default)
  --pricing-max-age-days DAYS  Refresh threshold, default 7
`;
export const analysisBooleanFlags = ["--no-index", "--no-additional-providers", "--offline"];

export function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** A command-line flag wins over its `SESSION_ANALYTICS_*` environment variable. */
export function setting(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  flag: string,
  variable: string,
): string | undefined {
  return argument(argv, flag) ?? (environment[`SESSION_ANALYTICS_${variable}`] || undefined);
}

export function analyzeOptionsFrom(argv: string[], environment: NodeJS.ProcessEnv): AnalyzeOptions {
  const options: AnalyzeOptions = { includeHidden: !argv.includes("--exclude-hidden") };
  if (argv.includes("--no-additional-providers") || environment["SESSION_ANALYTICS_ADDITIONAL_PROVIDERS"] === "0") options.additionalProviders = false;
  if (argv.includes("--no-index") || environment["SESSION_ANALYTICS_NO_INDEX"] === "1") options.noIndex = true;
  for (const [property, flag, variable] of analysisSettings) {
    const value = setting(argv, environment, flag, variable);
    if (value) options[property] = value as never;
  }
  options.offline = argv.includes("--offline") || environment.SESSION_ANALYTICS_OFFLINE === "1";
  const policy = setting(argv, environment, "--pricing-policy", "PRICING_POLICY");
  const sources = setting(argv, environment, "--pricing-sources", "PRICING_SOURCES");
  const age = setting(argv, environment, "--pricing-max-age-days", "PRICING_MAX_AGE_DAYS");
  if (policy !== undefined) options.pricingPolicy = policy as PricingPolicy;
  if (sources !== undefined) options.pricingSources = sources.split(",") as PricingSource[];
  if (age !== undefined) options.pricingMaxAgeDays = Number(age);
  pricingConfiguration(options);
  return options;
}
