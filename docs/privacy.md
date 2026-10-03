# Privacy contract

`session-analytics` reads coding-agent transcripts that already exist on your machine. Those transcripts contain everything you and your agents have written: prompts, responses, reasoning, commands, file paths, diffs, and tool output. This document defines exactly what the tool may return from them, how that boundary is enforced, and what it does not protect against.

The content-free contract covers dashboard/API, reports, pricing commands, insights, MCP, exports/sharing, the agent skill and the persisted index. `index path` deliberately prints only the index location for local management. The separate P3 review exception requires an explicit per-run `--send-content`; analytics never invoke it.

## The contract

**Returned:** allowlisted counters and metadata only.

- Token/cost/event counters, durations, timestamps, bounded model IDs and enumerated effort/status labels.
- Bounded tool, skill and MCP-server names; registry-verified slash-command names, never arguments or unknown command text.
- Repository display names and stable repository keys; 12-hex provider-qualified session hashes, hashed outcome references, pseudonymous profile keys and explicit plan labels.
- Numeric CLI versions, fixed entrypoint/originator enums, configured monthly plan amounts and allowlisted quota/plan states.
- Fixed warning text with approved counts/model identifiers; public price sources, dates, payload hashes, rates and provenance enums.

**Never returned:**

- prompts, user messages, assistant messages, or reasoning text;
- tool arguments, tool results, commands, diffs, or patch content;
- file paths, transcript paths, working directories, repository roots, or Git remotes;
- raw session, provider, workspace, or message IDs;
- session titles, branch names, or workspace names;
- credentials, environment variables, or process arguments;
- raw local error messages or stack traces.

## How it is enforced

- **Explicit projections.** Native parsers and provider adapters build public objects from declared fields. Raw records and internal correlation types never cross the worker boundary. Snapshot schemas reject unknown nested fields; the index recursively selects that same schema before writing and after reading.
- **One model policy.** `src/public/model-id.js` (also re-exported by `src/public-model.ts`) bounds IDs to 160 characters and up to three validated namespace components. Filesystem roots, paths with traversal, URLs, whitespace, file suffixes, credential patterns and recognizable raw identifiers are rejected as `<unknown>`. Eligible counters remain visible. A syntactically valid name is still identifying metadata, not proof of safe provenance.
- **Bounded names and enums.** Tools/skills/MCP names use the public grammar; Codex code-mode tool names are extracted as identifiers only. Status/error/warning fields use enums or fixed templates, never raw local errors.
- **Sentinel coverage.** Synthetic tests plant content, credentials, paths, IDs and commands in provider records. Analyzer, API, schemas, cache replay, reports, exports, MCP and rendering tests reject those strings at their output boundaries.
- **Fixed failures.** Worker stderr is discarded. The only index errors crossing the worker are allowlisted codes/messages; all other analysis failures are generic. Raw fetch errors and agent CLI output are not returned.
- **Read-only provider access.** Transcripts are streamed and provider SQLite stores opened read-only. The separate private data directory contains derived index facts, public price history, preferences/configuration and opt-in secrets; provider directories are untouched.
- **Explicit network boundaries.** Analysis reads cached prices; dashboard startup can refresh fixed public price feeds without local metadata, credentials or redirects. `--offline` disables pricing requests. `--outcomes-github` permits authenticated PR-coordinate lookups; `export --otlp-endpoint` permits selected content-free export delivery; `review --send-content` permits bounded P3 prose for that run. These options are independent. There is no telemetry. The loopback dashboard uses same-origin CSP, bundled fonts and marks.
- **MCP boundary.** Tools accept no paths, commands, URLs, SQL or client roots. Trusted source paths are launch settings. Only projected metrics and names-only inventory enter responses; configured MCP commands are never executed and servers are never contacted.

Raw transcript content is not persisted or logged. Bounded parsing collectors may hold current request/receipt evidence in memory until reconciliation. Reliability correlation retains only internal HMACs/counters; output/result text never enters the public projection. Outcome enrichment keeps private branch/PR coordinates only for bounded local correlation and explicitly enabled lookups. Public pricing caches contain normalized rates, not raw feed bodies or local inventories.

## Local index

The default content-free index lives in `~/Library/Application Support/session-analytics/` on macOS and `$XDG_DATA_HOME/session-analytics/` (fallback `~/.local/share/session-analytics/`) on Linux. `SESSION_ANALYTICS_DATA_DIR` / `--data-dir` overrides it. Only the private analytics data directory is writable; provider stores remain read-only. Use `--no-index` or `SESSION_ANALYTICS_NO_INDEX=1` to bypass every index read/write and analyze only currently present evidence.

The directory is mode `0700`. `index.sqlite`, WAL/SHM/journal files, the SQLite writer-coordination file, transient filesystem writer tickets, and a 32-byte random `index.key` are mode `0600`. Symbolic links, hard-linked files, and foreign ownership are rejected. These permissions and the key protect against other accounts; this is not encryption and does not protect against a process running as your user.

The following is the complete disk field manifest. Keys and fingerprints use HMAC-SHA-256 with `index.key`, which is never exported. A domain-separated verification MAC binds the database, all scopes, and pruning reservations to that key before scope selection. Legacy migration authenticates existing payloads first; it refuses unverifiable keyed-only state. Rebuild preserves a usable key; deleting or replacing the key does not make an existing database safe to reuse. Integrity MACs detect unintended changes but are not protection from an attacker who can read the key.

| Stored data | Contents | Tier |
| --- | --- | --- |
| `sessions.payload` | The complete schema-allowlisted `SessionAnalytics` projection below, including metric namespaces and pricing provenance; no raw provider rows | P0/P1/P2 when enabled |
| `scope`, `identity_key`, `source_keys`, `root_key`, `remote_key`, `signature` | Keyed hashes of source configuration, provider-qualified identity, paths, roots/remotes, and parser/rate/metadata dependencies | P1 |
| `payload_mac`, `ledger_mac` | Keyed payload integrity digests | P1 |
| `source_deleted`, `last_event_at`, `retention_verified` | Deletion state, normalized last activity, and whether a current parser verified the retention date; unverifiable legacy dates cannot justify pruning | P0 |
| `exclusions` | Only keyed scope, identity, signature, and source keys for pruned groups; no removed session payload or usage totals | P1 |
| `evidence.source_key` | Keyed absolute-path identity; the path is never stored | P1 |
| `evidence.fingerprint.device`, `.inode` | Filesystem identity numbers encoded losslessly as strings | P1 |
| `evidence.fingerprint.size`, `.mtime`, `.ctime` | Byte count and nanosecond modification/change times | P0 |
| `evidence.fingerprint.head`, `.tail` | Keyed first/last 4 KiB digests; bytes are discarded | P1 |
| `evidence.ledger.observations[]` | Numeric total/last counter fingerprint, activity gap (`null` for unknown), timestamp | P0 |
| `evidence.ledger.unownedFingerprints[]` | Numeric total/last fingerprints with no event timestamp, used to connect ownership dependencies | P0 |
| `evidence.ledger.models`, `.lastLocalActivityTimestamp`, `.bytes`, `.newlineTerminated`, `.unownedCounters` | Model IDs, continuation timestamp/byte offset, and boolean checkpoint guards | P0 |
| `evidence.ledger.prefixHash` | Keyed digest of the complete old prefix; no transcript bytes | P1 |
| `sessions.owned_counters` | Attributed numeric counter fingerprints, timestamps, and fallback model IDs, for deleted-owner reservations | P0 |
| `retired_counters.counter_key` | Keyed counter-membership reservations kept after pruning, without usage values or timestamps, solely to prevent rebilling | P1 |
| `metadata` | Keyed parser/rate revision, domain-separated key-verification MAC, and the UTC retention floor; no source configuration in plaintext | P0/P1 |
| `scans` | Keyed source scope, completion time, and counters/timing from the status manifest below | P0/P1 |
| `index.key` | Private random HMAC key, never part of output | Private key |
| SQLite metadata / `writer.sqlite` | Schema version, transaction metadata, and local writer coordination; no transcript data | P0 |
| `writer-ticket-*` / `.next` | Transient process ID, random nonce, and numeric mutex order; no provider data, paths, or session IDs; removed on release or dead-process recovery | P0 |

