# Privacy contract

`session-analytics` reads coding-agent transcripts that already exist on your machine. Those transcripts contain everything you and your agents have written: prompts, responses, reasoning, commands, file paths, diffs, and tool output. This document defines exactly what the tool may return from them, how that boundary is enforced, and what it does not protect against.

The contract applies to every output surface: the dashboard and its `/api/analytics` endpoint, the terminal report, the JSON snapshot (`report --json`), and the agent skill, which only runs those commands.

## The contract

**Returned:** allowlisted counters and identifiers only.

- Token counters by class, cost figures, counts of events, durations, and ISO timestamps.
- Validated model IDs and reasoning-effort labels as the provider recorded them.
- Tool names, and skill identifiers that match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
- A repository display name and a stable repository ID.
- A session key: the first 12 hex characters of a SHA-256 hash of the provider-qualified session ID.
- Pseudonymous profile keys, ordinal or explicitly configured display labels, allowlisted quota/plan state, and user-configured monthly USD plan amounts.
- Fixed-text parser warnings, which may include counts and model IDs.
- The rate card's effective date, model IDs, and public source URLs.

**Never returned:**

- prompts, user messages, assistant messages, or reasoning text;
- tool arguments, tool results, commands, diffs, or patch content;
- file paths, transcript paths, working directories, repository roots, or Git remotes;
- raw session, provider, workspace, or message IDs;
- session titles, branch names, or workspace names;
- credentials, environment variables, or process arguments;
- raw local error messages or stack traces.

## How it is enforced

- **Allowlist projection.** Parsers accumulate counters into an internal session state, and `finalizeSession` in `src/analyzer.ts` builds each public object field by field. Raw provider records are never spread into an output, so a new field in a provider's format cannot reach an output without a code change.
- **Internal-only types.** `SessionDatabaseRow` and `AnalyzeOptions` in `src/types.ts` carry paths, titles, branches, and IDs for correlation. They are used inside the analysis process and are not part of any public type.
- **Bounded derived names.** Skill identifiers must match the pattern above. Tool names come from the provider's structured tool-call records. The one exception is Codex code mode, where a single transported call can run several tools: the parser matches `tools.<name>(` in the call input and accepts only identifier characters (`[A-Za-z][A-Za-z0-9_]*`) as the name.
- **Shared public-model boundary.** `src/public-model.ts` accepts at most 96 ASCII characters matching `^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$`. It rejects the entire value for paths, URLs, whitespace/control characters, arbitrary error sentences or excessive length; it never extracts a model substring from private text. Rejected/missing values become the fixed `<unknown>` label. The boundary covers Claude/Codex requests, Cursor cost keys, legacy model rollups/warnings, rate-card model labels and new cache/context dimensions. Valid unknown IDs remain visible but unpriced without a configured rate. Cursor reported cost survives normalization and merging.
- **Sentinel tests.** Fixtures plant strings such as `secret-command`, `secret-path`, `secret-skill-args`, and `content-is-not-returned` in prompts, tool inputs, Cursor bubbles, Codex items, and streamed Claude content. Tests in `test/analyzer.test.ts`, `test/accounting.test.ts`, and `test/server.test.ts` serialize the full output and fail if any sentinel, transcript path, workspace name, remote, or raw session UUID appears.
- **Generic errors.** The server maps every failure to one of three fixed messages. The analysis worker's standard error is discarded rather than forwarded, so local paths in exceptions cannot reach the dashboard.
- **No exfiltration path.** The tool makes no network requests and has no telemetry. The dashboard is served from `127.0.0.1` with a Content Security Policy that only allows same-origin resources. See [SECURITY.md](../SECURITY.md) for the full threat model.
- **Read-only access.** JSONL transcripts are streamed and SQLite databases are opened with `readOnly: true`. Nothing is written to provider directories.

Content is held in memory only while a line is being parsed. It is not cached, logged, or written anywhere.

## Privacy tiers

Every field belongs to a tier. The tiers also govern planned features (see [roadmap.md](roadmap.md)).

| Tier | Contents | Status |
| --- | --- | --- |
| **P0** | Counts, token counters, costs, timestamps, durations, model IDs, tool and skill names, enumerated labels | Returned today |
| **P1** | Pseudonymous keys and identifying metadata: session keys, repository IDs and display names; later keyed hashes (with a per-machine secret) of paths and arguments, file extensions, command classes, MCP server names, commit SHAs | Returned today (keys and repository metadata only) |
| **P2** | Results of local rules over commands or diffs, where only rule IDs and counts leave the parser | Not implemented; will be opt-in |
| **P3** | Text shown to you or sent to an LLM, such as an opt-in session review | Not implemented; will be opt-in per run, stored separately, and labeled |

