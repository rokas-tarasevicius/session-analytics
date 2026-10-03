# Product evidence audit

Research snapshot: **2026-10-02**. This is a proposal input, not a new provider adapter or a claim of fleet-wide coverage. See [product strategy](product-strategy.md). All observations below come from this checkout or read-only local shape checks. No real repository name, path, account identifier, session identifier, prompt, command, message, diff, or tool output is reproduced.

## Method and interpretation

The audit first read the public types, provider parsers, API server, CLI, dashboard source, architecture, metric definitions, privacy manifest, provider guide, roadmap, and contributor rules. It then checked real local stores without running the analyzer against the whole machine.

For each JSONL source directory, enumerate files, sort by modification time with path as the internal tie-breaker, and select at most 12 evenly spaced ranks including the oldest and newest. Read at most the first 1,000 lines per selected file. Skip lines larger than 4 MiB; skip malformed JSON without printing it. Output consists of an allowlist of field paths, presence counts, record-class counts, and generic source labels. Profile roots that resolve to the same Codex directory are deduplicated. This is a **purposive format sample**, not a random prevalence estimate. Modification time can reflect a copy, repair, or active write. Prefix sampling underrepresents late-turn results and long sessions. Files were live; separate checks can observe different aggregate totals.

SQLite connections use `mode=ro` and `PRAGMA query_only=on`. Schema inspection, row counts, and non-null aggregates cover the listed tables; message-shape checks read only the most recent 1,000 rows. Auxiliary JSON files are capped at 10 MiB, and command-history inspection at 1,000 records. Cursor SDK NDJSON uses the same 12-file/1,000-line limits. No provider directory is changed. Local audit scripts and sanitized JSON outputs are under `.lane/` for maintainer review, not part of the product or a persistent raw-data collection.

**A present field is not a positive event.** `is_error: false`, a zero usage counter, or an empty array still establishes schema presence. Claude assistant rows include streamed copies: these denominators count inspected records, not unique requests. A zero count means “not observed in this sample,” never “unsupported by the provider.” Source-file discovery counts include supplemental and subagent JSONL; they are not validated session counts. In particular, 23 of the 36 selected Claude profile files were under `subagents/`. The Desktop sample contains supplemental records and only two files with assistant records.

| Source | JSONL files discovered | Files sampled | Parsed object records | Files reaching 1,000-line cap |
| --- | ---: | ---: | ---: | ---: |
| Claude profile A | 108 | 12 | 3,194 | 1 |
| Claude profile B | 1,394 | 12 | 1,908 | 0 |
| Claude profile C | 266 | 12 | 4,605 | 1 |
| Claude Desktop | 37 | 12 | 158 | 0 |
| Codex active, after root deduplication | 4,630 | 12 | 475 | 0 |
| Codex archive | 10 | 10 | 3,440 | 1 |
| Cursor CLI transcripts | 80 | 12 | 347 | 0 |

No malformed records or oversized lines were encountered in that JSONL sample. The total discovery counts are point-in-time filesystem inventory, not retention-complete user history. This audit deliberately does not repeat the brief's 98.8% Codex coverage figure as a freshly measured result.

Field notation: prefixes such as `assistant.`, `user.`, `session_meta.`, and `turn_context.` select the record `type`; they are not additional JSON object wrappers. `event_msg[token_count]` selects `type="event_msg"` and `payload.type="token_count"`. `<model>` denotes a dynamic model key whose value was not emitted.

Availability labels used below:

- **S — shipped:** parser/public field or surface verified in code. This does not imply every provider exposes it.
- **O — observed, unparsed:** real local structure verified; no current public metric consumes it.
- **I — inventory only:** described in the shared brief or a schema, but the relevant populated field was not established in this bounded sample. An implementation spike must verify it.
- **X — independent evidence required:** not derivable from the current snapshot; needs another source or deliberate user configuration.

## E01: Current product and public contract

Evidence: [public types](../../src/types.ts), [analyzer](../../src/analyzer.ts), [server](../../src/server.ts), [CLI](../../src/cli.ts), [dashboard markup](../../src/public/index.html), [dashboard calculations](../../src/public/app.js), [package manifest](../../package.json).

