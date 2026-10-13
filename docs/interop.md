# Snapshots, exports, and sharing

These commands work on the existing allowlisted snapshot. They do not read new kinds of transcript content. CSV, NDJSON, JSON downloads, sharing previews, merges, and snapshot dashboards are local operations. Only an explicit `export --otlp-endpoint URL` sends a network request, and only an explicit `--remote` runs `ssh` to read another machine's snapshot.

## Versioned snapshots

```bash
session-analytics report --json > snapshot.json
session-analytics --snapshot snapshot.json --no-open
session-analytics report --snapshot snapshot.json
```

The machine snapshot and single-repository analysis result carry `schemaVersion: 1`. The published [JSON Schema](../schemas/snapshot.v1.schema.json) uses Draft 2020-12. Schema versions describe the interchange shape, independently of the package version. Changes to the shape require updating the checked field maps in `scripts/snapshot-schema.ts`, regenerating the JSON, and reviewing compatibility. Incompatible changes need another schema version; the v1 loader rejects unknown versions and unknown fields, including nested fields. One exception keeps older files readable: snapshots written before the analysis namespaces were removed may still carry machine `limitsCache`, `outcomes` and `workflow`, repository `outcomes`, session `reliability`, `limitsCache`, `outcomes`, `workflow`, `insightSignals`, `skills` and `skillEvidence`, and session `mcpEvidence.toolOutcomes`, `rateLimits` and `truncated`. These removed fields are dropped on load, never validated or returned; every remaining field is still validated.

`--snapshot` bypasses provider discovery and analysis environment settings. Explicit analysis flags cannot be combined with it. Refresh re-reads the same file. Invalid files return a fixed error and never trigger a scan. A file dashboard refuses to reuse an occupied port, since that server could be displaying another snapshot. A live launch also refuses to reuse a file dashboard; `/api/health` exposes a fixed `dataSource: "live" | "snapshot"` discriminator, a random per-launch token and a normalized analysis-options hash, never the filename or option values. Live port reuse requires matching options and a token matching the private data-directory file. Full and shared snapshots are accepted; shared snapshots have a separate aggregate view without fabricated sessions or charts. View, window and provider shortcuts leave that view intact, the wordmark links to the shared aggregates, and the command palette omits view and repository navigation.

Files must be regular files, not symlinks, and at most 256 MiB. Schema traversal is limited to 20 million nodes and depth 40. These bounds accommodate the complete v0.6.0 projection; explicit OTLP delivery retains its separate 64 MiB payload limit. Loading checks hashed repository/session key syntax, fixed status labels and warning templates, bounded identifiers, unique keys, calendar-valid timestamps, repository references, and every daily/model/tool rollup against the sessions. Counters must be safe nonnegative integers. Token classes, model/session totals, tool counts, cost components, execution costs, daily values, and pricing coverage must reconcile. Cursor retains its separate reported-cost semantics: no invented model tokens or daily cost attribution. The bounded dependency-free validator implements only the vocabulary in the shipped schemas. Malformed or private strings in known public fields fail closed before the API, report, export, or collector sees them. Syntax cannot certify the provenance of repository display names or otherwise valid model/tool identifiers: import snapshots from a source you trust. Unknown Conductor agent names become the fixed `unsupported` provider, with unavailable cost and unsupported evidence; their raw names never leave the parser. Registered Cursor rows without usable evidence retain `cursor` with unsupported evidence. Neither counts toward the sharing threshold. Full snapshots retain repository display names and session keys; they are not the sharing format.

## Export files

```bash
session-analytics export --format csv --out ./export-csv
session-analytics export --format ndjson --out ./export-ndjson
session-analytics export --format otlp-json --out ./export-otlp
# Reuse a scan, with identical evidence across formats:
session-analytics export --snapshot snapshot.json --format csv --out ./saved-csv
```

`--format` and `--out` are required. The normal analysis flags and environment settings work when no snapshot file is supplied. Export creates missing directories with mode 0700 and files with mode 0600. It refuses existing destination files, including symlinks. A failed batch removes only files it created; earlier exports remain intact. The output directory should be private and under your control. Nothing is written to provider stores.

