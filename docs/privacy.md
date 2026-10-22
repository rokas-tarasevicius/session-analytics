# Privacy contract

`session-analytics` reads coding-agent transcripts that already exist on your machine. Those transcripts contain everything you and your agents have written: prompts, responses, reasoning, commands, file paths, diffs, and tool output. This document defines exactly what the tool may return from them, how that boundary is enforced, and what it does not protect against.

The content-free contract covers dashboard/API, reports, pricing commands, MCP, exports/sharing, the agent skill and the persisted index. `index path` deliberately prints only the index location for local management. Likewise, `machines list` and `machines check` print the saved machine configuration you typed (labels, SSH destinations, account names, Node.js paths and commands), `machines check` prints the most telling line `ssh` or the remote printed when a check fails (also in `--json`, with control, format and bidirectional characters removed), and `machines check --find-users` prints the names of login accounts on that machine whose home holds `.claude`, `.codex` or `.t3/userdata`.

## The contract

**Returned:** allowlisted counters and metadata only.

- Token/cost/event counters, durations, timestamps, bounded model IDs and enumerated effort/status labels.
- Bounded tool names, never arguments or command text.
- Repository display names and stable repository keys; 12-hex provider-qualified session hashes and pseudonymous profile keys.
- Fixed entrypoint/originator enums.
- Fixed warning text with approved counts/model identifiers; public price sources, dates, payload hashes, rates and provenance enums.
- In live limits output only: provider-reported limit readings, hashed account keys, plan enums and the profile directory names of this machine and of the machines it reads.

**Never returned:**

- prompts, user messages, assistant messages, or reasoning text;
- tool arguments, tool results, commands, diffs, or patch content;
- file paths, transcript paths, working directories, repository roots, or Git remotes;
- raw session, provider, workspace, or message IDs;
- session titles, branch names, or workspace names;
- credentials, environment variables, or process arguments;
- raw local error messages or stack traces.

## How it is enforced

- **Explicit projections.** Native parsers and provider adapters build public objects from declared fields. Raw records and internal correlation types never cross the worker boundary. Snapshot schemas reject unknown nested fields; the index recursively selects that same schema before writing and after reading.
- **One model policy.** `src/public/model-id.js` (also re-exported by `src/public-model.ts`) bounds IDs to 160 characters and up to three validated namespace components. Filesystem roots, paths with traversal, URLs, whitespace, file suffixes, credential patterns and recognizable raw identifiers are rejected as `<unknown>`. Eligible counters remain visible. A syntactically valid name is still identifying metadata, not proof of safe provenance.
- **Bounded names and enums.** Tool names use the public grammar; Codex code-mode tool names are extracted as identifiers only. Status/error/warning fields use enums or fixed templates, never raw local errors.
- **Sentinel coverage.** Synthetic tests plant content, credentials, paths, IDs and commands in provider records. Analyzer, API, schemas, cache replay, reports, exports, MCP and rendering tests reject those strings at their output boundaries.
- **Fixed failures.** Worker stderr is never forwarded. The only errors crossing the worker are allowlisted codes/messages: index states, the heap limit, and a worker that could not start, recognised only by Node's own error code (a missing module, `node:sqlite` unavailable, TypeScript under `node_modules`). All other analysis failures are generic. Raw fetch errors are not returned.
- **Read-only provider access.** Transcripts are streamed and provider SQLite stores opened read-only. The separate private data directory contains derived index facts, public price history, preferences/configuration and private keys; provider directories are untouched.
- **Explicit network boundaries.** Analysis reads cached prices; dashboard startup, periodic checks, newly observed unpriced models and manual refresh can update fixed public price feeds without local metadata, credentials or redirects. `--offline` disables pricing requests. `export --otlp-endpoint` permits selected content-free export delivery; it is independent of the pricing setting. Reading other machines is described in the next item. There is no telemetry. The loopback dashboard uses same-origin CSP, bundled fonts and marks.
- **Other machines.** Reading another machine (one saved with `machines add`, or `--remote`) runs the user's own `ssh` to start a `report --json` there (and, for `limits` and the Subscription view, a `limits --json --no-remote`), with `BatchMode` and without agent, X11 or port forwarding. The command line carries validated words (account, Node.js path, protocol words, version and digest), fixed flags, forwarded switches and this machine's time zone name, and nothing that describes this machine. With the bundled runtime, a fixed bootstrap and, once per version, this install's own code travel on stdin; on that machine, the tool writes only that account's `~/.cache/session-analytics/runtime` (code only; directories `0700`, files `0600`) and its own private data directory. Only that machine's content-free snapshot returns, validated like an imported file, or its limits snapshot, re-validated field by field through the ledger's allowlists with its labels rebuilt here; its stderr is reduced to one sanitized line shown only in this terminal (and in `machines check --json`). `machines check` also reads that account's Node.js version, the machine ID (or, where there is none, the host name), the account's UID and its name over the same connection; the check hashes the ID and UID as soon as they arrive (16 hex digits of SHA-256) and never stores or prints them raw. With the bundled runtime, the remote report and limits read hash their own machine ID and UID the same way and return only that hash, which is compared and dropped. A saved machine's last good snapshot and last good limits (without profile directory names) are kept in this machine's private data directory, and the readings and plans of real accounts from each fresh limits read are folded into this machine's limits ledger under the account key, without the machine, profile names or profile keys, so their history outlives that machine.
- **Limit meters.** `limits` and the Subscription view read provider-reported usage percentages, reset instants and plan names from Codex session `rate_limits` records, Claude Agent SDK `rate_limit_event` host logs and status-line input. Lines are decoded only when they contain those markers. Readings are attributed to accounts: a Claude event's `session_id` is matched against transcript file names found by listing each profile's `projects/` directories (transcripts are never opened), and a Codex rollout's first line is read for `session_meta.creator_account_id`. From each Claude profile's `.claude.json`, only `oauthAccount`'s organization and account IDs, five plan enums matching `^[a-z0-9_]{1,48}$` and the `hasExtraUsageEnabled` flag are kept; emails, names, organization names and project history are never read into results. From `.credentials.json`, only `subscriptionType` and `rateLimitTier` are inspected; no token is returned or stored. Account IDs are hashed inside the reader into account keys; session IDs are never stored. No Anthropic endpoint is contacted. Unless `--no-codex-account` or `--offline` is set, the tool starts the local `codex app-server` (at most every 10 minutes, once per Codex home) and sends only `initialize` and `account/rateLimits/read`; Codex makes the request to OpenAI with its own login. Reset credit IDs, titles and upsell banners are dropped, the account ID is kept only as its hash, and reset credits are never redeemed. Limits are served only by `limits` and the loopback `/api/limits`; they are not part of saved, shared, exported, remote or MCP snapshots, and another machine's limits reach this one only as its own `limits --json` answer over SSH. Profile directory names in that output, this machine's and the other machines', are shown live and never written to a file. The Subscription view matches sessions to accounts in the browser through pseudonymous profile keys and each session's `machine`. Fields are listed under [Limits endpoint](#limits-endpoint-limitssnapshot).
- **MCP boundary.** Tools accept no paths, commands, URLs, SQL or client roots. Trusted source paths are launch settings. Only projected metrics enter responses; the MCP worker reads no skill or MCP-server configuration, never executes configured commands and never contacts servers.

Raw transcript content is not persisted or logged. Bounded parsing collectors may hold current request/receipt evidence in memory until reconciliation. Public pricing caches contain normalized rates, not raw feed bodies or local inventories.

The dashboard API requires a same-origin fetch context when provided and an exact HTTP Origin
(scheme, host and port); credentials, paths, queries and fragments are invalid Origin values.
Requests remain GET-only, with no request body (zero `Content-Length` is allowed; chunked bodies
are rejected). Body rejections close the connection before any refresh work. Request targets,
including query strings, are limited to 8 KiB (HTTP 414); Node's header overflow returns HTTP 431.
Parser failures return fixed HTTP 400/431 errors (408 for a request timeout) with the same no-store and security headers as
normal responses, without reflecting request bytes. Rejections close the connection instead of
draining an advertised body, and ignore subsequent requests already buffered on that connection;
unsupported expectations return a fixed HTTP 417 error.

## Verification

The local real-machine verification harness also writes audit-only evidence: hashed session keys, metadata signatures and capture timestamps (P1); exclusion counts and independently reconstructed calibration values (P0, with hashed identities and event timestamps treated as P1). Source generations and calibration pairs stay in `.lane/`; they contain no source paths, raw session IDs or transcript content and add no public snapshot fields. Provider histories are read-only throughout verification.

See the [verification guide](../verify/README.md) for independent oracles and saved-evidence checks.

## Local index

The default content-free index lives in `~/Library/Application Support/session-analytics/` on macOS and `$XDG_DATA_HOME/session-analytics/` (fallback `~/.local/share/session-analytics/`) on Linux. `SESSION_ANALYTICS_DATA_DIR` / `--data-dir` overrides it. Only the private analytics data directory is writable; provider stores remain read-only. Use `--no-index` or `SESSION_ANALYTICS_NO_INDEX=1` to bypass every index read/write and analyze only currently present evidence.

The directory is mode `0700`. `index.sqlite`, WAL/SHM/journal files, the SQLite writer-coordination file, transient filesystem writer tickets, and a 32-byte random `index.key` are mode `0600`. Symbolic links, hard-linked files, and foreign ownership are rejected. These permissions and the key protect against other accounts; this is not encryption and does not protect against a process running as your user.

The following is the complete disk field manifest. Index source keys and integrity fingerprints use HMAC-SHA-256 with `index.key`, which is never exported. Internal Codex identity hashes are explicitly listed as unkeyed below. A domain-separated verification MAC binds the database, all scopes, and pruning reservations to that key before scope selection. Legacy migration authenticates existing payloads first; it refuses unverifiable keyed-only state. Rebuild preserves a usable key; deleting or replacing the key does not make an existing database safe to reuse. Integrity MACs detect unintended changes but are not protection from an attacker who can read the key.

