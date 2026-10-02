# Privacy contract

`session-analytics` reads coding-agent transcripts that already exist on your machine. Those transcripts contain everything you and your agents have written: prompts, responses, reasoning, commands, file paths, diffs, and tool output. This document defines exactly what the tool may return from them, how that boundary is enforced, and what it does not protect against.

The contract applies to every output surface: the dashboard and its `/api/analytics` endpoint, the terminal report, the JSON snapshot (`report --json`), the stdio MCP server, and the agent skill.

## The contract

**Returned:** allowlisted counters and identifiers only.

- Token counters by class, cost figures, counts of events, durations, and ISO timestamps.
- Model IDs and reasoning-effort labels as the provider recorded them.
- Tool names, and skill/MCP-server identifiers that match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
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
- **MCP boundary.** The stdio server accepts no tool-supplied paths, commands, URLs, SQL, or client roots. Trusted source/context paths are set only at launch. It queries a child-process snapshot and names-only configuration inventory, and constructs every tool payload explicitly. Names are bounded, repository display names are omitted, and failures contain fixed text. No config commands run and no configured MCP server is contacted. `test/mcp*.test.ts` covers wire responses, structured flags, quota samples and configuration sentinels.

Content is held in memory only while a line is being parsed. It is not cached, logged, or written anywhere.

## Privacy tiers

Every field belongs to a tier. The tiers also govern planned features (see [roadmap.md](roadmap.md)).