| Capability | Verified implementation | Product consequence |
| --- | --- | --- |
| Discovery and identity | Claude profiles/Desktop, Codex active/archive profiles, Cursor SQLite, optional Conductor enrichment; provider identity/CWD checks and canonical Git-root grouping | Repository-first, cross-provider accounting is already the foundation; do not pitch it as future work. |
| Physical usage | `SessionAnalytics.tokens`, model usage, costs, `spendByDay`, priced-token coverage; Claude streamed snapshots and Codex broadcast-counter deduplication | Preserve request ownership and cost basis before adding further aggregations. |
| Execution shape | `metrics.{userTurns,assistantMessages,modelCalls,toolCalls,transportToolCalls,compactions,taskStarts,taskCompletions,queueOperations,delegatedAgents,durationMilliseconds,eventSpanMilliseconds}` | Derived consumption ratios and descriptive cohorts can start here; these fields do not identify successful tasks. |
| Context diagnostic | `metrics.{maxInputTokensPerCall,maxContextWindow,contextUtilizationPeak}` | A current diagnostic exists, but a context trajectory requires new request-level evidence. |
| Delegation | `executionKind`, `costByExecution`, Claude composite parent/subagent file sets, Codex execution-segment attribution | Existing subagent cost is an observed lower bound; it is not an agent dependency graph. |
| Skills/tools | `tools`, `transportTools`, normalized `skills`, `skillEvidence` | Claude skill calls are explicit; Codex skill reads are inferred; Cursor skills are unavailable. |
| Dashboard | Summary, Distributions, Activity, Costs, Models, Tools, Skills; repository and date controls; provider controls in applicable views; compare up to six repositories in Distributions | Navigation is organized around dimensions. There is no dedicated session detail, evidence ledger, saved comparison, or operational attention view. |
| Time | Overview labels its scope “Sessions started during …”; Activity counts starts by browser-local weekday/hour | Session cohorts, calendar-day cost, and active intervals must remain separate concepts. |
| API | `GET /api/health`, `GET /api/analytics`, refresh via `?refresh=1`; one cached snapshot promise | No metrics query protocol, persistent index, MCP server, background ingestion, or server-side saved views. |
| Privacy boundary | Field-by-field projection; worker processes; capped heaps; read-only stores; loopback binding, Host/Origin checks, strict CSP; no runtime network client in analysis | Extend these guarantees rather than adding upload-first infrastructure. |
| Identity/persistence | Repository display names and timestamps are public metadata; session/repository keys use truncated, unkeyed SHA-256; browser persists view/theme only | “Content-free” does not mean anonymous. Shared/team exports need a distinct projection and threat model. |
| Distribution | Private package; `.ts` bin; native Node TypeScript; Node >=24; no runtime dependencies; git checkout/link workflow | Published compiled npm, Homebrew, and a standalone binary are release work, not currently available distribution channels. |

## E02: Claude Code and Desktop JSONL

Across the three Claude profile samples: **36 files / 9,707 records**, including **3,871 assistant**, **2,368 user**, **7 system**, **90 PR-link**, **110 queue-operation**, and **6 cost-state** records. The table counts present fields against the relevant record class, not deduplicated requests or eligible tool types.

