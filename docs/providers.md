# Providers

This page lists every evidence source, where it is read from, which fields the parser uses, how faithful the resulting numbers are, and what is not covered yet. All sources are read-only. Field names below are provider field names used for counting and correlation; none of their content is returned except where the [privacy contract](privacy.md) allows it (counters, names, model IDs, timestamps).

Fidelity labels:

- **Exact**: copied from a provider counter, after deduplication.
- **Estimated**: derived with a stated assumption, such as the Codex cache-write upper estimate.
- **Reported**: a value the provider computed and stored locally, used as-is.
- **Inferred lower bound**: counted from indirect evidence, so true usage can be higher.
- **Unavailable**: the local store does not record it.

## Claude Code

**Where:** every Claude Code profile's `projects` directory:

- `~/.claude/projects`
- every sibling profile such as `~/.claude-work/projects`
- `$CLAUDE_CONFIG_DIR/projects`
- `~/.config/claude/projects`

Profiles that resolve to the same real path are read once. `--claude-root PATH` replaces discovery with a single `projects` directory.

**Format:** one JSONL file per session at `<projects>/<encoded working directory>/<session UUID>.jsonl`. Sub-agent transcripts live at `<projects>/<encoded working directory>/<session UUID>/subagents/*.jsonl` and are analyzed as part of their parent session. `audit.jsonl` files are skipped.

**Identity:** the first records that carry `sessionId` and `cwd`. A file counts only when `sessionId` matches the UUID in its file name.

**Fields used:**

