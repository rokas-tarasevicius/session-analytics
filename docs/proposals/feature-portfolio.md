# Feature portfolio: 84 concrete proposals, scored and sequenced

Status: editorial product research, 2026-10-02. **None of these rows claims a new
feature has shipped.** Several improve a capability that already exists; the
increment is in the definition. [Strategy](product-strategy.md) selects a small
release set; this portfolio is not a commitment to build all 84 ideas.

The [CSV](feature-scores.csv) is the canonical sortable research dataset. This
page renders the same rows by category. Each row has value, differentiation
against all seven named alternatives, effort, privacy tier, exact data evidence,
implementation availability and risk scores. [Evidence IDs](evidence-audit.md)
refer to code review or a bounded local sample, not a provider-wide guarantee.
See [metric contracts](metric-contracts.md) for formulas, guards and worked checks.

## Scoring rubric

- **V, user value (1–5):** 1 cosmetic; 2 occasional convenience; 3 recurring useful
  question; 4 meaningful workflow decision; 5 protects a core trust decision or
  solves the target parallel-agent user's recurring investigation. These are
  unvalidated judgments, not survey results.
- **D, differentiation (0–2 per alternative):** 0 basic overlap; 1 a narrower
  scope/trust/implementation distinction; 2 a specific cross-provider evidence
  workflow worth testing. Neither 1 nor 2 means the other tool lacks a feature.
  Vector order is **ccusage / CodeBurn / AgentsView / tokscale / CodexBar /
  Claude Code `/usage` / Claude Code `/insights`**. The mean of seven entries is
  used for ranking. Conservative category defaults come from the
  [primary-source comparison](competitive-landscape.md); uncertainty is not a
  license to award a gap. Only TR01, WF04 and PR01 receive any 2, for a
  denominator-aware cross-provider explanation relative to narrower documented
  workflows. All require pilot validation; no competitor was benchmarked.
- **E, implementation effort (1–5):** 1 up to one engineering day; 2 roughly 2–3
  days; 3 roughly 4–7 days; 4 roughly 8–15 days; 5 more than 15 days or substantial
  uncertainty. Includes fixtures/docs/review; assumes listed dependencies already
  exist. A capped feasibility spike can have E5 for a complete release.
- **A, data availability (0–3):** 3 current projection or repository artifact
  supports the core idea; 2 required structured evidence observed locally but
  not yet normalized; 1 supplied inventory, manual input or a new integration
  requiring further validation; 0 intentionally unavailable or no source/contract.
  Mixed rows take the weakest essential input. A3 is not “implementation exists.”
- **R, risk (1–5):** 1 bounded/reversible; 2 coverage/privacy edge cases; 3 material
  inference or identity ambiguity; 4 boundary expansion or serious false-positive
  risk; 5 weak measurement validity or a new service/content trust boundary.
  Each row names its specific failure mode.
- **Privacy:** most sensitive proposed processing tier, not final counter shape.
  P2/P3 are opt-in and off by default. P1 does not mean anonymous. Unstructured
  command/diff interpretation is P2; no row silently downgrades it because the
  output is a number. OU01 restricts its P0 increment to structured line counts.

**Score = 5V + 4(mean D) + 2A − 2E − 2R.** Rank descending on the exact
sevenfold numerator, then higher V, lower E, and ID. Display rounds to two decimals.
The CSV retains that integer numerator for reproducibility. Weights favor user
value and available evidence over novelty. Numbers help expose disagreements;
ordinal effort is not a budget or forecast. Dependencies, trust gates and capacity
can place a lower-ranked item before a higher-ranked one.

Horizon: `2w` = selected foundation slice; `6w` = selected next slice;
`quarter` = selected later slice; `*-candidate` = cut first if capacity is short;
`*-pilot` = bounded design partner experiment; `quarter-spike` = capped technical
experiment; `backlog` = unscheduled; `defer` = outside quarter commitments. The
strategy has explicit capacity and cut rules. No high score bypasses a dependency.

## Ranked shortlist

| Rank | ID | Increment | Score | Horizon | V/E/A/R |
| --- | --- | --- | --- | --- | --- |
| 1 | PR05 | Projection contract and sentinel kit | 29.00 | 2w | 5/2/3/1 |
| 2 | PR01 | Source capability inspector | 28.71 | 2w | 5/2/2/1 |
| 3 | UX05 | Metric explainers and guard states | 27.29 | 2w | 5/2/3/1 |
| 4 | IN01 | Versioned snapshot contract | 26.14 | 2w | 5/2/3/1 |
| 5 | CO02 | Unpriced-usage triage | 25.57 | 2w | 5/2/3/1 |
| 6 | DS05 | Synthetic provider fixture kit | 25.00 | 6w-candidate | 5/2/3/1 |
| 7 | AF05 | Versioned bounded agent schema | 25.00 | quarter | 5/3/3/2 |
| 8 | PR02 | Export field preview | 25.00 | quarter | 5/3/3/2 |
| 9 | TR01 | Matched tool-outcome ledger | 23.57 | 6w | 5/3/2/2 |
| 10 | TE07 | Security review/adoption kit | 23.43 | quarter-candidate | 4/2/3/1 |
| 11 | AF02 | Repository tool_reliability query | 23.00 | quarter | 5/3/2/2 |
| 12 | DS07 | Verifiable offline release bundle | 23.00 | quarter-candidate | 5/3/3/1 |
| 13 | PR07 | Provider-format drift monitor | 23.00 | 6w-candidate | 5/3/2/2 |
| 14 | UX01 | Evidence-led overview cards | 22.14 | 6w | 5/3/3/2 |
| 15 | UX06 | First-run synthetic walkthrough | 21.14 | backlog | 4/2/3/1 |
| 16 | DS01 | Compiled npm release | 21.00 | 2w | 5/3/3/2 |
| 17 | TC01 | Coverage-aware cache comparison | 20.86 | 6w-candidate | 4/2/3/2 |
| 18 | CH01 | Deterministic weekly review | 20.29 | backlog | 4/2/3/2 |
| 19 | UX04 | Matched-period comparison | 20.14 | 6w | 5/3/3/3 |
| 20 | WF01 | Profile-aware cohorts | 20.14 | 6w | 5/3/2/2 |
| 21 | AF06 | Local preflight evidence card | 20.00 | backlog | 4/2/2/2 |
| 22 | DS04 | Static evidence-first docs site | 20.00 | 6w-candidate | 4/2/3/1 |
| 23 | DS06 | Decision-focused launch demo | 20.00 | 6w-candidate | 4/2/3/1 |
| 24 | CO05 | Timestamped quota history | 19.57 | 6w | 5/3/2/2 |
| 25 | IN02 | Minimized CSV/Markdown export | 19.14 | backlog | 4/2/3/2 |