| File | Grain and meaning |
| --- | --- |
| `sessions.csv` | One session, flattened tokens, costs, cost basis, pricing coverage, timestamps, execution/evidence labels, and execution counters. |
| `daily.csv` | The activity ledger: repository × provider × activity day in the snapshot's declared timezone (`velocity.timeZone`), with API-equivalent and provider-reported value (session-dated receipt value included) and contributing-session count. Only evidenced value dates appear; Cursor database totals are not assigned invented dates. |
| `models.csv` | Repository × provider × cost basis × model, with contributing sessions, calls, priced flag, token classes, and cost components. Cursor model costs do not establish model-level token attribution. |
| `tools.csv` | Repository × provider × tool name, with effective calls and contributing sessions. Like the Tools view, it includes only parsed sessions with observed tool evidence (legacy snapshots without evidence labels remain eligible) and finite, positive call counts. |
| `snapshot.ndjson` | First a `kind: "snapshot"` header with generation time, rate card, summary, and warnings; then `kind: "repository"` rollups and `kind: "session"` records. Every record carries `schemaVersion: 1`. Empty scans still have a header. |
| `otlp-logs.json` | One OTLP `ExportLogsServiceRequest`; one content-free log record per observed session. |

CSV is UTF-8 with a header and CRLF record separators; quotes and multiline values are escaped. Text beginning like a spreadsheet formula is prefixed with an apostrophe, so importing it cannot execute a formula. Null values are empty cells; they never become numeric zero. These files use existing field names and units. `totalUsd` and daily value are API-equivalent or provider-reported usage value as labeled, never an invoice. Token counts do not measure unique text or successful work.

The dashboard's **Export view** menu downloads JSON or any individual CSV directly in the browser. It applies repository and date selection and the active view's provider selection: the daily chart's provider toggles on Summary, the provider chips on Velocity, and the Activity and Tools filters; Costs and Pricing have none. The menu shows the resulting session count and states each file's value basis. For JSON and the sessions, models and tools CSVs, dates select **whole sessions by their start date** in the snapshot's declared timezone, matching session counts; unknown starts are excluded from a bounded window. Offset-free database timestamps mean UTC; ingestion emits UTC timestamps with milliseconds. The daily value CSV is instead the activity ledger of the repository and provider scope over the selected dates, whatever each session's start, so it adds up to the dashboard's usage value for the window (see [metrics](metrics.md#one-money-ledger)). The current snapshot stays exportable while a refresh runs. All JSON summaries and rollups are recomputed with the same checked implementation used by the analyzer, and the result can be reopened with `--snapshot`. Validated discovery failures survive every selection, including an empty one; selection-dependent coverage notes are regenerated. The filtering note is appended. Opening the menu binds its preview to the download; loading, refresh, and scope changes (including keyboard provider toggles) close and invalidate it. Downloads recheck the selection description and ask you to reopen Export if it has changed. Shared dashboards download only the existing shared JSON or an aggregate CSV. Downloads do not upload data or change the strict CSP.

## Sharing preview

```bash
session-analytics report --share > shared.json
session-analytics report --share --min-sessions 10 > shared-k10.json
session-analytics report --share --snapshot snapshot.json > shared-from-file.json
```

`report --share` always prints JSON, with or without `--json`. Stdout is the **complete payload to review**; stderr identifies it as a preview. The command does not transmit it. Inspect the file, then choose your own way to share it. Its [separate schema](../schemas/shared.v1.schema.json) identifies it with `kind: "shared"` and `schemaVersion: 1`.

The default minimum is **five distinct provider/session keys per repository bucket**; `--min-sessions` can set any integer at least two. Only sessions with parsed evidence (`transcript.status: "ok"`) count. **Totals are observed lower bounds and may include running and partially parsed sessions. Pricing coverage measures rates for observed tokens, not evidence completeness.** This applies to shared files and merges as well as the adjacent CLI/dashboard caveat. No active/partial subset count is released, avoiding an additional small-group disclosure. Alias grouping happens before the threshold, so aliases can deliberately join local roots for one logical project. Below-threshold buckets disappear completely. Summary totals include only retained buckets. No suppressed count, omitted total, daily/provider/model/tool breakdown, timestamp, warning, rate-card link, original name, or session key is included.

