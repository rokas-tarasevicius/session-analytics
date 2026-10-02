import { analyzeMachineSessionsIsolated } from "../analysis-process.ts";
import { analyzeOptionsFrom, argument } from "../options.ts";
import { brand } from "../brand.ts";
import { version } from "../version.ts";
import { loadInsightContext } from "./config.ts";
import { parseCommandArguments } from "./arguments.ts";
import { formatInsights, insightsForSnapshot } from "./service.ts";

try {
  const argv = process.argv.slice(2);
  const parsed = parseCommandArguments(argv, ["--from", "--through"], ["--json"]);
  if (parsed.has("--help")) {
    process.stdout.write(`${brand.name} ${version}
Usage: ${brand.command} insights [--json] [analysis options]

Content-free coaching cards with evidence, denominators and interpretation limits.
  --json                   Print the InsightsReport, including thresholds and rule coverage
  --insights-config PATH   JSON thresholds, disabledRules, comparisonModels and inventory
  --from YYYY-MM-DD        Include sessions starting on or after this UTC day
  --through YYYY-MM-DD     Include sessions starting on or before this UTC day
  --repo-id ID             Select one repository (all shared report source/repository flags work)
  --rate-card PATH         Use a reviewed alternative rate card
  --help, --version        Print help or version

Shared flags: --repo-name, --repo-root, --repo-remote, --claude-root, --codex-root,
--codex-archive-root, --cursor-database, --database, --exclude-hidden.
Settings use SESSION_ANALYTICS_* variables; --insights-config overrides
SESSION_ANALYTICS_INSIGHTS_CONFIG. No content is sent to an agent.
`);
  } else if (parsed.has("--version")) process.stdout.write(`${version}\n`);
  else {
    const options = analyzeOptionsFrom(argv, process.env);
    const context = await loadInsightContext(options);
    const snapshot = await analyzeMachineSessionsIsolated(options);
    const report = insightsForSnapshot(snapshot, context, { from: argument(argv, "--from"), through: argument(argv, "--through") });
    process.stdout.write(parsed.has("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatInsights(report));
  }
} catch {
  process.stderr.write("Insights could not be generated. Check command options, configuration and local evidence; use --help.\n");
  process.exitCode = 2;
}
