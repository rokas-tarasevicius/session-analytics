import type { AnalyzeOptions } from "./types.ts";

/** Analysis options shared by the dashboard and the report: flag, then `SESSION_ANALYTICS_*` variable. */
const analysisSettings: Array<[keyof AnalyzeOptions, string, string]> = [
  ["claudeRoot", "--claude-root", "CLAUDE_ROOT"],
  ["codexArchiveRoot", "--codex-archive-root", "CODEX_ARCHIVE_ROOT"],
  ["codexRoot", "--codex-root", "CODEX_ROOT"],
  ["cursorDatabasePath", "--cursor-database", "CURSOR_DATABASE"],
  ["databasePath", "--database", "CONDUCTOR_DATABASE"],
  ["rateCardPath", "--rate-card", "RATE_CARD"],
  ["repositoryId", "--repo-id", "REPO_ID"],
  ["repositoryName", "--repo-name", "REPO_NAME"],
  ["repositoryRemote", "--repo-remote", "REPO_REMOTE"],
  ["repositoryRoot", "--repo-root", "REPO_ROOT"],
];

export const analysisValueFlags = analysisSettings.map(([, flag]) => flag);

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
  for (const [property, flag, variable] of analysisSettings) {
    const value = setting(argv, environment, flag, variable);
    if (value) options[property] = value as never;
  }
  return options;
}
