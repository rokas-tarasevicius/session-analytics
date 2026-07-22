# Bootstrap Conductor session analytics

GBrain displays these steps; it does not execute them.

1. Confirm macOS and Node.js 24 or newer are available. Conductor metadata improves attribution but is not the only evidence source.
2. Preview the installed skill and its content-free evidence boundary before running local analysis.
3. Run `node .agents/skills/conductor-session-analytics/scripts/cli.ts --help`.
4. Launch the read-only dashboard with `node .agents/skills/conductor-session-analytics/scripts/server.ts --open`.
5. Review the selected time window, analyzed-session count, provider mix, and pricing coverage before interpreting cross-repository comparisons.

The dashboard reads standard local Codex, Claude, Cursor, and Conductor stores. It never needs cloud credentials, network access, a consuming repository dependency, or a non-loopback bind address.
