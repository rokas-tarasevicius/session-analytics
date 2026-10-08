# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Versions before 0.5.0 shipped as the `machine-session-analytics` skillpack.

## [Unreleased]

### Removed

- The Costs repository and visible token-type breakdowns and the Models view (`G M`). Model details now appear in Costs; token-type dollars remain in row tooltips.
- Dashboard Distributions, Reliability, Limits & cache, Workflow, Skills, Outcomes and Insights views, their assets and shortcuts, and the dashboard-only `/api/insights` endpoint.
- **Breaking:** the analysis behind those views, from every remaining surface. Tokens, cost, pricing, velocity, tool counts, compactions, context peaks and history coverage are unchanged (verified identical on the synthetic demo).
  - Commands `insights` and `review`, and the options `--insights-config`, `--reliability-content-rules`, `--outcomes-git`, `--outcomes-github`, `--workflow-content-rules` with their `--no-*` forms and `SESSION_ANALYTICS_INSIGHTS_CONFIG`, `SESSION_ANALYTICS_RELIABILITY_CONTENT_RULES`, `SESSION_ANALYTICS_OUTCOMES_GIT`, `SESSION_ANALYTICS_OUTCOMES_GITHUB` and `SESSION_ANALYTICS_WORKFLOW_CONTENT_RULES`. The flags are now rejected as unknown; the variables are ignored. The opt-in GitHub (`gh`) outcome queries and local Git correlation are gone.
  - Snapshot JSON fields `limitsCache`, `outcomes` and `workflow` (machine and repository), repository rollup `outcomes`, and per-session `reliability`, `limitsCache`, `outcomes`, `workflow`, `insightSignals`, `skills`, `skillEvidence`, `mcpEvidence.toolOutcomes`, `mcpEvidence.rateLimits` and `mcpEvidence.truncated`. `schemaVersion` stays 1: every remaining field keeps its meaning, and snapshots written by earlier versions still load with `--snapshot`, `export` and `merge`; their removed fields are ignored, and any other unknown field is still rejected.
  - Terminal report sections for limits & cache, outcomes, workflow and reliability.
  - MCP tool `unused_extensions`, tool error rates and result coverage in `tool_stats` (it now returns calls per tool), quota headroom in `budget_status`, skills in `repo_profile`/`compare_agents`, and the reliability, limits & cache, outcomes, workflow and insight families in each payload's `metrics`. The MCP worker no longer reads skill or MCP-server configuration.
  - Demo `insights` mode and the synthetic limits, outcomes, reliability and workflow evidence.

### Added

- Per-session `historyProfile` (native Claude sessions): the hashed Claude profile key and deduplicated request tokens per UTC day and model. It carries the machine-wide history coverage inputs that used to live in `limitsCache`. Indexed sessions written by earlier versions are migrated on load, so history coverage for source-deleted sessions is unchanged. The index reparses present sessions once after upgrading.

### Changed