| Signal / exact source path | Observed presence | State and proposed use |
| --- | --- | --- |
| `assistant.message.id`, `.model`, `.usage.{input_tokens,cache_read_input_tokens,cache_creation_input_tokens,output_tokens}` | Each 3,871/3,871 assistant records | S: token accounting, model cohorts, deduplication keys; never publish raw message IDs. |
| `assistant.message.usage.cache_creation.{ephemeral_5m_input_tokens,ephemeral_1h_input_tokens}` | Each 3,871/3,871 | S: physical TTL-class token accounting. Presence does not establish nonzero writes. |
| `assistant.message.usage.output_tokens_details.thinking_tokens` | 3,041/3,871 | S: separately exposed thinking tokens; avoid treating unexposed thinking as zero. |
| `assistant.effort` | 3,869/3,871 | S: session effort fallback; a chronological effort-switch measure is additional work. |
| `assistant.requestId` | 3,870/3,871 | O: internal request-level reconciliation; raw ID must never leave parser. |
| `assistant.message.usage.service_tier`, `.speed` | 3,869 and 3,041 / 3,871 | O: pricing provenance/cohort flags after allowlist validation; do not infer invoice modifiers from a label alone. |
| `assistant.message.usage.server_tool_use.{web_search_requests,web_fetch_requests}` | Each 3,043/3,871 | O: hosted-tool counters; costs still need reviewed rate rules. |
| `assistant.message.usage.iterations` | 3,041/3,871 | O: iteration detail candidate; element schema and duplicate semantics remain unverified. |
| `assistant.message.stop_reason`, `.stop_details` | 3,043 and 1 / 3,871 | O: bounded stop-reason classes; raw details cannot be exposed. |
| `assistant.message.diagnostics.cache_miss_reason.type` | 34/3,871; 7 sampled files | O: provider-attributed cache misses. This is nested under `message`, not a top-level `diagnostics` object in the observed records. |
| `assistant.isApiErrorMessage`, `.apiErrorStatus`, `.error` | 2, 1, and 2 / 3,871 | O: API failure classes; field presence is not a measured failure rate. |
| `assistant.quotaLimits.{status,rateLimitType,resetsAt}` | Each 1/3,871 | O: sparse Claude quota snapshots; insufficient for continuous headroom prediction. |
| `assistant.attributionSkill`, `.attributionAgent`, `.attributionMcpServer`, `.attributionMcpTool` | 925, 1,945, 269, 269 / 3,871 | O: attributed usage cohorts; join/deduplicate before allocating token value. Raw agent identifiers remain internal. `attributionPlugin` was not observed. |
| `user.message.content[].is_error` on tool-result blocks | 1,663/2,368 user records | O: tool-result success/error indicator. Denominator must be joined result-bearing calls, not all user messages. |
| `user.permissionMode`, `.promptSource`, `.origin.kind`, `.mcpMeta` | 30, 30, 3, 6 / 2,368 | O: bounded workflow and origin categories; these are sparse on tool-result-heavy records. |
| `user.toolDenialKind` | 5/2,368; 3 files | O: denial categories, separate from generic tool failure. |
| `user.toolUseResult.{interrupted,timedOutAfterMs,returnCodeInterpretation,gitOperation}` | 885, 2, 9, 27 / 2,368 | O: interruption/timeouts, structured return interpretation, recorded Git operation. A Git operation is evidence of an attempt/event, not a merged change. |
| `user.toolUseResult.{structuredPatch,userModified,type}` | 39, 39, 17 / 2,368 | O: edit-size counters and human-modified flags; diff text and paths cannot leave the parser. Validate each tool's nested schema before counting. |
| `user.toolUseResult.{status,resolvedModel,totalDurationMs,totalTokens,toolStats}` | 4, 4, 1, 1, 1 / 2,368 | O: delegated-run receipt candidates; do not add their token totals to child transcripts without reconciliation. |
| `system.{hookCount,hookInfos[].durationMs,hookErrors,preventedContinuation}` | Each 5/7 system records | O: hook latency and blocked continuation; hook error text stays private. |
| `cost-state.{totalCostUSD,totalLinesAdded,totalLinesRemoved,totalAPIDuration,totalToolDuration,totalDuration}` | Each 6/6; 2 files | O: receipt/reconciliation candidates. Cumulative snapshots are not additive and their coverage is sparse. |
| `pr-link.{prNumber,prRepository,prUrl}` | Each 90/90; 9 files | O: internal PR linkage candidates. Repetition demands deduplication; return hashed evidence/counts, not these values. |
| `queue-operation.operation`, `.reason` | 110/110 and 17/110 | S for total queue-operation count; O for enqueue/dequeue/cancel/steering distinctions. |
| Record `version`, `entrypoint`, `isSidechain`, `agentId` | 8,586, 8,586, 8,586, 4,313 / 9,707 | Version/entrypoint O; some sidechain/agent identity is used internally already. CLI-version cohorts and explicit graph edges need new public projections. |
| `attachment.type` | 2,340/9,707 | O for structured attachment-family extraction; individual failed-MCP/environment/skill-list fields were not verified in this sample. |

Desktop adds **31 assistant records in two sampled files**. All 31 expose base/cache token fields; none exposes `output_tokens_details.thinking_tokens` in this sample. It should reuse compatible Claude shapes while preserving source coverage; it must not inherit a universal thinking-coverage claim.