## Complete portfolio

Each score cell reads `rank · score; V/E/A/R; D vector`. Dependencies are IDs;
`none` means no other portfolio item, not zero engineering work. Existing docs,
read-only access and the privacy contract are prerequisites for every item.

### Cost and limits

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **CO01 Receipt reconciliation ledger** | Explain a discrepancy by comparing observed API-equivalent value with a same-basis source receipt; preserve unmatched totals. | #30 · 17.57; V/E/A/R 5/3/2/3; D 0/0/0/0/0/0/1; **P0**; 6w-candidate | E01 SessionAnalytics.cost/costBasis; E05 SDK result total_cost_usd and modelUsage observed but not projected; receipt boundaries need matching. | Subscription and API bases may differ; receipt is not automatically ground truth. Dependencies: PR01;IN01. |
| **CO02 Unpriced-usage triage** | Turn an unknown-model warning into tokens affected, excluded value basis and a reviewed rate-card contribution path. | #5 · 25.57; V/E/A/R 5/2/3/1; D 0/0/0/0/0/0/1; **P0**; 2w | E01 models[].priced/model, pricedTokenCoverage, rateCard.effectiveDate and fixed warnings already public. | Cannot estimate missing dollars from zero; model identifiers remain bounded provider metadata. Dependencies: PR01. |
| **CO03 Billing-modifier evidence ledger** | Separate observed service tier/speed/region modifiers from assumptions and compare repriced components. | #60 · 10.57; V/E/A/R 4/4/2/3; D 0/0/0/0/0/0/1; **P0**; backlog | E02 assistant.message.usage.service_tier/speed observed; region unobserved; E03 rate-limit labels do not prove billing modifiers; reviewed mapping still required. | Observed labels may not establish billed tier or region; unknown remains unpriced modifier. Dependencies: CO01. |
| **CO04 Manual subscription multiple** | Compare API-equivalent value with a manually entered same-period plan price and explicit account grouping. | #71 · 7.57; V/E/A/R 3/2/1/3; D 0/0/0/0/0/0/1; **P1**; backlog | E01 cost totals; new local configuration for amount/currency/period/account grouping; no reliable automatic profile-to-account identity. | Not ROI or savings; annual plans/taxes/credits and shared accounts invalidate simple comparisons. Dependencies: WF01;PR02. |
| **CO05 Timestamped quota history** | Show latest source-profile/window percentage/reset with account identity unknown; no cross-profile sum or assumed login continuity; expire when stale. | #24 · 19.57; V/E/A/R 5/3/2/2; D 0/0/0/0/0/0/1; **P0**; 6w | E03 event_msg[token_count].payload.rate_limits.primary/secondary.used_percent/window_minutes/resets_at; E06 auxiliary histories have limited local coverage. | Aliases may share quota; historical samples do not guarantee live capacity; never sum percentages. Dependencies: WF01;PR01. |
| **CO06 Bounded quota forecast** | Project a same-window percentage slope only with enough fresh monotone samples; otherwise show unknown. | #78 · 1.57; V/E/A/R 3/4/1/4; D 0/0/0/0/0/0/1; **P0**; backlog | E03 rate_limits snapshots exist; stable account/window identity requires explicit verified configuration plus new series/reset dedupe. | Bursty workload and shared accounts destroy extrapolation; forecasts must not auto-admit work. Dependencies: CO05;CO04. |
| **CO07 Counterfactual token pricing** | Reprice observed token classes at a selected reviewed rate card with exclusions visible. | #63 · 9.57; V/E/A/R 3/2/2/3; D 0/0/0/0/0/0/1; **P0**; backlog | E01 model token classes and data/rate-cards.json; request-level long-context modifiers require retained requests, not session maxima. | Same tokens at another rate do not predict another model's tokens, latency, quality or realized savings. Dependencies: CO02. |