- The Pricing view shows a grid of model cards instead of the rates table. Each card carries its provider's brand accent and mark, input and output price per 1M tokens, the selected window's usage value with a usage bar, tokens and calls, and a badge when rates are incomplete. Cards are ordered by API-equivalent usage value in the selection, then tokens; rate-card models unused in the selection sit behind a "Show N unused models" toggle. Selecting a card (click, Enter or Space) opens a details dialog with the full rate breakdown (input, cached input or cache read, 5-minute and 1-hour cache writes, output, long-context tiers), the current source, effective date, reviewed override and assumptions, selection coverage and token mix, and the historical rate evidence the usage applied. Source freshness, coverage, policy and refresh guidance stay above the grid. Snapshots gain `rateCard.models[].rate`, a numeric-only projection of each current rate.
- Velocity opens with Average price per active day and Usage value for the selected window and providers, followed by filters and the usage chart.
- Costs shows cost by provider and by model on shared zero-based scales, including value with no model evidence.
- Old `?view=models` links and saved Models preferences open Costs.
- Dashboard charts use provider brand colours (Claude terracotta, OpenAI/Codex grey, Cursor teal, Copilot purple, OpenCode gold, Gemini blue) defined once in `src/public/chart-colors.js`, with stable model shades per family (Opus, Sonnet, Haiku as shades of Claude; GPT models as greys). Legends are larger, show values and shares, follow the chart order, drop zero entries and highlight the matching series on hover or keyboard focus. Bars in a panel share one zero-based scale with no minimum width; bars that are not provider data use one neutral colour.
- Dashboard navigation now groups Summary and Velocity under Overview; Costs and Pricing under Economics; Tools and Activity under Usage, with Activity last in navigation, view stepping, the palette and shortcut help.
- Tools view is tool-first: the per-repository stacked distribution and "Selected repository" drill-down are replaced by KPI cards, a ranked tool table (calls, share, sessions, repositories, change against the previous window) and a profile for the selected tool (calls by session-start day, provider and repository split). Bars are single-colour, zero-based and proportional. Per-tool cost and duration are stated as not recorded rather than estimated.
- Dashboard windows default to the last 30 days of observed history. Explicit `?window=` presets still override the default; the window is not persisted. Under the default, sessions with an unknown start time are excluded (they reappear under **All**), and **Export view** downloads cover only the selected window.
- Dashboard design refinement: honesty guardrails moved into progressive disclosure. The coverage banner became a top-bar "Coverage" indicator that opens an Evidence & coverage dialog (coverage notes, per-provider evidence table, interpretation footnotes); inline "n/m sessions" denominators became hover badges beside the number; unavailable values render as an em dash with the reason on hover instead of "N/A"; long evidence paragraphs sit behind per-panel "Evidence & limits" disclosures.
- One shared component set (`src/public/ui.js`: filter bar with labelled fields, KPI card, data table, evidence disclosure, coverage badge) now renders Velocity and Pricing with the same spacing, type scale and controls as the Summary.
- Fleet table repository IDs show the key's hash tail; the footer collapses rate sources into one disclosure; the donut legend hides empty providers; distinct sidebar icons for each view; `e` opens the coverage dialog.
- Demo: Gemini CLI sessions use a rate-card model so the demo is priced across providers.

### Fixed

- The Summary provider donut now draws Copilot, OpenCode, Gemini and unsupported segments (they were listed in its legend but missing from the ring), and its legend no longer truncates names.
- Costs provider rows were each stretched to full width, so a $191 provider looked as long as a $576 one; rows now share the panel's maximum. Cost by model also shares one scale across providers.
- The Summary daily usage chart drew lines only for Claude, Codex and Cursor; every provider now gets its line.
- Folders that are not repositories no longer show up as repositories. Sessions started in the home directory, scratch, download or chat folders, or in a deleted checkout that recorded no Git remote, used to become one `<folder> · <hash> (local directory)` entry each; they now share one `No repository detected` group. Indexed sessions from those entries whose transcripts are gone move into it too, including former temporary-directory entries, because the index never kept their folder. Git repositories, recorded remotes and Conductor workspaces are attributed as before. The old per-folder repository IDs no longer exist: a saved `--repo-id` or a `--share-aliases` entry for one no longer matches, and `--repo-root` on a folder that is not a repository now reports that no evidenced repository has that root.
- Deleted temporary directories recorded under the other macOS spelling (`/private/tmp` for `/tmp`, `/var/folders` for `/private/var/folders`), and existing folders under `/tmp`, are grouped as `Ephemeral automation sessions` instead of one entry per run.
- Warm dashboard snapshots no longer reparse every Claude session when resumed copies share message IDs: only the sessions that share a message (8 of 485 on the measured history) skip the index, as all Claude sessions did before. On a ~5,800-session history a warm snapshot went from 115–269 s to about 51 s (CPU 138 s to 52 s).
- Raise the analysis worker heap cap from 256 MB to 1 GB; large histories exhausted it and the dashboard reported a generic parse failure. Hitting the cap now names the limit in the dashboard and CLI.
- Faster scans with unchanged output: concurrent fingerprinting, memoized source keys and repository lookups, reused HMAC keys, linear JSONL line splitting and cached calendar-day validation.
- Summary and Velocity now show the same usage value for the same window. The Summary "Priced usage value" KPI, its sparkline and delta, sidebar repository values and repository value bars use Velocity's activity-date ledger in the snapshot timezone instead of whole-session value of sessions started in the window (UTC). Undated value and sessions from sources without activity dates are disclosed beside the KPI as all-time amounts, and its delta uses the same guarded comparison as Velocity. Date windows no longer end on a future day when UTC session starts run ahead of the local date.
- Velocity's "This week vs last" and "Month to date vs prior" work again: they no longer depend on the selected window's start, OpenCode/Gemini/Copilot/Cursor SDK/Conductor-result sessions no longer block every comparison, a Monday or the 1st compares the period that just finished, small pricing gaps (at least 90% priced) show a partially-priced change instead of N/A, and a zero prior period shows "New" or "No activity". Unavailable comparisons state why.
- Verify recovered daily value against its UTC history remainder while independently conserving hourly velocity, including finalized output whose day is known but hour is not.
- Recognize canonical OS temporary directories in the independent repository oracle and carry recorded source changes through all native verification comparisons.
- Prove live changes to shared context-curve sampling and recovery calibration from saved public context facts and independently reconstructed SDK pairs, while retaining strict counters and accounting checks.