Each repository gets an HMAC-SHA256 pseudonym, truncated to 128 bits. The 32-byte random machine key is kept in `$XDG_STATE_HOME/session-analytics/sharing.key`, or `~/.local/state/session-analytics/sharing.key` by default. It is created with mode 0600; public permissions, wrong length, and symlinks are rejected. `--share-key-file FILE` or `SESSION_ANALYTICS_SHARE_KEY_FILE` selects another private key file. The key is never included in the output. Keep one key per contributing installation: rotating it changes both repository pseudonyms and the source identity used to detect repeated contributions.

For cross-machine repository matching, agree on explicit aliases:

```json
{
  "discovered-0123456789abcdef0123": "project-alpha",
  "conductor-abcdef0123456789abcd": "project-beta"
}
```

```bash
session-analytics report --share --share-aliases aliases.json > shared.json
```

Keys are repository IDs from a local full snapshot; values use 1–64 letters, digits, dots, underscores, or hyphens and must start with a letter or digit. Output labels become `alias-project-alpha`. Unmapped repositories remain keyed pseudonyms. Unknown IDs fail rather than silently ignoring an alias. Aliases are intentional identifying metadata: choose neutral labels and inspect the preview.

**The threshold counts sessions, not people.** This is minimum-count suppression, not differential privacy or a guarantee of anonymity. A bucket can contain one person's sessions; distinctive totals, aliases, repeated releases, and outside knowledge can identify activity. There is no protection against comparing repeated overlapping previews. Publish a single reviewed contribution per source for a team comparison, and avoid releasing increasingly narrow cuts. Model, tool, and time breakdowns are deliberately absent to avoid small intersection groups and subtraction attacks within one payload.

## Merge shared snapshots

```bash
session-analytics merge alice-shared.json bob-shared.json --out team.json
session-analytics --snapshot team.json --port 4180 --no-open
```

Merge accepts shared snapshots only, requires the same minimum threshold, sums additive counters, and validates the declared summaries. Identical labels combine; independent keyed pseudonyms stay separate. Pricing coverage is `pricedTokens / priceableTokens`, computed from the combined counters, never an average of percentages. Zero priceable tokens means N/A. Cursor provider-reported value stays separate from API-equivalent value.

Every nonempty contribution includes a domain-separated keyed `sources[]` identifier. Merge rejects any repeated source, including one already present in a previous merge. This conservatively rejects repeated scans from the same key even when their periods are disjoint: without session identifiers or times, overlap cannot be established safely. Do not use key rotation to bypass the check. Source IDs are linkable pseudonyms, not authenticated identities. The merger cannot detect dishonest files, independently copied transcripts on different machines, or regenerated keys. Empty contributions reveal no source identity and have all-zero totals. `--out FILE` creates a new private file; without it JSON goes to stdout. Merge never uploads.

## Combine machines

Agents that run on another computer, such as a server, a VM or a T3 Code host, write their history there. `--remote` reads those machines over SSH and shows them with this one; snapshot files do the same without SSH.

### Over SSH

```bash
session-analytics --remote server                     # dashboard: this machine and server
session-analytics report --remote server,build-box    # terminal report of all three
session-analytics --remote server --remote-command "sudo -n -iu agents session-analytics"
```

Install session-analytics on each remote machine (Node.js 24 and a checkout, as here) so that `ssh server session-analytics --version` works without a prompt. For each machine, this machine runs

```text
ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -T -- server \
  session-analytics report --json --no-remote --portable-ids --time-zone <this machine's zone> [forwarded switches]
```

and validates the reply like an imported file before combining it with the local scan (see below). The local scan and every remote read run at the same time, and **Refresh snapshot** reads every machine again. `--remote` applies to the dashboard, `report` (including `--share`) and `export`; MCP and index commands stay local.

