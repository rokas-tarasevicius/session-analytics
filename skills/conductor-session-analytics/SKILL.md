---
name: conductor-session-analytics
version: 0.2.1
description: Compute privacy-safe machine-wide usage value, tool, evidence, and lifecycle metrics from local Codex, Claude, Cursor, and Conductor history, grouped by repository in a read-only comparison dashboard.
mutating: false
brain_first: false
tools:
  - node
  - sqlite
triggers:
  - analyze machine-wide Conductor sessions
  - analyze every local agent session by repository
  - compare priced agent usage value across repositories
  - launch private localhost Codex Claude session dashboard
  - export content-free session cost snapshot
  - rank local agent compaction and tool usage
  - audit Conductor transcript and model pricing coverage
  - scan Cursor session history by repository
---

# Conductor session analytics

## Contract

Measure agent usage across the machine without returning prompts, reasoning, tool arguments, tool results, messages, commands, transcript paths, workspace metadata, provider session IDs, credentials, or raw local errors. Union provider-owned Codex, Claude, and Cursor history with Conductor metadata; assign sessions to repositories through validated working directories, Conductor workspaces, and Git roots; preserve pricing provenance and estimation status; and distinguish operational indicators from verified outcomes.

Inputs are the read-only Conductor database, local Codex and Claude transcript trees, the local Cursor history database, optional repository and evidence-path filters, and a versioned rate card. Outputs are a content-free CLI snapshot or a localhost-only dashboard with machine, repository, session, model, token, cache, cost, tool-name, duration, compaction, provider, and evidence metrics.

Read [the metric and interpretation catalog](references/metrics-catalog.md) completely before adding a metric, changing a rate, changing public fields, or interpreting dashboard results.

## Phase 1: select the evidence set

1. Default to the union of active and archived global Codex transcripts, Claude Code plus Claude Desktop local-agent transcripts, Cursor's local composer and bubble history, and every repository/session record in `~/Library/Application Support/com.conductor.app/conductor.db`, including hidden Conductor records.
2. Open SQLite read-only. Provider stores are canonical session evidence; Conductor contributes repository/workspace attribution and zero-session repositories.
3. Narrow only when the caller intentionally supplies `--repo-id`, `--repo-name`, `--repo-root`, or `--repo-remote`. A duplicate name is an error; prefer the stable repository ID.
4. Include hidden Conductor records by default so machine totals are complete. Exclude them only with `--exclude-hidden` and label that scope.
5. Index each provider transcript tree once. Match known Codex and Claude sessions by Conductor provider session ID, then validate provider metadata ID and working directory. Assign unclaimed provider sessions by exact working directory, Conductor workspace, and canonical Git root.
6. Recover a legacy Conductor row without a provider ID only when one transcript uniquely matches provider, working directory, and a 15-minute start-time window. Omit database-only stubs rather than guessing or double-counting them.
7. Read Cursor's local SQLite history without returning message content. Hydrate modern bubble records, deduplicate `toolFormerData.toolCallId`, and assign composers through workspace databases, recorded paths, and Git roots. Use provider-reported `usageData.costInCents` as usage value when present; do not infer a daily cost timestamp.
8. Treat working sessions as live snapshots whose totals may change on refresh. Never select evidence by title, modification time, or nearest filename, and never crawl unrelated files merely to discover Git repositories.

## Phase 2: calculate content-free metrics

1. Stream JSONL and retain only allowlisted counters, timestamps, event classes, tool names, stable internal call IDs, and provider model IDs.
2. For Codex, treat `total_token_usage` as a process-wide snapshot, not a session-local counter. Fingerprint each total/last-usage state across the full evidence union, assign it to its earliest observation, and sum the deduplicated `last_token_usage` request. Re-evaluate top-level/sub-agent attribution at every `session_meta` transition.
3. For Claude, deduplicate repeated assistant response IDs and tool-use block IDs across the main transcript and delegated trace tree before summing usage.
4. Count effective Codex code-mode tools only from `tools.<name>(` identifiers; never return or persist the surrounding JavaScript or arguments.
5. Keep missing evidence roots, malformed records, unsupported providers, zero-token sessions, and unpriced models visible without failing unrelated repositories. Do not turn stale database pointers into fake missing-transcript sessions.
6. Project internal evidence through the public content-free schema. Repository display name is the only human-authored repository field returned. Sessions use a one-way hashed local key rather than raw Conductor or provider IDs.