## [0.6.2] - 2026-10-04

### Fixed

- Recover finalized Claude output from query receipts only when their main-loop input counters and model agree with retained assistant evidence. Preserve cumulative receipt scope and unknown timing/reasoning details.
- Retain a higher Conductor receipt value as a provider-reported floor without discarding recovered message tokens or adding the two monetary sources together.

### Added

- Measure recovery against every surviving native/SDK pair during analysis. History coverage exposes guarded value ratios, denominators, quantiles, receipt floors and above-native exceptions; no multiplier inflates deleted history.

## [0.6.1] - 2026-10-04

### Fixed

- Read checkpointed external SQLite sources in read-only directories without losing sessions when WAL sidecars are absent; reject concurrent source changes (`INTEGRATION-SQLITE-01`).

- Reconcile native request identities, continuation files, billing iterations, replay, output classification and strict request dates across full and indexed scans.
- Correct historical tariffs, conservative receipt scope, partial pricing, repository ownership, provider snapshots and aggregate displays. Preserve unknown evidence and unattributed estimates explicitly.
- Run every imported validation regression in `npm test`; add `npm run verify:real` for independent raw-data comparisons and disposable full/cold/warm index checks.

Fixed or superseded bug IDs by validation area (superseded findings are resolved by a stronger combined fix):

