# Privacy contract

`session-analytics` reads coding-agent transcripts that already exist on your machine. Those transcripts contain everything you and your agents have written: prompts, responses, reasoning, commands, file paths, diffs, and tool output. This document defines exactly what the tool may return from them, how that boundary is enforced, and what it does not protect against.

The contract applies to every output surface: the dashboard and its `/api/analytics` endpoint, the terminal report, the JSON snapshot (`report --json`), and the agent skill, which only runs those commands.

## The contract

**Returned:** allowlisted counters and identifiers only.

- Token counters by class, cost figures, counts of events, durations, and ISO timestamps.
- Model IDs and reasoning-effort labels as the provider recorded them.
- Tool names, and skill identifiers that match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
- Bounded numeric CLI versions, fixed entrypoint/originator/effort enums, and registry-verified slash-command identifiers using the skill-name grammar (never unknown tokens, arguments or the rest of the command).
- A repository display name and a stable repository ID.
- A session key: the first 12 hex characters of a SHA-256 hash of the provider-qualified session ID.
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
| **P1** | Pseudonymous keys and identifying metadata: session keys, repository IDs and display names, workflow command and installed-skill identifiers; later keyed hashes (with a per-machine secret) of paths and arguments, file extensions, command classes, MCP server names, commit SHAs | Returned today (keys, repository metadata and registry identifiers) |
| **P2** | Results of local rules over content, where only fixed rule identifiers and counts leave the parser | Exact Claude interruption-marker counts are opt-in; no command/diff rules |
| **P3** | Text shown to you or sent to an LLM, such as an opt-in session review | Not implemented; will be opt-in per run, stored separately, and labeled |

P2 and P3 features are off by default. The workflow `claude-interrupt-marker` rule requires `--workflow-content-rules` or `SESSION_ANALYTICS_WORKFLOW_CONTENT_RULES=1`; `--no-workflow-content-rules` overrides both. It only matches one of two whole provider control markers, emits `claudeMarkers` counts, and excludes recognized markers from human-turn counts. No prompt fragments or regex captures leave the parser. Timing derived from those control events is marked by `coverage.contentRules` per session and `coverage.contentRuleSessions` in aggregates.

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
| `workflow` | Optional workflow aggregate; also present on the single-repository analysis result. See the workflow manifest below | P0/P1/P2 |

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
| `workflow` | Optional primary-transcript workflow projection; absent for unsupported/failed parses. See below | P0/P1/P2 |
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
| `maxContextWindow` | Largest context window the provider reported | P0 |
| `maxInputTokensPerCall` | Largest input of a single request | P0 |
| `contextUtilizationPeak` | `maxInputTokensPerCall / maxContextWindow`, or `null` when no window is reported | P0 |

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
| `model` | Model ID as recorded by the provider (`<unknown>` when none was recorded) | P0 |
| `calls` | Requests attributed to this model | P0 |
| `priced` | `true` when the rate card has an entry for this model (always `true` for Cursor provider-reported values) | P0 |

### Workflow field manifest

Types are declared in [`src/metrics/workflow-types.ts`](../src/metrics/workflow-types.ts) and re-exported from `src/types.ts`. All output objects are projections of counters, bounded labels and normalized timestamps. Raw IDs used for matching/deduplication, history `display` text, custom originator strings, queue reasons, skill bodies and directory paths stay internal. Fixtures in `test/workflow.test.ts` and `test/workflow-integration.test.ts` plant sentinels in all these sources and assert their absence through session/repository/machine JSON, the worker boundary and terminal report. The API uses the same worker projection, with additional coverage in `test/server.test.ts`.

Paths below are relative to `session.workflow`, except where specified. Unavailable histogram values and denominators are null, not zero.

