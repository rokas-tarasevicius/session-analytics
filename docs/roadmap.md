# Roadmap

This roadmap is ordered: correctness first, then reliability and economics, then outcomes, then agent-facing surfaces, then breadth. Items are content-free (privacy tiers P0 and P1 in [privacy.md](privacy.md#privacy-tiers)) unless marked **opt-in**. Opt-in features that need content are always off by default, labeled in the interface, and kept out of the default index.

Status: `[x]` shipped, `[ ]` not yet shipped. Milestones are not dated.

## Product strategy research

The [product strategy proposal](proposals/product-strategy.md) provides evidence-backed prioritization and conditional two-week, six-week and quarter planning horizons. These do not replace the milestone status below or promise release dates. In this subsection, completion means the research artifact is delivered, not that its proposed features are shipped.

- [x] Document five personas/jobs, 84 individually scored feature ideas, primary-source competitive research, bounded local evidence, dashboard navigation/wireframes, metric contracts, and packaging/open-source launch gates.
- [ ] Validate the proposed repository investigation workflow with consenting pilot users and synthetic tasks; collect no automatic telemetry or real histories.
- [ ] Resolve the documented comparison/denominator/context prerequisites and agree shared schema semantics before promoting new ratios or period comparisons.
- [ ] Pass compiled npm installed-artifact gates before advertising registry installation; evaluate Homebrew and executable packaging separately.

## M0: Correctness

**In progress.** 0.5.0 is the first standalone release and ships the first part of this milestone. No new feature work starts before the numbers are right.

- [x] Extract into a standalone repository with a single brand module (`src/brand.ts`).
- [x] Discover every local profile: `~/.claude-*`, `CLAUDE_CONFIG_DIR`, `~/.config/claude`, `~/.codex-*`, and `CODEX_HOME`, deduplicated by real path.
- [ ] Show the profile as a dimension in every view.
- [x] Claude Code: price the final streamed usage snapshot of each message instead of the first.
- [x] Claude Code: report thinking tokens separately and record reasoning effort.
- [x] Codex: count turns, messages, and compactions from `item_completed` items and top-level `compacted` records.
- [ ] Codex: parse `token_usage_record` events and the paginated rollout format.
- [x] Cursor: read workspace and sub-agent mappings from the `composerHeaders` table.
- [x] Cursor: read agent CLI transcripts and sessions run through Conductor's Cursor integration, with source-specific fidelity.
- [x] Conductor: recover verified Claude result evidence with grouped identities, cumulative accounting, and explicit partial-history labels.
- [x] Prevent OpenCode fork recounting, replay Gemini partial order correctly, and validate structured provider metadata.
- [x] Apply metric-specific availability and eligible/selected denominators across terminal and dashboard consumers.
- [ ] Stream or spill oversized Gemini legacy/replay stores beyond the documented memory limits.
- [x] Regression tests for streamed Claude usage, current Codex rollouts, profile discovery, and Cursor headers.
- [x] Shared bounded public model IDs, zero-last-usage regression coverage, UTC request chronology, and per-boundary compaction reconciliation.
- [ ] Golden-fixture parity tests for each supported provider format version.
- [x] Provider adapter interface and exact synthetic legacy-session parity for the Claude migration.
- [x] Claude history reconciliation: recover Conductor assistant usage, compare SDK receipts, and show per-profile/month statistics gaps with separate unattributed estimates.
- [ ] Extend reconciliation to provider aggregate stores with verified compatible accounting intervals.
- [x] Persistent content-free SQLite index with incremental ingest (keyed source identity, device/inode, size, nanosecond modification/change times, keyed head/tail fingerprints), session reuse, verified Codex ledger append checkpoints, migrations, WAL, and private permissions.
- [x] Retain previously indexed source-deleted sessions, reserve shared counter ownership, and provide `index status|path|rebuild|prune` and `--no-index`; fixture/demo parity tests.
- [x] Atomic ownership-component deferral, UTC-safe pruning with exclusion checkpoints, undated request reservations, key-bound stores, writer corruption recovery, and filtered dashboard retention caveats.
- [x] Index parity regressions for real-history outcome-reference shapes, atomic full-scan fallback, rotating session/ledger checks, and bounded broadcast-ledger memory; content-free full/cold/warm parity runner.
- [ ] Incremental Cursor database adapters and resumable session parser checkpoints (the current index refreshes Cursor and reparses changed composite sessions conservatively).

## M1: Reliability and economics

### Tool reliability and behavior

Local histories already record tool errors, exit codes, timeouts, durations, MCP call status, hook timing, permission modes, and denials. M1 turns them into content-free measures.

- [x] Tool outcomes/error rates by tool, normalized class and MCP server, with low-cardinality error classes and denominator guards. Environment, policy and interruption evidence stays distinguishable; causal blame is not inferred. Reliability tab, report, and repository/agent comparisons.
- [ ] Tool reliability attributed to explicit skills (separate from tool-name attribution).
- [x] Tool latency (mergeable approximate p50/p95 with timing coverage) and timeouts.
- [x] **Opt-in P2:** Loop and churn episodes from internal keyed hashes: exact repeats, repeated failing calls, failed-edit cascades, edit thrash, re-read churn, and search loops. Persistent 0600 machine key and stream-wide hashing/reference budgets; no digests in outputs.
- [x] **Opt-in P2:** Verification share and observed-tail skips (a final edit not followed by a test/build attempt), with incomplete/active evidence and overlapping executions marked unavailable; checks must start after edits complete.
- [ ] Failing-to-passing test transitions.
- [x] Steps and time to first possible edit, with main-stream coverage.
- [x] MCP server table: calls, error rate, latency, connection failure reports and servers seen.
- [ ] MCP configured-but-unused servers and schema token cost.
- [x] Hook runs, blocking summaries, and p95 duration with timing coverage.
- [x] Permission denials, permission-mode observations, and Codex approval-policy/sandbox mix.
- [ ] Permission prompts per 100 calls and most-approved command classes as allowlist candidates.
- [ ] Failure-loop cost: tokens and value spent inside flagged windows.

### Usage velocity

- [x] Local date/hour activity buckets for value, token classes, calls and starts, preserving per-event agent, model, execution and effort.
- [x] Velocity view by agent, provider, model, repository, execution and effort: day/week/month/hour, stacked/line/cumulative charts, rolling daily average, guarded comparisons, burn, scenario projection and movers.
- [x] Summary daily chart shares the agent velocity ledger; coverage and missing timestamps remain explicit.
- [x] Validate all public velocity model labels; gate inferences on metric evidence, select Codex coverage with charged counters, reject ambiguous start timestamps, and keep agent chart encodings stable across filters.
- [ ] Distinguish custom agent identities through an opt-in reviewed taxonomy without exposing free-text attribution.

### Limits, cache, and context economics

- [x] Public pricing feeds (models.dev and LiteLLM), immutable request-time snapshots, reviewed exceptions, offline mode, rates CLI, and source provenance with a dashboard Pricing tab.
- [x] Bound provider model labels and report errors; distinguish imputed cache rates in coverage/provenance; index retained price history and deduplicate unchanged rate tables without deleting observations.

- [ ] Rate-limit headroom over time from Codex rate-limit snapshots and Claude quota records: time to limit, sessions that hit limits, and usage-limit errors.
- [ ] Cache-break events with their cause (provider-reported cache-miss reason, idle gap longer than the TTL, model switch, tool-set change) and the cost of re-caching.
- [ ] Context fill curve, peak fill, compaction before and after sizes, and turns between compactions.
- [ ] Subscription leverage per profile: API-equivalent value against plan price.

- [x] Rate-limit headroom over time from Codex snapshots and Claude quotas: guarded time to limit, sessions with observed limit errors, profile usage caches and Desktop account history.
- [x] Cache-break provider reasons and separately labeled idle-TTL/model-switch/compaction heuristics; observed re-cache write cost and no-cache input counterfactual.
- [x] Context fill curves, paired per-request peaks, recorded compaction before/after sizes, and turns between compactions.
- [x] Subscription leverage per profile against explicitly configured monthly USD prices, with coverage guards.
- [x] Independent numeric quota freshness, compaction-only date filtering, and a 20,000-point snapshot curve budget with exact aggregates.
- [ ] Counterfactual pricing: the same tokens at another model's rates.

- [x] Counterfactual pricing: the same tokens at the next mapped tier's rates by default (configurable, explicit-target override), within provider and with explicit eligible-session coverage and no quality claim ([Insights](insights.md)).

## M2: Outcomes

### Session to commit to pull request

M2 links agent sessions to the code they produced, retroactively from existing logs, without hooks installed in advance and without uploading content.

- [x] Evidence-ranked session links from structured commit/PR operations and PR-link records, with weak branch/starting-checkout/workspace context kept separate from produced outcomes. Dashboard, report, and JSON include confidence and coverage.
- [x] Opt-in bounded local Git branch/window correlation, agent co-author trailer counts, and authenticated GitHub state/time-to-merge lookup for already evidenced PRs.
- [x] Guarded API-equivalent value per merged PR, changed lines per dollar, and edits-without-commit value labeled as a linkage heuristic, with deduplicated PRs and explicit pricing denominators.
- [x] Lines added and removed from Claude patches/cumulative totals, Codex completed FileChange diffs, and Cursor composer totals; missing and partial coverage remain visible.
- [x] Reconcile snapshot tails and resets, deduplicate cross-file Claude results, retain valid files in mixed Codex batches, and guard/report capped evidence consistently across surfaces.
- [ ] Hashed file-overlap correlation, reverted changes, line survival at 14 and 30 days, and follow-up fix commits.
- [ ] Cost per surviving line and independently evidenced abandoned or reverted spend.
- [ ] Hotspots: files with the most failed edits, churn, and sessions over time. File paths are shown locally only and never leave the parser in shared outputs.

### Human and agent interaction

- [x] Autonomy run length, human turns per session, turn wall time, and estimated waiting-for-human versus agent-active time, with coverage and explicit idle thresholds.
- [ ] Separate permission-wait time from agent activity using stable permission lifecycle evidence.
- [x] Codex interrupts, opt-in Claude marker counts, mid-turn steering, queue reason classes and plan-mode use.
- [ ] Plan-rejection evidence and rates (permission approvals are not plan rejections).
- [x] Concurrency: active sessions over time, daily peaks, effective parallelism and repository-level concurrency.
- [x] Session archetypes (quick, standard, deep, marathon) and a labeled stale-open-session abandonment heuristic.
- [x] Model, effort, CLI-version, entrypoint and originator mix with guarded, descriptive before/after comparisons.
- [ ] Task-matched regression attribution; observed timing changes alone cannot establish a regression.
- [x] Leading slash-command names and skill usage, including discovered installations without an observed invocation in scope.
- [x] Workflow dashboard and report, UTC active-time/value heatmaps and activity streaks.
- [x] Fail closed on unregistered slash-history tokens and incomplete primary lifecycle evidence; isolate optional workflow failures from accounting.
- [x] Reuse full-snapshot workflow aggregates, compute filtered cohorts in a browser worker, and preserve skill inventories in empty scopes.

## M3: Agent-facing

### Metrics-only MCP server

An MCP server that answers with metrics, never transcript text, so an agent cannot be steered by content from another session.

- [x] Dependency-free stdio MCP with strict schemas, repository defaults, bounded requests and a snapshot TTL; current and legacy protocol support.
- [x] `usage_summary`: repository/provider/model/execution-kind totals with price coverage and independent source-health counts, including empty results.
- [x] `budget_status`: today/this-week dated API value and priced/eligible token coverage, guarded burn rate, and fresh recorded Codex headroom. Current-session attribution and live quotas remain unavailable.
- [x] `repo_profile`: typical session value/turns/duration, tool/skill mix, cache hits and compactions with sample guards and active/settled/unknown lifecycle coverage.
- [x] `tool_stats`: call counts and structured outcome flags with coverage; integrated reliability summaries include guarded outcomes, latency and verification.
- [x] `recent_sessions`: hashed keys, providers/models, duration and value.
- [x] `compare_agents`: all public provider categories in one repository, without quality rankings.
- [ ] `tool_reliability`: failure history for a tool or command class in this repository.
- [ ] `repo_hotspots`
- [ ] `typical_cost`: by session archetype in this repository.
- [ ] `mcp_health`
- [x] `unused_extensions`: names-only conventional local inventory versus observed use, with frontmatter/alias identity matching, escaped-string privacy and explicit partial coverage.
- [x] An agent skill that opens the dashboard or reads the JSON snapshot ([skills/session-analytics](../skills/session-analytics/SKILL.md)).
- [ ] Optional hooks: pre-tool warnings from historical failure statistics, and a cross-provider budget guard.

### Opt-in review and coaching

Content-free coaching is local (P0/P1). Content review is **opt-in, off by default (P3)**.

- [x] Bounded review scaffolding: run content-free detectors first, preview sizes and redaction counts, then optionally review up to three windows through the user's CLI with explicit `--send-content` and an `unknown` fallback. Main Claude/Codex transcripts only; no causal attribution claim.
- [x] Ten coaching rules with denominators, configurable guards, estimated impact, confidence and suggested actions: repository peer outliers, cache reuse, price scenarios, compaction, delegation, large contexts, no-observed-use skills/MCP servers, idle-gap write associations and neutral start-time patterns. Insights tab with bounded rendering and session dry-run commands, CLI/JSON, dismiss/snooze/restore.
- [x] Coaching evidence guards: owned request peaks/size coverage, explicit partial/liveness states, completed-peer eligibility, per-target activity guards, unambiguous MCP attribution and stable eligible review sources.
- [x] Group coaching by rule/scope level with unique affected counts, ranked expandable scope tables, independent rule/scope dismiss/snooze, grouped CLI output and versioned `groups` + `items` JSON.
- [ ] Coaching extensions requiring richer evidence: request-level context fill above 60%, correction streaks, unverified final edits, repeated-approval context and hotspots. Permission approvals alone carry little signal.

## M4: Breadth and export

- [x] GitHub Copilot CLI persisted activity events, OpenCode SQLite history, and Gemini JSON/JSONL saved chats, verified against primary sources.
- [ ] Copilot persisted shutdown usage calibration; additional OpenCode schema generations and older JSON-directory storage.
- [ ] More agents, driven by demand: Pi, Grok, Goose, and Cline.
- [ ] OpenTelemetry GenAI export (pinned to a specification commit while the specification is in development), so sessions can be sent to existing observability backends.
- [ ] Team mode, later: content-free aggregates, pseudonymized repositories, k-anonymity thresholds, and a preview of exactly what leaves the machine before anything is shared.

- [ ] More agents, driven by demand: GitHub Copilot CLI, OpenCode, Gemini CLI, Pi, Grok, Goose, and Cline.
- [x] OpenTelemetry GenAI attributes in OTLP/JSON session aggregate logs, pinned to a Development specification commit, with explicit opt-in collector delivery.
- [x] Team sharing: aggregate-only preview, keyed repository pseudonyms or aliases, minimum-session suppression, disjoint-source merge, and a snapshot dashboard. Session thresholds do not guarantee person-level anonymity.
- [x] Versioned JSON Schemas, CSV/NDJSON exports, and browser downloads of the filtered view.
- [x] Enforce interchange identifier/warning allowlists, reconcile rollups, preserve coverage caveats, normalize UTC date selection, and prevent stale export previews or cross-source dashboard reuse.

## Architecture direction

- [x] Document [research-grounded metric candidates and an aggregate-only evidence audit](proposals/metrics-research.md), plus a [proposed normalized event model and provider ontology](proposals/schema-v2.md). This completes the design artifact, not the metric implementations above.
- [ ] Validate detector precision, false-flag burden and coverage on independently labeled, held-out trajectories before promoting experimental flags to coaching or automated interventions.

The analyzer will move from "scan everything on launch and keep a snapshot in memory" to "ingest incrementally into a persistent, content-free index":
The analyzer now ingests Claude/Codex incrementally into a persistent, content-free index in `src/store/`. Further extraction will move source parsing and metric computation into dedicated modules:

```text
adapters/    one per source; parse raw stores into normalized events
model/       normalized event schema (session, turn, model request, tool call and result,
             file edit, command, compaction, sub-agent, permission decision, hook run,
             rate-limit sample, git evidence)
store/       SQLite index, migrations, ingest watermarks
metrics/     registry: id, formula, privacy tier, fidelity per source, denominator guard
pricing/     versioned rate cards
surfaces/    cli, dashboard, mcp, skill, export
```

- The index lives outside repositories by default: `~/Library/Application Support/session-analytics/` on macOS and `$XDG_DATA_HOME/session-analytics/` (fallback `~/.local/share/session-analytics/`) on Linux. `SESSION_ANALYTICS_DATA_DIR` or `--data-dir` overrides it. Only derived facts and keyed fingerprints are stored.
- An optional raw-transcript archive, so history can outlive provider retention, is content and therefore **opt-in and off by default**.
- The JSON output carries a `schemaVersion`, and MCP tool names and custom telemetry attributes will stay brand-neutral.
- The runtime stays dependency-free. Distribution is `git clone` today; an npm package or a single binary may follow.

## Interpretation guardrails

Every metric added by this roadmap carries interpretation notes in its registry entry. Research on agent trajectories points to these rules:

- Session length misleads unless compared with a baseline for the same repository and kind of task.
- Interrupt rates tend to rise with user expertise; they are not a failure signal on their own.
- Permission approvals are nearly universal and carry little signal; plan rejections carry more.
- The number of errors in a session matters more than whether any error occurred.
- Loop and churn flags differ only modestly between failed and successful runs. They are flags, not verdicts.
- Passing tests are a weak outcome label: failed runs often claim success.
- Activity counters describe work; they do not prove quality, success, causation, or value delivered (see [metrics.md](metrics.md)).

## v0.6.0 release integration

- [x] Fourteen views grouped in the Control Room shell, consistent theme components, palette, shortcuts and URL entry points.
- [x] One dispatcher, shared options, complete schema/index projection and cross-lane MCP summaries.
- [x] Cold/warm/full projection parity including pricing, P2 settings and quota replay; one synthetic demo for every view.
- [x] Reconciled release documentation and explicit privacy/network boundaries.

- [x] v0.6.1: independent regression coverage for repository identity, Cursor and additional-provider replay, partial pricing coverage, aggregate displays, and legacy snapshot normalization.
- [x] v0.6.1: native continuation/receipt/iteration accounting, historical pricing, retained Conductor message recovery, and complete index dependency signatures.
- [x] v0.6.1: serialized, content-free real-machine verification with independent raw-data oracles and full/cold/warm comparison; exact unrecoverable historical ownership remains explicitly partial.