### Tokens, context and cache

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **TC01 Coverage-aware cache comparison** | Compare weighted cache-read share and observed cache-write volume with both cohorts' coverage. | #17 · 20.86; V/E/A/R 4/2/3/2; D 1/1/0/1/1/0/1; **P0**; 6w-candidate | E01 tokens.cachedInputTokens/uncachedInputTokens/cacheWriteInputTokens; no new source needed for aggregate ratio, request coverage requires adapter work. | Cache-read share is not unique text reuse; unavailable cache classes must not appear as measured zero. Dependencies: PR01;UX04. |
| **TC02 Provider-reported cache-miss reasons** | Group cache-miss events by allowlisted provider reason and show unknown-reason count. | #34 · 16.86; V/E/A/R 4/3/2/2; D 1/1/0/1/1/0/1; **P0**; backlog | E02 assistant.message.diagnostics.cache_miss_reason.type observed on 34/3,871 assistant records; not a top-level diagnostics field. | A reason label is provider diagnosis, not independently proved cause; changing tool/security context may be necessary. Dependencies: PR01. |
| **TC03 Observed re-cache burden** | Associate observed creation cost with the explicit miss on the same deduped request; later-window joins need schema evidence. | #51 · 12.86; V/E/A/R 4/4/2/3; D 1/1/0/1/1/0/1; **P0**; backlog | E02 message.id, timestamp, message.usage.cache_creation and message.diagnostics; requires per-request normalized timeline. | Do not add already-priced tokens twice or call all creation avoidable waste; temporal link is not causation. Dependencies: TC02;IN01. |
| **TC04 Aligned context-fill curve** | Plot each request's normalized total input (including non-overlapping cache classes) divided by its contemporaneous window, with gaps. | #43 · 14.86; V/E/A/R 4/3/2/3; D 1/1/0/1/1/0/1; **P0**; backlog | E03 event_msg[token_count].payload.info.last_token_usage.input_tokens and model_context_window; E01 stores independent maxima only. | Current maxima cannot produce true peak if windows change; no universal context danger threshold. Dependencies: IN01. |
| **TC05 Compaction event ledger** | Show boundaries, recorded pre/post sizes, duration and following-request usage without a quality score. | #62 · 9.86; V/E/A/R 3/3/1/2; D 1/1/0/1/1/0/1; **P0**; backlog | E01/E03 compaction counts exist; E02 compact_boundary.compactMetadata sizes/duration are inventory-only, unverified in sample. | A boundary count is not context loss; field absence means size/duration unavailable. Dependencies: IN01. |
| **TC06 Context amplification diagnostic** | Show processed input per observed model call, separating cached and uncached volume. | #68 · 8.86; V/E/A/R 2/2/3/3; D 1/1/0/1/1/0/1; **P0**; backlog | E01 tokens.inputTokens and metrics.modelCalls with source-specific request dedupe. | Repeated context is normal; ratio says nothing about redundant unique text or task success. Dependencies: UX05. |
| **TC07 Reasoning exposure coverage** | Show reasoning share only alongside responses exposing the breakdown; retain output pricing unchanged. | #48 · 13.86; V/E/A/R 3/2/2/2; D 1/1/0/1/1/0/1; **P0**; backlog | E02 usage.output_tokens_details.thinking_tokens and E03 usage reasoning fields; E01 reasoningOutputTokens lacks per-response exposure denominator. | Missing thinking counters are not zero reasoning; labels differ across providers. Dependencies: PR01. |

### Tools and reliability

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **TR01 Matched tool-outcome ledger** | Join calls to terminal results once; show errors, successes, interrupted and unknown with matched-outcome coverage. | #9 · 23.57; V/E/A/R 5/3/2/2; D 2/0/0/1/2/2/1; **P0**; 6w | E02 user.message.content tool_result.is_error and tool_use IDs; E03 item_completed CommandExecution status observed, McpToolCall inventory-only; currently unprojected. | Missing outcomes and provider semantics bias rates; raw error text never becomes a class. Dependencies: PR01;IN01. |
| **TR02 Tool duration distribution** | Show p50/p95 recorded durations by tool and outcome with eligible sample counts. | #35 · 16.86; V/E/A/R 4/3/2/2; D 1/0/0/1/1/1/1; **P0**; backlog | E02 user.toolUseResult.totalDurationMs observed in one delegated receipt; E03 item.duration in 20 command items; WebFetch/SDK durations unverified. | Unit variations and parallel calls; summed latency is not elapsed user wait. Dependencies: TR01. |
| **TR03 Opt-in error taxonomy** | Classify bounded local command/error patterns into rule IDs for missing executable, test failure or edit mismatch. | #59 · 10.86; V/E/A/R 4/4/1/3; D 1/0/0/1/1/1/1; **P2**; backlog | E02/E03 raw command and result bodies exist but are prohibited outputs; new local rule pack plus fixtures required; structured codes preferred first. | Rules may misclassify arbitrary text; off by default; unknown class retained. Dependencies: TR01;PR05. |
| **TR04 Repeated failing-call flag** | Flag three matched failures with the same keyed tool/argument fingerprint within five minutes. | #52 · 12.86; V/E/A/R 4/4/2/3; D 1/0/0/1/1/1/1; **P1**; backlog | E02 call input/result IDs and E03 function call arguments/output correlation; inputs hashed inside parser with new machine secret. | Retries/polling can be intentional; fingerprints are identifying and cannot leave local scope by default. Dependencies: TR01;PR03. |
| **TR05 MCP health by server** | Compare structured MCP calls/errors/durations and distinguish connection failure from tool error. | #44 · 14.86; V/E/A/R 4/3/1/2; D 1/0/0/1/1/1/1; **P1**; backlog | E03 McpToolCall.server/tool/status/duration inventory-only; E02 MCP attribution observed but outcome/connection attachments unverified. | Server names may identify private infrastructure; configured inventory is not invocation evidence. Dependencies: TR01. |
| **TR06 Hook latency and blocks** | Report hook-run count, explicit blocks and observed duration distributions without hook commands. | #56 · 11.86; V/E/A/R 3/3/2/2; D 1/0/0/1/1/1/1; **P0**; backlog | E02 system.stop_hook_summary hookCount/hookInfos[].durationMs/hookErrors/preventedContinuation; available subset sampled. | Hook errors can be deliberate policy enforcement; duration fields and aggregation may overlap. Dependencies: PR01. |
| **TR07 Provider retry burden** | Separate API retry attempts, delay and bounded status codes from tool failures. | #45 · 14.86; V/E/A/R 4/3/1/2; D 1/0/0/1/1/1/1; **P0**; backlog | E02 assistant isApiErrorMessage/apiErrorStatus observed; system.api_error retryAttempt/retryInMs are inventory-only and need nesting validation. | Error bursts are not model responses; retries must not double count calls or price. Dependencies: PR01. |

