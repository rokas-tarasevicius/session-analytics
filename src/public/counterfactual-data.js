import { calendarDays, ledgerCells } from "./velocity-data.js";
import { providerIds } from "./providers.js";

const rateAvailable = (rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0;

/**
 * Hypothetical ordinary API list-price equivalent, never observed value or an invoice.
 * The hourly ledger has no request context sizes or cache-write TTLs: do not invent either.
 * Coverage includes all dated observed input + output, including provider-reported tokens.
 */
export function counterfactualValue(sessions, rate, { start, end }, sourceModels = []) {
  const days = new Set(calendarDays(start, end));
  const rates = new Map(sourceModels.map(({ model, rate }) => [model, rate]));
  const vendors = new Map();
  let tokens = 0, repricedTokens = 0, value = 0, undatedTokens = 0, unledgeredSessions = 0;
  const excluded = { providerReported: 0, inputSplit: 0, cacheWrite: 0, missingRate: 0 };
  const price = (count, tariff, vendor) => {
    if (rateAvailable(tariff)) {
      const amount = count * tariff / 1_000_000;
      repricedTokens += count; value += amount;
      if (count > 0) {
        const row = vendors.get(vendor) ?? { vendor, tokens: 0, valueUsd: 0,
          crossVendor: vendor && rate?.provider ? vendor !== rate.provider : null };
        row.tokens += count; row.valueUsd += amount; vendors.set(vendor, row);
      }
    }
    else excluded.missingRate += count;
  };
  for (const session of sessions) {
    if (!session.velocity) { unledgeredSessions += 1; continue; }
    for (const [, values] of session.velocity.undated ?? []) undatedTokens += values[1] + values[5];
    // Only structured rate-card evidence establishes a vendor, including a recorded alias.
    const modelVendors = session.velocity.dimensions.map(({ model }) => {
      const provenance = (session.models ?? []).filter((usage) => usage.model === model).flatMap((usage) => usage.pricing ?? [])
        .sort((a, b) => (b.snapshotDate ?? "").localeCompare(a.snapshotDate ?? ""));
      const source = rates.get(model) ?? rates.get(provenance[0]?.rateModel);
      return providerIds.includes(source?.provider) && source.provider !== "unsupported" ? source.provider : null;
    });
    for (const [day, , dimensionId, values] of ledgerCells(session.velocity)) {
      if (!days.has(day)) continue;
      const input = values[1], output = values[5];
      tokens += input + output;
      if (session.costBasis === "provider-reported") { excluded.providerReported += input + output; continue; }
      const vendor = modelVendors[dimensionId] ?? null;
      price(output, rate?.outputPerMillion, vendor); // reasoning is already included in output
      // Cache-read evidence covers the whole physical input denominator. Numeric
      // placeholders without that evidence cannot establish an uncached/read split.
      if (values[12] !== input || values[2] + values[3] + values[4] !== input) {
        excluded.inputSplit += input;
        continue;
      }
      price(values[2], rate?.inputPerMillion, vendor);
      price(values[3], rate?.cachedInputPerMillion ?? rate?.cacheReadPerMillion, vendor);
      excluded.cacheWrite += values[4];
    }
  }
  return { valueUsd: repricedTokens ? value : null, tokens, repricedTokens, unrepricedTokens: tokens - repricedTokens,
    coverage: tokens ? repricedTokens / tokens : null, excluded, undatedTokens, unledgeredSessions,
    vendors: [...vendors.values()].sort((a, b) => Number(a.vendor === null) - Number(b.vendor === null)
      || (a.vendor ?? "").localeCompare(b.vendor ?? "")) };
}
