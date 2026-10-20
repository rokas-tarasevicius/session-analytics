---
name: session-analytics
description: Open a privacy-safe localhost dashboard, or print a terminal or JSON report, of machine-wide Claude Code, Codex, Cursor, Copilot CLI, OpenCode, Gemini CLI, and supported Antigravity SQLite session metrics grouped by repository. Use when asked to show, open, restart, compare, or analyze local coding-agent sessions, tokens, cost, tools, models, compactions, pricing coverage, or API-equivalent usage across repositories.
---

# Session analytics

## Contract

Show content-free session analytics for every locally evidenced Claude Code, Codex, Cursor, Copilot CLI, OpenCode, Gemini CLI, and supported Antigravity SQLite session. Group sessions by repository, preserve pricing provenance, and never return transcript content, prompts, reasoning, tool arguments or results, commands, paths, credentials, or raw identifiers.

## Phase 1: launch it

For a request to show, open, run, analyze, or restart the dashboard, immediately run exactly one command:

```bash
session-analytics
```

If the command is not on `PATH`, run `node bin/session-analytics.ts` from a source checkout of the project when one is available. Otherwise report that session-analytics is not installed and point to the installation guide in the project's `docs/cli.md#install`; do not install it without the user's go-ahead. Do not ask the user to run commands. Do not run setup, preprocessing, `report`, or `--help` first. The command discovers the evidence, calculates the snapshot, starts the loopback server, and opens the browser. It is safe to rerun: when a dashboard of the same version and options already owns the port, it reuses and opens that dashboard. If the command instead exits because another version (such as an older one left running after an upgrade) or a dashboard with different options owns the port, relay its message and run the same command again with another port, for example `session-analytics --port 4180`; do not stop the user's running dashboard.

For explicitly requested terminal output, run `session-analytics report`; add `--json` only when a machine-readable snapshot is requested.

Use repository or evidence-path flags only when the user explicitly narrows the request. Otherwise scan the complete machine evidence set and include hidden optional metadata.

The same command also reads every machine saved with `session-analytics machines add` over SSH. When the user asks to include another computer where agents run, run `session-analytics machines add HOST`, adding `--user NAME` only when the user names the account the agents run as there. Tell the user first that this copies session-analytics' own code into that account's `~/.cache/session-analytics/runtime` on that machine and runs it there over SSH. It checks the machine first and prints a `Fix:` line for each failure; relay those lines instead of running them, because sudo rules and SSH keys change the other machine. `session-analytics machines check` repeats the checks; `--find-users` lists the accounts with agent history there. Add `--no-remote` only when the user asks for this machine alone. When reporting results, say which machines were read: the `report` header and its `Machines` block, or `machines` in `report --json`, name each machine with its state (`ok`, `stale` with the age of its last good snapshot, or `failed`) and its fix. Never present a stale or failed machine's totals as current. `session-analytics limits` reads the same machines' subscription limits and merges them by account; its header, `Machines` block and each account's `Reported by` line say which machines were read. For scheduled or scripted runs, `--strict` makes `report` and `export` exit 3 when any machine was not read now.

## Phase 2: know where the evidence is

### Direct metrics through MCP

When the user asks a metric question and the `session-analytics` MCP server is connected, use its tools directly: `usage_summary`, `budget_status`, `repo_profile`, `tool_stats`, `recent_sessions`, and `compare_agents`. Continue to use the dashboard launch above when the user asks to open or show the dashboard. Installation is documented in `docs/mcp.md`; the server command is `session-analytics mcp`.

MCP defaults to the server's launch repository when known. Use `scope: "machine"` only for a machine-wide question; discover repository keys through `usage_summary` and pass `repositoryId` when narrowing. Tools never accept filesystem paths. Ordinary windows select sessions by start time in UTC; budget periods use dated API value. Report snapshot age, price coverage and observed denominators, and preserve `null` for unavailable or insufficient samples. API-equivalent value is not an invoice. Tool call counts are activity, not success; no tool reports quota headroom or error rates. Do not open transcripts to fill evidence gaps.

The command reads standard local stores automatically:

- Claude Code: `~/.claude/projects/`, every additional `~/.claude-*/projects/` profile, and `$CLAUDE_CONFIG_DIR/projects/`.
- Claude Desktop local agents: `~/Library/Application Support/Claude/local-agent-mode-sessions/`.
- Codex: `~/.codex/sessions/` and `~/.codex/archived_sessions/`, every additional `~/.codex-*` profile, and `$CODEX_HOME`.
- Cursor: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` plus its workspace mappings.
- Cursor SDK and activity-only transcripts: Conductor's `cursor-sdk-store` and `~/.cursor/projects/*/agent-transcripts`.
- Copilot CLI: `~/.copilot/session-state/*/events.jsonl`.
- OpenCode: `$XDG_DATA_HOME/opencode/opencode.db`, or `~/.local/share/opencode/opencode.db`.
- Gemini CLI: `~/.gemini/tmp/*/chats/session-*.json` and `.jsonl`.
- Antigravity App, IDE and CLI: schema-v1 `~/.gemini/{antigravity,antigravity-ide,antigravity-cli}/conversations/<UUID>.db`; legacy `.pb` files are unsupported.
- Optional Conductor enrichment: `~/Library/Application Support/com.conductor.app/conductor.db`.
- Reproducible prices: `data/rate-cards.json` in the project.

Profiles that resolve to the same directory are read once. Provider stores define the scan. Conductor is optional enrichment and is never required. “All repositories” means every repository evidenced by provider sessions, plus optional registered zero-session repositories; it is not a blind crawl of unrelated directories.

## Phase 3: understand the patterns

The analyzer handles these patterns without manual agent work:

1. Discover provider-owned active, archived, delegated, and IDE session evidence across every local profile.
2. Assign sessions through validated working directories, workspace mappings, and canonical Git roots.
3. Normalize provider schemas and deduplicate broadcast counters, streamed message snapshots, repeated messages, subagent traces, tools, and Cursor bubbles.
4. Apply dated cached public-feed snapshots and reviewed model rates while keeping unknown models visible and Cursor provider-reported values separate.
5. Project only allowlisted counters into a read-only dashboard bound to `127.0.0.1`.

Read the project's `docs/metrics.md` before changing a metric or rate, adding a public field, or making an interpretation beyond the dashboard labels.

## Phase 4: understand the metrics

- Scope and health: repositories found, repositories with sessions, analyzed sessions, provider evidence coverage, pricing coverage, missing evidence, unpriced models, and live snapshots.
- Tokens: processed input, uncached input, cache reads, observable cache writes, output, and separately exposed reasoning output.
- Usage value: API list-price equivalents, cache-write upper estimates, Cursor provider-reported local value, and top-level versus subagent allocation. These are not invoices or subscription charges.
- Execution shape: turns, model responses and calls, task markers, tool calls by name, compactions, summaries, queue operations, delegated agents, duration, and working or terminal state.
- Comparisons: repository totals, provider and model mix, daily priced-usage velocity, selectable time windows, ranked sessions, cache ratio, tool distribution, and repository drill-down.

Processed input is request-context consumption, not unique authored text. Tools and task markers describe activity; they do not prove quality, success, causation, or value delivered.

## Phase 5: report the result

After launching, report the dashboard URL, analyzed-session and repository counts, pricing coverage, live-snapshot count, and any warnings. Keep API-equivalent and provider-reported values separate. Use a separately scoped forensic workflow for causal claims or raw chronology.

## Anti-patterns

- Do not turn launch into a checklist or ask the user to run the command.
- Do not run multiple discovery, preprocessing, report, and dashboard commands for the default flow.
- Do not return transcript content, workspace paths, repository roots or remotes, raw session/provider IDs, tool inputs or results, commands, credentials, or raw local errors.
- Do not require Conductor, scan unrelated directories, open a metadata database in write mode, bind to a LAN address, or add CORS. Dashboard startup may refresh fixed public price feeds; use `--offline` to disable pricing requests.
- Do not call API-equivalent usage an invoice or infer success, quality, root cause, or delivered value from activity counters.