The index retains previously observed history after provider deletion. `index prune --before YYYY-MM-DD` removes old verified session facts, clears reusable evidence, vacuums the active database, and keeps a retention floor, minimal keyed exclusion checkpoints, and keyed anti-rebilling reservations. Subsequent scans may rebuild ledger evidence from surviving provider files; unchanged exclusion checkpoints skip session parsing without restoring session facts. The cutoff is exclusive UTC midnight; provider files are untouched. Unverified legacy dates are kept until the source can be reparsed. Rebuild discards retained history and resets the floor. Corruption recovery places unreadable main or writer databases in private `.rebuild-*` quarantine files, which are excluded from analysis, status, and prune; remove those separately when no longer needed. Retention is of derived facts, never a raw transcript archive. P2 settings partition indexed history, so disabling rules cannot replay earlier rule-derived facts. Deleted-source facts from a different P2 setting are unavailable in that scope. No P3 content is indexed.

## Privacy tiers

| Tier | Contents | Status |
| --- | --- | --- |
| **P0** | Counters, costs, dates, durations, bounded model/tool names and enumerated labels | Returned by default |
| **P1** | Pseudonymous session/repository/profile/outcome keys, display names, MCP/command/skill inventory names and timezone | Returned with explicit field coverage; private path/argument digests and keys are never public |
| **P2** | Fixed rule IDs/classes and counts derived from local content | Reliability and Workflow rules, plus optional Git trailer classification; opt-in, off by default |
| **P3** | Bounded redacted human/assistant prose sent through the user's agent CLI | Explicit `review --send-content` per run; never stored in the index or returned through analytics APIs |

`--reliability-content-rules` / `SESSION_ANALYTICS_RELIABILITY_CONTENT_RULES=1` enables local reliability rules. `--no-reliability-content-rules` overrides the opt-in. Structured outcomes, durations and permission/hook enums remain P0/P1. When rules need correlation, a private 32-byte `reliability-hmac.key` (0600) is created atomically under `--data-dir` / `SESSION_ANALYTICS_DATA_DIR`; symlinks, malformed keys and unsafe ownership/modes are refused. Neither keys nor argument/path digests enter snapshots. Default scans do not create that key.

`--workflow-content-rules` / `SESSION_ANALYTICS_WORKFLOW_CONTENT_RULES=1` enables two exact Claude interruption-marker rules; `--no-workflow-content-rules` overrides it. Only marker counts and labeled timing coverage leave the parser, never matched text. Disabling P2 selects an independent index scope. `--outcomes-git` permits bounded local Git enrichment including co-author classification; `--outcomes-github` separately permits network queries.

### P3 review exception

`review --session KEY --via claude|codex` defaults to a metadata-only dry-run: rule IDs, sizes and redaction counts, no displayed prose and no CLI invocation. Only an explicit `--send-content` flag permits that run to send a bounded prompt through the selected CLI on `PATH`. There is no environment-variable equivalent, persistent opt-in, review HTTP endpoint or dashboard send control. Authentication, retention and billing belong to the user's agent provider.

