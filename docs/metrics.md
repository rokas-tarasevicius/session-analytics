# Session analytics metric and interpretation catalog

This reference defines the privacy boundary, current metrics, and candidate extensions for the local session analytics dashboard. Update it together with parser tests whenever a metric changes meaning.

The [product proposal's metric contracts](proposals/metric-contracts.md) define candidate formulas, denominators, missing-data rules and synthetic worked examples for future work. They do not change the current schema or calculations. The [evidence audit](proposals/evidence-audit.md#e09-correctness-and-semantics-prerequisites) records implementation prerequisites, including session-start cohorts versus event windows, zero-denominator consistency, and request-aligned context fill; these findings remain unfixed by the documentation-only proposal.

## Evidence boundary

The analyzer may read provider transcripts locally, but its returned data is restricted to:

- a stable local repository key and display name;
- a one-way hashed local session key, provider, status, and timestamps;
- provider session identity and workspace CWD used internally only for correlation;
- model and reasoning-effort identifiers;
- physical token counters and context-window sizes;
- event-class counts and timestamps;
- tool names and stable call IDs, never arguments or results;
- normalized skill identifiers derived from explicit Claude `Skill` events or canonical Codex `SKILL.md` reads, never skill arguments or paths;
- transcript file count, validation status, and bounded parser warnings;
- costs derived from the versioned rate card.

The CLI JSON, API, dashboard, and MCP tools must not return prompts, messages, reasoning, session titles, branches, workspace metadata, repository roots/remotes, raw Conductor IDs, provider session IDs, tool arguments, tool results, commands, file paths, transcript paths, process arguments, credentials, raw local errors, or arbitrary environment output.

The default scope is the union of supported local Claude, Codex, Cursor, Copilot CLI, OpenCode, and Gemini CLI history. It is evidence-led rather than application-led or a blind filesystem crawl: provider working directories, Cursor workspace/file references, optional Conductor workspace mappings, and canonical Git roots determine repository assignment. Provider discovery must work without Conductor. When its database is available, Conductor adds repository/workspace correlations and registered zero-session repositories but does not define the machine boundary. Repository summaries and a single flattened session collection share stable repository IDs; sessions are not duplicated inside public repository objects.

Every provider profile on the machine is in scope: `~/.claude/projects`, sibling profiles such as `~/.claude-work/projects`, `$CLAUDE_CONFIG_DIR/projects`, `~/.config/claude/projects`, and Claude Desktop local-agent sessions; `~/.codex/{sessions,archived_sessions}`, sibling `~/.codex-*` profiles, and `$CODEX_HOME`. Roots that resolve to the same directory through symbolic links are read once. An explicit root option replaces discovery for that provider, so narrowed and synthetic scans never mix in the machine's own history.

Provider transcript stores are canonical evidence that a session can be analyzed. Conductor SDK results can recover a lower-fidelity session only after canonical discovery and unique legacy matching have failed. Rows without either kind of validated evidence remain excluded. A legacy row without a provider ID is first matched through a unique provider, working-directory, and start-time match. Fallback never supplements an existing canonical identity, so database stubs and copied summaries cannot inflate its totals.

An existing content-free index extends that evidence with previously validated sessions whose sources were removed. These are marked `transcript.sourceDeleted: true`, counted in ordinary totals, and retain their last observed facts, pricing, and parser semantics. The mark describes source availability, not session outcome, recency, or quality. An unreadable source is not proof of deletion: prior facts can be shown with a fixed availability warning. `--no-index` excludes all retained history and performs the present-evidence full scan. Rebuild cannot recover sources already removed.

Repository and machine warnings count source-deleted sessions beside the totals. Dashboard retention counts follow the selected repository/date window; scan-wide deferral and availability warnings remain visible across views. Frozen-pricing qualifications appear beside summary totals and the shared view context. `workingSnapshots` excludes source-deleted and unavailable historical observations. Their stored status and `snapshotWhileWorking` still describe the last source observation, not current activity. The browser derives P0 `retainedSessions` and `historicalWorkingSnapshots` counts locally without adding snapshot fields.

The index does not change current-evidence metric definitions. Parity tests require indexed and full-scan snapshots to match exactly except generation time when sources, rate card, and retention are unchanged. File/group fingerprints invalidate changed Claude composites. Codex counter ownership is recomputed across the evidence union from cached per-file facts; a changed owner invalidates both affected sessions. Retained and pruned owners reserve already-attributed counter states so they do not migrate into surviving receivers' totals. Retained facts cannot be repriced exactly from model aggregates because long-context rates apply per request; a fixed warning states that their prices remain those from their last successful ingest.

Outcome-bearing sessions use the same accounting path. The schema accepts existing artifact and observation hashes (`branch`, `commit`, `pr`, `commit-event`, `pr-event`, `workspace-pr`; the legacy `pull-request` prefix remains readable). An index projection/storage failure cannot become an invalid transcript or a retry with already-claimed counters: the entire ingest rolls back and fresh full-scan accounting runs with a fixed warning. This fallback omits source-deleted retained history and does not change the retention floor on disk.

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
- largest per-call input and configured context window, used for context insight eligibility, never as a performance score.

Codex input is request-context consumption, not unique transcript text: the same cached context is counted again whenever it is processed by another model call. Codex also broadcasts the same process-wide `total_token_usage` snapshot into multiple session files. Deduplicate exact total/last-usage states across the full evidence union, attribute each state to the observing file whose nearest preceding local response event is closest, break equal scores by timestamp and path, and sum `last_token_usage`; never sum a process-wide cumulative delta once per file. When a state carries no usable `last_token_usage`, only a delta between two snapshots that same evidence file observed is attributable to it: treat the file's opening snapshot, and the first snapshot after the counter moves backwards, as a baseline that is recorded and excluded. Billing an opening snapshot charges a whole process history to one request, which lands the parallel work of many sibling sub-agents on a single session and on the calendar day that session started. This activity-backed ownership prevents an earlier stale receiver from taking a request generated by another repository or model. A new `session_meta` can change a file from sub-agent to top-level execution, so allocate each deduplicated request to the execution segment active at the owning observation. Claude cache creation and reads are separate physical counters. Attribute Claude main-file usage to top-level execution and usage from its `subagents` evidence tree to sub-agent execution before aggregating the composite session. Provider reasoning output remains included in output pricing.

### Execution shape

- user-visible turns;
- assistant/model responses;
- model calls inferred from distinct positive usage increments or response IDs;
- task starts and completions when the provider emits them;
- context compactions and summary boundaries (Codex user turns/assistant messages retain the largest representation count; compactions reconcile individual identities or equal UTC timestamps across representations, preserving distinct boundaries through client upgrades and exposing uncertain matches);
- effective tool calls by tool name;
- skill invocations by normalized identifier, with evidence labeled explicit for Claude, inferred lower bound for Codex, and unavailable for Cursor;
- transport/orchestrator tool calls before code-mode expansion;
- Claude queue operations and delegated-agent identities;
- session wall span and provider-event span;
- live versus terminal status when observable.

Machine views also include repository count, repositories with selected sessions, working-snapshot count, explicit top-level/sub-agent execution value, and per-repository comparison dimensions. Usage-value comparisons must show transcript and pricing coverage beside totals.

Tool names are useful for workload shape. Tool call counts do not prove useful work, failure, or causal responsibility.

Skill names are a reviewed derived field rather than raw tool input. Accept only bounded canonical identifiers. Claude exposes an explicit `Skill` tool with the skill identifier in structured input. Codex does not expose a dedicated skill event, so count at most one invocation per tool call and skill identifier when a read-capable call references a canonical `<skill>/SKILL.md`; label these counts as an inferred lower bound. Do not infer skill usage from system instructions, user messages, arbitrary transcript text, directory enumeration, or an installed-skill inventory. Cursor skill coverage is not applicable until its local history exposes a stable invocation signal.

### Evidence health

- provider evidence validation status;
- provider session ID and workspace CWD validation;
- transcript files in the evidence set;
- stable versus working snapshot;
- cumulative-counter monotonicity;
- malformed records skipped;
- unsupported provider, schema, or model price.

## Reliability (M1)

`sessions[].reliability` is an optional, versioned namespace for Claude and Codex. Cursor and unsupported/invalid sessions omit it. Its absence is **unavailable**, not evidence of successful calls. The terminal report and MCP tools aggregate the session projections; repository selection (and MCP agent/provider filters) recompute counts and percentiles. Accounting and the existing effective/transport tool counters are unchanged.

### Evidence and outcomes

Each observed call has one of `success`, `error`, `denied`, `interrupted`, `timeout`, or `unknown`. Missing, running or opaque results stay unknown. Claude calls join `tool_use.id` to `tool_result.tool_use_id`; streamed blocks and repeated results count once. A Claude result with no `is_error` is successful by that provider's result schema, except an asynchronous/background launch, which does not establish completion even when accompanied by `is_error: false`, success/status fields or a background task ID. Only independently linked terminal evidence can complete it; explicit failures, denials, interruption and timeout still take precedence. `toolDenialKind`, `interrupted`, `timedOutAfterMs`, explicit exit codes, and known `returnCodeInterpretation` statuses override a generic success. A top-level receipt accompanying multiple result blocks is not attributed to every call.

Codex reads `CommandExecution` (`exit_code`, `status`, `duration`), `McpToolCall` (`status`, `result.isError`, `error`, `duration`), `FileChange` and direct function/custom call receipts. Call/item IDs join shapes when identical; replayed completions count once. Typed durations accept `{secs, nanos}`; explicit numeric `duration`, `duration_ms`, `durationMs`, `totalDurationMs` are milliseconds, and `durationSeconds` is seconds. No latency is inferred from record timestamp gaps. Results before their calls retain only bounded numeric receipt evidence and enum rule candidates until the matching tool is known. Late shell, edit and MCP results then receive the same outcome/latency classification as in-order results. Unmatched results are counted separately without inventing a tool name or call; an out-of-order result does not establish execution ordering.

Code-mode wrappers remain separate `other` calls. Their completion never implies that the enclosed tools succeeded. Typed inner tool items, when present, are measured independently. Reliability call counts therefore differ from the existing expanded `metrics.toolCalls`. Unlinked formats with distinct call/item IDs cannot safely be deduplicated by arbitrary transcript text; this is a coverage limitation, not grounds to guess a join.

Outcome precedence on conflicting/replayed evidence is timeout, denial, interruption, error, success, unknown. **Error rate** is `(error + timeout) / (success + error + timeout)`. Denials and interruptions are displayed separately, not assigned as agent faults. Every rate displays its numerator and eligible denominator; fewer than **5** eligible observations gives `N/A`/`null`. Outcome coverage is `(calls - unknown) / calls`, always shown as counts. A tiny sample is not a ranking.

`tools[]` groups by `(name, toolClass)`. MCP tool names use the canonical `mcp__server__tool` identity across Claude, direct Codex and typed completions, and this same identity participates in repeat matching. Combined MCP names over 128 characters use a bounded prefix plus a 16-hex SHA-256 suffix derived only from the structured name; separate servers do not collapse into bare tool names. `mcp[]` groups by structured server name (including Claude `mcp__server__tool` names). A server seen only in `failedMcpServers` attachments gets zero calls and positive `connectionFailures`; connection failures are reports, deduplicated by attachment UUID, not inferred unique outage incidents. They are excluded from the tool error-rate denominator. Configured-but-unused server inventory and schema token cost are not inferred.

### Local content rules (P2, opt-in)

`--reliability-content-rules` or `SESSION_ANALYTICS_RELIABILITY_CONTENT_RULES=1` enables deterministic rules over tool arguments and failed result text. They are **off by default**. `--no-reliability-content-rules` overrides the environment. The UI and report display enabled-session coverage; there is no browser toggle that silently enables parsing. No LLM, network access, raw content, raw path, or matching digest is involved in the output.

The cross-provider ontology is `read`, `search`, `edit`, `write`, `shell`, `test_build`, `vcs`, `web`, `mcp`, `delegate`, `plan`, `other`. Structured tool names and Codex `parsed_cmd` read/search/list classifications work by default. With P2 enabled, shell commands are classified locally using argv0 and known test/build invocations (`npm test`, `npm run check`, `pytest`, `go test`, etc.). Current Codex argv arrays such as `[shell, "-lc", command]` are handled. Simple `cd … && check` sequences and environment assignments are recognized. Help/version/configuration-only, cleanup and dry-run invocations do not count as verification. Build frontends require recognized targets/subcommands (for example `make test`, `cmake --build build`, `ninja test`). Single `&` background execution, mixed command classes, substitutions, pipelines, unknown programs/targets and ambiguous shell forms stay `shell`; scripts are never executed or opened. An unfamiliar test runner may therefore be unrecognized. Classes are activity labels, not proof of the command's intent or effect.

Error classes are `not_found`, `edit_anchor_mismatch`, `permission_denied_user`, `permission_denied_policy`, `hook_blocked`, `timeout`, `command_not_found`, `nonzero_exit`, `test_failed`, `interrupted`, `api_rate_limit`, `api_server_error`, `mcp_error`, `unknown`. Text matching runs only on already-failed results; a successful grep/read of error text is not an error. `Exit code N`, `Process exited with code N` and wall-time receipts are recognized only in the metadata prefix, before `Output:`/`Final output:` or the first unrecognized line. Explicit running/yielded state vetoes completion and timing inference. Output-body lines cannot supply exit codes or timing; ambiguous receipts remain unknown. Only numeric codes/milliseconds survive for later tool-sensitive interpretation; shell envelopes never establish edit/MCP completion. Exit 127 is command-not-found; nonzero test/build calls are test-failed. Structured API error events are separate `apiErrors` counts, never fabricated tool calls. These classes distinguish observable failure modes without asserting root cause or assigning blame.

### Latency and coverage

`latency` contains `samples`, sparse `[upperBoundMs, count]` histogram `buckets`, `p50Ms`, and `p95Ms`. Positive durations round up to logarithmic buckets with factor **1.1**, then whole milliseconds (at most 10% + 1 ms error). Zero is a valid observed duration. Nonfinite, negative or implausible durations over seven days are discarded. Quantiles are nearest-rank upper bounds, labeled **≈**. Aggregation merges buckets and recomputes quantiles; it never averages session p95s. Missing timing stays null, with `samples / calls` beside each latency. Hook timing shows `samples / runs` instead.

`coverage.argumentCalls` and `coverage.fileCalls` count calls with usable internal argument/file HMAC evidence. They are not counts of unique files. `unmatchedResults` counts receipts without a matching call. `truncated` means malformed input or a bounded-parser safeguard was reached: at most 50,000 calls plus pending results, 200,000 deduplication event keys (IDs at most 512 characters), and 1,000 distinct failed-connection servers per execution stream. Any truncated constituent or unmatched result makes the whole composite session ineligible for flags, verification share and skip; observed counters remain. Hashing is bounded to 1 MiB, 10,000 values and depth 16 per call, plus a stream-wide budget of 32 MiB of charged canonical string bytes and 16,384 file-reference hash attempts. File extraction is incremental and checks limits before allocating/hashing references, with at most 1,000 references per call. A limit hit stops further hashing and marks the stream truncated while structured outcomes continue up to the call cap. These budgets leave heap space for accounting and serialization under the 256 MiB worker cap. Missing hash evidence never falls back to plain SHA-256.

### Behavior episodes

With P2 enabled, argument object keys are sorted before HMAC-SHA256; string values, command quoting and whitespace inside strings are preserved. Structured Codex `parsed_cmd` read paths enrich file matching, including when a completion augments an existing call; paths remain P2-gated and never public. Paths are resolved lexically against the recorded working directory and HMACed with a separate domain. No filesystem contents or symlink targets are read for this matching. Digests exist only during one execution stream and are never returned. Rules count **episodes**, not every overlapping window:

| Flag | Trigger | Reset / boundary |
| --- | --- | --- |
| `exact_repeat` | Third consecutive call with identical tool and normalized arguments | Different/missing fingerprint; one count for a longer run |
| `repeated_failure` | Third consecutive error/timeout with identical tool and arguments | Successful, denied, interrupted, unknown, or different call |
| `failed_edit_cascade` | Third consecutive failed edit/write to the same first referenced file | Different file or intervening non-failed-edit call |
| `edit_thrash` | Third successful edit/write to one file within 10 calls | A passing test/build, or count falls below 3 as the window advances |
| `reread_churn` | Third read of the same file within 10 calls | Successful edit to that file, passing check, or count falls below 3 |
| `search_loop` | Tenth read/search since the last edit/write or test/build | Any edit/write/check attempt; one episode for a longer streak |

Claude main and subagent files are independent streams. A parent's passing test cannot reset another agent's churn window, and unrelated calls cannot combine into a loop. A passing check resets a churn window only after it completes and only when it started after the window activity completed. Parallel checks and launch acknowledgments cannot clear edit thrash. Counts sum into the composite session. `flags` is null when rules are disabled, the private key is unavailable, or parsing is incomplete. A zero with sparse argument/path evidence is a lower bound; use the hash-coverage counts. Polling, exploration and deliberate incremental editing can all trigger flags. **Flags are prompts for inspection, not verdicts.**

### Verification, hooks and permissions

`verification.checks` counts recognized test/build calls; `passed` and `failed` count success and error/timeout outcomes. `editCalls` counts successful or unresolved edit/write calls (possible edits); known failed or denied edits are excluded. `share` is checks divided by checks + editCalls, with a minimum denominator of 5, P2 enabled and complete parsing. It is a share of recognized edit/check activity, not a success rate or percentage of code tested.

`skip` is true when a final edit has no subsequent or overlapping completed test/build attempt; false only when an observed check started after every relevant edit completed and then completed. Parallel/overlapping executions are null unless a later causal check resolves them. Call-start and terminal-result sequence numbers, rather than call insertion order, establish this ordering; duplicate receipts do not move the completion boundary. A typed completion without a linked start cannot prove non-overlap. Even a failed check is an attempted verification. No edits, disabled rules, incomplete parsing, working sessions, uncompleted Codex turns, unknown results, or opaque tools produce null. Composite Claude sessions require complete parsing and no unmatched results in every stream, plus execution-order eligibility in every stream with edits; a skip in any eligible stream marks the session. This describes the **observed tail**, not proof that a session permanently ended or that tests covered a change. `stepsToFirstEdit` counts preceding main-stream calls; `msToFirstEdit` uses first-event to first-edit timestamps, or null without timestamps/edits. Comparisons show a mean and its session count. No absolute speed or productivity verdict follows from these values.

`hooks.runs` comes from stop-hook summaries' `hookCount` (or the number of hookInfos); `blocks` counts summaries with `preventedContinuation`, not individual blocked hooks. Only reported hookInfo durations contribute latency. `permissions.denials` counts denied calls. `modes`, `approvalPolicies` and `sandboxes` are allowlisted **observation counts**, not time shares or approval prompt counts. Unrecognized labels become `unknown`. Permission approvals carry little signal, and interrupts rise with expert steering; neither is inherently failure. Plan rejection semantics and approval-prompt rates need separate evidence.

## Useful derived indicators (other areas)

The [trajectory metrics research proposal](proposals/metrics-research.md) defines 20 candidate measures with formulas, concrete source fields, observed local coverage, confounders, privacy tiers, validation plans and UI wording. Its companion [normalized event proposal](proposals/schema-v2.md) specifies joins and missing-data semantics. These are research designs, not additional current metrics or a change to the definitions above. Their thresholds are experimental; activity and sequence flags do not establish outcomes.

### Limits, cache, and context (implemented)

The optional snapshot `limitsCache` namespace carries profile quota timelines and monthly subscription comparisons; its session namespace carries cache economics, per-request context coverage/curves, daily model/execution buckets, cache-break flags and compaction detail. [Limits, cache, and context](limits-cache.md) defines every formula, source location, retention bound and guard, with configuration examples.

- Quotas are account-wide observations grouped by pseudonymous profile, never repository consumption. Same-source timestamp duplicates are removed independently of token ownership. `latestNumeric` retains its own fetch time and `headroomExpiresAt` deadline (15 minutes or reset); later allowed statuses cannot erase or refresh it. Contradictory rejection/reset evidence invalidates it, including ties. Exposure only covers adjacent numeric observations at most 15 minutes apart, clipped at resets; ratios need three numeric snapshots and five observed minutes. Time-to-limit is a guarded projection, not a promise.
- Cache hit share uses cache-read / all input tokens and needs three requests and 1,000 input tokens. Net savings compare the same input priced without caching to observed uncached/read/write value, with per-request long-context pricing and negative savings allowed. Missing prices or request input reduce coverage. Re-cache write value on flagged requests is counted once; flags are not causal claims.
- Context peak is the maximum paired per-request input/window ratio, replacing the ratio of two independent maxima. Codex windows are recorded; Claude windows are reviewed model capacities. Strictly-above-40/60/80% shares use eligible requests with a three-request guard. Missing compaction sizes stay null; intervals count human turns within a stream.
- Monthly leverage compares dated input-plus-output API-equivalent value with an explicitly configured full monthly USD plan price. Three active days, positive price and complete coverage are required. Plan type never supplies a price. There is no extrapolation or claim of cash saved.

Quota observations stay account-wide because quota is shared. Cache/context buckets carry request dates; compaction events carry their own dates even without usage that day, and still extend the dashboard's date-picker bounds. Unknown time is excluded from dated views/monthly comparisons, not fabricated from file modification time. Claude chronology compares normalized UTC instants with undated requests last. Reports include undated request totals. All cumulative fallbacks, including all-zero last usage, retain totals but are excluded from request context and counterfactual pricing.

Curve detail has a 240-point session cap and a 20,000-point snapshot budget; `curveSampled` covers either reduction. Aggregate counters, daily buckets and peaks use all eligible requests. `compactionCountExact` is false for missing timestamps or ambiguous representation matches; summary counts and event details use the same reconciliation. Model dimensions share the bounded identifier policy in [privacy.md](privacy.md); rejected values become `<unknown>` without losing observed totals.

### Further candidates

## Workflow: human and agent interaction

The optional `session.workflow` object covers Claude's **primary transcript** and individual Codex threads. A Claude sub-agent's prompt is an agent input, not a human decision: child files still contribute to existing accounting totals but never extend the parent's workflow clock, tools or mix. Codex child threads retain timing and concurrency, with `humanTurns: null` and no autonomy-run samples. Cursor and failed parses have no workflow object; missing evidence is not a zero-duration session. `MachineAnalytics.workflow` and single-repository `RepositoryAnalytics.workflow` aggregate the supported sessions. Existing metric and accounting meanings are unchanged.

### Autonomy and timing

| Measure | Definition and limits |
| --- | --- |
| Human turns | Distinct primary Claude user messages with text, excluding structured tool results, metadata, compact summaries and sidechain/agent-origin inputs. Codex selects the richer of legacy `user_message` events and distinct `UserMessage` items; it never sums both shapes. Untimed turns remain in counts. With Claude content rules off, text control markers can remain indistinguishable from human text. |
| Tools between human turns | Effective calls after each observed human input until the next, including zero-tool runs and the final observed run. Calls before the first human are unassigned. Codex chooses the richer of deduplicated response calls (including code-mode expansion) and typed tool items. If events are untimed or truncated, run samples are unavailable rather than silently spanning a missing boundary. |
| `WorkflowHistogram` | Exact discrete `{value,count}` bins; `samples` is the sum of counts. p50 and p95 use nearest rank (`ceil(p × n)`), `max` is the maximum. Empty samples return null, including a null maximum. Aggregate percentiles pool bins, never average session percentiles. Tool samples are counts; turn samples are milliseconds. |
| Turn wall time | Prefer positive finite provider `task_complete` / `turn_aborted.duration_ms` or Claude `system/turn_duration.durationMs` (up to 7 days). Otherwise pair starts/human inputs with terminal markers. Claude/legacy histories can infer a turn end from the final assistant event before the next human or file end; open explicit turns are excluded. The number of provider durations and event-derived spans is always exposed. A later Claude duration replaces its inferred end once; final streamed end markers use their latest timestamp. Wall time includes permission/tool waiting. |
| Agent activity (estimated) | Sort recognized human, start, assistant, tool, result and terminal events by normalized ISO timestamp. Join consecutive gaps **≤5 minutes**, except after a terminal event or between two human inputs. Coalesce adjacent intervals within a session. There is no guessed leading/trailing duration. Long sparse tool calls may be undercounted. Broadcast Codex token snapshots, metadata-only records and queue bookkeeping never create activity. |
| Waiting for human (estimated) | A terminal marker followed by the next human with no intervening work supplies `min(gap, 30 minutes)`. Unrecorded completion cannot prove waiting. This does not measure a person's attention or labor. |
| Idle/unclassified | First-to-last recognized event span minus agent-active and capped human-wait intervals. The three partitions sum to the observed span. Unobserved time before/after the transcript is not extrapolated. Permission waiting remains unavailable. |
| Coverage | `timing` is `observed`, `partial` (missing timestamps, a cap, malformed primary records or projection failures), or `unavailable` (no positive event span). `timestampedEvents`, `untimedEvents`, `droppedEvents`, `malformedRecords` and `projectionErrors` expose the corresponding counts without error text. Any partial lifecycle suppresses tool runs, inferred turn spans, activity/waiting estimates, mid-turn steering and abandonment; independently recorded durations remain labeled. Observed counters are lower bounds. `humanTurns` coverage is `partial` when records/signals were lost. Claude child-file gaps are excluded and separately warned. Processing stops after 100,000 signals or dedupe identities; metadata caps at 10,000. |
| Ending | `terminal`: accepted explicit completion; `interrupted`: accepted abort; `inferred`: final assistant without an open explicit task; `open`: no observed ending; `unavailable`: incomplete evidence or no timed work events. Ending, waiting, activity and abandonment all use the accepted lifecycle stream. Mismatched or previously closed turn markers never advance the current activity clock or supply completed-session comparison evidence. These are evidence labels, not success labels. |

Human turns per session uses the eligible primary-session denominator and is null below **5 sessions**. Interruptions per human turn is null below **5 eligible turns** and uses Codex plus Claude sessions with enabled marker rules only. It is an event frequency, not a success/failure percentage; sub-agent interruption notifications are separate. Histograms show their sample counts even for small samples; a p95 of one observation has no population-level significance.

Item-only Codex tool histories locate calls at their completion timestamps; a call finishing after human steering can fall in a later observed run. Selecting the richer lifecycle shape avoids duplicate inflation but can undercount a file that changes formats mid-session. These are observations with coverage limits, not a measure of independence or work quality.

Legacy human notifications deduplicate by a nonempty stable UUID/message ID when present, otherwise by record ordinal. Equal timestamps do not establish identity: two inputs at one timestamp contribute two turns and preserve zero-tool runs. All workflow enum/reason validators require strings; malformed optional metadata cannot alter token, cost or tool accounting.

### Steering and planning

Codex `turn_aborted.reason` maps to `interrupted`, `replaced`, or `other`, deduplicated by turn ID when present. Distinct `SubAgentActivity(kind=interrupted)` items are counted separately. Mid-turn steering counts a new human input while an explicit task or a tool run remains open; it is a conservative indicator, not a classification of intent. Interrupt frequency can rise with expertise; it is not a failure signal.

Claude queue `operation` maps to `enqueue`, `dequeue`, `remove`, or `other`. Reasons map exact known labels into `prompt`, `interrupt`, `completion`, `cancellation`, `other`, or `unspecified`; arbitrary reasons are discarded. A transition into Claude permission mode `plan` or Codex `collaboration_mode.mode=plan` adds one plan entry. Duplicate snapshots in the same mode do not add entries. Distinct typed `Plan` items are separate counts. Plan rejections and permission approvals are not inferred from these counters.

**P2 opt-in:** `--workflow-content-rules` or `SESSION_ANALYTICS_WORKFLOW_CONTENT_RULES=1` enables the `claude-interrupt-marker` rule: exact whole-message or single-text-block matches of the provider's two fixed interruption markers. It retains a count (`interruptions.claudeMarkers`), never text. Embedded quotations do not match. `--no-workflow-content-rules` wins over both opt-ins. Default off: the count is null, not zero. The demo enables this rule against synthetic records only.

### Concurrency and time patterns

Concurrency is an exact interval sweep **over estimated active spans**, not over a session's whole lifetime. Intervals are half-open `[start,end)`, so an ending session and a session starting at the same instant do not overlap. Spans within each session are unioned first to prevent self-overlap. The timeline retains `{start,end,sessions}` segments; daily peaks split segments at **UTC midnight**. Repository concurrency uses a separate union for each repository.

`effectiveParallelism = activeSessionMilliseconds / wallClockActiveMilliseconds`, where the numerator sums activity across sessions and the denominator is its union across the selected scope. The ratio is null below **60 seconds** of wall-clock activity. Show both durations and eligible active-session count beside it. A single sufficiently observed session has parallelism 1. This measures concurrent session activity, not CPU utilization, agent workers inside a Claude parent, or simultaneous model requests.

The weekday × hour heatmaps use **UTC**, independent of browser timezone or daylight saving. Active time is split at each hour; overlap between sessions adds together. API-equivalent value is assigned to the UTC hour of each **deduplicated, priced request's recorded timestamp**, not spread across activity intervals or placed at session start. Claude child usage is excluded from its parent workflow heatmap; Codex child threads have their own value. Untimed, unpriced and Cursor provider-reported value is excluded. `timestampedPricedRequests / pricedRequests` makes temporal coverage explicit; this is API-equivalent value, not an invoice.

An active day has a positive active interval, not just a session start. `longestStreakDays` counts adjacent UTC active days; `currentStreakDays` ends today or yesterday relative to the snapshot's `asOfDay`, and is zero if neither is active. Streaks follow the selected scope and never imply performance targets.

Filtered browser exports follow the **session-start window** convention: all evidence from sessions started in the selected date window is included, including events after the window. Workflow summaries are recomputed from the selected public session projections.

### Archetypes and abandonment

Archetypes are **heuristics** over active duration, human turns and primary-transcript tool calls, evaluated in this order:

| Archetype | Threshold |
| --- | --- |
| Marathon | ≥4 hours active, **or** ≥30 human turns, **or** ≥300 tools |
| Deep | ≥1 hour active, **or** ≥10 turns, **or** ≥80 tools |
| Quick | <10 minutes active **and** ≤2 turns **and** ≤10 tools |
| Standard | Remaining sessions with positive estimated activity |
| Unavailable | No positive estimated activity; sparse timestamps cannot establish a short session |

Session length misleads without a same-repository/task baseline. These buckets do not identify a task, difficulty, productivity or success. Partial timing suppresses activity estimates and therefore has no archetype.

The **abandonment heuristic** flags a primary session with ≥1 observed human, ≥3 tools, no terminal/interruption or final-assistant ending, no truncated evidence, and ≥24 hours since its last work event. A working snapshot or recent open ending is `ongoing`; unsupported/sub-agent/low-activity/truncated evidence is `insufficient-evidence`; other eligible sessions are `not-flagged`. An explicit abort is not abandonment. Terminal evidence does not prove completion of the user's objective. No flag is a verdict; deleted or incomplete transcripts can cause false positives.

### Mix and before/after comparisons

Session `mix` retains bounded metadata changes and the first metadata observation on each UTC day: model ID, allowlisted effort, numeric CLI version (optional `alpha`, `beta`, `rc`, `dev` suffix), entrypoint and originator enums. Unknown or malformed labels are excluded or labeled unknown. No custom originator, nickname, plugin payload, branch or environment text is returned. Aggregate `mix` counts a session once for each day/provider/dimension/name observed; multiple models or versions may count the same session in multiple rows. These are **session-day observations**, not token or time shares.

Before/after compares adjacent first-observed model or CLI eras within the **same repository, provider, archetype, effort, entrypoint and duration-evidence class**, keeping the other model/CLI dimension constant. Exclude mixed/unknown metadata, partial timing, open/inferred/interrupted endings, and working snapshots. Compare sessions within 28 days on each side of the new era's first observation. Require ≥5 sessions per side; overlapping eras are explicitly ineligible. Output both cohort sizes, pooled turn/run p50s and eligibility. A fractional turn-time change is computed only for eligible cohorts with a baseline ≥1 second; otherwise null. Negative means shorter, positive means longer.

This is a descriptive comparison, **not regression attribution**. Archetypes are an imperfect proxy and can themselves change with tool usage; task identity and difficulty are unavailable. A longer turn may reflect deeper work or more autonomy. Compare samples and context before drawing conclusions.

### Slash commands and installed skills

Read only `history.jsonl` adjacent to each selected Claude projects root. Match by session ID internally; discard unmatched entries. A leading token must pass the bounded identifier grammar **and** have independent evidence in the conservative built-in registry or the matching profile/repository's `.claude` command/skill registry. Profile `commands/**/*.md` and repository `.claude/commands/**/*.md` names supply colon-qualified identifiers; `skills/*/SKILL.md` supplies skill identifiers. Registry discovery reads names and file existence only, never bodies. Unrecognized slash-prefixed records increment `unrecognizedCommands` without exporting spelling or timestamps, including single-component paths, directory paths and slash-prefixed raw IDs. Recognized entries retain `{name,at}`, deduplicated by session/name/timestamp. Arguments and following text are discarded. `commandHistoryAvailable` means readable matched-profile history, not complete coverage. Removed commands, unscanned plugin registries and new built-ins can remain unrecognized.

Inventory only directory names with a readable `SKILL.md`: selected Claude/Codex profile `skills/`, Codex `.system/`, default shared `~/.agents/skills` only when Codex roots are not overridden, and each selected repository's `.claude/skills`, `.codex/skills`, `.agents/skills`. Support symlink installations, deduplicate provider/repository/name, and never read skill bodies. Explicit roots never fall back to home inventories. Count absent/unreadable directories and malformed/unavailable histories without returning their paths or error strings.

`installedSkills[].observedInvocations` joins the existing skill counters by name/provider and, for project installations, repository. Profile installs are a union across the selected provider profiles; their invocation counts do not establish which profile supplied a skill. A zero means **no observed invocation in this scope**, not that the skill has never been used. Codex evidence remains a lower bound, and profile/project installations of the same name can overlap.

Repository selection is passed independently of the session cohort. A registered repository with no sessions and a selected date window with no activity still show their discovered installations, with zero observed invocations. Global installations remain visible for the selected provider. Inventory coverage counters describe discovery for the snapshot, not activity in the date window.

## Other useful derived indicators

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

## Outcomes

Optional `outcomes` namespaces on sessions, repository rollups, single-repository results, and the machine snapshot expose evidence, never a success verdict. Supported parsed sessions receive a projection; unavailable transcripts do not. Browser filters recompute the same aggregation code as the analyzer. Date filters select sessions by start date and include their whole observed histories; GitHub state is current at scan time.

### Evidence and line measurements

Each link carries `ref`, `kind` (`branch`, `commit`, `pull-request`), `role` (`outcome`, `context`), `identity` (`artifact`, `observation`), `confidence`, allowlisted `sources[]`, `created`, `state`, and nullable `timeToMergeMilliseconds`. `created` requires an explicit PR-create observation. `state` is `unknown`, `open`, `closed`, or `merged`; non-PR links keep unknown state. Merge duration is GitHub PR creation-to-merge, not session duration; unavailable, malformed, or reversed dates yield null.

| Confidence | Evidence | Interpretation |
| --- | --- | --- |
| Strong | Claude structured successful commit result; identified PR operation or PR-link | Explicit artifact association, not proof of authorship, quality, success, or value delivered. |
| Medium | Local commit on an evidenced branch within the session window; PR operation without identity | Correlation or operation evidence. Concurrent agents/humans can match a window. Anonymous operations cannot establish distinct PR counts. |
| Weak | Claude branch, Codex starting commit/branch, Conductor workspace PR-title presence/branch/archive commit | Context only; excluded from produced commit, PR, and merge metrics even if the workspace status says merged. |

Sources are `claude-git-operation`, `claude-pr-link`, `claude-branch`, `codex-session-git`, `conductor-workspace`, `local-git`, and `github`. GitHub adds state to existing associations; starting commits are excluded from Git matches. No command, message, title, or free-form stdout is searched for commits or PRs.

Claude accepts nested `toolUseResult.gitOperation.commit` (kind committed/amended, or absent legacy kind), `.push`, and `.pr` (created/edited/merged/closed). Error, interrupted, and timed-out results are excluded. Tool-use IDs deduplicate results across the entire logical session, including parent and sibling files; the first accepted result owns its line evidence. Only the UUID fallback is stream-qualified; results without either are skipped. Distinct IDs with identical patch content remain distinct edits. A PR operation with only a number resolves only when that number has exactly one locally evidenced repository coordinate in the session. Ambiguous numbers remain anonymous observations. PR references deduplicate across sessions; local merged observations take precedence over closed/open, and optional GitHub supplies current state.

`editsObserved` means a successful structured edit, completed FileChange, or positive provider line total. `editOperations` counts deduplicated Claude edit results and Codex FileChange items; Cursor totals have no operation count. Tool invocations alone do not prove edits. `operations.commits/pushes/prsCreated/prsEdited/prsMerged/prsClosed` count structured operation observations, not unique artifacts; enrichment does not increase these counters.

`linesAdded/linesRemoved` are nullable. `lineSource` identifies Claude structured patches or cumulative cost-state, Codex FileChange, Cursor composer, mixed, or unavailable. Claude counts `+`/`-` markers inside patch hunks. A cumulative cost-state replaces the edits it covers; repeated snapshots never sum. Top-level snapshots cover the composite session. Record position establishes coverage within one stream, checked against timestamps when both exist. Across streams, strictly earlier timestamps establish inclusion and strictly later timestamps establish a subsequent delta. Child files are read after the parent, so file-read order never establishes cross-stream chronology. Measured edits proven to follow the latest snapshot are added; an unmeasured tail makes coverage partial. A later consistent snapshot can absorb both tails.

Counter resets, contradictory totals, inconsistent record/timestamp order, and missing or tied cross-stream timestamps make coverage partial. Ambiguous overlaps retain a conservative per-direction lower bound: the maximum of the reconciled snapshot, its high-water mark, and the deduplicated measurable edits, never their sum. Later or undated child counters cannot be added to a parent counter; their known lower bounds are retained with partial coverage when their overlap is unresolved. Without a parent counter, independent stream measurements sum; if replayed edits make their counters overlap, use the maximum of the stream bounds and the unique patch sum and mark partial. Only numeric measurements, positions, and timestamps are retained for reconciliation; patch text is discarded during parsing.

Codex counts complete unified-diff hunks per file, not file headers, once per item ID (line-number fallback); failed/declined/unrecognized explicit statuses are excluded. A batch with valid and missing/binary/malformed diffs retains every valid file's counts and marks coverage partial, independently of file order or batching. Wholly unmeasurable events remain unavailable. Cursor requires both nonnegative line totals. Missing diffs never become measured zero.

`lineCoverage` is complete when the retained observations reconcile with known coverage, partial when edits lack lines or snapshot overlap/freshness is unresolved, and unavailable when nothing is measurable. Complete refers to retained observations, not all edits ever performed. Partial measurements are excluded from the complete-line value ratio. Repeated edits count repeatedly; these are changed lines, not unique or surviving lines. Mechanical marker counting is P0, not semantic content classification.

`prAssociationsComplete` is false if a PR association could not be retained or deduplication limits prevented inspection of further results. It describes collector completeness, not all PRs ever associated with a task. Losing only branch/commit details does not change this flag. PR allocation is withheld whenever an API session in scope has incomplete PR associations, including when a dropped association could hide the only merged PR.

### Aggregates and guarded ratios

| Fields | Definition |
| --- | --- |
| `sessions`, `observedSessions` | Selected sessions and sessions with outcome projections. Inspection coverage does not mean the provider records every outcome. |
| `editSessions`, `commitSessions`, `prSessions`, `mergedPrSessions` | Sessions with edits, produced commit evidence, outcome PR evidence, and an associated merge observation respectively. A merged identified PR applies to every selected session linked to it. Anonymous merge observations count only in session/operation metrics. These are independent funnel stages, not conversion rates. |
| `contextOnlySessions` | Sessions with at least one context link and no produced commit/PR evidence, including surviving commit operation counters. |
| `lineMeasuredSessions`, `linesAdded`, `linesRemoved` | Sessions with both line counters (including partial), and summed observed lines. Zero totals with zero measured sessions mean unavailable. |
| `coverage.lines.complete/partial/unavailable` | Mutually exclusive line-coverage counts among inspected sessions. Uninspected sessions are `sessions - observedSessions`. |
| `coverage.truncatedSessions` | Inspected sessions whose collector reached an evidence limit. Affected counts are lower bounds. |
| `coverage.enrichment.git/github` | Fixed status-count objects with keys off, not-applicable, matched, no-match, unavailable, limited. Each enricher's counts sum to inspected sessions. Uninspected sessions are not counted as failed enrichment. |
| `apiSessions`, `apiPricedSessions`, `apiEquivalentValueUsd` | Inspected API-equivalent sessions; those with complete pricing and token coverage exactly 1; sum of known-rate value, which is a lower bound if pricing is incomplete. |
| `unlinkedEditSessions`, `unlinkedApiEquivalentUsd` | API sessions with edits and no produced commit evidence, and their known-rate value. This linkage heuristic is not abandonment, failure, or evidence the work was never committed. |
| `pullRequests.linked/created/merged` | Distinct identified PR outcome references. Groups can share a PR; per-agent/repository distinct counts are not additive. |
| `pullRequests.unidentifiedCreatedOperations/unidentifiedMergedOperations` | Separate anonymous PR observations, excluded from unique artifact totals. |
| `commitSessionRate` | Commit sessions / inspected sessions; at least 5 inspected sessions required. |
| `apiEquivalentPerMergedPr` | Divide each API session's value equally among all its identified PRs, including open PRs. Sum shares associated with merged PRs, divide by distinct merged PRs linked to API sessions. At least 3 PRs required; withhold if any contributing session lacks complete pricing or any API session in scope has incomplete PR associations. Incomplete sessions contribute no allocated numerator. The retained denominator is diagnostic when evidence is incomplete. This is attributed observed session value, not full PR production cost. |
| `linesPerApiDollar` | Added + removed lines / API-equivalent value, for sessions with complete line coverage, complete pricing, and positive value. At least 5 eligible sessions and $1 required. Cursor and zero-value sessions are excluded. |

Each ratio returns `value` (number or null), `numerator`, `denominator`, `minimumDenominator`, `minimumSessions`, `eligibleSessions`, `candidateSessions`, `incompleteEvidenceSessions`, and `status` (available, unavailable, insufficient-activity, incomplete-pricing, incomplete-evidence). `incompleteEvidenceSessions` counts API sessions with incomplete PR associations for the PR ratio; it is zero for the other ratios. Incomplete evidence takes precedence over pricing/activity guards, even when no retained merged denominator exists. Only available ratios have a numeric value. Zero numerator is legitimate once guards pass; no denominator is N/A, never 0%. Candidates are selected sessions for commit share, API sessions with identified merged PRs or incomplete PR associations for PR value, and API sessions with at least partial lines for line value. Eligible sessions satisfy the corresponding coverage conditions. API-equivalent value is not an invoice.

Outcome aggregation uses the same evidence predicates across reports and exports. A commit operation qualifies even if its detail link was dropped at the cap, and it cannot appear under edits without commit evidence. The unlinked-value cohort includes API-equivalent sessions only. Terminal coverage shows complete/partial/unavailable line cohorts, evidence-limit counts, and per-enricher statuses. Partial line totals are labeled as lower bounds.

### Opt-in enrichment

`--outcomes-git` / `SESSION_ANALYTICS_OUTCOMES_GIT=1` enables read-only local Git correlation on fully qualified evidenced branches and exact first-to-last event windows (maximum 7 days). No implicit HEAD fallback, shell, fetch, worktree mutation, or commit-message output. Maximums: 8 branches/session, 100 Git queries/scan, 200 commits/query, 3 seconds/command. Timestamp traversal can miss nonmonotonic history; matches remain medium confidence. `agentCoauthoredCommits` counts distinct matched commits whose Co-authored-by trailer starts with Claude, Codex, or Cursor: an opt-in P2 rule, not authorship proof. `agentCoauthorTrailers` counts the recognized trailers on those commits, deduplicated by commit across branch queries (one commit may carry multiple agent trailers). Trailer text/emails are discarded.

`--outcomes-github` / `SESSION_ANALYTICS_OUTCOMES_GITHUB=1` checks `gh auth status`, then runs `gh pr view <number> --repo https://github.com/<owner>/<repo> --json state,createdAt,mergedAt` only for strict locally evidenced GitHub coordinates. Existing authentication and those PR coordinates go to GitHub. No transcript content, titles, bodies, searching, remote inference, or automatic login. At most 20 distinct requests/scan, cached across sessions, 4 seconds/command. Explicit repository filters constrain enrichment.

Both default off; `--no-outcomes-*` overrides environment, and repeated CLI flags use the last occurrence. Shared limits: 30 seconds elapsed after the first request and 512 KiB output/command. `enrichment.git/github` is off, not-applicable, matched, no-match (successful Git query without a match), unavailable (tool/auth/query/response missing), or limited (budget/result cap). Mixed successes/failures conservatively report unavailable while retaining successful links. Cursor has no branch/PR enrichment inputs and keeps off status. `truncated` marks collector caps: 128 links, 8 branches, or 100,000 dedupe/tool entries, numeric line observations, or line streams per session. Capped counts are lower bounds; ratios are not necessarily lower bounds, so incomplete PR allocation is withheld and incomplete line measurements are excluded. Errors never expose raw local text.

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

`rate-cards.json` and the immutable pricing cache are reproducibility inputs. The default policy uses reviewed exceptions, then matching public API snapshots in source order, then bundled fallback rates. A model with no unambiguous match remains unpriced. [Pricing evidence](pricing.md) documents all selection rules and caveats.

The Claude Opus 5 entry uses Anthropic's standard global API rates. The analyzer does not apply fast-mode, US-only inference, batch, or partner-platform modifiers because local Claude history does not establish those billing dimensions.

The Claude Fable 5.1 entry prices cache hits at 0.025x base input, the published exception to Anthropic's standard 0.1x cache-read multiplier; its base input, cache-write, and output rates match Claude Fable 5.

The Claude Opus 5.5 entry prices cache hits at 0.05x base input ($0.20 per million tokens), the published exception for that model; its 5-minute and 1-hour cache writes use the standard 1.25x and 2x multipliers. Claude 4.6 and later models carry no long-context modifier. The `gpt-6-sol` and `gpt-6.1-sol` entries apply OpenAI's published 2x input and cache, 1.5x output modifier above 272K input tokens per request.

Current Cursor builds keep global composer headers in a `composerHeaders` table that maps each composer to its workspace storage ID and marks subagent composers; older builds keep them in `ItemTable`. Both are read. Cursor local composer history exposes modern `bubbleId` token counters and stable `toolFormerData` tool-call IDs. `usageData.costInCents` is a provider-reported local usage value and may be aggregated by session, repository, and model. Bubble token counters are session-level because the local bubble schema does not retain a model identifier that can be joined safely to provider-reported model cost. It is not assigned to a day because the local store does not retain per-call cost timestamps. Relative timing values are not Unix timestamps and must not affect session spans. Cursor composer API rate coverage remains not applicable; the SDK source below has separate semantics.

## Additional provider evidence

New sources populate the optional `evidence` namespace. `source` identifies the store; `fidelity` distinguishes message, summary, and activity-only evidence. `tokens` is reported/unavailable; `tools` and `turns` are observed/unavailable. `timing` distinguishes provider timestamps from file modification times. `usageUnit` describes request/run/session granularity, or unavailable. Original native-provider outputs keep their previous shape. Availability labels apply to existing numeric fields: an unavailable numeric placeholder is not an observation of zero activity. The terminal and dashboard share metric-specific eligibility: invalid/missing transcripts are ineligible; tools, compactions, tokens, requests, durations, and costs have separate coverage. Totals with no eligible sessions display N/A; partial totals carry eligible/selected counts. Only eligible values enter rankings. Successful parsing does not imply complete metric coverage. `evidence.accounting` is an optional complete/partial label for retained accounting, independent of parser success.

- **Conductor results:** `conductor.resultRecords` counts distinct receipts, not runs. All eligible rows are grouped by provider identity before accounting. Cumulative `total_cost_usd`/`modelUsage` snapshots replace earlier progress. Explicit reset identities remain separate. Verified Claude Code 2.1 versions before 2.1.277 with distinct SDK `init` UUIDs establish disjoint process epochs; their final snapshots can be added. Newer resumes restore totals and remain one cumulative interval. Without sufficient boundary/version evidence, retain one observed snapshot and mark `evidence.accounting: partial`; counter decreases alone never establish disjoint usage. Zeroed crash receipts cannot erase earlier snapshots. See the [SDK accounting scopes](https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode).
- **Conductor counter scopes:** `conductor.turnLocalTokens` sums deduplicated turn-local `usage` into the existing nine-field `TokenUsage` shape (null when no usage counters are recorded), separately from session/model cumulative totals. It is never added to `modelUsage`. A lone receipt can supply session tokens when model counters are absent; multiple turn-local receipts do not substitute for cumulative session usage. `reportedTurns`, `durationMilliseconds`, `apiDurationMilliseconds`, and `permissionDenials` retain a lone receipt's values; with multiple receipts their scopes are not established, so they are null. `errorResults` and `terminalReasons` count receipts regardless of snapshot selection. Missing counters remain null. These flags are not task-success verdicts. Top-level reported USD takes precedence over model allocations; neither is an invoice. No daily attribution or model-request counts are inferred.
- **Cursor SDK:** latest retained snapshot per run ID; input, cache reads, cache writes, and output are disjoint counters. Reasoning is included in output. One started run is one observed run turn, not an inferred number of human messages or model requests. Tool calls are deduplicated by run plus call ID. Exact rate-card model matches are priced, with unknown models unpriced. Run aggregates cannot establish request context sizes: ordinary rates form the lower estimate, and the upper estimate applies any configured long-context premium to all aggregate usage. No aggregate cost is assigned to a day or `maxInputTokensPerCall`. When cache-write TTL is absent, the ordinary estimate uses the default write rate and the upper estimate also allows the configured one-hour rate; both assumptions are labeled.
- **Cursor transcripts:** human-message turns and structured assistant tool-use blocks only; tool IDs deduplicate streamed copies. `createdAt`/`updatedAt` are explicitly labeled file mtime, `firstEventAt`/`lastEventAt` remain null, and duration is unavailable. The session-start heatmap and duration distributions exclude these sessions. Date filters use their labeled file date. Models, tokens, cost, skills, and compactions are unavailable.
- **Copilot CLI:** persisted user/assistant messages, tool starts, turn lifecycle, and successful compaction markers, deduplicated by event and call/message IDs. Per-call usage is transient and shutdown token semantics are not calibrated here, so tokens and value remain unavailable. Request multipliers, premium requests, and AI credits are never USD. Skill evidence is unavailable.
- **OpenCode:** retained step-finish token counters are per request; the assistant snapshot contains the last step and is used only when no step counters survive for that message. Input/cache classes are disjoint, output includes reasoning. Tools deduplicate by call ID; `parent_id` supplies subagent evidence. Provider-calculated `cost` is not added to API estimates. Models use exact rate-card matches, including namespaced IDs. Pre-session messages in forks are matched to compact original-evidence fingerprints and excluded from the fork. Unmatched or undated request ownership is marked partial and excluded from additive tokens/cost; new post-fork requests remain independent. Daily values use owned request evidence only.
- **Gemini:** saved message counters are deduplicated by message ID, with JSONL checkpoints, rewinds, removals, and reorder operations applied to a content-free projection. Input includes cached input; output is candidate output plus separately recorded thought tokens. Tool-call IDs are deduplicated. Removed history cannot be recovered. Exact known rates are used; the bundled card currently has no Gemini rates, so those observed tokens remain visibly unpriced.

New activity-only sessions have `costBasis: unavailable`, `costComplete: false`, and `pricedTokenCoverage: null`. They do not become sessions “with an unpriced model.” Conductor API coverage is likewise N/A; `costComplete` requires supported, non-conflicting accounting boundaries and reported cost for every selected snapshot. It never proves complete historical retention. Numeric summary fields remain backward compatible. Evidence counts describe observations, never work quality, success, or value delivered.

The `gpt-5.3-codex-spark` entry uses zero rates because the provider documents the model as a research preview available through a subscription workflow rather than a separately metered API model. Zero here means “no observable API-equivalent charge,” not a claim that the subscription is free.

For OpenAI Codex transcripts, cached input is observable but cache writes are not separately identified in the cumulative usage counter. The ordinary estimate prices uncached input at the base rate. The upper estimate applies the configured cache-write premium to every uncached input token. The API-equivalent value should fall between those values when no other pricing modifier applies; neither value proves a subscription invoice or cash charge.

For Claude transcripts, deduplicate assistant `message.id` values before summing usage. Claude Code writes one record per streamed content block; every record of a message repeats the same input and cache counters while `output_tokens` grows, so keep the final snapshot (the one with the most output) for each message. Pricing the first snapshot undercounts output and thinking tokens. `usage.output_tokens_details.thinking_tokens` is reported as reasoning output and remains included in output pricing; record-level `effort` is the session's reasoning effort. Use the cache-creation TTL breakdown when present. If only aggregate cache creation exists, label the assumed TTL rather than silently claiming an exact cache-write price.

Apply long-context modifiers per request, not to the repository aggregate. Separately priced hosted tools, containers, search calls, storage, and network services require their own observable counters before they can enter the estimate.


### Pricing metadata and coverage

`rateCard.effectiveDate` remains the reviewed card's effective date. `rateCard.models[].provenance` describes the current resolved rate; `ModelUsage.pricing[]` is the distinct set of rate evidence actually used across requests, retained when sessions roll up into repositories and machine totals. It can contain several snapshots per model. Empty means no request has API rate evidence (wholly unpriced or provider-reported), not zero cost. `ModelUsage.pricingCoverage` carries the priced-token numerator and eligible-token denominator for API usage. This preserves partial coverage across requests and token classes. Missing cache rates can still contribute labeled estimates to cost totals, but their tokens remain only in `eligibleTokens`; `priced` and session `costComplete` stay false until every observed token class has an explicit rate. Explicit zero prices count as covered. A modeled upper estimate does not reduce ordinary input coverage because the observed uncached tokens still have a base rate. Provider-reported models omit this object.

A provenance item has `source` (`models.dev`, `litellm`, `reviewed`), `kind` (`api`, reviewed override/pin `reviewed`, bundled `fallback`), `snapshotDate` (UTC observation/effective timestamp), `payloadSha256` (full input-byte hash), `rateModel` (matching rate-card ID), `match` (`exact` or `alias`), `temporal` (`at-or-before`, `oldest` if the request predates the chosen evidence, `undated` if request time is unavailable), and `assumptions` (enumerated derived cache-rate rules). These values describe evidence, not billing fidelity.

`rateCard.pricing` reports offline mode, policy, refresh threshold in days, enabled sources, newest API observation (`newestSnapshotAt`), its age in days (`ageDays`), overall staleness, retained API snapshot count, and bounded warnings. Missing observations have null timestamps/ages/hashes and zero available-model counts. Each source also reports its own age, staleness, accepted model count and rejected-model count; an absent/stale source makes the overall catalog stale. `reviewed-only` bypasses API history and is never stale for automatic refresh purposes. Warnings are fixed codes: `cache-unavailable`, `invalid-snapshot`, `large-price-change`, `rejected-models`.

`rates status` coverage counts distinct locally observed Claude/Codex model IDs (aliases remain distinct observed IDs). `modelsPriced / modelsSeen` uses the current merged card, with `ratio: null` when none are seen; `bySource[].models` partitions priced IDs by the selected source, and `unpricedModels` names unmatched bounded IDs. Absent or rejected model values collapse to one `<unknown>` bucket without dropping their eligible tokens; paths, URLs, controls and recognizable raw identifiers never become public model labels. This differs from historical token-weighted `pricedTokenCoverage`. Cursor reported values are excluded. The Pricing tab shows token coverage with its actual numerator/denominator for selected sessions; an empty selection is N/A. These are completeness measures, not quality or value measures.

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

## Velocity (snapshot version 1)

The Velocity tab and Summary's agent lines share the same deduplicated activity ledger.
`MachineAnalytics.velocity` (also present on the single-repository result) declares
`version: 1` and the analysis process's IANA `timeZone`. Each session optionally carries
`agentIdentity` and `velocity`. Old snapshots without these additions remain readable;
the velocity view asks for a refresh instead of reconstructing activity from session totals.

### Calendar and attribution

- A velocity cell is one **local calendar date × local clock hour × dimension**. Dimensions
  combine agent, model, execution kind and effort. Provider and repository come from the
  containing session, so the payload does not duplicate their identifying metadata.
- Absolute provider timestamps are converted in the analysis process's local timezone,
  honoring `TZ`. The browser uses the declared timezone for dates and global session-start
  filtering even when its own timezone differs. Existing `spendByDay` fields retain their
  UTC semantics for compatibility; new charts use `velocity`, not those legacy fields.
- Missing, invalid or timezone-free timestamps go to `undated`. No cost or activity is
  moved to the session creation time, file modification time or last update. Undated totals
  are labeled as **all-time for the selected repository/provider scope**: a date window
  cannot assign them honestly. Dated plus undated counters reconcile with session totals.
  Global session-start filtering normalizes offset-free database timestamps as UTC.
  Missing starts and file-mtime fallbacks are excluded from bounded start-date scopes
  and counted as unknown starts; all-time totals retain them.
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
  including zero-activity dates. It needs seven dates inside both the selected range and
  observed history. It is available on daily lines/areas; it is disabled for cumulative,
  weekly, monthly and hour views so incompatible units are never overlaid.

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
custom attribution strings never leave the parser. Cursor has a provider-level agent
identity. Velocity effort is restricted to `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, `ultra`, or `unknown`, independently of the legacy session effort field.

Public model IDs match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; missing or invalid labels
become `<unknown>`. Paths, URLs, whitespace and command punctuation are rejected, including
usage-free start dimensions and tool-only records. Raw model keys remain internal for
pricing lookup; the same validated label is used by model summaries and warnings.

### Compact counters and coverage

`session.velocity.dimensions` is a per-session dictionary. `buckets` entries are
`[day, hour, dimensionIndex, values]`; `undated` entries are `[dimensionIndex, values]`.
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

Pricing coverage is index 10 / (1 + 5) for eligible Claude/Codex cells. Separate-reasoning
coverage is 11 / 5 and cache-read coverage is 12 / 1 for Claude/Codex; cache-write
coverage is 13 / 1 for Claude only. Cursor has no applicable API-price or split-counter
denominator, and Codex has no cache-write denominator. The UI names these eligible
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
Model/repository charts show the largest seven series plus an exact Other remainder; agent,
provider, execution and effort charts retain every evidenced group. This cap changes only
presentation, never totals. All chart modes share a text readout, pointer inspection, and
one keyboard focus stop with Left/Right, Home/End navigation.
All 16 supported agents have fixed identity slots: eight theme-aware colors, each with
solid/diagonal area fills or solid/dashed lines. Legends reproduce the actual SVG encoding.
Agent colors and patterns do not change when date/provider filters change spend rankings.

### Change, burn and projection guardrails

“Today” is the snapshot date in the declared timezone. Historical windows use their end
date as the comparison anchor. Week-to-date compares completed dates with the same dates
one week earlier. Month-to-date compares completed dates with the same number of dates
at the start of the previous month; when the prior month is shorter, **both** sides are
clipped to its length. Today is excluded from both comparisons. Coverage shows selected,
observed calendar days / required calendar days for each period. It does not prove the
provider retained all historical transcripts. A range clipped by the global window or the
first observed date is not a complete comparison.

Calendar coverage and **metric evidence** are separate. Known/eligible counters are retained
per day, period and mover group, including groups with zero measured value. Pricing,
reasoning, cache-read/uncached and cache-write inferences require 100% evidence over their
eligible tokens on both sides. Even equally partial coverage is insufficient. Known and
eligible counts for current/prior periods are displayed beside percentages; incomplete
evidence returns N/A. Recorded zeroes and inactive dates remain valid observations, but
0/0 evidence coverage is labeled N/A, never 100%. Unsupported providers have no eligible
denominator; a numeric unsupported contribution (Cursor's legacy uncached input) also
blocks inference. Sessions without any velocity data block comparisons. Observed totals
remain visible and are labeled partial when applicable.

Percent changes require a previous value of at least $0.01, 100 tokens, 3 sessions/model
calls, or 5 tool calls. Value/token percentages also require at least 3 prior model calls.
A zero or tiny baseline produces N/A, never an infinite percentage or a fabricated 0%.
Top movers rank absolute increases separately for repository, model and agent over the
last seven completed days versus the preceding seven. Percent guards use each group's
own prior calls; new groups can have a positive absolute increase with an N/A percentage.
Groups with incomplete evidence in either period are excluded from mover rankings; their
count is displayed. Ranked rows show each period's known/eligible counts. This prevents a
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
The band is a **rate scenario, not a confidence interval**: no normality, independence or probability
of future usage is claimed. It assumes the workload continues and cannot anticipate
project changes. API-equivalent value is not an invoice; activity counters do not prove
success, quality, human time saved or value delivered.

## Insights and review

`session-analytics insights [--json]` uses the ten-rule engine. [docs/insights.md](insights.md) defines every rule's formula, denominators, defaults, configuration, confidence and limitations. Repository/date selection recomputes peer baselines using parsed UTC instants. Known partial/active evidence is excluded; completed-peer comparisons additionally require parse-complete, observed inactive sessions. Unknown states lower aggregate confidence. Missing evidence is unavailable, never a zero-percent card. Impact is either an estimated same-token scenario difference, associated usage, or unavailable. Overlapping cards must not be added into total savings. Price comparisons imply nothing about quality or capability.

`InsightsReport` has `schemaVersion: 2`, snapshot `generatedAt`, `rateCardEffectiveDate`, applied `thresholds`, ranked `groups` and `items`, per-rule `coverage`, `evidenceCoverage` and fixed `warnings`. This changes the separate Insights contract: v1 `cards` becomes v2 `items`; the ordinary analytics snapshot is unchanged by grouping.

Each `InsightGroup` represents one `(rule, scopeKind)` across providers. `id` hashes that pair and `ruleDecisionId` hashes just the rule, so rule decisions survive changed repositories/targets. `itemIds` references every per-scope item exactly once in ranked order. `affected.repositories` / `.sessions` count unique actual contributing repositories/sessions, including only flagged compaction/context/gap sessions and the busiest bucket's starts. Inventory groups count sessions checked, not demonstrated harm. `coverage.eligibleSessions` is the unique rule-wide evidence population before activity guards; `totalSessions` and `totalRepositories` are all selected sessions and repositories with selected sessions. Peer denominators are never added together.

Group `estimatedImpact` retains the item's unit/basis and sums disjoint scope estimates within the rule. It never sums across rules or converts tokens to USD. `impactCoverage.quantifiedItems` / `.totalItems` disclose partial estimates; no quantified impact is `null`, not zero. Mixed units/bases fail closed to unquantified. Group `confidence` is the lowest item confidence; `guardrails` retains distinct fixed item notes and `suggestedAction` is the rule action. Sort USD groups first (descending), then tokens (descending), then unquantified, with stable ID ties; rows use the same ordering. Repository/date selection recomputes evidence. The CLI shows three leading rows and supports `--rule` / `--all-scopes`.

Items retain `id`, `rule`, `title`, `scope` (kind, repository/session key/provider or null), `evidence` (label, numeric value, unit, denominator and label), `estimatedImpact` (nullable value, USD/tokens unit, basis and label), confidence, guardrail, suggested action, compared/configured `names`, and eligible/selected session counts. A ratio's `value` is its **numerator**, not its divided share. All explanatory text comes from fixed templates. Item IDs hash rule, scope and compared names. `coverage[].findings` counts per-scope items; `coverage[].groups` counts grouped cards.

Pricing items add `pricing.strategy` (`next-tier-down` or `configured-target`) and `pricing.transitions[].sourceModel` / `.targetModel`. The [documented mapping](insights.md#configuration) applies exactly one same-provider edge to each recorded model's token classes, never chooses the cheapest model, and leaves unmapped/already-target usage at its recorded value. A mixed-model session enters only once and only if some usage moves. `comparisonModels` overrides the mapping for an explicit provider target. The additional “Tokens moved to a target tier” evidence uses all eligible scenario input-plus-output tokens as its denominator; full session/token coverage also includes excluded selected provider sessions. The repository/provider's net difference must meet the configured threshold. This policy describes price arithmetic, not capabilities, recommended models or guaranteed savings.

The additive Claude `session.insightSignals.cacheGaps` records `observableCalls` (deduplicated requests with explicit TTL fields and valid timestamps), `timedTransitions` (adjacent same-file/model requests with valid non-decreasing times and a current explicit TTL), `fiveMinuteExpiries` and `oneHourExpiries` (TTL-specific writes after a strictly longer gap; names describe candidates, not proven causes), `rewriteTokens` (those write tokens), `pricedRewriteTokens` (the subset with a known rate), and `estimatedPremiumUsd` (priced writes minus equivalent reads, floored at zero, with request-specific multipliers). Unknown TTLs, model switches, invalid dates and file boundaries never establish expiry. Counts can overlap across TTLs. Claude's existing `maxInputTokensPerCall` now reflects deduplicated requests, including unpriced models; no accounting totals change.

Codex's `maxInputTokensPerCall` now includes only owned, deduplicated sized requests. `insightSignals.requestSizes.observedTokens` and `.unknownTokens` partition accounted input plus output by whether the request's input size is known. Cumulative-only Codex deltas are unknown; foreign broadcasts are excluded from both the peak and size-coverage counts. Complete size coverage requires observed tokens to equal all accounted tokens with zero unknown tokens. Premium-sensitive target scenarios require complete coverage and peaks within threshold; premium-sensitive sources with unknown sizes are also excluded. Flat targets can use unknown-size usage from flat-priced sources. Mapped targets retain source/target eligibility and cohort/call guards; an ineligible next tier never falls back to a cheaper target. Cards expose eligible/selected provider session and token denominators.

`transcript.completeness` (`complete`, `partial`, `unknown`) describes the observed files' parse/version coverage. `transcript.liveness` (`active`, `inactive`, `unknown`) comes from ordered terminal/open markers and explicit Conductor status; an open marker older than 15 minutes or with missing/future time is unknown, never assumed active. Composite Claude evidence takes active, then unknown, then inactive across main/subagent files. These are observations and do not prove historical retention or future inactivity. `InsightsReport.evidenceCoverage` counts fixed reasons (`partial-transcript`, `active-session`, `unknown-liveness`, `unknown-completeness`, `unknown-request-size`) with `sessions` and `totalSessions`; reasons overlap. Invalid/missing start counts are reported in fixed warnings.

`insightSignals.mcpServers` optionally counts bounded structured server observations: Claude tool calls with `attributionMcpServer`, deduplicated by tool ID, and Codex `McpToolCall` items deduplicated by item ID. It does not change tool-call totals. Canonical double-underscore names also confirm use; ambiguous legacy single-underscore spellings do not. The MCP card shows ambiguous-name coverage and calls the result no confirmed observed use. Session items' optional `session.startedAt` is normalized UTC or null and `session.models` contains bounded model IDs, providing metadata for a review dry-run command. No session title or source path is included.

The separate P3 `review` command is off by default. Its default preview contains only the selected session key, CLI enum, mode, flagged rule IDs, span/excerpt counts, byte counts, redaction-category counts, omitted-block count, truncation flag and fixed note. Only explicit `--send-content` transmits bounded redacted prose. Results are projected to assessment/confidence/suggestion enums; raw model text is never an analytics field. [Review limits](insights.md#opt-in-review-p3) explain selection, best-effort redaction, provider billing and the `unknown` fallback.

## Interchange metrics (schema version 1)

Full machine and repository snapshots now include `schemaVersion: 1`. This is a format discriminator, not a provider parser version or package version. The [snapshot schema](../schemas/snapshot.v1.schema.json) describes the existing fields; their accounting semantics above are unchanged. CSV columns retain those field names and units. CSV/NDJSON structural fields and OTLP metadata are defined in [interop.md](interop.md).

CSV `contributingSessions` counts sessions that contributed an entry to the particular repository/provider/day, repository/provider/cost-basis/model, or repository/provider/tool row. It is not the number of successful tasks, people, or model calls. Daily rows reflect actual cost-event dates; no daily Cursor value or model-level Cursor tokens are inferred. NDJSON `kind` discriminates the snapshot header, repository rollups, and session records; each row carries the schema version. Exported JSON recomputes every rollup after repository, provider, and session-start date filtering. It includes the whole selected session, even if that session's usage extends beyond the selected dates.

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

Provider timestamps are normalized to UTC with milliseconds; timestamps without an offset, including SQLite-style timestamps, mean UTC. Dashboard summaries and exports share numeric session-start selection with an exclusive next-day UTC bound. Local DST does not move a session between selected UTC dates.

Unknown Conductor agents use `provider: "unsupported"`, `transcript.status: "unsupported"`, and `costBasis: "unavailable"`. These retained rows count in the session denominator but not analyzed sessions or sharing eligibility. Source status text is normalized to fixed labels; unknown labels become `unknown`. Tool/skill names use the bounded canonical identifier grammar; model IDs also allow one registry namespace segment. Malformed names become `unknown` / `<unknown>` without releasing source text. Tool counts are retained.

Imports reconcile machine/repository daily, model, and tool rollups against the shared analyzer/export aggregation implementation. Session tokens, model totals, cost components, execution/daily costs, tool counters, and pricing ratios are checked with exact integer counter comparisons and floating-point tolerances for currency/ratios. Cursor reported model costs remain distinct from unattributed session tokens and have no fabricated daily attribution.

Some Claude usage records understate or omit the aggregate cache-write counter while recording larger disjoint 5-minute/1-hour TTL buckets. Ingestion uses the larger of the aggregate and the TTL sum, adds those writes to input, and emits a fixed reconciliation warning. This corrects understated input totals; it preserves the recorded TTL evidence already used for pricing. It does not infer writes beyond either source counter.

Filtered files preserve validated discovery failures independently of selected rows, regenerate selection-dependent warnings, and append the filtering note. Shared totals are observed lower bounds and may include running and partially parsed sessions even when pricing coverage is 100%. Pricing coverage measures rates for observed tokens, not evidence completeness. Shared files release no extra active/partial subgroup counts or suppressed totals.

The health endpoint's `dataSource` is the fixed `live` or `snapshot` label; it prevents a live launch from silently showing saved history and reveals no filename.
## MCP query semantics

The seven [MCP tools](mcp.md) return `McpPayload` (schema version 1). The public types are in `src/mcp/types.ts`, re-exported by `src/types.ts`. This is a separate compact projection; existing dashboard/JSON field meanings are unchanged. Repository names are omitted. Standard MCP request IDs are echoed only for protocol correlation, never derived from local history.

### Scope, windows and provenance

- `scope.kind`/`repositoryId`: the selected machine scope or pseudonymous repository. Launch defaults use the same Git/worktree/Conductor assignment as sessions, and empty repositories remain empty. Explicit launch repository filters constrain every query.
- `snapshot.generatedAt`, `ageSeconds`, `ttlSeconds`: generation timestamp, nonnegative age at query time, and configured cache TTL. TTL starts when loading completes; expired requests share one refresh. A refresh failure is an error, never stale success.
- `window.name`, `since`, `until`, `timezone`, `basis`: UTC bounds, with a null lower bound for `all`. Day windows include the current UTC date; week starts Monday. Session metrics select sessions by `createdAt` (falling back to `firstEventAt`), include the lower bound, and exclude future starts. Untimed sessions can only enter `all`. Whole-session counters are never divided among days. `budget_status` alone uses the activity-day ledger for its period values.
- `notes[]`: fixed interpretation and evidence caveats, never copied provider warnings. Parser-warning presence adds a fixed coverage note; capped structured evidence adds a fixed truncation note.
- `sourceHealth[]`: provider discovery health independent of repository, window, and selected session counts. Each row contains `provider`, `status` (`available`, `incomplete`, `unavailable`, or `unknown` for older snapshots), `sourcesRead`, `missingSources`, and `unreadableSources`. It is collected before repository selection as `MachineAnalytics.mcpSourceHealth`, so unavailable providers remain visible even when the entire machine has no sessions. A provider filter selects health rows, not their denominators. Available means configured/discovered sources were readable, not that retained history is complete. Aggregate coverage warnings add a fixed note without forwarding their text.

### Totals and grouping

`totals.basis` is `session-start`, including in budget responses where the surrounding window's basis is `activity-day`. `totals.sessions`, `analyzedSessions`, and `workingSnapshots` are selected, valid-transcript and Conductor-working-snapshot session counts. The working count alone does not detect standalone activity; profiles expose lifecycle coverage separately. Input/output tokens, user turns and tool calls sum the corresponding existing session counters. `value.apiEquivalentUsd`/`apiUpperEstimateUsd` sum API-basis cost/upper estimates; `providerReportedUsd` sums reported-basis cost. They are kept separate and are not invoice amounts.

`value.pricingCoverage` has numerator equal to observed API-eligible model tokens with a known rate and denominator equal to all observed API model input plus output tokens. `unpricedTokens` is their difference. Cursor is excluded from that denominator. No API tokens means unavailable coverage; zero-rate reviewed models remain priced. Coverage needs at least one observed token; it describes evidence completeness, not performance.

`usage_summary.data.groupBy` is repository, provider, model, or agent. `groups[].key` is a repository hash, provider enum, provider-prefixed bounded model identifier, or execution-kind enum respectively. Agent means top-level/subagent/mixed/unknown, not an individual identity. Model group session counts may overlap; their cost/token attribution follows the analyzer's model counters. Model-level turns/tools and Cursor model tokens are `null` because evidence does not attribute them. Unknown or invalid model names group under `unknown`; sessions without model entries appear only in the top-level totals. Rows sort by combined observed value, then key; API and reported components still remain separate.

`totalGroups`, `totalTools`, `totalSessions`, `nextOffset` describe pagination, not an additional population. Default pages have 10 rows, maximum 50. An exhausted page has `nextOffset: null`; a snapshot refresh can change page membership. `recent_sessions` sorts by last event (then start), with the session hash as tie breaker; it returns bounded model IDs, timestamp/null, working status, duration/null and the same value/coverage object. `omittedModels` counts model identifiers beyond the cap of ten. All keys come from the existing public projection.

### Ratios and typical sessions

Every `McpRatio` includes `numerator`, `denominator`, `minimumDenominator`, `value` and `status`. Empty denominators produce `value: null`/`unavailable`; positive but small denominators produce `null`/`insufficient-data`. `value` is a fraction, except compactions per session, which can exceed one. Coverage uses minimum 1 because it reports evidence completeness. Cache hit rate requires 1,000 processed input tokens; tool error rate requires 20 observed results; compactions per session requires five eligible sessions.

`repo_profile` returns `sessions`, `activityStates.{active,settled,unknown}` counts, and four distributions: API-equivalent value, provider-reported value, user turns, and wall duration. Each includes `median`, nearest-rank `p90`, `samples`, `selectedSessions`, `excludedSessions`, and `minimumSamples` (5). Only valid transcripts with settled lifecycle evidence enter distributions. Value distributions also require complete API pricing with observed tokens, or reported-basis value respectively. Turns must be positive; duration needs first/last event evidence and a positive wall span. Zero API value from a priced zero-rate model is eligible. Exclusion counts are specific to each measurement; medians and p90 are null below five samples.

`mcpEvidence.activityState` is an enum derived from recorded lifecycle events. Codex task starts, user-message events/items and tool calls indicate active work; `task_complete`/`turn_aborted` settle the recorded turn. Token broadcasts never establish liveness. Claude user/assistant activity is active until `message.stop_reason: end_turn` or a system `turn_duration` record, tracked independently for main and subagent files by timestamp. Every included file must settle; any active file excludes the composite session. A Conductor `working` flag overrides settled evidence. Missing lifecycle evidence, malformed records, or untimed transitions cannot establish settled state. Cursor currently has unknown lifecycle evidence and its typical-session distributions remain unavailable. Settled describes the last recorded turn, not success, permanent completion, or live process status; a later start makes the next snapshot active again. Standalone discovery's default `idle` is never settlement evidence.

`cacheHitRate` divides cache reads by processed input for Claude/Codex only. `compactionsPerSession` divides their compactions by their valid-transcript session count; Cursor's missing evidence is never a zero compaction rate. `toolMix`/`skills` are descending `{name,calls}` counters capped at 20, with `omittedTools`/`omittedSkills`. `skillEvidence[]` gives each provider, its evidence enum, and selected session count. `compare_agents.agents[]` always contains Claude, Codex and Cursor totals/profiles under identical repository/window selection. It neither normalizes task mix nor ranks quality. Session length includes idle time and needs a same-repository/task baseline.

### Structured outcomes and quotas

`SessionAnalytics.mcpEvidence` is additive, collected during the existing streaming parse. `toolOutcomes[]` contains bounded `tool` names, `observedResults`, and `errors`. Claude requires a structured boolean `tool_result.is_error` joined to `tool_use.id`. Codex accepts a structured `output.isError` joined by call ID and completed `McpToolCall` items (`status`, `result.isError`). Raw tool output, exception text, command exit strings and error descriptions are never inspected for this feature. A raw result without a structured boolean/status is not a success. Duplicate IDs count once; if duplicate observations disagree, an explicit error is retained. Unmatched result IDs are excluded. Local ID maps cap at 100,000 entries each and set `truncated`; IDs never leave the collector.

`tool_stats` joins names against effective call counts and exposes `calls`, `observedResults`, `errors`, `errorRate` (errors/results), and `resultCoverage` (results/calls). Effective code-mode calls and transported results can differ. If results exceed calls, coverage is `null`/`unavailable` with both counts retained; no synthetic calls or successes are invented. A tool can have calls but unavailable error evidence, or structured completions without corresponding call counters. These are activity indicators, not verdicts or causes.

`mcpEvidence.rateLimits[]` keeps the most recent valid numeric Codex primary/secondary sample for each supported `windowMinutes` (300 or 10080): `usedPercent` (0–100), ISO `observedAt`, and ISO `resetsAt`. Equal timestamps keep the larger usage. No account/profile ID, plan name, limit ID or credit information is returned. `budget_status.rateLimits[]` gives a provider and available/unavailable status plus windows with `remainingPercent = 100 - usedPercent`. It only accepts samples aged 0–15 minutes with reset after query time. Across scoped sessions/profiles the highest observed usage wins, so headroom is conservative and may not identify the caller's account. The quota denominator is the provider's full window (100%); a missing/stale/reset sample yields no percentage. Claude/Cursor numeric quota evidence is unavailable here.

### Budget periods

`today` and `week` contain `since`, `until`, `apiEquivalentUsd`, `pricingCoverage`, `unpricedTokens`, `undatedTokens`, `datedSessions`, `undatedSessions`, `excludedProviderReportedUsd`, `elapsedHours`, and `apiEquivalentUsdPerHour`. Period API value sums `spendByDay` entries for the UTC dates in the period across **all** scoped sessions, including sessions started earlier. `datedSessions` counts API sessions with a dated value or token entry in the period, including zero-rate and wholly unpriced usage. `undatedSessions` counts scoped sessions without either applicable daily ledger. `excludedProviderReportedUsd` is the all-history scoped reported value with no date attribution, not period spending. Envelope totals explicitly retain `basis: session-start` for the week's start cohort.

The analyzer retains `mcpEvidence.pricingByDay[]` (`day`, `eligibleTokens`, `pricedTokens`) from the same deduplicated request usage and UTC accounting date as `spendByDay`, before unknown prices are excluded. Dates follow the existing timestamp/metadata fallback; invalid dates contribute only to `mcpEvidence.undatedTokens`. The period's `pricingCoverage` sums these operands over its days, and `unpricedTokens` is their difference. This coverage qualifies **both** the adjacent period value and burn rate; a session started before the week cannot disappear from its denominator. Period `undatedTokens` counts all scoped API tokens with no usable accounting date, excluded because they cannot be assigned to any period. Older snapshots lacking these operands return unavailable coverage and null unpriced/undated counts rather than borrow session-cohort coverage. Zero eligible tokens means unavailable, never 100%.

Elapsed hours run from UTC day/Monday start to query time. Burn rate divides dated API value by those hours only after at least one hour and three dated sessions. It does not estimate active time, extrapolate spending, infer a budget limit, or predict an invoice. Missing-history coverage remains a limitation even with full pricing coverage.

### Installed versus observed extensions

`unused_extensions.data.inventoryScope` is always `launch-context`. Each provider row has `inventoryCoverage: "partial"`, readable/unreadable source counts, a truncation flag, the provider's `skillEvidence`, installed/configured counts, lists of `skillsWithoutObservedUse`/`serversWithoutObservedUse`, and omitted-name counts. Skills resolve a bounded scalar frontmatter `name` (up to a 16 KiB prefix) or fall back to the canonical parent directory if absent. Canonical `SKILL.md` file identities deduplicate symlinks; invocation names and directory aliases match the same installation. The worker retains only `skillIdentities[].{name,aliases}` and canonical names in `skills[]`, never descriptions, bodies or paths. `unresolvedSkills` counts installations with unavailable identity; those cannot appear as unused. `skillIdentityCoverage` is available/partial/unavailable, separate from invocation evidence and overall inventory coverage. Older snapshots without identity mapping suppress the skill non-use list. The supported frontmatter subset is scalar names in a top-level mapping; ambiguous YAML is unavailable. See [Claude's naming rules](https://code.claude.com/docs/en/skills#how-a-skill-gets-its-command-name).

Server identifiers are structured JSON map keys or explicit TOML server-table names. MCP usage matches the longest configured prefix of `mcp__SERVER__TOOL`, including code-mode names already projected by the analyzer, so a name containing `__` is preserved. Case is preserved. TOML multiline basic strings honor escaped quotes/backslashes and closing quote runs; unterminated/unsupported string syntax rejects the source. Values and comments never contribute names. See [TOML string grammar](https://toml.io/en/v1.0.0#string). No inference is made from prompts or config commands.

Cursor skills without observed use are not listed because invocation evidence is unavailable. Codex skill use remains an inferred lower bound. Inventory scans cap each list at 512 names, each directory at 2,048 entries and each config at 1 MiB; unreadable/oversized files are counted without paths or errors. Symlink aliases are deduplicated. Project and provider sources are described in [MCP setup](mcp.md); plugin registries, managed configuration and inline TOML definitions remain outside coverage. Missing observations in a retained window never establish that an extension is unused or should be removed.

## Integrated replay and surfaces

Index replay preserves the entire declared session, including all seven added metric families and MCP/pricing evidence. `limitsCache.quotaEvidence` contains the normalized quota observations, deduplication counts, plan/credit state and hashed limit-hit keys needed to rebuild machine windows. It is evidence at ingest, not a live quota check. Freshness is recomputed when queried; filtered exports retain explicitly global quota windows but recompute session-derived subscriptions and outcome/workflow summaries.

P2 rule settings select separate index histories; disabling rules cannot expose previously cached rule counts. Ongoing workflows are reparsed because the abandonment heuristic can change as time passes. Source-deleted sessions retain last-ingest facts/prices, appear in historical totals, and never establish current working activity. Unknown session starts and file-mtime fallback dates are excluded from bounded start-date scopes. UTC comparisons use instants and exclusive next-midnight bounds.

MCP provenance includes optional `metrics` summaries for pricing, velocity, reliability, limits/cache, outcomes, workflow and insight signals. Existing denominator/activity guards apply. MCP quotas explicitly use global-profile observations and at most 20 windows; stale headroom is null. Full field maps are in [privacy.md](privacy.md#integrated-mcp-summaries-mcppayloadmetrics).

## History coverage and recovery

`historyCoverage` is an optional **machine-wide** namespace, separate from session and repository totals. The Summary panel always labels this global scope; its rows do not follow dashboard repository/date filters. Repository-filtered analysis and filtered snapshot exports omit the namespace. Full snapshots preserve it. No sessions or repository assignments are invented from statistics.

### Conductor assistant recovery

When a Claude provider identity has no canonical transcript, recover its retained assistant usage before considering result-only evidence. SQLite selects fixed metadata paths, usage counters and tool names/IDs; no prose, thinking text, arguments or results are selected into JavaScript row objects. Copies in `content`/`full_message` and duplicate Conductor rows share the same deduplication scope. Explicit conversation-reset links admit linked identities; foreign identities are excluded, and a canonical identity always wins. Codex SDK envelopes are never interpreted as Claude usage.

Native and recovered Claude requests use the same cache/TTL normalization and max-output snapshot rule. A larger output snapshot replaces an earlier one; ties retain the first owner unless usage or a reasoning breakdown was absent. The first usable request timestamp stays with that request, including across UTC midnight. Timing uses the record timestamp or database event timestamp. Missing timestamps stay undated. Tool-use IDs deduplicate calls, and `parent_tool_use_id`/sidechain markers distinguish subagent requests. Human turns, skills and unobserved lifecycle metrics remain unavailable. The SDK record UUID and database `sdk_message_id` identify streamed blocks, not API responses. When response IDs are stripped, recovery groups matching model and physical input counters within the same provider/parent agent, retaining max output. This can merge separate indistinguishable requests, so these groups are counted in `messagesWithoutIdentity` and request counts/value are conservative partial evidence. Turn IDs and intervening user records are not reliable response boundaries. A retained response ID in either copy of a record wins; ambiguous copies never add an extra known request. Retained message accounting is always partial, even if values agree.

Recovered sessions have `evidence.source: conductor-messages`, message fidelity, request usage units and API-equivalent prices. `historyStatistics` carries the fixed `claude-stream-snapshots-v5` counter basis and dated stream observations for native/recovered Claude sessions. `history.days` carries UTC day/model deduplicated token totals and value; `history.undatedTokens`/`undatedValueUsd` preserve the unbucketed remainder. Velocity uses the same deduplicated requests with its existing local-calendar convention. Recovery never allocates all usage to the session creation or update day.

`conductor.reconciliation` compares the message value (including proved query-output supplements) to the result parser's conservative selected cumulative receipts. `reportedUsd` is null without a monetary receipt; `differenceUsd` is message minus reported value; `relativeDifference` is that difference divided by a positive reported value, otherwise null. Status is `unavailable` without a receipt, `partial` with ambiguous receipt scope, absent usage, incomplete price coverage or missing request identities, otherwise `agrees` within **max($0.01, 1% of reported value)** or `differs`. The absolute tolerance is a rounding allowance, not a precision claim for tiny totals. `receiptScope` preserves complete/partial/unavailable receipt scope. Counts expose compared messages, missing usage and missing request identities. Agreement neither proves invoice accuracy nor complete retained history. Different prices, missing subagents and resumed receipt scope can cause differences. Result costs are never added to message costs. With no usable assistant usage, the existing result-only fallback remains.

### Final output and the receipt floor

Conductor often stores assistant blocks before output is final. Deduplicated `result.usage` supplies **query-local main-loop** counters; `modelUsage` and `total_cost_usd` have cumulative scope. A unique result bounds the preceding retained query records. After streamed-record and response grouping, recovery accepts an output supplement only when one known main-loop model remains and all three physical input classes (uncached, cache-read, cache-write) exactly match that query's receipt. Missing usage, ambiguous known/stripped aliases, or a response/record replayed across queries rejects the supplement. A new init, a counter decrease, or a new receipt UUID never establishes disjoint cumulative accounting. The VC-001 selection rules remain unchanged.

Only the positive difference between final query output and its retained output is added. It adds no input, request, tool, reasoning or non-reasoning count. `outputTokensRecovered` records this difference; it describes the message reconstruction even when the monetary floor wins. One shared UTC request day permits daily allocation; otherwise the output/value stays undated. Velocity requires a shared request hour and can therefore have more undated value than the UTC daily ledger. Receipt time is never substituted for a request date. Aggregate output uses ordinary pricing with no invented request context size.

Verification conserves these ledgers separately: `sum(spendByDay) + history.undatedValueUsd = cost.totalUsd`, and the sum of hourly velocity buckets plus `velocity.undated` also equals `cost.totalUsd`. The hourly remainder must never be added to the UTC daily ledger. The independent oracle also checks the history token total and each day against its model allocations.

If the selected cumulative receipt exceeds reconstructed API value, `receiptFloorApplied: true` selects `costBasis: provider-reported` and `evidence.source: conductor-result`. Message token classes, model request counts, tools and stream-overlap evidence survive. Model **dollars** come only from receipt allocations; unallocated dollars remain `<unknown>`. Thus token/request counters and reported dollars can describe different retained intervals. Price coverage stays null, accounting stays partial, and all selected reported dollars remain undated. `messageValueUsd` continues to expose the alternate API reconstruction; it is not added to the floor or used to allocate reported dollars. A receipt floor can exceed native API value because the sources/prices differ; it is a retained-evidence lower bound, not a promise to be numerically below a surviving transcript.

### Paired recovery calibration

`historyCoverage.recoveryCalibration` runs the same production recovery path as if each surviving Conductor Claude transcript were absent, without adding those counterfactual sessions to any totals. It is recalculated on full and indexed machine scans; repository-filtered analysis and filtered exports omit it with the enclosing machine scope. No static accuracy number, external dataset or multiplier is used.

`pairedSessions` counts uniquely matched surviving native/SDK sessions. Ratios use only complete, fully priced native sessions with at least `minimumNativeValueUsd` (**$1**), excluding observed active work/working snapshots; unknown liveness can remain and does not prove inactivity. `comparedSessions + excludedSessions = pairedSessions`. At least **five** eligible pairs are required; otherwise all four ratios are null. `nativeValueUsd` and `recoveredValueUsd` sum the eligible operands. `aggregateValueRatio` divides those sums; `medianValueRatio`, `p10ValueRatio` and `p90ValueRatio` linearly interpolate sorted per-session ratios at `(N - 1) × quantile`. They are descriptive sample quantiles, not confidence intervals.

`receiptFloorSessions` counts eligible pairs selecting reported value. `aboveNativeSessions` counts selected values exceeding native value by more than **max($0.01, 1% of native value)**. The panel discloses both because API and receipt prices/scopes can differ. Surviving recent transcripts and activity-weighted pooled ratios are not representative guarantees for deleted history, model quality, success or invoices. Subagent final output, stripped cache-write TTLs and ambiguous restarted cumulative receipts remain substantial limits. The independent paired oracle in `verify/recovery/` compares token classes, model allocations, UTC days, months and hashed worst cases before any extrapolation is considered.

### Profile statistics reconciliation

Read each Claude profile's optional `stats-cache.json`, including stats-only profiles, deduplicating real paths. Explicit `--claude-root` isolates both transcript and statistics discovery. Files are bounded to 8 MiB, 20,000 daily rows and 256 lifetime models. Only **`dailyModelTokensVersion: 5`** is currently comparable: the installed provider implementation sums UTC-day input + output + cache-read + cache-creation counters for **every streamed assistant block**, including child transcripts. It does not deduplicate API response IDs. Main-file sidechain copies are excluded; child files are included. These are repeated counter observations, not unique billable tokens. Unknown/older versions, malformed files and missing stores remain visible as unsupported/unreadable/missing, not zeros. Invalid dates/counters/model identifiers are ignored; repeated day/model rows take their maximum snapshot rather than being summed. Statistics are only compared on reported dates through `lastComputedDate`, when provided; a missing day is not an asserted zero.

For each **profile, UTC day and exact model ID**:

1. Preserve deduplicated native `limitsCache.buckets[].observedTokens` as `sessionTokens`. Separately sum `historyStatistics.days[].tokens` as `sessionStatisticsTokens`, matching the provider’s streamed-block basis. This extra counter never affects request counts, session tokens or session prices. Older source-deleted indexed sessions without these counters use deduplicated evidence as a conservative subtraction and are counted in `sessionsWithoutStatisticsCounters`.
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

Summary's daily chart uses the same local activity-day ledger as Velocity. Its whole-session KPI and UTC dated API-value sparkline have separately labeled populations. Models exposes any unallocated value or token balance without inventing a model identity. Unknown starts never contribute Activity heatmap starts. Source-deleted and unavailable historical observations stay outside live counts in filtered exports.

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
