import { analyzeMachineSessionsIsolated } from "../analysis-process.ts";
import { analyzeOptionsFrom, argument } from "../options.ts";
import { brand } from "../brand.ts";
import { version } from "../version.ts";
import { loadInsightContext } from "./config.ts";
import { parseCommandArguments } from "./arguments.ts";
import { formatInsights, insightsForSnapshot, selectInsightRule } from "./service.ts";

try {
  const argv = process.argv.slice(2);
  const parsed = parseCommandArguments(argv, ["--from", "--through", "--rule"], ["--json", "--all-scopes"]);
  if (parsed.has("--help")) {
    process.stdout.write(`${brand.name} ${version}
Usage: ${brand.command} insights [--json] [analysis options]

Ranked content-free rules with affected scopes, evidence and interpretation limits.
  --json                   Print schemaVersion 2: groups, ranked items, thresholds and coverage
  --insights-config PATH   JSON thresholds, disabledRules, nextTierModels, comparisonModels and inventory
  --rule RULE              Show one rule after computing its evidence and peer baselines
  --all-scopes             Print every ranked scope with full evidence (default: top 3 per rule)
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
    const report = selectInsightRule(insightsForSnapshot(snapshot, context, { from: argument(argv, "--from"), through: argument(argv, "--through") }), argument(argv, "--rule"));
    process.stdout.write(parsed.has("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatInsights(report, parsed.has("--all-scopes")));
  }
} catch {
  process.stderr.write("Insights could not be generated. Check command options, configuration and local evidence; use --help.\n");
  process.exitCode = 2;
}
