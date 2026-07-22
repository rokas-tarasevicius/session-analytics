# conductor-session-analytics

A product-neutral GBrain v1 package for content-free analysis of local Codex, Claude, Cursor, and Conductor session evidence, grouped by repository across the machine.

The package includes a dependency-free localhost dashboard, a human/JSON CLI, streaming Codex and Claude JSONL parsers, a read-only Cursor history reader, a versioned API rate card, machine and repository aggregations, privacy-safe public projections, routing fixtures, deterministic tests, and judge cases.

## Requirements

- macOS; Conductor metadata is optional but improves workspace attribution;
- Node.js 24 or newer for native TypeScript and `node:sqlite`;
- local Codex, Claude, or Cursor history in their standard user directories.

No network access is required. The dashboard binds only to `127.0.0.1`, has no CORS or telemetry, and never returns transcript content, raw identifiers, workspace paths, repository remotes, or local exception details.

## Run after scaffolding

```bash
node .agents/skills/conductor-session-analytics/scripts/cli.ts
node .agents/skills/conductor-session-analytics/scripts/cli.ts --json
node .agents/skills/conductor-session-analytics/scripts/server.ts --open
```

The default scope unions active and archived Codex history, Claude Code and Claude Desktop local-agent history, modern and legacy Cursor composer history, and Conductor's complete repository graph, including hidden records. Sessions are assigned through recorded working directories, Conductor/Cursor workspace mappings, and the longest matching Git root; this finds repository work under IDE folders, Documents, and other locations without crawling unrelated files. Narrow intentionally with `--repo-id`, `--repo-name`, `--repo-root`, or `--repo-remote`, or use `--exclude-hidden`. Run `cli.ts --help` for evidence-path overrides.

Database-only historical stubs are not counted as sessions. A legacy Conductor row is recovered only when exactly one provider transcript matches its provider, working directory, and start time. Cursor history contributes modern bubble token/tool metrics and provider-reported local usage value where available; Cursor value is not plotted by day because the local store does not retain per-call cost timestamps.

Dollar totals are priced usage values, not invoices. Codex and Claude use versioned API list-price equivalents; Cursor remains a separate provider-reported local value. Unknown-model tokens stay in the coverage denominator, and Codex files that transition from a sub-agent into a resumed top-level session are segmented at the transition rather than attributed wholesale to either execution mode.

## Validate

```bash
node --test test/*.test.ts skills/conductor-session-analytics/scripts/*.test.ts e2e/*.test.ts
gbrain skillpack doctor . --quick --json
gbrain routing-eval --skills-dir skills
```

Costs are reproducible API-equivalent estimates using `references/rate-cards.json`; they are not provider invoices or subscription charges.
