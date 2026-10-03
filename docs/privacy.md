# Privacy contract

`session-analytics` reads coding-agent transcripts that already exist on your machine. Those transcripts contain everything you and your agents have written: prompts, responses, reasoning, commands, file paths, diffs, and tool output. This document defines exactly what the tool may return from them, how that boundary is enforced, and what it does not protect against.

The content-free contract applies to the dashboard, `/api/analytics`, `/api/insights`, terminal reports, JSON snapshots (`report --json`, `insights --json`), and the agent skill. The separate P3 review workflow has an explicit per-run content-transmission exception described below; it is never invoked by an analytics scan or the dashboard.

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

- **Allowlist projection.** Parsers accumulate counters into an internal session state, and `finalizeSession` in `src/analyzer.ts` builds each public object field by field. Raw provider records are never spread into an output, so a new field in a provider's format cannot reach an output without a code change.
- **Internal-only types.** `SessionDatabaseRow` and `AnalyzeOptions` in `src/types.ts` carry paths, titles, branches, and IDs for correlation. They are used inside the analysis process and are not part of any public type.
- **Bounded derived names.** Skill identifiers must match the pattern above. Tool names come from the provider's structured tool-call records. The one exception is Codex code mode, where a single transported call can run several tools: the parser matches `tools.<name>(` in the call input and accepts only identifier characters (`[A-Za-z][A-Za-z0-9_]*`) as the name.
- **Sentinel tests.** Fixtures plant strings such as `secret-command`, `secret-path`, `secret-skill-args`, and `content-is-not-returned` in prompts, tool inputs, Cursor bubbles, Codex items, and streamed Claude content. Tests in `test/analyzer.test.ts`, `test/accounting.test.ts`, and `test/server.test.ts` serialize the full output and fail if any sentinel, transcript path, workspace name, remote, or raw session UUID appears.
- **Generic errors.** The server maps every failure to one of three fixed messages. The analysis worker's standard error is discarded rather than forwarded, so local paths in exceptions cannot reach the dashboard.
- **No analytics exfiltration path.** Analytics makes no network requests and has no telemetry. The dashboard is served from `127.0.0.1` with a Content Security Policy that only allows same-origin resources. Only the separate P3 review command with `--send-content` invokes a network-capable agent CLI. See [SECURITY.md](../SECURITY.md) for the full threat model.
- **Read-only access.** JSONL transcripts are streamed and SQLite databases are opened with `readOnly: true`. Nothing is written to provider directories.

In analytics, content is held in memory only while a line is being parsed. It is not cached, logged, or written anywhere. The opt-in review worker temporarily retains a bounded set of excerpts in memory; it does not write those excerpts, prompts or responses to disk.

## Privacy tiers

Every field belongs to a tier. The tiers also govern planned features (see [roadmap.md](roadmap.md)).

| Tier | Contents | Status |
| --- | --- | --- |
| **P0** | Counts, token counters, costs, timestamps, durations, model IDs, tool and skill names, enumerated labels | Returned today |
| **P1** | Pseudonymous keys and identifying metadata: session keys, repository IDs/display names, insight IDs and MCP server names; later keyed hashes of paths/arguments, file extensions, command classes and commit SHAs | Returned today (keys, repository metadata and configured MCP names) |
| **P2** | Results of local rules over commands or diffs, where only rule IDs and counts leave the parser | Not implemented; will be opt-in |
| **P3** | Bounded, redacted human/assistant prose sent through the user's own CLI for an optional session review | Explicit `review --send-content` per run only; off by default; never stored by this package or returned by an API |

P2 and P3 features will always be off by default.

### P3 review exception

`review --session KEY --via claude|codex` defaults to a metadata-only dry-run: rule IDs, sizes and redaction counts, no displayed prose and no CLI invocation. Only an explicit `--send-content` flag permits that run to send a bounded prompt through the selected CLI on `PATH`. There is no environment-variable equivalent, persistent opt-in, review HTTP endpoint or dashboard send control. Authentication, retention and billing belong to the user's agent provider.

The capped review worker resolves the hashed key through validated analyzer evidence, chooses up to three windows, and omits reasoning and tool argument/result blocks. It redacts common credential, URL, email, path, ID and code forms and known local identifiers; **remaining prose is P3 and may still be identifying or sensitive**. Regex redaction does not guarantee anonymization. It is capped to 12 excerpts × 1,000 characters and a 60 KB prompt. Paths and raw source IDs never cross the worker output boundary. Only allowlisted assessment enums are returned; arbitrary agent stdout/stderr is discarded. Default analytics remain content-free. [Full behavior and limitations](insights.md#opt-in-review-p3).

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
| `insightSignals.cacheGaps` | Optional Claude-only counters; see [Cache-gap signals](#cache-gap-signals) | P0 |
| `insightSignals.requestSizes.observedTokens`, `.unknownTokens` | Accounted input-plus-output tokens with known/unknown request input size, after ownership and deduplication | P0 |
| `insightSignals.mcpServers` | Optional map of bounded server name to structured observations: deduplicated Codex MCP items or Claude tool calls carrying explicit server attribution; no arguments/results | P1 names, P0 counts |
| `transcript.files` | Number of evidence files read for the session (main transcript plus sub-agent files) | P0 |
| `transcript.status` | `ok`, `missing`, `invalid`, or `unsupported` | P0 |
| `transcript.snapshotWhileWorking` | `true` for Conductor's explicit `working` status; false does not establish inactivity | P0 |
| `transcript.completeness` | Optional `complete`, `partial`, `unknown`: parse/file-version completeness of observed evidence, not lifetime retention | P0 |
| `transcript.liveness` | Optional `active`, `inactive`, `unknown`: observed lifecycle/Conductor state; see [evidence rules](insights.md#rules-and-formulas) | P0 |
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
| `maxInputTokensPerCall` | Largest owned, deduplicated request with known input size; a lower bound when request-size coverage is partial | P0 |
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
