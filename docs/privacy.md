# Privacy contract

`session-analytics` reads coding-agent transcripts that already exist on your machine. Those transcripts contain everything you and your agents have written: prompts, responses, reasoning, commands, file paths, diffs, and tool output. This document defines exactly what the tool may return from them, how that boundary is enforced, and what it does not protect against.

The contract applies to every output surface: the dashboard and its `/api/analytics` endpoint, the terminal report, the JSON snapshot (`report --json`), the agent skill, and the persisted index. `index path` is an explicit local management command: it prints the index database's location, never an evidence path, and that location is absent from analytics/status JSON.

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
- **Generic errors.** Server/report failures use fixed messages. Index failures cross the worker boundary only as an allowlisted code (`index-unavailable`, `index-busy`, `index-incompatible`, `index-integrity`, `index-coordination`); all other failures use a generic analysis error. The worker's standard error is discarded, so local paths in exceptions cannot reach the dashboard or report.
- **No exfiltration path.** The tool makes no network requests and has no telemetry. The dashboard is served from `127.0.0.1` with a Content Security Policy that only allows same-origin resources. See [SECURITY.md](../SECURITY.md) for the full threat model.
- **Read-only access.** JSONL transcripts are streamed and SQLite databases are opened with `readOnly: true`. Nothing is written to provider directories.
- **Explicit disk projection.** `src/store/projection.ts` builds cached session facts field by field on write and read. No provider record, `SessionDatabaseRow`, `AnalyzeOptions`, raw path, or raw identity is persisted. Sentinel tests inspect database rows and bytes, warm snapshots, retained snapshots, and management status.

Content is held in memory only while a line is being parsed. It is not cached, logged, or written anywhere.

## Local index

The default content-free index lives in `~/Library/Application Support/session-analytics/` on macOS and `$XDG_DATA_HOME/session-analytics/` (fallback `~/.local/share/session-analytics/`) on Linux. `SESSION_ANALYTICS_DATA_DIR` / `--data-dir` overrides it. Only the derived index is writable; provider stores remain read-only. Use `--no-index` or `SESSION_ANALYTICS_NO_INDEX=1` to bypass every index read/write and analyze only currently present evidence.

The directory is mode `0700`. `index.sqlite`, WAL/SHM/journal files, the SQLite writer-coordination file, transient filesystem writer tickets, and a 32-byte random `index.key` are mode `0600`. Symbolic links, hard-linked files, and foreign ownership are rejected. These permissions and the key protect against other accounts; this is not encryption and does not protect against a process running as your user.

The following is the complete disk field manifest. Keys and fingerprints use HMAC-SHA-256 with `index.key`, which is never exported. A domain-separated verification MAC binds the database, all scopes, and pruning reservations to that key before scope selection. Legacy migration authenticates existing payloads first; it refuses unverifiable keyed-only state. Rebuild preserves a usable key; deleting or replacing the key does not make an existing database safe to reuse. Integrity MACs detect unintended changes but are not protection from an attacker who can read the key.

| Stored data | Contents | Tier |
| --- | --- | --- |
| `sessions.payload` | The explicit `SessionAnalytics` projection listed below, including repository display names; no raw provider rows | P0/P1 |
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

The index retains previously observed history after provider deletion. `index prune --before YYYY-MM-DD` removes old verified session facts, clears reusable evidence, vacuums the active database, and keeps a retention floor, minimal keyed exclusion checkpoints, and keyed anti-rebilling reservations. Subsequent scans may rebuild ledger evidence from surviving provider files; unchanged exclusion checkpoints skip session parsing without restoring session facts. The cutoff is exclusive UTC midnight; provider files are untouched. Unverified legacy dates are kept until the source can be reparsed. Rebuild discards retained history and resets the floor. Corruption recovery places unreadable main or writer databases in private `.rebuild-*` quarantine files, which are excluded from analysis, status, and prune; remove those separately when no longer needed. Retention is of derived facts, never a raw transcript archive. No P2 or P3 processing is added.

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
| `workingSnapshots` | Machine summary only: working observations with present sources; source-deleted or unavailable historical observations are excluded | P0 |

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
| `firstEventAt` | Earliest valid event instant, normalized to UTC, or `null` | P0 |
| `lastEventAt` | Latest valid event instant, normalized to UTC, or `null` | P0 |
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
| `transcript.snapshotWhileWorking` | `true` when the session was marked working at its last source observation; a retained observation does not establish current activity | P0 |
| `transcript.warnings[]` | Fixed-text parser notes, which may include counts and model IDs | P0 |
| `transcript.sourceDeleted` | Optional `true`: these are last-ingested facts whose source was removed; absent for current evidence and `--no-index` output. Prices/parser results are frozen at last ingest | P0 |

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
