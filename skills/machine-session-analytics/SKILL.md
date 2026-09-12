---
name: machine-session-analytics
version: 0.3.3
description: Launch a privacy-safe localhost dashboard for machine-wide Codex, Claude, and Cursor session metrics grouped by repository. Use when asked to show, open, restart, compare, or analyze local coding-agent sessions, tokens, tools, models, execution shape, pricing coverage, or API-equivalent usage across repositories.
mutating: false
brain_first: false
tools:
  - node
  - sqlite
triggers:
  - coding agent session analytics
  - local coding agent session
  - Codex Claude Cursor usage
  - priced Codex Claude Cursor usage
  - usage across all repositories
  - local agent sessions by repository
  - priced agent usage across repositories
  - localhost agent session dashboard
  - machine session snapshot
  - local agent compaction and tool usage
  - model pricing coverage
  - Cursor session history by repository
  - sessions registered by Conductor
---

# Machine session analytics

## Contract

Show content-free session analytics for every locally evidenced Codex, Claude, and Cursor session. Group sessions by repository, preserve pricing provenance, and never return transcript content, prompts, reasoning, tool arguments or results, commands, paths, credentials, or raw identifiers.

## Phase 1: launch it

For a request to show, open, run, analyze, or restart the dashboard, immediately run exactly one command:

```bash
node .agents/skills/machine-session-analytics/scripts/server.ts --open
```

Do not ask the user to run commands. Do not run setup, preprocessing, `cli.ts`, or `--help` first. The command discovers the evidence, calculates the snapshot, starts the loopback server, and opens the browser. It is safe to rerun: when a compatible dashboard already owns the port, it reuses and opens that dashboard.

Use repository or evidence-path flags only when the user explicitly narrows the request. Otherwise scan the complete machine evidence set and include hidden optional metadata.

## Phase 2: know where the files are

The script reads standard local stores automatically:

- Codex: `~/.codex/sessions/` and `~/.codex/archived_sessions/`.
- Claude Code: `~/.claude/projects/`.
- Claude Desktop local agents: `~/Library/Application Support/Claude/local-agent-mode-sessions/`.
- Cursor: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` plus its workspace mappings.
- Optional Conductor enrichment: `~/Library/Application Support/com.conductor.app/conductor.db`.
- Reproducible prices: `references/rate-cards.json` inside this skill.

Provider stores define the scan. Conductor is optional enrichment and is never required. “All repositories” means every repository evidenced by provider sessions, plus optional registered zero-session repositories; it is not a blind crawl of unrelated directories.

## Phase 3: understand the patterns

The bundled analyzer handles these patterns without manual agent work:

1. Discover provider-owned active, archived, delegated, and IDE session evidence.
2. Assign sessions through validated working directories, workspace mappings, and canonical Git roots.
3. Normalize provider schemas and deduplicate broadcast counters, repeated messages, subagent traces, tools, and Cursor bubbles.
4. Apply the versioned model rate card while keeping unknown models visible and Cursor provider-reported values separate.
5. Project only allowlisted counters into a read-only dashboard bound to `127.0.0.1`.

Read [the metric and interpretation catalog](references/metrics-catalog.md) before changing a metric or rate, adding a public field, or making an interpretation beyond the dashboard labels.

## Phase 4: understand the metrics

The dashboard contains:

- Scope and health: repositories found, repositories with sessions, analyzed sessions, provider evidence coverage, pricing coverage, missing evidence, unpriced models, and live snapshots.
- Tokens: processed input, uncached input, cache reads, observable cache writes, output, and separately exposed reasoning output.
- Usage value: API list-price equivalents, cache-write upper estimates, Cursor provider-reported local value, and top-level versus subagent allocation. These are not invoices or subscription charges.
- Execution shape: turns, model responses and calls, task markers, tool calls by name, compactions, summaries, queue operations, delegated agents, duration, and working or terminal state.
- Comparisons: repository totals, provider and model mix, daily priced-usage velocity, selectable time windows, ranked sessions, cache ratio, tool distribution, and immediate repository drill-down.

Processed input is request-context consumption, not unique authored text. Tools and task markers describe activity; they do not prove quality, success, causation, or value delivered.

## Phase 5: report the result

After launching, report the dashboard URL, analyzed-session and repository counts, pricing coverage, live-snapshot count, and any warnings. Keep API-equivalent and provider-reported values separate. Use a separately scoped forensic workflow for causal claims or raw chronology.

For terminal-only output when explicitly requested, run `scripts/cli.ts`; add `--json` only when machine-readable output is requested.

## Output format

Report:

1. the opened localhost URL and selected scope;
2. session, repository, evidence, pricing-coverage, and live-snapshot status;
3. API-equivalent and provider-reported usage values with their caveats;
4. bounded warnings or investigation candidates without declaring causes.

## Anti-patterns

- Do not turn launch into a checklist or ask the user to run the script.
- Do not run multiple discovery, preprocessing, CLI, and server commands for the default dashboard flow.
- Do not return transcript content, workspace paths, repository roots or remotes, raw session/provider IDs, tool inputs or results, commands, credentials, or raw local errors.
- Do not require Conductor, scan unrelated directories, open a metadata database in write mode, bind to a LAN address, add CORS, or fetch live prices at launch.
- Do not call API-equivalent usage an invoice or infer success, quality, root cause, or delivered value from activity counters.

## Tools used

- One `server.ts --open` entrypoint for discovery, analysis, serving, browser launch, and idempotent reuse.
- Node.js 24 `node:sqlite` for streaming JSONL and read-only local SQLite analysis.
- A versioned local rate card and dependency-free loopback HTTP dashboard.