**Inventory-only follow-up:** the brief describes compaction `compactMetadata.{trigger,preTokens,postTokens,durationMs}`, API retry `retryAttempt/retryInMs/error.connection.code`, Read line/truncation counts, WebFetch response/latency/bytes, WebSearch duration, and failed-MCP/hook/skill inventory attachments. Relevant populated fields were not established by this bounded sample. Zero hits do not invalidate the inventory. The first implementation task is to verify the exact record subtype and nesting, including whether Read fields live inside a tool-specific subobject.

## E03: Codex rollout evidence

After deduplicating profile aliases: **22 sampled files / 3,915 records**: 12 active files and all 10 archive files, with one archive truncated at the 1,000-line inspection cap. There are 22 `session_meta`, 63 `turn_context`, 573 `token_count`, 57 `task_complete`, 2 `turn_aborted`, and 315 `item_completed` records.

| Exact source path | Observed presence | State and proposed use |
| --- | --- | --- |
| `session_meta.payload.{cwd,id,source,originator,cli_version,git.branch,git.commit_hash,git.repository_url}` | Each 22/22 metadata records | S for identity/repository correlation and basic execution kind; O for CLI/originator cohorts and internal Git evidence. Paths, branches, remotes, raw IDs, and commit hashes must remain internal. |
| `turn_context.payload.{model,effort}` | Each 63/63 | S: model/effort; O for switch chronology. |
| `turn_context.payload.{approval_policy,sandbox_policy.type,collaboration_mode.mode}` | Each 63/63 | O: permission/sandbox/plan-mode cohorts. They describe configuration, not safety or successful planning. |
| `turn_context.payload.sandbox_policy.network_access` | 6/63 | O: explicit capability flag; absence is unknown. |
| `event_msg[token_count].payload.info.{total_token_usage,last_token_usage,model_context_window}` | Each 568/573; 21/22 files | S: usage and context diagnostic; retain broadcast ownership and baseline exclusion. Five token-count records lacked these populated fields. |
| `event_msg[token_count].payload.rate_limits.{limit_id,primary.used_percent,primary.window_minutes,primary.resets_at}` | Each 477/573; 19/22 files | O: window headroom and reset observation. `limit_id` needs bounded normalization/internal grouping, not arbitrary passthrough. |
| `…rate_limits.plan_type`, `.secondary.used_percent`, `.credits` | 471, 357, 26 / 573 | O: plan/window/credits metadata; snapshot age and account/profile ambiguity matter. |
| `event_msg[task_complete].payload.{duration_ms,time_to_first_token_ms}` | Each 9/57; 9 files | O: reported turn latency/TTFT on a subset. The existing parser counts task completions but drops these measurements. |
| `event_msg[turn_aborted].payload.reason`, `.duration_ms` | 2/2 and 1/2 | O: interruption/replacement categories, never a standalone failure label. |
| `event_msg[item_completed].payload.item.{exit_code,status,duration,parsed_cmd[].type}` | Each 20/315 items; 1 file | O: command completion/status, latency, parsed command classes. The eligible denominator is command items; the table's 315-item denominator only describes field discovery. Validate `duration` representation before converting units. |
| `event_msg[item_completed].payload.item.kind` | 3/315; 1 file | O: subagent activity category candidate; exact item type must be checked before interpreting `kind`. |
| Top-level `compacted` | 1 record | S: compaction count. No before/after context sizes established here. |
| `response_item[function_call].payload.{name,call_id}` | Each 720/720 | S: tool names/call deduplication; call IDs stay internal. |
| `response_item[custom_tool_call].payload.{name,call_id}` | Each 119/119 | S: code-mode transport/effective tool distinction. |
| `response_item[function_call_output].payload.output` and custom-tool equivalent | 720 and 118 records | O for local, opt-in output rules; raw output is content. Extracting a process exit code from prose belongs in P2, not default P0. |

