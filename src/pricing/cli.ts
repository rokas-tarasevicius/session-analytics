import { analyzeMachineSessionsIsolated } from "../analysis-process.ts";
import { brand } from "../brand.ts";
import { analysisBooleanFlags, analysisValueFlags, analyzeOptionsFrom, optionErrorMessage, pricingHelp } from "../options.ts";
import { latestDiff, loadPricingCatalog, pricingCoverage, resolveRate } from "./catalog.ts";
import { updatePricing } from "./update.ts";
import { validModelId } from "./aliases.ts";

/** All rates commands are local reads except the explicit update command. */
export async function runRates(argv: string[], environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.includes("--help") || !argv.length) {
    process.stdout.write(`Usage: ${brand.command} rates update|show [model]|diff|status [options]

  update   Fetch public lists, validate and append immutable snapshots
  show     Show current merged USD/million rates and provenance
  diff     Compare the latest two snapshots of each source
  status   Show age, sources and coverage of models in local session evidence

  --json                 Print structured output
${pricingHelp}  --rate-card PATH       Pin a reviewed card (disables API refresh)
Source and repository filters from report also apply to status.
No command sends local model IDs, usage, paths or other local values to a pricing source.
`);
    return 0;
  }
  const [command, ...args] = argv;
  if (!["update", "show", "diff", "status"].includes(command ?? "")) {
    process.stderr.write("Expected rates update, show, diff, or status.\n"); return 2;
  }
  const valueFlags = new Set(analysisValueFlags);
  const flags = new Set([...analysisBooleanFlags, "--json", "--exclude-hidden", "--include-hidden"]);
  let model: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueFlags.has(arg)) {
      if (!args[index + 1] || args[index + 1]!.startsWith("--")) {
        process.stderr.write("A rates option requires a value.\n"); return 2;
      }
      index += 1;
    } else if (!flags.has(arg)) {
      if (command !== "show" || model || !validModelId(arg)) {
        process.stderr.write("Invalid rates argument.\n"); return 2;
      }
      model = arg;
    }
  }
  let options;
  try { options = analyzeOptionsFrom(args, environment); }
  catch (error) { process.stderr.write(`${optionErrorMessage(error)}\n`); return 2; }
  const json = args.includes("--json");
  try {
    if (command === "update") {
      const result = await updatePricing(options);
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`Pricing update: ${result.status}\n`);
        for (const source of result.sources) process.stdout.write(`${source.source}: ${source.status}; ${source.models} models; ${source.rejectedModels} rejected\n`);
        process.stdout.write(`${result.changes.length} changes; ${result.changes.filter(({ large }) => large).length} large changes (>50%, removed rates or changed boundaries).\n`);
      }
      return result.status === "failed" || result.status === "partial" ? 1 : 0;
    }
    const catalog = await loadPricingCatalog(options);
    if (command === "show") {
      const models = (model ? [model] : Object.keys(catalog.models)).flatMap((id) => {
        const result = resolveRate(catalog, id);
        return result ? [{ model: id, rate: result.rate, provenance: result.provenance }] : [];
      });
      if (json) process.stdout.write(`${JSON.stringify({ currency: "USD", status: catalog.status, models }, null, 2)}\n`);
      else {
        process.stdout.write("API-equivalent rates, USD per million tokens; not an invoice.\n");
        for (const item of models) process.stdout.write(`${item.model}: input ${item.rate.inputPerMillion}, output ${item.rate.outputPerMillion}, cache read ${item.rate.cachedInputPerMillion ?? item.rate.cacheReadPerMillion ?? "unavailable"}; ${item.provenance.source}/${item.provenance.kind} ${item.provenance.snapshotDate}\n`);
        if (!models.length) process.stdout.write("No matching model rate.\n");
      }
      return model && !models.length ? 1 : 0;
    }
    if (command === "diff") {
      const changes = latestDiff(catalog);
      const comparisons = catalog.status.sources.map(({ source }) => {
        const snapshots = catalog.history.filter((snapshot) => snapshot.source === source);
        return { source, before: snapshots.at(-2)?.fetchedAt ?? null, after: snapshots.at(-1)?.fetchedAt ?? null };
      });
      if (json) process.stdout.write(`${JSON.stringify({ comparisons, changes }, null, 2)}\n`);
      else {
        for (const comparison of comparisons) process.stdout.write(`${comparison.source}: ${comparison.before ?? "no previous snapshot"} → ${comparison.after ?? "no snapshot"}\n`);
        for (const change of changes) process.stdout.write(`${change.source} ${change.model}: ${change.change}${change.large ? " (large change)" : ""}\n`);
        if (!changes.length) process.stdout.write("No comparable rate changes. Two snapshots per source are needed.\n");
      }
      return 0;
    }
    const analytics = await analyzeMachineSessionsIsolated(options);
    const coverage = pricingCoverage(catalog, analytics.sessions.filter((session) => session.costBasis === "api-list-price-equivalent")
      .flatMap((session) => session.models.map(({ model }) => model)));
    if (json) process.stdout.write(`${JSON.stringify({ status: catalog.status, coverage }, null, 2)}\n`);
    else {
      process.stdout.write(`Pricing: ${catalog.status.policy}; ${catalog.status.offline ? "offline" : "public updates enabled"}; ${catalog.status.stale ? "stale or missing" : "current"}\n`);
      for (const source of catalog.status.sources) process.stdout.write(`${source.source}: ${source.fetchedAt ?? "not cached"}; ${source.ageDays === null ? "age unavailable" : `${source.ageDays.toFixed(1)} days old`}; ${source.models} models${source.stale ? "; stale" : ""}\n`);
      process.stdout.write(`Local model coverage: ${coverage.modelsPriced}/${coverage.modelsSeen}${coverage.ratio === null ? " (not applicable)" : ` (${(coverage.ratio * 100).toFixed(1)}%)`}; current rates, excluding provider-reported values.\n`);
      for (const source of coverage.bySource) process.stdout.write(`${source.source}: ${source.models} locally seen models priced\n`);
      for (const warning of catalog.status.warnings) process.stdout.write(`Pricing warning: ${warning}\n`);
    }
    return 0;
  } catch {
    process.stderr.write("Pricing could not be loaded, updated, or compared with local evidence.\n");
    return 1;
  }
}