The capped review worker resolves the hashed key through validated analyzer evidence, chooses up to three windows, and omits reasoning and tool argument/result blocks. It redacts common credential, URL, email, path, ID and code forms and known local identifiers; **remaining prose is P3 and may still be identifying or sensitive**. Regex redaction does not guarantee anonymization. It is capped to 12 excerpts × 1,000 characters and a 60 KB prompt. Paths and raw source IDs never cross the worker output boundary. Only allowlisted assessment enums are returned; arbitrary agent stdout/stderr is discarded. Default analytics remain content-free. [Full behavior and limitations](insights.md#opt-in-review-p3).

## Field manifest

**Research proposals:** [schema-v2.md](proposals/schema-v2.md) contains a separate, proposed event-field manifest, and [metrics-research.md](proposals/metrics-research.md) describes its intended measurements. Neither adds fields to the public snapshot listed below. The accompanying research audit retains aggregate counts/distributions and reviewed tool names only; it does not publish raw local records, paths or identifiers. Future implementation still requires the field-by-field projection, sentinel tests and P2/P3 opt-ins described here.

This manifest lists every field in the public snapshot. It is generated from the types in [`src/types.ts`](../src/types.ts); a change to those types must update this table in the same pull request. Metric semantics are defined in [metrics.md](metrics.md).

The [product strategy proposal](proposals/product-strategy.md) adds **no public fields** and changes no privacy tier or runtime behavior. Its [feature portfolio](proposals/feature-portfolio.md) assigns proposed processing tiers, and its [metric contracts](proposals/metric-contracts.md) require a separate types/manifest/sentinel update before implementation. Future names in those proposals are not part of this manifest. Repository names, precise timestamps and current unkeyed hashes remain identifying metadata; proposed team/export controls are not protections available today.

### Snapshot root (`MachineAnalytics`)

Returned by `/api/analytics` and `report --json`.

| Field | Meaning | Tier |
| --- | --- | --- |
| `schemaVersion` | Snapshot interchange version, currently `1` (also present in single-repository results) | P0 |
| `generatedAt` | ISO time the snapshot was computed | P0 |
| `velocity.version` | Optional velocity payload version; currently `1` (also on single-repository analysis results) | P0 |
| `velocity.timeZone` | IANA timezone used to bucket activity; analysis process local zone, including `TZ` override | P1 |
| `rateCard.currency` | Always `USD` | P0 |
| `rateCard.effectiveDate` | Effective date of the rate card used | P0 |
| `rateCard.models[].model` | Model ID with a currently resolved rate | P0 |
| `rateCard.models[].source` | Public URL of the selected rate source | P0 |
| `rateCard.models[].provenance` | Current rate evidence; see Pricing provenance below | P0 |
| `rateCard.pricing` | Cache freshness/configuration; see Pricing status below | P0 |
| `repositories[]` | One rollup per repository; see [Repository rollup](#repository-rollup-repositoryrollup) | P0/P1 |
| `sessions[]` | Every analyzed session; see [Session](#session-sessionanalytics) | P0/P1 |
| `spendByDay[]` | `{ name: "YYYY-MM-DD", value: USD }`, priced usage by UTC day | P0 |
| `spendByModel[]` | Model usage across all sessions; see [Model usage](#model-usage-modelusage) | P0 |
| `summary` | Machine totals; see [Summary](#summary) | P0 |
| `topTools[]` | `{ name, value }`, effective tool calls by tool name, descending | P0 |
| `warnings[]` | Fixed-text coverage notes (unpriced models, missing or unmatched transcripts, unreadable roots) | P0 |
| `limitsCache` | Optional quota/profile and subscription namespace, also present on the single-repository result; see [Limits and cache](#limits-and-cache) | P0/P1 |
| `outcomes` | Optional outcome summary; fields defined below | P0 |
| `workflow` | Optional workflow aggregate; also present on the single-repository analysis result. See the workflow manifest below | P0/P1/P2 |
| `mcpContext.repositoryId` | Optional launch-context repository key, or null outside a repository; requested internally by the MCP worker, never a path | P1 |
| `mcpSourceHealth[].provider`, `.status` | Provider and available/incomplete/unavailable discovery enum, independent of sessions | P0 |
| `mcpSourceHealth[].sourcesRead`, `.missingSources`, `.unreadableSources` | Discovery source counts; no paths or error text | P0 |

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
| `outcomes` | Optional outcome summary; also present on single-repository results | P0 |

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
| `unpricedSessions` | Sessions with observed tokens and estimated or unavailable token-class rates; excludes activity-only and reported-value sources with N/A coverage | P0 |
| `repositories` | Machine summary only: repositories in scope | P0 |
| `repositoriesWithSessions` | Machine summary only: repositories with at least one session | P0 |
| `workingSnapshots` | Machine summary only: working observations with present sources; source-deleted or unavailable historical observations are excluded | P0 |

### Session (`SessionAnalytics`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `agentIdentity.claudeEntrypoint` | Optional fixed enum: `cli`, `sdk`, `desktop`, `unknown` | P0 |
| `agentIdentity.claudeSubagentType` | Optional observed subtype: `general-purpose`, `explore`, `plan`, `other`, or `mixed` for a composite session | P0 |
| `agentIdentity.codexSource` | Optional initial source enum: `cli`, `exec`, `vscode`, `subagent`, `review`, `unknown` | P0 |
| `agentIdentity.codexOriginator` | Optional initial originator enum: `cli`, `exec`, `vscode`, `desktop`, `unknown`; arbitrary originator text is excluded | P0 |
| `velocity` | Optional compact, content-free local-time activity cells; see [Velocity cells](#velocity-cells-sessionvelocity) | P0 |
| `sessionKey` | First 12 hex characters of SHA-256 of `<provider>:<session ID>` (or of the Conductor session ID for Conductor-registered sessions). It is not keyed with a secret, so it is stable across runs; someone who already holds the raw ID can recompute it, but the key does not reveal the ID | P1 |
| `provider` | `claude`, `codex`, `cursor`, `copilot`, `opencode`, or `gemini` | P0 |
| `repositoryId` | Repository key, as in `repository.id` | P1 |
| `repositoryName` | Repository display name, as in `repository.name` | P1 |
| `status` | Validated session status label (`unknown`, `working`, `idle`, `completed`, `failed`, `cancelled`, `archived`, `queued`, `running`) | P0 |
| `createdAt` | Provider session start time; file modification time only when `evidence.timing` is `file-mtime` | P0 |
| `updatedAt` | Recorded session update/end time when available; otherwise the session start time. File modification time for `file-mtime` evidence | P0 |
| `status` | Session status label: Conductor's status when registered there, Cursor's composer status, otherwise `idle` | P0 |
| `createdAt` | Session start time | P0 |
| `provider` | `claude`, `codex`, `cursor`, or the fixed `unsupported` fallback for unknown agents (raw agent names are omitted) | P0 |
| `repositoryId` | Repository key, as in `repository.id` | P1 |
| `repositoryName` | Repository display name, as in `repository.name` | P1 |
| `status` | Fixed label: `idle`, `working`, `completed`, `failed`, `error`, `interrupted`, `cancelled`, `pending`, or `unknown`; unrecognized source text becomes `unknown` | P0 |
| `createdAt` | Session start as UTC ISO with milliseconds; offset-free source/database timestamps mean UTC | P0 |
| `updatedAt` | Conductor's or Cursor's last-updated time when available; otherwise the session start time | P0 |
| `workflow` | Optional primary-transcript workflow projection; absent for unsupported/failed parses. See below | P0/P1/P2 |
| `mcpEvidence` | Optional structured outcome/quota counters from the streaming parser; see [MCP fields](#mcp-fields) | P0 |
| `firstEventAt` | Earliest event timestamp in the evidence, or `null` | P0 |
| `lastEventAt` | Latest event timestamp in the evidence, or `null` | P0 |
| `effort` | Validated reasoning-effort enum (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `auto`, `unknown`), or `null` | P0 |
| `firstEventAt` | Earliest valid event instant, normalized to UTC, or `null` | P0 |
| `lastEventAt` | Latest valid event instant, normalized to UTC, or `null` | P0 |
| `effort` | Reasoning-effort label as recorded, or `null` | P0 |
| `executionKind` | `top-level`, `subagent`, `mixed`, or `unknown` | P0 |
| `costBasis` | `api-list-price-equivalent`, `provider-reported`, or `unavailable` | P0 |
| `costComplete` | For added sources: all owned observed token classes explicitly priced, or supported Conductor accounting intervals with cost for every selected snapshot. Partial accounting forces false. Activity-only evidence is incomplete; this field never proves complete historical retention | P0 |
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
| `reliability` | Optional versioned reliability projection; absent for unsupported evidence; see below | P0/P1/P2 |
| `limitsCache` | Optional request cache/context namespace for Claude and Codex; see [Limits and cache](#limits-and-cache). Absent for unsupported evidence | P0/P1 |
| `outcomes` | Optional session outcome evidence; fields defined below | P0/P1/P2 |
| `insightSignals.cacheGaps` | Optional Claude-only counters; see [Cache-gap signals](#cache-gap-signals) | P0 |
| `insightSignals.requestSizes.observedTokens`, `.unknownTokens` | Accounted input-plus-output tokens with known/unknown request input size, after ownership and deduplication | P0 |
| `insightSignals.mcpServers` | Optional map of bounded server name to structured observations: deduplicated Codex MCP items or Claude tool calls carrying explicit server attribution; no arguments/results | P1 names, P0 counts |
| `transcript.files` | Number of evidence files read for the session (main transcript plus sub-agent files) | P0 |
| `transcript.status` | `ok`, `missing`, `invalid`, or `unsupported` | P0 |
| `transcript.snapshotWhileWorking` | `true` for Conductor's explicit `working` status; false does not establish inactivity | P0 |
| `transcript.completeness` | Optional `complete`, `partial`, `unknown`: parse/file-version completeness of observed evidence, not lifetime retention | P0 |
| `transcript.liveness` | Optional `active`, `inactive`, `unknown`: observed lifecycle/Conductor state; see [evidence rules](insights.md#rules-and-formulas) | P0 |
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
| `transcript.snapshotWhileWorking` | `true` when the session was marked working at its last source observation; a retained observation does not establish current activity | P0 |
| `transcript.warnings[]` | Fixed-text parser notes, which may include counts and model IDs | P0 |
| `transcript.sourceDeleted` | Optional `true`: these are last-ingested facts whose source was removed; absent for current evidence and `--no-index` output. Prices/parser results are frozen at last ingest | P0 |
| `transcript.startTimeKnown` | Optional false when the displayed creation date cannot establish a session start; bounded start-date filters exclude it | P0 |

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
| `maxContextWindow` | Largest observed Codex window or reviewed Claude model capacity | P0 |
| `maxInputTokensPerCall` | Largest input of a single request | P0 |
| `contextUtilizationPeak` | Maximum paired request-input/window ratio over eligible deduplicated requests, or `null`; Claude's reviewed capacities are estimates | P0 |

### Reliability (`SessionReliability`)

Public types live in [`src/metrics/reliability-types.ts`](../src/metrics/reliability-types.ts), referenced and re-exported by `src/types.ts`. All fields below are under `sessions[].reliability`. MCP server/tool names are bounded to 128 identifier characters; invalid names become `unknown`. No raw provider object is copied into this namespace.

| Field | Meaning | Tier |
| --- | --- | --- |
| `version` | Reliability schema version, currently `1` | P0 |
| `contentRules` | `enabled` or `disabled` | P0 |
| `hashing` | `enabled`, `disabled`, or `unavailable`; never key material | P0 |
| `tools[].name` | Bounded structured tool name; MCP names are server-qualified (names exceeding 128 characters use a prefix plus a digest of the structured name only) | P0 / P1 for MCP server identity |
| `tools[].toolClass` | Fixed cross-provider class; shell command inference requires P2 | P0 / P2 when inferred |
| `tools[].calls`, `mcp[].calls` | Observed calls in this group | P0 |
| `tools[].outcomes`, `mcp[].outcomes` | Fixed `success`, `error`, `denied`, `interrupted`, `timeout`, `unknown` counters | P0 / P2 when derived from receipt text |
| `tools[].errors`, `mcp[].errors` | Fixed error-class IDs and counts (full enum in metrics.md); no error text | P0 / P2 when derived from text |
| `tools[].latency.samples`, `mcp[].latency.samples`, `hooks.latency.samples` | Observed durations contributing to the histogram | P0 / P2 for parsed receipt timing |
| `tools[].latency.buckets`, `mcp[].latency.buckets`, `hooks.latency.buckets` | Sparse numeric `[upperBoundMs, count]` pairs; no timestamps or call IDs | P0 / P2 for parsed receipt timing |
| `tools[].latency.p50Ms`, `tools[].latency.p95Ms`, `mcp[].latency.p50Ms`, `mcp[].latency.p95Ms`, `hooks.latency.p50Ms`, `hooks.latency.p95Ms` | Approximate merged quantiles, or null without samples | P0 / P2 for parsed receipt timing |
| `mcp[].server` | Bounded server name from structured tool/attachment evidence | P1 |
| `mcp[].connectionFailures` | Reported failed connections, separate from call errors | P0 |
| `coverage.argumentCalls`, `coverage.fileCalls` | Counts of calls with usable argument/file HMACs; never the HMACs themselves | P2 |
| `coverage.unmatchedResults` | Receipts without a matching call; suppresses sequence claims for the whole composite session | P0 |
| `coverage.truncated` | Parsing, retained-state or stream-wide hashing safeguards made the evidence partial | P0 |
| `flags` | Null when disabled/unavailable; otherwise the counters below | P2 |
| `flags.exact_repeat`, `flags.repeated_failure`, `flags.failed_edit_cascade`, `flags.edit_thrash`, `flags.reread_churn`, `flags.search_loop` | Local detector episode counts; no matching arguments, paths, digests, IDs or excerpts | P2 |
| `verification.checks`, `verification.passed`, `verification.failed` | Recognized test/build calls and outcomes | P0 / P2 for command classification |
| `verification.editCalls` | Successful or unresolved edit/write calls | P0 |
| `verification.share` | Guarded check / (check + edit) ratio, or null | P2 |
| `verification.skip` | Observed-tail skip; false requires a completed check started after edits completed; null for overlap or insufficient evidence | P2 |
| `verification.stepsToFirstEdit`, `verification.msToFirstEdit` | Main-stream calls and milliseconds before the first possible edit, or null | P0 |
| `hooks.runs`, `hooks.blocks` | Hook runs and summaries blocking continuation | P0 |
| `permissions.denials` | Denied tool calls | P0 / P2 if inferred from failed text |
| `permissions.modes` | Counts of `default`, `auto`, `bypassPermissions`, `plan`, `acceptEdits`, `dontAsk`, `unknown` observations | P0 |
| `permissions.approvalPolicies` | Counts of `untrusted`, `on-failure`, `on-request`, `never`, `unknown` observations | P0 |
| `permissions.sandboxes` | Counts of `read-only`, `workspace-write`, `danger-full-access`, `external-sandbox`, `unknown` observations | P0 |
| `apiErrors` | Structured `api_rate_limit`, `api_server_error`, `unknown` counts | P0 |

The dashboard and report derive class/repository/agent comparisons, coverage denominators, episode totals and guarded rates from these fields. The public JSON contains no per-call events and no additional reliability root rollup. Tests in `test/reliability.test.ts` and `test/server.test.ts` cover sentinels through the parser, child worker, API and report, including error text, diffs, command arguments, hooks and MCP results.

| `maxContextWindow` | Largest context window the provider reported | P0 |
| `maxInputTokensPerCall` | Largest owned, deduplicated request with known input size; a lower bound when request-size coverage is partial | P0 |
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
| `model` | Bounded model ID; `<unknown>` for absent or rejected values, retaining their token counters | P0 |
| `calls` | Requests attributed to this model; zero when aggregate sources cannot establish request counts | P0 |
| `priced` | `true` when every observed token class has an explicit rate across all requests (always `true` for Cursor provider-reported values) | P0 |
| `pricing[]` | Distinct rate provenance used across this model's requests; empty when no request was API-priced; see below | P0 |
| `pricingCoverage.pricedTokens`, `pricingCoverage.eligibleTokens` | Explicitly priced and eligible observed token counts for API usage; estimated cache classes and unknown models remain in the denominator only; absent for provider-reported usage | P0 |

### Pricing provenance (`RateProvenance`)

Present on current rate-card entries and on model usage in sessions, repositories and machine totals. No local paths or raw source records are included.

| Field | Meaning | Tier |
| --- | --- | --- |
| `source` | `models.dev`, `litellm`, or `reviewed` | P0 |
| `kind` | `api`, `reviewed`, or bundled `fallback` | P0 |
| `snapshotDate` | UTC fetch time or reviewed effective date at midnight | P0 |
| `payloadSha256` | SHA-256 of public feed/reviewed-card input bytes; not a local session identifier | P0 |
| `rateModel` | ID of the matching rate entry | P0 |
| `match` | `exact` or `alias` | P0 |
| `temporal` | `at-or-before`, `oldest` (request predates evidence), or `undated` | P0 |
| `assumptions[]` | `anthropic-cache-1h-2x`, `codex-cache-write-upper-1.25x`, `cache-write-upper-multiplier`, `cache-read-at-input`, `cache-write-5m-at-input`, `cache-write-5m-multiplier`, `cache-write-1h-at-5m`, `cache-write-ttl-5m`, `context-cache-read-at-base`, `context-cache-write-5m-at-base`, `context-cache-write-1h-at-base` | P0 |

### Pricing status (`rateCard.pricing`, `rates show/status`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `offline` | Whether public price fetching is disabled | P0 |
| `policy` | `reviewed-first`, `api-first`, or `reviewed-only` | P0 |
| `refreshAfterDays` | Configured stale threshold | P0 |
| `newestSnapshotAt`, `ageDays` | Latest API observation time and age; null without a cache | P0 |
| `stale` | Whether any enabled source is missing/old; false for pinned reviewed-only mode | P0 |
| `snapshots` | Number of retained, usable API observations in this configuration | P0 |
| `sources[].source`, `sources[].url` | Enabled source enum and fixed public endpoint | P0 |
| `sources[].fetchedAt`, `sources[].payloadSha256` | Latest source observation and full payload hash, or null | P0 |
| `sources[].ageDays`, `sources[].stale` | Per-source age (null when unavailable) and staleness | P0 |
| `sources[].models`, `sources[].rejectedModels` | Valid and rejected model-entry counts in the latest observation | P0 |
| `warnings[]` | `cache-unavailable`, `invalid-snapshot`, `large-price-change`, `rejected-models` | P0 |

### Rates CLI output

All fields below are **P0**. `rates status` returns `status` as above plus `coverage`. `rates show` returns `currency: USD`, `status` and `models[]`. `rates diff` returns `comparisons[]` and `changes[]`. `rates update` returns an enumerated result status, per-source results, and changes. The cache directory and local scan options are internal-only.

| Field | Meaning | Tier |
| --- | --- | --- |
| `coverage.modelsSeen`, `coverage.modelsPriced` | Distinct observed API-model IDs and those matched by current rates | P0 |
| `coverage.ratio` | Priced/seen fraction; null when the denominator is zero | P0 |
| `coverage.bySource[].source`, `coverage.bySource[].models` | Source enum and count of local IDs priced by that source | P0 |
| `coverage.unpricedModels[]` | Bounded observed model IDs without a matching current rate; rejected/absent values collapse to `<unknown>` | P0 |
| `models[].model`, `models[].provenance` | Requested/current model ID and rate evidence | P0 |
| `models[].rate.provider`, `models[].rate.source` | Rate's provider enum and public source URL | P0 |
| `models[].rate.inputPerMillion`, `outputPerMillion`, `cachedInputPerMillion`, `cacheReadPerMillion`, `cacheWrite5mPerMillion`, `cacheWrite1hPerMillion` | Allowlisted USD/million numeric rates | P0 |
| `models[].rate.cacheWriteMultiplier`, `cacheWriteObservable` | Reviewed/derived upper-estimate configuration | P0 |
| `models[].rate.longContext.inputMultiplier`, `outputMultiplier`, `thresholdInputTokens` | Reviewed per-request premium configuration | P0 |
| `models[].rate.contextTiers[].aboveInputTokens`, `inputPerMillion`, `outputPerMillion`, `cacheReadPerMillion`, `cacheWrite5mPerMillion`, `cacheWrite1hPerMillion` | Absolute tier rates and strict per-request threshold | P0 |
| `models[].rate.assumptions[]` | Normalized rate conventions: derived Anthropic one-hour price and configured cache-write upper-estimate rule | P0 |
| `models[].rate.contextTiers[].assumptions[]` | Optional `anthropic-cache-1h-2x` on a tier with a derived one-hour cache price; request provenance uses the applied tier | P0 |
| `comparisons[].source`, `before`, `after` | Source and previous/latest timestamps; null when unavailable | P0 |
| `changes[].source`, `model`, `change`, `large` | Source, model ID, `added`/`removed`/`changed`, and large-change flag | P0 |
| `changes[].before`, `after` | Full normalized rates as above; null for a missing side | P0 |
| update `status` | `updated`, `partial`, `failed`, `offline`, `reviewed-only` | P0 |
| update `sources[].source`, `status`, `models`, `rejectedModels` | Source enum, `updated`/`failed`, accepted/rejected counts | P0 |

`test/pricing.test.ts` plants sentinel content in feed descriptions/links/extra fields and inspects actual HTTP requests from a loopback fixture server. `test/pricing-accounting.test.ts` carries transcript sentinels through history selection, API projection, aggregation, report and rates status. Only fixed source URLs and explicitly projected fields survive. Corrupt payloads/errors do not enter output. `test/pricing-review.test.ts` injects invalid model values into Claude/Codex metadata and verifies CLI text/JSON, actual API responses and the actual Pricing renderer, retaining eligible tokens. It also tests report failures in both modes with missing/invalid cards and a crashed worker. `test/pricing-usage.test.ts` rejects sentinel assumption strings at the new tier boundary.

### Velocity cells (`SessionVelocity`)

Every new field is projected from counters or fixed enums. Dates/hours and finer agent
mix increase temporal detail; the explicit timezone is P1 because it can disclose a
region. Repository and session keys are inherited from the enclosing P1 session and are
not repeated inside cells. No event ID, agent ID, parent ID, command, nickname or custom
agent name is exported. Synthetic sentinel tests cover metadata, streamed content, tool
inputs, invalid timestamps and spawned-agent objects on the same API/JSON projection.
Usage-free and tool-only Claude/Codex fixtures also plant forbidden model labels and
assert their absence through both the capped isolated worker and HTTP API; usage and
fallback fixtures cover all three providers. No new snapshot fields are needed for
the browser's daily, period and group evidence guards.

| Field | Meaning | Tier |
| --- | --- | --- |
| `dimensions[]` | Per-session dictionary of observed dimension combinations | P0 |
| `dimensions[].agent` | Fixed enum: `claude-cli`, `claude-sdk`, `claude-desktop`, `claude-unknown`, `claude-general-purpose`, `claude-explore`, `claude-plan`, `claude-subagent`, `codex-cli`, `codex-exec`, `codex-vscode`, `codex-desktop`, `codex-subagent`, `codex-review`, `codex-unknown`, `cursor` | P0 |
| `dimensions[].model` | Bounded model ID matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, otherwise `<unknown>`; never inferred from text | P0 |
| `dimensions[].executionKind` | `top-level`, `subagent`, or `unknown`; no mixed cells | P0 |
| `dimensions[].effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, or `unknown` | P0 |
| `buckets[][0]` | Local `YYYY-MM-DD` date of evidenced activity | P0 |
| `buckets[][1]` | Local clock hour, integer 0–23 | P0 |
| `buckets[][2]` | Index into `dimensions` | P0 |
| `buckets[][3]` | Fixed tuple of counters, defined below | P0 |
| `undated[][0]` | Dimension index for activity without an absolute timestamp | P0 |
| `undated[][1]` | Same counter tuple, excluded from dated charts | P0 |
| `values[0]` | Priced value in USD | P0 |
| `values[1]` | Processed input tokens | P0 |
| `values[2]` | Uncached input tokens (legacy Cursor unsplit allocation; coverage remains unavailable) | P0 |
| `values[3]` | Cache-read input tokens | P0 |
| `values[4]` | Cache-write input tokens | P0 |
| `values[5]` | Output tokens, including reasoning | P0 |
| `values[6]` | Separately recorded reasoning tokens | P0 |
| `values[7]` | Model calls | P0 |
| `values[8]` | Effective tool calls | P0 |
| `values[9]` | Public sessions started | P0 |
| `values[10]` | Tokens assigned to a model price; coverage numerator | P0 |
| `values[11]` | Output with reasoning exposed by the charged usage; a cumulative difference requires both endpoints; coverage numerator | P0 |
| `values[12]` | Input with cache reads exposed by the charged usage; a cumulative difference requires both endpoints; coverage numerator | P0 |
| `values[13]` | Input tokens with a cache-write counter; coverage numerator | P0 |

`values` means the tuple in `buckets[][3]` or `undated[][1]`; it is not another JSON key.
Week/month/hour series, rolling means, changes, movers and projection bands are computed
in the browser from these cells and are not additional exported fields. Definitions,
minimum-activity guards and unknown-data rules are in [metrics.md](metrics.md#velocity-snapshot-version-1).

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

### Session outcomes (`SessionOutcomes`)

All fields below are inside `session.outcomes`. Names and semantics are declared in `src/metrics/outcome-types.ts`, re-exported by `src/types.ts`. [Metric definitions](metrics.md#outcomes) specify denominators, confidence, and limits.

| Field | Meaning | Tier |
| --- | --- | --- |
| `editsObserved` | Successful edit evidence or positive line totals observed | P0 |
| `editOperations` | Deduplicated Claude edit results / completed Codex FileChange events | P0 |
| `linesAdded`, `linesRemoved` | Observed counts, or null when unavailable | P0 |
| `lineCoverage` | complete, partial, unavailable; complete refers only to retained observations | P0 |
| `lineSource` | claude-cost-state, claude-structured-patch, codex-file-change, cursor-composer, mixed, unavailable | P0 |
| `operations.commits`, `operations.pushes` | Deduplicated successful structured Git operation counts | P0 |
| `operations.prsCreated`, `operations.prsEdited`, `operations.prsMerged`, `operations.prsClosed` | Structured PR operation counts, not unique artifacts | P0 |
| `links[].ref` | Kind prefix plus 24 hex characters of SHA-256 over a qualified artifact/observation identity | P1 |
| `links[].kind` | branch, commit, pull-request | P0 |
| `links[].role` | outcome or context | P0 |
| `links[].identity` | artifact or observation (no reliable artifact identity) | P0 |
| `links[].confidence` | strong, medium, weak | P0 |
| `links[].sources[]` | claude-git-operation, claude-pr-link, claude-branch, codex-session-git, conductor-workspace, local-git, github | P0 |
| `links[].created` | Explicit PR creation observed | P0 |
| `links[].state` | unknown, open, closed, merged; context state never proves an outcome | P0 |
| `links[].timeToMergeMilliseconds` | GitHub PR creation-to-merge duration, or null | P0 |
| `agentCoauthoredCommits` | Matched commits with an agent-name co-author trailer; 0 unless local Git enrichment is enabled | P2 (opt-in) |
| `agentCoauthorTrailers` | Recognized agent co-author trailers on matched commits, deduplicated by commit across branch queries | P2 (opt-in) |
| `enrichment.git`, `enrichment.github` | off, not-applicable, matched, no-match, unavailable, limited | P0 |
| `truncated` | Collector reached an evidence cap; counts may be lower bounds | P0 |
| `prAssociationsComplete` | False when a PR association or further result inspection was lost to a collector cap; guards PR allocation | P0 |

Outcome refs are stable, unkeyed pseudonyms, not anonymity guarantees. Commit and branch identities are qualified by repository key; PR identities use canonical repository/number; anonymous observations use provider-qualified session/tool IDs; workspace context uses workspace ID. No new path/argument hashes are exposed. An observer already holding candidate identities can recompute these hashes. Raw SHAs, branches, PR numbers, slugs, URLs, titles, and workspaces remain private even with enrichment. There is deliberately no raw-PR display mode.

Line-marker counting inspects only structured diff syntax and emits P0 counts; no semantic code/text rules run by default. Optional Git co-author classification is P2. Enabling GitHub sends only existing authentication and validated PR coordinates to github.com, never a transcript or file path. Both enrichments are explicitly off by default and have negative CLI overrides.

### Outcome summary (`OutcomeSummary`)

The root and repository `outcomes` share this schema. All fields are P0; totals with missing/partial coverage are not claims about all work.

| Field | Meaning | Tier |
| --- | --- | --- |
| `sessions`, `observedSessions` | Selected and inspected sessions | P0 |
| `editSessions`, `commitSessions`, `prSessions`, `mergedPrSessions` | Independent session evidence stages | P0 |
| `contextOnlySessions` | Sessions whose links are all weak context | P0 |
| `lineMeasuredSessions`, `linesAdded`, `linesRemoved` | Measured-session coverage and summed observed line counters | P0 |
| `coverage.lines.complete`, `coverage.lines.partial`, `coverage.lines.unavailable` | Mutually exclusive coverage counts among inspected sessions | P0 |
| `coverage.truncatedSessions` | Inspected sessions reaching evidence limits | P0 |
| `coverage.enrichment.git`, `coverage.enrichment.github` | Fixed counters keyed by off, not-applicable, matched, no-match, unavailable, limited; each sums to inspected sessions | P0 |
| `apiSessions`, `apiPricedSessions`, `apiEquivalentValueUsd` | API-basis session coverage and known-rate value | P0 |
| `unlinkedEditSessions`, `unlinkedApiEquivalentUsd` | API sessions/value with edits and no produced commit evidence; heuristic | P0 |
| `pullRequests.linked`, `pullRequests.created`, `pullRequests.merged` | Distinct identified PR counts | P0 |
| `pullRequests.unidentifiedCreatedOperations`, `pullRequests.unidentifiedMergedOperations` | Anonymous PR observations excluded from distinct totals | P0 |
| `operations.commits`, `operations.pushes`, `operations.prsCreated`, `operations.prsEdited`, `operations.prsMerged`, `operations.prsClosed` | Sum of session operation counts | P0 |
| `commitSessionRate` | Guarded commit-evidence session share | P0 |
| `apiEquivalentPerMergedPr` | Guarded allocated API session value per identified merged PR | P0 |
| `linesPerApiDollar` | Guarded changed lines per API-equivalent dollar | P0 |

Each of the three ratios has the following fields:

| Field | Meaning | Tier |
| --- | --- | --- |
| `value` | Numeric ratio only when available; otherwise null | P0 |
| `numerator`, `denominator` | Observed operands, including when a guard withholds the ratio | P0 |
| `minimumDenominator`, `minimumSessions` | Activity thresholds applied to that ratio | P0 |
| `eligibleSessions`, `candidateSessions` | Coverage counts for the ratio's measurement cohort | P0 |
| `incompleteEvidenceSessions` | API sessions with incomplete PR associations for the PR ratio; zero for other ratios | P0 |
| `status` | available, unavailable, insufficient-activity, incomplete-pricing, incomplete-evidence | P0 |

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

### Cache-gap signals

`session.insightSignals.cacheGaps` is absent for unsupported providers. Every value is a number, never transcript content.

| Field | Meaning | Tier |
| --- | --- | --- |
| `observableCalls` | Deduplicated Claude requests with explicit TTL fields and valid timestamps | P0 |
| `timedTransitions` | Adjacent same-model requests in the same file with valid times and current explicit TTL | P0 |
| `fiveMinuteExpiries` | 5m write events after a >5m gap; candidate association, not proven expiry | P0 |
| `oneHourExpiries` | 1h write events after a >1h gap; may overlap 5m events | P0 |
| `rewriteTokens` | TTL-specific cache-write tokens after qualifying gaps | P0 |
| `pricedRewriteTokens` | Subset of those tokens with a reviewed price | P0 |
| `estimatedPremiumUsd` | Estimated write-versus-read difference on priced tokens; not actual savings | P0 |

### Insights report (`InsightsReport`)

Returned by `insights --json` and `GET /api/insights`; public types are re-exported from `src/types.ts` and defined under `src/insights/`. Configuration file paths and settings contents are never returned.

| Field | Meaning | Tier |
| --- | --- | --- |
| `schemaVersion` | Version 2 of this separate report contract (`groups` plus `items`; v1 `cards` migrated to `items`) | P0 |
| `generatedAt` | Source snapshot time | P0 |
| `rateCardEffectiveDate` | Rate card date used for comparisons | P0 |
| `thresholds` | Explicit numeric configuration: `minRepoSessions`, `minModelCalls`, `minInputTokens`, `outlierMultiplier`, `minOutlierUsd`, `minDifferenceUsd`, `cacheReadShare`, `cacheWriteShare`, `compactionsPer100Calls`, `minCompactions`, `subagentShare`, `subagentDelta`, `longContextInputTokens`, `longContextShare`, `extensionMinSessions`, `extensionMinToolCalls`, `idleGapMinEvents`, `timeMinSessions`, `timeBucketShare`, `utcOffsetMinutes` | P0 |
| `groups[]`, `items[]` | Ranked rule/scope summaries and complete per-scope findings; no transcript records | P0/P1 |
| `groups[].id` | `insight-group-` plus 20 hex SHA-256 characters from rule/scope kind; stable display key | P1 |
| `groups[].ruleDecisionId` | `insight-rule-` plus 20 hex SHA-256 characters from rule alone; browser decision key across all scopes/filters | P1 |
| `groups[].rule`, `groups[].scopeKind` | Fixed rule ID and `machine`, `repo` or `session` | P0 |
| `groups[].title` | Fixed grouped rule title, including next-tier/configured-target scenario label | P0 |
| `groups[].itemIds[]` | References to existing opaque per-scope insight IDs, ranked within the group | P1 |
| `groups[].affected.repositories`, `.sessions` | Distinct actual contributor counts; inventory rules count sessions/repositories checked | P0 |
| `groups[].coverage.eligibleSessions`, `.totalSessions`, `.totalRepositories` | Unique rule-eligible session count and selected session/repository denominators | P0 |
| `groups[].estimatedImpact.value`, `.unit`, `.basis`, `.label` | Sum of disjoint quantified scope values within one rule/unit, or null; same enums as item impact and fixed total/partial-total label | P0 |
| `groups[].impactCoverage.quantifiedItems`, `.totalItems` | Quantified-scope count and all affected-scope denominator | P0 |
| `groups[].confidence` | Lowest per-scope confidence: `low`, `medium`, `high` | P0 |
| `groups[].guardrails[]`, `.suggestedAction` | Distinct fixed item interpretation notes and fixed rule action | P0 |
| `items[].id` | `insight-` plus 20 hex SHA-256 characters from rule, scope and names; stable browser decision key, not a secret-keyed hash | P1 |
| `items[].rule` | One of the ten fixed rule IDs in [insights.md](insights.md#rules-and-formulas) | P0 |
| `items[].title` | Fixed rule title | P0 |
| `items[].scope.kind` | `machine`, `repo`, `session` | P0 |
| `items[].scope.repositoryId`, `items[].scope.sessionKey` | Existing pseudonymous key or null | P1 |
| `items[].scope.provider` | Existing provider enum or null | P0 |
| `items[].session.startedAt`, `items[].session.models[]` | Present on session items: normalized UTC start (null if invalid/missing) and bounded model IDs; no title or path | P0 |
| `items[].evidence[].label` | Fixed description of a numeric measurement | P0 |
| `items[].evidence[].value` | Numeric scalar or ratio numerator | P0 |
| `items[].evidence[].unit` | `USD`, `tokens`, `count`, `ratio`, `multiple`, `hour` | P0 |
| `items[].evidence[].denominator` | Numeric denominator, or null for a scalar | P0 |
| `items[].evidence[].denominatorLabel` | Fixed denominator meaning, or null | P0 |
| `items[].estimatedImpact.value` | Numeric estimate or null when unquantified | P0 |
| `items[].estimatedImpact.unit` | `USD` or `tokens`; never summed across units | P0 |
| `items[].estimatedImpact.basis` | `scenario-difference`, `associated-usage`, `unavailable` | P0 |
| `items[].estimatedImpact.label` | Fixed description of estimate and limits | P0 |
| `items[].confidence` | `low`, `medium`, `high`; interpretive confidence | P0 |
| `items[].guardrail`, `items[].suggestedAction` | Fixed explanatory text, no transcript or config text | P0 |
| `items[].names[]` | Compared model ID or bounded configured skill/MCP server name; no settings values | P0 for models/skills, P1 for MCP servers |
| `items[].pricing.strategy` | Optional `next-tier-down` or `configured-target`, on price scenario items | P0 |
| `items[].pricing.transitions[].sourceModel`, `.targetModel` | Bounded model IDs describing each one-step within-provider scenario move; never arbitrary configuration values | P0 |
| `items[].coverage.eligibleSessions`, `items[].coverage.totalSessions` | Eligible/selected session counts, peers for peer comparisons | P0 |
| `coverage[].rule`, `coverage[].eligibleSessions`, `coverage[].totalSessions`, `coverage[].findings`, `coverage[].groups` | Rule ID, evidence coverage, scope-item count and grouped-card count | P0 |
| `coverage[].status` | `disabled`, `unavailable`, `insufficient`, `no-findings`, `findings` | P0 |
| `evidenceCoverage[].reason` | `partial-transcript`, `active-session`, `unknown-liveness`, `unknown-completeness`, `unknown-request-size` | P0 |
| `evidenceCoverage[].sessions`, `.totalSessions` | Reason count and selected-session denominator; overlapping counts | P0 |
| `warnings[]` | Fixed messages with counts about evidence, invalid/missing starts, partial inventory and interpretation; never raw provider warnings | P0 |

### Review metadata (`ReviewPreview`) and assessment

`review --json` returns `{ preview, result }`. The internal prompt is P3 and is never a field of this JSON. `result` is null for a dry-run or missing context. No excerpts or raw agent responses are displayed even after a send.

| Field | Meaning | Tier |
| --- | --- | --- |
| `preview.privacyTier` | Literal `P3`, identifies the optional workflow | P0 |
| `preview.mode` | `dry-run` or `sent` | P0 |
| `preview.sessionKey` | Selected hashed session key | P1 |
| `preview.via` | `claude` or `codex` | P0 |
| `preview.flaggedRules[]` | Fixed rule IDs relevant to this session/repository/provider | P0 |
| `preview.spans`, `preview.excerpts` | Selected bounded window/prose counts | P0 |
| `preview.contentBytes`, `preview.promptBytes` | UTF-8 JSON excerpt/full prompt sizes | P0 |
| `preview.redactions.credentials`, `.identifiers`, `.paths`, `.urls`, `.emails`, `.codeBlocks` | Counts of redaction replacements in selected excerpts | P0 |
| `preview.omittedBlocks` | Unsupported/non-prose blocks excluded while scanning the selected file | P0 |
| `preview.truncated` | Oversized records, excerpt/window limits or truncated prose encountered | P0 |
| `preview.note` | Fixed dry-run/send description and privacy limit | P0 |
| `result.assessment` | `unknown`, `expected`, `worth-review` | P0 |
| `result.confidence` | `low`, `medium`, `high` | P0 |
| `result.suggestion` | `none`, `compare-similar-task`, `check-context`, `check-cache`, `check-delegation` | P0 |

### Health endpoint

`GET /api/health` returns `{ service: "session-analytics", snapshot: "ready" | "building" | "not-started", status: "ok" }`. All fields are P0.

### Browser storage

The dashboard stores the selected view (`session-analytics-view`), theme (`session-analytics-theme`), and insight decisions (`session-analytics-insights-v1`). Insight decisions map opaque P1 scope IDs (`insight-…`) and rule IDs (`insight-rule-…`) to `dismissed` or a snooze-expiry timestamp; legacy scope decisions are retained. Rule choices apply across all scopes; restoring one does not erase independent scope choices; no card evidence, names, prose or settings are persisted. They can be restored from the Insights tab and do not affect API/CLI results.

### MCP fields

The following additive fields are declared in `src/mcp/types.ts` and re-exported by `src/types.ts`. Their formulas and missing-evidence semantics are in [MCP query semantics](metrics.md#mcp-query-semantics). All text descriptions, status strings, warnings and protocol errors below are fixed or enumerated unless explicitly identified as a bounded metadata name.

#### Session evidence (`McpSessionEvidence`)

These fields also appear in the existing JSON/API session projection when supported; the collector never returns its raw join IDs.

| Field under `mcpEvidence` | Meaning | Tier |
| --- | --- | --- |
| `activityState` | Recorded lifecycle enum: active, settled or unknown; never an inferred success | P0 |
| `pricingByDay[].day` | Valid UTC accounting date shared with the spend ledger | P0 |
| `pricingByDay[].eligibleTokens`, `.pricedTokens` | Deduplicated API token operands, including unpriced requests | P0 |
| `undatedTokens` | API tokens with no valid accounting date | P0 |
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
| `sourceHealth[].provider`, `.status` | Fixed provider and discovery status enums; unknown for older snapshots | P0 |
| `sourceHealth[].sourcesRead`, `.missingSources`, `.unreadableSources` | Source counts independent of the selected session cohort | P0 |
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
| `McpTotals.basis` | Always `session-start`, distinct from activity-day budget periods | P0 |
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
| `activityStates.active`, `.settled`, `.unknown` | Selected session counts by observed lifecycle; only settled sessions enter distributions | P0 |
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
| `today/week.pricingCoverage` | Dated priced/eligible token ratio qualifying the period value and burn rate | P0 |
| `today/week.unpricedTokens`, `.undatedTokens` | In-period unpriced tokens and all scoped API tokens without a date; null when operands unavailable | P0 |
| `today/week.datedSessions`, `.undatedSessions` | API sessions with a dated value/token entry in-period; all scoped sessions without applicable daily ledgers | P0 |
| `today/week.excludedProviderReportedUsd` | All-history scoped reported value excluded because timing is unavailable | P0 |
| `today/week.elapsedHours`, `.apiEquivalentUsdPerHour` | UTC wall-hour denominator and guarded historical burn rate/null | P0 |
| `rateLimits[].provider`, `.status` | Provider and available/unavailable evidence status | P0 |
| `rateLimits[].windows[]` | The same four numeric/timestamp quota fields as session evidence, plus `remainingPercent` | P0 |
| `unused_extensions`: `inventoryScope` | Always `launch-context` | P0 |
| `providers[].provider`, `.inventoryCoverage`, `.skillEvidence` | Provider, always-partial inventory, explicit/inferred/unavailable invocation method | P0 |
| `providers[].skillIdentityCoverage`, `.unresolvedSkills` | Available/partial/unavailable identity matching and installations excluded for unknown identity | P0 |
| `providers[].sourcesRead`, `.unreadableSources`, `.truncated` | Readable/unreadable source counts and cap flag; no paths/errors | P0 |
| `providers[].installedSkills`, `.configuredMcpServers` | Distinct bounded-name counts | P0 |
| `providers[].skillsWithoutObservedUse[]` | Installed skill names without invocation evidence in the selected scope/window | P0 |
| `providers[].serversWithoutObservedUse[]` | Configured MCP server names without observed use | P1 |
| `providers[].omittedSkills`, `.omittedServers` | Names beyond the response cap | P0 |

#### Worker inventory and protocol wrapper

The MCP worker returns `{analytics, inventory}` to its parent over an anonymous pipe. `analytics` is the allowlisted machine snapshot above. Each `inventory[]` contains only `provider`, `skills[]`, `skillIdentities[].name`/`.aliases[]`, `unresolvedSkills`, `mcpServers[]`, `sourcesRead`, `unreadableSources`, and `truncated`; server names are P1, all other inventory fields P0. Skill names come only from bounded scalar frontmatter names and directory aliases, deduplicated by a canonical path that stays inside the worker. At most a 16 KiB skill prefix is read; description/body content is never projected. Unsupported metadata yields an unknown identity count, not a purportedly unused name. TOML escaped delimiters and quote runs cannot turn string values into table names; malformed string syntax rejects the source. Config values, URLs, environment values and commands are discarded inside the worker. This inventory is in memory only, never persisted, and bounded to 512 names/identities and 512 aliases per identity.

The MCP wrapper contains standard JSON-RPC `jsonrpc`, caller-chosen `id` (protocol correlation only), `result` or `error`; errors use fixed `code`/`message` and, for unsupported versions, `data.supported`/`requested` protocol dates. Tool results contain `isError`, `content[].type`/`.text` (a fixed-template summary and serialized `McpPayload`), and `structuredContent` (the same payload). Modern results add `resultType` and `_meta.io.modelcontextprotocol/serverInfo`. Discovery/initialization contain only static product/version identifiers, protocol versions, tool capability declarations, instructions and catalog cache hints (`ttlMs`, `cacheScope`). `tools/list` returns static names/descriptions, JSON input schemas and read-only/idempotent/closed-world annotations. These are P0 and carry no local-history identifiers; caller request IDs are echoed as required by JSON-RPC, never used to query history.
The dashboard stores two values in browser `localStorage`: the selected view (`session-analytics-view`) and the theme (`session-analytics-theme`). No session data is persisted in the browser. The separate local SQLite index is described above.

### Index management status (`IndexStatus`)

`index status --json` returns these fields, with no data-directory or evidence path. Counts are index rows across isolated source scopes, not deduplicated machine metrics.

| Field | Meaning | Tier |
| --- | --- | --- |
| `state` | `ready`, `missing`, `corrupt`, or `incompatible` | P0 |
| `schemaVersion` | SQLite schema version, or `null` when unavailable | P0 |
| `sessions`, `sourceDeletedSessions` | Stored session facts and the subset marked source-deleted | P0 |
| `evidenceFiles`, `scopes` | Stored fingerprint rows and source scopes containing sessions | P0 |
| `databaseBytes` | Main SQLite file size; excludes WAL/SHM and quarantines | P0 |
| `lastScan` | Most recently committed ingest statistics, or `null` | P0 |
| `lastScan.completedAt` | UTC completion timestamp | P0 |
| `lastScan.fingerprintedFiles` | Unique transcript files fingerprinted during this ingest | P0 |
| `lastScan.parsedSessions`, `.reusedSessions` | Claude/Codex composite sessions parsed or reused, including reuse of exclusion checkpoints; Cursor refreshes are excluded | P0 |
| `lastScan.retainedSessions` | Prior sessions returned after source absence/unavailability | P0 |
| `lastScan.deferredSessions` | Session groups in unstable ownership components; prior facts/exclusions were preserved together | P0 |
| `lastScan.ledgerReads`, `.ledgerHits`, `.ledgerAppends` | Codex ledger files read, reused, and the read subset continued from a verified prefix | P0 |
| `lastScan.elapsedMilliseconds` | Ingest wall time after opening the index, excluding process startup | P0 |

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

### Interchange metadata and export fields

All formats retain only the declared P0/P1 fields and opted-in P2 counters; no P3 prose is exported. These fields extend the manifest above; the complete contracts and wire mappings are in [interop.md](interop.md). The two published schemas reject unknown nested fields. Snapshot import enforces hashed key syntax, fixed status labels, approved warning templates, bounded model/tool/skill names, and numeric reconciliation. Repository names and otherwise valid identifiers still require trusted provenance: syntax cannot certify their meaning. Arbitrary warning/error/status text and raw repository UUIDs are rejected.

| Field / surface | Meaning | Tier |
| --- | --- | --- |
| `schemaVersion` (machine/repository JSON, shared JSON, every CSV and NDJSON record; OTLP resource attribute) | Always `1` for this contract | P0 |
| CSV `sessionKey`, `repositoryId`, `repositoryName` | Existing public identity fields, unchanged for local exports | P1 |
| CSV `transcriptStatus` | Flattened `session.transcript.status` | P0 |
| CSV `day`, `tool`, `model`, `calls` | Existing date/tool/model labels and counters at the documented table grain | P0 |
| CSV `contributingSessions` | Sessions contributing an entry to a daily/model/tool row | P0 |
| Other CSV columns | Flattened existing session/token/cost/metric fields, with original units and cost basis | P0/P1 as above |
| NDJSON `kind` | `snapshot`, `repository`, or `session`; remaining fields are existing public fields | P0 |
| Filtered JSON `warnings[]` | Preserved fixed discovery caveats, regenerated selection coverage notes, and an appended filtering explanation | P0 |
| `/api/health.dataSource` | Fixed `live` or `snapshot` label used to prevent cross-source server reuse; never the snapshot filename | P0 |
| Shared JSON `kind`, `minimumSessions` | `shared`; minimum distinct session count required for every released bucket | P0 |
| Shared `sources[]` | Domain-separated HMAC installation identities, 128 bits; used to reject repeated contributions | P1 |
| Shared `repositories[].repository` | `repo-<128-bit HMAC>` or `alias-<explicit user alias>`; no original ID/name | P1 |
| Shared `repositories[]` and `summary`: `sessions`, `inputTokens`, `outputTokens`, `pricedTokens`, `priceableTokens`, `apiEquivalentSpendUsd`, `providerReportedSpendUsd`, `estimatedUpperSpendUsd`, `toolCalls`, `compactions` | Additive counters, restricted to retained buckets; no global total that includes suppressed buckets | P0 |
| Shared browser CSV `repository` and all shared counter columns | Same released aggregates; no added identity | P0/P1 as above |
| OTLP `resourceLogs[].resource.attributes`: `service.name`, `session_analytics.schema.version` | Fixed neutral service name and format version | P0 |
| OTLP `scopeLogs[].scope`: `name`, `version`, attributes `session_analytics.semconv.version`, `session_analytics.semconv.commit`; `scopeLogs[].schemaUrl` | Fixed exporter/package and pinned convention identifiers | P0 |
| OTLP `logRecords[]`: `timeUnixNano`, `observedTimeUnixNano`, `body.stringValue` | Snapshot observation time and fixed label `Observed session usage aggregate` | P0 |
| OTLP `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.model` | Existing usage counters and a model only when fully attributable | P0 |
| OTLP `session_analytics.repository.key`, `session_analytics.session.key` | Existing pseudonymous local keys; repository names omitted | P1 |
| OTLP `session_analytics.provider`, `.record.type`, `.cost.basis`, `.transcript.status` | Source enum and fixed interpretation/evidence labels | P0 |
| OTLP `session_analytics.usage.cache_read_tokens`, `.cache_write_tokens`, `.reasoning_tokens`, `.value_usd`, `.upper_value_usd`, `session_analytics.tool.calls`, `.model.calls`, `.pricing.coverage` | Existing counters/value/coverage; cache and reasoning counters are subsets, not extra tokens | P0 |

The HMAC key, alias-file lookup keys, snapshot/input/output paths, collector URL, credentials, and collector response/error text are not public fields. Aliases are deliberately shared identifiers and can be identifying even if their syntax is bounded. Shared files omit timestamps, session rows, model/tool names, fine-grained slices, source rate links, and warnings. Empty shared files have empty source lists and all-zero totals.

### Sharing and optional delivery boundary

`report --share` produces a local preview: stdout contains exactly the JSON payload, and nothing is transmitted. The threshold defaults to five distinct sessions per repository bucket; it is **not person-level k-anonymity**. A single person can produce every session. Repeated overlapping releases, distinctive totals, and outside information can identify activity; this is not differential privacy. Use neutral aliases and review a single contribution per source before sharing. No grand total includes suppressed rows. Merge accepts only validated shared aggregates at the same threshold and rejects repeated source pseudonyms, including transitively through earlier merges. Pseudonyms are linkable and are not authentication; different keys or copied evidence can defeat overlap detection.

A private 32-byte random sharing key is the only new persistent secret. Its default location is `$XDG_STATE_HOME/session-analytics/sharing.key` or `~/.local/state/session-analytics/sharing.key`; an explicit file option/environment override is supported. It is created with mode 0600, never exported, and symlink/public-permission keys are rejected. Files are opened exclusively to prevent overwrite. Existing output directories should be private and user-controlled. CSV neutralizes spreadsheet formulas in text cells. Browser downloads use local Blobs, no upload endpoint and no extra browser storage.

Only `export --format otlp-json --otlp-endpoint URL` can POST telemetry. It first saves the exact allowlisted payload locally. It requires HTTPS except loopback HTTP, rejects embedded credentials, does not follow redirects, and does not retry or print collector text. OTLP remains a P0/P1 **session-level** export, not the thresholded sharing format. It includes local pseudonymous session/repository keys and possibly model IDs. The CLI flag authorizes that delivery; normal analysis, sharing previews, merge, the dashboard, and file-only exports never send it. This is a deliberate exception to the default offline guarantee, not background telemetry.

Shared totals always carry a CLI/dashboard caveat that they are observed lower bounds and may include running and partially parsed sessions. Pricing coverage does not establish evidence completeness. No new completeness flags, rare subgroup counts, or suppressed totals enter shared files. New fixed parser warnings cover omitted malformed metadata and cache-write totals reconciled from recorded TTL buckets.

### Integrated quota replay (`SessionLimitsCache.quotaEvidence[]`)

This optional per-session P1 namespace preserves normalized transcript observations for cold/warm/full index parity. It adds no parsing pass or raw source storage. Machine profile windows are rebuilt and freshness recomputed on each scan; quotas remain global under repository/date filtering.

| Field | Meaning | Tier |
| --- | --- | --- |
| `profileKey`, `provider` | Existing pseudonymous profile key and Claude/Codex enum | P1/P0 |
| `planType`, `planObservedAt`, `credits` | Existing allowlisted plan enum, observation date and credits flags/numeric balance | P0 |
| `windows[].key`, `.label`, `.windowMinutes` | Fixed quota window identity/label and duration | P0 |
| `windows[].observations[]` | Existing `LimitSample`: normalized timestamp, utilization, reset timestamp and source enum | P0 |
| `windows[].duplicatesDiscarded`, `.historyLimited` | Reconciliation count and bounded-history flag | P0 |
| `hits[].key`, `.timestamp`, `.kind`, `hitSessions[]` | Hashed hit/session identities, time and fixed limit-hit kind | P1/P0 |

### Integrated MCP summaries (`McpPayload.metrics`)

These optional, bounded summaries use the selected sessions except explicitly global quota observations. No names, paths, commands, arbitrary text or unbounded event arrays are added.

| Namespace / fields | Meaning | Tier |
| --- | --- | --- |
| `pricing.policy`, `.stale`, `.sources[]` (`source`, `fetchedAt`, `stale`, `models`) | Fixed policy/source enums, dates, freshness and catalog counts | P0 |
| `velocity.coveredSessions`, `.selectedSessions`, `.timeZone`, `.datedApiEquivalentUsd`, `.undatedApiEquivalentUsd`, `.pricedTokens`, `.eligibleTokens` | Coverage and additive usage operands; timezone is identifying | P0/P1 |
| `reliability.coveredSessions`, `.selectedSessions`, `.contentRuleSessions`, `.truncatedSessions`, `.calls`, `.errorRate`, `.errorDenominator`, `.latency`, `.verification` | Existing bounded reliability counts, guarded ratio, latency samples/p50/p95 and verification denominators | P0/P2 when enabled |
| `limitsCache.minimumRequests`, `.minimumInputTokens`, `.coveredSessions`, `.selectedSessions`, `.requests`, `.inputTokens`, `.cacheReadTokens`, `.hitRatio`, `.pricedRequests`, `.netSavingsUsd`, `.flaggedBreakRequests`, `.contextRequests`, `.above80` | Guarded cache/context and coverage counters | P0 |
| `limitsCache.quotaScope`, `.quota[]`, `.omittedQuotaWindows` | Fixed global scope; at most 20 hashed profile keys, provider/window, observation count/date, headroom/expiry/staleness, observed minutes and shareAbove90; omission count | P0/P1 |
| `outcomes` | Existing `OutcomeSummary` field contract | P0 |
| `workflow.coverage`, `.humanTurns`, `.toolRuns`, `.turnWallTime`, `.time`, `.interruptions`, `.archetypes`, `.abandonment`, `.concurrency` | Existing workflow summary fields; histograms expose only samples/p50/p95/max, concurrency only peak/eligible/effective parallelism | P0/P2 when enabled |
| `insightSignals.coveredSessions`, `.selectedSessions`, `.knownRequestSizeTokens`, `.unknownRequestSizeTokens`, `.cacheGapTransitions`, `.estimatedCacheGapPremiumUsd` | Coverage and existing signal counters/value estimates | P0 |
