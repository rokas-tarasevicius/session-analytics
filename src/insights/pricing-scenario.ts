import { calculateCost } from "../analyzer.ts";
import type { SessionAnalytics } from "../types.ts";
import { boundedName } from "./config.ts";
import { completeRequestSizes, targetPriceEligible } from "./eligibility.ts";
import type { Insight, InsightContext } from "./types.ts";

/** Exactly one scenario per repository/provider. Each model's usage moves at most once,
 * so mixed-model sessions cannot appear in overlapping source/target cohorts. */
export function pricingScenario(api: SessionAnalytics[], provider: "claude" | "codex", context: InsightContext) {
  const chosen = context.comparisonModels[provider];
  const mapping = context.nextTierModels[provider] ?? {};
  const eligible: SessionAnalytics[] = [];
  const transitions = new Map<string, { sourceModel: string; targetModel: string }>();
  let before = 0, after = 0, changedTokens = 0;
  for (const session of api) {
    if (!completeRequestSizes(session) && session.models.some((model) => (context.rateCard.models[model.model]?.longContext || context.rateCard.models[model.model]?.contextTiers?.length))) continue;
    let difference = 0, remappedTokens = 0, valid = true;
    const moves: NonNullable<Insight["pricing"]>["transitions"] = [];
    for (const model of session.models) {
      if (model.inputTokens + model.outputTokens === 0) continue;
      const sourceRate = Object.hasOwn(context.rateCard.models, model.model) ? context.rateCard.models[model.model] : undefined;
      if (!boundedName(model.model) || sourceRate?.provider !== provider) { valid = false; break; }
      const target = chosen ?? (Object.hasOwn(mapping, model.model) ? mapping[model.model] : null);
      if (!target || target === model.model) continue; // Unmapped/already-target usage stays as recorded.
      const rate = Object.hasOwn(context.rateCard.models, target) ? context.rateCard.models[target] : undefined;
      if (!boundedName(target) || !rate || rate.provider !== provider || rate.inputPerMillion <= 0 || rate.outputPerMillion <= 0 || !targetPriceEligible(session, rate)) { valid = false; break; }
      difference += model.totalUsd - calculateCost(rate, model, 0).totalUsd;
      remappedTokens += model.inputTokens + model.outputTokens;
      moves.push({ sourceModel: model.model, targetModel: target });
    }
    if (!valid || !moves.length) continue;
    eligible.push(session); before += session.cost.totalUsd; after += session.cost.totalUsd - difference;
    changedTokens += remappedTokens;
    for (const move of moves) transitions.set(JSON.stringify(move), move);
  }
  const pricing: NonNullable<Insight["pricing"]> = {
    strategy: chosen ? "configured-target" : "next-tier-down",
    transitions: [...transitions.values()].sort((a, b) => a.sourceModel.localeCompare(b.sourceModel) || a.targetModel.localeCompare(b.targetModel)),
  };
  return { eligible, before, after, difference: before - after, changedTokens, pricing,
    names: [...new Set(pricing.transitions.map((move) => move.targetModel))].sort(),
    sufficient: eligible.length >= context.thresholds.minRepoSessions && eligible.reduce((sum, s) => sum + s.metrics.modelCalls, 0) >= context.thresholds.minModelCalls,
  };
}