P2 and P3 features will always be off by default.

## Field manifest

This manifest lists every field in the public snapshot. It is generated from the types in [`src/types.ts`](../src/types.ts); a change to those types must update this table in the same pull request. Metric semantics are defined in [metrics.md](metrics.md).

### Snapshot root (`MachineAnalytics`)

Returned by `/api/analytics` and `report --json`.

| Field | Meaning | Tier |
| --- | --- | --- |
| `generatedAt` | ISO time the snapshot was computed | P0 |
| `rateCard.currency` | Always `USD` | P0 |
| `rateCard.effectiveDate` | Effective date of the rate card used | P0 |
| `rateCard.models[].model` | Model ID that has a reviewed rate | P0 |
| `rateCard.models[].source` | Public URL of the rate's primary source | P0 |
| `repositories[]` | One rollup per repository; see [Repository rollup](#repository-rollup-repositoryrollup) | P0/P1 |
| `sessions[]` | Every analyzed session; see [Session](#session-sessionanalytics) | P0/P1 |
| `spendByDay[]` | `{ name: "YYYY-MM-DD", value: USD }`, priced usage by UTC day | P0 |
| `spendByModel[]` | Model usage across all sessions; see [Model usage](#model-usage-modelusage) | P0 |
| `summary` | Machine totals; see [Summary](#summary) | P0 |
| `topTools[]` | `{ name, value }`, effective tool calls by tool name, descending | P0 |
| `warnings[]` | Fixed-text coverage notes (unpriced models, missing or unmatched transcripts, unreadable roots) | P0 |
| `limitsCache` | Optional quota/profile and subscription namespace, also present on the single-repository result; see [Limits and cache](#limits-and-cache) | P0/P1 |

### Repository rollup (`RepositoryRollup`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `repository.id` | Stable repository key. For a repository registered in Conductor, `conductor-` followed by 20 hex characters of a SHA-256 hash of Conductor's repository record ID; the raw ID is never returned. Otherwise `discovered-` followed by 20 hex characters of a SHA-256 hash of the canonical root directory | P1 |
| `repository.name` | Display name: Conductor's repository name, or the basename of the Git root. Non-Git directories show `<basename> · <4 hex> (local directory)`; macOS temporary directories show `Ephemeral automation sessions` | P1 |
| `spendByDay[]` | Priced usage by UTC day for this repository | P0 |
| `spendByModel[]` | Model usage for this repository | P0 |
| `summary` | Repository totals; see [Summary](#summary) | P0 |
| `topTools[]` | Effective tool calls by name for this repository | P0 |
| `warnings[]` | Fixed-text coverage notes for this repository | P0 |

### Summary

Repository summaries and the machine summary share these fields.

| Field | Meaning | Tier |
| --- | --- | --- |
| `analyzedSessions` | Sessions whose evidence validated and parsed | P0 |
| `apiEquivalentSpendUsd` | Sum of API list-price-equivalent session values (Claude Code and Codex) | P0 |
| `cacheReadRatio` | Cache-read tokens divided by uncached input plus cache reads plus cache writes; `0` with no input | P0 |
| `compactions` | Sum of session compactions | P0 |
| `estimatedSpendUsd` | Priced usage value: API-equivalent plus provider-reported | P0 |
| `estimatedUpperSpendUsd` | Sum of session upper estimates | P0 |
| `missingTranscripts` | Sessions whose transcript is missing | P0 |
| `outputTokens` | Sum of output tokens | P0 |
| `pricedTokenCoverage` | Token-weighted share of observed tokens with a known rate; `null` when not applicable | P0 |
| `providerReportedSpendUsd` | Sum of provider-reported session values (Cursor) | P0 |
| `sessions` | Session count | P0 |
| `subagentSessions` | Sessions with sub-agent or mixed execution | P0 |
| `subagentSpendUsd` | Value attributed to sub-agent execution | P0 |
| `topLevelSessions` | Sessions with top-level or mixed execution | P0 |
| `topLevelSpendUsd` | Value attributed to top-level execution | P0 |
| `toolCalls` | Sum of effective tool calls | P0 |
| `totalInputTokens` | Sum of processed input tokens, including cache reads and writes | P0 |
| `unpricedSessions` | Sessions with at least one unpriced model | P0 |
| `repositories` | Machine summary only: repositories in scope | P0 |
| `repositoriesWithSessions` | Machine summary only: repositories with at least one session | P0 |
| `workingSnapshots` | Machine summary only: sessions that were still running when scanned | P0 |

### Session (`SessionAnalytics`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `sessionKey` | First 12 hex characters of SHA-256 of `<provider>:<session ID>` (or of the Conductor session ID for Conductor-registered sessions). It is not keyed with a secret, so it is stable across runs; someone who already holds the raw ID can recompute it, but the key does not reveal the ID | P1 |
| `provider` | `claude`, `codex`, or `cursor` | P0 |
| `repositoryId` | Repository key, as in `repository.id` | P1 |
| `repositoryName` | Repository display name, as in `repository.name` | P1 |
| `status` | Session status label: Conductor's status when registered there, Cursor's composer status, otherwise `idle` | P0 |
| `createdAt` | Session start time | P0 |
| `updatedAt` | Conductor's or Cursor's last-updated time when available; otherwise the session start time | P0 |
| `firstEventAt` | Earliest event timestamp in the evidence, or `null` | P0 |
| `lastEventAt` | Latest event timestamp in the evidence, or `null` | P0 |
| `effort` | Reasoning-effort label as recorded, or `null` | P0 |
| `executionKind` | `top-level`, `subagent`, `mixed`, or `unknown` | P0 |
| `costBasis` | `api-list-price-equivalent`, `provider-reported`, or `unavailable` | P0 |
| `costComplete` | `true` when every observed token was priced or no tokens were observed | P0 |
| `pricedTokenCoverage` | Share of this session's tokens with a known rate, or `null` | P0 |
| `cost` | Cost breakdown; see [Cost breakdown](#cost-breakdown-costbreakdown) | P0 |
| `costByExecution.topLevelUsd` | Value attributed to top-level execution | P0 |
| `costByExecution.subagentUsd` | Value attributed to sub-agent execution | P0 |
| `costByExecution.unknownUsd` | Value with no execution evidence | P0 |
| `tokens` | Token counters; see [Token usage](#token-usage-tokenusage) | P0 |
| `models[]` | Per-model usage; see [Model usage](#model-usage-modelusage) | P0 |
| `spendByDay` | `{ "YYYY-MM-DD": USD }` for this session, by UTC day of each priced request | P0 |
| `tools` | `{ toolName: count }`, effective tool calls (code-mode calls expanded to the inner tool) | P0 |
| `transportTools` | `{ toolName: count }`, tool calls as the provider transported them, before expansion | P0 |
| `skills` | `{ skillId: count }`, skill invocations | P0 |
| `skillEvidence` | `explicit` (Claude), `inferred` (Codex lower bound), or `unavailable` (Cursor) | P0 |
| `metrics` | Execution counters; see [Session metrics](#session-metrics-sessionmetrics) | P0 |
| `limitsCache` | Optional request cache/context namespace for Claude and Codex; see [Limits and cache](#limits-and-cache). Absent for unsupported evidence | P0/P1 |
| `transcript.files` | Number of evidence files read for the session (main transcript plus sub-agent files) | P0 |
| `transcript.status` | `ok`, `missing`, `invalid`, or `unsupported` | P0 |
| `transcript.snapshotWhileWorking` | `true` when the session was still running at scan time | P0 |
| `transcript.warnings[]` | Fixed-text parser notes, which may include counts and model IDs | P0 |

### Session metrics (`SessionMetrics`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `userTurns` | Human turns (tool results are not turns) | P0 |
| `assistantMessages` | Distinct assistant messages or agent messages | P0 |
| `modelCalls` | Priced or unpriced model requests with positive usage | P0 |
| `toolCalls` | Effective tool calls | P0 |
| `transportToolCalls` | Tool calls before code-mode expansion | P0 |
| `compactions` | Context compaction boundaries | P0 |
| `summaries` | Summary boundaries (Claude) | P0 |
| `taskStarts` | Task-start markers (Codex) | P0 |
| `taskCompletions` | Task-complete markers (Codex) | P0 |
| `queueOperations` | Queued-input operations (Claude) | P0 |
| `delegatedAgents` | Distinct delegated agents observed (Claude) | P0 |
| `durationMilliseconds` | Session start to last event | P0 |
| `eventSpanMilliseconds` | First event to last event | P0 |
| `maxContextWindow` | Largest observed Codex window or reviewed Claude model capacity | P0 |
| `maxInputTokensPerCall` | Largest input of a single request | P0 |
| `contextUtilizationPeak` | Maximum paired request-input/window ratio over eligible deduplicated requests, or `null`; Claude's reviewed capacities are estimates | P0 |

### Token usage (`TokenUsage`)

Appears as `session.tokens` and inside every model usage entry.

| Field | Meaning | Tier |
| --- | --- | --- |
| `inputTokens` | Processed input: uncached input plus cache reads plus cache writes | P0 |
| `uncachedInputTokens` | Input billed at the base input rate | P0 |
| `cachedInputTokens` | Cache-read input | P0 |
| `cacheWriteInputTokens` | Cache-write input (Claude) | P0 |
| `cacheWrite5mInputTokens` | Cache writes with a 5-minute TTL | P0 |
| `cacheWrite1hInputTokens` | Cache writes with a 1-hour TTL | P0 |
| `outputTokens` | Output, including reasoning | P0 |
| `reasoningOutputTokens` | Reasoning or thinking output, where recorded separately | P0 |
| `nonReasoningOutputTokens` | Output minus reasoning output | P0 |

### Cost breakdown (`CostBreakdown`)

Appears as `session.cost` and inside every model usage entry. All values are USD.

| Field | Meaning | Tier |
| --- | --- | --- |
| `inputUsd` | Uncached input value | P0 |
| `cachedInputUsd` | Cache-read value | P0 |
| `cacheWriteUsd` | Cache-write value | P0 |
| `outputUsd` | Output value | P0 |
| `totalUsd` | Sum of the components (or the provider-reported value for Cursor) | P0 |
| `upperEstimateUsd` | Total plus the cache-write premium on all uncached input where cache writes are not observable | P0 |

### Model usage (`ModelUsage`)

Appears in `session.models[]` and every `spendByModel[]`. Includes every `TokenUsage` and `CostBreakdown` field, plus:

| Field | Meaning | Tier |
| --- | --- | --- |
| `model` | Bounded validated model identifier (`<unknown>` when missing or rejected); same policy for rate-card labels and all model dimensions | P0 |
| `calls` | Requests attributed to this model | P0 |
| `priced` | `true` when the rate card has an entry for this model (always `true` for Cursor provider-reported values) | P0 |

### Limits and cache

Types are explicitly defined in [`src/metrics/limits-cache-types.ts`](../src/metrics/limits-cache-types.ts); formulas and guards are in [limits-cache.md](limits-cache.md). All provider records are projected field by field. Source/config paths, account/organization IDs, request IDs, unknown plan/limit names, diagnostic text, compaction summaries, raw credits metadata and raw config objects never leave the parser. No P2/P3 processing is added.

#### Snapshot `limitsCache`

| Field | Meaning | Tier |
| --- | --- | --- |
| `profiles[]` | Observed provider profiles or separate Desktop accounts | P0/P1 |
| `profiles[].key` | `profile-` plus 20 SHA-256 hex characters of provider-qualified canonical profile identity or Desktop organization; unkeyed, stable and pseudonymous, not anonymous against known-input recomputation | P1 |
| `profiles[].provider` | `claude` or `codex` | P0 |
| `profiles[].ordinal` | One-based discovery ordinal within provider | P0 |
| `profiles[].label` | Ordinal label, or explicitly configured bounded public display label; never inferred from directory names | P1 |
| `profiles[].scope` | `profile` or `desktop-account`; profiles are not assumed to have distinct subscriptions | P0 |
| `profiles[].planType`, `planObservedAt` | Allowlisted Codex plan enum (`free`, `go`, `plus`, `pro`, `team`, `business`, `enterprise`, `edu`, `unknown`) and observation time; nullable, never mapped to a guessed price | P0 |
| `profiles[].credits` | Nullable allowlisted credit observation | P0 |
| `profiles[].credits.observedAt` | Observation timestamp | P0 |
| `profiles[].credits.hasCredits`, `unlimited` | Nullable booleans | P0 |
| `profiles[].credits.balance` | Nullable finite numeric balance in provider units, not a USD conversion | P0 |
| `profiles[].windows[]` | Separate rate-limit windows; never added across accounts/profiles | P0/P1 |
| `profiles[].windows[].key` | Hashed limit identifier plus window kind/duration, or fixed Claude window enum | P1 |
| `profiles[].windows[].label`, `windowMinutes` | Fixed display label and nullable observed window duration | P0 |
| `profiles[].windows[].observations`, `duplicatesDiscarded` | Retained observation count and encountered same-source timestamp collisions | P0 |
| `profiles[].windows[].historyLimited`, `timelineSampled` | Explicit retention/sampling indicators | P0 |
| `profiles[].windows[].timeline[]`, `latest` | Bounded timeline and most recent sample, as defined below | P0 |
| `profiles[].windows[].latestNumeric` | Latest numeric sample using the same sample manifest below, or null; independently dated from latest status evidence | P0 |
| `profiles[].windows[].headroomExpiresAt` | Numeric observation's ISO freshness/reset deadline, or null without numeric evidence | P0 |
| `profiles[].windows[].stale` | Numeric sample (or latest status if no numeric sample exists) expired, future-dated, or past reset | P0 |
| `profiles[].windows[].headroomPercent`, `timeToLimitMinutes` | Nullable headroom and guarded projection from latest compatible numeric observation | P0 |
| `profiles[].windows[].observedMinutes`, `above90Minutes`, `shareAbove90` | Measured exposure denominator, ≥90% duration and nullable guarded share | P0 |
| `profiles[].limitHits[].timestamp`, `kind` | Bounded event details; ISO time and `http-429`, `usage-limit-exceeded`, or `quota-rejected` | P0 |
| `profiles[].limitHitCount`, `sessionsWithLimitErrors` | Exact observed event count and sessions with explicit request-limit errors; no raw session IDs | P0 |
| `subscriptions[].profileKey`, `month` | Profile pseudonym and UTC `YYYY-MM` | P1/P0 |
| `subscriptions[].apiEquivalentUsd`, `monthlyPriceUsd`, `leverage` | Observed dated API value, nullable user-configured full monthly USD price and nullable guarded ratio | P0 |
| `subscriptions[].pricedTokens`, `observedTokens`, `pricingCoverage` | Input-plus-output pricing denominator/numerator and nullable coverage | P0 |
| `subscriptions[].activeDays`, `partialMonth`, `scope` | Observed active days, current-month flag and `all-repositories`/`selected-repository` scope | P0 |
| `warnings[]` | Fixed optional-source/configuration warnings, without paths or raw errors | P0 |
| `policy.freshnessMinutes`, `maximumObservationGapMinutes`, `minimumObservedMinutes`, `minimumRequests`, `minimumInputTokens` | Published freshness, exposure and activity guards | P0 |
| `policy.contextTableReviewedAt` | Review date for Claude fallback model capacities | P0 |

Every `timeline[]` / `latest` / non-null `latestNumeric` sample contains only:

| Field | Meaning | Tier |
| --- | --- | --- |
| `timestamp`, `resetsAt` | Normalized ISO observation time and nullable reset | P0 |
| `usedPercent` | Nullable finite utilization in [0, 100] | P0 |
| `status` | Nullable `allowed`, `allowed_warning`, or `rejected` | P0 |
| `source` | `codex-transcript`, `claude-quota`, `claude-cache`, or `claude-desktop` | P0 |
| `usingOverage` | Nullable recorded boolean | P0 |

#### Session `limitsCache`

| Field | Meaning | Tier |
| --- | --- | --- |
| `profileKey` | Nullable profile pseudonym joining snapshot profiles | P1 |
| `cache` | Totals below, plus guarded `hitRatio` and nullable input `pricingCoverage` | P0 |
| `context` | Context totals below, plus the curve and guarded threshold shares | P0 |
| `buckets[].day`, `model`, `executionKind` | Nullable UTC request day, model ID, and execution enum; repository/profile come from the containing session | P0 |
| `buckets[].observedTokens`, `pricedTokens`, `apiEquivalentUsd` | Input-plus-output totals and ordinary priced request value, for monthly comparisons | P0 |
| `buckets[].cache`, `context` | Exact additive totals below (peak uses maximum) | P0 |
| `cacheBreaks[].timestamp`, `model`, `executionKind` | Nullable time and allowlisted request dimensions | P0 |
| `cacheBreaks[].reportedReason` | Nullable `previous_message_not_found`, `messages_changed`, `tools_changed`, `system_changed`, `model_changed` | P0 |
| `cacheBreaks[].heuristics[]` | `idle-ttl`, `model-switch`, `compaction` flags | P0 |
| `cacheBreaks[].writeTokens`, `writeUsd` | Observed write tokens and nullable priced write value on that request | P0 |
| `cacheBreaksSampled` | Event details sampled; aggregate counts remain exact | P0 |
| `compactions[].timestamp`, `executionKind`, `trigger` | Nullable time, execution enum, and `auto`/`manual`/`unknown` | P0 |
| `compactions[].preTokens`, `postTokens`, `turnsSincePrevious` | Nullable numeric pre/post sizes and observed human-turn interval within that stream | P0 |
| `compactionCount`, `compactionsSampled` | Total supported boundaries and explicit detail-sampling flag | P0 |
| `compactionCountExact` | False when missing timestamps or ambiguous cross-format matches prevent an exact observed-boundary count | P0 |

Cache totals in `cache` and `buckets[].cache`:

| Field | Meaning | Tier |
| --- | --- | --- |
| `requests`, `inputTokens`, `cacheReadTokens`, `cacheWriteTokens` | Deduplicated request/input class counts | P0 |
| `pricedRequests`, `pricedInputTokens` | Requests/input eligible for no-cache comparison with a known rate and known request input | P0 |
| `actualInputUsd`, `noCacheInputUsd`, `netSavingsUsd` | Observed input value, counterfactual value and difference; difference may be negative | P0 |
| `cacheWriteUsd`, `recacheWriteUsd` | Observed write value, and its subset on requests with break flags | P0 |
| `breakRequests`, `pricedBreakRequests`, `reportedBreaks`, `heuristicBreaks` | Unique flagged requests, their priced denominator, and potentially overlapping reported/heuristic counts | P0 |
| `unknownTtlWriteRequests` | Write requests lacking explicit TTL breakdown | P0 |

Context totals in `context` and `buckets[].context`:

| Field | Meaning | Tier |
| --- | --- | --- |
| `requests`, `eligibleRequests` | Deduplicated requests and requests with paired input/window evidence | P0 |
| `reportedWindowRequests`, `reviewedWindowRequests` | Recorded Codex versus reviewed Claude-capacity coverage | P0 |
| `above40`, `above60`, `above80`, `peakFill` | Strict threshold counts and nullable maximum paired fill ratio | P0 |
| `context.shareAbove40`, `shareAbove60`, `shareAbove80` | Session-only nullable shares, with minimum activity guard | P0 |
| `context.curveSampled` | Curve reduced by the 240-point session cap and/or 20,000-point snapshot cap; aggregate counts/peaks remain exact | P0 |
| `context.curve[].request`, `timestamp`, `executionKind`, `inputTokens`, `windowTokens`, `fill` | Request ordinal (not raw ID), nullable time, execution enum, input/window counts and paired ratio | P0 |

Sentinel tests in `test/limits-cache.test.ts` place content in diagnostics, quotas, unknown limit/plan IDs, credits metadata, Desktop organization IDs, compaction summaries and configuration. `test/model-privacy-fixture.ts` also plants paths, URLs, control characters, error text and oversized strings directly in Claude/Codex model metadata and Cursor cost keys. Tests cover serialized analytics, terminal output, the actual isolated-worker HTTP API and executed dashboard renderer, including cache-break/model dimensions.

### Health endpoint

`GET /api/health` returns `{ service: "session-analytics", snapshot: "ready" | "building" | "not-started", status: "ok" }`. All fields are P0.

### Browser storage

The dashboard stores two values in `localStorage`: the selected view (`session-analytics-view`) and the theme (`session-analytics-theme`). Nothing else is persisted.

## What this does not protect against

- **Your own account.** Anyone or anything that can read your home directory can read the raw transcripts directly. This tool does not encrypt, move, or delete provider history.
- **Other local processes.** Any process on your machine can request `http://127.0.0.1:<port>/api/analytics` while the dashboard runs. It receives the same content-free snapshot you see.
- **Identifying metadata.** Repository names, model IDs, and timestamps can be sensitive. A repository named after an unannounced project reveals that name. Review a JSON snapshot or screenshot before sharing it; for public material, use the synthetic demo (`npm run demo`).

## Changing the contract

A pull request that adds or changes a public field must:

1. add the field to the public types in `src/types.ts` and populate it explicitly (no spreading of provider records);
2. add a row to the field manifest above, with its tier;
3. define its semantics in [metrics.md](metrics.md);
4. add or extend a test that plants sentinel content in the relevant provider records and asserts it does not appear in the serialized output.

Fields in P2 or P3 additionally need an explicit opt-in that is off by default.
