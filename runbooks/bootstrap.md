# Bootstrap machine session analytics

No manual bootstrap or preprocessing is required after the pack is installed.

When asked to show the analytics, the agent runs one command:

```bash
node .agents/skills/machine-session-analytics/scripts/server.ts --open
```

That command discovers the standard Codex, Claude, and Cursor stores, performs the complete machine-wide analysis, starts or reuses the read-only localhost dashboard, and opens it in the browser. Do not run `cli.ts --help`, ask the user to select repositories, or require Conductor first.

The only runtime requirement is macOS with Node.js 24 or newer. Missing provider stores are reported as coverage information without blocking the providers that are present.