## Phase 3: apply a versioned rate card

1. Read `references/rate-cards.json` or an explicit `--rate-card` override and validate its effective date, providers, non-negative prices, multipliers, thresholds, and source provenance.
2. Apply uncached input, cache-read, observable cache-write, output, and request-level long-context rates separately.
3. Treat reasoning-output tokens as part of output, never an additional charge.
4. For Codex models without observable cache writes, report the ordinary estimate and an upper estimate that treats every uncached token as a cache write.
5. Include unknown-model tokens in the price-coverage denominator. Never infer the model for tokens observed before a model marker.
6. Call API-rate calculations API list-price equivalents or priced usage value, never invoices, charges, or actual spend. Keep provider-reported Cursor value separate.
7. Use `null`/not applicable when a ratio has no denominator.

## Phase 4: run the interfaces

From an installed skill directory, launch the dashboard:

```bash
node .agents/skills/conductor-session-analytics/scripts/server.ts --open
```

The server binds only to `127.0.0.1`, rejects non-loopback hosts, coalesces concurrent refreshes, scans on startup, and refreshes only on an explicit browser request. It is read-only and returns no transcript content.

For a terminal summary or stable JSON snapshot:

```bash
node .agents/skills/conductor-session-analytics/scripts/cli.ts
node .agents/skills/conductor-session-analytics/scripts/cli.ts --json
node .agents/skills/conductor-session-analytics/scripts/cli.ts --help
```

Use evidence-path overrides only for intentional local testing. Node.js 24 or newer is required for native TypeScript execution and `node:sqlite`.

## Phase 5: interpret without overclaiming

1. Start with scope, analyzed-session count, price coverage, working-snapshot share, and rate-card date before comparing usage value.
2. Use cost per turn, task marker, model call, tool call, or active hour only as an efficiency indicator, not a quality or success score.
3. Treat provider task-complete events, tool-result counts, idle status, and low compaction counts as operational proxies rather than verified outcomes.
4. Rank high spend, duration, tool volume, and compaction sessions as candidates for bounded investigation without declaring their cause. Do not label them anomalies, failures, or root causes.
5. Use a separate, explicitly scoped forensic workflow for causal reconstruction or raw chronology. Never expand this aggregate dashboard into transcript browsing.

## Output format

Report:

1. machine/repository selection, hidden-data choice, live-snapshot count, and generated time;
2. rate-card effective date, provider caveats, analyzed-session count, and price coverage;
3. machine and per-repository priced usage value, its API-equivalent/provider-reported basis, explicit top-level/sub-agent split, tokens, cache ratio, tools, duration, compactions, provider/model mix, and evidence status;
4. deterministic ranked outliers as investigation candidates, without declaring cause;
5. missing evidence roots/transcripts, unsupported schemas/providers, unpriced models, incomplete counters, and no-data ratios.

## Anti-patterns

- Do not return titles, branches, workspace names/paths, repository roots/remotes, raw session IDs, provider IDs, prompts, messages, reasoning, tool inputs/results, commands, transcript paths, credentials, or raw local exceptions.
- Do not call this a blind filesystem repository scan. The scope is repositories evidenced by provider sessions plus the Conductor repository graph.
- Do not open the Conductor database in write mode or interrupt a session. Do not bind the dashboard to a LAN address, add CORS, or add remote telemetry.
- Do not price cached input at the uncached rate when cache reads are observable.
- Do not double-charge reasoning output or duplicate Claude response/tool records.
- Do not hide unpriced tokens, missing evidence roots, no-data denominators, or working snapshots inside a machine total.
- Do not call task completion “success,” cost “value,” or high tool volume a root cause.
- Do not fetch live prices at launch. Update the reviewed versioned rate card with source provenance.

## Tools used

- Node.js 24 `node:sqlite` for read-only Conductor/Cursor metadata and streaming JSONL analysis.
- Internal provider session IDs and working-directory metadata for exact correlation only.
- A versioned JSON rate card for reproducible API-equivalent estimates.
- A dependency-free HTTP server and browser UI bound to `127.0.0.1`.