### Outcomes

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **OU01 Observed edit volume** | Count explicit structured added/removed lines; offer a separately opted-in P2 diff rule later. | #61 · 9.86; V/E/A/R 3/3/2/3; D 1/0/0/1/1/1/1; **P0**; backlog | E02 cost-state.totalLinesAdded/Removed observed in 6 cumulative snapshots: use validated maxima/deltas/reset handling, never sum; toolStats nested line counts unverified. | Repeated edits inflate churn; line count is not net change, quality or value. Dependencies: PR01. |
| **OU02 Artifact-operation evidence** | Record bounded commit/push/PR-created event counts and opaque internal links without claiming a merge. | #33 · 16.86; V/E/A/R 4/3/2/2; D 1/0/0/1/1/1/1; **P1**; quarter | E02 toolUseResult.gitOperation and pr-link fields; IDs/URLs consumed internally and excluded from public output. | A recorded operation can fail or refer to another artifact; do not publish raw PR URLs or SHAs. Dependencies: IN01;PR03. |
| **OU03 Evidence-ranked artifact joins** | Link sessions to independently checked artifacts with explicit/mapped/temporal confidence and unallocated work. | #55 · 11.86; V/E/A/R 5/5/1/4; D 1/0/0/1/1/1/1; **P1**; quarter-pilot | E02 pr-link/gitOperation; E05 workspaces artifact metadata shape; new local Git join; E08 merge status needs independent evidence. | Many sessions per artifact and vice versa; no authorship claims; weak time matches cannot allocate cost. Dependencies: OU02;IN03;PR02. |
| **OU04 Value per confirmed merged artifact** | Compare API-equivalent value per unique independently confirmed merge, with shared/unlinked pool visible. | #77 · 1.86; V/E/A/R 3/4/1/5; D 1/0/0/1/1/1/1; **P1**; backlog | E01 session value plus OU03 links; E08 no merge confirmation in current projection, requires explicit import/enrichment. | Small cohorts and task mix make rankings misleading; no developer or ROI score. Dependencies: OU03;IN04. |
| **OU05 Opt-in verification transitions** | Count same-class failing-to-passing test/build transitions from versioned local command rules. | #58 · 10.86; V/E/A/R 4/4/1/3; D 1/0/0/1/1/1/1; **P2**; backlog | E03 CommandExecution.parsed_cmd/exit_code and E02 Bash results; known command class still requires rule validation and opt-in. | Shell success can be unrelated to tests; tests outside captured session remain unknown. Dependencies: TR01;PR05. |
| **OU06 Opt-in last-edit verification gap** | Flag a recorded final edit without later observed verification only in closed, adequately captured sessions. | #67 · 8.86; V/E/A/R 4/4/1/4; D 1/0/0/1/1/1/1; **P2**; backlog | E02 Edit/Write events; E03 FileChange and task_complete; current public counters omit ordered edits/results. | Cannot say tests were skipped; incomplete logs and external CI are common alternative explanations. Dependencies: OU05;WF03. |
| **OU07 Change survival/revert study** | Pilot local AST/diff rules for revert/survival evidence solely as artifact follow-up, not value per line. | #82 · -5.14; V/E/A/R 2/5/1/5; D 1/0/0/1/1/1/1; **P2**; defer | E08 local Git history available only after explicit scope; blame/diffs require new opt-in P2 processing and boundary tests. | Refactors, squash merges and rename detection confound survival; high cost and surveillance misuse outweigh early value. Dependencies: OU03;IN03. |

### Workflow and behavior

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **WF01 Profile-aware cohorts** | Expose opaque profile selection and dedupe aliases so work/personal histories can be compared without paths. | #20 · 20.14; V/E/A/R 5/3/2/2; D 1/0/0/0/1/0/0; **P1**; 6w | E01 discoverProviderRoots already resolves aliases; E02/E03 multiple stores verified; new local profile key/projection needed. | Profile is not account identity; custom display labels can identify employers and stay local. Dependencies: PR03;IN01. |
| **WF02 Observed concurrency timeline** | Plot overlapping observed session spans and union duration, clearly labeled upper-envelope activity. | #31 · 17.14; V/E/A/R 4/2/3/3; D 1/0/0/0/1/0/0; **P0**; backlog | E01 firstEventAt/lastEventAt and metrics.eventSpanMilliseconds; E09 sessions have idle gaps. | Not effective parallelism or speedup; Claude composite and Codex child units differ. Dependencies: UX05. |
| **WF03 Turn interval ledger** | Separate explicit active-turn intervals from unclassified gaps using start/completion/interruption markers. | #57 · 11.14; V/E/A/R 4/4/2/3; D 1/0/0/0/1/0/0; **P0**; backlog | E03 task_started/task_complete/turn_aborted; E07 thread_turns duration_ms observed, starts sparse; E02 turn_duration inventory-only; no active-compute claim. | Clock mismatch, missing ends and overlapping intervals prevent exact human/agent/wait split. Dependencies: IN01. |
| **WF04 Delegation ownership graph** | Show own/delegated/shared-unknown usage with parent-child edges where explicitly evidenced. | #36 · 16.43; V/E/A/R 5/4/1/3; D 2/0/0/0/2/2/0; **P1**; quarter-pilot | E02 subagents and agentId observed; E03 session_meta.payload.source.subagent.thread_spawn.parent_thread_id/depth inventory-only; graph edges need validation. | Aliases/resumed threads cause cycles or changed roles; hashes and graph topology are sensitive. Dependencies: WF01;IN01. |
| **WF05 Interrupt and steering counters** | Report explicit interrupted/replaced turns beside cohort and coverage; no failure label. | #70 · 8.14; V/E/A/R 3/3/2/3; D 1/0/0/0/1/0/0; **P0**; backlog | E03 turn_aborted.reason and user-message chronology; E02 Bash interrupted; steering beyond explicit enums may need P2 rule. | Interruption may reflect expert guidance or task change; cannot infer dissatisfaction. Dependencies: WF03. |
| **WF06 Plan decisions versus permissions** | Separate observed plan rejections from permission approvals/denials; suppress absent plan-decision rate. | #74 · 6.14; V/E/A/R 3/3/1/3; D 1/0/0/0/1/0/0; **P0**; backlog | E02 permissionMode/toolDenialKind observed; E03 turn_context policies/mode; explicit plan-rejection signal not established by sampled data. | Policy mode is not a decision event; near-universal approval is a weak behavior signal. Dependencies: PR01. |
| **WF07 Model/effort/version cohorts** | Compare like-for-like repository cohorts before and after a recorded CLI/model/effort change. | #49 · 13.14; V/E/A/R 4/3/2/3; D 1/0/0/0/1/0/0; **P1**; backlog | E01 models and final effort; E02 record.version and E03 session_meta.cli_version/turn_context; request-level effort requires new segments. | Task mix and concurrent changes confound comparisons; session-final effort cannot characterize every request. Dependencies: WF01;UX04. |

