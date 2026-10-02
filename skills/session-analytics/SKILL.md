---
name: session-analytics
description: Open a privacy-safe localhost dashboard, or print a terminal or JSON report, of machine-wide Claude Code, Codex, and Cursor session metrics grouped by repository. Use when asked to show, open, restart, compare, or analyze local coding-agent sessions, tokens, cost, tools, skills, models, compactions, pricing coverage, or API-equivalent usage across repositories.
---

# Session analytics

## Contract

Show content-free session analytics for every locally evidenced Claude Code, Codex, and Cursor session. Group sessions by repository, preserve pricing provenance, and never return transcript content, prompts, reasoning, tool arguments or results, commands, paths, credentials, or raw identifiers.

## Phase 1: launch it

For a request to show, open, run, analyze, or restart the dashboard, immediately run exactly one command:

```bash
session-analytics
```

If the command is not on `PATH`, run `node <checkout>/bin/session-analytics.ts` from a local clone of the project instead. Do not ask the user to run commands. Do not run setup, preprocessing, `report`, or `--help` first. The command discovers the evidence, calculates the snapshot, starts the loopback server, and opens the browser. It is safe to rerun: when a compatible dashboard already owns the port, it reuses and opens that dashboard.

For explicitly requested terminal output, run `session-analytics report`; add `--json` only when a machine-readable snapshot is requested.

Use repository or evidence-path flags only when the user explicitly narrows the request. Otherwise scan the complete machine evidence set and include hidden optional metadata.

## Phase 2: know where the evidence is

The command reads standard local stores automatically:

- Claude Code: `~/.claude/projects/`, every additional `~/.claude-*/projects/` profile, and `$CLAUDE_CONFIG_DIR/projects/`.
- Claude Desktop local agents: `~/Library/Application Support/Claude/local-agent-mode-sessions/`.
- Codex: `~/.codex/sessions/` and `~/.codex/archived_sessions/`, every additional `~/.codex-*` profile, and `$CODEX_HOME`.
- Cursor: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` plus its workspace mappings.
- Optional Conductor enrichment: `~/Library/Application Support/com.conductor.app/conductor.db`.
- Reproducible prices: `data/rate-cards.json` in the project.

Profiles that resolve to the same directory are read once. Provider stores define the scan. Conductor is optional enrichment and is never required. “All repositories” means every repository evidenced by provider sessions, plus optional registered zero-session repositories; it is not a blind crawl of unrelated directories.

## Phase 3: understand the patterns

The analyzer handles these patterns without manual agent work:

1. Discover provider-owned active, archived, delegated, and IDE session evidence across every local profile.
2. Assign sessions through validated working directories, workspace mappings, and canonical Git roots.
3. Normalize provider schemas and deduplicate broadcast counters, streamed message snapshots, repeated messages, subagent traces, tools, and Cursor bubbles.
4. Apply the versioned model rate card while keeping unknown models visible and Cursor provider-reported values separate.
5. Project only allowlisted counters into a read-only dashboard bound to `127.0.0.1`.

Read the project's `docs/metrics.md` before changing a metric or rate, adding a public field, or making an interpretation beyond the dashboard labels.

## Phase 4: understand the metrics

- Scope and health: repositories found, repositories with sessions, analyzed sessions, provider evidence coverage, pricing coverage, missing evidence, unpriced models, and live snapshots.
- Tokens: processed input, uncached input, cache reads, observable cache writes, output, and separately exposed reasoning output.
- Usage value: API list-price equivalents, cache-write upper estimates, Cursor provider-reported local value, and top-level versus subagent allocation. These are not invoices or subscription charges.
- Execution shape: turns, model responses and calls, task markers, tool calls by name, compactions, summaries, queue operations, delegated agents, duration, and working or terminal state.
- Comparisons: repository totals, provider and model mix, daily priced-usage velocity, selectable time windows, ranked sessions, cache ratio, tool distribution, and repository drill-down.

Skill usage is explicit for Claude `Skill` tool events, an inferred lower bound for Codex calls that read a canonical `SKILL.md`, and unavailable for Cursor. Only normalized skill identifiers and counts enter the public projection; tool arguments and paths remain excluded.

Processed input is request-context consumption, not unique authored text. Tools and task markers describe activity; they do not prove quality, success, causation, or value delivered.

## Phase 5: report the result

After launching, report the dashboard URL, analyzed-session and repository counts, pricing coverage, live-snapshot count, and any warnings. Keep API-equivalent and provider-reported values separate. Use a separately scoped forensic workflow for causal claims or raw chronology.

## Anti-patterns

- Do not turn launch into a checklist or ask the user to run the command.
- Do not run multiple discovery, preprocessing, report, and dashboard commands for the default flow.
- Do not return transcript content, workspace paths, repository roots or remotes, raw session/provider IDs, tool inputs or results, commands, credentials, or raw local errors.
- Do not require Conductor, scan unrelated directories, open a metadata database in write mode, bind to a LAN address, add CORS, or fetch live prices at launch.
- Do not call API-equivalent usage an invoice or infer success, quality, root cause, or delivered value from activity counters.