- **What crosses the network.** The command line goes out: the remote command, fixed report flags, this machine's time zone name and the forwarded switches. Only the remote machine's content-free snapshot comes back. Each machine reads its own transcripts and keeps its own private index, so its history survives provider cleanup there. Remote snapshots stay in memory here; nothing from them enters this machine's index.
- **Authentication** is your SSH configuration: host aliases, keys, agents and jump hosts all work. `BatchMode` turns password and host-key prompts into failures instead of a hanging dashboard.
- **Forwarded switches:** `--offline`, `--no-index`, `--exclude-hidden`, `--no-additional-providers` and the pricing policy, sources and age. Source paths, `--data-dir` and `--database` describe this machine and stay here. Repository filters and `--rate-card` cannot be combined with `--remote`.
- **Another account.** When agents run as a different user on the remote machine, start session-analytics as that user, for example `--remote-command "sudo -n -iu agents session-analytics"` (this needs passwordless sudo for that command). Destinations and command words are limited to letters, digits and `_./~@%+=:,-`, so neither can smuggle shell syntax.
- **When a machine cannot be read** (no route, refused login, missing command, an older version that rejects the flags, no reply within 300 seconds, or output that is not a snapshot), the dashboard and report still show the other machines. This terminal names the machine with a fixed reason and the last line ssh or the remote printed; the snapshot carries a fixed warning. Run the same session-analytics version on every machine.

`SESSION_ANALYTICS_REMOTE` and `SESSION_ANALYTICS_REMOTE_COMMAND` set the same options for every launch. `--no-remote` ignores both and scans only this machine; it cannot be combined with `--remote`. Every fetched report uses `--no-remote`, so a destination's environment cannot trigger reads of further machines. A saved snapshot (`--snapshot`) never scans, so it ignores them.

### From files

Without SSH, create a full snapshot on each machine and merge them:

```bash
# On each machine, in the same time zone:
session-analytics report --json --portable-ids --time-zone Europe/London > laptop.json
# Copy the files to one place, then:
session-analytics merge laptop.json server.json --out machines.json
session-analytics --snapshot machines.json
```

Merge decides by content: all shared snapshots merge as above, all full snapshots combine, and a mixture is refused.

### How snapshots combine

Combining full snapshots, over SSH or from files, keeps every session and its details:

- **Sessions** are unioned by provider and session key. With `--portable-ids`, Claude and Codex registrations with a known provider session ID use the same key as their discovered transcripts, so a copy on a machine without Conductor counts once. Legacy registrations without a provider identity and other providers keep their keys. A session found on more than one machine (copied history, or the same file twice) is counted once, from the copy with the later last activity, then more model requests, and the snapshot carries a fixed warning.
- **Repositories** are unioned by ID; the first file that lists an ID names it. `--portable-ids` makes remote-backed IDs agree: a repository with a Git remote takes the ID discovery derives from that remote, even when Conductor registered it under its own ID. Without the flag, a Conductor repository on one machine and the same remote on another appear twice. Discovered local Git repositories use the hostname and Git root to keep identical paths on different machines distinct. Shared unassigned groups and Conductor repositories without a remote keep their existing IDs.
- **Rollups**, coverage warnings, and history-coverage months are recomputed from the combined sessions and profiles. Each input is treated as its own machine: the first input's Claude profile keys are kept, and later collisions receive deterministic machine-qualified keys, also rewritten on that input's sessions. Profile ordinals are unique and sequential. Merging the same file twice counts its profile statistics twice, while its sessions count once and carry the duplicate warning. Recovery calibration comes from the first file that has one, because its ratios cannot be pooled.
- **Rates**: each machine priced its own sessions with its own cache. The combined rate card lists every model once, first file first.
- **Time zones** must match by metadata version and zone, independent of JSON property order; two inputs without zone metadata also match. Activity days and hours are local to the analysis zone. Merge refuses files with different zones; create them with the same `--time-zone`.
- **Generation time** is the latest input timestamp, compared as an instant, so newer machines' activity remains selectable in the dashboard.
- **Retained history** keeps its local identity. Portable IDs and session keys are derived from live evidence, so once a local-only repository's transcripts or a Conductor registration are deleted, the history the index retains falls back to that machine's local repository ID or session key. Combine snapshots taken at about the same time: an old export merged with a new one from the same machine can show such a repository twice or count such a session twice.

Full snapshots keep repository display names and session keys, so combine only machines you control. Use `report --share` to compare with other people.

## OpenTelemetry mapping