### Agent-facing

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **AF01 Metrics-only budget_status** | Return scoped API-equivalent usage, observed quota age and unknowns in a bounded agent response. | #39 · 16.00; V/E/A/R 4/3/2/3; D 1/1/1/1/1/1/1; **P1**; quarter-candidate | E01 session/repository cost; E03 limit observations need CO05; caller must explicitly select opaque scope, no automatic raw thread IDs. | No guaranteed remaining tokens, budget enforcement or raw transcript access; agent may overtrust stale data. Dependencies: CO05;AF05. |
| **AF02 Repository tool_reliability query** | Answer a tool question with matched outcomes, baseline window and denominator in this repository. | #11 · 23.00; V/E/A/R 5/3/2/2; D 1/1/1/1/1/1/1; **P1**; quarter | E01 repository key/tool names; E02/E03 structured call/results after TR01; no prompts required. | Correlated historical errors are not proof a planned call will fail; small samples return unknown. Dependencies: TR01;AF05. |
| **AF03 Comparable typical_cost query** | Return median/range of API-equivalent session values for a supplied matched cohort, not a task-cost promise. | #50 · 13.00; V/E/A/R 3/3/3/3; D 1/1/1/1/1/1/1; **P1**; backlog | E01 cost/model/provider/execution fields; explicit task labels optional new local metadata; current session units differ by provider. | No task understanding from metrics; avoid mixing Claude composites with Codex spawned threads. Dependencies: AF05;UX04. |
| **AF04 Agent mcp_health query** | Expose recent structured server outcomes and stale/unsupported states to the calling agent. | #28 · 18.00; V/E/A/R 4/2/1/2; D 1/1/1/1/1/1/1; **P1**; backlog | E03 McpToolCall after TR05; local opaque repo scope; fixed bounded reply schema. | Server names identify integrations; cannot diagnose connectivity from old success counters. Dependencies: TR05;AF05. |
| **AF05 Versioned bounded agent schema** | Build read-only metrics queries over the allowlisted projection with max rows, time window and explicit unavailable reasons. | #7 · 25.00; V/E/A/R 5/3/3/2; D 1/1/1/1/1/1/1; **P1**; quarter | E01 MachineAnalytics and existing agent skill; no MCP runtime currently; protocol/transport implementation required without runtime dependencies. | Prompt injection via unchecked labels or unbounded responses; reject arbitrary paths, raw SQL and content queries. Dependencies: IN01;PR05. |
| **AF06 Local preflight evidence card** | Have the skill summarize selected repository coverage and typical observed tool issues before a user-chosen task. | #21 · 20.00; V/E/A/R 4/2/2/2; D 1/1/1/1/1/1/1; **P1**; backlog | E01 report --json/skill already exist; newer reliability measures require TR01; no task text ingestion required. | Generic advice and extra tool overhead can outweigh benefit; measure decision usefulness. Dependencies: AF05;TR01. |
| **AF07 Opt-in advisory hook** | Explicitly installed hook offers historical flags at tool boundaries, with bypass and a latency cap. | #76 · 2.00; V/E/A/R 2/4/2/4; D 1/1/1/1/1/1/1; **P1**; defer | E02/E03 outcomes after TR01; new provider hook integration and scoped configuration writes need separate authorization. | False positives interrupt useful work; this is a trust-boundary expansion, never part of read-only default. Dependencies: AF02;PR02. |

### Coaching

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **CH01 Deterministic weekly review** | Select at most three supported changes, each with baseline, limitation and one reversible experiment. | #18 · 20.29; V/E/A/R 4/2/3/2; D 1/0/0/1/1/1/0; **P1**; backlog | E01 existing aggregates; richer cards depend on TR01/CO05; local templates only, no LLM. | Multiple comparisons create noise; no savings claim or automatic delivery to others. Dependencies: UX01;UX04. |
| **CH02 Local experiment notebook** | Let users pin one bounded configuration change and compare frozen cohorts before/after. | #53 · 12.29; V/E/A/R 4/3/1/3; D 1/0/0/1/1/1/0; **P1**; quarter-candidate | E08 (new input/integration): New explicit local experiment ID/enum/cohort metadata; no reliable automatic config-change identity in current output. | User notes may contain sensitive text; keep notes out of public schema; observational not causal. Dependencies: UX04;PR02. |
| **CH03 Cache diagnosis card** | Explain a provider-reported miss and measured subsequent creation cost with unknown causes retained. | #37 · 16.29; V/E/A/R 4/2/2/3; D 1/0/0/1/1/1/0; **P0**; backlog | E02 diagnostics and creation counters after request-aligned ingestion; raw context never exposed. | Do not advise weakening system instructions or permissions merely to improve cache. Dependencies: TC02;TC03. |
| **CH04 Reviewable failure-loop card** | Show a repeated failing-call window with counts and comparable baseline, then suggest inspection. | #38 · 16.29; V/E/A/R 4/2/2/3; D 1/0/0/1/1/1/0; **P1**; backlog | E02/E03 keyed fingerprints plus statuses; no command or result shown. | Loops occur in successful runs; user must be able to dismiss, not accept a failure verdict. Dependencies: TR04;UX04. |
| **CH05 Configured-versus-observed extensions** | Compare bounded configured plugin/MCP inventory with observed invocation counts over an explicit window. | #72 · 7.29; V/E/A/R 3/3/1/3; D 1/0/0/1/1/1/0; **P1**; backlog | E06 settings enabledPlugins/counters partly present; complete MCP inventory shape unverified; current tools/skills are invocation-only. | Installed-but-unseen can mean incomplete history, security reserve or episodic use; never auto-remove. Dependencies: PR01;TR05. |
| **CH06 Skill adoption evidence** | Compare explicit and inferred skill invocations separately, with unavailable provider states. | #42 · 15.29; V/E/A/R 3/2/3/2; D 1/0/0/1/1/1/0; **P0**; backlog | E01 skills and skillEvidence already public; attributionSkill may offer future explicit evidence after validation. | Canonical SKILL.md reads are only a lower bound; installation/listing does not prove use. Dependencies: PR01. |
| **CH07 Per-run content review** | Only after a separate privacy design, let a user preview selected content windows for their chosen model. | #84 · -7.71; V/E/A/R 2/5/0/5; D 1/0/0/1/1/1/0; **P3**; defer | E08 current projection intentionally excludes content; requires a new separate read/preview/send path and per-run opt-in. | Breaks default content boundary and creates credential/retention/injection concerns; excluded from quarter commitments. Dependencies: PR02;PR04. |