**Inventory-only follow-up:** no `token_usage_record`, `thread_goal_updated`, structured `McpToolCall` result/error, `FileChange.changes`, or populated `task_complete.error.codex_error_info` field appeared in this small sample. Nor did it establish `source.subagent.thread_spawn.{depth,parent_thread_id}`, `forked_from_id`, or role/nickname metadata. The shared brief describes these shapes, and the code already recognizes a subagent source generally, but format-specific fixtures must precede product claims. Codex cache-write tokens are not in the shipped rollout accounting; a counterfactual upper estimate is not an observed write count.

## E04: Cursor local evidence

Evidence: [Cursor parser functions](../../src/analyzer.ts) and read-only store inspection.

- **S:** The existing parser reads `composerHeaders`, legacy header mappings, `cursorDiskKV` `composerData:*` records and `bubbleId:*` records. It uses composer identity/time, `tokenCount.{inputTokens,outputTokens}`, `toolFormerData.{toolCallId,name}`, and `usageData.<model>.costInCents`. Provider-reported cost remains distinct from API pricing and is not assigned to a day.
- **Observed local sparsity:** 3 `composerHeaders` rows, 6 total `cursorDiskKV` rows, only **1 composerData record and 0 bubble records**, plus 177 `ItemTable` rows. This machine cannot validate broad historical composer reliability or per-call timing coverage. The audit confirmed schema/counts, not populated bubble fields.
- **O:** Cursor CLI sample: **12/80 files, 347 records**. `role` and `message.content[].type` are present in all 347 records; `message.content[].name` is present in 286 records across six files. No top-level `timestamp` or `usage` was observed. This source can broaden tool/workflow inventory; it cannot support invented time-series or token totals.
- **O/I:** Cursor-through-Conductor SDK stores exist; see E05. Do not collapse a run, composer, and transcript into three sessions without identity reconciliation.

## E05: Conductor metadata, SDK results, and Cursor runs

The current analyzer uses Conductor for workspace/repository correlation, hidden status, working snapshots, registered empty repositories, and model fallback. It does **not** use SDK results as fallback usage evidence. The optional database is not the authority for discovery.

| Source / field | Read-only evidence | Availability and limitation |
| --- | --- | --- |
| `sessions` | 1,041 rows; `permission_mode`, `fast_mode`, `context_token_count`, `model` non-null on all; `claude_effort_level` on 891; `context_used_percent` on 787 | O beyond current enrichment. The actual effort column is `claude_effort_level`, not a generic `effort`. Stored context values may be current/stale snapshots rather than a time series. |
| `workspaces` | 851 rows; schema includes `derived_status`, `archive_commit`, `intended_target_branch`, `pr_title`, `branch` | I for populated outcome evidence; only schema was checked. No title, branch, commit, or workspace identity was output. |
| `session_messages` | 741,966 rows at schema/count audit time | A large mixed content store. Never ingest its rows wholesale into a public index. |
| `session_messages.content` JSON where `type="result"` | Latest 1,000 rows: 999 valid JSON objects, 2 result objects | O: results are stored in `content` in this sample. `full_message` was null in all 1,000 rows; assuming that column would silently miss receipts. |
| Result `total_cost_usd`, `modelUsage`, `usage`, `num_turns`, `is_error` | Each present in 2/2 observed result objects | O: provider receipts, turn counts, bounded terminal flags. Join to canonical transcript evidence; do not sum both. |
| Result `duration_ms`, `duration_api_ms`, `permission_denials`, `terminal_reason`, `ttft_ms` | None in those 2 result objects | I: listed in the brief, not established by this sample. Sparse sampling does not prove unsupported. |
| Cursor SDK `runs.ndjson` | 41 files discovered; 12 sampled; 39 records | O: top-level `status`, `model.id`, `createdAt` in 39/39; `startedAt` and `endedAt` in 33/39. |
| Cursor SDK `run_events.ndjson` | 39 files discovered; 12 sampled; 8,669 records; 7 files hit the line cap | O for presence of event stream and `createdAt` on every sampled record. The precise tool-call payload nesting was not established by the allowlisted probes. |
| SDK `usage.{input,output,cacheRead,cacheWrite,reasoning}` | No matches in 39 sampled runs under those exact paths | I: verify the actual version/nesting and receipt timing before promising token parity. |

## E06: Auxiliary usage, configuration, and limit stores