| Tier | Contents | Status |
| --- | --- | --- |
| **P0** | Counts, token counters, costs, timestamps, durations, model IDs, tool and skill names, enumerated labels | Returned today |
| **P1** | Pseudonymous keys and identifying metadata: session keys, repository IDs and display names, MCP server names; later keyed hashes (with a per-machine secret) of paths and arguments, file extensions, command classes, commit SHAs | Returned today (keys, repository metadata, MCP server names) |
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
| `mcpContext.repositoryId` | Optional launch-context repository key, or null outside a repository; requested internally by the MCP worker, never a path | P1 |

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
| `mcpEvidence` | Optional structured outcome/quota counters from the streaming parser; see [MCP fields](#mcp-fields) | P0 |
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

### Health endpoint

`GET /api/health` returns `{ service: "session-analytics", snapshot: "ready" | "building" | "not-started", status: "ok" }`. All fields are P0.

### Browser storage

The dashboard stores two values in `localStorage`: the selected view (`session-analytics-view`) and the theme (`session-analytics-theme`). Nothing else is persisted.

### MCP fields

The following additive fields are declared in `src/mcp/types.ts` and re-exported by `src/types.ts`. Their formulas and missing-evidence semantics are in [MCP query semantics](metrics.md#mcp-query-semantics). All text descriptions, status strings, warnings and protocol errors below are fixed or enumerated unless explicitly identified as a bounded metadata name.

#### Session evidence (`McpSessionEvidence`)

These fields also appear in the existing JSON/API session projection when supported; the collector never returns its raw join IDs.

| Field under `mcpEvidence` | Meaning | Tier |
| --- | --- | --- |
| `toolOutcomes[].tool` | Bounded tool name from structured invocation/completion evidence | P0 |
| `toolOutcomes[].observedResults` | Distinct matched structured outcomes | P0 |
| `toolOutcomes[].errors` | Outcomes with an explicit error flag/failure status | P0 |
| `rateLimits[].windowMinutes` | Provider quota window, 300 or 10080 minutes | P0 |
| `rateLimits[].usedPercent` | Recorded numeric utilization, 0–100 | P0 |
| `rateLimits[].observedAt` | ISO observation timestamp | P0 |
| `rateLimits[].resetsAt` | ISO provider reset timestamp | P0 |
| `truncated` | Collector hit its bounded local ID capacity | P0 |

#### Common tool envelope (`McpPayload`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `schemaVersion` | MCP payload schema, currently 1 | P0 |
| `tool` | One of seven published tool names | P0 |
| `snapshot.generatedAt` | ISO snapshot generation time | P0 |
| `snapshot.ageSeconds` | Nonnegative age at query time | P0 |
| `snapshot.ttlSeconds` | Configured in-memory cache TTL | P0 |
| `scope.kind` | `repository` or `machine` | P0 |
| `scope.repositoryId` | Pseudonymous repository key or null | P1 |
| `window.name` | Enumerated window | P0 |
| `window.since`, `window.until` | ISO query bounds; lower bound null for all history | P0 |
| `window.timezone` | Always `UTC` | P0 |
| `window.basis` | `session-start` or `activity-day` | P0 |
| `totals` | Selected cohort totals below | P0 |
| `notes[]` | Fixed interpretation/coverage notes | P0 |
| `data` | One tool-specific projection listed below | P0/P1 |

#### Reused totals, values, ratios and distributions

| Field | Meaning | Tier |
| --- | --- | --- |
| `McpTotals.sessions`, `.analyzedSessions`, `.workingSnapshots` | Selected, analyzed and working counts | P0 |
| `McpTotals.inputTokens`, `.outputTokens` | Observed token sums; null for unattributed Cursor model groups | P0 |
| `McpTotals.userTurns`, `.toolCalls` | Session counter sums; null for model groups | P0 |
| `McpTotals.value` | Separated value/coverage object | P0 |
| `McpValue.apiEquivalentUsd`, `.apiUpperEstimateUsd` | API-basis value and upper estimate | P0 |
| `McpValue.providerReportedUsd` | Provider-reported local value, separate basis | P0 |
| `McpValue.pricingCoverage` | Ratio object for priced/API-eligible tokens | P0 |
| `McpValue.unpricedTokens` | API-eligible tokens without a rate | P0 |
| `McpRatio.value` | Fraction or compactions per session; null when unavailable/too small | P0 |
| `McpRatio.numerator`, `.denominator`, `.minimumDenominator` | Observed operands and sample guard | P0 |
| `McpRatio.status` | `available`, `insufficient-data`, `unavailable` | P0 |
| `McpDistribution.median`, `.p90` | Median/nearest-rank 90th percentile, or null below the sample guard | P0 |
| `McpDistribution.samples`, `.selectedSessions`, `.excludedSessions`, `.minimumSamples` | Measurement sample count, selection denominator, exclusions, guard | P0 |

#### Tool-specific data

| Field under `data` | Meaning | Tier |
| --- | --- | --- |
| `usage_summary`: `groupBy` | Repository/provider/model/agent execution-kind dimension | P0 |
| `groups[].key` | Repository hash (P1), or provider/model/execution-kind identifier (P0) | P0/P1 |
| `groups[].totals`, `totalGroups`, `nextOffset` | Per-group totals, full group count and next page/null | P0 |
| `repo_profile`: `sessions` | Selected repository session count | P0 |
| `apiEquivalentUsd`, `providerReportedUsd`, `userTurns`, `durationMilliseconds` | Distribution objects on the named bases | P0 |
| `cacheHitRate`, `compactionsPerSession` | Ratios with supported-provider denominators | P0 |
| `toolMix[].name`, `skills[].name` | Bounded metadata names | P0 |
| `toolMix[].calls`, `skills[].calls`, `omittedTools`, `omittedSkills` | Observed counts and names beyond the list cap | P0 |
| `skillEvidence[].provider`, `.evidence`, `.sessions` | Provider, explicit/inferred/unavailable method, selected count | P0 |
| `compare_agents`: `agents[].provider`, `.totals`, `.profile` | Fixed provider enum and the same totals/profile objects | P0 |
| `tool_stats`: `tools[].name`, `.calls`, `.observedResults`, `.errors` | Bounded tool name and observed counts | P0 |
| `tools[].errorRate`, `.resultCoverage`, `totalTools`, `nextOffset` | Result-based ratios, full tool count and next page/null | P0 |
| `recent_sessions`: `sessions[].sessionKey`, `.repositoryId` | Existing pseudonymous session/repository keys | P1 |
| `sessions[].provider`, `.executionKind`, `.workingSnapshot` | Fixed provider/execution enums and snapshot flag | P0 |
| `sessions[].startedAt`, `.lastEventAt`, `.durationMilliseconds` | Validated timestamps/duration or null | P0 |
| `sessions[].models`, `.omittedModels`, `.value` | Bounded model identifiers, excess-model count and separated value object | P0 |
| `totalSessions`, `nextOffset` | Full selected session count and next page/null | P0 |
| `budget_status`: `today`, `week` | UTC activity-day period objects | P0 |
| `today/week.since`, `.until`, `.apiEquivalentUsd` | Period bounds and dated API value | P0 |
| `today/week.datedSessions`, `.undatedSessions` | API sessions with a dated entry in-period; all scoped sessions without a daily ledger | P0 |
| `today/week.excludedProviderReportedUsd` | All-history scoped reported value excluded because timing is unavailable | P0 |
| `today/week.elapsedHours`, `.apiEquivalentUsdPerHour` | UTC wall-hour denominator and guarded historical burn rate/null | P0 |
| `rateLimits[].provider`, `.status` | Provider and available/unavailable evidence status | P0 |
| `rateLimits[].windows[]` | The same four numeric/timestamp quota fields as session evidence, plus `remainingPercent` | P0 |
| `unused_extensions`: `inventoryScope` | Always `launch-context` | P0 |
| `providers[].provider`, `.inventoryCoverage`, `.skillEvidence` | Provider, always-partial inventory, explicit/inferred/unavailable invocation method | P0 |
| `providers[].sourcesRead`, `.unreadableSources`, `.truncated` | Readable/unreadable source counts and cap flag; no paths/errors | P0 |
| `providers[].installedSkills`, `.configuredMcpServers` | Distinct bounded-name counts | P0 |
| `providers[].skillsWithoutObservedUse[]` | Installed skill names without invocation evidence in the selected scope/window | P0 |
| `providers[].serversWithoutObservedUse[]` | Configured MCP server names without observed use | P1 |
| `providers[].omittedSkills`, `.omittedServers` | Names beyond the response cap | P0 |

#### Worker inventory and protocol wrapper

The MCP worker returns `{analytics, inventory}` to its parent over an anonymous pipe. `analytics` is the allowlisted machine snapshot above. Each `inventory[]` contains only `provider`, `skills[]`, `mcpServers[]`, `sourcesRead`, `unreadableSources`, and `truncated`; server names are P1, all other inventory fields P0. Skill definitions, config values, URLs, environment values and commands are discarded inside the worker. This inventory is in memory only, never persisted, and bounded to 512 names per list.

The MCP wrapper contains standard JSON-RPC `jsonrpc`, caller-chosen `id` (protocol correlation only), `result` or `error`; errors use fixed `code`/`message` and, for unsupported versions, `data.supported`/`requested` protocol dates. Tool results contain `isError`, `content[].type`/`.text` (a fixed-template summary and serialized `McpPayload`), and `structuredContent` (the same payload). Modern results add `resultType` and `_meta.io.modelcontextprotocol/serverInfo`. Discovery/initialization contain only static product/version identifiers, protocol versions, tool capability declarations, instructions and catalog cache hints (`ttlMs`, `cacheScope`). `tools/list` returns static names/descriptions, JSON input schemas and read-only/idempotent/closed-world annotations. These are P0 and carry no local-history identifiers; caller request IDs are echoed as required by JSON-RPC, never used to query history.

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