### Team

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **TE01 User-reviewed aggregate bundle** | Pilot coarse repository-alias bundles on synthetic data until minimum static small-cell/complementary-total rules pass review; no session records. | #41 · 15.43; V/E/A/R 4/4/3/3; D 1/1/0/1/1/1/1; **P1**; quarter-pilot | E01 local aggregates exist; new bundle minimization, identity policy and preview; no automatic upload. | Small cohorts and model/tool names can reidentify work; no anonymity claim or default sharing. Dependencies: PR02;PR03;IN01. |
| **TE02 Explicit multi-machine import** | Merge reviewed aggregate bundles with provenance and duplicate-origin checks for a user's own machines. | #75 · 2.43; V/E/A/R 3/5/1/4; D 1/1/0/1/1/1/1; **P1**; backlog | E08 (new input/integration): New user-provided exports; no device identity/session-dedupe contract exists today. | Double counts moved transcripts; per-machine hashes cannot safely join global identities. Dependencies: TE01;IN07. |
| **TE03 Team comparability coverage** | Show schema/provider/time-window compatibility before combining team aggregates. | #69 · 8.43; V/E/A/R 3/3/1/3; D 1/1/0/1/1/1/1; **P1**; backlog | New exported capability manifest and metric version; E01 source coverage too coarse for cross-machine equivalence. | Missing members or different capture policies can invalidate apparent team trends. Dependencies: TE01;PR01. |
| **TE04 Small-cell and difference suppression** | Suppress small aggregate cells and complementary totals; prevent repeated-filter differencing in any future shared view. | #64 · 9.43; V/E/A/R 4/4/1/4; D 1/1/0/1/1/1/1; **P1**; backlog | E08 (new input/integration): New bundle/query policy and deliberate test corpus; threshold alone is not anonymity; membership counts require explicit input. | Repeated releases leak differences; k-thresholds do not protect against auxiliary knowledge. Dependencies: TE01. |
| **TE05 Recipient consent and retention controls** | Version what is shared, who selected it and retention intent; stop future exports on revocation. | #65 · 9.43; V/E/A/R 4/4/1/4; D 1/1/0/1/1/1/1; **P1**; backlog | E08 (new input/integration): New local sharing preferences and recipient agreement; no centralized identity or enforcement service today. | Previously copied bundles cannot be remotely erased; do not promise revocation of already shared copies. Dependencies: TE01. |
| **TE06 Self-hosted aggregate collector** | Consider a separate service receiving reviewed aggregates only after validated organizational demand. | #83 · -6.57; V/E/A/R 2/5/0/5; D 1/1/0/1/1/1/1; **P1**; defer | E08 no auth, RBAC, ingest API or remote server exists; current server is loopback GET-only. | Operational/security scope exceeds analytics tool; no shared transcript service or manager rankings. Dependencies: TE01;TE03;TE04;TE05. |
| **TE07 Security review/adoption kit** | Publish trust-boundary diagram, reproducible synthetic checks, supported-source matrix and offline test instructions. | #10 · 23.43; V/E/A/R 4/2/3/1; D 1/1/0/1/1/1/1; **P0**; quarter-candidate | E01 architecture/privacy/SECURITY and current sentinels already exist; package-specific evidence needs DS01. | Documentation is not certification; avoid compliance guarantees or collecting organization histories. Dependencies: PR05;DS04. |

### Privacy and trust

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **PR01 Source capability inspector** | Show present/absent/unsupported fields and eligible counts beside metrics, with fixed reasons and freshness. | #2 · 28.71; V/E/A/R 5/2/2/1; D 2/1/1/1/2/2/1; **P0**; 2w | E01 transcript health/model coverage; E02-E07 source field observations require aggregate capability projection, not raw inventory. | Sample presence is not universal provider support; no real filesystem names in diagnostics. Dependencies: none. |
| **PR02 Export field preview** | Preview exact allowlisted fields, sensitivity and cardinality before user-directed file export. | #8 · 25.00; V/E/A/R 5/3/3/2; D 1/1/1/1/1/1/1; **P1**; quarter | E01 MachineAnalytics projection/manifest; new export serializer and UI, repository names identifiable today. | Content-free is not anonymous; custom names/keys/timestamps can reveal work and must be minimized. Dependencies: IN01. |
| **PR03 Keyed pseudonym mode** | Offer local per-machine keyed repository/profile/session aliases with explicit reset/linkability behavior. | #29 · 18.00; V/E/A/R 4/3/3/3; D 1/1/1/1/1/1/1; **P1**; 6w | E01 IDs are existing truncated hashes, not a machine-secret scheme; new local secret/configuration required. | Secret rotation breaks saved links; same aliases link time periods; no cross-machine matching by default. Dependencies: IN01. |
| **PR04 Derived-index lifecycle controls** | Show index size/age/version; support explicit rebuild/retention and local key reset without touching sources. | #54 · 12.00; V/E/A/R 4/4/1/3; D 1/1/1/1/1/1/1; **P1**; quarter-candidate | E08 no persistent index today; depends on index-store lane; path watermark mapping is internal-sensitive metadata, not public metrics. | Deleting an index does not delete source history; source paths in ingest metadata need restrictive local permissions. Dependencies: IN01. |
| **PR05 Projection contract and sentinel kit** | Extend contributor-facing schema/field checklist and synthetic sentinel corpus across each new surface. | #1 · 29.00; V/E/A/R 5/2/3/1; D 1/1/1/1/1/1/1; **P0**; 2w | E01 fixtures and analyzer/accounting/server/CLI tests already enforce core boundary; current public types lack schemaVersion. | Synthetic coverage cannot prove every leak absent; field allowlisting and bounded labels remain required. Dependencies: none. |
| **PR06 Offline permission doctor** | Report fixed source-readable/unsupported/runtime/network-policy checks without dumping environment or paths. | #40 · 16.00; V/E/A/R 4/3/1/2; D 1/1/1/1/1/1/1; **P0**; backlog | E01 options/discovery and fixed error patterns; new probe diagnostics needed; runtime network-denial proof needs test harness. | Avoid broad OS scans, credentials and permission-changing actions; diagnose only configured sources. Dependencies: PR01;DS01. |
| **PR07 Provider-format drift monitor** | Expose unexpected record-shape counts and loss of required-field coverage, with provider/version enums. | #13 · 23.00; V/E/A/R 5/3/2/2; D 1/1/1/1/1/1/1; **P0**; 6w-candidate | E02 record.version, E03 cli_version and parser malformed counters; new bounded shape registry and synthetic version fixtures. | Enumerating arbitrary field names can leak content-derived keys; output only reviewed shape IDs and counts. Dependencies: PR01;PR05. |