The GenAI attribute mapping is pinned to **semantic-conventions 1.37.0**, commit [`aec6e9d3e86754683dab7c707655d69d953b2768`](https://github.com/open-telemetry/semantic-conventions/tree/aec6e9d3e86754683dab7c707655d69d953b2768/docs/gen-ai). That revision labels GenAI conventions Development. The pin is intentional; it is not a claim to track the latest evolving convention. The wire envelope follows [OTLP JSON Protobuf encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding).

This is an OTLP **log export of session aggregates**, not standard GenAI inference spans or per-request token histograms. Session summaries cannot recover the original request timing, model invocation distribution, server identity, or trace relationships. Each log has a fixed body, the snapshot time as decimal nanoseconds, and these attributes:

| Attributes | Mapping |
| --- | --- |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | Authoritative session totals; input includes caches, output includes reasoning. Encoded as decimal `intValue` strings. |
| `gen_ai.response.model` | Only when exactly one known model accounts for all of the session's token counters. Omitted for mixed or unattributable usage. |
| `session_analytics.provider`, `.repository.key`, `.session.key` | Agent provider enum and existing pseudonymous local keys. Repository display names are omitted. |
| `session_analytics.record.type` | Always `session_aggregate`. |
| `session_analytics.cost.basis`, `.transcript.status` | Existing enums for interpretation and evidence coverage. |
| `session_analytics.usage.cache_read_tokens`, `.cache_write_tokens`, `.reasoning_tokens` | Subsets of the input/output totals; never add them again. |
| `session_analytics.tool.calls`, `.model.calls` | Observed effective calls. |
| `session_analytics.usage.value_usd`, `.upper_value_usd` | Labeled usage value and upper estimate, not invoice charges. |
| `session_analytics.pricing.coverage` | Existing ratio; omitted if N/A. Its denominator is input + output tokens for this session. |
| Resource `service.name`, `session_analytics.schema.version` | Neutral service ID and snapshot version. |
| Scope `name`, `version`, `.semconv.version`, `.semconv.commit`; `schemaUrl` | Exporter package and pinned convention identifiers. The last two attributes use the `session_analytics` prefix. |

`gen_ai.provider.name` is omitted because an agent name does not establish the actual API endpoint/vendor. `gen_ai.operation.name`, raw conversation/request IDs, content attributes, tool arguments/results, hostnames, paths, trace/span IDs, and inferred outcomes are also omitted. The collector should route these custom aggregate logs separately from inference-call telemetry. Re-exporting overlapping snapshots repeats observations, so summing every import would double-count.

Local file output is the default. To send **the saved bytes** to a collector:

```bash
session-analytics export --snapshot snapshot.json --format otlp-json --out ./collector-export \
  --otlp-endpoint http://127.0.0.1:4318/v1/logs
```

The URL is the full logs endpoint, including any custom path. Remote endpoints require HTTPS; loopback HTTP is allowed. Embedded credentials and URL fragments are rejected. No `OTEL_*` environment variable activates networking. There is one POST with JSON content type, a 10-second timeout, a 64 MiB request limit, and a 64 KiB acknowledgement limit. Redirects and automatic retries are disabled. Rejected records, collector warnings, malformed acknowledgements, timeouts, and HTTP failures return nonzero status without echoing response text. The saved file remains; a failure can mean delivery happened but acknowledgement was lost. Inspect the collector before manually resending. No authentication/header CLI is provided in v1; use a local authenticated collector or proxy when needed.

## Development checks

```bash
node scripts/snapshot-schema.ts          # regenerate after a reviewed type change
node scripts/snapshot-schema.ts --check  # fail on generated schema drift
npm run check
```

The test suite covers fixture/schema parity, privacy sentinels, CSV quoting and injection, empty exports, filter totals, suppression boundaries, private key persistence, aliasing, merge conflicts, bounded file reads, no-overwrite writes, dashboard file refresh, OTLP field mapping, and a loopback collector including redirects and partial acknowledgement. No real history is used for test fixtures or screenshots.

The v1 contract shipped in 0.6.0. These corrections keep version 1; regenerate older files containing formerly accepted raw warning/status strings or inconsistent evidence. When merging provider/metric lanes, extend the closed schema and privacy manifest atomically, preserve optional fields as optional, and add filtered-export reconciliation coverage.
