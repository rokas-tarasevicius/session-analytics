# Pricing evidence and reproducibility

Dollar figures are **API-equivalent usage value, not an invoice**. This system prices the token classes visible in local history. It does not infer a subscription bill, credits, negotiated discounts, priority/flex/batch service, regional modifiers, or hosted-tool charges. Cursor's locally reported value remains separate and is not repriced.

## Commands

```bash
session-analytics rates update
session-analytics rates show
session-analytics rates show anthropic/claude-opus-5.5 --json
session-analytics rates diff --json
session-analytics rates status --offline --json
session-analytics report --offline --json > snapshot.json
```

- `update` downloads the enabled lists and appends validated snapshots. It returns a per-source result and changes from the previous snapshot. Partial success retains the successful update and every older snapshot. Failed/partial updates exit `1`; offline or reviewed-only updates are explicit no-ops and exit `0`.
- `show [model]` reads the current merged rates, in USD per million tokens, with provenance. An unknown or ambiguous model returns an empty list and exits `1`. Valid bounded provider IDs are kept in output; aliases only affect rate lookup. Rejected model values become `<unknown>` in usage/status without losing their eligible tokens.
- `diff` compares the last two snapshots of **each source**, independently of the reviewed override policy. It reports full before/after normalized rates, additions, removals, and large-change flags. A source needs two observations to have a diff.
- `status` reads the cache and scans local session evidence in the existing isolated worker. It reports source freshness and current rate coverage of distinct observed Claude/Codex model IDs. Repository and source-root filters are the same as `report`. It excludes Cursor provider-reported values. It does not download prices, and can take as long as a report.

All four commands accept `--json`. They never print cache paths, raw errors, credentials, transcripts, repository names or identifiers. Model IDs and price-source metadata are allowlisted. Report JSON stays clean: stale-pricing hints go to stderr. Analysis failures in either report mode produce one fixed stderr message, no stdout and a nonzero exit status.

## Public sources

