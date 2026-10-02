# Research proposal: observable coding-agent trajectories

**Status: proposed, not implemented. Research cutoff: 2026-10-02.** This lane changes documentation and research artifacts only. It does not add metrics to the dashboard, parser, JSON, CLI or MCP surfaces. The companion [schema-v2 proposal](schema-v2.md) defines the event and privacy contracts needed to implement these ideas in later lanes.

The strongest first release would expose **paired tool outcomes, coverage, compaction boundaries, cache diagnostics, fresh quota samples, and collaboration patterns**. Sequence flags can help users choose what to investigate, but they cannot establish task success, root cause, quality, or time saved. Code survival requires independent Git evidence; reliable verification classification needs explicit receipts or opt-in local rules.

This proposal contributes three things: a bounded aggregate-only audit of real local evidence, a research-grounded catalog of 20 candidate metrics with validation plans, and a normalization contract that makes provider differences visible. All numeric local findings below describe the audited sample, not a representative population of developers. Research findings describe their authors' populations, not this machine.

## Reading guide

- [Current implementation and design constraints](#current-implementation-and-design-constraints)
- [Local evidence and viability](#local-evidence-and-viability)
- [Candidate metrics and detectors](#candidate-metrics-and-detectors)
- [Validation and delivery sequence](#validation-and-delivery-sequence)
- [Research survey](#research-survey)
- [Canonical ontology and error taxonomy](schema-v2.md)

## Current implementation and design constraints

The [architecture](../architecture.md), [provider coverage](../providers.md), [metric definitions](../metrics.md), [privacy manifest](../privacy.md), [roadmap](../roadmap.md) and [contribution rules](../../CONTRIBUTING.md) are the baseline. Inspection of [src/analyzer.ts](../../src/analyzer.ts) and [src/types.ts](../../src/types.ts) found these implementation boundaries:

| Existing code | What it establishes | Consequence for the proposal |
| --- | --- | --- |
| `analyzeClaude`, `claudeUsage` | Final maximum-output snapshot per assistant message; distinct tool IDs; subagent execution; latest top-level effort | Raw assistant-record counts are not request counts. A session's final effort cannot stand in for request effort mix. Tool outcomes need a new join. |
| `buildCodexCounterLedger`, `analyzeCodex` | Cross-file cumulative-counter ownership, baseline exclusion, execution segments, maximum count across lifecycle shapes | A sample cannot reproduce full-machine token ownership. Do not use sample token totals as spend or child-workload estimates. A normalized event store must preserve ownership and lifecycle dedupe. |
| `nestedToolNames` | Lexical extraction of calls from code-mode input; transport names kept separately | A nested name mention is not a result or proof of runtime execution. Future result coverage must state which layer it measures. |
| `analyzeCursorComposer`, `cursorModernTool` | Bubble tokens, structured call names/IDs, provider-reported cost, plausible timestamps | Current Cursor cost has no request/day allocation. Sparse local Cursor evidence must stay unavailable for unsupported rates. |
| `finalizeSession` | Explicit field projection; hashed session identity; aggregate context maxima | Keep the allowlist boundary. Proposed per-request context occupancy cannot reuse a ratio of maxima taken at different times. New keyed identifiers need a versioned migration. |
| Analysis and Cursor workers | Raw evidence stays in bounded child processes; only the projected result crosses the boundary | A richer internal schema must not silently turn into a public event dump. Keep P2/P3 opt-in data separate and use aggregate projections. |

There are no runtime dependencies to add. The research audit runs separately from product analysis and performs no network calls; literature browsing is an authoring activity only. No provider directory is modified. Existing parser gaps are documented as implementation work for the owning lanes, not fixed opportunistically here.

## Local evidence and viability

The completed audit and its limitations are included below. Machine identifiers, repository names, paths, messages, commands, diffs and raw errors are excluded from all published research artifacts. Only counts, distributions, reviewed tool names and fixed schema/enum labels are retained.


### Local evidence audit

This is a content-free feasibility audit captured on 2026-10-02, 15:10:22–15:10:26 UTC. The retained artifacts are [audit-local.py](evidence/audit-local.py) (stdlib-only research tooling) and [local-audit-2026-10-02.json](evidence/local-audit-2026-10-02.json) (allowlisted aggregates). Neither artifact is product runtime code. No observed transcript text, repository name, filesystem path, provider identifier, command, argument, branch, raw diagnostic, or result body is persisted. The source families below are symbolic provider defaults, not an exported inventory of local paths.

### Method and limits

Metadata inventory enumerated provider-default Claude project histories across three profiles, canonical Codex active/archive histories, and Cursor agent transcripts. Broad Codex-profile discovery found mirrored extra roots, so **only the canonical Codex root** was sampled. Files are the sampling unit; they are not interchangeable with sessions, tasks, turns, or requests.

Files above 32 MiB were excluded before sampling; selected files were read to completion with an 8 MiB per-line limit. Selection was deterministic SHA-256 ranking of home-relative paths with a fixed public seed, separately within the strata below. The selected list and its hashes were not persisted. Quotas deliberately oversample Claude main files and Codex archived files, so pooled counts are **unweighted sample descriptions**, not representative population estimates. File sizes and strata can correlate with activity and failures; excluding the largest files may especially understate long-session and compaction tails.

| Provider / stratum | Discovered files | Size-eligible files | Selected and completed |
| --- | ---: | ---: | ---: |
| Claude main | 358 | 353 | 100 |
| Claude subagent | 1,412 | 1,412 | 80 |
| Codex active | 4,630 | 4,615 | 180 |
| Codex archive | 10 | 10 | 10 |
| Cursor transcript | 80 | 80 | 80 |

Selected input sizes were 319,939,744 bytes for Claude, 118,216,412 bytes for Codex, and 1,616,536 bytes for Cursor. The corrected pass parsed 67,061 / 34,367 / 1,223 records respectively. Every provider had **0 malformed JSON records, 0 non-object records, 0 unreadable selected files, 0 over-limit selected lines, and 0 selected files whose size/mtime changed during their read**. Metadata exclusions were five Claude and fifteen Codex files; no eligible selected file was truncated. This is not an atomic snapshot: activity continued between inventory and reading, and other files could change. There is no timestamp weighting, date-range restriction, or recency weighting.

One initial bounded pass exposed two adapter assumptions that were corrected: Claude diagnostics are under `message`, and Cursor tool blocks lack IDs. A small shape probe over thirty already-selected Claude files confirmed the diagnostic nesting. One corrected pass then produced the retained snapshot. No product analyzer or full-history content scan ran. The final pass took approximately 3.5 seconds. Counts changed slightly between passes because active histories were still being written; all results here use only the corrected snapshot.

Claude assistant snapshots are deduplicated in memory by message ID and retain maximal output usage. Tool call/result IDs are joined and deduplicated in memory (five repeated Claude call observations and thirty-six repeated result observations were removed). Codex session IDs are checked in memory for duplicate files (none found in this sample); session metadata can occur multiple times within one file. Codex compaction count is the **maximum** of top-level, legacy event, and item-completed shapes per file to avoid adding multiple representations. This is a conservative shape reconciliation, not a proof that every event is uniquely identified. Cursor tool blocks lack IDs, so its counts are **block observations**, not deduplicated executions. None of these identifiers leaves the process.

Unknown enums collapse to `other`; non-reviewed tool names and MCP tool names are collapsed to fixed categories. Therefore this audit intentionally does not claim a complete installation-specific tool inventory. All numerical percentiles are linear-interpolated sample percentiles. Reproduction on a live machine can produce different counts; the script reproduces the method, not an immutable private dataset.

### Tool outcomes: use the correct denominators

| Evidence | Numerator / denominator | Result | What it supports |
| --- | --- | ---: | --- |
| Claude explicit error signals among linked results | 344 / 13,239 | 2.60% | Observed error-signal prevalence; 3,042 results lack an explicit boolean status |
| Claude explicit-status availability | 10,197 / 13,239 | 77.02% | Coverage of the boolean status field |
| Claude errors within the explicit-status subset | 344 / 10,197 | 3.37% | Describes that subset only; biased by tool-specific omission of false statuses |
| Claude Bash errors, full explicit-status coverage | 279 / 10,124 | 2.76% | A usable tool-specific error-signal rate for sampled Bash results |
| Codex structured command item nonzero exits | 52 / 482 | 10.79% | Nonzero-exit prevalence among structured command items; not task failure |
| Codex exploratory wrapper markers | 383 nonzero / 3,272 recognized markers | 11.71% | P2 lexical evidence only; not a validated provider-wide tool-error rate |
| Codex lexical marker coverage among linked transport results | 3,272 / 6,735 | 48.58% | 3,463 linked results remain unclassified |
| Cursor linked result status | 0 available results | N/A | No error-rate denominator exists |

The most important local missingness finding is **status-dependent omission**: Bash records have explicit booleans for every linked result, while Edit has eight explicit true statuses among 863 results and no explicit false statuses. Read similarly has seven explicit true statuses among 666 results. Showing Edit as “8/8 failed” would be actively misleading. Retain explicit errors, explicit non-errors, and unknown status separately; a provider-contract-validated default-false interpretation could be added later, with its own evidence version.

The Codex structured command item schema exposes `exit_code`, `status`, `duration`, and `parsed_cmd` on all 482 command items, but only twelve of 190 files contain these items (6.32%). A nonzero exit may be a normal search miss, deliberate failing test, or prerequisite check. The 482 items and 6,735 transport results are different granularities and must not be added, cross-divided, or assumed one-to-one.

Codex lexical markers are restricted to joined known command transports (`exec_command`, `write_stdin`, `shell`, `shell_command`), recognized wrapper prefixes, and an anchored `Process exited with code N` line near the wrapper start. An embedded documentation quote containing “Exit code” is covered by a negative synthetic fixture. This remains a local regex over result text (P2) and cannot establish nested tool attribution, task success, or a provider comparison. The snapshot observed no direct structured JSON `exit_code`/`isError` values in linked transport output, so all 3,272 classified transport observations here are lexical.

Claude per-file rates with at least twenty explicitly classified results have n=100 files, median 2.36%, p75 4.76%, p90 6.69%, p95 8.44%, maximum 16.00%. Without the minimum-activity guard, tiny files produce a 100% upper tail. These rates retain the status-selection caveat. Main-stratum error signals are 258/9,446 linked results (2.73%); subagent-stratum signals are 86/3,793 (2.27%). These are exposure descriptions, not a judgment that delegation improves reliability.

### Cache, context, and interruptions

The verified local diagnostic path is **`message.diagnostics.cache_miss_reason.type`**, not a top-level `diagnostics` field. It is present on 110/10,583 unique Claude assistant messages (1.04%) across forty of 180 files (22.22%). This is diagnostic incidence, not proof that the other messages had cache hits.

| Cache-miss reason | Messages | Share of the 110 diagnosed messages |
| --- | ---: | ---: |
| `previous_message_not_found` | 81 | 73.64% |
| `messages_changed` | 9 | 8.18% |
| `tools_changed` | 7 | 6.36% |
| `system_changed` | 6 | 5.45% |
| `model_changed` | 6 | 5.45% |
| Unrecognized reason, collapsed to `other` | 1 | 0.91% |

For 10,543 unique messages with all three input components and a nonzero total, the **per-message**, unweighted cache-read fraction `cache_read / (input + cache_read + cache_creation)` has median 99.168%, p25 97.50%, p75 99.662%, min 0%, max 100%. It is not a token-weighted cache-hit rate or a cost saving estimate. Provider input-token semantics differ; normalize components before comparing providers. Cost savings would additionally require valid cache TTL and model-price coverage.

Claude has two `compact_boundary` events in two main files: 2/180 sampled files (1.11%) or 2/100 sampled main files (2.00%). Both were `auto`. Both expose `preTokens`, `postTokens`, and `durationMs`; pre-token counts range 967,099–999,737, post-token counts 8,107–16,942, and durations 118,370–139,992 ms. With n=2 this demonstrates parseability, not a typical reduction or latency distribution. No sampled subagent file contains this shape; do not infer universal absence of subagent compaction.

Codex has forty reconciled compactions in twenty-one of 190 files (11.05%): thirty-six in the active stratum and four in the archive stratum. Per-file median is 0, p90 is 1, maximum is 7. The affected-file denominator is twenty of 180 active files versus one of ten archived files. Differences from Claude combine sampling, version, context-size, and representation differences; they are not evidence of superior context handling.

Codex records 366 `task_started`, 357 `task_complete`, and seven `turn_aborted` events across seven files (7/190 = 3.68% affected-file incidence). All observed abort reasons are `interrupted`; none is `replaced`. Seven aborts among 364 observed terminal events is 1.92%, but this is only a descriptive event ratio: lifecycle IDs were not normalized/joined into complete turns, the observation window is open, and task completion is not verified success. Claude's sampled `toolUseResult.interrupted` field is present on 7,184 tool-use-result records with no observed true values; this tool-level flag is not a turn-level interruption rate. Cursor supplies no interruption or timing denominator.

### Rate-limit observations

Codex `token_count.rate_limits` appears in 188/190 files (98.95%). Five-hour samples appear in 146 files and seven-day samples in 185; window availability differs even when the rate-limit container exists. Repeated identical `(file, window class, used_percent, reset)` observations are collapsed. The retained distinct observed states are **not time-weighted samples**: common states across different files are counted again, accounts can be shared, idle periods are unobserved, and aliases for different limit IDs are not independently modeled here.

| Window | Distinct observed states | Used %: median / p90 / max | States with ≤20% headroom | States at ≥100% used |
| --- | ---: | --- | --- | --- |
| Five-hour | 496 | 19 / 79 / 100 | 49/496 (9.88%) | 5/496 (1.01%) |
| Seven-day | 482 | 16 / 50 / 99 | 22/482 (4.56%) | 0/482 (0%) |

Within-file maximum used percent provides a second view of observation clustering. Five-hour maxima: n=146, median 16%, p90 44%, p95 52.5%, max 100%. Seven-day maxima: n=185, median 10%, p90 38.6%, p95 51.6%, max 99%. These are feasibility and variance evidence for a limit-pressure timeline. They do not estimate hours blocked, predict reset availability, or attribute consumption to this application. Claude `quotaLimits` appears on twenty-three of 10,583 unique assistant messages (0.22%), so that field alone does not support an equivalent regularly sampled headroom timeline.

### Delegation and effort

Claude inventory contains 1,412 subagent files among 1,770 discovered files (79.77%). The deliberately stratified sample contains eighty subagent files among 180 files (44.44%); that latter share is an artifact of the sampling quota. Neither is a token, cost, elapsed-time, or independent-task share. Within the sample, subagent-stratum tool calls are 3,793/13,239 (28.65%), also unweighted. `attributionAgent` is present on 3,248/10,583 unique assistant messages (30.69%); its value was not exported and field presence is not a separate count of child sessions.

Codex's **final `session_meta.source` classification per file** marks sixteen of 190 files as subagent (8.42%). Nineteen subagent source records appear among 193 total metadata records because metadata can repeat within a file. This audit does not claim all-time lineage membership or workload share. Parent/child IDs can support future normalized lineage, but inferred totals must avoid shared counters and inherited context.

Claude effort is present on 10,543/10,583 unique assistant messages (99.62%): `xhigh` 10,282, `medium` 220, `high` 41. Among effort-bearing messages that is 97.52% / 2.09% / 0.39%. Latest observed effort per file is available in 165/180 files: `xhigh` 130, `medium` 31, `high` 4. The difference between message-weighted and file-weighted views illustrates activity confounding.

Codex effort is present in all 390 turn-context records across all 190 files: `high` 146 (37.44%), `none` 120 (30.77%), `xhigh` 54 (13.85%), `max` 40 (10.26%), `medium` 24 (6.15%), `ultra` 6 (1.54%). Latest-per-file counts are `none` 120, `high` 34, `xhigh` 24, `max` 4, `medium` 4, `ultra` 4. `none` is an observed provider enum; do not relabel it “zero reasoning” or compare effort labels as a common numeric scale.

### Coverage that changes detector feasibility

| Signal and exact local shape | Observed coverage | Feasibility consequence |
| --- | --- | --- |
| Claude `requestId` | 10,567/10,583 messages (99.85%); 174/180 files | Strong request linkage candidate; request IDs still require their own cardinality/dedup validation |
| Claude `message.usage.output_tokens_details.thinking_tokens` | 10,493/10,583 messages (99.15%) | Reasoning-token counters viable; no reasoning text may leave parser |
| Claude `message.usage.iterations` | 10,493/10,583 messages (99.15%) | Presence verified, inner iteration semantics not audited |
| Claude thinking content blocks | 7,829 blocks in 163/180 files | Presence only; no text or quality claim |
| Claude `permissionMode` | 550 records; 100/180 files (55.56%) | Settings-context coverage, not an approval/denial outcome |
| Claude `toolDenialKind` | 11 records, all enum values unrecognized by reviewed list | Preserve unknown; denial taxonomy still needs contract validation |
| Claude stop-hook summary | 96 summaries in 14/180 files (7.78%) | `hookCount`, `hookInfos`, `hookErrors`, `preventedContinuation` present on all 96 |
| Claude hook duration | 192 numeric duration observations | Median 101.5 ms, p90 231.7 ms; local overhead signal viable where configured |
| Claude `toolUseResult.structuredPatch` | 609/8,639 tool-use-result records (7.05%); 40/180 files | Edit-volume extraction possible; not code survival |
| Claude `toolUseResult.userModified` | Same 609-record coverage | Field presence only; no attribution-of-quality inference |
| Claude `toolUseResult.gitOperation` | 203/8,639 result records (2.35%); 38/180 files | Value observed as an object; string operation enums were not validated |
| Claude cost-state totals | 104 records in 52/180 files (28.89%) | Counter reconciliation needed before treating as per-session costs or edits |
| Claude `pr-link` | 1,204 records in 36/180 files (20.00%) | Highly repeatable evidence; counts are not unique PRs or merges |
| Claude `attributionSkill` / `attributionMcpServer` | 2,217 / 363 of 10,583 messages (20.95% / 3.43%) | Names must pass explicit policy; no source strings retained here |
| Claude `attributionPlugin` | 0/10,583 messages | Not locally verified in this sample; absence is not impossibility |
| Codex `turn_context` effort/model/approval/sandbox/collaboration keys | All 390 turn-context records in 190/190 files | Configuration context broadly available |
| Codex `token_count.info` usage/context keys | 6,113/6,132 token-count records; 187/190 files | Presence supports normalized usage; cumulative snapshots are not independent requests |
| Codex task duration | 276/357 completion events (77.31%); 174/190 files | Known-duration denominator required |
| Codex TTFT | 267/357 completion events (74.79%); 170/190 files | Exclude missing, do not treat as zero |
| Codex FileChange `changes` | 460 items across 29/190 files (15.26%) | Changes schema present; patch paths/content remain private |
| Codex MCP structured item | 32 items across 4/190 files (2.11%) | Sparse but status/duration/server/tool keys present |
| Codex legacy `user_message` | 16 records in 4/190 files | Legacy-only turn reconstruction misses modern item schemas |
| Cursor transcript timestamps/results | None observed in 1,223 records / 80 files | Timing, tool errors, token rates, and interruption metrics unavailable |

The aggregate JSON contains the raw numerators, denominators, and schema-key presence counts for these findings. Record-level counts, unique-message counts, and file-level coverage are intentionally different; do not substitute one denominator for another.

### Safe observed tool-name inventory

Names below are reviewed structured tool names (P0 under the current field manifest), not names inferred from prose. Unknown installation-specific and MCP names are represented only by fixed redaction categories.

- Claude: `Agent` 92, `Bash` 10,124, `CronCreate` 1, `CronDelete` 1, `Edit` 863, `Glob` 8, `Grep` 60, `Read` 666, `SendMessage` 54, `Skill` 79, `TaskOutput` 6, `TaskStop` 9, `ToolSearch` 123, `WebFetch` 106, `WebSearch` 85, `Write` 260; MCP category 590; unreviewed-name category 112.
- Codex transport: `apply_patch` 355, `close_agent` 4, `create_goal` 1, `exec` 2,280, `exec_command` 3,285, `get_goal` 2, `request_user_input` 30, `run` 3, `spawn_agent` 18, `update_goal` 1, `update_plan` 22, `view_image` 15, `wait` 411, `wait_agent` 12, `write_stdin` 174; unreviewed-name category 122. Wrapper `exec` is orchestration/transport, not automatically a shell command; `wait` and `write_stdin` must not count as fresh command starts.
- Cursor **ID-less block observations**: `Glob` 70, `Grep` 53, `Read` 472, `Shell` 733, `StrReplace` 157, `Task` 1, `TodoWrite` 9, `WebFetch` 5, `WebSearch` 8, `Write` 16; unreviewed-name category 865. Unknown-name observations are 36.21% of Cursor's 2,389 tool blocks, so a complete Cursor ontology needs further adapter review.

Codex custom-tool input also contains static references to `tools.apply_patch`, `tools.exec_command`, `tools.update_plan`, `tools.write_stdin`, and redacted names. These P2 lexical observations describe code references, not confirmed execution count, concurrency, status, or latency. Transport and nested static-reference counts must remain separate.

Cursor's database was opened with SQLite `mode=ro` and `query_only=ON`. It has three composer-header rows (zero marked subagent), six key/value rows, one composer-data row, and zero bubble rows. The one composer row exposes `composerId`, `createdAt`, `lastUpdatedAt`, `isBestOfNSubcomposer`, `modelConfig`, and `usageData`; it lacks `conversation` and `tokenCount`. The probe checked only top-level `costInCents`; it did not inspect nested `usageData.<model>.costInCents`, so it makes no claim about that counter's availability. No identifier or database value was exported. Database population is too sparse to validate provider-wide usage or error coverage. A header's subagent flag and composer metadata flag are not interchangeable without a join.

### Privacy and verification

The aggregate consists of P0 counters/enums/distributions, reviewed P0 tool names (identifying MCP names are excluded), and explicitly labeled P2-derived numeric evidence (Codex wrapper-marker and static nested-tool-reference observations). The audit never exports prompts, responses, reasoning, patch contents, tool input/output, raw errors, local identifiers, real repository names, or observed source paths. Regex extraction happens inside the local process; only allowlisted counts leave it. Unknown strings are collapsed rather than copied into a new schema enum. This prevents new provider fields from becoming an accidental export channel.

Run the synthetic self-test without local data:

```sh
python3 docs/proposals/evidence/audit-local.py --self-test
```

Expected result: `self_test: passed`, four sentinel cases and ten behavior checks. The synthetic checks exercise Claude content/IDs/errors/unknown names, Codex content/IDs/unknown abort reasons, malformed lines, safe command-wrapper classification, a quoted-exit negative case, and Cursor ID-less multi-block preservation. They do not prove compatibility with every provider version.

To reproduce this bounded audit, explicitly enable its P2 lexical rules (the recorded snapshot includes them). Omit `--include-content-rules` for a structured-fields-only audit; P2-derived observations will then be unavailable:

```sh
python3 docs/proposals/evidence/audit-local.py --include-content-rules > .lane/reproduced-evidence-aggregate.json
```

The script scrubs unexpected exceptions to a fixed error code; SQLite queries are read-only. It uses no external network, subprocesses, runtime dependencies, or product analyzer. The historical private source data is intentionally not part of the artifacts.


### Viability decisions from the audit

“Viable” here means an input can be measured, not that a detector is validated or shipped. The per-field tables above distinguish record, message and file coverage; the artifact contains additional numerators.

| Candidates | Local evidence decision | Next evidence gate |
| --- | --- | --- |
| D01 tool outcomes | Claude Bash supports complete explicit-status rate; other tools need missingness treatment. Codex structured nonzero exits cover only 12/190 files; Cursor status unavailable. | Provider-specific status contracts, event joins and paired-result fixtures |
| D02–D05 recovery/repetition/churn | Calls and some edit receipts present; exact scoped fingerprints and recovery sequences were **not computed**. | P1 identity implementation; P2 opt-in where content classification is needed; benign-repeat validation |
| D06–D07 verification | Shell/command and edit observations exist, but this audit did **not** classify test commands, tested snapshots or check start times. | Verified command-purpose rules or structured receipts; complete edit/check ordering |
| D08 exploration | Reviewed read/search/write names observable; shell mutations and 36.21% unknown Cursor names limit coverage. | Full action mapping, applied-edit receipt and comparable task cohorts |
| D09 context/compaction | Codex boundary variation observable; Claude paired compaction sizes parseable but only n=2. Codex context fields in 187/190 files. | Request/window pairing and exact boundary joins; no context-quality inference |
| D10 cache economics | Claude counters broad; miss diagnoses selective (110/10,583 messages). | Diagnose at observed scope; valid TTL/pricing inputs and full token ownership before value estimates |
| D11–D12 quota | Codex samples broad and variable; sparse Claude quota flags do not provide comparable percentage history. | Separate limit/account buckets, sample freshness and de-broadcasting; forecasting deferred |
| D13–D15 collaboration | Codex interruptions and policy context observed; no validated human-initiator, waiting-time or plan-decision denominator. | Explicit lifecycle/decision joins; show unavailable components honestly |
| D16 delegation | File/source evidence exists; sample file shares are quota-sensitive and not resource shares. | Parent/child reconciliation and whole-evidence usage ownership |
| D17 effort/reasoning | Recorded effort and Claude thinking counters broadly observable, with substantial weighting effects. | Attribute effort to requests; no “overthinking” label from token counts |
| D18 hooks/waits | 192 Claude hook durations from 14/180 files; other duration sources have partial coverage. | Valid units and one event level; configured-hook and completion denominators |
| D19 code survival | Transcript Git clues exist; no Git history or attributed line cohorts were audited. | Independent read-only Git lineage and matured follow-up; **deferred** |
| D20 schema coverage | Missingness, source-shape and tool-name coverage demonstrably change conclusions. | Ship coverage with every metric, not as a hidden debug field |

The audit intentionally excludes Conductor SDK streams/DB enrichment, Claude Desktop usage histories, Codex thread/goals databases, provider stats caches, settings, and CodexBar histories. Those are brief-listed source candidates, not verified inputs in this sample. The schema marks such mappings as candidates rather than claiming coverage.


## Candidate metrics and detectors

These are proposed definitions, not shipped fields or validated predictors. The local audit below establishes **observability**, not predictive validity. IDs are stable proposal identifiers; thresholds are starting points for a validation experiment. No detector stops an agent or writes to its session.

### Common measurement contract

- The formula denominator contains only units with the required fields. For the schema coverage record, `eligible` means all relevant candidate units and `observed` is the usable subset: report `numerator / formula denominator`, `observed / eligible`, and unknown/censored counts. In the cards, an “eligible episode/turn” means eligible **for that formula**. A provider name alone never establishes usability. Distinguish a missing field, unsupported format, failed join, invalid value, opt-out, and a genuine observed zero.
- Use deduplicated logical events and the relationships in [schema-v2.md](schema-v2.md). A transported code-mode call and its inner operations occupy separate levels. A lexical mention of an inner call is an inferred operation, not proof it ran or has a result.
- Operation signatures are scoped by keyed workspace/CWD, actor and execution epoch, then tool and canonical arguments. Identical arguments in different working directories or children are different operations. Unknown-result operations remain in the sequence; opaque operations or evidence gaps break any claimed unchanged-state epoch rather than disappearing from a detector window.
- Begin with counts. For this proposal, show a descriptive ratio only with at least 20 usable denominator observations; show a comparative detector only with at least 50 usable observations across at least five sessions per compared stratum. These are product guardrails, **not statistical guarantees**. Small samples retain their counts and an “insufficient activity” label. Do not silently drop them from coverage.
- Report pooled event rates and session-weighted distributions separately. Correlated calls inside a long session do not provide independent trials. Use session-cluster bootstraps for exploratory uncertainty; do not attach an independent-Bernoulli confidence interval to every tool call.
- Baselines match repository, provider, model/effort, tool class, execution kind, and observation format where supported. Task type must come from a structured field or explicit user label; it cannot be recovered from message text under the default privacy contract. Without comparable tasks, say “descriptive comparison; task mix unknown.”
- “No later event observed” is not “did not happen.” Truncated logs, provider retention, ongoing turns, unjoined delegated work, and missing CLI history censor sequences. Never call a quiet session abandoned from elapsed time alone.
- P0 means allowlisted structured counters/enums. P1 includes linkable keys and keyed fingerprints; existing model/tool names follow the current manifest. P2 means local content classification with only fixed rule IDs and counters retained, explicitly opt-in and off by default. P3 semantic review is out of scope. A detector requiring P2 stays unavailable when it is off; it never quietly falls back to content inspection.

### D01 — Observable tool error burden

**Definition.** `E / K`, where `K` is unique tool calls with an explicit terminal success/error status and `E` is those with an explicit error. Display cancellations separately as `C / (K + C)`. Also report errors per eligible session, median/p90, and `K / all unique calls`. For generic command exits report a **nonzero-exit rate**, not automatically a tool-failure rate: exit 1 can mean a negative search result.

**Signals.** Claude `assistant.message.content[].tool_use.id/name` joins `user.message.content[].tool_result.tool_use_id/is_error`; `user.toolUseResult` contributes structured interruption/timeout fields. Codex joins `response_item.call_id` and matching outputs, or `event_msg.item_completed.item.{id,type,status,exit_code}` for command/MCP items. Cursor `toolFormerData.toolCallId/name` establishes a call, but a result status requires a separately verified field; a header or role/tool-only transcript is insufficient.

**Tier and confounders.** P0 counts, P1 internal joins; parsing `Exit code N` or a result string is a separate P2 rule. Provider `is_error` means the provider labeled it an error, not that the agent caused it. Missing status is unknown, not success. The audit found status missingness depends on tool and outcome: a known-status rate can therefore be badly biased even with a large denominator. For such strata lead with `explicit error signals / all linked results` as a lower-bound signal prevalence, show unknowns, and reserve comparative error rates for a validated status-recording mechanism. Transport success can conceal an inner tool error.

**Validation and UI.** Golden fixtures cover duplicate streamed calls, result-before-call, explicit false/true/missing status, cancellation, conflicting results, and a harmless nonzero search exit. Show a tool-class table with errors/known results, result coverage, and cancellation counts. Compare like tools; do not rank providers by mixed workload error rates.

### D02 — Recovery after an observable error

**Definition.** An episode starts at a known failed logical call and ends at the next known success for the same operation signature, or is censored at a human turn, incompatible context change, missing-data boundary, or session end. Repeated failures of that signature belong to the open episode: three failures then one success are one recovery. Use a fixed initial follow-up horizon of 20 eligible operations; report recovery within 20 / episodes with recovery or complete 20-operation follow-up, plus early-censored episodes / all episodes. Report median/p90 recovery steps only among observed recoveries, explicitly labeled; eventual recovery requires a censor-aware time-to-event estimate. A more permissive “any same-class success” is a separately named fallback and cannot be pooled with signature-linked recovery.

**Signals.** D01 statuses, ordered tool events, keyed tool+argument signature, Claude `toolUseResult.type/structuredPatch` edit evidence, Codex `FileChange` item evidence and `turn_aborted`; timestamps only when recorded. A success response says the operation completed; it does not prove the original task recovered.

**Tier and confounders.** P1 signature comparison; P2 only if status or operation class requires content rules. Retrying a command after installing a dependency may be useful recovery. Sibling tasks can share a tool class but not an objective. A different successful command must not erase an unresolved error.

**Validation and UI.** Synthetic overlapping failures and later successes test episode attribution. Calibrate against consented, independently labeled traces, including successful runs with many recoverable errors. Present a recovery-steps distribution and unresolved-at-end count; never “failures fixed” without a matched episode.

### D03 — Repeated failing operation flag

**Definition.** Flag at least three known failures sharing `HMAC(tool, canonical arguments)` within ten consecutive eligible operations, with no observed intervening mutation relevant to the fingerprint. Count one episode per maximal overlapping window, and report flagged calls / eligible calls. Sensitivity analysis must include 2/3/5 repetitions and 5/10/20-operation windows before choosing defaults.

**Signals.** D01, normalized tool calls/results, P1 argument fingerprints and resource keys, structured edit/file-change evidence. Failed API retries are a separate class from command retries. Include reason class where known, never raw errors.

**Tier and confounders.** P1 with structured mutation evidence, P1+P2 if command/diff rules identify mutations. “No mutation observed” is a visibility statement, not proof of unchanged world state; an opaque shell call invalidates that assumption. Polling, flaky tests, backoff, lock contention, human-requested repetition, and eventually consistent services create benign repeats. Do not label the flag “death spiral” or assume its entire cost was wasted.

**Validation and UI.** Challenge fixtures include identical commands after a mutation, deliberate polling, independent concurrent calls, and a missing result. Measure false flags per 100 sessions on held-out repositories; require manual review before any coaching rollout. Display “repeated failing operation,” repetition count, coverage, and observed request value inside the flagged interval. Shared requests without reliable allocation remain unallocated.

### D04 — Edit churn and failed-edit cascades

**Definition.** For a keyed resource, report edit attempts, successful edits, explicit failures, and repeated edits before the next verification event. `failed edits / edits with known status` measures edit friction. `(added + removed) / max(1, abs(added - removed))` is an optional line-turnover descriptor, never an efficiency score; show its two inputs because formatting can make it enormous. Exact revert detection needs opt-in keyed before/after fingerprints, not line counts alone.

**Signals.** Claude Edit/Write `toolUseResult.structuredPatch`, `type`, `userModified`; Codex `item_completed.item.type=FileChange`, `changes[path].type/unified_diff`. Count diff lines locally using a versioned rule. Link paths through a machine-secret HMAC only; do not retain patches or filenames.

**Tier and confounders.** P1 resource identities, P2 diff rules; pure provider-supplied line counters can be P0. Generated code, renames, formatters, notebook rewrites, and human edits confound volume. `userModified` alone does not quantify human rework.

**Validation and UI.** Test binary/empty/unified diffs, context lines, duplicate patches, add/delete/rename and streamed repeated edits. Show anonymous resource groups and failed-edit sequences with counts, not path labels. Do not identify an edit as “anchor mismatch” unless a reviewed rule or structured enum supports it.

### D05 — Re-read and search repetition

**Definition.** Within an epoch bounded by a known edit/compaction/human turn, `repeat reads / eligible reads` uses the same keyed resource and range; `repeat searches / eligible searches` uses a keyed query+scope signature. A candidate flag is four identical operations in a ten-operation window, reported separately from ordinary read/search share.

**Signals.** Claude Read/Grep/Glob, `toolUseResult.numLines/totalLines/truncatedByTokenCap`; Codex named read/search tools or opt-in classified shell operations; Cursor structured `read_file`, `ripgrep`, or `glob` calls where recorded. Arguments are fingerprinted locally and discarded.

**Tier and confounders.** P1; shell-command classification is P2. A truncated read, changed file, compaction, or new subagent justifies re-reading. Without mutation visibility the UI must say “repetition observed” rather than “redundant reads.” Token-volume savings cannot be inferred from call count.

**Validation and UI.** Test overlapping ranges, glob scope changes, punctuation/case normalization, truncation, and separate agents reading one file. Present repetition alongside truncation and compaction counts. Validate against benign exploration, not only labeled failures.

### D06 — Verification freshness after the final observed edit

**Definition.** For closed, edit-bearing turns with continuous evidence through completion, `turns with a completed verification that started against a snapshot after the final edit / eligible edit-bearing turns`. If snapshot identity is unavailable, require its observed start after the final edit and label snapshot consistency unverified. A result arriving after an edit from a check started before that edit is stale. Display pass, fail, interrupted, unknown-result, and no-observed-verification separately. A session-level fallback must be labeled because Claude may not expose reliable turn boundaries.

**Signals.** Edit timestamps/order; Codex `CommandExecution.parsed_cmd[].type` only when its enum actually identifies verification (generic `run` does not); Claude Bash/Codex shell invocations plus opt-in allowlisted test/build/lint command rules. `returnCodeInterpretation` or `exit_code` may supply outcome. A `task_complete` marker is a boundary, not a test result. Join child verification only with explicit parent linkage and compatible resource scope.

**Tier and confounders.** P2 for general shell classification, P0 for future structured verification receipts. Documentation-only work may legitimately need no tests. Passing the wrong tests, cached test results, remote CI, and manual checks remain invisible. Missing recognition of a custom test runner lowers classification coverage.

**Validation and UI.** Test edit→check-start→pass, pass→edit, parallel check-start→edit→pass, failure→pass, no terminal status, still-running session, delegated verification, and compound shell scripts. Separate “not applicable” via explicit task/validation policy from “unobserved.” UI copy: “verification observed after last edit,” with rule coverage and no quality badge.

### D07 — Failing-to-passing verification transitions

**Definition.** Count failed→passed episodes of the **same** verification signature with at least one intervening observed edit. Coalesce consecutive failures until one later pass; never count one pass as multiple recoveries. Use a fixed follow-up horizon of the next five comparable check executions and report recoveries / episodes with recovery or full five-check follow-up, with early-censored episodes shown separately. Require the passing check to start after the edit under D06. A pass under a different command, working directory, or environment fingerprint is not a recovery pair.

**Signals.** D06 and keyed command/workspace signature, ordered edits, structured exit outcomes. Record whether test case counts or suite identity are available; do not infer them from a command name.

**Tier and confounders.** P1+P2. Flakes, disabled tests, weakened assertions, changed test scope, or network restoration can produce the same transition. It proves a result changed, not the implementation became correct.

**Validation and UI.** Synthetic tests must keep environment/scope changes separate and avoid pairing parallel runs by timestamp alone. Prospective CI receipts can independently validate the observed transition. Display “same check: fail → pass” with known scope and edit count, not “bug fixed.”

### D08 — Exploration before first edit

**Definition.** For edit-bearing sessions, count logical operations and measured active time before the first observed edit, plus read/search share in that prefix. Keep no-edit sessions as a separate workload group. Never set time-to-first-edit to session duration when no edit is observed.

**Signals.** Normalized ontology, Claude Edit/Write, Codex `FileChange` or explicit patch calls, Cursor verified write/edit names. Use provider action order; time is unavailable for role-only Cursor transcripts. A shell call can edit without an explicit patch event, lowering edit-observation coverage.

**Tier and confounders.** P0 classes; P2 shell classification optional. Onboarding, research, review and planning are legitimate no-edit workflows. Less exploration can mean familiarity or reckless assumptions; more can mean difficult code or wandering.

**Validation and UI.** Stratify by repository and explicit task type, reporting unknown task mix. Validate first-edit capture against synthetic shell/patch/child-agent examples. Show a distribution of operations before edit, without a “faster is better” target. This describes trajectory shape rather than detecting semantic premise errors.

### D09 — Context occupancy and compaction discontinuity

**Definition.** Per request, `processed input / contemporaneous context window`, never the ratio of unrelated maxima. Report eligible requests / all requests. For compactions with positive `preTokens`, reduction is `(preTokens - postTokens) / preTokens`; negative values are retained as anomalies. Report compactions per 100 observed turns and the distribution of turns between boundaries when turn joins exist.

**Signals.** Codex `event_msg.token_count.info.{last_token_usage.input_tokens,model_context_window}`; Claude `system.compact_boundary.compactMetadata.{trigger,preTokens,postTokens,durationMs}`. Codex `compacted`, `context_compacted`, and `ContextCompaction` may represent the same event. Join causal epochs by sequence, not timestamp proximity alone.

**Tier and confounders.** P0, P1 joins. Context capacity is not an accuracy guarantee, and missing `postTokens` makes reduction unavailable even when a boundary is visible. Automatic/manual compaction, cached input, and different models change the meaning of occupancy.

**Validation and UI.** Test changing window sizes, duplicate representations, compaction at file start, missing post-size, and occupancy above one without silently clamping. Show a curve with observed boundaries. A pre/post increase in errors or re-reads is an exploratory association requiring matched windows and task controls, not a “context rot score.”

### D10 — Cache economics and provider-reported miss causes

**Definition.** Read share is `read / (uncached + read + write)` for Claude and `cached / input` for Codex. Net API-equivalent cache advantage for one priced request is `[read × (base - readRate) - write5m × (write5mRate - base) - write1h × (write1hRate - base)] / 1e6`. This may be negative. For a fixed prefix, nominal break-even reads are `(writeRate - base) / (base - readRate)` when the denominator is positive. Unknown TTL/model/rate makes the corresponding component unavailable.

**Signals.** Deduplicated Claude `message.usage` and the locally verified **`message.diagnostics.cache_miss_reason.type`**; Codex `last_token_usage.cached_input_tokens` with usage ownership. The brief's abbreviated diagnostic name is not a top-level record path. Keep provider-reported `previous_message_not_found`, `messages_changed`, `tools_changed`, `system_changed`, `model_changed` separate from inferred TTL expiry or model-switch associations.

**Tier and confounders.** P0. An idle gap exceeding TTL is not proof of a particular eviction cause. Cache diagnostics are selected observations; reason shares use requests/iterations with diagnostics, not all requests. Codex cache-write cost is unobserved and must not be fabricated. List-price advantage is not an invoice saving.

**Validation and UI.** Test final streamed snapshots, iteration-vs-request multiplicity, aggregate-write/TTL mismatch, zero rates, unknown models, and negative net advantage. Show read share, priced-token coverage and a separate “reported miss causes” panel; never assign all uncached tokens to a diagnosed miss. Re-caching cost requires a matched request, not a reason count multiplied by average tokens.

### D11 — Rate-limit headroom, pressure and freshness

**Definition.** A valid sample has `headroom = 100 - used_percent` within a provider-qualified limit bucket, window duration and reset epoch. Report sample p10/p50/p90 and the share of **observed samples** at ≤10% headroom. A time-weighted share uses left-held intervals capped at a documented freshness limit (initial experiment: five minutes), split at reset boundaries; uncovered wall time stays unknown. Never treat an activity-sampled percentile as percentage of the working day.

**Signals.** Codex `event_msg.token_count.rate_limits.{limit_id,primary,secondary}` with `used_percent/window_minutes/resets_at`; Claude `quotaLimits` statuses have weaker numeric coverage and cannot be converted to percentages. Provider plan-utilization histories could add numeric samples after separate validation. Do not add primary and secondary percentages.

**Tier and confounders.** P0 counters, P1 keyed account/profile bucket. Broadcast snapshots duplicate observations. Multiple sessions consume one shared quota, rolling windows can decline without a reset, and off-machine usage may be invisible. Latest-known headroom is not current headroom indefinitely.

**Validation and UI.** Test out-of-order duplicates, changed reset time, >100/negative values, different quota buckets, and stale samples. Show two separate windows, last sample age, observation coverage and “stale” state. Do not infer subscription tier or a cash balance from usage alone.

### D12 — Limit approach forecast (defer until calibrated)

**Definition.** Within one bucket and reset epoch, estimate a robust positive slope of usage percentage versus time from at least five distinct samples in a 30-minute lookback spanning at least ten minutes; the latest sample must satisfy D11's freshness limit. `ETA = headroom / positive slope`; uncertainty must be calibrated on independent account/reset epochs, not concurrent sessions sharing quota. Nonpositive slope, reset, insufficient span, or unstable estimates yield no forecast. A short-lived quota ETA is not a spend forecast.

**Signals.** D11; explicit `usage_limit_exceeded` and `apiErrorStatus=429` are outcome checks, but a 429 need not indicate the same quota bucket. Distinguish request-rate throttling from plan-limit exhaustion.

**Tier and confounders.** P0/P1. Shared-account work and bursty parallel agents invalidate stationarity. Rolling quota replenishment makes linear forecasts especially weak. No local benchmark of forecasting accuracy exists yet.

**Validation and UI.** Hold out entire reset epochs, compare with a last-value/no-forecast baseline, and score prediction-interval coverage plus false imminent-limit alerts. Only show an ETA if backtesting meets a preregistered calibration target; otherwise ship headroom/freshness alone.

### D13 — Recorded interruptions and human steering

**Definition.** `explicitly interrupted terminal turns / terminal turns with known completion-or-interruption state`; report replaced turns separately. This is a provider-reported interruption rate. Its human-initiated subset requires an explicit initiator; unknown initiators stay visible. Also show interruptions per started turn with open/censored turns visible, so denominator choices remain clear. A message arriving during a known active turn is a steering event only when human sender and timing are explicit.

**Signals.** Codex `task_started`, `task_complete`, `turn_aborted.reason/duration_ms`, compatible turn IDs; Claude Bash `toolUseResult.interrupted` describes a tool interruption, not automatically a human interruption or interrupted turn. Claude queue events and permission-mode changes are separate observations.

**Tier and confounders.** P0/P1. Expertise, proactive correction, parallel work and replaced instructions all raise this rate without demonstrating failure. Provider cancellation and user steering are different causes; unknown initiator stays unknown.

**Validation and UI.** Test replaced/interrupted/completed terminals, duplicate starts, missing starts, and new user messages after completion. Show completion/interrupt/replacement counts and state coverage with copy that interruptions can reflect active collaboration. No “bad session” coloring from interruptions alone.

### D14 — Autonomy span and effective parallelism

**Definition.** Autonomy run length is logical operations between explicit human interventions; duration requires known boundaries and stays right-censored at observation end. A provider `role=user` wrapper containing a tool result is not a human intervention. Concurrent execution uses the union of **known active execution intervals**, not session spans: `sum of active durations / duration of their union` within the selected scope. Choose one homogeneous, non-nested level (for example, individual tool executions); never sum inclusive parent turns together with their child/tool intervals. Human waiting, parent waiting on children and permission waiting are separate only if their start/end events exist.

**Signals.** Codex task/turn lifecycle, command durations, Claude `turn_duration`, Agent `totalDurationMs`, timestamps and explicit human message roles. Session start/end envelopes support only “overlapping session spans,” a distinct low-fidelity metric.

**Tier and confounders.** P0/P1. A long autonomous run can be useful work or an unobserved stall. Tools may run concurrently inside a turn; sum duration double-counts wall time unless interval union is used. Missing background operations underestimate concurrency.

**Validation and UI.** Test nested/overlapping intervals, zero-length work, idle overnight sessions and unclosed operations. Show operations/run and observed active intervals with censored shares. Never call event span “time saved” or subtract it from human effort.

### D15 — Permission exposure and plan decisions

**Definition.** Report explicit permission requests, approvals, denials and unknown decisions per 100 eligible calls; `denials / requests with known decision` is an interaction measure. Plan rejection is separately `rejected plans / plans with explicit accepted-or-rejected decision`. An exit-plan call or a return to plan mode does not establish a rejection.

**Signals.** Claude `permissionMode`, `toolDenialKind`, permission-mode records; Codex `turn_context.approval_policy/sandbox_policy/collaboration_mode.mode`, explicit approval/plan lifecycle if present. Configuration indicates exposure policy, never a request or decision. Free-text corrections are excluded under P0/P1.

**Tier and confounders.** P0 enums/P1 joins; content-derived plan decisions would be P2 and require independent validation. Broad auto/bypass modes suppress approval prompts. Near-universal approvals have little discriminative value; policy comparisons must retain exposure mode.

**Validation and UI.** Test auto-approved calls without prompts, user versus policy denials, aborted approval dialogs, plan-mode transitions and absent explicit decisions. Show mode mix plus observed requests; mark plan rejection unavailable when unsupported, not 0%. Do not recommend bypassing controls based on approval frequency.

### D16 — Delegation share and coordination overhead

**Definition.** Report separate shares for child execution files, logical calls, owned tokens and priced request value. Only the last two measure consumption; file share is not delegation workload. Coordination share is `delegate/wait/send/collect operations / all eligible operations`, split from child execution. Fan-out is distinct child executions per explicitly linked parent turn, with unresolved links counted.

**Signals.** Claude `subagents/`, `agentId`, Agent `status/resolvedModel/totalDurationMs/totalTokens/toolStats`; Codex `session_meta.source.subagent.thread_spawn.{depth,parent_thread_id}` and `SubAgentActivity`; Cursor `composerHeaders.isSubagent/subagentInfo` where present. Fold duplicate parent-reported child totals and actual child usage through one ownership policy.

**Tier and confounders.** P0/P1. Parent rollups are not additional requests. Missing child logs lower coverage. Resuming a Codex thread as top-level changes execution segment. Heavy delegation reflects task and orchestrator strategy, not automatically wasted coordination.

**Validation and UI.** Test child totals duplicated in parent results, mixed-role sessions, orphaned children and nested delegation. Show a share by unit with known execution attribution, plus fan-out and coordination operations. No cross-provider comparison of file shares as if they were cost shares.

### D17 — Effort mix and prolonged reasoning (exploratory)

**Definition.** Request effort mix is `requests at effort e / requests with known effort`. Reasoning share is `separately exposed reasoning output / output with compatible reasoning breakdown`; unknown reasoning is not zero. A prolonged-reasoning candidate flags same-stratum requests above the historical p95 reasoning-token distribution; it is not an “overthinking” diagnosis. Work after the last edit is separately measured and can be essential verification.

**Signals.** Claude assistant `effort`, `message.usage.output_tokens_details.thinking_tokens`; Codex `turn_context.effort` and owned `reasoning_output_tokens`. A turn-context record mix is not request-weighted effort mix; a session's final effort is not its entire history.

**Tier and confounders.** P0. Models expose reasoning differently, effort is a control setting rather than realized computation, and hard tasks need longer reasoning. Hidden reasoning or a provider reporting no breakdown prevents comparisons. Do not inspect reasoning text.

**Validation and UI.** Test effort changes mid-turn, unknown labels, missing reasoning breakdown and reasoning > output anomalies. Use matched task experiments varying effort with independent quality labels to evaluate any efficiency hypothesis. Show requested effort and observed token distributions separately; no default “wasted thinking” score.

### D18 — Hook and tool wait overhead

**Definition.** Hook p50/p95 duration uses completed hook observations with valid durations; blocking share is `continuation-preventing summaries / eligible stop-hook summaries`. Tool wall latency uses terminal results, while open calls are censored. A sum of hook or tool durations is accumulated execution time, not a fraction of wall time unless intervals can be unioned.

**Signals.** Claude `system.stop_hook_summary.{hookCount,hookInfos[].durationMs,hookErrors,preventedContinuation}`, `system.api_error.retryInMs`, structured WebFetch `durationMs`/WebSearch `durationSeconds`, Agent duration; Codex command/MCP `duration`, `task_complete.time_to_first_token_ms`. Do not invent units for an unverified `duration` field.

**Tier and confounders.** P0. Hooks may overlap or intentionally block unsafe operations; errors are distinct from successful enforcement. Scheduled retry delay differs from actual elapsed delay. Provider API wait, shell execution and human wait must not be merged.

**Validation and UI.** Test ms/sec conversion, summary vs child duplicate counts, partial durations and parallel hooks. Show latency distributions by event kind and known-duration coverage; minimum sample requirements apply to p95. No “overhead waste” amount without a valid wall-time baseline.

### D19 — Code survival and outcome-linked value (independent evidence required)

**Definition.** For a cohort of explicitly attributed additions at a known revision, `unchanged added lines with continuous mapped lineage at age d / eligible introduced lines with d days of follow-up`, at 14 and 30 days. Use the selected branch revision at or immediately before the horizon, provided the observed history extends through it. Equal text elsewhere, or deletion then reintroduction, does not establish survival. Report original lines, censored lines, rename policy, generated-file policy and attribution confidence. Zero surviving lines is 0% when the original eligible cohort is nonempty; cost per surviving line is then unavailable, not zero or infinity. The cost numerator needs owned priced usage linked to that same cohort. Syntactic retention is not semantic survival, productivity or quality.

**Signals.** Claude structured `toolUseResult.gitOperation`/`pr-link` supply event classes; optional local Git supplies revision graph and line mapping, with revision/path identifiers keyed before persistence. Codex `session_meta.git.commit_hash` is a starting revision, not proof the agent created it. Time overlap alone is weak attribution. Diff/line tracking is a P2 operation; nothing is implemented by this proposal.

**Tier and confounders.** P1 keyed links, opt-in P2 local line rules. Squash/rebase, cherry-picks, human coauthorship, renames, formatting, generated code, follow-up requirements and inaccessible history complicate attribution. Durable wrong code can survive; useful temporary code can disappear. Right-censor recent cohorts instead of assigning them zero survival.

**Validation and UI.** Synthetic Git histories test rename, edit, revert, merge, squash and insufficient follow-up. Validate provenance against independently reviewed commits, keep weak links out of the primary denominator, and compare only matched repository cohorts. UI shows evidence strength and survival curve, never raw commit IDs/paths or inferred business value.

### D20 — Observation coverage and schema drift

**Definition.** For each metric, track usable observed units / all relevant eligible units by provider and adapter version, plus missing/invalid/unsupported/conflicting field counts. A drop in result coverage without an error-rate change is a data-health alert first. Track unknown tool-class share and unresolved joins independently of workload metrics.

**Signals.** Adapter field-presence counters; input format variants, safe CLI-version bucket, parser errors, stable-versus-working snapshots; no raw errors or arbitrary unknown enum strings. Audit coverage is presence in the selected files, not a promise across historical versions.

**Tier and confounders.** P0. A newly deployed CLI, retention, a provider switch or sampling changes may explain drift. Avoid a fixed alarm threshold until baseline variability is known. A rise in missing output can be concurrent unfinished work rather than a parser bug.

**Validation and UI.** Feed old/new and malformed synthetic formats, unknown enum values and hidden sentinel strings; assert fail-closed outputs and honest unavailable measures. Show a compact coverage badge next to every detector, with a separate adapter-health view. Release gating should prioritize unexplained coverage regressions before tuning behavior thresholds.

## Validation and delivery sequence

1. **Build evidence fidelity first.** Implement normalized events and tested joins in the owning provider/index lanes. Add result coverage, source-level dedupe and null semantics before user-facing error rates. Preserve v1 snapshot behavior during a versioned transition; no proposal field is live in this lane.
2. **Start with measurable descriptions.** Prioritize D01, D09 boundary counts, D10 cache counters/reported causes, D11 headroom/freshness, D13 explicit interruptions, D16 attributed execution shares, and D17 recorded effort. Local sparsity may narrow this list by provider. Do not treat sample event counts as calibrated alert thresholds.
3. **Opt-in rule experiments.** D03–D07 require reviewed fingerprints/classifiers and synthetic fixtures including benign retries, polling, intentional re-reading and independent concurrent work. P2 activation must be explicit. Keep rule ID/version and classification coverage; never store commands, diffs or matched snippets.
4. **Separate labels from features.** A known tool error is a label for tool-result behavior only. Session success requires independent CI/Git/human evidence. Consent to review content is separate from running content-free analytics. Annotators must not see the detector's score when labeling validation cases; report disagreements and “unknown.”
5. **Evaluate without leakage.** Split by repository and chronological period; do not random-split calls from one session into train/test. Compare simple count baselines to each candidate. Report precision/recall where outcome labels exist, false flags per 100 sessions, coverage, missingness by source, and session-cluster uncertainty. Run ablations with and without task/provider/effort controls. No causal claim from observational matching alone.
6. **Calibrate before coaching.** Pre-register acceptable false-flag burden and confidence requirements with maintainers for each use case, then test on held-out data. A dashboard exploration can tolerate more false positives than an interruption hook. This proposal authorizes neither automated interruption nor policy changes. D12 forecasts and D19 survival wait for their missing validation/evidence.

Reject a single “agent quality” score, global session-length thresholds, permission-approval-based trust scores, self-reported task completion as success, time-overlap-only code attribution, and a default LLM judge. They exceed what the observed metadata can support.


## Research survey

Research cutoff: **2026-10-02**. Primary pages and the explicitly linked paper versions below were inspected on this date. This is a focused survey, not a systematic literature review. The sources include peer-reviewed work, explicitly identified preprints, provider engineering reports, an independent randomized experiment, and an independent practitioner experiment. Publication date is distinct from the date of the evaluated models or collected trajectories. Local measurements are reported separately above.

The central design conclusion is that **process observations support inspection, while outcome and causal claims require independent evidence**. A tool error is an observable event; a task failure, a mistaken premise, and a missed stopping opportunity are different constructs. A useful research panel should expose those distinctions instead of turning heterogeneous counters into a quality score.

### Direct coding-agent trajectory research

#### R1 — A common action/result representation

Bouzenia and Pradel, **Understanding Software Engineering Agents: A Study of Thought-Action-Result Trajectories**, 2025-06-23, preprint version 1. [Primary full text](https://arxiv.org/html/2506.18824v1).

The study normalizes 120 trajectories and 2,822 model interactions from RepairAgent, AutoCodeRover, and OpenHands. It distinguishes structural properties and action sequences from semantic judgments about whether reasoning uses tool feedback. Repetitive action patterns occur in unsuccessful runs, but changing action categories can also be useful progress.

**Implication:** retain separate request, tool-call, and tool-result events; analyze action-family transitions and exact repeated actions. Do not equate repetition of a family with repeated identical work.

**Limit:** small, repair-focused sample and older agents. Semantic feedback integration required content inspection and manual labeling; names, token counts, and exit codes cannot recover those labels. Any such semantic detector belongs outside the P0/P1 structural proposal and needs its own opt-in P3 validation.

#### R2 — The original length association is descriptive

Majgaonkar et al., **Understanding Code Agent Behaviour: An Empirical Study of Success and Failure Trajectories**, 2025-10-31, preprint version 1. [Primary full text](https://arxiv.org/html/2511.00197v1).

Across OpenHands, SWE-agent, and Prometheus on SWE-bench, failed traces are generally longer and more variable. Their phase analysis distinguishes diagnosis, reproduction, planning, implementation, and verification. Even failed trajectories frequently identify the appropriate file; file localization alone does not establish an adequate fix.

**Implication:** show a distribution of steps and verification timing within comparable cohorts; retain task and scaffold distinctions.

**Limit:** these are associations in a benchmark, not a threshold separating healthy work from waste. The later R3 analysis directly challenges the unadjusted length interpretation. A local long-session badge should therefore say “unusually long relative to this cohort,” never “failed” or “overthinking.” Missing task identity substantially weakens even that comparison.

#### R3 — Task difficulty reverses the length association

Mehtiyev and Assunção, **Beyond Resolution Rates: Behavioral Drivers of Coding Agent Success and Failure**, 2026-04-02, preprint version 1. [Primary full text](https://arxiv.org/html/2604.02547v1).

The study covers 9,374 trajectories, 19 agents, eight frameworks, 14 models, and 500 SWE-bench Verified tasks. The relationship between length and failure changes direction when comparisons hold task difficulty fixed. Context gathering before editing and greater validation activity are associated with success more consistently than raw length.

**Implication:** preserve provider, model, effort, scaffold version, and repository strata. Study verification placement and action sequences rather than penalizing total tokens or elapsed time. A same-repository baseline is helpful but does not fully control task difficulty.

**Limit:** observational, one run per agent/task, 500 Python tasks from 12 public repositories. Holding tasks fixed still changes agent identity; holding agents fixed still changes tasks. The paper does not establish a causal intervention that improves arbitrary local development.

#### R4 — A reproducible detector catalog, with bounded claims

Shu et al., **What Resolve Rate Hides: Trajectory Structure Diagnostics for Coding Agents**, 2026-07-07, preprint explicitly under review. [Primary full text](https://arxiv.org/html/2607.06184v1).

TraceProbe analyzes 2,500 SWE-bench Verified trajectories across five production settings, normalizing nine action families and applying reproducible sequence predicates. Search loops are its most stable reported clue; several other signals weaken in task-fixed comparisons.

**Implication:** treat repetition and verification predicates as candidates for local validation, not universal alarms. Our thresholds are independent experimental choices.

**Limit:** the study concerns Python repair benchmarks. Anchor-based milestones require gold patches; semantic tags require a model; write persistence requires more than edit counts. The framework supplies corpus diagnostics rather than a per-run root-cause oracle or remediation policy.

#### R5 — Visible errors can arrive after the important mistake

Zhao et al., **Failure as a Process: An Anatomy of CLI Coding Agent Trajectories**, 2026-07-10, preprint version 1. [Primary full text](https://arxiv.org/html/2607.09510v1).

The authors retain 1,794 annotated trajectories from 3,843 collected runs across seven models and three terminal scaffolds; 1,184 retained trajectories fail. They distinguish a decisive error, an empirically unrecovered point, and the first observable failure. The median decisive error occurs at step seven, substantially before the typical visible failure. Root causes include information misuse, capability gaps, and environmental blockers. Even a semantic prefix monitor reaches only 28.8% recall at best, with little advance warning.

**Implication:** record observed error episodes, time to the next successful matching operation, and first/post-edit verification. Label an unresolved observed episode as censored when logging ends.

**Limit:** decisive-error and recovery labels required LLM-assisted, human-adjudicated reading. “Unrecoverable” is retrospective, not proof that recovery was impossible. Filtered abnormal runs and a terminal benchmark limit transfer. Content-free telemetry cannot claim to locate the root cause or detect an inevitable failure.

#### R6 — Multi-agent failure has several distinct mechanisms

Cemri et al., **Why Do Multi-Agent LLM Systems Fail?**, first submitted 2025-03-17; inspected version 2, 2025-04-22. [Primary full text](https://arxiv.org/html/2503.13657v2).

MAST organizes 14 failure modes into specification/system design, inter-agent misalignment, and verification. Examples include repeated steps, lost context, premature termination, incomplete verification, and disregarded agent input. The inspected version studies seven frameworks and more than 200 tasks, reporting strong human annotation agreement.

**Implication:** separate a child's observed completion status from receipt of that completion by the parent. Preserve parent/child structure, delegated resource shares, and missing-terminal-event coverage. Use MAST as a vocabulary for validation labels, not as a direct map from counters to diagnoses.

**Limit:** mixed task domains and content-based annotations. Merely spawning many children does not demonstrate coordination failure; a status of completed does not prove its output was used or correct. Avoid pooling version-specific dataset counts from later MAST revisions into this citation.

#### R7 — Tool cycles and verbose reasoning are different

Lee et al., **Overthinking Loops in Agents: A Structural Risk via MCP Tools**, 2026-02-16, preprint version 1. [Primary full text](https://arxiv.org/html/2602.14798v1).

The authors induce cyclic tool behavior using malicious MCP tools in general agents and Qwen-Code. Individually plausible tool calls can combine into a costly cycle; output-concision controls do not reliably remove this structural behavior.

**Implication:** define repetition over ordered, deduplicated effective actions, not just reasoning tokens. Study exact same-call retries separately from alternating tool cycles, and report the share of observable actions in flagged windows.

**Limit:** adversarial experiments demonstrate a mechanism, not the prevalence of ordinary coding waste. Repeated test calls can diagnose flakes, polling can be necessary, and unchanged parameters can intentionally recheck changed external state. Do not classify a local loop as malicious or mistaken from this paper, and do not label every long reasoning response “overthinking.”

### Verification and downstream outcomes

#### R8 — Persistence requires a longitudinal Git observation

Popescu et al., **Investigating Autonomous Agent Contributions in the Wild: Activity Patterns and Code Change over Time**, 2026-04-01; MSR 2026 Technical Track. [Primary full text](https://arxiv.org/html/2604.00917v1).

The corpus contains 111,969 pull requests; the code-evolution sample takes 1,560 commits per agent/human category. The authors compare syntactic line survival and churn at three days, one week, and three weeks. Survival is unchanged added lines divided by initial added lines. Agent-associated commits exhibit more subsequent churn in this sample.

**Implication:** keep within-session edit recurrence distinct from post-merge line persistence. A future Git enrichment should state the seed revision, observation horizon, attribution confidence, and eligible/censored cohort; export only aggregates and keyed identities.

**Limit:** short horizons, imperfect AI/human attribution, differences in repositories and tasks, and syntactic rather than semantic matching. Refactoring and purposeful deletion reduce survival without reducing quality; retained code may be unused or defective. Transcript patch counters alone cannot calculate code survival.

#### R9 — Verify environmental state, not a completion assertion

Anthropic, **Demystifying evals for AI agents**, 2026-01-09, practitioner engineering report. [Primary article](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

The report distinguishes a recorded trajectory from the actual final environment and describes complementary code-based, human, and model graders. It recommends reusable task evaluations that can track latency, token use, costs, and errors while checking final outcomes.

**Implication:** store “a recognized check ran,” “the command exited successfully,” “an independent CI check passed,” and “an outcome was confirmed” as separate evidence states. Evaluate detectors against an independent labeled task set with repeated runs, rather than against their own triggering predicates.

**Limit:** engineering guidance, not an estimate of detector accuracy. A passing shell command establishes only that command's exit status. A named test command can run zero relevant tests; tools and harnesses affect what is observed. A provider task-complete marker is lifecycle evidence, not independent proof of correctness.

### Context and cache economics

#### R10 — Longer context is an exposure, not a diagnosis

Hong, Troynikov, and Huber, **Context Rot: How Increasing Input Tokens Impacts LLM Performance**, 2025-07-14, Chroma technical report. [Primary report](https://www.trychroma.com/research/context-rot); date corroborated by the [publisher's research index](https://www.trychroma.com/updates/research).

Controlled retrieval, conversational-memory, and repeated-word experiments across 18 models show nonuniform performance as input length increases. Simple needle retrieval does not characterize every long-context task.

**Implication:** expose request-level input occupancy, observed context-window coverage, compaction boundaries, and post-compaction rereading as separate measurements. Experiment with these as predictors on explicitly labeled tasks.

**Limit:** this is general LLM evidence, not a coding-agent trajectory validation. Model-specific behavior and artificial tasks do not establish a universal context percentage at which work becomes unreliable. Compaction can be helpful, and a long context can contain necessary information. Neither occupancy nor compaction count measures actual loss of understanding.

#### R11 — Measure cache value and latency separately

Lumer et al., **Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks**, 2026-01-09, preprint version 1. [Primary full text](https://arxiv.org/html/2601.06007v1).

The experiment compares cache strategies across four models and three providers using DeepResearchBench, 10,000-token system prompts, and 40 sessions per condition. Cost and time-to-first-token do not move identically across strategies. For example, the results table reports a GPT-4o full-context latency regression despite lower estimated cost.

**Implication:** separate cached-token fraction, cache-write volume, API-equivalent savings, and measured first-token latency. Version the pricing assumptions and show counter coverage.

**Limit:** research/search agents, not coding trajectories; a large static prompt dominates the setup. The abstract's ranges differ from detailed tables, so this survey does not repeat a headline savings range. UUID-based cache-breaking and warm-up treatment are experimental choices, not proposed product behavior. It does not justify assuming all cold input could have been cached, or that subscription headroom has a universal token conversion.

#### R12 — Harness changes can invalidate a shared prefix

Shihipar/Anthropic, **Lessons from building Claude Code: Prompt caching is everything**, 2026-04-30, practitioner engineering report. [Primary article](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything).

The report describes prefix-sensitive caching, stable-versus-changing prompt sections, model/tool changes, and compaction calls that reuse existing prefixes. These mechanisms explain why local miss-reason enums can be more informative than one aggregate cache-read ratio.

**Implication:** break down observed miss reasons, stratify by model and CLI version, and compare requests before/after a configuration or compaction boundary. Show actual write/read counters rather than predicting savings from prefix length alone.

**Limit:** product-specific engineering advice and date-specific behavior. It does not establish that an observed reason is avoidable, that every missing diagnostic denotes a cache hit, or that changing to a cheaper model is always economical. A cheaper-model counterfactual requires request-specific pricing and cache rebuilding assumptions, and remains an estimate.

#### R13 — A cache/context regression can mimic a model regression

Anthropic, **An update on recent Claude Code quality reports**, 2026-04-23, provider postmortem. [Primary article](https://www.anthropic.com/engineering/april-23-postmortem).

The incident report separates a changed effort default, repeated removal of reasoning history after an idle-session optimization, and a prompt change. The repeated history removal also caused cache misses. Effects differed across versions and user conditions and were not immediately reproduced by ordinary evaluations.

**Implication:** keep effort choice, CLI version, request cache diagnostics, idle gaps, and compaction events distinct. A within-model version comparison is a plausible investigation workflow; a joint shift in cache reads and repetition can prioritize inspection.

**Limit:** one vendor's retrospective diagnosis, not proof that a similar local pattern has the same cause. Lower effort need not mean lower delivered value; long reasoning need not mean waste. The product should present coincident changes and evidence coverage without claiming a causal explanation.

### Autonomy and human collaboration

#### R14 — Interruption can reflect practiced oversight

Anthropic, **Measuring AI agent autonomy in practice**, 2026-02-18, observational provider research. [Primary article](https://www.anthropic.com/research/measuring-agent-autonomy).

In interactive Claude Code data, more experienced users both auto-approve more and interrupt more. Reported per-turn interruption grows from roughly 5% for newer users to roughly 9% for experienced users. The work distinguishes human interruptions, agent-initiated stops, and turn duration; it cautions that duration is an imperfect autonomy proxy.

**Implication:** show interruption as an oversight pattern with a turn denominator. Separate interrupted, replaced, clarification, permission, and plan-review events when structured evidence permits. Compare within permission modes and experience cohorts only if those covariates are actually available.

**Limit:** observational product telemetry and some model-generated classifications. Complexity, user selection, parallel work, and defaults confound the pattern. Local logs do not reveal the reason or quality of an intervention. There is no evidence here that reducing interruptions improves results.

#### R15 — Approval frequency is weak evidence of attentive review

Anthropic, **How we built Claude Code auto mode: a safer way to skip permissions**, 2026-03-25, practitioner engineering report. [Primary article](https://www.anthropic.com/engineering/claude-code-auto-mode).

Anthropic reports users approve 93% of permission prompts and explains how repeated prompts can produce approval fatigue. The report distinguishes sandboxing, manual approval, and classifier-assisted decisions.

**Implication:** report approvals as a permission-policy/workflow measure, not a quality score or proof of human attention. Preserve a structured decision source: human, policy, classifier, or unknown.

**Limit:** the article does not validate plan rejection as a success predictor. Treat a structured human rejection of a plan as a distinct steering event because it evaluates a proposed approach; any stronger assertion about its predictive value is a local hypothesis requiring validation. A denied tool call must not be relabeled a plan rejection, and an automatic denial must not be attributed to the human.

#### R16 — Iterative collaboration may be the successful workflow

Kumar et al., **How Developers Use AI Agents: When They Work, When They Don't, and Why**, 2025-06-14, inspected preprint version 1. [Primary full text](https://arxiv.org/html/2506.12347v1).

The researchers observe 19 developers addressing 33 real issues in familiar repositories using an in-IDE agent. About half the issues are resolved; incremental problem solving and active iteration are associated with greater success. Participants also encounter trust, debugging, and testing challenges.

**Implication:** retain user-turn boundaries, revision cycles, and evidence of testing; permit comparison of interaction styles without declaring the most autonomous style best. A high follow-up count can reflect useful collaboration.

**Limit:** small qualitative/observational setting, a particular generation of tools, and no random assignment to collaboration strategy. More dialogue can result from a harder task. Session count or user messages cannot quantify developer attention, review burden, or time saved.

#### R17 — Activity and perceived speed are not productivity measurements

Becker et al./METR, **Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity**, 2025-07-10. [Primary study report](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/); [paper](https://arxiv.org/abs/2507.09089).

In a randomized experiment, 16 developers complete 246 real tasks in mature repositories they know well. Allowing early-2025 AI tools increases completion time by 19% in this setting, despite participants believing AI made them faster.

**Implication:** do not convert tool calls, completed turns, generated lines, or reported satisfaction into saved hours. A productivity claim requires an independent definition of the work, a comparison condition, and human-time measurement.

**Limit:** specific tools, experienced maintainers, familiar large repositories, and the early-2025 period. It is not a current universal estimate of AI productivity and must be read alongside R18. The result does not invalidate useful descriptive analytics; it limits what those analytics can claim.

#### R18 — Parallel work and selection complicate follow-up studies

Becker et al./METR, **We are Changing our Developer Productivity Experiment Design**, 2026-02-24. [Primary research update](https://metr.org/blog/2026-02-24-uplift-update/).

The follow-up reports substantial developer/task selection effects and unreliable task-time accounting for some developers running concurrent agents. Raw estimates lean toward speedup, but the researchers explicitly characterize the data as weak evidence for its magnitude and redesign the study.

**Implication:** separate wall span, summed agent durations, overlapping agent intervals, and measured human time. Include observation-window and task-selection limitations. Concurrency is a workflow characteristic, not a multiplier for human hours saved.

**Limit:** this is a methodology update with unresolved bias, not a clean new causal productivity estimate. It neither confirms that early-2025 results remain current nor licenses presenting the raw follow-up point estimates as established benefits.



### Research-to-design crosswalk

This table links motivation to our proposed definitions; it does not claim that the papers validated the thresholds in these cards. The four-in-ten repetition and three-failure predicates are local research choices, distinct from the source predicates described above.

| Candidate IDs | Research motivation | Evidence still needed |
| --- | --- | --- |
| D01–D02 | R1, R5, R9: separate actions from results and final outcomes | Reliable joins and independent recovery labels |
| D03–D05 | R1, R4, R7: repeated action patterns merit inspection | Benign polling/retries as hard negatives; local precision |
| D06–D08 | R2–R5, R9: placement of exploration and verification matters | Structured receipts or opt-in rules; comparable task cohorts |
| D09–D10 | R10–R13: context and cache effects must remain separate | Paired request windows, diagnostic coverage, causal experiments |
| D11–D12 | Local quota evidence and measurement design | Reset/account identity, freshness, calibrated forecasts; no claim of a published detector |
| D13–D15 | R14–R16: policy and human oversight shape the traces | Explicit decision actors and plan-decision events |
| D16–D17 | R6–R7, R13, R18: delegation, reasoning and duration are different | Owned child usage, effort-by-request, matched outcomes |
| D18, D20 | Measurement prerequisites in the local evidence | Latency units, source dedupe and synthetic drift tests |
| D19 | R8–R9, R17–R18: downstream observations and productivity need independent evidence | Attributed Git cohorts and sufficient follow-up; no productivity conversion |