### UX and information architecture

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **UX01 Evidence-led overview cards** | Replace the initial decision burden with at most three scoped changes and click-through denominators. | #14 · 22.14; V/E/A/R 5/3/3/2; D 0/0/0/0/0/1/1; **P1**; 6w | E01 aggregate sessions support first comparisons; tool/quota cards depend on TR01/CO05, not raw transcript UI. | An alert feed can overstate noise; empty state must say no supported change, not healthy. Dependencies: PR01;TR01;UX04. |
| **UX02 Session/day evidence navigation** | Support machine to repository to actor to session to day with allowlisted event details and persistent scope. | #27 · 18.14; V/E/A/R 5/4/2/2; D 0/0/0/0/0/1/1; **P1**; backlog | E01 sessions/daily costs support partial drill-down; E02/E03 ordered event projection needed for exact event-day totals. | Current createdAt cohort filtering includes whole-session totals; no arbitrary daily allocation of Cursor totals. Dependencies: IN01;WF01. |
| **UX03 Local saved views** | Save bounded filters, grouping, comparison and relative windows; restore without broadening silently. | #46 · 14.14; V/E/A/R 3/2/3/2; D 0/0/0/0/0/1/1; **P1**; backlog | E01 browser localStorage already stores view/theme; new versioned scope descriptor and migration required. | Custom labels and URL fragments may reveal metadata; export strips keys/names and defaults stay local. Dependencies: UX04. |
| **UX04 Matched-period comparison** | Compare same-repo/provider/execution cohorts with both denominators, model/schema/rate-card versions and coverage exclusions; CLI-version matching needs WF07. | #19 · 20.14; V/E/A/R 5/3/3/3; D 0/0/0/0/0/1/1; **P1**; 6w | E01 session/model/cost fields exist; exact spend-in-period requires event-day handling, unlike createdAt cohorts today. | No causality, task equivalence or comparison when denominators/bases mismatch; incomplete days explicit. Dependencies: PR01;UX05. |
| **UX05 Metric explainers and guard states** | Put formula, eligible population, source limits and unknown/too-small states next to each number. | #3 · 27.29; V/E/A/R 5/2/3/1; D 1/0/0/0/1/1/1; **P0**; 2w | E01 metrics/privacy docs and existing coverage; new UI components apply defined registry rules. | Never retrofit unmeasured precision; duration/tool counts are not success or value. Dependencies: PR01. |
| **UX06 First-run synthetic walkthrough** | Offer demo plus a three-question tour explaining cost basis, coverage and repository scope. | #15 · 21.14; V/E/A/R 4/2/3/1; D 0/0/0/0/0/1/1; **P0**; backlog | E01 scripts/demo.ts already isolates six fake repositories; richer scenarios need synthetic fixture additions. | Demo must never fall through to real source discovery; no automatic upload or tracking. Dependencies: DS01;UX05. |
| **UX07 Accessible dense investigation** | Add table/text alternatives, persistent keyboard focus and mobile dense rows for investigation paths. | #26 · 19.14; V/E/A/R 4/3/3/1; D 0/0/0/0/0/1/1; **P0**; 6w-candidate | E01 existing SVG/DOM/dashboard classes and focusable heatmap provide baseline; no new provider fields. | Do not let performance shortcuts remove access to exact values, focus or denominator text. Dependencies: UX01. |