- **aggregation:** `AGG-001`, `AGG-002`, `AGG-003`, `AGG-004`, `AGG-005`, `AGG-006`, `AGG-007`, `AGG-008`, `AGG-009`.
- **claude:** `CLAUDE-D01`, `CLAUDE-TIED-BREAKDOWNS`, `CLAUDE-UNKNOWN-REASONING`, `VC-CROSS-SESSION`, `VC-ITERATIONS`, `VC-STUB`, `VC-UNDATED`.
- **codex:** `CODEX-01`, `CODEX-02`, `CODEX-03`, `CODEX-04`, `CODEX-05`, `CODEX-06`, `CODEX-07`.
- **conductor:** `VC-001`, `VC-O1`, `VC-O2`, `VC-O3`, `VC-P1`, `VC-P2`, `VC-P3`, `VC-P4`.
- **dedup:** `DEDUP-AD-01`, `DEDUP-AD-02`, `DEDUP-AD-03`, `DEDUP-AD-04`, `DEDUP-AD-05`, `DEDUP-CD-01`, `DEDUP-CD-02`, `DEDUP-CD-03`, `DEDUP-CD-04`, `DEDUP-CL-01`, `DEDUP-CL-02`, `DEDUP-CL-03`, `DEDUP-CL-04`, `DEDUP-CX-02`, `DEDUP-CX-03`, `DEDUP-CX-04`, `DEDUP-CX-05`, `DEDUP-CX-07`, `DEDUP-CX-08`, `DEDUP-CX-09`, `DEDUP-CX-10`.
- **history recovery:** `HISTORY-MESSAGE-RECOVERY`, `HISTORY-STREAM-COUNTERS`, `HISTORY-STRIPPED-IDENTITY`.
- **index:** `INDEX-CLAIM-ROLLBACK`, `INDEX-MEMORY-LEDGER`, `INDEX-MEMORY-PROJECTION`, `INDEX-MEMORY-ROLLBACK`, `INDEX-MEMORY-SERIALIZATION`, `INDEX-OUTCOME-SCHEMA`, `INDEX-STALE-AUDIT`.
- **integration:** `INTEGRATION-CLAUDE-MEMORY`, `INTEGRATION-CLAUDE-PRIMARY`, `INTEGRATION-CODEX-FORK-MEMORY`, `INTEGRATION-CODEX-INDEX-CALLS`, `INTEGRATION-CODEX-INDEX-PAGES`, `INTEGRATION-CONDUCTOR-01`, `INTEGRATION-CONDUCTOR-MEMORY`, `INTEGRATION-INDEX-PROJECTION-MEMORY`, `INTEGRATION-PRICE-01`, `INTEGRATION-PRICE-02`, `INTEGRATION-PRICE-03`, `INTEGRATION-PRICE-04`.
- **other-providers:** `ADAPTER-001`, `ADAPTER-002`, `ADAPTER-003`, `ADAPTER-004`, `ADAPTER-005`, `CURSOR-01`, `CURSOR-02`, `CURSOR-03`, `CURSOR-04`, `CURSOR-05`, `CURSOR-06`, `CURSOR-NATIVE-01`, `CURSOR-NATIVE-02`, `CURSOR-NATIVE-03`, `CURSOR-NATIVE-04`, `CURSOR-NATIVE-05`, `CURSOR-NATIVE-06`, `CURSOR-NATIVE-07`, `DESKTOP-01`, `DESKTOP-02`.
- **pricing:** `PRICING-1M-ALIAS`, `PRICING-ITERATIONS`, `PRICING-LAB-PREFIX`, `PRICING-MESSAGE-ITERATIONS`, `PRICING-SPARK`, `PRICING-SUMMARY-TIERS`, `PRICING-TIER-WRITE-UPPER`, `VP-CODEX-HISTORY`, `VP-CODEX-UPPER`.
- **reconcile:** `RC-CODEX-01`, `RC-CODEX-02`, `RC-CONDUCTOR-CARRYOVER`, `RC-CONDUCTOR-LOCAL`, `RC-CONDUCTOR-REPLAY`, `RC-MODEL-01`.
- **repos:** `R-CONDUCTOR-01`, `R-CONDUCTOR-02`, `R-CURSOR-01`, `R-CURSOR-02`, `R-CURSOR-03`, `R-GIT-01`, `R-GIT-02`, `R-GIT-03`, `R-GIT-04`, `R-GIT-05`, `R-GIT-06`.
- **time:** `TIME-01`, `TIME-02`, `TIME-03`, `TIME-04`, `TIME-05`, `TIME-06`, `TIME-07`, `TIME-08`, `TIME-09`, `TIME-10`, `TIME-11`, `TIME-12`.
- **verification:** `INTEGRATION-VERIFY-01`, `INTEGRATION-VERIFY-02`, `INTEGRATION-VERIFY-03`, `INTEGRATION-VERIFY-04`, `INTEGRATION-VERIFY-05`, `INTEGRATION-VERIFY-06`, `INTEGRATION-VERIFY-07`, `INTEGRATION-VERIFY-08`, `INTEGRATION-VERIFY-09`, `INTEGRATION-VERIFY-10`, `INTEGRATION-VERIFY-11`, `INTEGRATION-VERIFY-12`.