| Source | Endpoint | Normalization |
| --- | --- | --- |
| models.dev | [Public model catalog](https://models.dev/api.json) | Only `anthropic.models` and `openai.models`, with text output and numeric `cost.input`/`cost.output`. Prices are already USD/million. Reads `cache_read`, `cache_write`, optional `cache_write_1h`, explicit context `tiers`, and legacy `context_over_200k` only when explicit tiers are absent. |
| LiteLLM | [Versioned source file on GitHub](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) ([raw feed](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json)) | Only direct `anthropic`/`openai` providers and chat/response text inference. Per-token prices are multiplied by one million. Separate 5-minute and one-hour cache creation fields, cache reads, and `*_above_<N>k_tokens` fields become absolute context tiers. |

The upstream [models.dev schema](https://github.com/anomalyco/models.dev/blob/dev/README.md) and [LiteLLM pricing fields](https://docs.litellm.ai/docs/proxy/custom_pricing) describe these inputs. A model's context-window **limit is not a price-tier boundary**. Explicit models.dev context tiers take precedence over the legacy `context_over_200k` field, which can coexist with a 272K tier.

Unknown fields, descriptions, environment/key names, feed-supplied links and non-price metadata are discarded. Deployment, cloud-reseller, image-only, audio-only, batch and priority price rows are excluded. OpenRouter is deliberately not enabled: its resale prices are a different basis from the direct API-equivalent value shown here.

## Merge policy

Default `reviewed-first`:

1. Entries named in `data/rate-cards.json`'s `reviewedOverrides` list.
2. Matching cached APIs, in `models.dev,litellm` order.
3. Remaining entries in the bundled reviewed card as `fallback`.
4. No match: visibly unpriced; never an invented zero.

The reviewed exceptions pin **complete model rates**. This keeps cache ratios and long-context premiums internally consistent when a feed changes its base rate. The list includes Opus 5.5's 0.05× cache-read exception, Fable 5.1's 0.025× exception, and the reviewed OpenAI entries with 2× input/cache and 1.5× output above 272K. Codex Spark has no verified bundled API tariff and remains unpriced even if a public feed reports zero rates; an explicit custom card can supply a tariff.

`--pricing-policy api-first` explicitly gives APIs precedence over those exceptions. `--pricing-policy reviewed-only` uses only the current bundled card. `--rate-card PATH` pins that entire reviewed card and bypasses API history and automatic refresh, preserving the existing custom-card behavior. A custom card without `reviewedOverrides` is fully reviewed.

`--pricing-sources litellm,models.dev` reverses API priority; either source can be selected alone. Unknown or duplicate sources are rejected. Endpoint URLs are fixed and cannot be set through flags, environment variables, feeds or cache contents.

Alias lookup prefers an exact ID, then an unambiguous lab-prefix/numeric-punctuation equivalent, then a dated/undated equivalent. `openai/` and `anthropic/` prefixes, dotted versus dashed numeric versions, and trailing `YYYYMMDD` or `YYYY-MM-DD` dates are recognized. It never maps arbitrary reseller prefixes or strips model variants such as `mini`. If several dated variants match and no unambiguous undated entry exists, the model stays unpriced.

## History selection

For each request, select each source's newest snapshot whose `fetchedAt` is **not later than the request timestamp**, then apply the merge policy. Among API sources, evidence at or before the request takes precedence over a higher-priority source first observed later. This prevents adding a new preferred feed from rewriting a request already covered by older API evidence.

If the selected source observation predates a model’s first listing, use that model’s first later observation as `temporal: oldest`; this does not replace an existing historical price or resurrect a model removed after its first listing. Evidence at or before the request from another enabled source still takes precedence over this later fallback. If no API observation is early enough, use the oldest observation under the configured source order. Provenance labels this `temporal: oldest`. Missing or invalid request timestamps use the latest available rates with `temporal: undated`. Reviewed cards use their effective date; their earlier archived versions remain available under the default policy. Snapshots in the future are not used as fetched API evidence.

Every priced `ModelUsage` has a `pricing[]` list, because a session or aggregate can span more than one source/snapshot. Each item includes source, kind (`api`, `reviewed`, `fallback`), timestamp, payload SHA-256, matched rate ID, alias/exact match, temporal selection and enumerated assumptions. Wholly unpriced and provider-reported models have an empty list. `pricingCoverage` retains explicit token-class rates in the numerator and all eligible observed tokens in the denominator. Substituted cache rates contribute labeled cost estimates but no priced-token coverage. Usage assumptions describe only the rules actually applied to that request. The public `rateCard.models` list describes **current** rates; use model usage provenance for the historical rates actually applied.

A fetch timestamp is an observation date, not a provider's historical effective date. Before the first observation, historical costs are estimates; updating a previously empty cache or changing policy can change them. Retaining the same cache, reviewed card, parser version and configuration makes a report reproducible. This is not a reconstruction of prices before data collection began. Removing snapshots loses that evidence.

## Cache and refresh

The cache lives in `pricing/` beneath:

- macOS: `~/Library/Application Support/session-analytics/`;
- Linux: `$XDG_DATA_HOME/session-analytics/`, or `~/.local/share/session-analytics/` (relative XDG paths are ignored);
- `--data-dir PATH` or `SESSION_ANALYTICS_DATA_DIR`, when set.

Each immutable API observation contains a schema version, source, fetched time, fixed source URL, SHA-256 of the fetched bytes, and a content-addressed reference to normalized rates. Identical normalized rate tables share one `rates-<sha256>.json` blob even when raw feed bytes or observation times differ. The loader validates and shares each table once in memory. Legacy inline snapshots remain readable and are deduplicated in memory; they are not deleted or rewritten. Reviewed cards are archived on updates too. An envelope checksum covers the observation or reviewed snapshot; a separate content hash covers each shared rate table. Missing or damaged blobs invalidate only dependent observations. The original raw feed body is not retained; its hash identifies the input but is not an upstream signature. This is corruption detection, not protection against another process running as the user. Snapshots publish atomically, so interruption or concurrent updates cannot expose a partial file or overwrite an existing observation. New directories/files are created with modes `0700`/`0600`.

There is no retention pruning: every observation timestamp and payload hash survives deduplication. History is partitioned once by source with numeric timestamps. Requests use binary search, with constant-time oldest/latest boundaries, and shared alias indexes cache both matches and misses. Loading metadata still grows with the number of observations, and distinct changed rate tables require memory. Reproduce the 2/104/730-observation benchmark with `node --expose-gc --max-old-space-size=256 scripts/benchmark-pricing-history.ts`. Analysis only reads this cache and never writes or fetches. The dashboard serves its first scan immediately from local evidence, then checks for stale prices in the background at startup and every six hours. Concurrent checks share one update. **Refresh snapshot** (`/api/analytics?refresh=1`) first updates any enabled source that is absent, stale, or whose newest fetch is older than 24 hours, bounded by the existing 15-second timeout per source; a failed update still scans with cached/reviewed evidence. Background checks never rescan or mutate displayed totals. A content-free `/api/health` pricing hint records whether changed normalized rates await a scan and the newest successful fetch time. The browser polls that hint every minute while visible and shows **Pricing evidence needs a refresh / Refresh snapshot** in Pricing when new rates are available, including when the displayed source metadata was fresh. A scan only acknowledges updates available before it began, so a concurrent background update keeps its hint.

After a scan observes distinct model IDs with positive eligible tokens and no matching rate, the server also checks for newly listed models if any enabled source’s newest fetch is absent or older than 24 hours. This uses the same update flight and is limited to one triggered attempt per 24 hours per server, including failures. Model IDs are never sent upstream: requests still fetch whole fixed lists. The next manual refresh can use the new cache. Offline mode, reviewed-only policy, `--rate-card` and `--snapshot` disable all automatic public checks and manual public updates. Failures retain cached rates and print one fixed stderr line: `Background pricing update unavailable; cached rates remain in use.` The startup `Background pricing update: …` status line remains. Reports and `show`, `diff`, `status` never trigger a public request.

Legacy inline snapshots sometimes mark a derived one-hour cache price globally without identifying its context tier. The loader conservatively retains that assumption on their one-hour tier prices; it does not change the numeric prices or original observation hashes. New snapshots identify assumptions on the relevant tier.

A source is stale when it is absent or its age exceeds `--pricing-max-age-days` (default `7`, configurable `0`–`3650`). Any stale enabled source makes the catalog stale, so a successful source cannot hide another source's failure. `--offline` or `SESSION_ANALYTICS_OFFLINE=1` disables public requests everywhere, including explicit `rates update`. Cached API prices continue to work offline. All pricing flags have corresponding `SESSION_ANALYTICS_` variables (`DATA_DIR`, `PRICING_POLICY`, `PRICING_SOURCES`, `PRICING_MAX_AGE_DAYS`); CLI values win, and offline environment mode cannot be overridden by another option.

## Validation and fidelity

- Plain fixed-URL GETs, no credentials, cookies, bodies, local values, redirects or dynamic model queries. A timeout is 15 seconds per source; the decoded response limit is 32 MiB. A public service can see the client's IP and request time. Localhost dashboard HTTP is unaffected by offline mode.
- Finite numeric prices between $0 and $10,000 per million tokens; no string coercion. Provider values must be the strings `claude` or `codex`; arrays, objects and null are rejected. Nonpositive/invalid boundaries, duplicate tiers and unsupported tier types are rejected. A feed with no valid rates, excessive invalid entries, or loss of more than half its prior model coverage fails without replacing prior evidence.
- A price change greater than 50%, loss of a previously priced field/model, or a changed tier structure is flagged. Valid large changes are kept and made reviewable with `rates diff`; they are not silently clamped to the previous price. Absolute context rates preserve independently specified cache premiums rather than assuming they always match input multipliers.
- models.dev typically exposes 5-minute but not one-hour Anthropic cache writes. When a 5-minute price is available, missing one-hour prices use the reviewed 2× input convention and carry `anthropic-cache-1h-2x`. LiteLLM's explicit one-hour field is used when present. This derived rate is not claimed as an observed feed field.
- Codex retains the existing unobservable cache-write upper estimate (1.25× uncached input) with `codex-cache-write-upper-1.25x` on both API-derived and reviewed rates. Custom multipliers use `cache-write-upper-multiplier`; request provenance includes the rule only when it adds a premium. It is an estimate, not evidence that OpenAI billed a cache write.
- Missing cache-read rates use input as an estimate; missing 5-minute write rates use input with the configured multiplier, and a missing one-hour rate uses that resolved 5-minute rate. Missing context-tier cache prices use their base-context prices. Unsplit writes are estimated with a 5-minute TTL. Every substitution has a bounded assumption code and removes only its affected tokens from coverage; the costs remain in estimated totals. Explicit zero prices remain covered. [Metrics](metrics.md#pricing-metadata-and-coverage) lists each rule. Feeds may disagree or lag.

The demo seeds synthetic pricing snapshots and runs offline in its temporary data directory. Automated tests use canned loopback HTTP fixtures and synthetic transcripts, never real public sources or the user's pricing cache.
