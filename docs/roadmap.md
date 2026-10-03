# Roadmap

This roadmap is ordered: correctness first, then reliability and economics, then outcomes, then agent-facing surfaces, then breadth. Items are content-free (privacy tiers P0 and P1 in [privacy.md](privacy.md#privacy-tiers)) unless marked **opt-in**. Opt-in features that need content are always off by default, labeled in the interface, and kept out of the default index.

Status: `[x]` shipped, `[ ]` not yet shipped. Milestones are not dated.

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
- [ ] Cursor: read agent CLI transcripts and sessions run through Conductor's Cursor integration.
- [ ] Conductor: use per-session result records as fallback evidence when a provider transcript has been deleted.
- [x] Regression tests for streamed Claude usage, current Codex rollouts, profile discovery, and Cursor headers.
- [ ] Golden-fixture parity tests for each supported provider format version.
- [ ] Reconciliation report: compare computed totals with provider-reported totals where they exist.
- [ ] Persistent content-free index with incremental ingest (per-file path, size, modification time, and offset watermarks), so launches stop rescanning unchanged history.

## M1: Reliability and economics

### Tool reliability and behavior

Local histories already record tool errors, exit codes, timeouts, durations, MCP call status, hook timing, permission modes, and denials. M1 turns them into content-free measures.

- [ ] Tool error rate by tool, normalized tool class, MCP server, and skill, with low-cardinality error classes (for example not found, edit anchor mismatch, permission denied by user or policy, hook blocked, timeout, command not found, test failed, rate limited, server error, MCP error, interrupted). Environment faults are kept separate from agent faults.
- [ ] Tool latency (p50 and p95) and timeouts.
- [ ] Loop and churn flags from keyed hashes (with a per-machine secret) of tool name and arguments plus exit codes: repeated failing calls, failed-edit cascades, edit thrash on one file, re-read churn, and search loops.
- [ ] Verification share and verification skips (a final edit not followed by a test or build), and failing-to-passing test transitions.
- [ ] Steps and time to first edit.
- [ ] MCP server table: calls, error rate, latency, connection failures, configured-but-unused servers, and schema token cost.
- [ ] Hook runs, blocks, and p95 duration.
- [ ] Permission friction: prompts per 100 tool calls, denials, and the most-approved command classes as allowlist candidates.
- [ ] Failure-loop cost: tokens and value spent inside flagged windows.

### Limits, cache, and context economics

- [ ] Rate-limit headroom over time from Codex rate-limit snapshots and Claude quota records: time to limit, sessions that hit limits, and usage-limit errors.
- [ ] Cache-break events with their cause (provider-reported cache-miss reason, idle gap longer than the TTL, model switch, tool-set change) and the cost of re-caching.
- [ ] Context fill curve, peak fill, compaction before and after sizes, and turns between compactions.
- [ ] Subscription leverage per profile: API-equivalent value against plan price.
- [ ] Counterfactual pricing: the same tokens at another model's rates.

## M2: Outcomes

### Session to commit to pull request

M2 links agent sessions to the code they produced, retroactively from existing logs, without hooks installed in advance and without uploading content.

- [ ] Session, commit, and pull-request links ranked by evidence strength: a commit SHA in a tool result, a pull-request URL, an orchestrator workspace's pull request, a branch, hashed file overlap, then a time window. Every link carries a confidence label.
- [ ] Enrichment from local Git and the GitHub CLI: merged, reverted, time to merge, line survival at 14 and 30 days, and follow-up fix commits.
- [ ] Cost per merged pull request, cost per surviving line, and abandoned or reverted spend.
- [ ] Lines added and removed per session.
- [ ] Hotspots: files with the most failed edits, churn, and sessions over time. File paths are shown locally only and never leave the parser in shared outputs.

### Human and agent interaction

- [ ] Autonomy run length, human turns per session, turn wall time, and the split between waiting for a human, agent activity, and waiting on permissions.
- [ ] Interrupts, mid-turn steering, plan-mode use, and plan rejections.
- [ ] Concurrency: parallel sessions over time and effective parallelism, which matters most for orchestrator users.
- [ ] Session archetypes (quick, standard, deep, marathon) and abandonment.
- [ ] Model, effort, and CLI-version mix, with regression detection when a CLI or model version changes.
- [ ] Slash-command and skill usage, including installed-but-unused skills.

## M3: Agent-facing

### Metrics-only MCP server

An MCP server that answers with metrics, never transcript text, so an agent cannot be steered by content from another session.

- [x] Dependency-free stdio MCP with strict schemas, repository defaults, bounded requests and a snapshot TTL; current and legacy protocol support.
- [x] `usage_summary`: repository/provider/model/execution-kind totals with price coverage and independent source-health counts, including empty results.
- [x] `budget_status`: today/this-week dated API value and priced/eligible token coverage, guarded burn rate, and fresh recorded Codex headroom. Current-session attribution and live quotas remain unavailable.
- [x] `repo_profile`: typical session value/turns/duration, tool/skill mix, cache hits and compactions with sample guards and active/settled/unknown lifecycle coverage.
- [x] `tool_stats`: call counts and structured outcome flags with coverage; broader reliability remains M1.
- [x] `recent_sessions`: hashed keys, providers/models, duration and value.
- [x] `compare_agents`: the three providers in one repository, without quality rankings.
- [ ] `tool_reliability`: failure history for a tool or command class in this repository.
- [ ] `repo_hotspots`
- [ ] `typical_cost`: by session archetype in this repository.
- [ ] `mcp_health`
- [x] `unused_extensions`: names-only conventional local inventory versus observed use, with frontmatter/alias identity matching, escaped-string privacy and explicit partial coverage.
- [x] An agent skill that opens the dashboard or reads the JSON snapshot ([skills/session-analytics](../skills/session-analytics/SKILL.md)).
- [ ] Optional hooks: pre-tool warnings from historical failure statistics, and a cross-provider budget guard.

### Opt-in review and coaching

**Opt-in, off by default (P3).**

- [ ] Run content-free detectors first to find suspect windows, then optionally ask an LLM to review only those windows, through your own agent CLI, with an explicit "unknown" answer.
- [ ] Coaching cards, each tied to a measured signal: cache waste, context above 60%, repeated approvals, correction streaks, unverified final edits, unused MCP servers and skills, and hotspots.

## M4: Breadth and export

- [ ] More agents, driven by demand: GitHub Copilot CLI, OpenCode, Gemini CLI, Pi, Grok, Goose, and Cline.
- [ ] OpenTelemetry GenAI export (pinned to a specification commit while the specification is in development), so sessions can be sent to existing observability backends.
- [ ] Team mode, later: content-free aggregates, pseudonymized repositories, k-anonymity thresholds, and a preview of exactly what leaves the machine before anything is shared.

## Architecture direction

The analyzer will move from "scan everything on launch and keep a snapshot in memory" to "ingest incrementally into a persistent, content-free index":

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

- The index will live outside any repository: `~/Library/Application Support/<name>/` on macOS and `$XDG_DATA_HOME/<name>/` on Linux, holding the derived index and configuration.
- An optional raw-transcript archive, so history can outlive provider retention, is content and therefore **opt-in and off by default**.
- The JSON output will carry a `schemaVersion`, and MCP tool names and custom telemetry attributes will stay brand-neutral.
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