| Stored data | Contents | Tier |
| --- | --- | --- |
| `sessions.payload` | The complete schema-allowlisted `SessionAnalytics` projection below, including metric namespaces and pricing provenance; no raw provider rows | P0/P1 |
| `scope`, `identity_key`, `source_keys`, `root_key`, `remote_key`, `signature` | Keyed hashes of source configuration, provider-qualified identity, paths, roots/remotes, and parser/rate/metadata dependencies | P1 |
| `payload_mac`, `ledger_mac` | Keyed payload integrity digests | P1 |
| `source_deleted`, `last_event_at`, `retention_verified` | Deletion state, normalized last activity, and whether a current parser verified the retention date; unverifiable legacy dates cannot justify pruning | P0 |
| `exclusions` | Only keyed scope, identity, signature, and source keys for pruned groups; no removed session payload or usage totals | P1 |
| `evidence.source_key` | Keyed absolute-path identity; the path is never stored | P1 |
| `evidence.fingerprint.device`, `.inode` | Filesystem identity numbers encoded losslessly as strings | P1 |
| `evidence.fingerprint.size`, `.mtime`, `.ctime` | Byte count and nanosecond modification/change times | P0 |
| `evidence.fingerprint.head`, `.tail` | Keyed first/last 4 KiB digests; bytes are discarded | P1 |
| `evidence.ledger.observations[]` | Numeric total/last counter fingerprint, activity gap (`null` for unknown), selected and earliest observed timestamps | P0 |
| `evidence.ledger.identity.key`, `.parents[]`, `.createdAt` | SHA-256 thread/ancestor identities and normalized creation time; unkeyed and linkable, with no raw IDs | P1/P0 |
| `evidence.ledger.receipts[].key`, `.fingerprint`, `.timestamp` | SHA-256 of the thread/response identity pair, numeric counters, and normalized receipt time | P1/P0 |
| `evidence.ledger.calls[].key`, `.timestamp` | SHA-256 transport-call identity and normalized time or null, used to exclude proven inherited calls | P1/P0 |
| `evidence.ledger.nativeFingerprints[]` | Numeric counter fingerprints proven to alias explicit request receipts | P0 |
| `evidence.ledger.unownedFingerprints[]` | Numeric total/last fingerprints with no event timestamp, used to connect ownership dependencies | P0 |
| `evidence.ledger.models`, `.lastLocalActivityTimestamp`, `.bytes`, `.newlineTerminated`, `.unownedCounters` | Model IDs, continuation timestamp/byte offset, and boolean checkpoint guards | P0 |
| `evidence.ledger.prefixHash` | Keyed digest of the complete old prefix; no transcript bytes | P1 |
| `claude_ownership.source_key`, `.fingerprint` | Keyed absolute-path identity and the same file fingerprint as `evidence` | P1/P0 |
| `claude_ownership.observations` | Per Claude transcript file, in file order: a 128-bit keyed hash of each assistant message ID and its numeric output/total/reasoning/cache-TTL/input/cache-read/cache-write counters; compressed, no raw IDs or content | P1/P0 |
| `conductor_records.session_key`, `.signature` | Keyed Conductor session identity and keyed digest of the session's row-count, rowid and byte-length change evidence | P1 |
| `conductor_records.payload` | Per Conductor session, the allowlisted result-receipt and assistant-message projection: 128-bit keyed hashes in place of every record, response, provider session, tool-call and query identity; token counters, reported costs, durations, turn and denial counts, normalized timestamps, enum terminal reasons, model IDs and bounded tool names; compressed, no content | P1/P0 |
| `observations_mac` | Keyed payload integrity digest for `claude_ownership` | P1 |
| `sessions.owned_counters` | Attributed numeric counter fingerprints, timestamps, and fallback model IDs; Antigravity additionally uses namespaced HMAC response keys and HMAC owner keys with empty timestamps for request-owner reservations. No raw request IDs | P0/P1 |
| `retired_counters.counter_key` | Keyed counter-membership reservations kept after pruning, including Antigravity response-ownership reservations, without usage values or timestamps, solely to prevent rebilling | P1 |
| `limits-v2.json` | Limit-meter ledger: per reading the provider, account key, meter, window minutes, reset and observation times, used percent, status and source enums; per account the plan and its source, the allowlisted plan enums, Claude extra-usage enum and reason, Codex credit balance and banked reset count with scope, grant and expiry times, and the pseudonymous profile keys logged into it; banked-reset count history per account; profile key → account key and fallback-key → account key maps; per Codex home's fallback key, the account keys seen creating its rollouts or answering the account read; Codex scoped-limit names; read positions keyed by device and inode with a 64-bit hash of the 64 bytes before each position and, for Codex rollouts, the creating account's key; harvest and import times; last Codex account read time; the time of each of this machine's sources' newest reading. Readings, plans and banked-reset counts of real accounts read from other machines are kept the same way, without the machine they came from; another machine's plan only for an account this machine never read a plan for. Account keys are unkeyed SHA-256 of OAuth or ChatGPT account IDs, or of a profile's real path when no login is recorded. No paths, session IDs, raw account IDs, profile names, credit IDs or tokens | P0/P1 |
| `limits-inbox-v2.jsonl`, `limits-inbox-v2.jsonl.<random>.merging`, `limits-statusline-<account key>.last` | Status-line readings pending the next harvest, in the same row format; an inbox a harvest has claimed and deletes once the ledger is written (a stopped harvest's claim is taken by the next one); each account's last recorded signature | P0/P1 |
| `limits-gate/writer-ticket-<pid>-<random>` | Short-lived tickets that make ledger writers in different processes take turns; each holds only a queue number and is removed when its write ends | P0 |
| `limits.json`, `limits-inbox.jsonl`, `limits-statusline.last` | The 0.9.0 ledger without accounts, its inbox and signature. This version never writes them and reads only `limits.json`, as import input; an older installation sharing the data directory may still write them | P0 |
| `limits-v2.json.unreadable-<time>` | A ledger that could not be parsed, set aside unchanged | P0/P1 |
| `metadata` | Keyed parser/rate revision, domain-separated key-verification MAC, and the UTC retention floor; no source configuration in plaintext | P0/P1 |
| `metadata.audit:sessions:<scope>`, `.audit:ledgers:<scope>`, `.audit:ownership:<scope>`, `.audit:conductor:<scope>` | Keyed scope and last selected keyed session/source identity in the rotating verification sample; committed only with a successful ingest | P1 |
| `scans` | Keyed source scope, completion time, and counters/timing from the status manifest below | P0/P1 |
| `index.key` | Private random HMAC key, never part of output | Private key |
| SQLite metadata / `writer.sqlite` | Schema version, transaction metadata, and local writer coordination; no transcript data | P0 |
| `writer-ticket-*` / `.next` | Transient process ID, random nonce, and numeric mutex order; no provider data, paths, or session IDs; removed on release or dead-process recovery | P0 |
| `dashboard-PORT.token` / `.next` | Random 32-byte per-launch dashboard token encoded as 64 hex characters; mode `0600` inside the private mode `0700` data directory; no local evidence or option values | P0 |
| `machines.json` | Saved machines, as typed by the user: format version, this machine's label, and per machine a label, SSH destination, account name, whether to read it without a login shell, Node.js path, runtime enum, command words for an installed runtime, enabled flag and time added, plus a 16-hex SHA-256 of that machine's ID (or host name, marked `host-`) and account UID recorded by `machines check`. Mode `0600`, replaced atomically under an empty, short-lived `machines.json.lock`, validated strictly on every read. No credentials, keys or analytics | P1 |
| `machines/<name>.snapshot.json` | A saved machine's last good snapshot: the same content-free, validated full snapshot that machine returned, kept to show it as stale when a later read fails. Mode `0600` inside a `0700` directory, replaced atomically, validated again before use, and deleted by `machines remove` or a new destination or account | P0/P1 as the snapshot fields |
| `machines/<name>.limits.json` | A saved machine's last good limits: format version, the session-analytics version that stored it, a SHA-256 digest of the request (its `--offline`-independent switches) and of the SSH destination and account, read time and duration, whether that machine's reads also ask its Codex app-server, and its validated limits snapshot with profile directory names removed. Mode `0600`, replaced atomically, used for at most 7 days, deleted by `machines remove` or a new destination or account | P0/P1 as the limits fields |
| `machines/<name>.json` | What that snapshot answers: format version, the session-analytics version that stored it, a SHA-256 digest of the request (time zone, pricing and scan switches), a SHA-256 digest of the SSH destination and account it was read from, a SHA-256 digest of the snapshot file, read time and duration, the remote version, session and repository counts, and the 16-hex machine and account hash the remote reported. Mode `0600` | P0/P1 |

On a machine read with the bundled runtime, the account read also keeps `~/.cache/session-analytics/runtime/<version>-<first 16 digest digits>/` (under `$XDG_CACHE_HOME` when set): this install's `package.json`, `bin`, `src`, `data` and `schemas` files, `.manifest` (their paths and byte sizes) and `.complete` (the 64-hex digest). It holds code only, never analytics, history, configuration or anything from this machine. That account's own data directory holds the files this table describes, for its own history.

The index retains previously observed history after provider deletion. `index prune --before YYYY-MM-DD` removes old verified session facts, clears reusable evidence, vacuums the active database, and keeps a retention floor, minimal keyed exclusion checkpoints, and keyed anti-rebilling reservations. Subsequent scans may rebuild ledger evidence from surviving provider files; unchanged exclusion checkpoints skip session parsing without restoring session facts. The cutoff is exclusive UTC midnight; provider files are untouched. Unverified legacy dates are kept until the source can be reparsed. Rebuild discards retained history and resets the floor. Corruption recovery places unreadable main or writer databases in private `.rebuild-*` quarantine files, which are excluded from analysis, status, and prune; remove those separately when no longer needed. Retention is of derived facts, never a raw transcript archive. Index payloads written by earlier versions may still contain removed analysis namespaces; they are dropped when read and never returned, except that a Claude session's stored profile key and per-day model tokens are carried forward as `historyProfile`.

### Parity audit diagnostics

The development-only `scripts/parity.ts` runner reads real sources without writing to them. It uses offline prices and a fresh private index inside `.lane/`; it never serializes the real snapshot or source content into its report. The metadata-only generation check hashes native file identities/versions (including Claude children) and an explicit Conductor session/workspace/repository metadata allowlist in memory. It never queries message tables. These hashes are used to detect live changes, not exported as paths or raw IDs.

| Diagnostic field | Contents | Tier |
| --- | --- | --- |
| `phase`, `milliseconds`, `sessions`, `unchangedSessions`, `fellBack`, `failure`, `stage` | Fixed full/cold/warm phase, failure category and analysis/serialization stage, wall time, counts and fallback flag | P0 |
| `index` | The existing index scan statistics including the audit counts, or null for a full scan | P0 |
| `invalidSchemaFields` | Schema-owned field names mapped to failure counts; dynamic keys and source values are omitted | P0 |
| `totals[]` | UTC session-start month, provider, sessions/invalid counts and existing token/cost-class totals | P0 |
| `differences[]`, `unchangedDifferences[]` | Existing 12-hex session keys and names of differing allowlisted fields; no source values | P1 |
| `monthlyDifferences[]`, `unchangedMonthlyDifferences[]` | Month/provider and names of differing total fields | P0 |
| `changedEvidenceSessions[]` | Existing hashed session keys whose native evidence or correlation metadata changed between phases | P1 |
| `unverifiedEvidenceSessions[]` | Existing hashed session keys outside the native-file/correlation generation inventory; these are excluded from the unchanged-evidence comparison | P1 |

No new processing tier or network access is introduced. A consistency fallback uses a fixed allowlisted warning; the worker's heap-limit diagnostic is also fixed text and never forwards child stderr.

## Privacy tiers

| Tier | Contents | Status |
| --- | --- | --- |
| **P0** | Counters, costs, dates, durations, bounded model/tool names and enumerated labels | Returned by default |
| **P1** | Pseudonymous session/repository/profile keys, display names and timezone | Returned with explicit field coverage; private keys are never public |
| **P2** | Fixed rule IDs/classes and counts derived from local content | No current feature; any such rule must be opt-in and off by default |
| **P3** | Bounded redacted human/assistant prose sent off the machine | No current feature; would require an explicit per-run opt-in and could never be stored in the index or returned through analytics APIs |

## Field manifest

**Research proposals:** [schema-v2.md](proposals/schema-v2.md) contains a separate, proposed event-field manifest, and [metrics-research.md](proposals/metrics-research.md) describes its intended measurements. Neither adds fields to the public snapshot listed below. The accompanying research audit retains aggregate counts/distributions and reviewed tool names only; it does not publish raw local records, paths or identifiers. Future implementation still requires the field-by-field projection, sentinel tests and P2/P3 opt-ins described here.

This manifest lists every field in the public snapshot. It is generated from the types in [`src/types.ts`](../src/types.ts); a change to those types must update this table in the same pull request. Metric semantics are defined in [metrics.md](metrics.md).

The [product strategy proposal](proposals/product-strategy.md) adds **no public fields** and changes no privacy tier or runtime behavior. Its [feature portfolio](proposals/feature-portfolio.md) assigns proposed processing tiers, and its [metric contracts](proposals/metric-contracts.md) require a separate types/manifest/sentinel update before implementation. Future names in those proposals are not part of this manifest. Repository names, precise timestamps and current unkeyed hashes remain identifying metadata; sharing now provides aggregate-only previews, keyed repository pseudonyms or explicit aliases, and minimum-session suppression. These shipped controls do not guarantee anonymity; see [Sharing and optional delivery boundary](#sharing-and-optional-delivery-boundary).

### Snapshot root (`MachineAnalytics`)

Returned by `/api/analytics` and `report --json`.

| Field | Meaning | Tier |
| --- | --- | --- |
| `schemaVersion` | Snapshot interchange version, currently `1` (also present in single-repository results) | P0 |
| `generatedAt` | ISO time the snapshot was computed | P0 |
| `velocity.version` | Optional velocity payload version; currently `1` (also on single-repository analysis results) | P0 |
| `velocity.timeZone` | IANA timezone used to bucket activity; analysis process local zone, including a `--time-zone` or `TZ` override | P1 |
| `rateCard.currency` | Always `USD` | P0 |
| `rateCard.effectiveDate` | Effective date of the rate card used | P0 |
| `rateCard.models[].model` | Model ID with a currently resolved rate | P0 |
| `rateCard.models[].source` | Public URL of the selected rate source | P0 |
| `rateCard.models[].provenance` | Current rate evidence; see Pricing provenance below | P0 |
| `rateCard.models[].rate` | Current public price per 1M tokens: provider key and numeric rate fields only (input, cached input, cache read, cache writes, cache-write multiplier and observability, output, long-context modifiers and context tiers) | P0 |
| `rateCard.pricing` | Cache freshness/configuration; see Pricing status below | P0 |
| `repositories[]` | One rollup per repository; see [Repository rollup](#repository-rollup-repositoryrollup) | P0/P1 |
| `sessions[]` | Every analyzed session; see [Session](#session-sessionanalytics) | P0/P1 |
| `spendByDay[]` | `{ name: "YYYY-MM-DD", value: USD }`, priced usage by UTC day | P0 |
| `spendByModel[]` | Model usage across all sessions; see [Model usage](#model-usage-modelusage) | P0 |
| `summary` | Machine totals; see [Summary](#summary) | P0 |
| `topTools[]` | `{ name, value }`, effective tool calls by tool name, descending | P0 |
| `warnings[]` | Fixed-text coverage notes (unpriced models, missing or unmatched transcripts, unreadable roots) | P0 |
| `machines[]` | Optional; present when the snapshot combines machines. One entry per machine, this machine first; see [Machine status](#machine-status-machinestatus) | P0/P1 |
| `mcpContext.repositoryId` | Optional launch-context repository key, or null outside a repository; requested internally by the MCP worker, never a path | P1 |
| `mcpSourceHealth[].provider`, `.status` | Provider and available/incomplete/unavailable discovery enum, independent of sessions | P0 |
| `mcpSourceHealth[].sourcesRead`, `.missingSources`, `.unreadableSources` | Discovery source counts; no paths or error text | P0 |

### Machine status (`MachineStatus`)

Present in snapshots that combine machines, in `/api/machines` (the same entries as they stand while the dashboard reads), and, for one entry with `identity`, in a remote machine's `report --json --identify-machine` answer.

| Field | Meaning | Tier |
| --- | --- | --- |
| `key` | `local` for this machine, otherwise the lower-case saved name or a plain form of the `--remote` destination; referenced by session `machine` and history profile `machine` | P1 |
| `label` | This machine's label (`machines rename local LABEL`, default `this machine`) or the saved name or destination the user typed; merged files use `machine-1`, `machine-2` | P1 |
| `state` | `ok`, `stale`, `failed`, or `reading` (dashboard only, before that machine answers) | P0 |
| `reason` | Optional fixed enum (`connection`, `sudo`, `timeout`, `same-machine`, `no-history` and the others listed in [interop.md](interop.md#machine-status)); never remote text | P0 |
| `fix` | Optional command that fixes the reason, built from fixed text and the saved configuration (machine name, SSH destination, account name, Node.js path) | P1 |
| `sessions`, `repositories` | Counts read from that machine | P0 |
| `readAt`, `durationMs` | When the snapshot in use was read, and how long the read took; null when none is used | P0 |
| `version` | The session-analytics version that produced it, when the machine said | P0 |
| `identity` | Only in a single machine's own answer to `--identify-machine`: 16-hex SHA-256 of its machine ID (or host name) and account UID, used to recognise the same machine read twice, then dropped; never in a combined snapshot | P1 |
| `warnings[]` | Optional fixed discovery warnings that came from that machine | P0 |

### Repository rollup (`RepositoryRollup`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `repository.id` | Stable repository key. For a registered repository, `conductor-` plus the first 20 hex characters of SHA-256 of `conductor:<private repository record ID>`. Otherwise `discovered-` plus 20 hex characters of SHA-256 of the grouping identity: `remote:<normalized full remote>` when available, else the canonical Git/common directory. Temporary directories share the hash of a fixed sentinel path, and directories without repository evidence share the hash of the fixed string `no-repository`, so neither ID depends on a local path. Unassigned native Cursor composers share a fixed hashed group; adapters hash their source plus private project/group identity, or session identity when no group is available. Raw identity inputs never leave the parser | P1 |
| `repository.name` | Display name: Conductor's repository name, the final normalized remote component, or the basename of the Git root. Directories without any repository evidence share the fixed label `No repository detected`; temporary directories show `Ephemeral automation sessions`; unassigned groups use a fixed provider label with an optional hash suffix | P1 |
| `spendByDay[]` | Priced usage by UTC day for this repository | P0 |
| `spendByModel[]` | Model usage for this repository | P0 |
| `summary` | Repository totals; see [Summary](#summary) | P0 |
| `topTools[]` | Effective tool calls by name for this repository | P0 |
| `warnings[]` | Fixed-text coverage notes for this repository | P0 |

### Summary

Repository summaries and the machine summary share these fields.

| Field | Meaning | Tier |
| --- | --- | --- |
| `analyzedSessions` | Sessions whose evidence validated and parsed | P0 |
| `apiEquivalentSpendUsd` | Sum of API list-price-equivalent session values across sources with reviewed rates | P0 |
| `cacheReadRatio` | Cache-read tokens divided by uncached input plus cache reads plus cache writes; `null` with no input | P0 |
| `compactions` | Sum of session compactions | P0 |
| `estimatedSpendUsd` | Priced usage value: API-equivalent plus provider-reported | P0 |
| `estimatedUpperSpendUsd` | Sum of session upper estimates | P0 |
| `missingTranscripts` | Sessions whose transcript is missing | P0 |
| `outputTokens` | Sum of output tokens | P0 |
| `pricedTokenCoverage` | Token-weighted share of observed tokens with a known rate; `null` when not applicable | P0 |
| `providerReportedSpendUsd` | Sum of provider-reported session values (Cursor composer database and Conductor SDK results) | P0 |
| `sessions` | Session count | P0 |
| `subagentSessions` | Sessions with sub-agent or mixed execution | P0 |
| `subagentSpendUsd` | Value attributed to sub-agent execution | P0 |
| `topLevelSessions` | Sessions with top-level or mixed execution | P0 |
| `topLevelSpendUsd` | Value attributed to top-level execution | P0 |
| `toolCalls` | Sum of effective tool calls | P0 |
| `totalInputTokens` | Sum of processed input tokens, including cache reads and writes | P0 |
| `unpricedSessions` | Sessions with observed tokens and estimated or unavailable token-class rates; excludes activity-only and reported-value sources with N/A coverage | P0 |
| `repositories` | Machine summary only: repositories in scope | P0 |
| `repositoriesWithSessions` | Machine summary only: repositories with at least one session | P0 |
| `workingSnapshots` | Machine summary only: working observations with present sources; source-deleted or unavailable historical observations are excluded | P0 |

### Session (`SessionAnalytics`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `agentIdentity.claudeEntrypoint` | Optional fixed enum: `cli`, `sdk`, `desktop`, `unknown` | P0 |
| `agentIdentity.claudeSubagentType` | Optional observed subtype: `general-purpose`, `explore`, `plan`, `other`, or `mixed` for a composite session | P0 |
| `agentIdentity.codexSource` | Optional initial source enum: `cli`, `exec`, `vscode`, `subagent`, `review`, `unknown` | P0 |
| `agentIdentity.codexOriginator` | Optional initial originator enum: `cli`, `exec`, `vscode`, `desktop`, `unknown`; arbitrary originator text is excluded | P0 |
| `velocity` | Optional compact, content-free local-time activity cells; see [Velocity cells](#velocity-cells-sessionvelocity) | P0 |
| `machine` | Optional, in snapshots that combine machines: the `key` of the machine whose copy of the session was kept | P1 |
| `sessionKey` | First 12 hex characters of SHA-256 of `<provider>:<session ID>` (or of the Conductor session ID for Conductor-registered sessions). It is not keyed with a secret, so it is stable across runs; someone who already holds the raw ID can recompute it, but the key does not reveal the ID | P1 |
| `provider` | `claude`, `codex`, `cursor`, `copilot`, `opencode`, `gemini`, `antigravity`, and `unsupported` | P0 |
| `repositoryId` | Repository key, as in `repository.id` | P1 |
| `repositoryName` | Repository display name, as in `repository.name` | P1 |
| `status` | Fixed label: `idle`, `working`, `completed`, `failed`, `error`, `interrupted`, `cancelled`, `pending`, or `unknown`; unrecognized source text becomes `unknown` | P0 |
| `createdAt` | Provider session start time; file modification time only when `evidence.timing` is `file-mtime` | P0 |
| `updatedAt` | Recorded session update/end time when available; otherwise the session start time. File modification time for `file-mtime` evidence | P0 |
| `mcpEvidence` | Optional lifecycle state and daily pricing-coverage operands from the streaming parser; see [MCP fields](#mcp-fields) | P0 |
| `firstEventAt` | Earliest valid event instant, normalized to UTC, or `null` | P0 |
| `lastEventAt` | Latest valid event instant, normalized to UTC, or `null` | P0 |
| `effort` | Bounded reasoning-effort label, or `null`; adapters use `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `auto`, or `unknown`, while native evidence may retain other validated labels | P0 |
| `executionKind` | `top-level`, `subagent`, `mixed`, or `unknown` | P0 |
| `costBasis` | `api-list-price-equivalent`, `provider-reported`, or `unavailable` | P0 |
| `costComplete` | For added sources: all owned observed token classes explicitly priced, or supported Conductor accounting intervals with cost for every selected snapshot. Partial accounting forces false. Activity-only evidence is incomplete; this field never proves complete historical retention | P0 |
| `pricedTokenCoverage` | Share of this session's tokens with a known rate, or `null` | P0 |
| `cost` | Cost breakdown; see [Cost breakdown](#cost-breakdown-costbreakdown) | P0 |
| `costByExecution.topLevelUsd` | Value attributed to top-level execution | P0 |
| `costByExecution.subagentUsd` | Value attributed to sub-agent execution | P0 |
| `costByExecution.unknownUsd` | Value with no execution evidence | P0 |
| `tokens` | Token counters; see [Token usage](#token-usage-tokenusage) | P0 |
| `models[]` | Per-model usage; see [Model usage](#model-usage-modelusage) | P0 |
| `spendByDay` | `{ "YYYY-MM-DD": USD }` for this session, by UTC day of each priced request | P0 |
| `tools` | `{ toolName: count }`, effective tool calls (code-mode calls expanded to the inner tool) | P0 |
| `transportTools` | `{ toolName: count }`, tool calls as the provider transported them, before expansion | P0 |
| `metrics` | Execution counters; see [Session metrics](#session-metrics-sessionmetrics) | P0 |
| `historyProfile` | Optional, native Claude sessions only: input to machine-wide history coverage; absent when the transcript's Claude profile is unknown | P0/P1 |
| `historyProfile.profileKey` | Pseudonymous `profile-<20 hex>` key of the Claude profile holding the transcript, the same key as `historyCoverage.profiles[].profileKey`; derived from the canonical profile directory, which is never returned | P1 |
| `historyProfile.days[].day`, `.model`, `.tokens` | UTC request date (`YYYY-MM-DD`), bounded model ID, and deduplicated request input plus output tokens for that day and model; undated requests are omitted | P0 |
| `transcript.files` | Number of evidence files read for the session (main transcript plus sub-agent files) | P0 |
| `transcript.status` | `ok`, `missing`, `invalid`, or `unsupported` | P0 |
| `transcript.snapshotWhileWorking` | `true` when the session was marked working at its last source observation; a retained observation does not establish current activity | P0 |
| `transcript.completeness` | Optional `complete`, `partial`, `unknown`: parse/file-version completeness of observed evidence, not lifetime retention | P0 |
| `transcript.liveness` | Optional `active`, `inactive`, `unknown`: observed lifecycle/Conductor state; see [transcript evidence](metrics.md#request-size-and-transcript-evidence) | P0 |
| `transcript.warnings[]` | Fixed-text parser notes, which may include counts and model IDs | P0 |
| `evidence` | Optional source fidelity and availability; absent on the original native-provider projections | P0 |
| `evidence.accounting` | Optional `complete` or `partial` for retained accounting; no promise of complete historical retention | P0 |
| `evidence.source` | `conductor-result`, `cursor-sdk`, `cursor-transcript`, `copilot-events`, `opencode-db`, `gemini-chat`, or `antigravity-db` | P0 |
| `evidence.fidelity` | `message`, `summary`, or `activity-only`; describes the retained source, not task quality | P0 |
| `evidence.tokens` | `reported` or `unavailable`; distinguishes observed counters (including recorded zero) from missing evidence | P0 |
| `evidence.tools` | `observed` or `unavailable` | P0 |
| `evidence.turns` | `observed` or `unavailable`; SDK runs count as observed run turns, Conductor loop-turn summaries do not become human turns | P0 |
| `evidence.timing` | `provider` or `file-mtime`; file dates cannot establish start time, duration, or active hours | P0 |
| `evidence.usageUnit` | `request`, `run`, `session`, or `unavailable`; identifies the granularity of token evidence | P0 |
| `conductor` | Optional result-only SDK counters, populated only for Conductor fallback sessions | P0 |
| `conductor.turnLocalTokens` | Deduplicated turn-local receipt counters in the nine-field `TokenUsage` shape below; separate from cumulative session/model totals; null if no usage counters are recorded | P0 |
| `conductor.turnLocalTokens.inputTokens` | Same inputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.uncachedInputTokens` | Same uncachedInputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.cachedInputTokens` | Same cachedInputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.cacheWriteInputTokens` | Same cacheWriteInputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.cacheWrite5mInputTokens` | Same cacheWrite5mInputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.cacheWrite1hInputTokens` | Same cacheWrite1hInputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.outputTokens` | Same outputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.reasoningOutputTokens` | Same reasoningOutputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.turnLocalTokens.nonReasoningOutputTokens` | Same nonReasoningOutputTokens semantics as TokenUsage, scoped to deduplicated turn-local receipts only | P0 |
| `conductor.resultRecords` | Distinct retained terminal SDK result records after UUID/message-ID deduplication | P0 |
| `conductor.reportedTurns` | A single receipt's SDK `num_turns`; null when absent or multiple receipts; not human turns | P0 |
| `conductor.durationMilliseconds` | A single receipt's `duration_ms`; null when absent or multiple receipts; distinct from the session wall span | P0 |
| `conductor.apiDurationMilliseconds` | A single receipt's `duration_api_ms`; null when absent or multiple receipts | P0 |
| `conductor.permissionDenials` | A single receipt's denial-array length; null when absent or multiple receipts; no denial objects escape | P0 |
| `conductor.errorResults` | Count of results with `is_error === true`; not a task-failure verdict | P0 |
| `conductor.terminalReasons` | Counts keyed only by `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`, `completed`, `cancelled`, `interrupted`, or `unknown`; all other values map to `unknown` | P0 |
| `transcript.sourceDeleted` | Optional `true`: these are last-ingested facts whose source was removed; absent for current evidence and `--no-index` output. Prices/parser results are frozen at last ingest | P0 |
| `transcript.startTimeKnown` | Optional false when the displayed creation date cannot establish a session start; bounded start-date filters exclude it | P0 |

Structured metadata is validated before aggregation and warning construction. Model IDs use a separate bounded grammar that preserves namespaces (including `org/model` and `@cf/vendor/model`) and exact rate keys, while rejecting filesystem, URL, whitespace/control, and credential shapes. Tool identifiers exclude prototype keys. Rejected model/tool values become fixed unknown labels; timestamps must parse as bounded ISO date-time forms. Private correlation IDs and ownership fingerprints remain inside the worker.

### Session metrics (`SessionMetrics`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `userTurns` | Human turns (tool results are not turns); Cursor SDK counts started runs as observed run turns. Zero is a placeholder when `evidence.turns` is unavailable | P0 |
| `assistantMessages` | Distinct assistant messages or agent messages | P0 |
| `modelCalls` | Priced or unpriced model requests with positive usage; zero placeholders for summary/activity sources with unavailable request counts (see `evidence.usageUnit`) | P0 |
| `toolCalls` | Effective tool calls | P0 |
| `transportToolCalls` | Tool calls before code-mode expansion | P0 |
| `compactions` | Context compaction boundaries | P0 |
| `summaries` | Summary boundaries (Claude) | P0 |
| `taskStarts` | Task-start markers (Codex), started SDK runs (Cursor), or assistant-turn starts (Copilot) | P0 |
| `taskCompletions` | Task-complete markers (Codex), finished SDK runs (Cursor), or assistant-turn ends (Copilot); not proof of task success | P0 |
| `queueOperations` | Queued-input operations (Claude) | P0 |
| `delegatedAgents` | Distinct delegated agents observed (Claude) | P0 |
| `durationMilliseconds` | Legacy session start to last event; added sources use recorded start/end metadata. Zero is an unavailable placeholder for `file-mtime` evidence | P0 |
| `eventSpanMilliseconds` | First event to last event | P0 |
| `maxContextWindow` | Largest observed Codex window or reviewed Claude model capacity | P0 |
| `maxInputTokensPerCall` | Largest input of a single request | P0 |
| `contextUtilizationPeak` | Maximum paired request-input/window ratio over eligible deduplicated requests, or `null`; Claude's reviewed capacities are estimates | P0 |

### Token usage (`TokenUsage`)

Appears as `session.tokens` and inside every model usage entry.

| Field | Meaning | Tier |
| --- | --- | --- |
| `inputTokens` | Processed input: uncached input plus cache reads plus cache writes | P0 |
| `uncachedInputTokens` | Input billed at the base input rate | P0 |
| `cachedInputTokens` | Cache-read input | P0 |
| `cacheWriteInputTokens` | Cache-write input where the source records it | P0 |
| `cacheWrite5mInputTokens` | Cache writes with a 5-minute TTL | P0 |
| `cacheWrite1hInputTokens` | Cache writes with a 1-hour TTL | P0 |
| `outputTokens` | Output, including reasoning | P0 |
| `reasoningOutputTokens` | Reasoning or thinking output, where recorded separately | P0 |
| `nonReasoningOutputTokens` | Output explicitly classified as non-reasoning; the remainder after both known classes is unknown | P0 |

### Cost breakdown (`CostBreakdown`)

Appears as `session.cost` and inside every model usage entry. All values are USD.

| Field | Meaning | Tier |
| --- | --- | --- |
| `inputUsd` | Uncached input value | P0 |
| `cachedInputUsd` | Cache-read value | P0 |
| `cacheWriteUsd` | Cache-write value | P0 |
| `outputUsd` | Output value | P0 |
| `totalUsd` | Sum of the components, or the reported total for Cursor composer/Conductor evidence (without an invented component allocation) | P0 |
| `upperEstimateUsd` | Total plus configured uncertainty: unobservable cache writes, and for added adapters aggregate context premiums or unknown write TTL | P0 |

### Model usage (`ModelUsage`)

Appears in `session.models[]` and every `spendByModel[]`. Includes every `TokenUsage` and `CostBreakdown` field, plus:

| Field | Meaning | Tier |
| --- | --- | --- |
| `model` | Bounded model ID; `<unknown>` for absent or rejected values, retaining their token counters, and for provider-reported value without a supported model allocation | P0 |
| `calls` | Requests attributed to this model; zero when aggregate sources cannot establish request counts | P0 |
| `priced` | `true` when every observed token class has an explicit rate across all requests, or when the model row carries an explicit provider-reported value (including recorded zero) | P0 |
| `pricing[]` | Distinct rate provenance used across this model's requests; empty when no request was API-priced; see below | P0 |
| `pricingCoverage.pricedTokens`, `pricingCoverage.eligibleTokens` | Explicitly priced and eligible observed token counts for API usage; estimated cache classes and unknown models remain in the denominator only; absent for provider-reported usage | P0 |

### Pricing provenance (`RateProvenance`)

Present on current rate-card entries and on model usage in sessions, repositories and machine totals. No local paths or raw source records are included.

| Field | Meaning | Tier |
| --- | --- | --- |
| `source` | `models.dev`, `litellm`, or `reviewed` | P0 |
| `kind` | `api`, `reviewed`, or bundled `fallback` | P0 |
| `snapshotDate` | UTC fetch time or reviewed effective date at midnight | P0 |
| `payloadSha256` | SHA-256 of public feed/reviewed-card input bytes; not a local session identifier | P0 |
| `rateModel` | ID of the matching rate entry | P0 |
| `match` | `exact` or `alias` | P0 |
| `temporal` | `at-or-before`, `oldest` (request predates evidence), or `undated` | P0 |
| `assumptions[]` | `anthropic-cache-1h-2x`, `codex-cache-write-upper-1.25x`, `cache-write-upper-multiplier`, `cache-read-at-input`, `cache-write-5m-at-input`, `cache-write-5m-multiplier`, `cache-write-1h-at-5m`, `cache-write-ttl-5m`, `context-cache-read-at-base`, `context-cache-write-5m-at-base`, `context-cache-write-1h-at-base` | P0 |

### Pricing status (`rateCard.pricing`, `rates show/status`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `offline` | Whether public price fetching is disabled | P0 |
| `policy` | `reviewed-first`, `api-first`, or `reviewed-only` | P0 |
| `refreshAfterDays` | Configured stale threshold | P0 |
| `newestSnapshotAt`, `ageDays` | Latest API observation time and age; null without a cache | P0 |
| `stale` | Whether any enabled source is missing/old; false for pinned reviewed-only mode | P0 |
| `snapshots` | Number of retained, usable API observations in this configuration | P0 |
| `sources[].source`, `sources[].url` | Enabled source enum and fixed public endpoint | P0 |
| `sources[].fetchedAt`, `sources[].payloadSha256` | Latest source observation and full payload hash, or null | P0 |
| `sources[].ageDays`, `sources[].stale` | Per-source age (null when unavailable) and staleness | P0 |
| `sources[].models`, `sources[].rejectedModels` | Valid and rejected model-entry counts in the latest observation | P0 |
| `warnings[]` | `cache-unavailable`, `invalid-snapshot`, `large-price-change`, `rejected-models` | P0 |

### Rates CLI output

All fields below are **P0**. `rates status` returns `status` as above plus `coverage`. `rates show` returns `currency: USD`, `status` and `models[]`. `rates diff` returns `comparisons[]` and `changes[]`. `rates update` returns an enumerated result status, per-source results, and changes. The cache directory and local scan options are internal-only.

| Field | Meaning | Tier |
| --- | --- | --- |
| `coverage.modelsSeen`, `coverage.modelsPriced` | Distinct observed API-model IDs and those matched by current rates | P0 |
| `coverage.ratio` | Priced/seen fraction; null when the denominator is zero | P0 |
| `coverage.bySource[].source`, `coverage.bySource[].models` | Source enum and count of local IDs priced by that source | P0 |
| `coverage.unpricedModels[]` | Bounded observed model IDs without a matching current rate; rejected/absent values collapse to `<unknown>` | P0 |
| `models[].model`, `models[].provenance` | Requested/current model ID and rate evidence | P0 |
| `models[].rate.provider`, `models[].rate.source` | Rate's provider enum and public source URL | P0 |
| `models[].rate.inputPerMillion`, `outputPerMillion`, `cachedInputPerMillion`, `cacheReadPerMillion`, `cacheWrite5mPerMillion`, `cacheWrite1hPerMillion` | Allowlisted USD/million numeric rates | P0 |
| `models[].rate.cacheWriteMultiplier`, `cacheWriteObservable` | Reviewed/derived upper-estimate configuration | P0 |
| `models[].rate.longContext.inputMultiplier`, `outputMultiplier`, `thresholdInputTokens` | Reviewed per-request premium configuration | P0 |
| `models[].rate.contextTiers[].aboveInputTokens`, `inputPerMillion`, `outputPerMillion`, `cacheReadPerMillion`, `cacheWrite5mPerMillion`, `cacheWrite1hPerMillion` | Absolute tier rates and strict per-request threshold | P0 |
| `models[].rate.assumptions[]` | Normalized rate conventions: derived Anthropic one-hour price and configured cache-write upper-estimate rule | P0 |
| `models[].rate.contextTiers[].assumptions[]` | Optional `anthropic-cache-1h-2x` on a tier with a derived one-hour cache price; request provenance uses the applied tier | P0 |
| `comparisons[].source`, `before`, `after` | Source and previous/latest timestamps; null when unavailable | P0 |
| `changes[].source`, `model`, `change`, `large` | Source, model ID, `added`/`removed`/`changed`, and large-change flag | P0 |
| `changes[].before`, `after` | Full normalized rates as above; null for a missing side | P0 |
| update `status` | `updated`, `partial`, `failed`, `offline`, `reviewed-only` | P0 |
| update `sources[].source`, `status`, `models`, `rejectedModels` | Source enum, `updated`/`failed`, accepted/rejected counts | P0 |

`test/pricing.test.ts` plants sentinel content in feed descriptions/links/extra fields and inspects actual HTTP requests from a loopback fixture server. `test/pricing-accounting.test.ts` carries transcript sentinels through history selection, API projection, aggregation, report and rates status. Only fixed source URLs and explicitly projected fields survive. Corrupt payloads/errors do not enter output. `test/pricing-review.test.ts` injects invalid model values into Claude/Codex metadata and verifies CLI text/JSON, actual API responses and the actual Pricing renderer, retaining eligible tokens. It also tests report failures in both modes with missing/invalid cards and a crashed worker. `test/pricing-usage.test.ts` rejects sentinel assumption strings at the new tier boundary.

### Velocity cells (`SessionVelocity`)

Every new field is projected from counters or fixed enums. Dates/hours and finer agent
mix increase temporal detail; the explicit timezone is P1 because it can disclose a
region. Repository and session keys are inherited from the enclosing P1 session and are
not repeated inside cells. No event ID, agent ID, parent ID, command, nickname or custom
agent name is exported. Synthetic sentinel tests cover metadata, streamed content, tool
inputs, invalid timestamps and spawned-agent objects on the same API/JSON projection.
Usage-free and tool-only Claude/Codex fixtures also plant forbidden model labels and
assert their absence through both the capped isolated worker and HTTP API; usage and
fallback fixtures cover all three providers. No new snapshot fields are needed for
the browser's daily, period and group evidence guards.

| Field | Meaning | Tier |
| --- | --- | --- |
| `dimensions[]` | Per-session dictionary of observed dimension combinations | P0 |
| `dimensions[].agent` | Fixed enum: `claude-cli`, `claude-sdk`, `claude-desktop`, `claude-unknown`, `claude-general-purpose`, `claude-explore`, `claude-plan`, `claude-subagent`, `codex-cli`, `codex-exec`, `codex-vscode`, `codex-desktop`, `codex-subagent`, `codex-review`, `codex-unknown`, `cursor`, `copilot`, `opencode`, `gemini`, `antigravity` | P0 |
| `dimensions[].model` | Bounded model ID matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, otherwise `<unknown>`; never inferred from text | P0 |
| `dimensions[].executionKind` | `top-level`, `subagent`, or `unknown`; no mixed cells | P0 |
| `dimensions[].effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, or `unknown` | P0 |
| `buckets[][0]` | Local `YYYY-MM-DD` date of evidenced activity | P0 |
| `buckets[][1]` | Local clock hour, integer 0–23 | P0 |
| `buckets[][2]` | Index into `dimensions` | P0 |
| `buckets[][3]` | Fixed tuple of counters, defined below | P0 |
| `undated[][0]` | Dimension index for activity without an absolute timestamp | P0 |
| `undated[][1]` | Same counter tuple, excluded from dated charts | P0 |
| `sessionDated[][0]` | Optional. Local `YYYY-MM-DD` date of the session's last evidenced activity, for value the source records without its own request/run time | P0 |
| `sessionDated[][1]` | Local clock hour of that activity, integer 0–23 | P0 |
| `sessionDated[][2]` | Index into `dimensions` | P0 |
| `sessionDated[][3]` | Same counter tuple, included in dated totals and labeled session-dated | P0 |
| `values[0]` | Priced value in USD | P0 |
| `values[1]` | Processed input tokens | P0 |
| `values[2]` | Uncached input tokens (legacy Cursor unsplit allocation; coverage remains unavailable) | P0 |
| `values[3]` | Cache-read input tokens | P0 |
| `values[4]` | Cache-write input tokens | P0 |
| `values[5]` | Output tokens, including reasoning | P0 |
| `values[6]` | Separately recorded reasoning tokens | P0 |
| `values[7]` | Model calls | P0 |
| `values[8]` | Effective tool calls | P0 |
| `values[9]` | Public sessions started | P0 |
| `values[10]` | Observed tokens in classes with explicit rates; coverage numerator. Estimated or unavailable classes remain outside this count even when other classes in the request are priced | P0 |
| `values[11]` | Output with reasoning exposed by the charged usage; a cumulative difference requires both endpoints; coverage numerator | P0 |
| `values[12]` | Input with cache reads exposed by the charged usage; a cumulative difference requires both endpoints; coverage numerator | P0 |
| `values[13]` | Input tokens with a cache-write counter; coverage numerator | P0 |

`values` means the tuple in `buckets[][3]`, `sessionDated[][3]` or `undated[][1]`; it is not another JSON key.
Week/month/hour series, rolling means, changes, movers and projection bands are computed
in the browser from these cells and are not additional exported fields. Definitions,
minimum-activity guards and unknown-data rules are in [metrics.md](metrics.md#velocity-snapshot-version-1).

### Dashboard pending analytics fields

`/api/analytics?wait=10` may return HTTP 202 with only `pending: true` and `progress`.
Progress is transient and content-free; it never includes provider names, paths, session IDs or errors.

| Field | Meaning | Privacy tier |
| --- | --- | --- |
| `pending` | Fixed boolean `true` while the scan runs | P0 |
| `progress` | Current scan counters, or null when no scan is running | P0 |
| `progress.phase` | Fixed vocabulary: `discover`, `parse`, `combine` | P0 |
| `progress.done` | Nonnegative integer completed work units | P0 |
| `progress.total` | Nonnegative integer known work units, or null | P0 |
| `progress.startedAt` | Server-generated UTC scan start timestamp | P0 |
| `progress.fullParse` | Boolean: this index is parsing all history again | P0 |

### Health endpoint

`GET /api/health` returns `{ service: "session-analytics", dataSource: "live" | "snapshot", snapshot: "ready" | "building" | "not-started", status: "ok", instanceToken: "<64 hex characters>", optionsHash: "<64 hex characters>", scanHash: "<64 hex characters>", version: "X.Y.Z" }`. All fields are P0 and carry no local evidence. `instanceToken` is random per launch; `optionsHash` is the SHA-256 of normalized analysis options, including a digest of the machines read; `scanHash` is the same without the machines, so a launch can say that only the machines differ; `version` is the tool version, also shown in the dashboard footer. None returns paths, option values, snapshot filenames or transcript data. Live port reuse requires the same version, the same options hash and a token matching `dashboard-PORT.token` in the private data directory; a launch that finds another version prints the running version only when it matches the release grammar (`X.Y.Z` with an optional short prerelease suffix). Each dashboard writes its token even with `--no-index` or `--snapshot`; this does not open or write the index. Tokens are replaced on the next launch on that port and contain no retained analytics.

| Optional health field | Meaning | Tier |
| --- | --- | --- |
| `pricing.updateAvailable` | Boolean: normalized public rates changed since the last acknowledged scan; no model inventory or local evidence | P0 |
| `pricing.fetchedAt` | Newest successful enabled-source fetch time as ISO timestamp, or null | P0 |

`pricing` is present only on live dashboards with public updates enabled; offline, reviewed-only, custom-card and saved-snapshot dashboards omit it. These hints are never added to saved analytics or CLI pricing status.

### Limits endpoint (`LimitsSnapshot`)

`GET /api/limits` and `limits --json` return the limits snapshot defined in [`src/limits/types.ts`](../src/limits/types.ts). It is live-only: it is never written into a saved, shared, exported, remote or MCP snapshot, and `--snapshot` dashboards serve an empty one.

| Field | Contents | Tier |
| --- | --- | --- |
| `schemaVersion`, `generatedAt`, `dataSource`, `persisted`, `ledger`, `codexAccount` | Format version, harvest time and fixed status enums | P0 |
| `plans` | Deprecated: the plan enum of each provider's most recently active account | P0 |
| `sources[]` | Source enum, `ok`/`empty`/`unavailable`, readings read this harvest, latest reading time | P0 |
| `observations[]` | Provider, account key, bounded meter ID, window minutes, reset and observation times, used percent, status and source enums | P0/P1 |
| `meters[]` | Provider, account key, meter ID, display label, window minutes, last reading time, retired flag. Labels are fixed text, the bounded meter ID, or a Codex `limit_name` matching `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$` | P0/P1 |
| `accounts[].key` | Account key: `claude-`/`codex-` and the first 16 hex characters of an unkeyed, domain-separated SHA-256 of the Claude organization and account IDs or the ChatGPT account ID, computed inside the reader. The same login has the same key on every machine, so keys are linkable across machines. `claude-p-`/`codex-p-` keys hash a profile's real path while its login is unknown; `claude-w-<minute of the week>` groups unattributed Claude readings by weekly reset; `""` is unattributed | P1 |
| `accounts[].profileNames`, `accounts[].label` | **Local-only.** Names of the profile directories logged into the account (`default`, or the directory name without `.claude-`/`.codex-` when it matches `^[A-Za-z0-9._-]{1,40}$`, else `profile`), this machine's when it reports the account, else the first other machine's, and a label built from the plan and those names. Directory names can identify an employer or client, so they never leave `limits` output and the loopback API, and are never stored; another machine's arrive only in its live `limits --json` answer | P1 |
| `accounts[].profileKeys` | Pseudonymous profile keys: for Claude the same `profile-<20 hex>` as `session.historyProfile.profileKey`, for Codex the same hash over the `CODEX_HOME` path | P1 |
| `accounts[].provider`, `attribution`, `plan`, `planSource`, `planEvidence` | Enums; plan evidence is the five allowlisted `oauthAccount` enums or the raw Codex `plan_type`, each matching `^[a-z0-9_]{1,48}$` | P0 |
| `accounts[].extraUsage`, `accounts[].codex` | Claude extra-usage enum, reason enum and time; Codex credit balance, `ordinaryUsageAllowed`, banked reset count with status, scope, grant and expiry times | P0 |
| `accounts[].weeklyAnchor`, `accounts[].lastSeen`, `accounts[].planObservedAt` | Latest weekly reset instant, latest reading time, and when the plan was first read as it is (Claude) or reported (Codex) | P0 |
| `accounts[].machines[]` | Only when limits were read from several machines: per machine logged into the account, its `key` (as in [Machine status](#machine-status-machinestatus)) and its pseudonymous profile keys, Claude ones as the combined snapshot names them (in `limits`, which reads no snapshot, remapped among the profiles that report limits) | P1 |
| `machines[]` | Only when limits were read from several machines: this machine first, then each other machine with its `key`, `label`, `state` (`ok`, `stale`, `failed`, `reading`), fixed `reason` enum, `fix` command built from the saved configuration, `readAt` and `durationMs`. In a single machine's own `limits --json --no-remote --identify-machine` answer, that machine alone with `identity`, the 16-hex hash of its machine ID (or host name, marked `host-`) and account UID, used by the reading machine to recognise the same machine read twice and then dropped | P0/P1 |
| `resetCreditHistory[]` | `[provider, account key, observedAt, available]` rows recorded when the banked count changes | P0/P1 |

### Browser storage

The dashboard stores the selected view (`session-analytics-view`), theme (`session-analytics-theme`), density (`session-analytics-density`), shortcut preference (`session-analytics-shortcuts`), and Subscription plan and payer overrides (`session-analytics.subscription-plan.<account key>` and `session-analytics.subscription-payer.<account key>`: a pseudonymous account key with a plan ID or `individual`/`organization`, written only when you choose one). Theme and density are saved only when you change them; the system theme and one-visit `?theme=`/`?density=` URL values are not saved. The time window and session data are not persisted in browser storage. The removed Insights view’s legacy decision key is no longer read or written.

The address bar records the current view, window preset, custom start and end dates, and the focused repository's opaque ID (`?view=`, `?window=`, `?start=`, `?end=`, `?repo=`), so reload and Back/Forward restore them; the browser's history keeps these loopback URLs like any other. Repository names and paths are never written to the URL (a name is still accepted when reading an older `?repo=` link).

### MCP fields

The following additive fields are declared in `src/mcp/types.ts` and re-exported by `src/types.ts`. Their formulas and missing-evidence semantics are in [MCP query semantics](metrics.md#mcp-query-semantics). All text descriptions, status strings, warnings and protocol errors below are fixed or enumerated unless explicitly identified as a bounded metadata name.

#### Session evidence (`McpSessionEvidence`)

These fields also appear in the existing JSON/API session projection when supported; the collector never returns its raw join IDs.

| Field under `mcpEvidence` | Meaning | Tier |
| --- | --- | --- |
| `activityState` | Recorded lifecycle enum: active, settled or unknown; never an inferred success | P0 |
| `pricingByDay[].day` | Valid UTC accounting date shared with the spend ledger | P0 |
| `pricingByDay[].eligibleTokens`, `.pricedTokens` | Deduplicated API token operands, including unpriced requests | P0 |
| `undatedTokens` | API tokens with no valid accounting date | P0 |

#### Common tool envelope (`McpPayload`)

| Field | Meaning | Tier |
| --- | --- | --- |
| `schemaVersion` | MCP payload schema, currently 1 | P0 |
| `tool` | One of six published tool names | P0 |
| `snapshot.generatedAt` | ISO snapshot generation time | P0 |
| `snapshot.ageSeconds` | Nonnegative age at query time | P0 |
| `snapshot.ttlSeconds` | Configured in-memory cache TTL | P0 |
| `scope.kind` | `repository` or `machine` | P0 |
| `scope.repositoryId` | Pseudonymous repository key or null | P1 |
| `sourceHealth[].provider`, `.status` | Fixed provider and discovery status enums; unknown for older snapshots | P0 |
| `sourceHealth[].sourcesRead`, `.missingSources`, `.unreadableSources` | Source counts independent of the selected session cohort | P0 |
| `window.name` | Enumerated window | P0 |
| `window.since`, `window.until` | ISO query bounds; lower bound null for all history | P0 |
| `window.timezone` | Always `UTC` | P0 |
| `window.basis` | `session-start` or `activity-day` | P0 |
| `totals` | Selected cohort totals below | P0 |
| `notes[]` | Fixed interpretation/coverage notes | P0 |
| `data` | One tool-specific projection listed below | P0/P1 |

#### Reused totals, values, ratios and distributions

| Field | Meaning | Tier |
| --- | --- | --- |
| `McpTotals.basis` | Always `session-start`, distinct from activity-day budget periods | P0 |
| `McpTotals.sessions`, `.analyzedSessions`, `.workingSnapshots` | Selected, analyzed and working counts | P0 |
| `McpTotals.inputTokens`, `.outputTokens` | Observed token sums; null for unattributed Cursor model groups | P0 |
| `McpTotals.userTurns`, `.toolCalls` | Session counter sums; null for model groups | P0 |
| `McpTotals.value` | Separated value/coverage object | P0 |
| `McpValue.apiEquivalentUsd`, `.apiUpperEstimateUsd` | API-basis value and upper estimate | P0 |
| `McpValue.providerReportedUsd` | Provider-reported local value, separate basis | P0 |
| `McpValue.pricingCoverage` | Ratio object for priced/API-eligible tokens | P0 |
| `McpValue.unpricedTokens` | API-eligible tokens without a rate | P0 |
| `McpRatio.value` | Fraction or compactions per session; null when unavailable/too small | P0 |
| `McpRatio.numerator`, `.denominator`, `.minimumDenominator` | Observed operands and sample guard | P0 |
| `McpRatio.status` | `available`, `insufficient-data`, `unavailable` | P0 |
| `McpDistribution.median`, `.p90` | Median/nearest-rank 90th percentile, or null below the sample guard | P0 |
| `McpDistribution.samples`, `.selectedSessions`, `.excludedSessions`, `.minimumSamples` | Measurement sample count, selection denominator, exclusions, guard | P0 |

#### Tool-specific data

| Field under `data` | Meaning | Tier |
| --- | --- | --- |
| `usage_summary`: `groupBy` | Repository/provider/model/agent execution-kind dimension | P0 |
| `groups[].key` | Repository hash (P1), or provider/model/execution-kind identifier (P0) | P0/P1 |
| `groups[].totals`, `totalGroups`, `nextOffset` | Per-group totals, full group count and next page/null | P0 |
| `repo_profile`: `sessions` | Selected repository session count | P0 |
| `activityStates.active`, `.settled`, `.unknown` | Selected session counts by observed lifecycle; only settled sessions enter distributions | P0 |
| `apiEquivalentUsd`, `providerReportedUsd`, `userTurns`, `durationMilliseconds` | Distribution objects on the named bases | P0 |
| `cacheHitRate`, `compactionsPerSession` | Ratios with supported-provider denominators | P0 |
| `toolMix[].name` | Bounded tool names | P0 |
| `toolMix[].calls`, `omittedTools` | Observed counts and names beyond the list cap | P0 |
| `compare_agents`: `agents[].provider`, `.totals`, `.profile` | Fixed provider enum and the same totals/profile objects | P0 |
| `tool_stats`: `tools[].name`, `.calls` | Bounded tool name and effective call count | P0 |
| `totalTools`, `nextOffset` | Full tool count and next page/null | P0 |
| `recent_sessions`: `sessions[].sessionKey`, `.repositoryId` | Existing pseudonymous session/repository keys | P1 |
| `sessions[].provider`, `.executionKind`, `.workingSnapshot` | Fixed provider/execution enums and snapshot flag | P0 |
| `sessions[].startedAt`, `.lastEventAt`, `.durationMilliseconds` | Validated timestamps/duration or null | P0 |
| `sessions[].models`, `.omittedModels`, `.value` | Bounded model identifiers, excess-model count and separated value object | P0 |
| `totalSessions`, `nextOffset` | Full selected session count and next page/null | P0 |
| `budget_status`: `today`, `week` | UTC activity-day period objects | P0 |
| `today/week.since`, `.until`, `.apiEquivalentUsd` | Period bounds and dated API value | P0 |
| `today/week.pricingCoverage` | Dated priced/eligible token ratio qualifying the period value and burn rate | P0 |
| `today/week.unpricedTokens`, `.undatedTokens` | In-period unpriced tokens and all scoped API tokens without a date; null when operands unavailable | P0 |
| `today/week.datedSessions`, `.undatedSessions` | API sessions with a dated value/token entry in-period; all scoped sessions without applicable daily ledgers | P0 |
| `today/week.excludedProviderReportedUsd` | All-history scoped reported value excluded because timing is unavailable | P0 |
| `today/week.elapsedHours`, `.apiEquivalentUsdPerHour` | UTC wall-hour denominator and guarded historical burn rate/null | P0 |

#### Worker output and protocol wrapper

The MCP worker returns `{analytics}`, the allowlisted machine snapshot above, to its parent over an anonymous pipe. It reads no skill directories or MCP-server configuration.

The MCP wrapper contains standard JSON-RPC `jsonrpc`, caller-chosen `id` (protocol correlation only), `result` or `error`; errors use fixed `code`/`message` and, for unsupported versions, `data.supported`/`requested` protocol dates. Tool results contain `isError`, `content[].type`/`.text` (a fixed-template summary and serialized `McpPayload`), and `structuredContent` (the same payload). Modern results add `resultType` and `_meta.io.modelcontextprotocol/serverInfo`. Discovery/initialization contain only static product/version identifiers, protocol versions, tool capability declarations, instructions and catalog cache hints (`ttlMs`, `cacheScope`). `tools/list` returns static names/descriptions, JSON input schemas and read-only/idempotent/closed-world annotations. These are P0 and carry no local-history identifiers; caller request IDs are echoed as required by JSON-RPC, never used to query history.

### Index management status (`IndexStatus`)

`index status --json` returns these fields, with no data-directory or evidence path. Counts are index rows across isolated source scopes, not deduplicated machine metrics.

| Field | Meaning | Tier |
| --- | --- | --- |
| `state` | `ready`, `missing`, `corrupt`, or `incompatible` | P0 |
| `schemaVersion` | SQLite schema version, or `null` when unavailable | P0 |
| `sessions`, `sourceDeletedSessions` | Stored session facts and the subset marked source-deleted | P0 |
| `evidenceFiles`, `scopes` | Stored fingerprint rows and source scopes containing sessions | P0 |
| `databaseBytes` | Main SQLite file size; excludes WAL/SHM and quarantines | P0 |
| `lastScan` | Most recently committed ingest statistics, or `null` | P0 |
| `lastScan.completedAt` | UTC completion timestamp | P0 |
| `lastScan.fingerprintedFiles` | Unique transcript files fingerprinted during this ingest | P0 |
| `lastScan.parsedSessions`, `.reusedSessions` | Claude/Codex composite sessions parsed or reused, including reuse of exclusion checkpoints; Cursor refreshes are excluded | P0 |
| `lastScan.retainedSessions` | Prior sessions returned after source absence/unavailability | P0 |
| `lastScan.deferredSessions` | Session groups in unstable ownership components; prior facts/exclusions were preserved together | P0 |
| `lastScan.ledgerReads`, `.ledgerHits`, `.ledgerAppends` | Codex ledger files read, reused, and the read subset continued from a verified prefix | P0 |
| `lastScan.auditedSessions`, `.auditedLedgers` | Cached native session/ledger projections independently reparsed and matched in the rotating verification sample; zero for older scan records | P0 |
| `lastScan.elapsedMilliseconds` | Ingest wall time after opening the index, excluding process startup | P0 |

## What this does not protect against

- **Your own account.** Anyone or anything that can read your home directory can read the raw transcripts directly. This tool does not encrypt, move, or delete provider history.
- **Other local processes.** Any process on your machine can request `http://127.0.0.1:<port>/api/analytics` while the dashboard runs. It receives the same content-free snapshot you see.
- **Identifying metadata.** Repository names, model IDs, and timestamps can be sensitive. A repository named after an unannounced project reveals that name. Review a JSON snapshot or screenshot before sharing it; for public material, use the synthetic demo (`npm run demo`).

## Changing the contract

A pull request that adds or changes a public field must:

1. add the field to the public types in `src/types.ts` and populate it explicitly (no spreading of provider records);
2. add a row to the field manifest above, with its tier;
3. define its semantics in [metrics.md](metrics.md);
4. add or extend a test that plants sentinel content in the relevant provider records and asserts it does not appear in the serialized output.

Fields in P2 or P3 additionally need an explicit opt-in that is off by default.

### Interchange metadata and export fields

All formats retain only the declared P0/P1 fields; no content is exported. These fields extend the manifest above; the complete contracts and wire mappings are in [interop.md](interop.md). The two published schemas reject unknown nested fields. Snapshot import enforces hashed key syntax, fixed status labels, approved warning templates, bounded model/tool names, and numeric reconciliation. Removed analysis fields in older snapshots are dropped on load without validation; see [interop.md](interop.md#versioned-snapshots). Repository names and otherwise valid identifiers still require trusted provenance: syntax cannot certify their meaning. Arbitrary warning/error/status text and raw repository UUIDs are rejected.

| Field / surface | Meaning | Tier |
| --- | --- | --- |
| `schemaVersion` (machine/repository JSON, shared JSON, every CSV and NDJSON record; OTLP resource attribute) | Always `1` for this contract | P0 |
| CSV `sessionKey`, `repositoryId`, `repositoryName` | Existing public identity fields, unchanged for local exports | P1 |
| CSV `transcriptStatus` | Flattened `session.transcript.status` | P0 |
| CSV `machine` (`sessions.csv`) | The session's machine `key` in a snapshot that combines machines, as in session `machine`; empty for one machine | P1 |
| CSV `day`, `tool`, `model`, `calls` | Existing date/tool/model labels and counters at the documented table grain | P0 |
| CSV `contributingSessions` | Sessions contributing an entry to a daily/model/tool row | P0 |
| Other CSV columns | Flattened existing session/token/cost/metric fields, with original units and cost basis | P0/P1 as above |
| NDJSON `kind` | `snapshot`, `repository`, or `session`; remaining fields are existing public fields | P0 |
| Filtered JSON `warnings[]` | Preserved fixed discovery caveats, regenerated selection coverage notes, and an appended filtering explanation | P0 |
| `/api/health.dataSource` | Fixed `live` or `snapshot` label used to prevent cross-source server reuse; never the snapshot filename | P0 |
| `/api/health.service`, `.snapshot`, `.status` | Fixed service ID, readiness enum and `ok` status; no local evidence | P0 |
| `/api/health.instanceToken` | Random per-launch 32-byte token encoded as hex, checked against the private per-port token file for reuse; no local evidence | P0 |
| `/api/health.optionsHash` | SHA-256 of normalized analysis options; only the digest, with no paths, option values or local evidence | P0 |
| `/api/health.scanHash` | The same digest without the machines read, so a launch can say that only the machines differ; no paths, option values or local evidence | P0 |
| `/api/health.version` | Tool version, required to match before a running dashboard is reused; no local evidence | P0 |
| `/api/machines` | `{ machines: MachineStatus[] }`, each machine's current state for a dashboard reading other machines; an empty list otherwise. The same fields as [Machine status](#machine-status-machinestatus), without `identity` | P0/P1 |
| Shared JSON `kind`, `minimumSessions` | `shared`; minimum distinct session count required for every released bucket | P0 |
| Shared `sources[]` | Domain-separated HMAC installation identities, 128 bits; used to reject repeated contributions | P1 |
| Shared `repositories[].repository` | `repo-<128-bit HMAC>` or `alias-<explicit user alias>`; no original ID/name | P1 |
| Shared `repositories[]` and `summary`: `sessions`, `inputTokens`, `outputTokens`, `pricedTokens`, `priceableTokens`, `apiEquivalentSpendUsd`, `providerReportedSpendUsd`, `estimatedUpperSpendUsd`, `toolCalls`, `compactions` | Additive counters, restricted to retained buckets; no global total that includes suppressed buckets | P0 |
| Shared browser CSV `repository` and all shared counter columns | Same released aggregates; no added identity | P0/P1 as above |
| OTLP `resourceLogs[].resource.attributes`: `service.name`, `session_analytics.schema.version` | Fixed neutral service name and format version | P0 |
| OTLP `scopeLogs[].scope`: `name`, `version`, attributes `session_analytics.semconv.version`, `session_analytics.semconv.commit`; `scopeLogs[].schemaUrl` | Fixed exporter/package and pinned convention identifiers | P0 |
| OTLP `logRecords[]`: `timeUnixNano`, `observedTimeUnixNano`, `body.stringValue` | Snapshot observation time and fixed label `Observed session usage aggregate` | P0 |
| OTLP `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.model` | Existing usage counters and a model only when fully attributable | P0 |
| OTLP `session_analytics.repository.key`, `session_analytics.session.key` | Existing pseudonymous local keys; repository names omitted | P1 |
| OTLP `session_analytics.machine.key` | Only in a snapshot that combines machines: the session's machine `key`, as in session `machine` | P1 |
| OTLP `session_analytics.provider`, `.record.type`, `.cost.basis`, `.transcript.status` | Source enum and fixed interpretation/evidence labels | P0 |
| OTLP `session_analytics.usage.cache_read_tokens`, `.cache_write_tokens`, `.reasoning_tokens`, `.value_usd`, `.upper_value_usd`, `session_analytics.tool.calls`, `.model.calls`, `.pricing.coverage` | Existing counters/value/coverage; cache and reasoning counters are subsets, not extra tokens | P0 |

The HMAC key, alias-file lookup keys, snapshot/input/output paths, collector URL, credentials, and collector response/error text are not public fields. Aliases are deliberately shared identifiers and can be identifying even if their syntax is bounded. Shared files omit timestamps, session rows, model/tool names, fine-grained slices, source rate links, and warnings. Empty shared files have empty source lists and all-zero totals.

### Sharing and optional delivery boundary

`report --share` produces a local preview: stdout contains exactly the JSON payload, and nothing is transmitted. The threshold defaults to five distinct sessions per repository bucket; it is **not person-level k-anonymity**. A single person can produce every session. Repeated overlapping releases, distinctive totals, and outside information can identify activity; this is not differential privacy. Use neutral aliases and review a single contribution per source before sharing. No grand total includes suppressed rows. Merge accepts only validated shared aggregates at the same threshold and rejects repeated source pseudonyms, including transitively through earlier merges. Pseudonyms are linkable and are not authentication; different keys or copied evidence can defeat overlap detection.

A private 32-byte random sharing key is the only new persistent secret. Its default location is `$XDG_STATE_HOME/session-analytics/sharing.key` or `~/.local/state/session-analytics/sharing.key`; an explicit file option/environment override is supported. It is created with mode 0600, never exported, and symlink/public-permission keys are rejected. Files are opened exclusively to prevent overwrite. Existing output directories should be private and user-controlled. CSV neutralizes spreadsheet formulas in text cells. Browser downloads use local Blobs, no upload endpoint and no extra browser storage.

Only `export --format otlp-json --otlp-endpoint URL` can POST telemetry. It first saves the exact allowlisted payload locally. It requires HTTPS except loopback HTTP, rejects embedded credentials, does not follow redirects, and does not retry or print collector text. OTLP remains a P0/P1 **session-level** export, not the thresholded sharing format. It includes local pseudonymous session/repository keys and possibly model IDs. The CLI flag authorizes that delivery; normal analysis, sharing previews, merge, the dashboard, and file-only exports never send it. This is an explicit delivery boundary independent of pricing: dashboard startup refreshes stale fixed public price feeds unless `--offline` is set. Offline disables pricing requests, not an explicitly requested OTLP delivery.

Shared totals always carry a CLI/dashboard caveat that they are observed lower bounds and may include running and partially parsed sessions. Pricing coverage does not establish evidence completeness. No new completeness flags, rare subgroup counts, or suppressed totals enter shared files. New fixed parser warnings cover omitted malformed metadata and cache-write totals reconciled from recorded TTL buckets.

### Integrated MCP summaries (`McpPayload.metrics`)

These optional, bounded summaries use the selected sessions. The envelope contains only `basis`, `pricing` and `velocity`. No names, paths, commands, arbitrary text or unbounded event arrays are added.

| Namespace / fields | Meaning | Tier |
| --- | --- | --- |
| `basis` | Fixed `whole-sessions-selected-by-start` label | P0 |
| `pricing.policy`, `.stale`, `.sources[]` (`source`, `fetchedAt`, `stale`, `models`) | Fixed policy/source enums, dates, freshness and catalog counts | P0 |
| `velocity.coveredSessions`, `.selectedSessions`, `.timeZone`, `.datedApiEquivalentUsd`, `.undatedApiEquivalentUsd`, `.pricedTokens`, `.eligibleTokens` | Ledger coverage across selected sessions; value and token operands include only API-equivalent sessions. Dated value includes activity-dated and session-dated cells; token operands also include undated cells. Timezone is identifying | P0/P1 |

### History recovery and coverage

All new data is P0 counters/enums/model IDs/timestamps except the existing-style pseudonymous profile key (P1). Provider paths, profile directory names, message/session/request IDs and raw exceptions stay private. SQLite projects fixed metadata fields before SDK rows reach the JavaScript parser; message prose, reasoning, tool arguments/results and result text are never selected. Statistics files are read-only, size-bounded and explicitly projected. No network calls, content rules or new secret are introduced. Recovery's public session namespace passes the same schema allowlist into and out of the index.

| Field | Meaning | Tier |
| --- | --- | --- |
| `historyCoverage.version`, `historyCoverage.scope` | Optional machine-wide reconciliation version 1 and fixed machine scope | P0 |
| `historyCoverage.profiles[]` | Discovered/deduplicated Claude statistics profile projections | P0/P1 |
| `historyCoverage.profiles[].profileKey` | `profile-` plus 20 hex characters derived from the canonical profile directory, the same key as session `historyProfile.profileKey`; no raw profile name/path | P1 |
| `historyCoverage.profiles[].ordinal` | Scan-local profile number used for a neutral display label | P0 |
| `historyCoverage.profiles[].machine` | Optional, in snapshots that combine machines: the `key` of the machine holding the profile | P1 |
| `historyCoverage.profiles[].status` | available/missing/unsupported/unreadable statistics status | P0 |
| `historyCoverage.profiles[].dailyTokensVersion` | Numeric daily statistics format version, or null | P0 |
| `historyCoverage.profiles[].statisticsThrough` | Valid UTC-day cache watermark, or null | P0 |
| `historyCoverage.profiles[].firstStatisticsDay` | Earliest valid daily statistics day, or null | P0 |
| `historyCoverage.profiles[].firstTranscriptDay` | Earliest present native transcript event day for this profile; excludes source-deleted index facts | P0 |
| `historyCoverage.profiles[].lifetimeTokens` | Sum of validated lifetime counter observations, potentially repeated per streamed block; not assigned to months | P0 |
| `historyCoverage.profiles[].sessionsWithoutStatisticsCounters` | Indexed native sessions lacking matching stream counters; deduplicated evidence provides a partial subtraction | P0 |
| `historyCoverage.profiles[].months[].month` | UTC `YYYY-MM` month | P0 |
| `historyCoverage.profiles[].months[].models[].model` | Bounded public model ID | P0 |
| `historyCoverage.profiles[].months[].models[].statisticsDays` | Number of reported day/model cells in the comparison | P0 |
| `historyCoverage.profiles[].months[].models[].providerTokens` | Provider-reported stream counter totals over those cells; may repeat requests | P0 |
| `historyCoverage.profiles[].months[].models[].sessionTokens` | Same-profile deduplicated native session tokens (`historyProfile.days[].tokens`) over those cells | P0 |
| `historyCoverage.profiles[].months[].models[].sessionStatisticsTokens` | Same-profile native streamed-block counters, matching the provider statistics basis | P0 |
| `historyCoverage.profiles[].months[].models[].gapTokens` | Sum of daily max(0, provider minus matching session stream counters) | P0 |
| `historyCoverage.profiles[].months[].models[].possibleOverlapTokens` | Conservative share of unknown-profile recovered stream counters reserved once across profiles | P0 |
| `historyCoverage.profiles[].months[].models[].unattributedTokens` | Gap less possible overlap | P0 |
| `historyCoverage.profiles[].months[].models[].pricedUnattributedTokens` | Remainder token estimate covered by explicit rates for the imputed token classes | P0 |
| `historyCoverage.profiles[].months[].models[].unattributedEstimateUsd` | Separately labeled API-equivalent estimate; never included in session/repository totals | P0 |
| `historyCoverage.profiles[].months[].models[].tokenMixSource` | lifetime-model or unavailable estimate basis | P0 |
| `historyCoverage.months[].month` | UTC month across dated session evidence and statistics | P0 |
| `historyCoverage.months[].sessionsWithDatedValue` | Number of distinct sessions supplying a dated monetary observation in this month | P0 |
| `historyCoverage.months[].statisticsCells` | Number of reported profile/day/model statistics cells; zero means comparison unavailable | P0 |
| `historyCoverage.months[].sessionEvidenceUsd` | Actually dated session value from all providers | P0 |
| `historyCoverage.months[].recoveredMessageUsd` | Recovered Claude message value, already included in dated evidence | P0 |
| `historyCoverage.months[].unattributedEstimateUsd` | Sum of profile/model estimates | P0 |
| `historyCoverage.months[].unattributedTokens` | Sum of remaining profile/model gap tokens | P0 |
| `historyCoverage.months[].pricedUnattributedTokens` | Sum of priced remainder token estimates | P0 |
| `historyCoverage.months[].possibleOverlapTokens` | Sum of conservative overlap reservations | P0 |
| `historyCoverage.undatedSessionValueUsd` | Session value with no request day, including result-only summaries | P0 |
| `historyCoverage.unassignedProfileTokens` | Recovered Claude tokens whose profile is unknown, including undated tokens | P0 |
| `historyStatistics.basis` | Fixed `claude-stream-snapshots-v5` counter observation basis; never used to price sessions | P0 |
| `historyStatistics.days[].day`, `historyStatistics.days[].model`, `historyStatistics.days[].tokens` | UTC day, bounded model ID and repeated streamed-block counters for native/recovered Claude sessions | P0 |
| `history.days[].day`, `history.days[].model` | Recovered session UTC day and bounded model ID | P0 |
| `history.days[].tokens`, `history.days[].valueUsd` | Deduplicated recovered input-plus-output tokens and API-equivalent value | P0 |
| `history.undatedTokens`, `history.undatedValueUsd` | Recovered usage without trustworthy request timestamps | P0 |
| `conductor.reconciliation` | Optional message-versus-receipt comparison; result cost is not added to message cost | P0 |
| `conductor.reconciliation.messageValueUsd` | Recovered API-equivalent message value | P0 |
| `conductor.reconciliation.reportedUsd` | Conservative receipt value, or null | P0 |
| `conductor.reconciliation.differenceUsd` | Message minus reported value, or null | P0 |
| `conductor.reconciliation.relativeDifference` | Difference divided by positive reported value, or null | P0 |
| `conductor.reconciliation.status` | agrees/differs/partial/unavailable | P0 |
| `conductor.reconciliation.receiptScope` | complete/partial/unavailable receipt accounting scope | P0 |
| `conductor.reconciliation.messages` | Recovered assistant response/group count; partial when identities are missing | P0 |
| `conductor.reconciliation.messagesWithoutUsage` | Assistant messages without usable token counters | P0 |
| `conductor.reconciliation.messagesWithoutIdentity` | Recovered groups containing usage without a stable upstream response ID | P0 |
| `conductor.reconciliation.outputTokensRecovered` | Optional finalized output added to the alternate message reconstruction after exact query-input/model agreement; no content or identity | P0 |
| `conductor.reconciliation.receiptFloorApplied` | Optional flag selecting higher provider-reported receipt dollars while retaining message token/request evidence; comparison can also appear on `conductor-result` | P0 |
| `historyCoverage.recoveryCalibration.version`, `.basis` | Version 1 and fixed `paired-surviving-native` comparison basis | P0 |
| `historyCoverage.recoveryCalibration.pairedSessions`, `.comparedSessions`, `.excludedSessions` | Surviving paired population and guarded eligible/excluded denominators | P0 |
| `historyCoverage.recoveryCalibration.receiptFloorSessions`, `.aboveNativeSessions` | Eligible pairs using a monetary floor and exceeding native value beyond the documented tolerance | P0 |
| `historyCoverage.recoveryCalibration.minimumNativeValueUsd` | Fixed $1 per-pair native denominator guard | P0 |
| `historyCoverage.recoveryCalibration.nativeValueUsd`, `.recoveredValueUsd` | Eligible paired-value operands; the recovered operand can contain explicitly counted provider-reported floors | P0 |
| `historyCoverage.recoveryCalibration.aggregateValueRatio`, `.medianValueRatio`, `.p10ValueRatio`, `.p90ValueRatio` | Pooled ratio and interpolated per-session quantiles; null with fewer than five eligible pairs | P0 |
| `evidence.source` | Additionally accepts `conductor-messages`; message fidelity, request usage units, partial accounting | P0 |

Machine history coverage is omitted from repository-filtered analysis and filtered exports. Full snapshot exports preserve it; aggregate-only team sharing does not include the new namespace. The panel explicitly labels machine scope independently of interactive filters. See [the method and uncertainty](metrics.md#history-coverage-and-recovery), including provider retention and uncertain profile overlap.

Calibration uses the same locally projected SDK metadata and already analyzed native sessions; only aggregate counters reach the snapshot. Query/response/record identities remain private, including the internal query-boundary field. No prompts, SDK result text, source paths, raw IDs or per-pair keys enter the calibration namespace. The local verifier emits hashed keys and numerical operands only. Receipt-floor selection preserves stream counters for statistics overlap; summary-only token evidence has no invented profile/day allocation. These additions are P0 and require no secret or network request.

### v0.6.1 correctness audit boundary

`verify/` and `npm run verify:real` read local provider evidence and emit only allowlisted numerical operands, model IDs, timestamps, enums, and existing hashed correlation keys. The release runner uses a throwaway private analytics data directory and serializes real analysis with the shared audit lock. Provider stores remain read-only. Persisted audit snapshots replace repository names with hashed labels; raw transcript paths, provider IDs, content and local exception text never enter audit reports. Public model residuals use the existing `<unknown>` sentinel, never a guessed model name. Unique registered recovered/additional-provider sessions preserve the established SHA-256 registered session key contract.

New fixed warnings disclose partial reported model allocations, retained main-loop token lower bounds and unallocated unknown-model balances. They are P0 enumerated explanations, with no raw text. Version-qualified Conductor marginal values and result identity correlations remain internal. Per-model historical tariff provenance uses existing P0/P1 price metadata; no new content tier or network request at analysis time is introduced.

External SQLite readers remain read-only when a checkpointed WAL database has no sidecars in a non-writable source directory. The guarded immutable fallback reads the original file without creating sidecars; it rejects a newly appeared WAL/journal or any main-file generation change. Its fixed error contains no path, schema value or source text. Generation metadata stays inside the reader and adds no public field.
