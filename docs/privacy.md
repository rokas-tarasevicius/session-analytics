# Privacy contract

`session-analytics` reads coding-agent transcripts that already exist on your machine. Those transcripts contain everything you and your agents have written: prompts, responses, reasoning, commands, file paths, diffs, and tool output. This document defines exactly what the tool may return from them, how that boundary is enforced, and what it does not protect against.

The contract applies to every output surface: the dashboard and its `/api/analytics` endpoint, the terminal report, the JSON snapshot (`report --json`), and the agent skill, which only runs those commands.

## The contract

**Returned:** allowlisted counters and identifiers only.

- Token counters by class, cost figures, counts of events, durations, and ISO timestamps.
- Model IDs and reasoning-effort labels as the provider recorded them.
- Tool names, and skill identifiers that match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
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

- **Allowlist projection.** Parsers accumulate counters into an internal session state. `finalizeSession` in `src/analyzer.ts` and the projections in `src/providers/` build public objects field by field. Raw provider records are never spread into an output, so a new field in a provider's format cannot reach an output without a code change.
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
| `apiEquivalentSpendUsd` | Sum of API list-price-equivalent session values across sources with reviewed rates | P0 |
| `cacheReadRatio` | Cache-read tokens divided by uncached input plus cache reads plus cache writes; `0` with no input | P0 |
| `compactions` | Sum of session compactions | P0 |
| `estimatedSpendUsd` | Priced usage value: API-equivalent plus provider-reported | P0 |
| `estimatedUpperSpendUsd` | Sum of session upper estimates | P0 |
| `missingTranscripts` | Sessions whose transcript is missing | P0 |
| `outputTokens` | Sum of output tokens | P0 |
| `pricedTokenCoverage` | Token-weighted share of observed tokens with a known rate; `null` when not applicable | P0 |
| `providerReportedSpendUsd` | Sum of provider-reported session values (Cursor composer database and Conductor SDK results) | P0 |
| `sessions` | Session count | P0 |
| `subagentSessions` | Sessions with sub-agent or mixed execution | P0 |
| `subagentSpendUsd` | Value attributed to sub-agent execution | P0 |
| `topLevelSessions` | Sessions with top-level or mixed execution | P0 |
| `topLevelSpendUsd` | Value attributed to top-level execution | P0 |
| `toolCalls` | Sum of effective tool calls | P0 |
| `totalInputTokens` | Sum of processed input tokens, including cache reads and writes | P0 |
| `unpricedSessions` | Sessions with observed tokens and incomplete API rate coverage; excludes activity-only and reported-value sources with N/A coverage | P0 |
| `repositories` | Machine summary only: repositories in scope | P0 |
| `repositoriesWithSessions` | Machine summary only: repositories with at least one session | P0 |
| `workingSnapshots` | Machine summary only: sessions that were still running when scanned | P0 |

