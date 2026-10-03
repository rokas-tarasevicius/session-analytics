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
| `assistant` | `effort`; `message.id`, `message.model`; `message.usage`: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`; `tool_use` blocks: `id`, `name`, and `input.skill` for the `Skill` tool only |
| `user` | whether `message.content` is non-empty text (to count human turns; tool results are not turns) |
| `queue-operation`, compaction and summary records | counted by type |

**Fidelity:**

| Measure | Fidelity |
| --- | --- |
| Input, cache reads, cache writes, output | Exact. Claude Code writes one record per streamed content block; the final snapshot of each `message.id` is used. |
| Cache-write TTL | Exact when `cache_creation` splits 5-minute and 1-hour writes; otherwise all writes are priced at the 5-minute rate. |
| Thinking tokens | Exact when `output_tokens_details.thinking_tokens` is recorded; otherwise they stay inside output and the session carries a warning. Thinking tokens are always priced as output. |
| Cost | Estimated: API list-price equivalent from the rate card. |
| Tools | Exact by name, once per tool-use ID. |
| Skills | Explicit, from `Skill` tool calls. |
| Sub-agent cost | Exact split: usage from `subagents/` files is sub-agent execution; usage in the main file is top-level. |
| Effort | As recorded on assistant records. |

**Known gaps:**

- Claude Code deletes local transcripts after its `cleanupPeriodDays` setting (30 days by default). History it has deleted cannot be analyzed.
- `stats-cache.json` and other provider-reported totals are not yet used for reconciliation.
- Git evidence in transcripts (branches, commit and pull-request records) is not used yet; see [M2](roadmap.md#m2-outcomes).
- Views do not yet show which profile a session came from.

### Claude reliability evidence

The streaming reliability adapter also joins `tool_use.id` to user `tool_result.tool_use_id` and reads `is_error`, `toolDenialKind`, and single-result `toolUseResult` interruption/timeout, explicit duration, success/status and exit-code interpretation fields. `stop_hook_summary` supplies hook counts, blocks and individual hook durations; attachments supply failed MCP server names; permission modes and API error enums are allowlisted. Text-derived error classes, shell command classes and argument/path matching require the P2 option. Results and arguments never enter the public projection. Async/background launch acknowledgments stay unknown even with explicit successful receipt fields. A linked terminal result is required. Main and subagent streams are independent for sequence rules; any truncated or orphan-result stream suppresses composite verification; see [reliability metrics](metrics.md#reliability-m1).

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
| `event_msg` | `payload.type`: `user_message`, `agent_message`, `task_started`, `task_complete`, `context_compacted`, `item_completed` (`item.type` of `UserMessage`, `AgentMessage`, or `ContextCompaction`, and `item.id`), and `token_count` (`info.total_token_usage`, `info.last_token_usage`, `info.model_context_window`) |
| `compacted` | counted as a compaction |
| `response_item` | `function_call` and `custom_tool_call`: `name`, `call_id`. A `custom_tool_call` input is scanned for code-mode `tools.<name>(` invocations. The input of a read-capable call (`exec_command`, `read_file`, `Bash`, `Read`, or a code-mode call to one of the first two) is scanned for `<skill>/SKILL.md`. Only tool names and skill identifiers are kept. |

**Fidelity:**

| Measure | Fidelity |
| --- | --- |
| Input, cached input, output, reasoning output | Exact per request from `last_token_usage`, deduplicated across files that received the same process-wide snapshot. |
| Cache writes | Unavailable. The ordinary estimate prices uncached input at the base rate; the upper estimate adds the cache-write premium to all uncached input. |
| Cost | Estimated: API list-price equivalent, with long-context modifiers applied per request. |
| Tools | Exact by name, once per `call_id`. Code-mode calls are expanded to the inner tool names; the transported calls are kept separately as `transportTools`. |
| Skills | Inferred lower bound: at most one invocation per call and skill when a read-capable call references a canonical `SKILL.md`. |
| Turns, messages, compactions | Exact; the largest count among the legacy, `item_completed`, and `compacted` shapes. |
| Sub-agent cost | Exact split by the execution segment active when each request was observed. |
| Model | From `turn_context`; when a request precedes any model record, the file's single model is used if it has exactly one. |

**Known gaps:**

- Codex's `state_5.sqlite` is not read.
- `token_usage_record` events and the paginated rollout format are not parsed yet.
- Rate-limit snapshots are recorded by Codex but are not used by the reliability lane; see [M1](roadmap.md#m1-reliability-and-economics).

### Codex reliability evidence

`item_completed` items of type `CommandExecution`, `McpToolCall` and `FileChange` contribute outcome evidence. Command argv arrays, `parsed_cmd` enums (and P2-gated structured read paths), `{secs,nanos}` durations, exit codes, MCP status and `result.isError` are supported. Function/custom call outputs may contain structured receipts or text blocks; text receipt rules require P2 and inspect only recognized metadata before the output body. Explicit running receipts cannot complete a command. Receipt evidence remains content-free while waiting for late calls. MCP identities include the server across all shapes. `turn_context.approval_policy` and `sandbox_policy.type` are allowlisted observation counts. Active turns suppress verification-skip claims. Wrapper completion is never attributed to inner calls; typed inner calls remain separate evidence. Call IDs join matching shapes; formats with unrelated identifiers remain a documented limitation. See [reliability metrics](metrics.md#reliability-m1).

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
| Skills, compactions, effort | Unavailable. |
| Sub-agents | From `isBestOfNSubcomposer`, `subagentInfo`, or the header's `isSubagent` flag. |

**Known gaps:**

- Cursor agent CLI transcripts (`~/.cursor/projects/*/agent-transcripts`) are not read yet.
- Cursor sessions run through Conductor's Cursor integration are not read yet.
- Composers whose files and workspace cannot be mapped are grouped under an unassigned local directory.

## Conductor (optional enrichment)

**Where:** `~/Library/Application Support/com.conductor.app/conductor.db` (macOS). Override with `--database PATH`. A missing database is normal and changes nothing about provider discovery.

**Format:** SQLite, opened read-only.

**Fields used:**

| Table | Fields |
| --- | --- |
| `repos` | `id`, `name`, `root_path`, `remote_url`, `default_branch`, `hidden` |
| `workspaces` | `id`, `repository_id`, `workspace_name`, `workspace_path`, `branch` |
| `sessions` | `id`, `status`, `agent_type`, `title`, `created_at`, `updated_at`, `claude_session_id` (the provider session ID), `model`, `is_hidden`, `workspace_id` |

Session titles, workspace names, branches, root paths, and remotes are loaded for correlation inside the analysis process and are never returned.

**What it adds:**

- workspace paths mapped to repositories, including repositories whose workspaces live outside the repository root;
- registered repositories with zero sessions, so they still appear in comparisons;
- hidden flags for `--exclude-hidden`;
- live status: sessions marked `working` are flagged as snapshots whose totals may still move;
- a model fallback when a transcript records none;
- `--repo-remote` matching, since remotes are only known for registered repositories.

**Known gaps:**

- Conductor's per-session result records (turns, durations, reported cost) are not yet used as fallback evidence when a provider transcript has been deleted.
- Agent types other than Claude Code and Codex are reported as unsupported.

## Adding a provider

See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-provider) for the checklist. A new source needs a discovery rule with an explicit override option, an identity check, a parser that only accumulates allowlisted counters, fixtures with sentinel content, and a section on this page.
