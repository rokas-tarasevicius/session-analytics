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
  ["timeZone", "--time-zone", "TIME_ZONE"],
];

export const analysisValueFlags = [...analysisSettings.map(([, flag]) => flag), "--pricing-policy", "--pricing-sources", "--pricing-max-age-days"];
export const pricingHelp = `  --offline              Disable public pricing requests (cached prices still work)
  --data-dir PATH        Override the per-user analytics data directory
  --pricing-policy MODE  reviewed-first (default), api-first, or reviewed-only
  --pricing-sources LIST Ordered sources: models.dev,litellm (default)
  --pricing-max-age-days DAYS  Refresh threshold, default 7
`;
export const machineHelp = `  --time-zone ZONE       IANA time zone for activity days and hours (default: TZ, then the system zone)
  --portable-ids         Give repositories with a Git remote the same ID on every machine
`;
export const analysisBooleanFlags = ["--no-index", "--no-additional-providers", "--offline", "--portable-ids"];

/** A rejected option value; the message is fixed and safe to print. */
export class OptionError extends Error {}

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

/** The canonical IANA name, e.g. `Europe/London`. The name also travels to other machines, so only zone characters pass. */
export function canonicalTimeZone(value: string): string {
  const invalid = (): never => { throw new OptionError("--time-zone must be an IANA time zone such as Europe/London or UTC."); };
  if (value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) invalid();
  try { return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone; }
  catch { return invalid(); }
}

export function analyzeOptionsFrom(argv: string[], environment: NodeJS.ProcessEnv): AnalyzeOptions {
  const options: AnalyzeOptions = { includeHidden: !argv.includes("--exclude-hidden") };
  if (argv.includes("--no-additional-providers") || environment["SESSION_ANALYTICS_ADDITIONAL_PROVIDERS"] === "0") options.additionalProviders = false;
  if (argv.includes("--no-index") || environment["SESSION_ANALYTICS_NO_INDEX"] === "1") options.noIndex = true;
  if (argv.includes("--portable-ids") || environment["SESSION_ANALYTICS_PORTABLE_IDS"] === "1") options.portableIds = true;
  for (const [property, flag, variable] of analysisSettings) {
    const value = setting(argv, environment, flag, variable);
    if (value) options[property] = value as never;
  }
  if (options.timeZone) options.timeZone = canonicalTimeZone(options.timeZone);
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

export interface RemoteOptions {
  /** SSH destinations, in the order given. */
  remotes: string[];
  /** Words that start session-analytics on each remote machine. */
  command: string[];
}

export const remoteValueFlags = ["--remote", "--remote-command"];
export const remoteBooleanFlags = ["--no-remote"];
export const remoteHelp = `  --remote HOST[,HOST]   Also read these machines over SSH; session-analytics must be installed there
  --remote-command CMD   How to start it there (default: session-analytics)
  --no-remote            Scan only this machine; ignore remote environment settings
`;

/** Destinations and command words reach ssh and the remote shell, so only plain words pass. */
export function remoteOptionsFrom(argv: string[], environment: NodeJS.ProcessEnv): RemoteOptions {
  if (argv.includes("--no-remote")) {
    if (argv.includes("--remote")) throw new OptionError("--no-remote cannot be combined with --remote.");
    return { remotes: [], command: [] };
  }
  const raw = setting(argv, environment, "--remote", "REMOTE");
  const remotes = raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
  if (remotes.some((remote) => !/^[A-Za-z0-9_][A-Za-z0-9._@%:+/-]{0,254}$/.test(remote))) {
    throw new OptionError("--remote takes SSH destinations such as server or user@server, separated by commas.");
  }
  if (new Set(remotes).size !== remotes.length) throw new OptionError("List each --remote machine once.");
  const command = (setting(argv, environment, "--remote-command", "REMOTE_COMMAND") ?? "session-analytics").trim().split(/\s+/);
  if (command.join(" ").length > 512 || !command.every((word) => /^[A-Za-z0-9_./~@%+=:,-]+$/.test(word))) {
    throw new OptionError("--remote-command takes plain words, such as session-analytics or sudo -n -iu agents session-analytics.");
  }
  return { remotes, command };
}

/** Options that describe only this machine cannot be honoured on another one. */
export function assertRemoteAnalysis(options: AnalyzeOptions, remote: RemoteOptions): void {
  if (!remote.remotes.length) return;
  if (options.repositoryId || options.repositoryName || options.repositoryRemote || options.repositoryRoot) {
    throw new OptionError("Repository filters cannot be combined with --remote; focus a repository in the dashboard instead.");
  }
  if (options.rateCardPath) throw new OptionError("--rate-card prices this machine only and cannot be combined with --remote.");
}

/** Fixed text for a rejected analysis option: the time-zone message, else the pricing one. */
export function optionErrorMessage(error: unknown): string {
  return error instanceof OptionError ? error.message : "Invalid pricing configuration.";
}

/** The worker environment for an analysis: `TZ` carries an explicit time zone. */
export function analysisEnvironment(options: Pick<AnalyzeOptions, "timeZone">): NodeJS.ProcessEnv {
  return options.timeZone ? { ...process.env, TZ: options.timeZone } : process.env;
}