### Evidence limits

- `VC-002`, `PRICING-OWNERSHIP-CONTRACT`, `DEDUP-CX-01`, and `DEDUP-CX-06`: retained legacy receipts/counters do not establish exact additional billing or ownership. Diagnostic fixes expose partial evidence; no speculative correction is added.
- `R-SHARED-01`: later reuse of the same missing cwd does not prove repository ownership, so the suspected reattribution is rejected.
- Grok models remain unpriced when the existing offline normalized cache lacks their rates; the fixed xAI importer takes effect on an explicit or subsequently due public-rate refresh.

### Index integrity and recovered history

- Accept the outcome hash formats already emitted by the parsers in the persistent projection schema. Indexed Codex and Claude composite sessions no longer become invalid or lose tokens/value when they carry PR or observation-only outcome references.
- Roll back index-only failures and retry full-scan accounting with a fixed warning, preventing duplicate retries and lost Codex counter ownership. Add rotating warm-cache session/ledger verification and a content-free full/cold/warm parity runner.
- Bound Codex dependency reconstruction to one cached ledger at a time instead of retaining every broadcast receiver's observations in the 256 MB analysis worker.
- Stream and compress prior cached payloads in memory so warm scans can retain rollback evidence without holding a second full JSON string graph; the on-disk format is unchanged.
- Stream worker snapshot output with backpressure instead of allocating the entire serialized history as one string; the JSON format and 256 MB heap cap are unchanged.
- Construct compact allowlisted session objects so cold indexed populations fit the same heap budget as full-scan results, without weakening schema validation.
- Recover missing Claude transcripts from Conductor assistant usage with deduplicated request pricing, dates, tool names, subagent attribution, and explicit receipt reconciliation. Add machine-wide History coverage from Claude statistics with separate, conservatively overlap-adjusted unattributed estimates. Statistics compare matching streamed-block counters, avoiding false gaps from response deduplication; stripped SDK response IDs remain conservative and partial. Previously result-only usage lacked daily attribution; recovered values can increase or decrease when message evidence replaces cumulative receipts.

## [0.6.0] - 2026-10-03

### Added