| Record | Fields |
| --- | --- |
| every record | `type`, `subtype`, `timestamp`, `uuid`, `agentId` |
| `assistant` | `effort`; `message.id`, `message.model`, lifecycle `message.stop_reason`; `message.usage`: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`; `tool_use` blocks: `id`, `name` |
| `user` | whether `message.content` is non-empty text (to count human turns; tool results are not turns) |
| `queue-operation`, compaction and summary records | counted by type |
| `compact_boundary` | `uuid` and `timestamp`; canonical boundary UUIDs deduplicate repeats |
| lifecycle | `message.stop_reason` and `system.turn_duration` for observed inactivity; ordered user/assistant records for open work |
| `system.turn_duration` | Settled-turn lifecycle evidence; tracked independently for parent and subagent files |

**Fidelity:**

| Measure | Fidelity |
| --- | --- |
| Input, cache reads, cache writes, output | Exact. Claude Code writes one record per streamed content block; the final snapshot of each `message.id` is used. |
| Cache-write TTL | Exact when `cache_creation` splits 5-minute and 1-hour writes; otherwise all writes are priced at the 5-minute rate. |
| Thinking tokens | Exact when `output_tokens_details.thinking_tokens` is recorded; otherwise they stay inside output and the session carries a warning. Thinking tokens are always priced as output. |
| Cost | Estimated: API list-price equivalent from the rate card. |
| Tools | Exact by name, once per tool-use ID. |
| Sub-agent cost | Exact split: usage from `subagents/` files is sub-agent execution; usage in the main file is top-level. |
| Effort | As recorded on assistant records. |

**Known gaps:**

- Claude Code deletes local transcripts after its `cleanupPeriodDays` setting (30 days by default). Retained Conductor assistant metadata can recover usage and tool counts; result receipts remain a summary fallback. Missing response identities make recovery conservative and partial.
- Claude Code deletes local transcripts after its `cleanupPeriodDays` setting (30 days by default). The local index preserves sessions ingested before cleanup, marked `transcript.sourceDeleted`. History deleted before the first ingest requires an independent source such as Conductor; the index alone cannot reconstruct it.
- Profile `stats-cache.json` daily-token version 5 is reconciled against same-profile UTC day/model streamed-block counters, separately from deduplicated session usage; older or unknown versions are labeled unsupported. See [History coverage](metrics.md#history-coverage-and-recovery).
- Each native Claude session carries its pseudonymous profile key and deduplicated request tokens per UTC day and model as `historyProfile`, the input to machine-wide history coverage. Dashboard views do not expose a profile dimension.

## Claude Desktop local agents

**Where:** `~/Library/Application Support/Claude/local-agent-mode-sessions` (macOS), when it exists. Included in Claude discovery; `--claude-root` replaces it.

**Format:** session files named with the session UUID (`*.jsonl`, or `local_<UUID>.json`), parsed with the Claude Code parser above.

**Known gaps:** macOS path only. Fidelity follows whatever the files record.

## Codex

**Where:**

- `~/.codex/sessions` and `~/.codex/archived_sessions`
- the same two directories in every sibling profile such as `~/.codex-work`
- the same two directories under `$CODEX_HOME`

`--codex-root` and `--codex-archive-root` replace discovery; passing either one limits the scan to the roots given.

**Format:** JSONL rollouts. Active sessions are stored as `sessions/YYYY/MM/DD/rollout-<timestamp>-<session UUID>.jsonl`; archived sessions are stored flat in `archived_sessions`.

**Identity:** the first `session_meta` record's `payload.id` and `payload.cwd`. A file counts only when the ID matches the UUID in its file name.

**Fields used:**

| Record | Fields |
| --- | --- |
| `session_meta` | `payload.id`, `payload.cwd`, `payload.source.subagent` (sub-agent execution) |
| `turn_context` | `payload.model`, `payload.effort` |
| `event_msg` | `payload.type`: `user_message`, `agent_message`, `task_started`, `task_complete`, `turn_aborted` (settled-turn lifecycle evidence), `context_compacted`, `item_completed` (`item.type` of `UserMessage`, `AgentMessage`, or `ContextCompaction`, and `item.id`), and `token_count` (`info.total_token_usage`, `info.last_token_usage`, `info.model_context_window`) |
| `compacted` | counted as a compaction |
| `response_item` | `function_call` and `custom_tool_call`: `name`, `call_id`. A `custom_tool_call` input is scanned for code-mode `tools.<name>(` invocations. Only tool names are kept. |
| lifecycle | Ordered `task_started`, `user_message`, `task_complete`, `turn_aborted` for liveness observations. Tool arguments/results are discarded. |

**Fidelity:**

| Measure | Fidelity |
| --- | --- |
| Input, cached input, output, reasoning output | Exact per request from `last_token_usage`, deduplicated across files that received the same process-wide snapshot. |
| Cache writes | Unavailable. The ordinary estimate prices uncached input at the base rate; the upper estimate adds the cache-write premium to all uncached input. |
| Cost | Estimated: API list-price equivalent, with long-context modifiers applied per request. |
| Tools | Exact by name, once per `call_id`. Code-mode calls are expanded to the inner tool names; the transported calls are kept separately as `transportTools`. |
| Turns, messages | Largest count among legacy and `item_completed` shapes. |
| Compactions | Individual boundaries joined by shared identity or equal UTC timestamp across legacy, item and `compacted` shapes. Distinct format-era events survive; undated or unmatched evidence is counted rather than guessed away. |
| Sub-agent cost | Exact split by the execution segment active when each request was observed. |
| Model | From `turn_context`; when a request precedes any model record, the file's single model is used if it has exactly one. |

Owned request peaks exclude foreign broadcast counters, and cumulative-only usage without a known request size does not raise them. Both Claude and Codex record parse/file-version completeness and observed liveness. Recent unmatched open markers (within 15 minutes) are active, stale/missing/future ones unknown, and a terminal marker indicates observed inactivity. These states are not a retention or future-inactivity guarantee.

**Known gaps:**

- Codex's `state_5.sqlite` is not read.
- `token_usage_record` events and the paginated rollout format are not parsed yet.
- Rate-limit snapshots, tool exit codes and durations are recorded by Codex but not used.

## Cursor

**Where:** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (macOS) and the sibling `workspaceStorage` directory. Override with `--cursor-database PATH`; the `workspaceStorage` directory is located relative to that file, so on Linux you can point it at `~/.config/Cursor/User/globalStorage/state.vscdb` (not yet covered by tests).

**Format:** SQLite, opened read-only in a separate child process.

**Fields used:**

| Table and key | Fields |
| --- | --- |
| `cursorDiskKV` `composerData:<id>` | `composerId`, `createdAt`, `lastUpdatedAt`, `status`, `usageData.<model>.costInCents`, `isBestOfNSubcomposer`, `subagentInfo`, inline `conversation`. File references in `context`, `conversation`, `newlyCreatedFiles`, `newlyCreatedFolders`, `originalFileStates`, and `originalModelLines` are used only to find the repository. |
| `cursorDiskKV` `bubbleId:<composer>:<bubble>` | `bubbleId`, `type` (user or assistant), `tokenCount.inputTokens`, `tokenCount.outputTokens`, `toolFormerData.name`, `toolFormerData.toolCallId`, `timingInfo`, legacy `capabilitiesRan` names |
| `composerHeaders` table (current builds) | `composerId`, `workspaceId`, `lastUpdatedAt`, `isSubagent` |
| `ItemTable` `composer.composerHeaders` (older builds) | composer to workspace mapping |
| `workspaceStorage/<id>/workspace.json` and `state.vscdb` | workspace folder, and `composer.composerData` headers |

**Fidelity:**

| Measure | Fidelity |
| --- | --- |
| Tokens | Exact per session from bubble counters. No model attribution and no cache split, because bubbles do not record a model that can be joined to cost safely. |
| Cost | Reported: `usageData.costInCents`, kept separate from API-equivalent values. Not plotted by day, because the store has no per-call cost timestamps. |
| Pricing coverage | Not applicable. |
| Tools | By name, once per `toolCallId`; legacy `capabilitiesRan` names are added as recorded. |
| Compactions, effort | Unavailable. |
| Sub-agents | From `isBestOfNSubcomposer`, `subagentInfo`, or the header's `isSubagent` flag. |

**Known gaps:**

- Cursor SDK and agent transcript sources are covered separately below; their fidelity differs from this database.
- Composers whose files and workspace cannot be mapped are grouped under an unassigned local directory.

## Conductor (optional enrichment and history recovery)

**Where:** `~/Library/Application Support/com.conductor.app/conductor.db` (macOS). Override with `--database PATH`. A missing database is normal and changes nothing about provider discovery.

**Format:** SQLite, opened read-only.

**Fields used:**

| Table | Fields |
| --- | --- |
| `repos` | `id`, `name`, `root_path`, `remote_url`, `default_branch`, `hidden` |
| `workspaces` | `id`, `repository_id`, `workspace_name`, `workspace_path`, `branch` |
| `sessions` | `id`, `status`, `agent_type`, `title`, `created_at`, `updated_at`, `claude_session_id` (the provider session ID), `model`, `is_hidden`, `workspace_id` |
| `session_messages` | `id`, `session_id`, `created_at` when present; allowlisted SDK `assistant`, `result`, `system/init` and `conversation_reset` metadata in `content` or `full_message`; optional `sdk_message_id` |

Session titles, workspace names, branches, root paths, and remotes are loaded for correlation inside the analysis process and are never returned.

**What it adds:**

- workspace paths mapped to repositories, including repositories whose workspaces live outside the repository root;
- registered repositories with zero sessions, so they still appear in comparisons;
- hidden flags for `--exclude-hidden`;
- live status: sessions marked `working` are flagged as snapshots whose totals may still move;
- a model fallback when a transcript records none;
- `--repo-remote` matching, since remotes are only known for registered repositories.

**Known gaps:**

- A result-only session cannot recover missing tools, user messages, request counts, execution kind, or request times. Result `num_turns` counts SDK loop turns, not human turns.
- Missing/malformed messages, unrecognized agent types, or results whose provider ID conflicts with the registered row do not become evidence. Assistant metadata is projected inside SQLite for message recovery; user/assistant prose, reasoning and tool arguments/results are never selected into JavaScript row objects.

**Message recovery:** when native Claude evidence is absent, assistant usage takes precedence over receipt totals. Native and recovered streams share cache/TTL normalization and final/max-output snapshot selection. Tools deduplicate by tool-use ID; explicit `parent_tool_use_id` and sidechain markers attribute subagent requests. Request timestamps prefer the recorded timestamp, then the database event timestamp, never the session update date. Results are compared on their existing conservative cumulative scope, not added to recovered value. Stripped response IDs use conservative groups of matching input counters within each agent; SDK record UUIDs are not response IDs. Missing identities and missing usage are exposed, and retained message history remains partial. Conductor Codex rows never use Claude SDK recovery.

**Result fallback:** canonical native evidence wins. All remaining rows are collected before grouping by the result's provider identity, including legacy rows without a registered ID. UUIDs (message IDs when absent) deduplicate receipt copies; they do not identify independent accounting periods. Rows that disagree about repository attribution use an explicit unassigned group. This parser supports verified Claude SDK results; other providers' superficially similar result envelopes require separate scope verification.

Cumulative totals use the final valid snapshot per proven interval, not the sum of receipts. `system/init` UUIDs and `claude_code_version` establish supported process/version boundaries; explicit `conversation_reset` links admit changed identities. Older verified process intervals can be disjoint; restored resumes overlap earlier totals. Unknown or conflicting histories retain a partial observed snapshot. Zeroed crash results preserve earlier evidence. Counter decreases alone never prove a reset. The [official SDK scope guide](https://code.claude.com/docs/en/agent-sdk/cost-tracking#accumulate-costs-across-multiple-calls) documents version-dependent resume behavior.

Only scalar counters, bounded model IDs, and fixed enums leave the parser. Turn-local `usage` is separate from cumulative `modelUsage`. SDK turn/duration/denial counters become null across multiple receipts because their scopes are not established. Receipt/error/terminal-reason counts remain independent of accounting. There is no inferred request count, tool count, per-request daily spend, or task-success verdict. The cumulative receipt value is **session-dated** at the selected receipt's time, so Summary and Velocity include it with that label. See [metric definitions](metrics.md#additional-provider-evidence).

## Cursor SDK through Conductor

**Where:** `~/Library/Application Support/com.conductor.app/cursor-sdk-store`, or `--cursor-sdk-root`. Format verified read-only against local store shapes; fixtures contain only synthetic records.

**Identity:** `agents.ndjson` supplies `agentId`, `cwd`, and created/updated timestamps. Each directory is traversed once for runs and once for events. Identity-scoped projections retain only compact counters, bounded model/tool labels, and private correlation IDs; rescans rebuild them. Latest run snapshots are retained; raw event bodies and SDK metadata are discarded.

| Store | Fields retained for analytics |
| --- | --- |
| `runs.ndjson` | `agentId`, `runId` for correlation; `model.id`, `status`, `createdAt`, `updatedAt`, `startedAt`, `endedAt`; `usage.inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens` |
| `run_events.ndjson` | `payload.type: sdk_message`, then `message.type: tool_call`, `agent_id`, `run_id`, `call_id`, `name`; no arguments/results |

**Fidelity:** run-level **Reported** token counters; **Estimated** API-equivalent value for exact rate-card matches. Activity dates are **run-level**: each run's value is dated by its own `startedAt` (else `endedAt`, else `createdAt`), tool calls by their event `createdAt` (else their run's time); a run without a time is **session-dated**. Local checks confirmed total tokens equal input + cache read + cache write + output, with reasoning inside output. Tool lifecycle records count once per run/call ID. One started run counts as one observed run turn. Missing tool-event files preserve run summaries with tools labeled unavailable. Requests, assistant-message counts, per-request context sizes, and per-request cost allocation are unavailable. Aggregate long-context uncertainty is carried in the upper estimate. No new model rates or aliases are guessed.

## Cursor agent transcripts

**Where:** `~/.cursor/projects/*/agent-transcripts/**/*.jsonl`, or `--cursor-transcript-root` pointing at `projects`. Format verified locally: `role`, `message.content`, and structured `tool_use` blocks. Files are identified by the session UUID filename; no embedded ID is claimed.

**Fidelity:** **activity-only**. Count user text turns, assistant records, and distinct tool-use IDs/names. Models, tokens, pricing, and compactions are **Unavailable**. File mtime supplies the displayed date with `evidence.timing: file-mtime`; it does not establish duration or session start. Activity heatmaps exclude these dates, and the activity ledger keeps their tool calls **undated**; the records carry no times.

Encoded project directory names are matched only against known repository/workspace paths. Ambiguous or unmatched names produce a pseudonymous unassigned group; paths are never reconstructed by guessing. For an identical Cursor session ID, composer database evidence wins over SDK evidence, which wins over activity-only transcripts. These sources are not added together.

## GitHub Copilot CLI

**Where:** `~/.copilot/session-state/*/events.jsonl`, or `--copilot-root`. GitHub documents the [local session-state layout](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference).

**Verified schema:** the [SDK session event types](https://github.com/github/copilot-sdk/blob/19e9a4b9c620d1032110cb6739961c4c1a651278/nodejs/src/generated/session-events.ts) define the persisted envelope and `session.start` metadata. The recorded `data.sessionId` must match the containing directory; `data.context.cwd` and a valid start timestamp are required.

**Fidelity:** **activity-only**. Deduplicate by event ID, assistant message ID, and tool call ID. Count `user.message`, `assistant.message`, `assistant.turn_start`/`turn_end`, `tool.execution_start`, and successful `session.compaction_complete` markers. Arguments, message bodies, summaries, errors, and branches are discarded. [GitHub's event reference](https://github.com/github/copilot-sdk/blob/19e9a4b9c620d1032110cb6739961c4c1a651278/docs/features/streaming-events.md) marks per-call `assistant.usage` as ephemeral. Tokens, model attribution, and USD value remain **Unavailable** in this adapter; premium requests, multipliers, and AI credits are not dollars. Tool calls are **event-dated** in the activity ledger by each event's `timestamp`.

**Planned:** calibrate persisted shutdown `modelMetrics` token semantics and resume boundaries against primary-source receipts before importing usage totals. This adapter intentionally does not price transient usage or assume every saved session has complete shutdown counters.

## OpenCode

**Where:** `$XDG_DATA_HOME/opencode/opencode.db`, defaulting to `~/.local/share/opencode/opencode.db`, or `--opencode-database`.

**Verified schema:** OpenCode **v1.2.24**, [`session.sql.ts`](https://github.com/anomalyco/opencode/blob/v1.2.24/packages/opencode/src/session/session.sql.ts), [`message-v2.ts`](https://github.com/anomalyco/opencode/blob/v1.2.24/packages/opencode/src/session/message-v2.ts), and the [`finish-step` writer](https://github.com/anomalyco/opencode/blob/v1.2.24/packages/opencode/src/session/processor.ts).

| Table | Fields used |
| --- | --- |
| `session` | `id`, `directory`, `parent_id`, `time_created`, `time_updated` |
| `message` | `id`, `session_id`; JSON `data.role`, `modelID`, `time.created/completed`, `tokens.input/output/reasoning/cache.read/cache.write` |
| `part` | `id`, `session_id`, `message_id`, `time_created`; JSON `data.type`, step `tokens`, tool `callID`/`tool` |

**Fidelity:** reported request counters, API-equivalent pricing, observed user/assistant records and tools. Step-finish records preserve each request; assistant snapshots retain the last step and are used only when no step counters survive. [`getUsage`](https://github.com/anomalyco/opencode/blob/v1.2.24/packages/opencode/src/session/index.ts) normalizes disjoint input/cache classes. Reasoning stays inside output. No provider `cost` value is added to API estimates. Activity dates are **request-level**: step-finish `time_created`, else the message's `time.created`. `parent_id` identifies subagent execution. Unknown rates stay unpriced. SQL connections are read-only; malformed JSON is skipped without echoing it.

**Planned:** older directory-based storage and later incompatible SQLite generations. Unsupported table layouts produce a fixed warning; the adapter does not infer schemas from arbitrary JSON keys.

## Gemini CLI

**Where:** `~/.gemini/tmp/*/chats/session-*.json` and `.jsonl`, or `--gemini-root` pointing at `tmp`.

**Verified schema:** [chat record types](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/services/chatRecordingTypes.ts) and [recording/replay service](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/services/chatRecordingService.ts). Metadata requires `sessionId`, `projectHash`, and `startTime`; records use `id`, `type`, `timestamp`, `model`, `tokens`, and structured `toolCalls.id/name`. JSONL metadata updates/checkpoints, message replacements, rewinds, removals, and ordering are replayed into a content-free projection. Content and result patches cannot enter metrics. During format migration, JSONL wins over a JSON copy of the same session.

Project assignment follows the [project registry and ownership markers](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/config/projectRegistry.ts): the sibling `projects.json` maps absolute roots to slugs, and `.project_root` records ownership. The provider project hash must match the proposed root. Known local repository roots can also resolve legacy hashed directories; unresolved projects remain pseudonymous and unassigned. The [storage implementation](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/config/storage.ts) establishes these locations.

**Fidelity:** reported retained-message counters and observed tool/turn counts. Activity dates are **message-level** from each message's `timestamp`; a message without one is **session-dated**. Input includes cache reads; total output adds separately recorded thought tokens. `kind` distinguishes explicit main/subagent evidence. Removed history is not recoverable. The current rate card has no Gemini entries, so usage is visible but unpriced until a reviewed rate is supplied. Monolithic JSON larger than 32 MiB is skipped; JSONL is streamed. Compaction counts are unavailable.

## Source overrides and isolation

Every added store has its own explicit option and `SESSION_ANALYTICS_*` variable, listed in [README](../README.md#options). Defaults discover all supported providers independently of Conductor. `--no-additional-providers` (or `SESSION_ANALYTICS_ADDITIONAL_PROVIDERS=0`) disables the five additional default stores; explicit new-store paths still run. It does not disable the result fallback inside a selected Conductor database. Missing optional stores are normal. New adapters emit fixed warnings for inaccessible/unsupported stores, continue with other sources, never follow child-directory symlinks, and perform no network requests.

- Deleted Claude transcripts can use Conductor assistant metadata, then result receipts as a fallback. Other provider aggregates need independently verified accounting scopes.
- Agent types other than Claude Code and Codex in Conductor are reported as unsupported evidence. Unknown agent names use the fixed public provider `unsupported`; raw names are omitted. These rows round-trip through interchange and remain outside sharing eligibility.

## Adding a provider

See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-provider) for the checklist. A new source needs a discovery rule with an explicit override option, an identity check, a parser that only accumulates allowlisted counters, fixtures with sentinel content, and a section on this page.

### Review hardening and resource limits

OpenCode forks copy old messages/parts under fresh IDs. The adapter uses retained message timestamps and compact stable evidence fingerprints to identify inherited ownership before pricing; inherited requests are counted only at their original session/date. If original ownership is missing or timestamps are absent, copied usage is excluded and accounting is partial. New requests after fork creation remain eligible. Namespaced models retain their exact identity for rate lookup.

Gemini partial reorder patches preserve the unmentioned prefix before the explicitly ordered suffix, matching the pinned replay implementation. Legacy JSON is read/projected once. Legacy files larger than **4 MiB**, replays exceeding **20,000 retained messages** or **50,000 tool references**, and oversized individual projections are rejected with fixed warnings. JSONL line buffering is bounded before parsing (4 Mi characters for Gemini); skipped malformed/oversized records mark accounting partial. Large unsupported histories need a streaming/disk-backed replay implementation before these limits can be raised. The synthetic memory probe reserves earlier-provider heap and checks budget rejection under the production 256 MiB cap; this does not establish total-worker heap headroom.

## Velocity evidence

All three adapters populate compact velocity counters at the same counting points as
existing session totals. Claude entrypoint and fixed subagent attribution enums, and
Codex source/originator enums, provide finer agent groups without exporting custom names.
Per-request model, effort and execution stay attached to their activity cells, including
model/source changes inside a Codex rollout. Cursor provider value stays undated, while
only bubbles with absolute start timestamps contribute dated tokens/tools. The additional
sources date their cells as finely as they record time (request, message, event or run);
value without its own time is session-dated, see [Session-dated value](metrics.md#session-dated-value). The full
[velocity definition](metrics.md#velocity-snapshot-version-1) covers local timezone/DST
behavior, unavailable cache/reasoning fields and the session-start denominator.
## MCP coverage refinements

Provider discovery projects only source status enums and read/missing/unreadable counts, independent of the selected sessions. Deduplicated Claude/Codex pricing retains dated eligible/priced token operands so budget coverage includes unpriced activity from older sessions. Profiles require settled lifecycle observations; missing evidence is unknown, including Cursor, and an orchestrator working flag overrides settled observations. These statuses describe recorded turns, not success or live process state. See [metric definitions](metrics.md#mcp-query-semantics).

### Correctness and incomplete evidence

Cursor SDK stores merge distinct runs across copies and keep the latest duplicate run snapshot. Recorded run time selects pricing evidence without inventing request-day allocation. Stable stream-event IDs can recover usage when final run counters are absent; such recovery remains partial. Valid canonical run counters take precedence. Native Cursor excludes empty drafts, preserves explicitly reported zero cost, and replaces stale inline bubbles with their current disk snapshots. Missing provider cost is unavailable, with incomplete cost coverage. Explicit transcript subagent ancestry is retained.

Gemini replay retains non-accounting message identities as rewind/order anchors and follows persisted metadata updates. Copilot's optional context is not required for session identity, and malformed starts do not hide later valid starts. OpenCode excludes inherited boundary-time responses and marks skipped malformed messages/parts as partial accounting. A broken or oversized provider file/store cannot erase already found sessions or prevent healthy siblings from being read; fixed warnings record the discovery gap.
