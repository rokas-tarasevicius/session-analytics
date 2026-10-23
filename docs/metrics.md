# Session analytics metric and interpretation catalog

This reference defines the privacy boundary, current metrics, and candidate extensions for the local session analytics dashboard. Update it together with parser tests whenever a metric changes meaning.

The [product proposal's metric contracts](proposals/metric-contracts.md) define candidate formulas, denominators, missing-data rules and synthetic worked examples for future work. They do not change the current schema or calculations. The [evidence audit](proposals/evidence-audit.md#e09-correctness-and-semantics-prerequisites) records implementation prerequisites, including session-start cohorts versus event windows, zero-denominator consistency, and request-aligned context fill; these findings remain unfixed by the documentation-only proposal.

## Evidence boundary

The dashboard's `/api/health` is operational metadata, separate from analytics: `service` is `session-analytics`, `status` is `ok`, `dataSource` is `live` or `snapshot`, and `snapshot` is `ready`, `building` or `not-started`. `instanceToken` is a random 32-byte per-launch value encoded as hex; `optionsHash` is a hex SHA-256 digest of normalized analysis options (resolved explicit paths and data directory, boolean defaults and pricing defaults, with stable key order). `version` is the tool version; a launch reuses only a dashboard of the same version. They verify live port reuse without exposing paths, option values or local evidence. When public pricing updates are enabled on a live dashboard, optional `pricing.updateAvailable` is a boolean indicating changed normalized rates not yet acknowledged by a scan; `pricing.fetchedAt` is the newest successful enabled-source fetch time (ISO timestamp or null). They are operational hints, never saved pricing evidence or changes to displayed totals. Offline, reviewed-only, custom-card and saved-snapshot dashboards omit `pricing`. These fields do not change `rates status` or `rates update` output. See the [health privacy contract](privacy.md#health-endpoint).

The analyzer may read provider transcripts locally, but its returned data is restricted to:

- a stable local repository key and display name;
- a one-way hashed local session key, provider, status, and timestamps;
- provider session identity and workspace CWD used internally only for correlation;
- model and reasoning-effort identifiers;
- physical token counters and context-window sizes;
- event-class counts and timestamps;
- tool names and stable call IDs, never arguments or results;
- transcript file count, validation status, and bounded parser warnings;
- costs derived from the versioned rate card.

The CLI JSON, API, dashboard, and MCP tools must not return prompts, messages, reasoning, session titles, branches, workspace metadata, repository roots/remotes, raw Conductor IDs, provider session IDs, tool arguments, tool results, commands, file paths, transcript paths, process arguments, credentials, raw local errors, or arbitrary environment output.

The default scope is the union of supported local Claude, Codex, Cursor, Copilot CLI, OpenCode, Gemini CLI, and supported Antigravity SQLite history. It is evidence-led rather than application-led or a blind filesystem crawl: provider working directories, Cursor workspace/file references, optional Conductor workspace mappings, and canonical Git roots determine repository assignment. Provider discovery must work without Conductor. When its database is available, Conductor adds repository/workspace correlations and registered zero-session repositories but does not define the machine boundary. Repository summaries and a single flattened session collection share stable repository IDs; sessions are not duplicated inside public repository objects.

Every provider profile on the machine is in scope: `~/.claude/projects`, sibling profiles such as `~/.claude-work/projects`, `$CLAUDE_CONFIG_DIR/projects`, `~/.config/claude/projects`, and Claude Desktop local-agent sessions; `~/.codex/{sessions,archived_sessions}`, sibling `~/.codex-*` profiles, and `$CODEX_HOME`. Roots that resolve to the same directory through symbolic links are read once. An explicit root option replaces discovery for that provider, so narrowed and synthetic scans never mix in the machine's own history.

Provider transcript stores are canonical evidence that a session can be analyzed. Conductor SDK results can recover a lower-fidelity session only after canonical discovery and unique legacy matching have failed. Rows without either kind of validated evidence remain excluded. A legacy row without a provider ID is first matched through a unique provider, working-directory, and start-time match. Fallback never supplements an existing canonical identity, so database stubs and copied summaries cannot inflate its totals.

An existing content-free index extends that evidence with previously validated sessions whose sources were removed. These are marked `transcript.sourceDeleted: true`, counted in ordinary totals, and retain their last observed facts, pricing, and parser semantics. The mark describes source availability, not session outcome, recency, or quality. An unreadable source is not proof of deletion: prior facts can be shown with a fixed availability warning. `--no-index` excludes all retained history and performs the present-evidence full scan. Rebuild cannot recover sources already removed.

Repository and machine warnings count source-deleted sessions beside the totals. Dashboard retention counts follow the selected repository/date window; scan-wide deferral and availability warnings remain visible across views. Frozen-pricing qualifications appear beside summary totals and the shared view context. `workingSnapshots` excludes source-deleted and unavailable historical observations. Their stored status and `snapshotWhileWorking` still describe the last source observation, not current activity. The browser derives P0 `retainedSessions` and `historicalWorkingSnapshots` counts locally without adding snapshot fields.

The index does not change current-evidence metric definitions. Parity tests require indexed and full-scan snapshots to match exactly except generation time when sources, rate card, and retention are unchanged. File/group fingerprints invalidate changed Claude composites. Codex counter ownership is recomputed across the evidence union from cached per-file facts; a changed owner invalidates both affected sessions. Retained and pruned owners reserve already-attributed counter states so they do not migrate into surviving receivers' totals. Retained facts cannot be repriced exactly from model aggregates because long-context rates apply per request; a fixed warning states that their prices remain those from their last successful ingest.

An index projection/storage failure cannot become an invalid transcript or a retry with already-claimed counters: the entire ingest rolls back and fresh full-scan accounting runs with a fixed warning. This fallback omits source-deleted retained history and does not change the retention floor on disk.

Warm scans independently reparse a rotating sample of up to four cached native sessions and one cached Codex ledger. Samples compare complete projected session facts and complete ledger observations, with file-version checks to distinguish live changes. Native liveness observations that can age out are reparsed. Sampling is a bounded regression detector, not a proof for every cached row on every launch; the full/cold/warm parity runner and synthetic CI regressions provide broader verification.

`index prune --before DATE` excludes sessions whose last event (falling back to updated/start time) is strictly before UTC midnight of `DATE`. Event extrema compare parsed instants and normalize to UTC; invalid timestamps are ignored. Unknown dates and unverifiable pre-schema-3 dates are kept until sources can be reparsed. It is a session-retention cutoff, not a per-event time filter. A persistent floor prevents old source files from immediately repopulating the index; minimal keyed exclusion checkpoints skip unchanged pruned session parses without retaining their removed usage facts. New activity or changed dependencies re-evaluate exclusion. Retired Codex membership is checked at every request claim, including undated events. Rebuild resets the floor. Removed subagent-only files invalidate a still-present Claude composite, which is recomputed from present sources; the index is not a per-file archive.

### Index operational counters

These P0 diagnostics are emitted by `index status --json`, not mixed into the analytics snapshot:

| Field | Definition and interpretation |
| --- | --- |
| `state`, `schemaVersion` | Readability/compatibility state and current on-disk schema; missing is normal before first ingest. |
| `sessions`, `sourceDeletedSessions` | Stored session rows and their source-deleted subset, across source scopes. Different scopes can contain the same session; these are not machine session totals. |
| `evidenceFiles`, `scopes`, `databaseBytes` | Stored fingerprint rows, scopes containing sessions, and main-database bytes (excluding sidecars/quarantines). |
| `lastScan.completedAt` | Time of the most recently committed ingest; `lastScan` is `null` before one completes. |
| `lastScan.fingerprintedFiles` | Unique Claude/Codex files inspected, including subagents. |
| `lastScan.parsedSessions`, `lastScan.reusedSessions` | Claude/Codex sessions recomputed or reused, including exclusion checkpoints. Cursor always refreshes and is outside this denominator. A changed dependent may be reparsed even if its own file is unchanged. |
| `lastScan.retainedSessions` | Prior facts included after source absence/unavailability. |
| `lastScan.deferredSessions` | Session groups in connected ownership components affected by live changes; their previous facts/exclusions and reservations remain one committed generation. Parse/reuse counters describe work attempted, including these groups. |
| `lastScan.ledgerReads`, `lastScan.ledgerHits`, `lastScan.ledgerAppends` | Codex ledger files read, cached files reused, and the subset of reads resumed after a complete-prefix hash check. Appends still reparse the changed session aggregate. |
| `lastScan.auditedSessions`, `lastScan.auditedLedgers` | Unchanged cached native sessions and Codex ledgers independently reparsed and compared successfully in the rotating sample. Audits are extra verification work; these sessions remain counted as reused. Old scan records report zero. |
| `lastScan.elapsedMilliseconds` | Ingest wall time excluding child startup; benchmark wall times include that startup. These are operational timings, not agent-work productivity measures. |

`scripts/parity.ts` reports full/cold/warm wall times, per-session presence/duplicates, transcript status/file count, every token class, each cost component and model allocation, plus UTC session-start-month/provider totals. Token counters are exact; USD comparisons allow differences strictly below $0.01. Schema failures report only schema-owned field names and counts. A metadata-only audit detects native source/composite or Conductor correlation changes between phases and reports a separate unchanged-evidence comparison, retaining the unfiltered differences. Sources outside that inventory are listed as unverified and excluded from the unchanged-evidence comparison. Any unfiltered mismatch, invalid schema, worker failure or index fallback makes the audit fail; changing evidence must not be claimed as exact parity.

## Current measures

### Spend and usage

- input, uncached input, cache-read input, and observable cache-write input tokens;
- output and, where exposed, reasoning-output tokens;
- non-reasoning output derived only when reasoning output is separately exposed;
- ordinary API-equivalent estimate and cache-write upper estimate;
- priced usage value by session and model, plus activity day only where cost timestamps are evidenced;
- price coverage: the share of observed input plus output tokens with an explicit rate for their token class, or not applicable when no tokens were observed;
- cache-read ratio and cache-write volume;
- largest per-call input (`maxInputTokensPerCall`) and largest context window (`maxContextWindow`), never as a performance score;
- peak context fill (`contextUtilizationPeak`): the maximum paired per-request input/window ratio, not the ratio of two independent maxima. Codex windows are recorded per request; Claude windows are reviewed model capacities. It is `null` when no request pairs a known input size with a window.

Codex input is request-context consumption, not unique transcript text: the same cached context is counted again whenever it is processed by another model call. Codex also broadcasts the same process-wide `total_token_usage` snapshot into multiple session files. Deduplicate exact total/last-usage states across the full evidence union, attribute each state to the observing file whose nearest preceding local response event is closest, break equal scores by timestamp and path, and sum `last_token_usage`; never sum a process-wide cumulative delta once per file. When a state carries no usable `last_token_usage`, only a delta between two snapshots that same evidence file observed is attributable to it: treat the file's opening snapshot, and the first snapshot after the counter moves backwards, as a baseline that is recorded and excluded. Billing an opening snapshot charges a whole process history to one request, which lands the parallel work of many sibling sub-agents on a single session and on the calendar day that session started. This activity-backed ownership prevents an earlier stale receiver from taking a request generated by another repository or model. A new `session_meta` can change a file from sub-agent to top-level execution, so allocate each deduplicated request to the execution segment active at the owning observation. Claude cache creation and reads are separate physical counters. Attribute Claude main-file usage to top-level execution and usage from its `subagents` evidence tree to sub-agent execution before aggregating the composite session. Provider reasoning output remains included in output pricing.

### Execution shape

- user-visible turns;
- assistant/model responses;
- model calls inferred from distinct positive usage increments or response IDs;
- task starts and completions when the provider emits them;
- context compactions and summary boundaries (Codex user turns/assistant messages retain the largest representation count; compactions reconcile individual identities or equal UTC timestamps across representations, preserving distinct boundaries through client upgrades; undated or unmatched evidence is counted rather than guessed away);
- effective tool calls by tool name;
- transport/orchestrator tool calls before code-mode expansion;
- Claude queue operations and delegated-agent identities;
- session wall span and provider-event span;
- live versus terminal status when observable.

Machine views also include repository count, repositories with selected sessions, working-snapshot count, explicit top-level/sub-agent execution value, and per-repository comparison dimensions. Usage-value comparisons must show transcript and pricing coverage beside totals.

Tool names are useful for workload shape. Tool call counts do not prove useful work, failure, or causal responsibility.

The Tools dashboard derives MCP origins from effective names matching `mcp__<server>__<tool>` (case-sensitive, nonempty server and tool components, no whitespace). The first `__` after `mcp__` separates the server from the tool; further separators belong to the tool. Empty server segments and missing/empty tool segments remain in “Other tool names” and are excluded from MCP server rows. Other names remain unclassified; they can include MCP calls recorded without that convention. Group and server call shares divide by all calls in tool-eligible selected sessions. Session reach divides distinct sessions using the group/server by all tool-eligible selected sessions, including observed zero-call sessions. Repository reach divides distinct repositories using it by all distinct repositories with tool-eligible selected sessions. Reach overlaps across rows; server calls sum to the MCP-prefixed group, and the two origin groups sum to the existing tool total. With eligible sessions but no calls, counts are zero and call shares are unavailable; without eligible sessions, the panel is unavailable. These are browser-derived values from existing fields, not new snapshot fields or evidence of server health/configuration.

### Evidence health

- provider evidence validation status;
- provider session ID and workspace CWD validation;
- transcript files in the evidence set;
- stable versus working snapshot;
- cumulative-counter monotonicity;
- malformed records skipped;
- unsupported provider, schema, or model price.

## Useful derived indicators (other areas)

The [trajectory metrics research proposal](proposals/metrics-research.md) defines 20 candidate measures with formulas, concrete source fields, observed local coverage, confounders, privacy tiers, validation plans and UI wording. Its companion [normalized event proposal](proposals/schema-v2.md) specifies joins and missing-data semantics. These are research designs, not additional current metrics or a change to the definitions above. Their thresholds are experimental; activity and sequence flags do not establish outcomes.

### Candidate indicators

These can be added without reading content, provided they are labeled as indicators:

- priced usage value per user turn, task completion, model call, effective tool call, or active hour;
- context churn: cumulative input divided by largest context window or event span;
- compactions per hour and spend between compactions;
- tool diversity and concentration by family;
- delegation fan-out and tool use per delegated actor for Claude;
- model-switch count and spend allocation across model changes;
- concurrency timeline: number of repository sessions with overlapping event spans;
- priced-usage velocity by day or week and rolling change from the preceding period;
- analyzed-session count, price coverage, working-snapshot share, and the eligible denominator for provider-specific measures;
- outlier ranks for priced usage value, duration, tool calls, and compactions.

Ratios with tiny denominators need a minimum-activity guard. Ratios with no denominator are not applicable, never 0% or 100%. A session with one task-complete marker is not necessarily more efficient than a session whose provider does not emit that marker.

## Metrics requiring independent evidence

Do not derive these from transcripts alone:

- successful or failed outcome;
- merged pull requests, closed issues, deployed artifacts, or recovered systems;
- value delivered, human time saved, correctness, or quality;
- root cause, death-spiral diagnosis, or missed stop point;
- cloud, provider-tool, CI, or human labor cost not present in usage receipts;
- billable invoice amounts under a subscription, enterprise agreement, discount, priority tier, region modifier, tax, or provider credit.

These require Git, GitHub, CI, deployment, provider billing, or explicit human evidence. Correlate them through a bounded forensic or product-ledger workflow rather than inferring them from volume.

## Pricing semantics

`rate-cards.json` and the immutable pricing cache are reproducibility inputs. The default policy uses reviewed exceptions, then matching public API snapshots in source order, then bundled fallback rates. When a source observation predates a model’s first listing, its first later observation may price otherwise unmatched historical usage, labeled `temporal: oldest`; already priced requests and subsequent source removals keep their existing selection rules. A model with no unambiguous match remains unpriced. [Pricing evidence](pricing.md) documents all selection rules and caveats.

The Claude Opus 5 entry uses Anthropic's standard global API rates. The analyzer does not apply fast-mode, US-only inference, batch, or partner-platform modifiers because local Claude history does not establish those billing dimensions.

The Claude Fable 5.1 entry prices cache hits at 0.025x base input, the published exception to Anthropic's standard 0.1x cache-read multiplier; its base input, cache-write, and output rates match Claude Fable 5.

The Claude Opus 5.5 entry prices cache hits at 0.05x base input ($0.20 per million tokens), the published exception for that model; its 5-minute and 1-hour cache writes use the standard 1.25x and 2x multipliers. Claude Haiku 5.5 uses explicit absolute rates above 100K input tokens: input/cache read/5-minute write/1-hour write/output are $0.50/$0.05/$0.625/$1.00/$2.50 per million, versus $0.10/$0.01/$0.125/$0.20/$0.50 through 100K. Other bundled Claude entries carry no long-context modifier. The `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-luna` and `gpt-5.6-luna` entries apply OpenAI's published 2x input and cache, 1.5x output modifier above 272K input tokens per request.

Current Cursor builds keep global composer headers in a `composerHeaders` table that maps each composer to its workspace storage ID and marks subagent composers; older builds keep them in `ItemTable`. Both are read. Cursor local composer history exposes modern `bubbleId` token counters and stable `toolFormerData` tool-call IDs. `usageData.costInCents` is a provider-reported local usage value and may be aggregated by session, repository, and model. Bubble token counters are session-level because the local bubble schema does not retain a model identifier that can be joined safely to provider-reported model cost. It is not assigned to a day because the local store does not retain per-call cost timestamps. Relative timing values are not Unix timestamps and must not affect session spans. Cursor composer API rate coverage remains not applicable; the SDK source below has separate semantics.

### Hypothetical model pricing (Costs)

The Costs what-if panel computes a **hypothetical API list-price equivalent**, not a bill, observed usage value,
or savings forecast. It applies another model's currently resolved ordinary rates from the snapshot's existing
`rateCard.models` to the selected activity window and repository scope. For each dated or session-dated ledger cell,
the amount is `(uncached input × input rate + cache reads × cached-input rate + output × output rate) / 1,000,000`.
`cachedInputPerMillion` takes precedence over `cacheReadPerMillion`, including an explicit zero. Reasoning tokens
are already included in output and are never added again. Unknown original models can participate when their token
classes are observed; their original price coverage does not determine hypothetical target-rate coverage.

Input participates only when the ledger's cache-read evidence covers its entire input denominator and its uncached,
cached and cache-write counters reconcile to total input. Cache writes are always excluded: hourly cells do not
retain their TTLs. A missing target class rate excludes that class, without substituting the input rate; an explicit
zero rate is supported. Provider-reported sessions are excluded from the amount. **Not re-priced** counts all dated
observed input plus output minus the re-priced classes, divided by all dated observed input plus output, including
provider-reported tokens. The displayed excluded percentage rounds upward to 0.1%; exact token counts accompany it.
No dated tokens means unavailable coverage; no re-priced tokens means an unavailable amount, never a free estimate.
Undated tokens and sessions without a ledger are disclosed separately for the whole scope and never assigned to the window.

The panel breaks the re-priced amount and token count down by **source vendor**. A ledger dimension's model is
matched to `rateCard.models` (or its recorded pricing provenance's latest `rateModel` alias); the matched rate's
`provider` establishes the vendor. Neither the session's agent/provider nor model-name text establishes a vendor:
for example, Cursor can use a Claude model. A contribution is labelled **Cross-vendor comparison** when its source
rate vendor differs from the comparison rate's `provider`. Only actually re-priced classes enter these amounts
and counts; they sum to the hypothetical total and re-priced denominator. Missing source rate evidence remains
an explicitly unknown-vendor contribution; it is never silently treated as same-vendor. This comparison holds the
recorded tokens constant across vendors and does not establish what another vendor would have billed.

Request context sizes are unavailable in the ledger, so long-context and tier premiums are omitted, rather than
applied to an aggregate as if it were one request. Token counts and cache behavior are held constant; models can
tokenize differently and have different capabilities. Current target rates do not reproduce historical tariffs.
The selection lives only in browser memory. No snapshot field, accounting total, projection, or export changes.
The estimate shares Pricing's freshness wording and state from `rateCard.pricing` and the existing `/api/health`
pricing-update poll. Offline mode discloses that only cached prices are used; stale or newly cached prices carry
the same refresh notice as Pricing. The hypothetical calculation stays available without presenting those rates as fresh.

## Additional provider evidence

New sources populate the optional `evidence` namespace. `source` identifies the store; `fidelity` distinguishes message, summary, and activity-only evidence. `tokens` is reported/unavailable; `tools` and `turns` are observed/unavailable. `timing` distinguishes provider timestamps from file modification times. `usageUnit` describes request/run/session granularity, or unavailable. Original native-provider outputs keep their previous shape. Availability labels apply to existing numeric fields: an unavailable numeric placeholder is not an observation of zero activity. The terminal and dashboard share metric-specific eligibility: invalid/missing transcripts are ineligible; tools, compactions, tokens, requests, durations, and costs have separate coverage. Totals with no eligible sessions display N/A; partial totals carry eligible/selected counts. Only eligible values enter rankings. Successful parsing does not imply complete metric coverage. `evidence.accounting` is an optional complete/partial label for retained accounting, independent of parser success.

- **Conductor results:** `conductor.resultRecords` counts distinct receipts, not runs. All eligible rows are grouped by provider identity before accounting. Cumulative `total_cost_usd`/`modelUsage` snapshots replace earlier progress. Explicit reset identities remain separate. Verified Claude Code 2.1 versions before 2.1.277 with distinct SDK `init` UUIDs establish disjoint process epochs; their final snapshots can be added. Newer resumes restore totals and remain one cumulative interval. Without sufficient boundary/version evidence, retain one observed snapshot and mark `evidence.accounting: partial`; counter decreases alone never establish disjoint usage. Zeroed crash receipts cannot erase earlier snapshots. See the [SDK accounting scopes](https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode).
- **Conductor counter scopes:** `conductor.turnLocalTokens` sums deduplicated turn-local `usage` into the existing nine-field `TokenUsage` shape (null when no usage counters are recorded), separately from session/model cumulative totals. It is never added to `modelUsage`. A lone receipt can supply session tokens when model counters are absent; multiple turn-local receipts do not substitute for cumulative session usage. `reportedTurns`, `durationMilliseconds`, `apiDurationMilliseconds`, and `permissionDenials` retain a lone receipt's values; with multiple receipts their scopes are not established, so they are null. `errorResults` and `terminalReasons` count receipts regardless of snapshot selection. Missing counters remain null. These flags are not task-success verdicts. Top-level reported USD takes precedence over model allocations; neither is an invoice. No per-request daily attribution or model-request counts are inferred; the receipt value is [session-dated](#session-dated-value).
- **Cursor SDK:** latest retained snapshot per run ID; input, cache reads, cache writes, and output are disjoint counters. Reasoning is included in output. One started run is one observed run turn, not an inferred number of human messages or model requests. Tool calls are deduplicated by run plus call ID. Exact rate-card model matches are priced, with unknown models unpriced. Run aggregates cannot establish request context sizes: ordinary rates form the lower estimate, and the upper estimate applies any configured long-context premium to all aggregate usage. A run's value is dated by the run's own time (`startedAt`, else `endedAt`, else the run's `createdAt`) in `spendByDay` (UTC) and the velocity ledger; a run without any of these is [session-dated](#session-dated-value). No run value is assigned to `maxInputTokensPerCall`. When cache-write TTL is absent, the ordinary estimate uses the default write rate and the upper estimate also allows the configured one-hour rate; both assumptions are labeled.
- **Cursor transcripts:** human-message turns and structured assistant tool-use blocks only; tool IDs deduplicate streamed copies. `createdAt`/`updatedAt` are explicitly labeled file mtime, `firstEventAt`/`lastEventAt` remain null, and duration is unavailable. The session-start heatmap and duration distributions exclude these sessions. Date filters use their labeled file date. Models, tokens, cost, skills, and compactions are unavailable.
- **Copilot CLI:** persisted user/assistant messages, tool starts, turn lifecycle, and successful compaction markers, deduplicated by event and call/message IDs. Per-call usage is transient and shutdown token semantics are not calibrated here, so tokens and value remain unavailable. Request multipliers, premium requests, and AI credits are never USD. Skill evidence is unavailable.
- **OpenCode:** retained step-finish token counters are per request; the assistant snapshot contains the last step and is used only when no step counters survive for that message. Input/cache classes are disjoint, output includes reasoning. Tools deduplicate by call ID; `parent_id` supplies subagent evidence. Provider-calculated `cost` is not added to API estimates. Models use exact rate-card matches, including namespaced IDs. Pre-session messages in forks are matched to compact original-evidence fingerprints and excluded from the fork. Unmatched or undated request ownership is marked partial and excluded from additive tokens/cost; new post-fork requests remain independent. Daily values use owned request evidence only.
- **Gemini:** saved message counters are deduplicated by message ID, with JSONL checkpoints, rewinds, removals, and reorder operations applied to a content-free projection. Input includes cached input; output is candidate output plus separately recorded thought tokens. Tool-call IDs are deduplicated. Removed history cannot be recovered. Exact known rates are used; the bundled card currently has no Gemini rates, so those observed tokens remain visibly unpriced.

- **Antigravity:** schema-v1 SQLite generation metadata supplies disjoint uncached input, cache reads, cache writes, and total output. Thinking is a subset of output, never added again; an absent thinking counter leaves the reasoning split unknown. A nonempty `gen_metadata` ledger takes precedence over mirrored step usage, including when damaged; older stores without that ledger use step metadata. Native response IDs deduplicate requests across retained copies and forks; counters alone never establish identity. Fork usage without response identity is excluded and accounting is partial. Keyed request-owner reservations persist in the private index and its prune ledger, preventing inherited usage from being counted again after parent-source deletion. Actual model names use the dated pricing resolver; numeric model enums remain visibly unpriced. Provider request timestamps date usage, unique step/message or execution joins recover absent generation times, and otherwise value is session-dated. Structured tool-call IDs deduplicate execution-step copies within a session. Human and assistant step counts describe retained history, including inherited fork history; execution kind and compactions remain unavailable.

New activity-only sessions have `costBasis: unavailable`, `costComplete: false`, and `pricedTokenCoverage: null`. They do not become sessions “with an unpriced model.” Conductor API coverage is likewise N/A; `costComplete` requires supported, non-conflicting accounting boundaries and reported cost for every selected snapshot. It never proves complete historical retention. Numeric summary fields remain backward compatible. Evidence counts describe observations, never work quality, success, or value delivered.

`gpt-5.3-codex-spark` has no verified bundled API tariff and remains visibly unpriced, including when a public feed reports zero rates. A subscription preview does not establish a zero-dollar API-equivalent charge; an explicit custom rate card can supply a tariff.

For OpenAI Codex transcripts, cached input is observable but cache writes are not separately identified in the cumulative usage counter. The ordinary estimate prices uncached input at the base rate. The upper estimate applies the configured cache-write premium to every uncached input token. The API-equivalent value should fall between those values when no other pricing modifier applies; neither value proves a subscription invoice or cash charge.

For Claude transcripts, deduplicate assistant `message.id` values before summing usage. Claude Code writes one record per streamed content block; every record of a message repeats the same input and cache counters while `output_tokens` grows, so keep the final snapshot (the one with the most output) for each message. Pricing the first snapshot undercounts output and thinking tokens. `usage.output_tokens_details.thinking_tokens` is reported as reasoning output and remains included in output pricing; record-level `effort` is the session's reasoning effort. Use the cache-creation TTL breakdown when present. If only aggregate cache creation exists, label the assumed TTL rather than silently claiming an exact cache-write price.

Apply long-context modifiers per request, not to the repository aggregate. Separately priced hosted tools, containers, search calls, storage, and network services require their own observable counters before they can enter the estimate.


### Pricing metadata and coverage

`rateCard.effectiveDate` remains the reviewed card's effective date. `rateCard.models[].provenance` describes the current resolved rate and `rateCard.models[].rate` is its numeric projection in USD per million tokens (`provider`, `inputPerMillion`, `outputPerMillion`, and when published `cachedInputPerMillion`, `cacheReadPerMillion`, `cacheWrite5mPerMillion`, `cacheWrite1hPerMillion`, `cacheWriteMultiplier`, `cacheWriteObservable`, `longContext`, `contextTiers` without assumptions); assumptions stay on the provenance and the URL on `source`; `ModelUsage.pricing[]` is the distinct set of rate evidence actually used across requests, retained when sessions roll up into repositories and machine totals. It can contain several snapshots per model. Empty means no request has API rate evidence (wholly unpriced or provider-reported), not zero cost. `ModelUsage.pricingCoverage` carries the priced-token numerator and eligible-token denominator for API usage. This preserves partial coverage across requests and token classes. Missing cache rates can still contribute labeled estimates to cost totals, but their tokens remain only in `eligibleTokens`; `priced` and session `costComplete` stay false until every observed token class has an explicit rate. Explicit zero prices count as covered. A modeled upper estimate does not reduce ordinary input coverage because the observed uncached tokens still have a base rate. Provider-reported models omit this object.

A provenance item has `source` (`models.dev`, `litellm`, `reviewed`), `kind` (`api`, reviewed override/pin `reviewed`, bundled `fallback`), `snapshotDate` (UTC observation/effective timestamp), `payloadSha256` (full input-byte hash), `rateModel` (matching rate-card ID), `match` (`exact` or `alias`), `temporal` (`at-or-before`, `oldest` if the request predates the chosen evidence, `undated` if request time is unavailable), and `assumptions` (enumerated derived cache-rate rules). These values describe evidence, not billing fidelity.

`rateCard.pricing` reports offline mode, policy, refresh threshold in days, enabled sources, newest API observation (`newestSnapshotAt`), its age in days (`ageDays`), overall staleness, retained API snapshot count, and bounded warnings. Missing observations have null timestamps/ages/hashes and zero available-model counts. Each source also reports its own age, staleness, accepted model count and rejected-model count; an absent/stale source makes the overall catalog stale. `reviewed-only` bypasses API history and is never stale for automatic refresh purposes. Warnings are fixed codes: `cache-unavailable`, `invalid-snapshot`, `large-price-change`, `rejected-models`.

`rates status` coverage counts distinct locally observed Claude/Codex model IDs (aliases remain distinct observed IDs). `modelsPriced / modelsSeen` uses the current merged card, with `ratio: null` when none are seen; `bySource[].models` partitions priced IDs by the selected source, and `unpricedModels` names unmatched bounded IDs. Absent or rejected model values collapse to one `<unknown>` bucket without dropping their eligible tokens; paths, URLs, controls and recognizable raw identifiers never become public model labels. This differs from historical token-weighted `pricedTokenCoverage`. Cursor reported values are excluded. The Pricing tab's **Pricing coverage** is the Costs figure: priced over eligible activity-ledger tokens for the selected dates, with its numerator and denominator, rounded down to 0.1%; no eligible tokens is N/A. Its model cards are one per session provider and model (a model used through two providers has two cards), read the same activity ledger for the selected dates, and cover every session whose value is not provider-reported, so they add up to Costs' API-equivalent value; a reconciliation line adds the provider-reported value to reach the window's usage value. A model with neither value nor tokens in the selected dates has no card. Cards are ordered by usage value, then eligible tokens, then calls, then model ID and provider; current rate-card models with no usage in the selection sit behind a "Show N unused models" toggle. A card's details show the current rate, its source and any reviewed override, and the historical rate evidence (`ModelUsage.pricing[]`) its usage actually applied. These are completeness measures, not quality or value measures.

`rates show --json` returns USD/million base, cache and context rates with provenance. `contextTiers[].aboveInputTokens` is a strict per-request input boundary; equality uses the lower tier, and the highest exceeded boundary wins. Its input/output/cache prices are absolute USD/million rates. Existing `longContext` multipliers remain supported for reviewed cards. `assumptions` labels rules actually used by a request. `contextTiers[].assumptions` carries the optional `anthropic-cache-1h-2x` convention for that tier, so an explicit tier rate can replace a derived base rate without retaining a false assumption.

| Assumption code | Meaning | Coverage effect |
| --- | --- | --- |
| `anthropic-cache-1h-2x` | One-hour write derived as 2× input when a 5-minute price exists | Exclude affected one-hour tokens |
| `cache-read-at-input` | Missing cache-read price substituted with input rate | Exclude read tokens |
| `cache-write-5m-at-input`, `cache-write-5m-multiplier` | Missing 5-minute price uses input, optionally with configured multiplier | Exclude affected write tokens |
| `cache-write-1h-at-5m` | Missing one-hour price uses the resolved 5-minute price, including its input/multiplier fallback if needed | Exclude one-hour tokens |
| `cache-write-ttl-5m` | Aggregate writes lack a TTL split and use the 5-minute price | Exclude unsplit writes once, even if their price is also imputed |
| `context-cache-read-at-base`, `context-cache-write-5m-at-base`, `context-cache-write-1h-at-base` | A context tier omits a cache price; use the base-context rate | Exclude the affected class |
| `codex-cache-write-upper-1.25x`, `cache-write-upper-multiplier` | Unobservable-write upper estimate uses 1.25×, or a custom configured multiplier | Base-input coverage unchanged; label only when the premium is nonzero |

Costs retain these estimates, and the Pricing view shows their assumptions beside the source evidence. An assumption is absent when its token class or premium was not used. Temporal fallback is labeled separately: token coverage measures rate-field completeness, not proof of historical prices or invoice fidelity.

`rates diff` emits source comparisons (previous/latest timestamps, null if unavailable) and changed model rates (`before`/`after`, null for additions/removals). `large` flags changes greater than 50%, removed prices and changed tier structure; a first snapshot has no comparable changes. `rates update` returns a fixed result status, per-source result/model/rejection counts and the same changes. Partial/failed updates preserve previously valid cache evidence. Neither command interprets a price change as an invoice change.

## One money ledger

The Velocity tab and Summary share the same deduplicated activity ledger. **Usage value has one
dashboard definition:** the API list-price equivalent of recorded usage, provider-reported values included,
not an invoice, counted **by activity date** in the declared timezone, including
[session-dated value](#session-dated-value), which the Summary, Costs and Velocity notes state separately. Every
money figure for a window sums this ledger (`buildVelocity` over the scope's sessions and the selected dates): the
Summary "Usage value" KPI, its sparkline and delta, the sidebar repository values, the "Usage value by repository"
bars, the fleet table's Usage value and Priced columns (its rows add up to the KPI, and it sorts by that value), the
"Usage-value mix" (one row per model and provider, the remainder past eight rows as one "Other" row, so it adds up
to the KPI), the explicit sub-agent value (ledger cells whose execution kind is sub-agent), Summary's daily chart,
Costs, the Pricing cards, Velocity's "Usage value" card and the dashboard's daily CSV export. They agree to the cent
for the same window, repository focus and providers (Velocity's provider chips state "N of M providers" when some are
off; Summary's KPI always uses all, its daily-chart chips filter only that chart and the export). A session started
before the window counts the value it used inside the window, and a session still running after the window's end
counts only the value up to it.
Undated value (including Cursor's provider-reported value) and sessions from older snapshots written before their source had a ledger
are disclosed beside the KPI and on Costs as **all-time** amounts for the scope, never added to a dated window;
stale sessions that need a refresh are counted there too and mark the KPI partial. A repository whose sessions have
no ledger at all shows an unavailable value (—), not $0. The Summary delta
uses the same guarded comparison as Velocity's cards (observed prior window, at least 90% pricing
evidence, minimum baseline). The window's latest selectable date is capped at the snapshot's local
date, so a session start "tomorrow" in UTC cannot add an empty future day.

Counts are not money: session, token, tool and compaction KPIs, the fleet table's other columns, Tools and Activity
cover the sessions **started** in the window. Start dates use the same declared timezone as the ledger, so every view
states one calendar; unknown starts and file-modification fallbacks are excluded from a bounded window and kept by
"All observed time". The terminal report keeps its whole-session totals. Dashboard JSON, sessions, models and tools
exports are whole sessions started in the window; only the daily CSV is ledger-dated (see
[interchange](#interchange-metrics-schema-version-1)).

## Quiet repositories

Summary derives this insight locally from existing public fields; snapshots and accounting totals are unchanged.
For each repository in the selected machine/repository scope, take the union of known session-start days in the
snapshot timezone and occupied `velocity.buckets` / `velocity.sessionDated` days. A zero-value or wholly unpriced
cell still establishes activity. A repository is quiet when at least one such day precedes the window's start
and none falls within its inclusive start/end dates. Its last observed active day is the maximum day strictly
before the start. Dates after the window's end do not affect historical results; repositories first observed
after the window or without earlier dated evidence are omitted. Results sort by last day descending, name,
then opaque repository key, using the dashboard's existing disambiguated display names.

Undated cells, unknown starts and file-mtime fallbacks cannot establish an active day. Sessions without a ledger
can contribute a known start only. The panel explicitly qualifies this as observed dated activity and discloses
that undated activity is excluded and local history may be incomplete. All history has no preceding window,
so the panel is hidden; it is also hidden when there are no matches or another view is open. Empty windows retain
the insight even while Summary's charts are hidden. No ratio, prior-period comparison, quality or outcome claim is calculated.

## Costs

Costs reads the same activity ledger as the Summary KPI and Velocity, over the same selected dates, repository
focus and timezone (see [one money ledger](#one-money-ledger)). **Usage value** is the window total; it splits into
**API-equivalent value** (every session whose value is not provider-reported) and **Provider-reported value**
(Cursor database and Conductor result sessions), and a reconciliation line under the cards states
`usage value = API-equivalent + provider-reported` with the dates, the timezone, the session-dated part and the
all-time amounts no window can hold (undated value, older-snapshot sessions without a ledger). Provider rows run
from the highest value down and end with a total line equal to the usage value. Model rows are one per provider and
model; **No model evidence** is ledger value whose cells carry no model (`<unknown>`). Each panel shares one
zero-based scale across its rows. Model row tooltips give the API-equivalent/provider-reported split and the
ledger's token classes for the window. **Pricing coverage** is priced over eligible ledger tokens for the window,
rounded down to 0.1% so it reads 100.0% only when every eligible token has a rate; the Pricing view shows the same
figure.

The **upper estimate** (cache-write assumption) is recorded per whole session. For the window it is the API
ledger value with each cell scaled by its own session's upper/ordinary ratio: a session whose dated value lies inside
the window keeps its exact upper estimate, and a session straddling a window boundary contributes in proportion to its
dated value. It is shown in the API-equivalent card's note, not as a separate total.

## Velocity (snapshot version 1)

`MachineAnalytics.velocity` (also present on the single-repository result) declares
`version: 1` and the analysis process's IANA `timeZone`. Each session optionally carries
`agentIdentity` and `velocity`. Old snapshots without these additions remain readable;
the velocity view asks for a refresh instead of reconstructing activity from session totals.

Velocity opens with **Average per active day** and **Usage value**, both from dated usage value for the selected
window and provider chips, independent of the chart's Metric selector. Average per active day divides dated
usage value by the number of calendar days with value greater than zero; it is unavailable when no
days are active. Its note also shows active days out of all calendar days and value per calendar day.
The chart header shows the selected metric's period total.

### Calendar and attribution

Activity's rhythm KPIs use the same known session starts as its weekday-hour heatmap, after the selected date window, repository and provider filters. Unknown, invalid and file-mtime starts are excluded. **Active days** count distinct calendar start dates in the snapshot timezone. **Longest start-day streak** is the longest consecutive run of those dates inside the window; gaps break a run, multiple starts on one date count once, and daylight-saving changes do not break adjacent calendar dates. It is not a live/current streak or a duration. **Busiest hour** aggregates starts per local clock hour across weekdays; **Busiest weekday** aggregates starts per weekday across hours. Repeated daylight-saving clock hours share a bucket, as in the heatmap. Ties are retained; the display chooses the earliest hour or Monday-first weekday and labels the tie count. No known starts means unavailable insights, never a zero-day streak or a zero-count winner. These browser-derived aggregates add no snapshot fields and change no accounting totals.

- A velocity cell is one **local calendar date × local clock hour × dimension**. Dimensions
  combine agent, model, execution kind and effort. Provider and repository come from the
  containing session, so the payload does not duplicate their identifying metadata.
- Absolute provider timestamps are converted in the analysis process's local timezone,
  honoring `--time-zone` or `TZ`. The browser uses the declared timezone for dates and global session-start
  filtering even when its own timezone differs. Existing `spendByDay` fields retain their
  UTC semantics for compatibility; new charts use `velocity`, not those legacy fields.
- Missing, invalid or timezone-free timestamps go to `undated`. No cost or activity is
  moved to the session creation time, file modification time or last update, except
  [session-dated value](#session-dated-value) from the sources listed there, which is labeled. Undated totals
  are labeled as **all-time for the selected repository/provider scope**: a date window
  cannot assign them honestly. Dated plus undated counters reconcile with session totals.
  Global session-start filtering normalizes offset-free database timestamps as UTC.
  Missing starts and file-mtime fallbacks are excluded from bounded start-date scopes
  and counted as unknown starts; all-time totals retain them.
- Every source now writes a ledger; the dating evidence differs by source (see
  [Session-dated value](#session-dated-value)). A session from `opencode-db`, `gemini-chat`,
  `copilot-events`, `cursor-sdk`, `cursor-transcript`, `antigravity-db` or `conductor-result` without `velocity`
  comes from an older snapshot: it is disclosed with its whole-session value as **older snapshots
  without activity dates** and excluded from dated totals until the next refresh. Any other session
  without `velocity` (a snapshot written before the ledger existed) counts as missing and asks for a refresh.
- Claude prices the final streamed usage once at the first positive-usage snapshot's
  timestamp in the owning execution kind. A usage-free parent placeholder cannot assign a
  subagent's usage to the parent's date. Tools use their first deduplicated call timestamp.
  Codex uses the owning token observation after the existing broadcast-counter dedupe;
  source, model and effort are captured at that observation, not taken from the session's
  final state. Code-mode tool expansion uses the same effective-call counts as the ledger.
- Cursor's provider-reported cost has no per-call timestamp and stays undated. Bubble
  tokens and tools are dated only when `clientStartTime` is an absolute Unix timestamp;
  relative timings stay undated. Their model is `<unknown>` because joining those tokens
  to a composer-level model cost would invent evidence. Cursor's legacy uncached-input
  allocation is retained for reconciliation, with **zero cache-split coverage**.
- Sessions started counts each public session once, including each independent Codex or
  Cursor subagent session. Claude subagent files belong to the composite parent session
  and do not add starts. Start dimensions use the first observed Claude assistant or
  Codex turn context; where absent, model and effort are unknown. These labels describe
  the initial observed context, not necessarily a request made at the creation timestamp.
- Days include inactive dates. Weeks start Monday; months follow the local calendar.
  Boundary weeks/months contain only dates selected in the global window. Hour profiles
  sum the selected dates into 24 clock hours: the repeated autumn DST hour combines both
  occurrences, and the missing spring hour contributes no activity. Cumulative lines
  restart at the selected start date and are disabled for unordered hour profiles.
- The rolling overlay is the total over the last seven calendar dates divided by seven,
  including zero-activity dates. It needs seven dates within observed history whose
  combined metric evidence meets the same **90%** floor as the week and month comparisons
  (below 100%, the readout marks that average partially priced/observed); dates before the
  selected range are included, so the first plotted day can have an average. It is available
  on daily lines/areas; it is disabled for cumulative, weekly, monthly and hour views so
  incompatible units are never overlaid.

### Session-dated value

Each source's cells use the finest time it records:

| Source | Time evidence | Ledger dating |
| --- | --- | --- |
| Claude, Codex, Conductor messages | Per request | Request-dated |
| OpenCode (`opencode-db`) | Per step-finish part `time_created`, else the message's `time.created`; tool parts use their own `time_created` | Request-dated |
| Antigravity (`antigravity-db`) | Generation start time, else a unique message/execution match to a step | Request-dated; unmatched usage is session-dated |
| Gemini CLI (`gemini-chat`) | Per retained message `timestamp` | Request-dated; a message without one is session-dated |
| Copilot CLI (`copilot-events`) | Per persisted event `timestamp` | Tool calls event-dated; no usage or value is recorded |
| Cursor SDK (`cursor-sdk`) | Per run `startedAt`/`endedAt`/`createdAt`; per tool event `createdAt` | Run-dated (a run is one turn); a run without a time is session-dated |
| Conductor results (`conductor-result`) | One cumulative receipt total per retained session | Session-dated at the selected receipt's time |
| Cursor transcripts (`cursor-transcript`) | None (file mtime is not activity evidence) | Undated; no value is recorded |
| Cursor database | Bubble `clientStartTime`; provider-reported cost has none | Tokens/tools bubble-dated; reported value undated |

**Session-dated value** is value whose own request or run time the source does not record. It is
placed in `velocity.sessionDated` on the session's **last evidenced activity time**: the selected
cumulative receipt's database time for Conductor results, otherwise the latest observed event time,
falling back to the recorded session update time. If none is a valid absolute time it stays undated.
A single point was chosen over spreading the value evenly from start to end because it conserves the
total without inventing a daily distribution: a cumulative receipt only proves the value had accrued
by that time, and an even spread would put value on idle days of a session resumed days later. The
cost is that a session spanning several days shows all of its session-dated value on its last day.

Session-dated cells count in every dated total (Summary, sidebar, repository bars, the fleet table, model
mix, Summary's daily chart, Costs, Pricing, the daily CSV export, Velocity and its comparisons), so those
views still agree. The Summary note, the Costs reconciliation line and Velocity's coverage line state how
much of the window's value is session-dated and from how many sessions.
`spendByDay` (UTC) excludes session-dated value; it records only value with its own request or run
time. Hour-of-day profiles place session-dated value at the hour of the session's last activity.

### Agent evidence

Claude `entrypoint` maps `cli` → `cli`, `sdk-ts` → `sdk` (SDK/orchestrated), and
`local-agent` → `desktop`. Other values become `unknown`. Subagent-file
`attributionAgent` maps `general-purpose`, `Explore` and `Plan` to fixed enum values;
custom types become `other`. A composite session reports `mixed` when it observes more
than one subagent type. A subtype does not turn a main-file request into a subagent.

Codex source is `cli`, `exec`, `vscode`, `review`, or `subagent` for a structured
`source.subagent` record; other values become `unknown`. Originators are separately
allowlisted: `codex_cli_rs`, `codex_exec`, `codex_vscode`, and `Codex Desktop` map to
`cli`, `exec`, `vscode`, and `desktop`. The source takes precedence for grouping; a known
originator is the fallback when source is unknown. Session identity describes the first
metadata record; cells retain segment-specific identity. Parent IDs, nicknames and
custom attribution strings never leave the parser. Cursor, Copilot CLI, OpenCode, Gemini CLI and Antigravity have provider-level agent
identities (`cursor`, `copilot`, `opencode`, `gemini`, `antigravity`); Conductor result receipts use `claude-sdk`. Velocity effort is restricted to `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, `ultra`, or `unknown`, independently of the legacy session effort field.

Public model IDs match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; missing or invalid labels
become `<unknown>`. Paths, URLs, whitespace and command punctuation are rejected, including
usage-free start dimensions and tool-only records. Raw model keys remain internal for
pricing lookup; the same validated label is used by model summaries and warnings.

### Compact counters and coverage

`session.velocity.dimensions` is a per-session dictionary. `buckets` entries are
`[day, hour, dimensionIndex, values]`; `undated` entries are `[dimensionIndex, values]`. The optional
`sessionDated` entries have the bucket shape and hold [session-dated value](#session-dated-value);
the field is absent when a session has none.
The fixed `values` tuple has 14 positions:

| Index | Counter | Meaning |
| --- | --- | --- |
| 0 | `valueUsd` | Priced API-equivalent value, or undated Cursor provider-reported value; no price is invented for unknown models |
| 1 | `inputTokens` | All processed input, including cache reads/writes |
| 2 | `uncachedInputTokens` | Existing uncached-input counter; Cursor's unsplit input allocation is identified by missing coverage |
| 3 | `cachedInputTokens` | Cache reads |
| 4 | `cacheWriteInputTokens` | Observable cache writes; Codex/Cursor do not expose these |
| 5 | `outputTokens` | Output including reasoning |
| 6 | `reasoningOutputTokens` | Separately reported reasoning/thinking; missing detail is not evidence of no reasoning |
| 7 | `modelCalls` | Existing deduplicated positive-usage model calls, priced or unpriced |
| 8 | `toolCalls` | Existing effective tool calls, including code-mode expansion |
| 9 | `sessionsStarted` | One per public session, at creation time when absolute |
| 10 | `pricedTokens` | Input plus output assigned to an applicable model price |
| 11 | `reasoningKnownOutputTokens` | Output on requests exposing a separate reasoning breakdown |
| 12 | `cacheReadKnownInputTokens` | Input on requests exposing cache-read counters |
| 13 | `cacheWriteKnownInputTokens` | Input on requests exposing cache-write counters |

Pricing coverage is index 10 / (1 + 5) for eligible cells: every source except the Cursor
database. Conductor receipt value covers its reported tokens when a receipt reports a cost.
Separate-reasoning coverage is 11 / 5 and cache-read coverage is 12 / 1 for the same cells;
cache-write coverage is 13 / 1 for Claude, OpenCode, Cursor SDK and Antigravity. The Cursor database has no
applicable API-price or split-counter denominator, and Codex and Gemini have no cache-write denominator. The UI names these eligible
providers and shows numerators and denominators; a missing denominator is N/A. These are evidence-coverage ratios, not
reasoning shares or cache-hit rates. Missing provider fields remain missing evidence,
even when the underlying legacy counter is zero. Token classes overlap: reasoning is
inside output, and uncached/read/write are inside input. Do not add all selectors together.

Codex exposure is selected alongside the usage actually charged: a positive per-request
`last_token_usage` uses that record's fields. When last usage is absent, empty or has zero
input/output, the cumulative difference uses only breakdowns evidenced at **both**
endpoints. Each field must be a finite, non-negative number; an observed zero is valid.
An unused last-usage object cannot certify a cumulative difference. Reset baselines remain
excluded. This changes coverage, not existing token/value accounting.

Counters aggregate on the server before serialization. There are no public per-request
records, no IDs in cells, and no duplicate daily/hour or six-dimensional marginal payloads.
Velocity groups by Provider by default. Every grouping shows its largest six series by total
plus an exact Other (N) remainder when more than six have values. This cap changes only
presentation, never totals. All chart modes share a two-column text readout, pointer inspection, and
one keyboard focus stop with Left/Right, Home/End navigation.
All 20 supported agent categories have fixed identity slots: eight theme-aware colors, each with
solid/diagonal area fills or solid/dashed lines. Legends reproduce the actual SVG encoding.
Agent colors and patterns do not change when date/provider filters change spend rankings.

### Change, burn and projection guardrails

“Today” is the snapshot date in the declared timezone. Historical windows use their end
date as the comparison anchor. Today is partial and excluded, so comparisons run through the
last completed date. Week comparisons use the Monday-start week containing that date: Monday
through the last completed date versus the same weekdays one week earlier. The card names those weekdays,
“Week to date (Mon–Thu) vs same days last week”, so it cannot be read as the Summary's rolling “last 7 days
vs the previous 7” delta, which compares two whole 7-day windows. Month comparisons use
its month: the first N completed dates versus the first N dates of the previous month; when the
prior month is shorter, **both** sides are clipped to its length. On a Monday, or on the 1st,
the last completed date belongs to the period that just finished, so the cards compare that
whole week/month with the one before and are relabeled “Last week vs week before” / “Last month
vs month before”. A rolled-back month keeps the clipping rule (on April 1, March 1–28 versus
February 1–28) so both sides cover the same number of days. A historical window's end date is
complete and is included; its cards read “Week through <date> (Mon–<weekday>) vs same days prior week” / “Month through <date>
vs prior”, so a past window ending on a Monday or the 1st compares one day with the same day a
week or month earlier. No projection is shown for a month with no remaining days. The calendar indicators (week, month, burn and projection) read the ledger from
two whole months before the anchor month, independent of the selected window's start, so a
“Last 7 days” window still compares this week with last week. Their periods must still lie inside
observed history: dates before the first observed activity are not zero. Notes show both periods'
dates and values. Coverage does not prove the provider retained all historical transcripts.

Calendar coverage and **metric evidence** are separate. Known/eligible counters are retained
per day, period and mover group, including groups with zero measured value. Week and month
comparisons need at least **90%** metric evidence (for value: priced tokens) over the eligible
tokens of **each** period; between 90% and 100% the change is shown on observed values and marked
partially priced/observed, with both sides' counts in the explanation. The rolling average
uses the same floor over each seven-day week. Burn, projections and movers still require 100%
evidence on both sides. Even equally partial coverage is insufficient for those. Known and
eligible counts for current/prior periods are displayed beside percentages; incomplete
evidence returns N/A. Recorded zeroes and inactive dates remain valid observations, but
0/0 evidence coverage is labeled N/A, never 100%. Unsupported providers have no eligible
denominator; a numeric unsupported contribution (Cursor's legacy uncached input) also
blocks inference. Canonical sessions without velocity data (stale snapshots) block comparisons;
sources without activity dates do not. Observed totals remain visible and are labeled partial
when applicable.

Percent changes require a previous value of at least $0.01, 100 tokens, 3 sessions/model
calls, or 5 tool calls. Value/token percentages also require at least 3 prior model calls.
For guarded comparisons, a current/prior ratio strictly above 10× is displayed as a multiple of the prior value (for example, $816.08 versus $5.23 is `▲ 156×`), rounded to at most one decimal, instead of a percentage increase. Exactly 10× still reads `▲ 900.0%`; declines retain percentages. Summary, Tools and Velocity (including Top increases) share this display rule; the underlying delta and baseline guards are unchanged.
A tiny baseline produces N/A with the minimum stated, never an infinite percentage or a
fabricated 0%. An observed prior period with exactly zero value shows **New** when the current
period has activity and **No activity** when both are zero. Unavailable comparisons state their
specific reason (no observed prior history, partly observed period, insufficient evidence,
small baseline, or a stale snapshot).
Top increases rank positive absolute increases separately for repository, model and agent over the
last seven completed days versus the preceding seven. Percent guards use each group's
own prior calls; an observed zero baseline shows New, while a nonzero baseline below the minimum shows a small-baseline dash.
Groups with incomplete evidence in either period are excluded from mover rankings; their
count is displayed. Ranked rows show compact evidence for previous → current (for example, `13.8M priced (100%) → 9.3M priced (100%)`); each cell's tooltip and accessible name retain the exact known/eligible counts and any unsupported-breakdown note. This prevents a
return of pricing or token telemetry from being described as a workload increase.

Burn is today's partial value divided by the median of the previous 14 full calendar
days. It needs all 14 dates, at least 3 active dates, and the same minimum-activity guard.
The full denominator and its coverage are displayed. **This is not a same-hour comparison**
and will usually rise during the day. Historical windows do not show a “today” ratio.
Both today's evidence and all baseline evidence must be complete, with their known/eligible
counters shown alongside the ratio. Rolling averages also return N/A over any evidence gap.

The end-of-month projection uses the observed total through the last complete date plus
remaining calendar days at the median of up to 14 trailing complete daily values. The
low/high scenarios use their 10th/90th percentiles. If today is partial, its projected
contribution is the larger of the observed value and the scenario daily rate; a busy
today does not consume the projection for future full days. It requires the month
from its start inside the selected/observed range, at least 7 complete sample dates,
at least 3 active dates, and a minimum-activity guard. Zero dates count. Metric evidence
must be complete for the whole observed month
(including today) and every sampled day. Gaps are not zero samples and are not silently
dropped. Month/sample evidence counts stay visible even when the projection is unavailable.
Unavailable burn ratios and projections name the failed guard with observed and required figures: calendar coverage, complete metric evidence, sample/active days, minimum value or model calls, or an ended month/historical window.
The band is a **rate scenario, not a confidence interval**: no normality, independence or probability
of future usage is claimed. It assumes the workload continues and cannot anticipate
project changes. API-equivalent value is not an invoice; activity counters do not prove
success, quality, human time saved or value delivered.

## Request size and transcript evidence

Claude's `maxInputTokensPerCall` reflects deduplicated requests, including unpriced models. Codex's `maxInputTokensPerCall` includes only owned, deduplicated sized requests; cumulative-only Codex deltas and foreign broadcasts never raise it. No accounting totals depend on these peaks.

`transcript.completeness` (`complete`, `partial`, `unknown`) describes the observed files' parse/version coverage. `transcript.liveness` (`active`, `inactive`, `unknown`) comes from ordered terminal/open markers and explicit Conductor status; an open marker older than 15 minutes or with missing/future time is unknown, never assumed active. Composite Claude evidence takes active, then unknown, then inactive across main/subagent files. These are observations and do not prove historical retention or future inactivity.

## Interchange metrics (schema version 1)

Full machine and repository snapshots now include `schemaVersion: 1`. This is a format discriminator, not a provider parser version or package version. The [snapshot schema](../schemas/snapshot.v1.schema.json) describes the existing fields; their accounting semantics above are unchanged. CSV columns retain those field names and units. CSV/NDJSON structural fields and OTLP metadata are defined in [interop.md](interop.md).

CSV `contributingSessions` counts sessions that contributed an entry to the particular repository/provider/day, repository/provider/cost-basis/model, or repository/provider/tool row. It is not the number of successful tasks, people, or model calls. `daily.csv` is the activity ledger: dated and [session-dated](#session-dated-value) usage value by repository, provider and calendar day in the snapshot's declared timezone (`velocity.timeZone`), with `apiEquivalentSpendUsd` for every session whose value is not provider-reported and `providerReportedSpendUsd` for provider-reported sessions (Conductor result receipts, which are session-dated). Undated value (Cursor's database value) and sessions without a ledger have no daily rows; no daily Cursor database value or model-level Cursor tokens are inferred. From the dashboard it covers the sessions in the repository and provider scope, whatever their start date, over the selected dates, so it adds up to the dashboard's usage value for the window. NDJSON `kind` discriminates the snapshot header, repository rollups, and session records; each row carries the schema version. Exported JSON and the sessions, models and tools CSVs recompute every rollup after repository, provider, and session-start date filtering. They include the whole selected session, even if that session's usage extends beyond the selected dates.

The shared format contains only additive counters from successfully analyzed sessions in repository buckets with at least `minimumSessions` distinct provider/session keys (default 5; minimum 2). Explicit aliases may join roots before thresholding. `repositories[].repository` is a keyed pseudonym or explicit alias. `sources[]` contains domain-separated keyed installation identities so merges can reject repeated sources. There are no raw/local session keys or time windows in this format.

| Shared counter (in each repository and `summary`) | Definition |
| --- | --- |
| `sessions` | Successfully analyzed distinct sessions in retained buckets; this is the threshold denominator, not a count of people. |
| `inputTokens`, `outputTokens` | Observed session totals. Cache reads/writes are included in input; reasoning is included in output. |
| `priceableTokens` | Sum of input + output tokens from sessions with a non-null pricing-coverage measurement. |
| `pricedTokens` | Sum of each eligible session's input + output tokens multiplied by its pricing coverage. May have floating-point rounding. |
| `apiEquivalentSpendUsd` | Sum of API-list-price-equivalent usage value only. |
| `providerReportedSpendUsd` | Sum of provider-reported local value only (kept separate). |
| `estimatedUpperSpendUsd` | Sum of upper estimates across retained sessions, on their existing cost bases. |
| `toolCalls`, `compactions` | Sum of effective tool calls and compaction counts across retained sessions. |

Every shared `summary` is the sum of **visible rows only**. Suppressed buckets never contribute to a hidden or global subtotal. Missing/invalid evidence does not count toward k. Merging uses the same k across inputs and sums counters; it never averages ratios or reconstructs session records. Shared pricing coverage is `pricedTokens / priceableTokens` with both counters visible; when there are no priceable tokens it is N/A. The whole row is suppressed below the session-activity guard. API-equivalent value is not an invoice. Counts and values are activity measures, not quality, success, or value delivered.

The OTLP mapping uses `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and conditionally `gen_ai.response.model` on custom session-aggregate **logs**. Snapshot observation time is not request start/end time. It does not synthesize request latency, histogram distributions, success status, provider endpoint identity, or inference spans. Repeated exports are overlapping observations, not new activity increments; see the [pinned mapping and ingestion caveats](interop.md#opentelemetry-mapping).

### Interchange correctness and evidence limits

Provider timestamps are normalized to UTC with milliseconds; timestamps without an offset, including SQLite-style timestamps, mean UTC. Dashboard views and exports select sessions by their start date in the snapshot's declared timezone, the calendar of the activity ledger, so one window means the same dates for value and counts. Programmatic `filterSnapshot` callers can still select by numeric start instants with an exclusive end.

Unknown Conductor agents use `provider: "unsupported"`, `transcript.status: "unsupported"`, and `costBasis: "unavailable"`. These retained rows count in the session denominator but not analyzed sessions or sharing eligibility. Source status text is normalized to fixed labels; unknown labels become `unknown`. Tool names use the bounded canonical identifier grammar; model IDs also allow one registry namespace segment. Malformed names become `unknown` / `<unknown>` without releasing source text. Tool counts are retained.

Imports reconcile machine/repository daily, model, and tool rollups against the shared analyzer/export aggregation implementation. Session tokens, model totals, cost components, execution/daily costs, tool counters, and pricing ratios are checked with exact integer counter comparisons and floating-point tolerances for currency/ratios. Cursor reported model costs remain distinct from unattributed session tokens and have no fabricated daily attribution.

Some Claude usage records understate or omit the aggregate cache-write counter while recording larger disjoint 5-minute/1-hour TTL buckets. Ingestion uses the larger of the aggregate and the TTL sum, adds those writes to input, and emits a fixed reconciliation warning. This corrects understated input totals; it preserves the recorded TTL evidence already used for pricing. It does not infer writes beyond either source counter.

Filtered files preserve validated discovery failures independently of selected rows, regenerate selection-dependent warnings, and append the filtering note. Shared totals are observed lower bounds and may include running and partially parsed sessions even when pricing coverage is 100%. Pricing coverage measures rates for observed tokens, not evidence completeness. Shared files release no extra active/partial subgroup counts or suppressed totals.

The health endpoint's `dataSource` is the fixed `live` or `snapshot` label; it prevents a live launch from silently showing saved history and reveals no filename.
## MCP query semantics

The six [MCP tools](mcp.md) return `McpPayload` (schema version 1). The public types are in `src/mcp/types.ts`, re-exported by `src/types.ts`. This is a separate compact projection; existing dashboard/JSON field meanings are unchanged. Repository names are omitted. Standard MCP request IDs are echoed only for protocol correlation, never derived from local history.

### Scope, windows and provenance

- `scope.kind`/`repositoryId`: the selected machine scope or pseudonymous repository. Launch defaults use the same Git/worktree/Conductor assignment as sessions, and empty repositories remain empty. Explicit launch repository filters constrain every query.
- `snapshot.generatedAt`, `ageSeconds`, `ttlSeconds`: generation timestamp, nonnegative age at query time, and configured cache TTL. TTL starts when loading completes; expired requests share one refresh. A refresh failure is an error, never stale success.
- `window.name`, `since`, `until`, `timezone`, `basis`: UTC bounds, with a null lower bound for `all`. Day windows include the current UTC date; week starts Monday. Session metrics select sessions by `createdAt` (falling back to `firstEventAt`), include the lower bound, and exclude future starts. Untimed sessions can only enter `all`. Whole-session counters are never divided among days. `budget_status` alone uses the activity-day ledger for its period values.
- `notes[]`: fixed interpretation and evidence caveats, never copied provider warnings. Parser-warning presence adds a fixed coverage note.
- `sourceHealth[]`: provider discovery health independent of repository, window, and selected session counts. Each row contains `provider`, `status` (`available`, `incomplete`, `unavailable`, or `unknown` for older snapshots), `sourcesRead`, `missingSources`, and `unreadableSources`. It is collected for all seven providers before repository selection as `MachineAnalytics.mcpSourceHealth`, so unavailable providers remain visible even when the entire machine has no sessions. Cursor combines its database, SDK and transcript stores. Absent optional defaults do not count as missing: no discovered sources is `unavailable` with zero counts (no sources discovered or selected, including when default discovery is disabled). Explicitly selected absent paths count as missing; unreadable/invalid stores count as unreadable. A provider filter selects health rows, not their denominators. Available means configured/discovered sources were readable, not that retained history is complete. Aggregate coverage warnings add a fixed note without forwarding their text.
  The dashboard also uses these existing discovery counts for its first-run state and Coverage source checks. Only known provider labels and fixed outcomes are shown. Checks cover every supported provider; a provider whose counts are all zero is reported as having no sources discovered or selected. Missing history does not establish installation status. Older snapshots without these rows show an explicit unavailable explanation.

### Totals and grouping

`totals.basis` is `session-start`, including in budget responses where the surrounding window's basis is `activity-day`. `totals.sessions`, `analyzedSessions`, and `workingSnapshots` are selected, valid-transcript and Conductor-working-snapshot session counts. The working count alone does not detect standalone activity; profiles expose lifecycle coverage separately. Input/output tokens, user turns and tool calls sum the corresponding existing session counters. `value.apiEquivalentUsd`/`apiUpperEstimateUsd` sum API-basis cost/upper estimates; `providerReportedUsd` sums reported-basis cost. They are kept separate and are not invoice amounts.

`value.pricingCoverage` has numerator equal to observed API-eligible model tokens with a known rate and denominator equal to all observed API model input plus output tokens. `unpricedTokens` is their difference. Cursor is excluded from that denominator. No API tokens means unavailable coverage; zero-rate reviewed models remain priced. Coverage needs at least one observed token; it describes evidence completeness, not performance.

`usage_summary.data.groupBy` is repository, provider, model, or agent. `groups[].key` is a repository hash, provider enum, provider-prefixed bounded model identifier, or execution-kind enum respectively. Agent means top-level/subagent/mixed/unknown, not an individual identity. Model group session counts may overlap; their cost/token attribution follows the analyzer's model counters. Model-level turns/tools and Cursor model tokens are `null` because evidence does not attribute them. Unknown or invalid model names group under `unknown`; sessions without model entries appear only in the top-level totals. Rows sort by combined observed value, then key; API and reported components still remain separate.

`totalGroups`, `totalTools`, `totalSessions`, `nextOffset` describe pagination, not an additional population. Default pages have 10 rows, maximum 50. An exhausted page has `nextOffset: null`; a snapshot refresh can change page membership. `recent_sessions` sorts by last event (then start), with the session hash as tie breaker; it returns bounded model IDs, timestamp/null, working status, duration/null and the same value/coverage object. `omittedModels` counts model identifiers beyond the cap of ten. All keys come from the existing public projection.

### Ratios and typical sessions

Every `McpRatio` includes `numerator`, `denominator`, `minimumDenominator`, `value` and `status`. Empty denominators produce `value: null`/`unavailable`; positive but small denominators produce `null`/`insufficient-data`. `value` is a fraction, except compactions per session, which can exceed one. Coverage uses minimum 1 because it reports evidence completeness. Cache hit rate requires 1,000 processed input tokens; compactions per session requires five eligible sessions.

`repo_profile` returns `sessions`, `activityStates.{active,settled,unknown}` counts, and four distributions: API-equivalent value, provider-reported value, user turns, and wall duration. Each includes `median`, nearest-rank `p90`, `samples`, `selectedSessions`, `excludedSessions`, and `minimumSamples` (5). Only valid transcripts with settled lifecycle evidence enter distributions. Value distributions also require complete API pricing with observed tokens, or reported-basis value respectively. Turns must be positive; duration needs first/last event evidence and a positive wall span. Zero API value from a priced zero-rate model is eligible. Exclusion counts are specific to each measurement; medians and p90 are null below five samples.

`mcpEvidence.activityState` is an enum derived from recorded lifecycle events. Codex task starts, user-message events/items and tool calls indicate active work; `task_complete`/`turn_aborted` settle the recorded turn. Token broadcasts never establish liveness. Claude user/assistant activity is active until `message.stop_reason: end_turn` or a system `turn_duration` record, tracked independently for main and subagent files by timestamp. Every included file must settle; any active file excludes the composite session. A Conductor `working` flag overrides settled evidence. Missing lifecycle evidence, malformed records, or untimed transitions cannot establish settled state. Cursor currently has unknown lifecycle evidence and its typical-session distributions remain unavailable. Settled describes the last recorded turn, not success, permanent completion, or live process status; a later start makes the next snapshot active again. Standalone discovery's default `idle` is never settlement evidence.

`cacheHitRate` divides cache reads by processed input for Claude/Codex only. `compactionsPerSession` divides their compactions by their valid-transcript session count; Cursor's missing evidence is never a zero compaction rate. `toolMix` is a descending `{name,calls}` counter capped at 20, with `omittedTools`. `compare_agents.agents[]` always contains `claude`, `codex`, `cursor`, `copilot`, `opencode`, `gemini`, `antigravity`, and `unsupported` totals/profiles under identical repository/window selection. It neither normalizes task mix nor ranks quality. Session length includes idle time and needs a same-repository/task baseline.

### Tool statistics

`SessionAnalytics.mcpEvidence` is additive, collected during the existing streaming parse. It contains only `activityState`, `pricingByDay[]` and `undatedTokens`; no tool results, error flags or quota samples are retained.

`tool_stats` returns `{ name, calls }` per tool from the effective call counters. Code-mode calls count the inner tools they ran. There is no error rate, result count or result coverage. Call counts are activity indicators, not verdicts or causes. `budget_status` reports no quota, plan limit or headroom.

### Budget periods

`today` and `week` contain `since`, `until`, `apiEquivalentUsd`, `pricingCoverage`, `unpricedTokens`, `undatedTokens`, `datedSessions`, `undatedSessions`, `excludedProviderReportedUsd`, `elapsedHours`, and `apiEquivalentUsdPerHour`. Period API value sums `spendByDay` entries for the UTC dates in the period across **all** scoped sessions, including sessions started earlier. `datedSessions` counts API sessions with a dated value or token entry in the period, including zero-rate and wholly unpriced usage. `undatedSessions` counts scoped sessions without either applicable daily ledger. `excludedProviderReportedUsd` is the all-history scoped reported value with no date attribution, not period spending. Envelope totals explicitly retain `basis: session-start` for the week's start cohort.

The analyzer retains `mcpEvidence.pricingByDay[]` (`day`, `eligibleTokens`, `pricedTokens`) from the same deduplicated request usage and UTC accounting date as `spendByDay`, before unknown prices are excluded. Dates follow the existing timestamp/metadata fallback; invalid dates contribute only to `mcpEvidence.undatedTokens`. The period's `pricingCoverage` sums these operands over its days, and `unpricedTokens` is their difference. This coverage qualifies **both** the adjacent period value and burn rate; a session started before the week cannot disappear from its denominator. Period `undatedTokens` counts all scoped API tokens with no usable accounting date, excluded because they cannot be assigned to any period. Older snapshots lacking these operands return unavailable coverage and null unpriced/undated counts rather than borrow session-cohort coverage. Zero eligible tokens means unavailable, never 100%.

Elapsed hours run from UTC day/Monday start to query time. Burn rate divides dated API value by those hours only after at least one hour and three dated sessions. It does not estimate active time, extrapolate spending, infer a budget limit, or predict an invoice. Missing-history coverage remains a limitation even with full pricing coverage.

## Integrated replay and surfaces

Index replay preserves the entire declared session, including velocity, history profile, MCP and pricing evidence. Source-deleted sessions retain last-ingest facts/prices, appear in historical totals, and never establish current working activity. Unknown session starts and file-mtime fallback dates are excluded from bounded start-date scopes. UTC comparisons use instants and exclusive next-midnight bounds.

MCP provenance includes an optional `metrics` envelope with `basis`, `pricing` and `velocity` summaries. Existing denominator/activity guards apply. Full field maps are in [privacy.md](privacy.md#integrated-mcp-summaries-mcppayloadmetrics).

## History coverage and recovery

`historyCoverage` is an optional **machine-wide** namespace, separate from session and repository totals. The Summary panel always labels this global scope; its rows do not follow dashboard repository/date filters. Repository-filtered analysis and filtered snapshot exports omit the namespace. Full snapshots preserve it. No sessions or repository assignments are invented from statistics.

### Session history profile

`sessions[].historyProfile` is optional and present only on native Claude sessions whose profile is known. `profileKey` is the pseudonymous `profile-<20 hex>` key of the Claude profile that holds the transcript, the same key used by `historyCoverage.profiles[].profileKey`. `days[]` holds `{ day, model, tokens }` rows sorted by day and model: `day` is the request's UTC date (`YYYY-MM-DD`), `model` the bounded public model ID, and `tokens` the deduplicated request input plus output tokens, counted at the same point and with the same deduplication as the session's priced usage. Undated requests are omitted, so the rows can sum to less than the session's token total. These counters are the session side of the profile statistics reconciliation below; they are not a separate usage total and never change session tokens, prices or request counts. Indexed sessions written before this field existed are converted from their stored per-day evidence when they are read.

### Conductor assistant recovery

When a Claude provider identity has no canonical transcript, recover its retained assistant usage before considering result-only evidence. SQLite selects fixed metadata paths, usage counters and tool names/IDs; no prose, thinking text, arguments or results are selected into JavaScript row objects. Copies in `content`/`full_message` and duplicate Conductor rows share the same deduplication scope. Explicit conversation-reset links admit linked identities; foreign identities are excluded, and a canonical identity always wins. Codex SDK envelopes are never interpreted as Claude usage.

Native and recovered Claude requests use the same cache/TTL normalization and max-output snapshot rule. A larger output snapshot replaces an earlier one; ties retain the first owner unless usage or a reasoning breakdown was absent. The first usable request timestamp stays with that request, including across UTC midnight. Timing uses the record timestamp or database event timestamp. Missing timestamps stay undated. Tool-use IDs deduplicate calls, and `parent_tool_use_id`/sidechain markers distinguish subagent requests. Human turns and unobserved lifecycle metrics remain unavailable. The SDK record UUID and database `sdk_message_id` identify streamed blocks, not API responses. When response IDs are stripped, recovery groups matching model and physical input counters within the same provider/parent agent, retaining max output. This can merge separate indistinguishable requests, so these groups are counted in `messagesWithoutIdentity` and request counts/value are conservative partial evidence. Turn IDs and intervening user records are not reliable response boundaries. A retained response ID in either copy of a record wins; ambiguous copies never add an extra known request. Retained message accounting is always partial, even if values agree.

Recovered sessions have `evidence.source: conductor-messages`, message fidelity, request usage units and API-equivalent prices. `historyStatistics` carries the fixed `claude-stream-snapshots-v5` counter basis and dated stream observations for native/recovered Claude sessions. `history.days` carries UTC day/model deduplicated token totals and value; `history.undatedTokens`/`undatedValueUsd` preserve the unbucketed remainder. Velocity uses the same deduplicated requests with its existing local-calendar convention. Recovery never allocates all usage to the session creation or update day.

`conductor.reconciliation` compares the message value (including proved query-output supplements) to the result parser's conservative selected cumulative receipts. `reportedUsd` is null without a monetary receipt; `differenceUsd` is message minus reported value; `relativeDifference` is that difference divided by a positive reported value, otherwise null. Status is `unavailable` without a receipt, `partial` with ambiguous receipt scope, absent usage, incomplete price coverage or missing request identities, otherwise `agrees` within **max($0.01, 1% of reported value)** or `differs`. The absolute tolerance is a rounding allowance, not a precision claim for tiny totals. `receiptScope` preserves complete/partial/unavailable receipt scope. Counts expose compared messages, missing usage and missing request identities. Agreement neither proves invoice accuracy nor complete retained history. Different prices, missing subagents and resumed receipt scope can cause differences. Result costs are never added to message costs. With no usable assistant usage, the existing result-only fallback remains.

### Final output and the receipt floor

Conductor often stores assistant blocks before output is final. Deduplicated `result.usage` supplies **query-local main-loop** counters; `modelUsage` and `total_cost_usd` have cumulative scope. A unique result bounds the preceding retained query records. After streamed-record and response grouping, recovery accepts an output supplement only when one known main-loop model remains and all three physical input classes (uncached, cache-read, cache-write) exactly match that query's receipt. Missing usage, ambiguous known/stripped aliases, or a response/record replayed across queries rejects the supplement. A new init, a counter decrease, or a new receipt UUID never establishes disjoint cumulative accounting. The VC-001 selection rules remain unchanged.

Only the positive difference between final query output and its retained output is added. It adds no input, request, tool, reasoning or non-reasoning count. `outputTokensRecovered` records this difference; it describes the message reconstruction even when the monetary floor wins. One shared UTC request day permits daily allocation; otherwise the output/value stays undated. Velocity requires a shared request hour and can therefore have more undated value than the UTC daily ledger. Receipt time is never substituted for a request date. Aggregate output uses ordinary pricing with no invented request context size.

Verification conserves these ledgers separately: `sum(spendByDay) + history.undatedValueUsd = cost.totalUsd`, and the sum of hourly velocity buckets, `velocity.sessionDated` and `velocity.undated` also equals `cost.totalUsd`. The hourly remainder must never be added to the UTC daily ledger. The independent oracle also checks the history token total and each day against its model allocations.

If the selected cumulative receipt exceeds reconstructed API value, `receiptFloorApplied: true` selects `costBasis: provider-reported` and `evidence.source: conductor-result`. Message token classes, model request counts, tools and stream-overlap evidence survive. Model **dollars** come only from receipt allocations; unallocated dollars remain `<unknown>`. Thus token/request counters and reported dollars can describe different retained intervals. Price coverage stays null, accounting stays partial, and all selected reported dollars remain undated. `messageValueUsd` continues to expose the alternate API reconstruction; it is not added to the floor or used to allocate reported dollars. A receipt floor can exceed native API value because the sources/prices differ; it is a retained-evidence lower bound, not a promise to be numerically below a surviving transcript.

### Paired recovery calibration

`historyCoverage.recoveryCalibration` runs the same production recovery path as if each surviving Conductor Claude transcript were absent, without adding those counterfactual sessions to any totals. It is recalculated on full and indexed machine scans; repository-filtered analysis and filtered exports omit it with the enclosing machine scope. No static accuracy number, external dataset or multiplier is used.

`pairedSessions` counts uniquely matched surviving native/SDK sessions. Ratios use only complete, fully priced native sessions with at least `minimumNativeValueUsd` (**$1**), excluding observed active work/working snapshots; unknown liveness can remain and does not prove inactivity. `comparedSessions + excludedSessions = pairedSessions`. At least **five** eligible pairs are required; otherwise all four ratios are null. `nativeValueUsd` and `recoveredValueUsd` sum the eligible operands. `aggregateValueRatio` divides those sums; `medianValueRatio`, `p10ValueRatio` and `p90ValueRatio` linearly interpolate sorted per-session ratios at `(N - 1) × quantile`. They are descriptive sample quantiles, not confidence intervals.

`receiptFloorSessions` counts eligible pairs selecting reported value. `aboveNativeSessions` counts selected values exceeding native value by more than **max($0.01, 1% of native value)**. The panel discloses both because API and receipt prices/scopes can differ. Surviving recent transcripts and activity-weighted pooled ratios are not representative guarantees for deleted history, model quality, success or invoices. Subagent final output, stripped cache-write TTLs and ambiguous restarted cumulative receipts remain substantial limits. The independent paired oracle in `verify/recovery/` compares token classes, model allocations, UTC days, months and hashed worst cases before any extrapolation is considered.

### Profile statistics reconciliation

Read each Claude profile's optional `stats-cache.json`, including stats-only profiles, deduplicating real paths. Explicit `--claude-root` isolates both transcript and statistics discovery. Files are bounded to 8 MiB, 20,000 daily rows and 256 lifetime models. Only **`dailyModelTokensVersion: 5`** is currently comparable: the installed provider implementation sums UTC-day input + output + cache-read + cache-creation counters for **every streamed assistant block**, including child transcripts. It does not deduplicate API response IDs. Main-file sidechain copies are excluded; child files are included. These are repeated counter observations, not unique billable tokens. Unknown/older versions, malformed files and missing stores remain visible as unsupported/unreadable/missing, not zeros. Invalid dates/counters/model identifiers are ignored; repeated day/model rows take their maximum snapshot rather than being summed. Statistics are only compared on reported dates through `lastComputedDate`, when provided; a missing day is not an asserted zero.

For each **profile, UTC day and exact model ID**:

1. Preserve deduplicated native `historyProfile.days[].tokens` as `sessionTokens`. Separately sum `historyStatistics.days[].tokens` as `sessionStatisticsTokens`, matching the provider’s streamed-block basis. This extra counter never affects request counts, session tokens or session prices. Older source-deleted indexed sessions without these counters use deduplicated evidence as a conservative subtraction and are counted in `sessionsWithoutStatisticsCounters`.
2. Compute `gapTokens = max(0, providerTokens - sessionStatisticsTokens)`. Excess evidence on another day, model or profile never offsets this gap.
3. Recovered Conductor requests have no trustworthy profile. For statistics comparison only, each retained SDK record contributes its counters once, deduplicating record UUIDs across database copies; response deduplication is still used for session pricing. For each day/model, reserve `min(sum(profile gaps), unknown-profile recovered stream counters)` as **possible overlap**, once across all profiles. Allocate that reservation proportionally to gaps with integer largest-remainder rounding. This is a conservative uncertainty allowance, **not inferred profile membership**.
4. `unattributedTokens = gapTokens - possibleOverlapTokens`. Roll the operands up to profile/month/model and machine/month only after these daily calculations.

Price the remainder using the profile's **lifetime token-class proportions for the same model**, with the rate card resolved for each reported day. Do not use `modelUsage.costUSD` as a price (subscription stores may report zero). Use ordinary rates, not one enormous fictitious long-context request; unknown cache-write TTL uses the default write rate. Missing token mix or model rates produces an unpriced remainder, not a zero-cost assertion. `pricedUnattributedTokens / unattributedTokens` accompanies every dollar estimate and measures explicit rate coverage of the imputed mix; it does **not** measure evidence completeness. Partial rate substitutions can give a value while lowering the priced denominator.

These estimates are uncertain: the remaining provider counters can repeat streamed requests and therefore overstate missing billable tokens; lifetime mix need not match a past month, daily/lifetime caches may cover different horizons, provider counting rules may differ, and unknown-profile Conductor overlap may come from a different account. Undated result-only evidence cannot be subtracted by day and can still overlap a statistics gap. Accordingly, estimates remain separate and must not be added to session totals as an authoritative grand total. Lifetime tokens without a daily allocation are disclosed but never assigned to a month. No extrapolation fills dates the statistics cache does not cover.

Each month exposes `sessionsWithDatedValue` and `statisticsCells` (reported profile/day/model cells) as its evidence denominators. A month without statistics displays an unavailable estimate, not zero missing usage. Each machine month shows `sessionEvidenceUsd` (all providers' actually dated session value), `recoveredMessageUsd` (its recovered Claude subset), remaining estimated value/tokens, price coverage and overlap reservations. `undatedSessionValueUsd` includes result-only summaries and other costs without request days. The first present Claude transcript day excludes index-only source-deleted sessions; the first statistics day and statistics watermark show the cache's actual horizon. **Provider transcript retention can remove older sessions while statistics survive.** An earliest observed date alone does not prove a deletion, the historical retention setting or that earlier work never happened.

The inspected Codex state store has one `threads.tokens_used` snapshot per thread and created/updated timestamps, not dated per-model request increments or the disjoint token classes needed for this estimator. It is not subtracted from monthly rollout evidence or added as recovered usage. A verified counter scope and timestamp allocation are prerequisites for supporting it. Conductor Codex registrations remain covered by canonical rollout precedence.

### v0.6.1 repository and aggregate correctness

Repository grouping canonicalizes existing symlinks, resolves Git `commondir`, and uses the nearest independent Git boundary. A complete normalized remote joins independent clones, preserving host, namespace and nondefault port; namespace case is preserved except on known case-insensitive GitHub/Bitbucket hosts. Initial Codex metadata remotes supply historical identity when the checkout is missing. Recorded Conductor workspace ownership and aliases do not depend on session-row presence. Cursor workspace metadata outranks referenced files, and absent ownership is explicitly unassigned. Discovered IDs change for repositories now grouped by remote; present sources are reassigned on every scan. Source-deleted indexed evidence keeps its last known repository identity until stronger surviving evidence is available.

Velocity pricing coverage sums the exact count of explicitly priced token classes. Partial receipts and activity-only sessions are not missing-price sessions; `unpricedSessions` counts positive observed token denominators with nonnull coverage below one. `cacheReadRatio` is null when its input denominator is zero. Saved v1 snapshots with the independently reproducible v0.6.0 coverage/live-count formulas normalize those derived fields on import; session evidence and all other accounting consistency checks remain required.

Summary's daily chart, usage-value KPI (with its sparkline and delta), sidebar repository values and repository value bars use the same local activity-day ledger as Velocity; the other Summary KPIs are labeled session-start cohorts. Costs exposes any unallocated value or token balance without inventing a model identity. Unknown starts never contribute Activity heatmap starts. Source-deleted and unavailable historical observations stay outside live counts in filtered exports.

### v0.6.1 receipt and pricing corrections

Conductor init records do not establish disjoint accounting intervals. Result-only recovery keeps one observed cumulative lower bound per provider identity; ambiguous resets and restarts remain partial. Only retained version-qualified older marginal metadata can establish additional reported cost. Where no cumulative token counters exist, deduplicated turn-local usage is retained as a partial main-loop token lower bound. It is never added to cumulative whole-tree tokens. Nonnegative unallocated reported balances use the existing `<unknown>` model bucket with zero invented requests; a metadata-only model name cannot establish allocation. Retained assistant usage supplies message tokens when available; a higher receipt value remains a separately labeled floor, with scope uncertainty preserved.

The bundled pricing catalog includes model-specific historical Sol rates from July 9 through August 20, 2026, and Terra rates from July 9 through July 29. The Sol pre-reduction input/cache/output rates are $5/$0.50/$30 per million; Terra's $2.50/$0.25/$15 rates are inferred from the announced 20% reduction. Effective boundaries use UTC midnight because the official changelog supplies dates, not exact transition times. Transition-day values and the inferred Terra interval are estimates, not reconstructed invoices. Explicit custom cards retain their configured tariffs. Derived provenance hashes identify the reviewed interval plus its base observation, not a historical downloaded provider payload. Sources: [official changelog](https://developers.openai.com/api/docs/changelog), [model-specific cache-write policy](https://developers.openai.com/api/docs/guides/prompt-caching).

Legacy OpenAI models no longer receive an inferred cache-write surcharge. Explicit feed/custom write tariffs override fallback multipliers, and upper estimates use the resolved context write price. Spark has no verified bundled API tariff and stays visibly unpriced. Summary upper estimates bound each physical token class independently across configured context tiers and unknown TTL remainder; they do not claim observed request sizes.

The active reviewed card supersedes an archived definition with the same effective date, including the fallback for requests predating all observations. Archives with distinct effective dates remain historical evidence, and stored source files are not rewritten. An explicit custom card remains authoritative.

### v0.6.1 native evidence boundaries

Claude fallback, message, compaction and advisor iteration counters replace their envelope and price each known attempt at its observed model and request size. Unsupported or malformed attempts remain partial. Richer streamed TTL/thinking details can augment equal physical counters without adding another request. Missing thinking detail leaves an unknown output remainder: known reasoning plus known non-reasoning may be less than total output.

Validated Claude copies and children form one composite, and stable response identities prevent copied usage from billing again in another session. Surviving children can expose a partial group when the main is missing; an indexed fuller parent retains its observed history. Desktop metadata can establish source attribution unless an explicit transcript entrypoint says otherwise. Legacy Desktop receipt supplements require version-qualified, disjoint response intervals, exactly matching native input/cache counters, one main model, no child overlap and final-result consistency. They add only proven missing output or uncached model residuals, with no invented request count or reasoning classification.

Codex explicit thread/response receipts establish independent requests, including compaction. Validated continuation files contribute a union with separate per-file cumulative baselines. Exact file copies collapse; foreign metadata cannot relabel a child's execution. Pre-birth ancestor counters and exact four-counter request chains prove replay. Different dates, different tool calls, or a counter decrease alone cannot establish independent billing for otherwise equal legacy states; these cases stay conservatively counted and partial.

All JSONL readers use LF framing, preserving CR whitespace and Unicode separators inside JSON strings. Request times must normalize to valid UTC instants. Undated usage stays in lifetime totals and explicit undated velocity/MCP coverage without an invented daily cell. Unknown starts and file mtimes cannot establish Activity/session-start cohorts. Independently dated usage and compactions still contribute to observed date bounds.

### Dashboard scan progress

The dashboard's pending analytics response includes transient work counters, separate from the snapshot.
`progress.phase` is `discover` (enumerating provider sessions), `parse` (parsing or serving indexed sessions),
or `combine` (aggregating the snapshot). `done` counts completed session work units, including skipped/unreadable
candidates and indexed results; the Cursor database child counts as one unit. `total` is null before enumeration
and otherwise the work known so far; it can grow as providers finish discovery. These counters describe scan
work, not the resulting snapshot's session count. `startedAt` is the scan's UTC ISO timestamp; `fullParse` is a
boolean indicating a cold index or a parser/price revision requiring all history to be parsed again.

## Subscription plan periods

Live limits (`GET /api/limits`, `limits --json`) are separate from saved analytics. The optional
`observations[].planType` is the closed Codex tier enum declared in `src/types.ts` (via `limits/types.ts`):
`free`, `go`, `plus`, `prolite`, `pro`, `team`, `business`, `enterprise`, `edu`, `promax`, or `unknown`.
Null/absent means missing evidence; every unrecognised source string becomes
`unknown`. The same vocabulary applies to `accounts[].planEvidence.planType`, including imported ledgers and remote snapshots. Neither field ever carries arbitrary provider text. `unknown` cannot calibrate capacity because several unknown tiers could share it. Claude readings omit it.

Subscription value uses the existing hourly activity ledger and account/machine join; token counts and API-equivalent
usage totals do not change. Codex value per 1% is the median of qualifying segments **on the same reported tier**,
with outlier filtering applied within that tier and at least two segments. Calibration uses all retained eligible history (up to 120 days), independently of the selected value window. A cycle containing more than one tier,
including readings before the first known tier, has no reliable allowance baseline and cannot calibrate. Missing readings carry the last observed tier forward for analysis, just as price periods do; earlier readings are never backfilled. Historical reset dollar
values use their cycle's tier. A change within an unchanged reset window starts pace at the first new-tier reading,
using the percent increase since that reading, without inventing a redeemed reset.

Each new observed Codex tier starts a price period at that reading's Unix timestamp. Price is
`monthly USD × overlap seconds / (86400 × 30.4375)` per period; capacity is
`that tier's weekly capacity × overlap seconds / (86400 × 7)`. The account's counted period still begins at its first
meter reading and ends at the earlier of now and the selected window's end. UTC-second overlaps handle fractional
days and DST without assuming that every local day is 24 hours. These are observed plan periods, not invoice dates. Assuming one transition between consecutive known-tier readings,
its price timing error is at most `abs(new monthly USD − old monthly USD) × gap seconds / (86400 × 30.4375)`.
Missed intermediate changes and invoice rules add separate uncertainty; there is no fixed billing-error guarantee.
The headline value multiple includes only matched value from periods with a positive personal price, paired with
those same periods' prorated prices; employer-paid, free and unknown-price periods are reported beside it. The account
row's multiple is unavailable if any counted period lacks a personal price. Current full-month potential uses the
current tier's calibration and monthly price independently of historical price coverage.

A manual plan override prices all counted periods at that selected plan; it never merges tier calibrations. A payer
override applies to every period. Wholly untagged Codex histories and Claude retain the old current-plan fallback;
once Codex has tagged evidence, its earlier untagged period has unknown price and capacity and is excluded from the personal multiple.
An upgrade typically lowers the historical price estimate and raises the multiple compared with pricing every prior
day at the latest expensive tier; downgrades do the reverse. Calibration/capacity may move either way or become
unavailable while the new tier accumulates evidence. Total extracted usage value is unchanged.

The private `limits-v2.json` upgrades its version marker to 3 and appends an optional tenth column for this tier.
Version 0.12.1 rejects that marker and reports an unreadable ledger instead of silently hiding new history. Existing
nine-column v2 rows and the earlier separate `limits-v3.json` are imported; the separate file stays read-only. The original
`limits.json` import and `limits-inbox-v2.jsonl` remain supported. Nine-column rows stay untagged; the migration does
not infer historical plans or reread provider history to invent them. [Subscription semantics and migration](subscription.md#where-the-readings-come-from).
