# Snapshots, exports, and sharing

These commands work on the existing allowlisted snapshot. They do not read new kinds of transcript content. CSV, NDJSON, JSON downloads, sharing previews, merges, and snapshot dashboards are local operations. Only an explicit `export --otlp-endpoint URL` sends a network request, and only a machine saved with `machines add`, or an explicit `--remote`, makes it run `ssh` to read another machine's snapshot.

## Versioned snapshots

```bash
session-analytics report --json > snapshot.json
session-analytics --snapshot snapshot.json --no-open
session-analytics report --snapshot snapshot.json
```

The machine snapshot and single-repository analysis result carry `schemaVersion: 1`. The published [JSON Schema](../schemas/snapshot.v1.schema.json) uses Draft 2020-12. Schema versions describe the interchange shape, independently of the package version. Changes to the shape require updating the checked field maps in `scripts/snapshot-schema.ts`, regenerating the JSON, and reviewing compatibility. Incompatible changes need another schema version; the v1 loader rejects unknown versions and unknown fields, including nested fields. A snapshot that [combines machines](#machine-status) adds three optional fields: the `machines` list, each session's `machine` key and each Claude profile's `machine` key. A single machine's snapshot does not carry them and is unchanged, so files written by earlier versions still load; a combined snapshot is refused by versions before these fields. One exception keeps older files readable: snapshots written before the analysis namespaces were removed may still carry machine `limitsCache`, `outcomes` and `workflow`, repository `outcomes`, session `reliability`, `limitsCache`, `outcomes`, `workflow`, `insightSignals`, `skills` and `skillEvidence`, and session `mcpEvidence.toolOutcomes`, `rateLimits` and `truncated`. These removed fields are dropped on load, never validated or returned; every remaining field is still validated.

`--snapshot` bypasses provider discovery and analysis environment settings. Explicit analysis flags cannot be combined with it. Refresh re-reads the same file. Invalid files return a fixed error and never trigger a scan. A file dashboard refuses to reuse an occupied port, since that server could be displaying another snapshot. A live launch also refuses to reuse a file dashboard; `/api/health` exposes a fixed `dataSource: "live" | "snapshot"` discriminator, a random per-launch token, a normalized analysis-options hash and the tool version, never the filename or option values. Live port reuse requires the same version, matching options and a token matching the private data-directory file. Full and shared snapshots are accepted; shared snapshots have a separate aggregate view without fabricated sessions or charts. View, window and provider shortcuts leave that view intact, the wordmark links to the shared aggregates, and the command palette omits view and repository navigation.

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

Agents that run on another computer, such as a server, a VM or a T3 Code host, write their history there. Save each such machine once; from then on a plain `session-analytics`, `report` and `export` read it over your own SSH together with this one:

```bash
session-analytics machines add agentbox --user agent-t3   # agents run as agent-t3 on the host agentbox
session-analytics                                         # this machine and agentbox, every time
```

`agentbox` is any SSH destination your `ssh` reaches without a prompt: a host alias from `~/.ssh/config`, `user@host` or `ssh://user@host:port`. `--user agent-t3` names the account whose history is read there, for agents that run as their own user; without it, the account you log in as is read. That account needs Node.js 24 or later on its login `PATH` and nothing else, because session-analytics brings its own code ([the bundled runtime](#the-bundled-runtime)). Snapshot files combine machines [without SSH](#from-files).

### Save a machine

`machines add` connects first and runs the same checks as [`machines check`](#check-a-machine), each with its fix:

```text
$ session-analytics machines add agentbox --user agent-t3
agentbox  (ssh agentbox, as agent-t3, bundled runtime)
  ✓ ssh       connected in 0.1 s without a prompt
  ✓ sudo      sudo -n -iu agent-t3 works without a password
  ✓ node      v24.21.0 (needs 24 or later)
  ✓ machine   not this machine, and not saved under another name
  ✓ runtime   0.9.0+09867a9b installed now (434 KB in 0.4 s)
  ✓ history   741 sessions, 11 repositories in 19.6 s

The bundled runtime is this session-analytics 0.9.0, copied into agent-t3's ~/.cache/session-analytics/runtime on agentbox and run there; use --runtime installed to run your own install instead.

Saved agentbox. A plain session-analytics now reads this machine and agentbox.
```

It refuses a machine it cannot log in to, an account that does not exist there (and lists the accounts with agent history instead), this machine itself, and a machine and account already saved under another name; while adding, those fixes name `machines add`, never a machine that was not saved. Any other failure is saved with its fix, and the last line says `Saved NAME, but it cannot be read until this is fixed: …` instead of `now reads`, so a machine that is not ready yet can still be added. When the account read has no agent history, `add` looks for the accounts that do and names them in its fix. `--no-check` saves without connecting, `--find-users` lists accounts with history as `check` does, and `--name LABEL` chooses the label (default: the host name up to its first dot, or a whole IP address with `-` for its dots, such as `192-168-1-20`).

```bash
session-analytics machines list [--json]
session-analytics machines check [NAME...] [--find-users] [--json]
session-analytics machines set NAME [--ssh DEST] [--user NAME | --no-user] [--no-login-shell | --login-shell] [--node PATH] [--runtime bundled|installed] [--command WORDS] [--enable | --disable]
session-analytics machines rename NAME LABEL     # rename local LABEL labels this machine
session-analytics machines remove NAME
```

- **The saved file** is `machines.json` in the private data directory, mode `0600` and replaced atomically. It holds labels, SSH destinations, account names, how to start session-analytics there, and a 16-digit hash of each machine's ID and account, which `check` records so the same machine cannot be saved twice under different names. A file with an unknown field, version or value is refused, never repaired or partly read. Every `machines` command changes it under a lock (`machines.json.lock`, broken after 30 seconds) from the file as it is at that moment, so a `check` that runs for minutes never undoes an `add` or `set` made meanwhile.
- **`--user NAME`** reads as that account through `sudo -n -iu NAME`, which needs passwordless sudo to that account ([below](#when-sudo-needs-a-password)). Labels, destinations, account names and node paths are validated words, so none can smuggle shell syntax.
- **`--no-login-shell`** reads such an account with `sudo -n -H -u NAME` instead, for a service account whose shell is `nologin` or `false` and refuses the login shell `-i` starts (`check` names that failure and this fix). Without a login shell, nothing from that account's profile applies: `node` is found on sudo's own `PATH` (`secure_path`), or named with `--node /usr/bin/node`.
- **Which machines a run reads**, first match wins: `--no-remote` reads none; `--remote` reads its own list for this run ([advanced](#advanced-ad-hoc-machines-with---remote)); the deprecated `SESSION_ANALYTICS_REMOTE` does the same for every launch; otherwise every enabled saved machine. `--machines a,b` narrows a run to those saved machines, disabled ones included, and `machines set NAME --disable` leaves one out until `--enable`. Repository filters and `--rate-card` describe this machine only, so saved machines step aside for them with a notice; with `--remote` or `--machines` they are refused.
- **The dashboard** follows `machines.json`: `add`, `set`, `rename` and `remove` reach a running dashboard on its next request, which reads the machines again and rebuilds its snapshot from this machine's last scan, and a plain `session-analytics` afterwards reuses it. A dashboard started with `--remote`, `--no-remote` or the deprecated variable keeps the machines it was started with; a launch that differs from it only in its machines says so (`already running on this port with other machines`).

### When sudo needs a password

`--user` runs every command there as `sudo -n -iu ACCOUNT …`: `-n` never prompts, and `-i` starts that account's login shell, so its `HOME`, `PATH` and Node.js are used. When sudo wants a password, `check` says `sudo -n could not run commands as agent-t3 without a password` and prints the rule that allows it. Run it on that machine, logged in as the account you reach it with over SSH:

```bash
echo "$USER ALL=(agent-t3) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/session-analytics-agent-t3
sudo chmod 0440 /etc/sudoers.d/session-analytics-agent-t3
sudo visudo -c        # optional: checks every sudoers file
```

The rule lets your SSH account run any command as `agent-t3` without a password, not only session-analytics, and anyone who can log in as you can then act as `agent-t3`. It grants nothing towards root or any other account. A narrower rule would not be safer: the bundled runtime is `node -`, which runs whatever arrives on its standard input, so it can do anything that account can. Without a rule, log in as that account directly with a key in its `~/.ssh/authorized_keys`: `machines set agentbox --ssh agent-t3@agentbox --no-user`.

### The bundled runtime

By default a saved machine runs this machine's own session-analytics, so nothing is installed there by hand and both machines run the same code. For each read, this machine runs

```text
ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -T \
  -a -x -o ClearAllForwardings=yes -o PermitLocalCommand=no -o RemoteCommand=none -- agentbox \
  sudo -n -iu agent-t3 node - sa1 run 0.9.0 <digest> \
  report --json --no-remote --portable-ids --time-zone <this machine's zone> [forwarded switches] --identify-machine
```

with a small fixed bootstrap (`src/remote/bootstrap.ts`, plain old JavaScript kept as a string, so compiled installs carry it too) on stdin, so no shell quoting layer ever sees it. `BatchMode` turns a password or host-key prompt into a failure; `-a`, `-x` and `ClearAllForwardings` keep your SSH agent, X11 display and any ports forwarded in your SSH configuration away from the code that runs there; `PermitLocalCommand=no` and `RemoteCommand=none` keep a host's `LocalCommand` or `RemoteCommand` out of the read. The bootstrap:

1. Exits 78 with `sa1: node-too-old` when Node.js is older than 24, before any newer syntax can fail.
2. Looks for this exact install in that account's `~/.cache/session-analytics/runtime/<version>-<digest>` (under `$XDG_CACHE_HOME` when it is an absolute path). The digest is a SHA-256 over this install's `package.json`, `bin`, `src`, `data` and `schemas`, so a checkout with local changes gets its own copy. The cached copy is verified against the digest before every run.
3. Refuses a cache that another account could change between that verification and the start, as OpenSSH's `StrictModes` does: every directory from the cache up to `/` must belong to that account or root and be writable by no one else, unless it is sticky like `/tmp` (group write passes only for that account's own private group). `session-analytics` and `runtime` must be directories owned by that account and not links. One that is only readable by others is made private (`0700`); one that others could write to, and a runtime directory that is a link or another account's, is emptied and installed again rather than trusted. Otherwise it exits 80 with `sa1: cache-unwritable not-private PATH`, naming the directory at fault.
4. When the install is missing or damaged, answers `sa1: need-runtime` (exit 75). Only then does a second round trip send the install itself, about 0.4 MB compressed, after the bootstrap. The bootstrap verifies it against the digest (81 on a mismatch), writes it to a private temporary directory and renames it into place (80 when the cache cannot be written). It keeps the newest three runtimes and any used in the last 14 days.
5. Runs `report` from the cached copy with that account's Node.js, starting only an entry point the verified manifest lists, and relays its output and exit status. Its JSON is compact, as only this reader sees it.

What a read leaves on that machine:

- **The runtime**, in `~/.cache/session-analytics/runtime/<version>-<first 16 digits of the digest>/`: this install's `package.json`, `bin`, `src`, `data` and `schemas` (about 2 MB unpacked), plus `.manifest` (file names and sizes) and `.complete` (the digest). Directories are mode `0700`, files `0600`. It holds code only: no history, analytics or configuration. Each new version, or each local change to a checkout, adds one directory. `machines remove` leaves it in place; delete the directory there to reclaim the space.
- **That account's own data directory** (`$XDG_DATA_HOME/session-analytics` or `~/.local/share/session-analytics` on Linux, `~/Library/Application Support/session-analytics` on macOS, or `SESSION_ANALYTICS_DATA_DIR` there): its private index, exactly as a `report` run there by hand would write it; `--no-index` reads without it. A `report` makes no network request of its own: it prices with that machine's cached and reviewed rates.
- **Nothing else.** Provider history there is only read. No saved-machines file, dashboard, service or scheduled job is created, and nothing keeps running between reads.

Measured against a real server with about 740 sessions, adding it took 20.7 s: 0.4 s to install the runtime, then 19.6 s for the first read, because a new runtime has a new parser revision and rebuilds that account's private index once. Later checks took about 3 s, of which the read took 2.0 to 2.7 s, and a `report` of a laptop with 6,400 sessions and that server took 35 s, set by the laptop's own scan.

This copies code to the machine and runs it as that account. It is not a boundary against that account, which can already run anything as itself; `node -` runs whatever arrives on stdin by design. To run your own install there instead, use `--runtime installed`, with `--command` naming it when `session-analytics` is not on that account's non-interactive `PATH`, for example `--command "node /opt/session-analytics/bin/session-analytics.ts"`. When an installed machine fails as if it ran another version, it is asked for `--version` and the message names both versions.

### Check a machine

```text
$ session-analytics machines check
agentbox  (ssh agentbox, as agent-t3, bundled runtime)
  ✓ ssh       connected in 0.1 s without a prompt
  ✓ sudo      sudo -n -iu agent-t3 works without a password
  ✓ node      v24.21.0 (needs 24 or later)
  ✓ machine   not this machine, and not saved under another name
  ✓ runtime   0.9.0+09867a9b cached
  ✓ history   741 sessions, 11 repositories in 2.0 s

All checks passed.
```

`check` stops each machine at its first failure and prints the reason, the most telling line `ssh` or the remote printed, and the exact command that fixes it. It exits 1 when any check fails. The history step is a real read, so it also warms that machine's index. When your SSH configuration shares connections (`ControlMaster`) and one is open, the ssh step also tries a login of its own; if only the shared connection works, it warns, because reads fail once that connection closes. `--find-users` also lists the login accounts whose home holds `.claude`, `.codex` or `.t3/userdata`, by name only (on macOS, from `dscl`), marking service accounts with no login shell; homes the SSH account cannot enter are tested with `sudo -n test -d`, and only when `sudo -n` works at all, so a machine without passwordless sudo logs one refusal rather than one per account. When the account read has no history, it suggests the accounts that do. `--json` prints the same results as JSON: names, destinations, each check's result and fix, and for a failure the one sanitized line `ssh` or the remote printed; never history or a raw machine ID.

| Failure | Fix printed |
| --- | --- |
| host name not found | check the name; `ssh -G HOST` shows how `~/.ssh/config` resolves it |
| SSH cannot connect, or a new host key | check that the host is up and reachable, then run `ssh HOST true` once in a terminal |
| SSH login refused | run `ssh HOST true`: if it asks for a key passphrase, load the key into your agent (`ssh-add`, `AddKeysToAgent yes`); if it asks for a password, `ssh-copy-id HOST` |
| works only through a shared connection (a warning) | the same: load the key into your agent so a login of its own works |
| sudo needs a password | the rule [above](#when-sudo-needs-a-password), in `/etc/sudoers.d/session-analytics-ACCOUNT` |
| account not found | `machines check NAME --find-users` lists the accounts with history (`add` lists them itself) |
| login shell refuses commands (`nologin`) | `machines set NAME --no-login-shell` |
| `node` missing or older than 24 | install Node.js 24 or later there, or `machines set NAME --node /usr/bin/node` |
| output other than asked for | make sure nothing in that account's login profile (`.bashrc`, `.profile`) prints to stdout |
| cache not writable or not private | `machines set NAME --runtime installed`, or a writable, private `XDG_CACHE_HOME` in that account's profile |
| no history (a warning) | that account has no agent history: `machines set NAME --user ACCOUNT`, naming the accounts that have some when they are known |
| runtime incomplete here | this install is missing its own files: reinstall it, or `machines set NAME --runtime installed` |
| command not found (installed) | the bundled runtime, or the full command in `--command` |

### Reading

The local scan and every machine's read run at the same time, and each machine is reported as it finishes, for example `Read 741 sessions across 11 repositories from agentbox in 2.2 s.` The reply is validated like an imported file before it is combined with the local scan ([below](#how-snapshots-combine)), and **Refresh snapshot** reads every machine again, except one still reading.

- **What crosses the network.** The command line goes out: the account, Node.js path, protocol words, version, digest, fixed report flags, this machine's time zone name and the forwarded switches. With the bundled runtime, the bootstrap and, once per version, this install's code go out on stdin. Nothing that describes this machine goes out: no paths, history, saved machines or local options. Only the remote machine's content-free snapshot comes back, with the standard error of `ssh` and the remote, of which one sanitized line (control, format and bidirectional characters removed) is shown in this terminal and in `machines check --json`, and nowhere else. Each machine reads its own transcripts and keeps its own private index, so its history survives provider cleanup there. A saved machine's last good snapshot is kept in the private data directory ([machine status](#machine-status)); ad-hoc `--remote` snapshots stay in memory. Nothing from either enters this machine's index.
- **Authentication** is your SSH configuration: host aliases, keys, agents, jump hosts and connection sharing all work. Every read, with either runtime or `--remote`, uses the `ssh` options [above](#the-bundled-runtime), so a password or host-key prompt fails instead of hanging the dashboard.
- **Forwarded switches:** `--offline`, `--no-index`, `--exclude-hidden`, `--no-additional-providers` and the pricing policy, sources and age. Source paths, `--data-dir` and `--database` describe this machine and stay here.
- **Time limit.** A machine that has not answered within 300 seconds is stopped; `--remote-timeout SECONDS` or `SESSION_ANALYTICS_REMOTE_TIMEOUT` changes it. A machine's first indexed read is its slowest, so run `machines check` once after adding a large one.
- **Stopping.** The time limit, Ctrl-C, `SIGTERM` and `SIGHUP` stop this machine's `ssh` and analysis workers (and their Cursor worker) before the process exits, nothing new starts once a signal arrives, and a stopped run never prints a partial result. An `ssh` that exits while a helper it started (a `ProxyCommand` that backgrounds, say) still holds its output is settled a second after its output stops, not at the time limit. With the bundled runtime the remote work stops too: the bootstrap relays the report's output and writes an empty line about once a second, so when the connection closes its next write fails and it stops the report and its analysis worker within a few seconds. A `--runtime installed` or `--remote` read keeps running there until it finishes.
- **When a machine cannot be read**, the dashboard and report still show the other machines. This terminal names the machine with a fixed reason, the most telling line `ssh` or the remote printed (never Node's version trailer or a stack frame) and the command that fixes it. A saved machine falls back to its [last good snapshot](#machine-status), marked stale; otherwise its sessions are missing. A machine read with no sessions is named with the hint that its agents may run as another account.
- **The dashboard does not wait** for the slowest machine. It shows a snapshot as soon as this machine's scan finishes, with each machine still reading shown from its last good snapshot (or without its sessions until it answers), and rebuilds the snapshot as each machine answers; the page asks `/api/machines` every 2 seconds while one is reading and fetches the new snapshot when it changes. **Refresh snapshot** scans this machine again and reads each machine that is not already reading; if this machine's scan fails, the other machines' reads carry on. **Read them again** in **Machine details** reads the other machines again without scanning this one, for the fix-then-retry loop. `report` and `export` wait for every machine.

### Machine status

Every snapshot that combines machines lists them in `machines`, this machine first, then the others in the order they are saved or given:

```json
{ "key": "agentbox", "label": "agentbox", "state": "stale", "reason": "connection",
  "fix": "run ssh agentbox true once in a terminal to accept the host key and check the login (ssh-copy-id agentbox installs a key)",
  "sessions": 722, "repositories": 10, "readAt": "2026-10-14T09:44:12.000Z", "durationMs": 4180, "version": "0.9.0",
  "warnings": ["Cursor local session history is missing."] }
```

- **`key`** is `local` for this machine and the lower-case saved name for the others (a plain form of the destination for `--remote`); each session's `machine` and each Claude profile's `machine` name it. A session found on more than one machine keeps the key of the copy that was kept. **`label`** is this machine's label (`machines rename local LABEL`, default `this machine`) or the saved name.
- **`state`** is `ok` (read now), `stale` (not read now; its last good snapshot is used), `failed` (not read, and its sessions are missing) or, only in a dashboard snapshot served before that machine answered, `reading`. **`reason`** is a fixed word such as `unknown-host`, `connection`, `login-refused`, `sudo`, `login-shell`, `timeout` or `same-machine`, never remote text; `no-history` marks a machine read with no sessions. **`fix`** is the command that fixes it, built only from the saved configuration.
- **`sessions`** and **`repositories`** count what was read from that machine, before sessions found on two machines are counted once. **`readAt`** is when the snapshot in use was read, **`durationMs`** how long the read took, and **`version`** the session-analytics that produced it, when the machine said (the bundled runtime always does). **`warnings`** are the fixed discovery warnings that machine raised, so a missing Cursor history is shown as that machine's, not this one's.
- **Last good snapshots.** After every good read of a saved machine, its validated snapshot is kept in the private data directory as `machines/<name>.snapshot.json`, with `machines/<name>.json` recording when and how it was read; both are mode `0600` and replaced atomically. When a later read fails, that snapshot is used instead, marked `stale` with its age, so going offline, or a server that is rebooting, does not make every total drop. It is used only when it was stored by this same version of session-analytics, for the same time zone, pricing and scan switches (`--no-index` included, since it leaves retained history out), from the same SSH destination and account, at most 7 days ago, and only when the snapshot's SHA-256 matches its record and it validates again; a copy read now always wins over a stale copy of the same session, also when combined files are merged. `machines set` with a new destination or account, and `machines remove`, delete it; `machines rename` keeps it. Ad-hoc `--remote` machines have none.
- **The same machine twice.** The bundled runtime answers with a 16-digit hash of its machine ID (`SESSION_ANALYTICS_MACHINE_ID`, else `/etc/machine-id`, `/var/lib/dbus/machine-id` or a Mac's platform UUID) and account, which this machine compares with its own and the others'. A machine that turns out to be this machine and account, or one already read under another name, is not counted again: it is listed as `failed` with the reason `same-machine` and the fix to remove it. Where there is no machine ID, the hash comes from the host name and is marked `host-`; since clones and default-named machines share host names, such a match is only a warning in `machines check` and `add`, never a refusal or a dropped machine. Where several machines share one machine ID, such as containers or VMs cloned from one image, set `SESSION_ANALYTICS_MACHINE_ID` to a different value in each account's environment; every same-machine fix says so. A saved `--runtime installed` machine is compared by the hash `machines check` recorded, if any; an ad-hoc `--remote` machine is not compared.
- **`report`** names the machines it covers in its header (stale ones marked, failed ones listed as not read) and adds a `Machines` block with each machine's sessions, repositories and read time, or its reason and fix. **`--strict`** makes `report` and `export` exit with status 3 after their output when any machine was not read now (failed, stale, or still reading in a saved dashboard snapshot), so a scheduled export notices; without it they exit 0. The report's Warnings name the machine each discovery warning came from. The snapshot also carries a fixed warning when a machine's sessions are missing or stale.
- **The dashboard** shows a Machines strip above the scope line: one chip per machine with its session count and state, which switches that machine's sessions in or out of every view, total and export except Subscription, whose limits are read on this machine only, so its value counts this machine's sessions and names the machines it leaves out; a chip's count is all time, not the selected dates. A machine without a snapshot is a button that opens **Machine details** with its state, counts, read time, duration, version and fix, and **Read them again**. The sync label says how many machines are ready and names the others, and Summary adds **Usage value by machine**. Coverage notes name the machine that raised them.

### Advanced: ad-hoc machines with --remote

```bash
session-analytics --remote server                     # dashboard: this machine and server
session-analytics report --remote server,build-box    # or --remote server --remote build-box
session-analytics --remote agentbox --remote-command "sudo -n -iu agent-t3 node /opt/session-analytics/bin/session-analytics.ts"
```

`--remote` reads these machines for one run instead of the saved ones. Each needs session-analytics installed (see [installation](cli.md#install), for example `npm install -g` with the release tarball URL) and runs `session-analytics` on the SSH user's non-interactive `PATH`, or the words in `--remote-command`, the same for every destination; run the same version on both machines. Repeated `--remote` flags add up. Destinations and command words are limited to letters, digits and `_./~@%+=:,-`, so neither can smuggle shell syntax, and `~` is refused after `sudo`, where the SSH user's shell would expand it to its own home.

`SESSION_ANALYTICS_REMOTE` and `SESSION_ANALYTICS_REMOTE_COMMAND` are deprecated: they still set the same options for every launch, with a notice; save the machines instead. `--no-remote` ignores them and the saved machines; it cannot be combined with `--remote` or `--machines`. Every fetched report uses `--no-remote`, so a machine's environment or saved machines cannot trigger reads of further machines. A saved snapshot (`--snapshot`) never scans, so it ignores all of these.

Saved machines and `--remote` apply to the dashboard, `report` and `export`; MCP, `limits` and index commands stay local. `report --share` describes this machine only, because one keyed source ID covers everything it shares: it never reads saved machines, refuses `--remote` and `--machines`, and refuses a `--snapshot` that combines several machines. Share from each machine and merge the shared files, so that merge can catch overlap. Shared snapshots never carry machine labels.

### From files

Without SSH, create a full snapshot on each machine and merge them:

```bash
# On each machine, in the same time zone:
session-analytics report --json --portable-ids --time-zone Europe/London > laptop.json
# Copy the files to one place, then:
session-analytics merge laptop.json server.json --out machines.json
session-analytics --snapshot machines.json
```

Merge decides by content: all shared snapshots merge as above, all full snapshots combine, and a mixture is refused. Merged full snapshots list their machines as `machine-1`, `machine-2` and so on in input order; a file that already combines machines keeps its machines, with a suffix when two files use the same key or label.

### How snapshots combine

Combining full snapshots, over SSH or from files, keeps every session and its details:

- **Sessions** are unioned by provider and session key. With `--portable-ids`, Claude and Codex registrations with a known provider session ID use the same key as their discovered transcripts, so a copy on a machine without Conductor counts once. Legacy registrations without a provider identity and other providers keep their keys. A session found on more than one machine (copied history, or the same file twice) is counted once, from the copy with the later last activity, then more model requests, and the snapshot carries a fixed warning. A copy read now always beats a copy from a stale machine's last good snapshot. The kept copy's machine is the session's `machine`.
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