- Fourteen views in the Control Room dashboard, grouped navigation, command palette, collision-free shortcuts, URL entry points, density controls, and light/dark themes (#17).
- Velocity and guarded period comparisons (#4); cached, dated public price feeds, request-time provenance, Pricing view and `rates` commands (#5).
- Tool reliability, latency, verification and optional local content rules (#6); quota, cache, context and plan-value evidence (#7); outcome linkage and opt-in Git/GitHub enrichment (#8).
- Workflow timing, concurrency, steering, command history and skill inventory (#9); grouped insights and an explicit per-run content review workflow (#10).
- A private SQLite index with complete session replay, source-deleted retention, ownership checkpoints and `index status|path|rebuild|prune` (#11).
- Seven metrics-only MCP tools with repository scope, coverage and summaries from every integrated metric family (#12).
- Provider adapters, Cursor SDK/transcripts, Copilot CLI, OpenCode, Gemini and conservative Conductor result recovery (#13).
- Versioned snapshot schemas, CSV/NDJSON/OTLP exports, aggregate-only sharing and snapshot dashboards (#14).
- Product strategy, information architecture, evidence research and launch proposals (#15, #16).

### Changed

- One dispatcher and shared analysis options across dashboard, reports, pricing, insights, review, exports, index and MCP.
- One synthetic demo covers every view and provider. New views use the Control Room cards, typography, colors, controls and tables.
- The persistent projection and interchange schemas cover all final metric namespaces, pricing provenance and normalized quota evidence; cold/warm/full scans are checked for parity.
- P2 rule settings partition cached history. Public price refreshes and each explicit network feature are documented separately; provider stores remain read-only and runtime dependencies remain zero.

### Fixed

- Preserved streamed-response maxima, Codex ownership/deduplication, partial-accounting coverage and provider-specific N/A semantics across merged parsers and consumers.
- Preserved quota facts on warm scans and invalidated caches for parser, pricing, command-history and option changes; open workflows are reevaluated as they age.
- Unified bounded model identities, numeric UTC comparisons, unknown-start exclusions and full-metric filtered exports.
- Kept source-deleted history warnings visible and excluded historical working observations from live counts.
- Reconciled all reviewed conflict fixes and privacy tests; no lane tests removed.

## [0.5.0] - 2026-10-02

First standalone release.

### Added

- `session-analytics` command with `dashboard` (default) and `report` subcommands; `--no-open` starts the dashboard without launching a browser.
- Discovery of every local Claude Code and Codex profile: `~/.claude-*` and `~/.codex-*` siblings, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `~/.config/claude`, deduplicated through symbolic links. Explicit root options still replace discovery.
- Claude thinking tokens, reported separately as reasoning output, and the recorded reasoning effort per session.
- Cursor workspace and subagent mapping through the `composerHeaders` table used by current Cursor builds.
- Reviewed rate-card entries for `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6-sol`, and `gpt-6.1-sol`; the rate card is effective 2026-10-02.
- Regression tests for streamed Claude usage, current Codex rollouts, profile discovery, and Cursor headers.
- Strict TypeScript checking, `package.json` scripts, a single brand module, and a cross-platform browser opener.

### Fixed

- Claude output tokens were undercounted because the first streamed snapshot of each message was priced instead of the final one. On one real machine this removed 19-47% of output tokens per profile.
- Claude sessions in any profile other than `~/.claude` were never read.
- Codex user turns, assistant messages, and compactions read near zero for current rollouts, which record them as `item_completed` items and top-level `compacted` records.
- Claude Desktop local-agent sessions no longer add a missing-root warning on machines without Claude Desktop.

### Changed

- Moved from the GBrain skillpack layout to `src/`, `test/`, `data/`, `docs/`, and `skills/`. The agent skill now runs the `session-analytics` command.
- Repositories registered in Conductor are identified by a pseudonymous `conductor-<hash>` key instead of Conductor's raw record ID.
- Both `dashboard` and `report` read the same options; environment overrides use the `SESSION_ANALYTICS_*` prefix (for example `SESSION_ANALYTICS_CLAUDE_ROOT`); the `MACHINE_*` and `CONDUCTOR_*` aliases were removed. `CONDUCTOR_PORT` is still honored.
- The dashboard is titled Session Analytics; saved view and theme preferences use new storage keys.

### Removed

- GBrain skillpack manifest, bootstrap runbook, judge evaluations, and routing fixtures.

## [0.4.4] - 2026-08-05

### Changed

- Replace the mixed Activity palette with seven green-only intensity levels while preserving logarithmic bucketing.
- Bump the package to `0.4.4` for the corrected Activity palette.

## [0.4.3] - 2026-08-05

### Changed

- Expand Activity to a seven-level, logarithmically distributed cool-to-warm color scale so low, medium, and peak session counts remain distinguishable.
- Use light mode as the first-run default while preserving an explicit saved theme preference.
- Bump the package to `0.4.3` for the revised Activity scale and theme default.

## [0.4.2] - 2026-08-05

### Changed

- Remove the oversized dashboard hero and explanatory copy, retaining only compact snapshot metadata alongside the scope controls.
- Bump the package to `0.4.2` for the streamlined dashboard layout.

## [0.4.1] - 2026-08-05

### Added

- Show the exact session count and local weekday/hour in a GitHub-style tooltip when an Activity heatmap cell is hovered or keyboard-focused.

### Changed

- Bump the package to `0.4.1` for the new dashboard interaction.

## [0.4.0] - 2026-08-04

### Added

- Add focused dashboard views for multi-repository distributions, local-time session activity, cost components, provider-separated model usage, per-repository tool distribution, and provider-aware skill distribution.
- Parse explicit Claude `Skill` tool events and infer a lower bound for Codex skill use from read-capable calls that reference canonical `SKILL.md` files.
- Publish normalized skill identifiers, counts, and evidence method without returning skill arguments or file paths.

### Changed

- Group model bars by provider and keep Cursor provider-reported value visually separate from Codex and Claude API-equivalent estimates.
- Limit distribution comparisons to six uniquely colored repositories, place selected and high-activity repositories first, and use logarithmic bins for heavy-tailed duration, cost, and tool-call data.
- Bump the package to `0.4.0` for the new public session fields and dashboard views.

### Fixed

- Render only the active analytics view so provider and time-window controls do not rebuild thousands of hidden elements or stall on machine-scale snapshots.
- Keep distribution selectors and repository distribution tables inside the mobile viewport while retaining internal scrolling for the full repository set.
- Represent tool and skill categories outside the six-item legend as an explicit `Other` segment instead of leaving an unexplained blank share.

## [0.3.4] - 2026-09-13

### Fixed

- Stop charging an unobserved process-wide Codex counter baseline to one session and one calendar day. A Codex cumulative counter is shared by every session file its process owns, so a session that starts mid-run opens on a snapshot describing requests it never issued. When that opening snapshot carried no per-request `last_token_usage`, the whole counter was billed as a single request, inflating the spend of heavily parallel sub-agent workspaces by an order of magnitude and concentrating it on the day each sub-agent happened to start. Only deltas between two snapshots the same evidence file observed are now attributable, and a non-monotonic counter re-baselines instead of billing its full total.

### Added

- Warn per session when a process-wide counter baseline is excluded, and distinguish that case from token events that lacked per-request usage but still yielded an observed delta.
- Regression coverage asserting that an unobserved 900M-token opening snapshot contributes neither session value nor daily spend.

## [0.3.3] - 2026-09-12

### Added

- Add reviewed rate-card entries for `gpt-6-astra` (including its 272K long-context modifiers) and `claude-fable-5-1`, so sessions on those models are priced instead of counted as unpriced.

### Fixed

- Correct the `gpt-5.6-sol` and `gpt-5.6-terra` rates to the published $4/$0.40/$20 and $2/$0.20/$12 per million tokens; both entries previously carried the `gpt-5.5` and `gpt-5.4` rates and overstated API-equivalent value.

### Changed

- Move the rate-card effective date to 2026-09-12 after reverifying every entry against its primary source, and document Claude Fable 5.1's 0.025x cache-read multiplier.

## [0.3.2] - 2026-08-02

### Added

- Price Claude Opus 5 usage at Anthropic's standard global API rates, including separate cache-read, five-minute cache-write, one-hour cache-write, input, and output categories.

### Changed

- Document that fast-mode, US-only inference, batch, and partner-platform pricing modifiers remain excluded when local session evidence does not identify them.

## [0.3.1] - 2026-07-22

### Changed

- Reduce the agent-facing skill to a one-command launch workflow plus a concise guide to evidence locations, processing patterns, and available metrics.
- Replace the multi-step bootstrap checklist with the single dashboard command; CLI and path overrides are now explicitly optional rather than preflight steps.

### Fixed

- Make the dashboard command idempotent: rerunning it recognizes a compatible server already using the selected port, reuses it, and opens the existing dashboard instead of failing.

## [0.3.0] - 2026-07-22

### Changed

- Rename the package and canonical skill from `conductor-session-analytics` to `machine-session-analytics`; provider-owned Codex, Claude, and Cursor history now defines the machine-wide scope, while Conductor is documented and routed as optional repository/workspace enrichment.
- Update CLI, server, dashboard, bootstrap, installer, routing, host exposure, judge criteria, and repository guidance to the provider-neutral identity. The installer accepts the former pack name as a compatibility alias but installs only the new canonical skill.

### Fixed

- Assign duplicated Codex process-wide snapshots to the observer with the closest preceding local response activity, with deterministic timestamp/path tie-breaking, so an earlier stale receiver cannot take another repository's, model's, or execution mode's request.
- Recover a Codex owner event that precedes its model marker only when the same evidence file contains exactly one model ID; ambiguous owners remain visibly unknown and unpriced.
- Attribute Claude usage from nested `subagents` evidence files to sub-agent execution while preserving the composite session and globally deduplicating assistant message IDs.
- Ignore relative Cursor bubble timings that are not plausible Unix-millisecond timestamps, preventing 1970 event dates and multi-decade activity spans.
- Clamp malformed negative provider token counters to zero without changing valid observed usage.
- Add the official standard global Claude Opus 4.6 input, cache, and output rates from Anthropic's pricing documentation instead of leaving those evidenced sessions unpriced.

### Added

- Regression coverage for stale-before-owner Codex broadcasts, Claude sub-agent value, unknown models remaining unpriced, negative Cursor counters, plausible timestamps, and session/model/repository/machine accounting invariants.

## [0.2.1] - 2026-07-22

### Fixed

- Treat Codex cumulative token counters as process-wide snapshots, deduplicate identical total/last-request states across session files, and sum only the owning request's `last_token_usage` instead of multiplying global deltas by every observing file.
- Exclude inherited child-session baselines and repeated broadcasts while preserving model and top-level/sub-agent attribution at the earliest recorded observation.

### Changed

- Label input totals as request input processed and state that repeatedly processed cached context is included; these totals are not unique transcript text.

## [0.2.0] - 2026-07-22

### Changed

- Renamed dashboard dollar totals to priced usage value and separated API list-price equivalents from provider-reported Cursor value; neither is presented as an invoice or actual charge.
- Segmented Codex cumulative deltas at every execution-mode transition so transcripts resumed from sub-agent work are no longer attributed wholesale to sub-agents.
- Kept unknown-model tokens in the pricing-coverage denominator instead of silently reporting complete coverage.
- Added provider toggles to the daily chart, honest Cursor daily-timing unavailability, explicit top-level/sub-agent value, and provider-specific model colors.

### Fixed

- Included ten unique archived Codex transcripts and Claude Desktop local-agent transcripts in the default machine union.
- Accumulated Claude transcript identity until both provider ID and working directory are observed, rejected ID-only directory mismatches, and deferred evidence ownership until validation succeeds.
- Hydrated modern Cursor `bubbleId` records, deduplicated real tool calls through `toolFormerData.toolCallId`, read provider-reported `costInCents`, and assigned composers through 84 workspace databases.
- Selected the longest matching registered repository root and treated cumulative-counter decreases as new observed segments.
- Isolated the memory-heavy Cursor scan in a short-lived child process so its parsed local evidence is released before Codex and Claude analysis.

## [0.1.0] - 2026-07-22

### Added

- Product-neutral machine-wide local agent session analytics workflow.
- One-pass Codex and Claude transcript indexing plus read-only Cursor composer history, assigned through Conductor workspaces, recorded working directories, and Git roots.
- Complete calendar-day spend velocity with labeled USD/date axes, keyboard/mouse point inspection, provider branding, and selectable all/7/30/90/custom analysis windows.
- Immediate repository drill-down from charts and the comparison table, with stale database-only session stubs omitted and uniquely matchable legacy sessions recovered.
- Repository, session, model, token, cost, tool-name, duration, compaction, provider, and evidence metrics without transcript browsing or ambiguous context-pressure scoring.
- Content-free human and JSON CLI with explicit repository narrowing.
- Read-only loopback dashboard with repository comparison, drill-down filters, responsive tables, and focused aggregate visualizations.
- Versioned provider rate card, interpretation catalog, routing fixtures, deterministic parser/server/package tests, E2E CLI checks, and judge evaluations.

### Security

- Public results exclude titles, branches, workspace metadata, repository roots/remotes, raw Conductor/provider IDs, transcript paths/content, commands, credentials, and raw local exceptions.
- The server binds to `127.0.0.1`, rejects non-loopback Host/Origin values, has no CORS or telemetry, and coalesces concurrent refresh scans.
