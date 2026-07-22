import { analyzeMachineSessionsIsolated } from "./analysis-process.ts";
import type { AnalyzeOptions } from "./types.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const valueFlags = new Set([
  "--claude-root",
  "--codex-archive-root",
  "--codex-root",
  "--cursor-database",
  "--database",
  "--rate-card",
  "--repo-id",
  "--repo-name",
  "--repo-remote",
  "--repo-root",
]);
const booleanFlags = new Set(["--exclude-hidden", "--help", "--include-hidden", "--json", "--version"]);
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (!flag?.startsWith("--") || (!valueFlags.has(flag) && !booleanFlags.has(flag))) {
    process.stderr.write(`Unknown session analytics argument: ${flag ?? "<missing>"}\n`);
    process.exit(2);
  }
  if (valueFlags.has(flag)) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      process.stderr.write(`Session analytics argument ${flag} requires a value.\n`);
      process.exit(2);
    }
    index += 1;
  }
}

if (process.argv.includes("--help")) {
  process.stdout.write(`Machine Session Analytics 0.3.1

Usage: node scripts/cli.ts [options]

By default, unions all local Codex, Claude, and Cursor session evidence across the machine. Conductor metadata is optional enrichment and hidden metadata records are included.

Options:
  --json                 Print the content-free snapshot as JSON
  --exclude-hidden       Exclude hidden optional repository/session metadata
  --repo-id ID           Narrow to one stable repository ID
  --repo-name NAME       Narrow to one uniquely named repository
  --repo-root PATH       Narrow by canonical repository root
  --repo-remote URL      Narrow by canonical Git remote
  --database PATH        Override the optional Conductor metadata database
  --codex-root PATH      Override the Codex transcript root
  --codex-archive-root PATH Override the archived Codex transcript root
  --claude-root PATH     Override the Claude transcript root
  --cursor-database PATH Override the Cursor local history database
  --rate-card PATH       Override the reviewed rate card
  --version              Print the skill version
  --help                 Show this help
`);
  process.exit(0);
}
if (process.argv.includes("--version")) {
  process.stdout.write("0.3.1\n");
  process.exit(0);
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" }).format(
    value,
  );
}

function dollars(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

const optionalArguments: Array<[keyof AnalyzeOptions, string]> = [
  ["claudeRoot", "--claude-root"],
  ["codexArchiveRoot", "--codex-archive-root"],
  ["codexRoot", "--codex-root"],
  ["cursorDatabasePath", "--cursor-database"],
  ["databasePath", "--database"],
  ["rateCardPath", "--rate-card"],
  ["repositoryId", "--repo-id"],
  ["repositoryName", "--repo-name"],
  ["repositoryRemote", "--repo-remote"],
  ["repositoryRoot", "--repo-root"],
];
const analyzeOptions: AnalyzeOptions = {
  includeHidden: !process.argv.includes("--exclude-hidden"),
};
for (const [property, flag] of optionalArguments) {
  const value = argument(flag);
  if (value) analyzeOptions[property] = value as never;
}

const analytics = await analyzeMachineSessionsIsolated(analyzeOptions);

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(analytics, null, 2)}\n`);
} else {
  process.stdout.write("Machine session analytics · all locally evidenced repositories\n");
  process.stdout.write(`Generated: ${analytics.generatedAt}\n`);
  process.stdout.write(
    `Repositories: ${analytics.summary.repositoriesWithSessions}/${analytics.summary.repositories} with sessions\n`,
  );
  process.stdout.write(
    `Sessions: ${analytics.summary.analyzedSessions}/${analytics.summary.sessions} analyzed\n`,
  );
  process.stdout.write("\nRepository comparison\n");
  for (const repository of [...analytics.repositories].sort(
    (left, right) => right.summary.estimatedSpendUsd - left.summary.estimatedSpendUsd,
  )) {
    process.stdout.write(
      `${dollars(repository.summary.estimatedSpendUsd).padStart(10)}  ` +
        `${String(repository.summary.sessions).padStart(4)} sessions  ` +
        `${compactNumber(repository.summary.totalInputTokens).padStart(7)} input  ` +
        `${repository.repository.name}\n`,
    );
  }
  process.stdout.write(
    `Priced usage value: ${dollars(analytics.summary.estimatedSpendUsd)} (not an invoice)\n` +
      `  API list-price equivalent: ${dollars(analytics.summary.apiEquivalentSpendUsd)}\n` +
      `  Provider-reported local value: ${dollars(analytics.summary.providerReportedSpendUsd)}\n` +
      `  Sub-agent contribution: ${dollars(analytics.summary.subagentSpendUsd)}\n`,
  );
  process.stdout.write(
    `Tokens: ${compactNumber(analytics.summary.totalInputTokens)} input, ` +
      `${compactNumber(analytics.summary.outputTokens)} output\n`,
  );
  process.stdout.write(
    `Cache reads: ${(analytics.summary.cacheReadRatio * 100).toFixed(1)}%; ` +
      `tools: ${compactNumber(analytics.summary.toolCalls)}; ` +
      `compactions: ${analytics.summary.compactions}\n`,
  );
  process.stdout.write("\nTop sessions by priced usage value\n");
  for (const session of [...analytics.sessions]
    .sort((left, right) => right.cost.totalUsd - left.cost.totalUsd)
    .slice(0, 15)) {
    const model = session.models.map(({ model: name }) => name).join(", ") || "unknown model";
    process.stdout.write(
      `${dollars(session.cost.totalUsd).padStart(10)}  ${session.provider.padEnd(6)}  ` +
        `${model.padEnd(20).slice(0, 20)}  Session ${session.sessionKey}\n`,
    );
  }
  if (analytics.warnings.length > 0) {
    process.stdout.write("\nWarnings\n");
    for (const warning of analytics.warnings) process.stdout.write(`- ${warning}\n`);
  }
}
