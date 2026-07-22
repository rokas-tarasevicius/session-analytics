# machine-session-analytics

A product-neutral GBrain v1 package for content-free analysis of every locally evidenced Codex, Claude, and Cursor session, grouped by repository across the machine. Conductor is an optional repository/workspace enrichment source, not the scope boundary.

The package includes a dependency-free localhost dashboard, a human/JSON CLI, streaming Codex and Claude JSONL parsers, a read-only Cursor history reader, a versioned API rate card, machine and repository aggregations, privacy-safe public projections, routing fixtures, deterministic tests, and judge cases.

## Requirements

- macOS; provider-owned local history is sufficient, while Conductor metadata optionally improves workspace attribution;
- Node.js 24 or newer for native TypeScript and `node:sqlite`;
- local Codex, Claude, or Cursor history in their standard user directories.

No network access is required. The dashboard binds only to `127.0.0.1`, has no CORS or telemetry, and never returns transcript content, raw identifiers, workspace paths, repository remotes, or local exception details.

## Run

```bash
node .agents/skills/machine-session-analytics/scripts/server.ts --open
```

This is the complete default workflow. The one command discovers local evidence, analyzes it, starts or reuses the loopback dashboard, and opens it in the browser. No setup checklist, preprocessing command, Conductor database, or repository selection is required.

For explicitly requested terminal-only output, use `cli.ts`; add `--json` for a machine-readable snapshot.

The default scope unions active and archived Codex history, Claude Code and Claude Desktop local-agent history, and modern/legacy Cursor composer history from their machine-wide stores. Every provider session is assigned through its recorded working directory, Cursor workspace mapping, optional Conductor workspace mapping, and longest matching Git root. This covers work under IDE project folders, Documents, worktrees, and other locations without assuming one app owns the repository list. When present, Conductor contributes registered zero-session repositories and hidden workspace records. Narrow intentionally with `--repo-id`, `--repo-name`, `--repo-root`, or `--repo-remote`, or use `--exclude-hidden`.

Database-only historical stubs are not counted as sessions. A legacy Conductor row is recovered only when exactly one provider transcript matches its provider, working directory, and start time. Cursor history contributes modern bubble token/tool metrics and provider-reported local usage value where available; Cursor value is not plotted by day because the local store does not retain per-call cost timestamps.

Dollar totals are priced usage values, not invoices. Codex and Claude use versioned API list-price equivalents; Cursor remains a separate provider-reported local value. Unknown-model tokens stay unpriced in the coverage denominator. Duplicated Codex process snapshots are owned by the file with the closest local response activity rather than whichever receiver happened to record the snapshot first. Codex execution transitions are segmented at each `session_meta`, and Claude usage from nested sub-agent evidence is accounted separately inside its composite session.

## Validate

```bash
node --test test/*.test.ts skills/machine-session-analytics/scripts/*.test.ts e2e/*.test.ts
gbrain skillpack doctor . --quick --json
gbrain routing-eval --skills-dir skills
```

Costs are reproducible API-equivalent estimates using `references/rate-cards.json`; they are not provider invoices or subscription charges.
