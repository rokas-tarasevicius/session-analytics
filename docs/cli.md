# Command-line reference

`session-analytics` is one executable. Run with no arguments it scans local history and serves the dashboard; subcommands print reports, export files, manage price lists and the private index, and expose the metrics-only MCP server. This page lists every command, option and environment variable. For what the tool shows and why, start with the [README](../README.md).

## Contents

- [Install](#install)
- [Dashboard](#dashboard)
- [Terminal report](#terminal-report)
- [JSON snapshot](#json-snapshot)
- [Exports and team sharing](#exports-and-team-sharing)
- [Pricing sources and history](#pricing-sources-and-history)
- [Local index](#local-index)
- [Subscription limits](#subscription-limits)
- [MCP server and agent skill](#mcp-server-and-agent-skill)
- [Options](#options)
- [Environment variables](#environment-variables)
- [Demo and developer scripts](#demo-and-developer-scripts)

## Install

Requirements: **Node.js 24 or newer** and **macOS** or **Linux** (Claude Code and Codex history also works on Linux; see [platform support](faq.md)). Windows is not supported. Install with one of:

```bash
brew install rokas-tarasevicius/tap/session-analytics   # Homebrew; uses Homebrew's Node.js
npm install -g session-analytics                        # npm registry
npm install -g https://github.com/rokas-tarasevicius/session-analytics/releases/latest/download/session-analytics.tgz
```

Then `session-analytics --version` prints the installed version. Every channel installs the same compiled package: the `session-analytics-X.Y.Z.tgz` attached to each [GitHub Release](https://github.com/rokas-tarasevicius/session-analytics/releases), which the release workflow installed and ran on Linux and macOS before publishing it. The third line needs no npm registry: npm installs the release asset directly, and `session-analytics.tgz` always names the latest release. The package has no dependencies and runs no install scripts. Packaged releases start after 0.9.0; 0.9.0 and earlier run only from a source checkout.

- **Pin a version:** `npm install -g session-analytics@X.Y.Z`, or the versioned asset `https://github.com/rokas-tarasevicius/session-analytics/releases/download/vX.Y.Z/session-analytics-X.Y.Z.tgz`.
- **Try once without installing:** `npx -y session-analytics@X.Y.Z` (or `npx --package <tarball URL> session-analytics`). npx checks the registry on every start, so configure MCP clients and the Claude Code status line with an installed command.
- **Verify a download:** run `shasum -a 256 -c --ignore-missing SHA256SUMS` beside the downloaded asset, and `gh attestation verify session-analytics-X.Y.Z.tgz -R rokas-tarasevicius/session-analytics` to check that this repository's release workflow built it. Versions the workflow publishes to npm carry npm provenance for the same bytes.

### Upgrade, roll back and uninstall

| Channel | Upgrade | Roll back | Uninstall |
| --- | --- | --- | --- |
| Homebrew | `brew upgrade session-analytics` | The tap keeps only the latest version; uninstall and install the older version through npm | `brew uninstall session-analytics` |
| npm | `npm install -g session-analytics@latest` | `npm install -g session-analytics@X.Y.Z` | `npm uninstall -g session-analytics` |
| Release tarball | Run the install command again | Install the versioned asset URL | `npm uninstall -g session-analytics` |

There is no automatic update check. After an upgrade, the first scan parses present sessions again once, and a dashboard still running the old version is named instead of reused: stop it and start the command again. An older version refuses an index that a newer version migrated ("created by a newer version"); run it with `--no-index` until you upgrade again.

Uninstalling removes the command only. The [data directory](#local-index) keeps the private index, pricing cache and limits ledger: `~/Library/Application Support/session-analytics/` on macOS and `$XDG_DATA_HOME/session-analytics/` (or `~/.local/share/session-analytics/`) on Linux, unless `--data-dir` or `SESSION_ANALYTICS_DATA_DIR` chose another; `session-analytics index path` prints the index file inside it. The sharing key stays in `$XDG_STATE_HOME/session-analytics/` (or `~/.local/state/session-analytics/`). Delete both directories to remove everything session-analytics stored; provider history is never modified. Also remove any MCP registration or status line that runs the command.

### From source

```bash
git clone https://github.com/rokas-tarasevicius/session-analytics.git
cd session-analytics
node bin/session-analytics.ts --version   # Node runs the TypeScript sources directly
npm link                                  # optional: a session-analytics command for this checkout
```

A checkout runs unreleased `master`; `git checkout vX.Y.Z` runs a release. It needs no install step: `npm ci` installs TypeScript and type definitions for the checks in [CONTRIBUTING.md](../CONTRIBUTING.md) only. `npm link` and a global install share the `session-analytics` command, so use one at a time. `npm run demo` explores synthetic history without reading your own sessions.

`npm install github:rokas-tarasevicius/session-analytics` installs the TypeScript sources under `node_modules`, where Node refuses to run them (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`); use a release channel above instead. [Releases](release.md) documents how packages are built, checked and published.

## Dashboard

```bash
session-analytics                 # scan, serve on 127.0.0.1:4174, open the browser
session-analytics --no-open       # serve without opening a browser
session-analytics --port 4180     # use another loopback port
session-analytics --offline       # use only cached and reviewed prices
session-analytics --snapshot team.json --no-open   # open a saved or shared snapshot without scanning
session-analytics --remote server # also read another machine over SSH
```

The server binds to `127.0.0.1` only and answers read-only `GET` requests. `--remote` adds machines read over your SSH configuration, such as a server where agents run; see [combine machines](interop.md#combine-machines). Running the command again reuses a verified live dashboard on that port only when it runs the same version with the same analysis options; otherwise stop it or choose `--port`. After an upgrade, a dashboard still running the old version is named with its version instead of being reused; the footer shows the version a dashboard runs. Saved-file dashboards are kept separate. **Refresh snapshot** in the dashboard re-scans without restarting. Stop it with `Ctrl+C`.

### Window and URL state

The dashboard starts with the last 30 days of observed history. `?window=7`, `?window=30`, `?window=90`, or `?window=all` overrides this for the visit, and `?window=custom&start=YYYY-MM-DD&end=YYYY-MM-DD` opens a custom range. `?view=` selects a view (`summary`, `velocity`, `costs`, `pricing`, `tools`, `activity`), `?repo=` focuses a repository, and `?theme=` / `?density=` apply a one-visit appearance. The window is not saved in browser storage, but the address bar follows the view, window and repository focus, so reload, bookmarks and Back/Forward return to the same place. Sessions with an unknown start time only count under **All**, and **Export view** downloads cover the selected window, so choose **All** for a whole-history export.

### Dates and timezones

Every money total follows **activity dates**, even when the session began before the selected window. Sessions, tokens and tools select sessions by start date. The analysis timezone is shown in the view; pass `--time-zone ZONE` (or set `TZ` before launching) to choose a different one. Cursor's provider-reported value and other activity without timestamps stay undated. Value from sources that record no request times (Conductor result receipts, or a Gemini message or Cursor SDK run without its own time) is **session-dated**: placed on the session's last activity and stated in the Summary and Velocity notes. Projection bands are workload scenarios, not confidence intervals or invoices. See the [velocity definitions](metrics.md#velocity-snapshot-version-1) for denominators and attribution rules.

Missing or timezone-free session starts are counted as undated and excluded from dated session-start totals. Velocity comparisons show current/prior evidence beside each percentage; gaps in pricing or token detail make changes, burn and projections unavailable. Agent colors and patterns stay attached to the same identity as filters change.

## Terminal report

```bash
session-analytics report
```

Prints repository totals, priced usage value split into API-equivalent and provider-reported parts, token and cache totals, the 15 highest-value sessions by hashed key, and coverage warnings.

## JSON snapshot

```bash
session-analytics report --json > snapshot.json
jq '.repositories[] | {name: .repository.name, usd: .summary.estimatedSpendUsd}' snapshot.json
```

The snapshot has the same shape as the dashboard's `/api/analytics` response and carries `schemaVersion: 1`, validated by the [published JSON Schema](../schemas/snapshot.v1.schema.json). Every field is described in the [field manifest](privacy.md#field-manifest).

## Exports and team sharing

```bash
session-analytics export --format csv --out ./exports
session-analytics export --format ndjson --out ./ndjson
session-analytics export --format otlp-json --out ./otlp
session-analytics report --share > shared.json  # exact local preview; sends nothing
session-analytics merge alice-shared.json bob-shared.json --out team.json
session-analytics --snapshot team.json --no-open
session-analytics merge laptop.json server.json --out machines.json  # your own machines, full detail
```

CSV exports sessions, daily value, models, and tools. **Export view** in the dashboard downloads the filtered JSON or CSV locally. `report --share` removes session details, uses keyed repository pseudonyms or explicit aliases, and suppresses repository buckets with fewer than five distinct sessions by default. This threshold counts sessions, not people, and does not guarantee anonymity. Merge rejects repeated contributing sources. Merging full snapshots instead combines your own machines into one full snapshot; create each with `report --json --portable-ids --time-zone ZONE` (see [combine machines](interop.md#combine-machines)). A full or shared snapshot can be opened without scanning provider history. Imports enforce hashed identifiers, fixed warnings/status labels, and reconciled accounting. Filtered downloads preserve discovery caveats, select whole sessions by start date in the snapshot's timezone, and honour the active view's provider filter; the daily value CSV is the activity-dated ledger for the selected dates, so it adds up to the dashboard's usage value. Shared totals may include running and partially parsed sessions; pricing coverage does not establish evidence completeness.

See [schemas, exports, and sharing](interop.md) for field definitions, aliases, threshold controls, the pinned OpenTelemetry mapping, and optional `--otlp-endpoint` delivery. Export files never overwrite existing files; network delivery happens only with that explicit flag.

## Pricing sources and history

```bash
session-analytics rates update               # fetch and archive public price lists
session-analytics rates show gpt-5.4 --json   # inspect rates and provenance
session-analytics rates diff                 # changes between the last two source snapshots
session-analytics rates status --offline     # age, sources, and local model coverage
session-analytics --offline                  # dashboard using only local cached/reviewed prices
```

Analysis never waits for the network. The dashboard uses the local cache immediately and refreshes stale sources in the background after its first scan; **Refresh snapshot** applies the new evidence. A report only prints an update hint on stderr (including with `--json`). The default stale threshold is seven days. `--offline` or `SESSION_ANALYTICS_OFFLINE=1` prevents public requests in every command.

Each request uses the latest available source snapshot at or before its timestamp. Requests older than the cache use the oldest available snapshot and carry an explicit label; this is an estimate, not reconstructed historical pricing. Every observation is retained, so a later price observation does not overwrite earlier evidence; unchanged rate tables share storage and indexed history keeps request lookup bounded. The dashboard's **Pricing** view shows freshness, coverage, and the provenance used by selected sessions. The [pricing reference](pricing.md) explains precedence, aliases, cache storage, and limitations.

## Local index

The first launch builds the index; later launches and dashboard refreshes fingerprint evidence and reuse unchanged session facts. Claude main and subagent files form one invalidation group. Codex ownership is recomputed from cached counter evidence so a changed rollout can invalidate another session without re-parsing unrelated files. Cursor's mutable databases and repository assignments are refreshed on every scan.

Each warm scan checks a rotating sample of up to four cached native sessions and one Codex ledger against fresh parsing. A consistency failure rolls back the ingest and runs a full scan with a visible warning; that fallback includes present sources only. Key/MAC corruption still fails closed. `--no-index` remains available on both dashboard and report commands.

```bash
session-analytics index status             # counts, schema, and last-ingest statistics
session-analytics index status --json
session-analytics index path               # local management path, never in analytics output
session-analytics index prune --before 2026-01-01
session-analytics index rebuild            # discard old facts, then rescan configured sources
session-analytics report --no-index        # bypass the index, including retained history
```

The default data directory is `~/Library/Application Support/session-analytics/` on macOS and `$XDG_DATA_HOME/session-analytics/` (or `~/.local/share/session-analytics/`) on Linux. Override it with `--data-dir PATH` or `SESSION_ANALYTICS_DATA_DIR`. The directory is mode `0700`; the database, SQLite sidecars, and per-machine key are `0600`. The index stores derived facts and keyed fingerprints, never transcript text or raw paths/IDs. See [on-disk privacy](privacy.md#local-index).

Previously indexed sessions survive provider cleanup and carry `transcript.sourceDeleted: true`; their facts and prices remain those of their last successful ingest. Prune removes sessions whose last observed event is **strictly before UTC midnight** on the given date and keeps a retention floor for future indexed scans. It does not delete provider files. Rebuild resets that floor and discards retained history that no longer has source evidence. An unreadable index fails with a fixed error; rebuild recovers it, while `--no-index` bypasses it. A corrupt database is quarantined privately during recovery; quarantine files are not part of the active index.

Pruned sources keep only keyed exclusion checkpoints, so unchanged files skip session parsing; new activity can re-enter. Event extrema are compared as UTC instants. Legacy dates that cannot be verified are kept until their sources can be read again. Key mismatches fail an integrity check before selecting history, and rebuild also repairs damaged writer coordination. The dashboard shows filtered retention counts and frozen-pricing notes and excludes historical working observations from live snapshots. Direct machine and repository analyzer calls share the same visibility default.

## Subscription limits

```sh
session-analytics limits                 # harvest meters and print each with its reset and projection
session-analytics limits --json          # content-free limits snapshot
session-analytics limits --quiet         # harvest only, for cron: */20 * * * * session-analytics limits --quiet
session-analytics limits statusline      # Claude Code status line: records stdin rate_limits, prints them
session-analytics limits --no-codex-account  # skip the banked-reset read through the local Codex app-server
```

Readings come from Codex session `rate_limits` records, Claude Agent SDK `rate_limit_event` records in host event logs (`SESSION_ANALYTICS_CLAUDE_EVENT_LOGS` overrides the T3 Code default), and status-line input. They are kept in `limits.json` in the data directory; `--no-index` neither reads nor writes it. See [Subscription limits and value](subscription.md).

## MCP server and agent skill

```bash
session-analytics mcp
```

The MCP server speaks stdio and exposes six read-only tools: usage summaries, budget status, repository profiles, tool statistics, recent sessions, and same-repository agent comparisons. It defaults to the launch repository and caches snapshots for 60 seconds. Every result includes source health and interpretation notes; budget periods carry their own pricing coverage, and typical-session baselines exclude active or unknown lifecycle evidence. No transcript content is exposed. See [MCP setup for Claude Code, Codex and Cursor](mcp.md), or try `node scripts/demo.ts mcp` with an MCP client against synthetic data.

The package and the repository ship an agent skill at [`skills/session-analytics`](../skills/session-analytics/SKILL.md). Copy or symlink it into a skills directory your agent reads, either in a project or in your home directory:

```bash
SKILL="$(npm root -g)/session-analytics/skills/session-analytics"   # npm or release tarball install
# SKILL="$(brew --prefix session-analytics)/libexec/lib/node_modules/session-analytics/skills/session-analytics"   # Homebrew
# SKILL="$PWD/skills/session-analytics"   # source checkout

# Claude Code
mkdir -p ~/.claude/skills
ln -s "$SKILL" ~/.claude/skills/session-analytics

# Codex and other agents that read .agents/skills
mkdir -p ~/.agents/skills
ln -s "$SKILL" ~/.agents/skills/session-analytics
```

Then ask, for example, "open my session analytics" or "compare agent usage across my repositories". The skill runs `session-analytics` (or `node bin/session-analytics.ts` in a source checkout when the command is not on `PATH`), reports the dashboard URL, session and repository counts, pricing coverage, and warnings, and keeps API-equivalent and provider-reported values separate. It uses `report` or `report --json` only when you ask for terminal or machine-readable output.

## Options

| Option | Applies to | Description |
| --- | --- | --- |
| `--no-open` | dashboard | Start the server without opening a browser. |
| `--port PORT` | dashboard | Loopback port, 1024 to 65535. Default `4174`, or `CONDUCTOR_PORT + 4` inside a Conductor workspace. |
| `--json` | report, rates, index status | Print structured JSON instead of text; for `report`, the versioned content-free snapshot. |
| `--share` | report | Preview aggregate-only JSON with pseudonymized repositories and a minimum of five sessions per bucket. |
| `--snapshot FILE` | dashboard, report, export | Read a validated snapshot file instead of scanning provider stores. |
| `--repo-name NAME` | both | Narrow to one uniquely named repository. |
| `--repo-root PATH` | both | Narrow to the repository whose canonical root is `PATH`. |
| `--repo-remote URL` | both | Narrow by Git remote. Remotes are discovered from Git and provider metadata, with optional Conductor enrichment. |
| `--repo-id ID` | both | Narrow to one repository ID from a previous snapshot. |
| `--exclude-hidden` | both | Leave out repositories and sessions hidden in Conductor. Hidden records are included by default. |
| `--claude-root PATH` | both | Read only this Claude Code `projects` directory instead of discovering profiles. |
| `--codex-root PATH` | both | Read this Codex `sessions` directory instead of discovering profiles. |
| `--codex-archive-root PATH` | both | Read this Codex `archived_sessions` directory. Passing either Codex option replaces Codex discovery, so pass both to include archives. |
| `--cursor-database PATH` | both | Cursor `state.vscdb` to read. |
| `--cursor-sdk-root PATH` | both | Conductor's Cursor SDK store directory. |
| `--cursor-transcript-root PATH` | both | Cursor's `projects` directory containing `agent-transcripts`. |
| `--copilot-root PATH` | both | Copilot CLI's `session-state` directory. |
| `--opencode-database PATH` | both | OpenCode's `opencode.db`. |
| `--gemini-root PATH` | both | Gemini CLI's `tmp` directory containing project `chats` directories. |
| `--no-additional-providers` | both | Disable discovery of those five additional stores; explicit new-store paths still apply. Conductor result fallback follows `--database`. |
| `--database PATH` | both | Conductor database to use for optional enrichment. |
| `--rate-card PATH` | dashboard, report, export, rates, index rebuild, mcp | Pin an alternative reviewed rate card; bypass cached API prices and automatic pricing refresh. |
| `--offline` | dashboard, report, export, rates, index rebuild, mcp | Disable public pricing requests; retain access to cached prices. |
| `--data-dir PATH` | dashboard, report, export, rates, index, mcp | Private index, pricing cache and settings directory. |
| `--pricing-policy MODE` | dashboard, report, export, rates, index rebuild, mcp | `reviewed-first` (default), `api-first`, or `reviewed-only`. |
| `--pricing-sources LIST` | dashboard, report, export, rates, index rebuild, mcp | Ordered public sources; default `models.dev,litellm`. |
| `--pricing-max-age-days DAYS` | dashboard, report, export, rates, index rebuild, mcp | Stale threshold, default `7`; `0` checks on every dashboard startup. |
| `--no-index` | both | Read present provider evidence without accessing the index; also `SESSION_ANALYTICS_NO_INDEX=1`. |
| `--time-zone ZONE` | dashboard, report, export, index rebuild, mcp | IANA time zone for activity days and hours, such as `Europe/London`. Default: `TZ`, then the system zone. |
| `--remote HOST[,HOST]` | dashboard, report, export | Also read these machines over SSH and combine them with this one. Each needs session-analytics installed; see [combine machines](interop.md#combine-machines). Cannot be combined with `--snapshot`, repository filters or `--rate-card`. |
| `--remote-command CMD` | dashboard, report, export | Words that start session-analytics on the remote machines. Default `session-analytics`; for example `sudo -n -iu agents session-analytics`. |
| `--no-remote` | dashboard, report, export | Scan only this machine, ignoring `SESSION_ANALYTICS_REMOTE` and `SESSION_ANALYTICS_REMOTE_COMMAND`. Cannot be combined with `--remote`; always used for fetched reports. |
| `--portable-ids` | dashboard, report, export, mcp | Give every repository with a Git remote the remote-derived ID, including repositories registered in Conductor, so snapshots from several machines name the same repository identically. Output only; the index keeps local IDs. |
| `--version`, `--help` | all | Print the version or command help. |

"Both" means the dashboard and `report` commands. `export`, `rates` and `mcp` accept the same source, repository and pricing options (`--remote` applies to the dashboard, `report` and `export` only); `index rebuild` accepts the source, time-zone and pricing options but not repository filters; `merge` accepts only `--out`. Incomplete primary transcripts are labeled partial and retain observed counters and independent provider durations.

## Environment variables

The analysis settings and the dashboard port can also be set with `SESSION_ANALYTICS_*` environment variables, named after the flag; a command-line option wins over the environment. Dashboard: `SESSION_ANALYTICS_PORT`. Source paths: `SESSION_ANALYTICS_CLAUDE_ROOT`, `SESSION_ANALYTICS_CODEX_ROOT`, `SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT`, `SESSION_ANALYTICS_CURSOR_DATABASE`, `SESSION_ANALYTICS_CURSOR_SDK_ROOT`, `SESSION_ANALYTICS_CURSOR_TRANSCRIPT_ROOT`, `SESSION_ANALYTICS_COPILOT_ROOT`, `SESSION_ANALYTICS_OPENCODE_DATABASE`, `SESSION_ANALYTICS_GEMINI_ROOT` and `SESSION_ANALYTICS_CONDUCTOR_DATABASE`. Repository filters: `SESSION_ANALYTICS_REPO_ID`, `SESSION_ANALYTICS_REPO_NAME`, `SESSION_ANALYTICS_REPO_REMOTE` and `SESSION_ANALYTICS_REPO_ROOT`. Machines: `SESSION_ANALYTICS_REMOTE`, `SESSION_ANALYTICS_REMOTE_COMMAND`, `SESSION_ANALYTICS_TIME_ZONE` and `SESSION_ANALYTICS_PORTABLE_IDS=1`; `--snapshot` ignores the remote settings. Pricing and storage: `SESSION_ANALYTICS_RATE_CARD`, `SESSION_ANALYTICS_PRICING_POLICY`, `SESSION_ANALYTICS_PRICING_SOURCES`, `SESSION_ANALYTICS_PRICING_MAX_AGE_DAYS`, `SESSION_ANALYTICS_DATA_DIR`, `SESSION_ANALYTICS_OFFLINE=1` and `SESSION_ANALYTICS_NO_INDEX=1`. `SESSION_ANALYTICS_CODEX_ACCOUNT=0` turns off the banked-reset read (same as `--no-codex-account` on the dashboard and `limits`; `--offline` also skips it); `SESSION_ANALYTICS_CODEX_BIN` names the Codex binary. `SESSION_ANALYTICS_CLAUDE_EVENT_LOGS` lists directories of Claude Agent SDK event logs for limit meters. Set `SESSION_ANALYTICS_ADDITIONAL_PROVIDERS=0` to disable discovery of the five additional stores. Output flags such as `--no-open`, `--json`, `--share`, `--snapshot` and `--exclude-hidden` are command-line only.

Profile discovery honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME`; OpenCode also honors `XDG_DATA_HOME`. Each source override replaces only that source's default; isolated scans should supply all desired paths and disable additional discovery. The demo does this automatically. `--time-zone` (or `TZ`) selects the analysis timezone.

## Demo and developer scripts

```bash
npm run demo                      # synthetic dashboard on http://127.0.0.1:4175
npm run demo -- report            # terminal report of the same data
node scripts/demo.ts mcp          # MCP server over the synthetic data
```

The demo generates about 60 days of synthetic sessions for six fictional repositories in a temporary directory, points every source option at that directory, and deletes it on exit. It never reads real history. Every screenshot in this repository is rendered from it. `--bin PATH` (or `SESSION_ANALYTICS_DEMO_BIN`) runs the same data through another build, such as the `bin/session-analytics.js` of an installed package, and `SESSION_ANALYTICS_DEMO_NOW=<ISO 8601 instant>` generates the data as of that instant, so two runs analyze the same sessions. `node scripts/smoke-installed.ts TARBALL` uses both to compare a packed release, installed into a temporary prefix, with the checkout.

Developers can run `node scripts/parity.ts --machine` to compare full, cold-index and warm-index accounting. It uses the 1024 MB analysis worker, offline pricing, a fresh private index under `.lane/`, and the shared real-scan lock. Output contains month/provider totals and differences by hashed session key, never repository names or transcript content. Live source changes are reported separately and do not suppress the unfiltered diff or a failing exit status. Use `--demo-root PATH` with a retained synthetic demo for repeatable local checks.

Release verification uses `node scripts/verify-real.ts`: independent provider, repository, pricing and time oracles, with recorded source generations and explicit live-session exclusions. See the [verification guide](../verify/README.md) for evidence files and saved-artifact rechecks.