| Field | Meaning | Tier |
| --- | --- | --- |
| `schemaVersion` | Workflow contract version, `1` | P0 |
| `scope` | `primary-transcript` | P0 |
| `ending` | `terminal`, `interrupted`, `inferred`, `open`, `unavailable` | P0 |
| `coverage.timing` | `observed`, `partial`, `unavailable` timing coverage | P0 |
| `coverage.humanTurns` | `observed`, `partial` when primary records/projection signals were lost, or `not-applicable` for a child thread | P0 |
| `coverage.timestampedEvents`, `coverage.untimedEvents`, `coverage.droppedEvents` | Normalized signal and cap counters | P0 |
| `coverage.malformedRecords`, `coverage.projectionErrors` | Primary JSON/record-shape gaps and isolated optional-observer failures; no raw errors | P0 |
| `coverage.contentRules` | Whether the P2 marker rule was enabled for this session | P0 |
| `humanTurns` | Observed primary human inputs, null for sub-agent threads | P0 |
| `toolCalls` | Selected primary-transcript tool-call count, including untimed calls | P0 |
| `toolRuns`, `turnWallTime` | Histogram objects: `bins[].value`, `bins[].count`, `samples`, `p50`, `p95`, `max`; counts for runs, milliseconds for turns | P0 |
| `recordedTurnDurations`, `inferredTurnDurations` | Histogram sample counts by timing evidence | P0 |
| `time.activeMilliseconds`, `time.waitingForHumanMilliseconds`, `time.unclassifiedMilliseconds`, `time.observedSpanMilliseconds` | Estimated activity/wait/idle partition and observed wall span | P0 |
| `time.idleThresholdMilliseconds`, `time.waitingCapMilliseconds` | Fixed 300,000 / 1,800,000 ms thresholds | P0 |
| `time.activeSpans[].start`, `time.activeSpans[].end` | Coalesced, half-open ISO activity intervals; no event IDs | P0 |
| `interruptions.interrupted`, `interruptions.replaced`, `interruptions.other` | Deduplicated structured Codex abort counts | P0 |
| `interruptions.subagentInterrupted` | Distinct interrupted sub-agent activity items | P0 |
| `interruptions.claudeMarkers` | Fixed rule `claude-interrupt-marker` count; null when off | P2 |
| `steering.midTurnHumanTurns`, `steering.planEntries`, `steering.planItems` | Steering and distinct planning evidence counters | P0 |
| `steering.queueOperations.enqueue`, `.dequeue`, `.remove`, `.other` | Fixed operation enum counters | P0 |
| `steering.queueReasons.prompt`, `.interrupt`, `.completion`, `.cancellation`, `.other`, `.unspecified` | Fixed reason-class counters, never original reason text | P0 |
| `archetype` | `quick`, `standard`, `deep`, `marathon`, or null; heuristic | P0 |
| `abandonment` | `flagged`, `not-flagged`, `insufficient-evidence`, `ongoing`; heuristic | P0 |
| `mix[].at` | ISO metadata observation timestamp | P0 |
| `mix[].model` | Bounded structured model identifier or null | P0 |
| `mix[].effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, or null | P0 |
| `mix[].cliVersion` | Numeric three-component version; optional numeric alpha/beta/rc/dev suffix; null otherwise | P0 |
| `mix[].entrypoint` | `cli`, `sdk-ts`, `local-agent`, `vscode`, `exec`, `subagent`, `review`, `unknown` | P0 |
| `mix[].originator` | `codex_cli_rs`, `codex_vscode`, `codex_exec`, `codex_sdk`, `app-server`, `unknown` | P0 |
| `commands[].name` | Leading identifier independently verified against built-in or scoped command/skill registries; unknown spellings never leave the parser | P1 |
| `commands[].at` | Normalized timestamp of a recognized command in matched Claude history | P0 |
| `unrecognizedCommands` | Matched slash-prefixed history entries without registry evidence; count only, never the spelling | P0 |
| `commandHistoryAvailable` | Whether the matching profile history was readable | P0 |
| `valueByHour[].hour`, `valueByHour[].usd` | UTC-hour timestamp and API-equivalent value of timestamped priced primary requests | P0 |
| `pricedRequests`, `timestampedPricedRequests` | Value heatmap denominator/numerator | P0 |

The following paths are relative to `MachineAnalytics.workflow` or `RepositoryAnalytics.workflow`. Public `RepositoryRollup` does not duplicate this large aggregate; per-repository concurrency is inside `workflow.repositories`.

| Field | Meaning | Tier |
| --- | --- | --- |
| `schemaVersion` | Workflow contract version, `1` | P0 |
| `coverage.sessions`, `.supportedSessions`, `.timedSessions`, `.humanSessions`, `.contentRuleSessions`, `.partialSessions` | Selected, supported, timed, primary-human, P2-enabled and partial session counts | P0 |
| `autonomy.humanTurns`, `.turnsPerSession` | Primary human inputs and guarded mean (null below five sessions) | P0 |
| `autonomy.toolRuns`, `.turnWallTime` | Pooled histograms with the same six histogram fields as above | P0 |
| `autonomy.recordedTurnDurations`, `.inferredTurnDurations` | Pooled timing evidence counts | P0 |
| `time.activeMilliseconds`, `.waitingForHumanMilliseconds`, `.unclassifiedMilliseconds` | Sums of session partitions, not a cross-session wall union | P0 |
| `interruptions.interrupted`, `.replaced`, `.other`, `.subagentInterrupted`, `.claudeMarkers` | Summed counters above, preserving null for disabled marker rules | P0/P2 |
| `interruptions.eligibleHumanTurns`, `.eligibleSessions`, `.perHumanTurn` | Covered denominator, session count and guarded event frequency; may include enabled P2 counts | P0/P2 |
| `steering.midTurnHumanTurns`, `.planEntries`, `.planItems`, `.queueOperations`, `.queueReasons` | Summed counters with exactly the same nested keys as session steering | P0 |
| `concurrency.peak`, `.eligibleSessions` | Peak activity overlap and sessions with positive activity spans | P0 |
| `concurrency.activeSessionMilliseconds`, `.wallClockActiveMilliseconds`, `.effectiveParallelism` | Summed session activity, wall union and guarded ratio | P0 |
| `concurrency.timeline[].start`, `.end`, `.sessions` | ISO interval boundaries and concurrently active session count | P0 |
| `concurrency.daily[].day`, `.peak`, `.activeSessionMilliseconds`, `.wallClockActiveMilliseconds` | UTC date, daily peak, activity sum and wall union | P0 |
| `repositories[].repositoryId` | Existing pseudonymous repository key | P1 |
| `repositories[].sessions`, `.peak`, `.effectiveParallelism`, `.activeSessionMilliseconds`, `.wallClockActiveMilliseconds` | Per-repository supported count and concurrency measures | P0 |
| `archetypes.quick`, `.standard`, `.deep`, `.marathon`, `.unavailable` | Counts by heuristic bucket | P0 |
| `abandonment.flagged`, `.eligible`, `.ongoing`, `.insufficientEvidence` | Heuristic numerator and coverage counts | P0 |
| `patterns.timezone`, `.asOfDay` | `UTC` and the snapshot's reference date | P0 |
| `patterns.cells[].weekday`, `.hour`, `.activeMilliseconds`, `.apiEquivalentUsd` | Sunday=0 weekday, 0–23 UTC hour, summed activity and priced request value; 168 cells | P0 |
| `patterns.activeDays`, `.longestStreakDays`, `.currentStreakDays` | Active-day and UTC streak counts | P0 |
| `patterns.pricedRequests`, `.timestampedPricedRequests` | Summed heatmap coverage counters | P0 |
| `mix[].day`, `.provider`, `.dimension`, `.name`, `.sessions` | UTC date, provider, model/effort/cliVersion/entrypoint/originator dimension, bounded name and distinct session-day count | P0 |
| `comparisons[].repositoryId` | Existing pseudonymous repository key | P1 |
| `comparisons[].provider`, `.dimension`, `.archetype`, `.effort`, `.entrypoint`, `.heldConstant` | Comparable context: provider, `cliVersion`/`model`, bucket, effort, entrypoint and the fixed other identifier | P0 |
| `comparisons[].durationEvidence` | `provider-duration`, `event-derived`, `mixed` timing class held constant | P0 |
| `comparisons[].before`, `.after`, `.changedAt` | Bounded before/after identifiers and first new-era ISO timestamp | P0 |
| `comparisons[].beforeSessions`, `.afterSessions`, `.status` | Cohort sizes and `eligible`, `small-cohort`, `overlapping-eras` guard label | P0 |
| `comparisons[].beforeTurnP50`, `.afterTurnP50`, `.beforeRunP50`, `.afterRunP50`, `.turnTimeChange` | Pooled turn/run medians and guarded fractional timing change; nullable | P0 |
| `commands[].name` | Registry-verified command identifier | P1 |
| `commands[].count`, `commandHistorySessions`, `unrecognizedCommands` | Recognized command counts, readable-history session denominator and unrecognized slash-entry count | P0 |
| `installedSkills[].name` | Bounded discovered skill identifier | P1 |
| `installedSkills[].provider`, `.observedInvocations` | Claude/Codex provider and observed scoped invocation count | P0 |
| `installedSkills[].repositoryId` | Existing repository key for project installations; null for provider profile/shared inventory | P1 |
| `inventory.directoriesRead`, `.directoriesUnavailable`, `.historyFilesRead`, `.historyFilesUnavailable`, `.malformedHistoryRecords` | Inventory coverage counters; no directory names, history filenames or errors | P0 |

Derived timing/turn/heuristic fields can incorporate P2 interruption control events **only when enabled**, as indicated by coverage. All such values remain counters, enums and timestamps. No P3 content is introduced. New workflow controls persist no extra browser state; only the existing selected-tab/theme storage is used.

Malformed primary evidence makes timing partial and ending unavailable. Tool-run, inferred-turn, activity, waiting and abandonment estimates are suppressed; independent provider durations retain their evidence count. Enum fields accept strings only, and optional observer failures cannot discard accounting. The browser worker receives only the existing public projection, never provider records. Its cache is in memory, bounded to eight filtered aggregates, and invalidated with each new snapshot.

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