### Integrations and exports

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **IN01 Versioned snapshot contract** | Add reviewed schemaVersion/metric-version semantics and documented forward/unknown-field behavior for consumers. | #4 · 26.14; V/E/A/R 5/2/3/1; D 0/0/0/0/0/1/1; **P0**; 2w | E01 MachineAnalytics/report --json and field manifest exist; root schema version currently absent. | Version alone does not ensure compatibility; additive changes still need shared-lane coordination. Dependencies: none. |
| **IN02 Minimized CSV/Markdown export** | Export selected aggregate rows and coverage/definitions to a user-chosen local file. | #25 · 19.14; V/E/A/R 4/2/3/2; D 0/0/0/0/0/1/1; **P1**; backlog | E01 repository/session summaries; new serializers only over allowed projection, preview first. | CSV formula injection, identifying repository names and dropped footnotes; no automatic messaging. Dependencies: IN01;PR02. |
| **IN03 Read-only local Git evidence** | Join explicit internal artifact IDs to bounded Git status/time metadata within a selected repository. | #66 · 9.14; V/E/A/R 4/4/1/3; D 0/0/0/0/0/1/1; **P1**; quarter-pilot | E08 Git roots used for grouping today; commit/merge metadata extraction and scope/identity checks are new. | Git author/message/path text must not escape; merge semantics differ from remote PR state. Dependencies: OU02;PR03. |
| **IN04 Opt-in GitHub/CI enrichment** | On explicit request import bounded merge and check-status fields; default analysis remains offline. | #79 · 0.14; V/E/A/R 3/5/1/4; D 0/0/0/0/0/1/1; **P1**; defer | E08 no gh/API enrichment exists; requires scoped auth/destination contract and exact internal artifact IDs. | Network/auth trust boundary; raw URL/title/author/log excluded; CI success is not correctness. Dependencies: OU03;PR02. |
| **IN05 Opt-in OTel aggregate export** | Map reviewed metrics to a pinned telemetry schema, excluding message/command/path attributes. | #81 · -4.86; V/E/A/R 2/5/1/4; D 0/0/0/0/0/1/1; **P1**; defer | E08 no exporter today; schema/spec mapping and explicit endpoint configuration needed; no runtime export by default. | Semantic-convention changes and collector defaults can leak identifiers/content or trigger outbound traffic. Dependencies: IN01;PR02. |
| **IN06 Local quota-history import** | Read an explicitly selected supported local quota-history store with provenance and no credential retrieval. | #73 · 6.14; V/E/A/R 3/3/1/3; D 0/0/0/0/0/1/1; **P1**; backlog | E06 CodexBar history presence/shape partly verified; adapters need exact version fixtures; no API or cookies. | Imported snapshots may duplicate provider logs or identify accounts; absent stores do not mean no quota use. Dependencies: CO05;PR01. |
| **IN07 Deterministic snapshot diff** | Compare two local snapshots after matching schema/rate card/scope; report coverage changes separately. | #32 · 17.14; V/E/A/R 4/3/3/2; D 0/0/0/0/0/1/1; **P1**; backlog | E01 JSON projection exists; stable field ordering and snapshot metadata contract require versioned serializer. | Hashes or schema changes can break joins; generatedAt alone cannot distinguish new evidence from repricing. Dependencies: IN01;PR02. |

### Distribution

| ID / proposed increment | Definition and decision served | Scores / tier / horizon | Exact data availability | Risk / dependencies |
| --- | --- | --- | --- | --- |
| **DS01 Compiled npm release** | Ship compiled ESM with assets and both workers; clean-prefix installed-artifact tests precede publication. | #16 · 21.00; V/E/A/R 5/3/3/2; D 0/0/0/0/0/0/0; **P0**; 2w | E01 package.json private:true/bin .ts, worker URL strings, bundled public/data resources; see distribution proposal primary sources. | Source tests miss node_modules TS rejection and broken worker/asset paths; no postinstall scans. Dependencies: PR05. |
| **DS02 Maintained Homebrew tap** | Install the same compiled release with pinned checksum and Node dependency; smoke-test synthetic report. | #47 · 14.00; V/E/A/R 4/2/1/2; D 0/0/0/0/0/0/0; **P0**; 6w-candidate | E08 (new input/integration): New external tap/release metadata; no formula or published artifact exists; packaging experiment required. | Core admission not guaranteed; upgrades must not delete local data or create background services. Dependencies: DS01. |
| **DS03 Single-executable feasibility spike** | Cap research at two days; prove SQLite/assets/worker isolation/signing before committing to a runtime bundle. | #80 · -1.00; V/E/A/R 3/5/1/4; D 0/0/0/0/0/0/0; **P0**; quarter-spike | E08 (new input/integration): New SEA build artifacts and internal worker dispatch; no binary exists; Node-version-specific gates in distribution plan. | Bundled runtime needs security updates; no Node24-floor assumption from newest SEA docs. Dependencies: DS01. |
| **DS04 Static evidence-first docs site** | Render canonical Markdown: install, numbers, privacy, providers, workflows and contribution guide. | #22 · 20.00; V/E/A/R 4/2/3/1; D 0/0/0/0/0/0/0; **P0**; 6w-candidate | E01 docs/README/branding already exist; hosting/build is new and separate from offline application. | Host logs differ from app telemetry; bundle assets and advertise only tested install paths. Dependencies: DS01. |
| **DS05 Synthetic provider fixture kit** | Give contributors minimal versioned source shapes, identity/dedupe expectations and sentinels without real logs. | #6 · 25.00; V/E/A/R 5/2/3/1; D 0/0/0/0/0/0/0; **P0**; 6w-candidate | E01 test/fixtures.ts and provider contribution checklist; new contributor recipes and fixture naming. | Redacted production logs can still leak; require synthetic structure-only reproductions. Dependencies: PR05. |
| **DS06 Decision-focused launch demo** | Publish synthetic discrepancy-to-decision walkthrough instead of a token leaderboard. | #23 · 20.00; V/E/A/R 4/2/3/1; D 0/0/0/0/0/0/0; **P0**; 6w-candidate | E01 scripts/demo.ts/assets exist; new TR01 signal fixtures and explicit synthetic labeling needed. | Do not imply demo improvement was observed in a customer or that high usage means value. Dependencies: UX06;TR01. |
| **DS07 Verifiable offline release bundle** | Publish hashes, locked build recipe, provenance where eligible and installed offline/privacy parity evidence. | #12 · 23.00; V/E/A/R 5/3/3/1; D 0/0/0/0/0/0/0; **P0**; quarter-candidate | E01 package-lock, CI and sentinels; packaging checks/provenance and independent rebuild remain future gates. | Provenance is not correctness; only claim reproducibility after an independent matching rebuild. Dependencies: DS01;PR05. |

## Sensitivity and selection discipline

Re-run the ranking with D set to zero before defending a novel feature. Trust
foundations (PR05, IN01, UX05, CO02), fixture quality (DS05) and release integrity
(DS07) still score strongly because they protect a real decision and have usable
inputs. Varying subjective novelty should not overturn the correctness-first
sequence. A full release cannot be planned by adding ordinal E values; estimate
actual slices after dependencies and source-version checks.

The selected two-week slice includes DS01 despite its lower numerical rank
because every public install depends on it. The six-week slice includes TR01 and
CO05 to test a decision workflow, while high-scoring TE07 and DS07 can follow:
their broader organizational/release claims are not the initial habit being
validated. Team collection, content review and automatic hooks remain deferred
regardless of possible demand. Do not use these scores as public competitor
ratings or as evidence of user willingness to pay.