These sources are not consumed by the current analyzer. They can reconcile or enrich canonical events; they must not automatically become additive usage ledgers.

| Source / exact field family | Observed shape | Product use and constraint |
| --- | --- | --- |
| Claude `stats-cache.json`: `dailyActivity[].{date,messageCount,sessionCount,toolCallCount}` | Each present in 49 entries | O: coarse reconciliation, with scope/timezone/retention differences displayed. |
| Claude `stats-cache.json`: `dailyModelTokens[].tokensByModel`, `modelUsage.<model>.costUSD` | 28 daily-model entries; 8 model cost fields | O: provider-side aggregate comparison; receipt basis and model scope must be aligned. |
| Claude global configuration: `skillUsage`, `toolUsage`, `pluginUsage` | All three object fields present | O: installed/used extension inventory candidates. Keys may identify private tools or skills; default share projection should omit names. |
| Claude global configuration: `cachedUsageUtilization.five_hour.utilization`, `.five_hour.resets_at`, `.seven_day.utilization` | No populated match at these exact paths | I: inventory claim not confirmed in the inspected default config; other profiles or versions may differ. |
| Claude `settings.json`: `hooks`, `enabledPlugins` | Both present | O: configured-versus-observed inventory. Do not copy configuration values or hook commands; extract bounded counts/names only where justified. |
| Claude `history.jsonl`: leading `/command` token in `display` | 90/1,000 sampled records begin with slash | O for a bounded command-name extractor; this audit retained only the count. Never retain arguments or the rest of `display`. Treat as opt-in P2 local text extraction unless contract review explicitly approves a bounded identifier exception. |
| Claude Desktop plan usage history | JSON file exists and contains `samples` | I for exact window/utilization nesting: not established by this audit. Do not ship guessed field names. |
| CodexBar Claude/Codex history | JSON files exist with `version` and `accounts`; nested `usedPercent`/`resetsAt` fields observed | O for retained quota samples, I for complete adapter schema/identity/time normalization. Wildcard account keys were never emitted. Claude: 95 populated `usedPercent` and 92 `resetsAt` fields; Codex: 466 each. These are inspected nested fields, not a count of independent billing windows. |

Quota history is a separate, stale-able measurement stream. It is not safe to reconstruct official remaining tokens by subtracting local transcript tokens from an undocumented subscription allowance. Profile does not necessarily equal billing account; account joins require explicit evidence or local user configuration.

## E07: Codex local SQLite

No current analyzer code reads these stores. Their schemas provide promising independent checks and turn-level measures without parsing human text.

| Store/table | Population and verified fields | Proposed use |
| --- | --- | --- |
| `state_5.sqlite` / `threads` | 4,628 rows. `tokens_used`, `cli_version`, `approval_mode`, `sandbox_policy` non-null on all; `model` 4,554; `reasoning_effort` 4,551. Schema also includes `source`, `originator`, `agent_role`, `agent_nickname`, Git metadata and rollout pointers. | O: session inventory/reconciliation and configuration cohorts. Non-null is not nonempty/nonzero. Validate cumulative-token semantics before comparing with attributed rollout totals. Raw pointers, titles, previews and identifiers stay internal. |
| `thread_history_1.sqlite` / `thread_turns` | 6,794 rows; `status` populated on all, `duration_ms` on 5,982, `started_at` on 872, `completed_at` on 6,012; schema has rollout offsets and internal thread/turn keys. | O: completion/interruption statuses and reported duration. Low start-time coverage prevents assuming full active-interval reconstruction. Status values were not reproduced or verified as a closed enum in this audit. |
| `goals_1.sqlite` | File exists; there is no table named `goals` in the inspected schema. | I: goal data requires actual schema discovery. Do not implement against an assumed `goals` table. |

The state/rollout counts differ. This audit did not attempt to reconcile deleted, archived, copied, or actively changing entries; publishing their difference as lost sessions would be misleading.

## E08: Missing or independent evidence

