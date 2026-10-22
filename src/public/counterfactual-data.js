import { calendarDays, ledgerCells } from "./velocity-data.js";

const rateAvailable = (rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0;

/**
 * Hypothetical ordinary API list-price equivalent, never observed value or an invoice.
 * The hourly ledger has no request context sizes or cache-write TTLs: do not invent either.
 * Coverage includes all dated observed input + output, including provider-reported tokens.
 */
export function counterfactualValue(sessions, rate, { start, end }) {
  const days = new Set(calendarDays(start, end));
  let tokens = 0, repricedTokens = 0, value = 0, undatedTokens = 0, unledgeredSessions = 0;
  const excluded = { providerReported: 0, inputSplit: 0, cacheWrite: 0, missingRate: 0 };
  const price = (count, tariff) => {
    if (rateAvailable(tariff)) { repricedTokens += count; value += count * tariff / 1_000_000; }
    else excluded.missingRate += count;
  };
  for (const session of sessions) {
    if (!session.velocity) { unledgeredSessions += 1; continue; }
    for (const [, values] of session.velocity.undated ?? []) undatedTokens += values[1] + values[5];
    for (const [day, , , values] of ledgerCells(session.velocity)) {
      if (!days.has(day)) continue;
      const input = values[1], output = values[5];
      tokens += input + output;
      if (session.costBasis === "provider-reported") { excluded.providerReported += input + output; continue; }
      price(output, rate?.outputPerMillion); // reasoning is already included in output
      // Cache-read evidence covers the whole physical input denominator. Numeric
      // placeholders without that evidence cannot establish an uncached/read split.
      if (values[12] !== input || values[2] + values[3] + values[4] !== input) {
        excluded.inputSplit += input;
        continue;
      }
      price(values[2], rate?.inputPerMillion);
      price(values[3], rate?.cachedInputPerMillion ?? rate?.cacheReadPerMillion);
      excluded.cacheWrite += values[4];
    }
  }
  return { valueUsd: repricedTokens ? value : null, tokens, repricedTokens, unrepricedTokens: tokens - repricedTokens,
    coverage: tokens ? repricedTokens / tokens : null, excluded, undatedTokens, unledgeredSessions };
}