### Session (`SessionAnalytics`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `sessionKey` | First 12 hex characters of SHA-256 of `<provider>:<session ID>` (or of the Conductor session ID for Conductor-registered sessions). It is not keyed with a secret, so it is stable across runs; someone who already holds the raw ID can recompute it, but the key does not reveal the ID | P1 |
| `provider` | `claude`, `codex`, `cursor`, `copilot`, `opencode`, or `gemini` | P0 |
| `repositoryId` | Repository key, as in `repository.id` | P1 |
| `repositoryName` | Repository display name, as in `repository.name` | P1 |
| `status` | Validated session status label (`unknown`, `working`, `idle`, `completed`, `failed`, `cancelled`, `archived`, `queued`, `running`) | P0 |
| `createdAt` | Provider session start time; file modification time only when `evidence.timing` is `file-mtime` | P0 |
| `updatedAt` | Recorded session update/end time when available; otherwise the session start time. File modification time for `file-mtime` evidence | P0 |
| `firstEventAt` | Earliest event timestamp in the evidence, or `null` | P0 |
| `lastEventAt` | Latest event timestamp in the evidence, or `null` | P0 |
| `effort` | Validated reasoning-effort enum (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `auto`, `unknown`), or `null` | P0 |
| `executionKind` | `top-level`, `subagent`, `mixed`, or `unknown` | P0 |
| `costBasis` | `api-list-price-equivalent`, `provider-reported`, or `unavailable` | P0 |
| `costComplete` | For added sources: all owned observed tokens priced, or supported Conductor accounting intervals with cost for every selected snapshot. Partial accounting forces false. Activity-only evidence is incomplete; this field never proves complete historical retention | P0 |
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
| `skillEvidence` | `explicit` (native Claude), `inferred` (native Codex lower bound), or `unavailable` | P0 |
| `metrics` | Execution counters; see [Session metrics](#session-metrics-sessionmetrics) | P0 |
| `transcript.files` | Number of evidence files read for the session (main transcript plus sub-agent files) | P0 |
| `transcript.status` | `ok`, `missing`, `invalid`, or `unsupported` | P0 |
| `transcript.snapshotWhileWorking` | `true` when the session was still running at scan time | P0 |
| `transcript.warnings[]` | Fixed-text parser notes, which may include counts and model IDs | P0 |
| `evidence` | Optional source fidelity and availability; absent on the original native-provider projections | P0 |
| `evidence.accounting` | Optional `complete` or `partial` for retained accounting; no promise of complete historical retention | P0 |
| `evidence.source` | `conductor-result`, `cursor-sdk`, `cursor-transcript`, `copilot-events`, `opencode-db`, or `gemini-chat` | P0 |
| `evidence.fidelity` | `message`, `summary`, or `activity-only`; describes the retained source, not task quality | P0 |
| `evidence.tokens` | `reported` or `unavailable`; distinguishes observed counters (including recorded zero) from missing evidence | P0 |
| `evidence.tools` | `observed` or `unavailable` | P0 |
| `evidence.turns` | `observed` or `unavailable`; SDK runs count as observed run turns, Conductor loop-turn summaries do not become human turns | P0 |
| `evidence.timing` | `provider` or `file-mtime`; file dates cannot establish start time, duration, or active hours | P0 |
| `evidence.usageUnit` | `request`, `run`, `session`, or `unavailable`; identifies the granularity of token evidence | P0 |
| `conductor` | Optional result-only SDK counters, populated only for Conductor fallback sessions | P0 |
| `conductor.turnLocalTokens` | Deduplicated turn-local receipt counters in the nine-field `TokenUsage` shape below; separate from cumulative session/model totals; null if no usage counters are recorded | P0 |
| `conductor.turnLocalTokens.inputTokens` | Same inputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.uncachedInputTokens` | Same uncachedInputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.cachedInputTokens` | Same cachedInputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.cacheWriteInputTokens` | Same cacheWriteInputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.cacheWrite5mInputTokens` | Same cacheWrite5mInputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.cacheWrite1hInputTokens` | Same cacheWrite1hInputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.outputTokens` | Same outputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.reasoningOutputTokens` | Same reasoningOutputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.nonReasoningOutputTokens` | Same nonReasoningOutputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.resultRecords` | Distinct retained terminal SDK result records after UUID/message-ID deduplication | P0 |
| `conductor.reportedTurns` | A single receipt's SDK `num_turns`; null when absent or multiple receipts; not human turns | P0 |
| `conductor.durationMilliseconds` | A single receipt's `duration_ms`; null when absent or multiple receipts; distinct from the session wall span | P0 |
| `conductor.apiDurationMilliseconds` | A single receipt's `duration_api_ms`; null when absent or multiple receipts | P0 |
| `conductor.permissionDenials` | A single receipt's denial-array length; null when absent or multiple receipts; no denial objects escape | P0 |
| `conductor.errorResults` | Count of results with `is_error === true`; not a task-failure verdict | P0 |
| `conductor.terminalReasons` | Counts keyed only by `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`, `completed`, `cancelled`, `interrupted`, or `unknown`; all other values map to `unknown` | P0 |

Structured metadata is validated before aggregation and warning construction. Model IDs use a separate bounded grammar that preserves namespaces (including `org/model` and `@cf/vendor/model`) and exact rate keys, while rejecting filesystem, URL, whitespace/control, and credential shapes. Tool/skill identifiers exclude prototype keys. Rejected model/tool values become fixed unknown labels; timestamps must parse as bounded ISO date-time forms. Private correlation IDs and ownership fingerprints remain inside the worker.

### Session metrics (`SessionMetrics`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `userTurns` | Human turns (tool results are not turns); Cursor SDK counts started runs as observed run turns. Zero is a placeholder when `evidence.turns` is unavailable | P0 |
| `assistantMessages` | Distinct assistant messages or agent messages | P0 |
| `modelCalls` | Priced or unpriced model requests with positive usage; zero placeholders for summary/activity sources with unavailable request counts (see `evidence.usageUnit`) | P0 |
| `toolCalls` | Effective tool calls | P0 |
| `transportToolCalls` | Tool calls before code-mode expansion | P0 |
| `compactions` | Context compaction boundaries | P0 |
| `summaries` | Summary boundaries (Claude) | P0 |
| `taskStarts` | Task-start markers (Codex), started SDK runs (Cursor), or assistant-turn starts (Copilot) | P0 |
| `taskCompletions` | Task-complete markers (Codex), finished SDK runs (Cursor), or assistant-turn ends (Copilot); not proof of task success | P0 |
| `queueOperations` | Queued-input operations (Claude) | P0 |
| `delegatedAgents` | Distinct delegated agents observed (Claude) | P0 |
| `durationMilliseconds` | Legacy session start to last event; added sources use recorded start/end metadata. Zero is an unavailable placeholder for `file-mtime` evidence | P0 |
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
| `cacheWriteInputTokens` | Cache-write input where the source records it | P0 |
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
| `totalUsd` | Sum of the components, or the reported total for Cursor composer/Conductor evidence (without an invented component allocation) | P0 |
| `upperEstimateUsd` | Total plus configured uncertainty: unobservable cache writes, and for added adapters aggregate context premiums or unknown write TTL | P0 |

### Model usage (`ModelUsage`)

Appears in `session.models[]` and every `spendByModel[]`. Includes every `TokenUsage` and `CostBreakdown` field, plus:

| Field | Meaning | Tier |
| --- | --- | --- |
| `model` | Model ID as recorded by the provider (`<unknown>` when none was recorded) | P0 |
| `calls` | Requests attributed to this model; zero when aggregate source evidence cannot establish request counts | P0 |
| `priced` | `true` when the rate card has an exact entry, or a model-specific reported USD allocation is present | P0 |

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