| Desired conclusion | What is available locally | What is still required |
| --- | --- | --- |
| Actual invoice or subscription cash cost | API-equivalent tokens and some provider-reported receipt values | X: plan prices/periods entered by the user or an explicit authorized billing import, plus discounts, credits, tax, region and service-tier rules. |
| Verified merged/reverted/deployed outcome | Sparse `pr-link`, Git operation markers, workspace schema | X: local Git evidence and/or opt-in Git hosting/CI/deployment enrichment with confidence-ranked joins. A PR link does not prove a merge. |
| Quality, business value, time saved | Activity, latency, tool failures, input/output volume | X: independent evaluation, user labels, or product outcome evidence. No transcript-only productivity score is justified. |
| True task identity for matched cohorts | Repository/model/provider/effort, limited lifecycle metadata | X: explicit user task tags or consented classifications. “Same repository” does not guarantee comparable difficulty. |
| Actual CPU busy time or human attention | Event timestamps, some durations, sparse turn starts | X: instrumentation or explicit interpretation as observed intervals. A session span is not active compute time. |
| Agent-loop diagnosis, repeated command semantics, test command identity, file churn | Tool argument/result content exists locally | P1 keyed fingerprints can support equality-only repetition flags; P2 opt-in local rules can classify content into bounded counts. Neither proves failure or causality. Raw paths/commands never enter ordinary output. |
| Team organization, consent, comparable identity, cross-machine deduplication | One machine's history and pseudonymous local keys | X: explicit team policy, consent, import/export protocol, coarse cohort thresholds, and a separate sharing projection. Do not reuse unkeyed local hashes as a team identity scheme. |
| Complete context/cache/latency measurements for all providers | Uneven provider-specific fields and sparse stores | X: more fixtures and explicit capability/coverage labels. A missing signal is unavailable, never zero. |

## E09: Correctness and semantics prerequisites

These are code findings, not newly implemented changes. They should constrain feature promises and the first roadmap slice.

1. **Session cohorts and event windows differ.** `sessionsInWindow()` filters `createdAt`; `summarize()` then uses each selected session's full totals. The UI explicitly labels this as sessions started during a period. A session that begins before a period but spends tokens inside it is outside the cohort. A session that starts inside the period can contribute later spending. Exact period comparisons need event/day allocations; do not silently relabel the existing cohort total as period spend. The daily cost chart has its own day allocation semantics.
2. **Ratios need one shared missing-data contract.** `aggregate()` in the analyzer returns `cacheReadRatio = 0` for a zero denominator; browser `summarize()` returns `null`. Resolve this before exporting new ratios. Every ratio should carry eligibility and a minimum-activity guard; do not average percentages across sessions.
3. **Current context peak is a proxy.** `finalizeSession()` divides the largest observed request input by the largest reported context window. These maxima can belong to different requests/models. A true peak fill requires aligned request/window pairs and provider-defined limits; no universal warning threshold follows from this proxy.
4. **Fallback receipts can double-count.** Claude `cost-state`, delegated receipts, Conductor results, provider stats caches, and Codex state counters overlap canonical transcript evidence. Select or reconcile a basis; never add them merely because they exist.
5. **Execution graphs need identity and interval work.** Claude subagents are folded into a parent session; Codex can change execution kind mid-file. Counting session rows as independent simultaneous workers misstates concurrency. Use explicit edges and measured intervals, preserve unknowns, and distinguish tool wall time from overlapping delegated work.
6. **Existing context/source coverage is uneven.** A field's public presence does not prove observability across providers. Cursor reported cost has no safe day/model-token join; Codex cache writes are unobserved; Claude thinking can be unexposed. Unknown must propagate through comparisons and coaching.
7. **Metadata deserves a separate sharing design.** Repository names, tool/server names, precise timestamps, and stable unkeyed hashes can identify work. A content-free local snapshot is not a safely anonymous public/team export. Preview exact fields, use purpose-scoped aliases/keyed identity where needed, coarsen time, and aggregate before sharing.
8. **Freshness must be explicit.** The current server's refresh replaces a whole snapshot. New operational cards should display sample time, evidence age, and stale/unavailable states; a cached quota sample is not live remaining capacity.

For implementation acceptance, each proposed metric needs: an exact source mapping, duplicate/ownership rules, numerator and eligible denominator, missing-data semantics, sample-age semantics, privacy tier, allowlisted output fields, and synthetic sentinel fixtures. The [feature catalog](feature-portfolio.md) uses these evidence IDs to separate near-term derivations from adapter work and independent integrations.
