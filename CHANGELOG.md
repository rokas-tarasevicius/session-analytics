# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Versions before 0.5.0 shipped as the `machine-session-analytics` skillpack. Tags and GitHub Releases start at 0.7.0. 0.8.1 was prepared at commit `67b0281` but never tagged or released; its changes first shipped in 0.9.0, and its link below compares commits.

## [Unreleased]

### Added

- `session-analytics upgrade` upgrades the installation with the package manager that installed it: `brew upgrade` for Homebrew, and `npm install -g session-analytics@latest` in the same prefix for npm and release-tarball installs. `upgrade --check` prints the installed and latest versions without changing anything. A source checkout is left alone. See [upgrade](docs/cli.md#upgrade-roll-back-and-uninstall).

## [0.10.3] - 2026-10-20

### Fixed

- npm receives each release again: 0.10.2's publish failed because npm read the tarball's relative path as a GitHub repository. 0.10.3 has the same code as 0.10.2, and it is the first version published to npm with provenance. 0.10.2 is on GitHub only.

## [0.10.2] - 2026-10-20

### Added

- Install from npm: `npm install -g session-analytics`, or `npx session-analytics` to try it. npm serves the same tarball as the GitHub Release, and the release workflow publishes it with provenance through trusted publishing. See [installation](docs/cli.md#install).

## [0.10.1] - 2026-10-20

### Added

- Install with Homebrew on macOS or Linux: `brew install rokas-tarasevicius/tap/session-analytics`. The tap installs the release tarball and runs it with Homebrew's Node.js; `brew upgrade` and `brew uninstall` manage it. See [installation](docs/cli.md#install).

## [0.10.0] - 2026-10-15

### Added

- Install a compiled package instead of running a source checkout: `npm install -g https://github.com/rokas-tarasevicius/session-analytics/releases/latest/download/session-analytics.tgz` installs the latest release without the npm registry. Every GitHub Release attaches `session-analytics-X.Y.Z.tgz`, an unversioned `session-analytics.tgz` so that URL always names the latest release, and `SHA256SUMS`; the tarball has a build provenance attestation (`gh attestation verify`). The release workflow can also publish the same bytes to npm and a Homebrew tap; neither is published yet, and the installation guide will name them once they are. See [installation](docs/cli.md#install).
- `npm run build` compiles an installable package into `dist/`: the same code as JavaScript, the dashboard files, rate card, schemas and agent skill, and a generated manifest with a `.js` command, no install scripts and no dependencies. `node scripts/build.ts --out DIR` builds elsewhere and refuses to empty a directory that is not new, empty or an earlier build. `npm run pack:release` packs it into `release/`. Development is unchanged: Node runs the TypeScript sources directly, and the root `package.json` stays private.
- `npm run release:check` now builds and packs that package, checks its files and manifest, and installs the tarball into a temporary prefix whose path contains a space. From the installed copy it runs every command's help and version, the synthetic report (compared with the source run, with every synthetic source read), an MCP tool call, the dashboard with every static file and API route, and the report again from a read-only installation. `node scripts/smoke-installed.ts` runs the same smoke against a tarball or a registry version. `node scripts/demo.ts --bin PATH` runs the demo against any build, and `SESSION_ANALYTICS_DEMO_NOW` pins the instant the demo generates its data from, so two runs analyze the same sessions.
- The dashboard footer shows the version it runs, and `/api/health` reports it.
- Subscription limits are tracked per account. Two Claude logins used on one machine, such as a Max plan and a Team seat in separate `CLAUDE_CONFIG_DIR` profiles, are now separate meters with their own plan, weekly reset time and extra-usage state; profiles logged into the same account share one. Agent SDK events find their account through the session's transcript file name, status-line readings through the inherited `CLAUDE_CONFIG_DIR` or transcript path, and Codex readings through the rollout's or app-server's account ID; a Codex reading without one joins its home's account only while exactly one account has ever been seen there. Account IDs are hashed where they are read. `limits` prints each account labelled with its plan and local profile names, and `limits --json` (schema version 2) adds `accounts`, `meters` and an `account` on every reading. See [Accounts](docs/subscription.md#accounts).
- In-place resets: when a provider restarts a meter at 0% without moving its reset, the readings after it form a new segment of the cycle. Pace, projection, calibration and the closing level use the latest segment, and the restored level is shown as a reset, never as waste. The ledger never merges readings after such a reset with the higher ones before it, and keeps each meter's latest reading on its own, so the level shown is the current one.
- Value is matched to the account whose meters it moved: Claude sessions through their profile, Codex sessions when there is one Codex account on their machine. Value on employer-paid seats, on plans without a price and on sessions that match no account is reported beside the totals instead of inside them.
- The plan list, reviewed on 2026-10-14, adds Claude Team standard and premium seats, ChatGPT Pro 100, 200 and 500, and who pays for each plan. Team, Enterprise and Business seats are treated as paid by the organization: they show API value without a personal multiple and get no plan advice. A plan with a list price can be marked as paid by you or by an employer in the view.
- The privacy manifest lists every field of the limits snapshot, including which fields are local-only. See [Limits endpoint](docs/privacy.md#limits-endpoint-limitssnapshot).
- The demo includes synthetic subscription limits for two Claude profiles (a Team seat that resets on Fridays and runs onto extra usage, and a Max plan without extra usage that resets on Mondays, with a capped 5-hour window and an in-place reset) and a ChatGPT Pro account with a banked reset, and `scripts/screenshots.ts` captures the Subscription view. The demo now discovers Claude inside its synthetic home instead of passing `--claude-root`.
- `session-analytics machines add HOST [--user NAME]` saves a machine to read over SSH, and every later dashboard, `report` and `export` reads it with this one; `list`, `check`, `set`, `rename` and `remove` manage the private `machines.json`. `--machines a,b` reads only some saved machines for a run, and `--no-remote` none. A running dashboard follows `machines.json`: `add`, `set`, `rename` and `remove` reach it on its next request, and a plain `session-analytics` keeps reusing it. The first machine added to a dashboard that had none starts a new scan of this machine at once, and removing the last one serves this machine's last scan. Every `machines` command changes the file under a lock from the file as it is, so a long `check` never undoes an `add` made meanwhile. `add` refuses an account that does not exist on that machine and lists the accounts with agent history instead, and while adding, fixes never name a machine that was not saved; a machine saved with a failing check ends with `Saved NAME, but it cannot be read until this is fixed: …`, and the bundled-runtime note appears only once the runtime check passed. `--name` defaults to the host name before its first dot, or a whole IP address such as `192-168-1-20`. While the dashboard reads this machine alone, its Coverage notes end with how to add one. See [combine machines](docs/interop.md#combine-machines).
- Saved machines use a bundled runtime by default: nothing is installed there except Node.js 24. A small fixed bootstrap sent over SSH runs this install's own code from that account's `~/.cache/session-analytics/runtime`, copying it there (about 0.4 MB compressed) only when that exact version is missing or damaged, and verifying it against its SHA-256 digest before every run. Like OpenSSH's `StrictModes`, it refuses a cache under any directory another account could write to, empties a runtime directory that was opened up rather than trust it, and starts only an entry point its verified manifest lists. The bootstrap ships as a module, so compiled installs carry it. `--runtime installed` runs your own install there instead. See [what a read leaves on that machine](docs/interop.md#the-bundled-runtime).
- `session-analytics machines check` is a doctor for each saved machine: SSH, sudo, Node.js, the runtime, and a real read with its session count and time. Every failure prints the exact command that fixes it, such as the sudo rule `--user` needs, and the command exits 1; a Node.js path saved with `--node` that is missing there is named as the missing one, with `--node node` to go back to the login `PATH`. A host name that does not resolve, a host that cannot be reached and a login that is refused each get their own fix, and a login that works only through a shared SSH connection someone else opened is a warning. `--find-users` lists the accounts on that machine whose home has agent history, by name only, on Linux and macOS, including service accounts with no login shell; when the account read has no history, the fix names the accounts that do. `--json` includes the one sanitized line SSH or the remote printed for a failure.
- `--no-login-shell` (on `machines add` and `set`) reads a service account whose shell is `nologin` or `false` with `sudo -n -H -u` instead of `sudo -n -iu`; `check` names that failure and this fix.
- **Read them again** in Machine details reads the other machines again without scanning this one (`/api/machines?read=1`), for the fix-then-retry loop.
- `--remote-timeout SECONDS` (or `SESSION_ANALYTICS_REMOTE_TIMEOUT`) changes the 300-second limit for each machine's read.
- Machines are a dimension. A snapshot that combines machines lists them in `machines`, each with its state (`ok`, `stale`, `failed`), a fixed reason, the command that fixes it, its session and repository counts, read time, duration and producing version, and tags each session and Claude profile with its machine. A session found on two machines keeps the machine of the copy that was kept, discovery warnings stay attributed to the machine that raised them, and History coverage labels each Claude profile with its machine. See [machine status](docs/interop.md#machine-status).
- The dashboard shows a Machines strip with each machine's session count and state, a long state note wrapping inside its chip on narrow screens. Each chip switches that machine's sessions in or out of every view except Subscription, and of every total and export; a machine that was not read opens **Machine details** with its reason and fix. Summary adds **Usage value by machine**, and Coverage notes name the machine they came from.
- Exports of a snapshot that combines machines name each session's machine: `sessions.csv` ends with a `machine` column (empty for one machine), and OTLP log records carry `session_analytics.machine.key`.
- A saved machine's last good snapshot is kept privately in the data directory after each read. When a later read fails, it is shown instead, marked stale with its age, rather than dropping that machine's sessions; it is reused only for the same version, time zone and switches (`--no-index` included), the same SSH destination and account, and when the snapshot's digest matches its record, for at most 7 days. Merging combined files judges each session by the state of its own machine, so a stale machine's copy never beats a copy read now.
- `report --strict` and `export --strict` exit with status 3 when any machine was not read now (failed, stale, or still reading in a saved dashboard snapshot), for scheduled runs.
- `/api/machines` returns each machine's current state while the dashboard reads other machines.
- Subscription limits are read from saved machines (and `--remote` ones) too: `limits` and the Subscription view run `limits --json --no-remote` on each machine through the same SSH and bundled runtime as its snapshot, at the same time as this machine's harvest, and merge the readings by account, since a login has the same key on every machine. An account takes the plan most recently changed on any machine (a Max plan guessed without its rate-limit tier gives way to one read with it), the freshest Codex state and the freshest extra-usage event, and lists the machines logged into it; readings no machine could tie to an account stay on their machine. A machine asks its own Codex app-server only for an account for which this machine knows no banked resets. A machine reached twice, or this machine reached as another, counts once, as for snapshots. A machine's first read may take the whole `--remote-timeout`, since its first harvest reads weeks of records; later reads stop after 60 seconds, and a read that runs out of time says `no limits within N seconds`. A machine that cannot be read is shown from its last good limits (`machines/<name>.limits.json`, saved machines, 7 days), marked stale, and each fresh read is folded into this machine's ledger, so that history outlives the machine; another machine's plan only fills in an account this machine never read a plan for, and the ledger records each source's newest reading on this machine, so the Sources table and `limits` describe this machine's sources alone. `limits` names the machines in its header, adds a `Machines` block and a `Reported by` line per account, and takes `--no-remote`, `--machines`, `--remote` and `--remote-timeout` like `report`. The dashboard shows this machine's meters first and merges each machine's when it answers. See [Machines](docs/subscription.md#machines).
- `limits --json --no-remote --unsettled` leaves full Claude readings unsettled, for a machine that merges them with others before settling them with the merged account's extra-usage state, and `limits --json --no-remote --identify-machine` lists the machine with the hash of its machine ID and account, as `report` does.
- `release:check`'s installed smoke runs `machines --help` and reads a saved machine through a stand-in `ssh` with the bundled runtime the installed bin packs from its own compiled files, first installing it and then running the verified copy, so a package missing the bootstrap or a runtime file fails before publication. The package check requires `src/remote/bootstrap.js` and `src/remote/runtime.js`.

### Changed

- The release workflow builds and packs the package once, verifies its checksums wherever it is used, installs and runs that tarball on Linux and macOS under Node.js 24.0.0, the newest 24.x and 26, and publishes only after platform validation, the Chrome check and every installed smoke succeed. The GitHub Release is created as a draft, receives its files, and only then becomes the latest release; a re-run resumes the draft and never changes a published release. npm publishing (trusted publishing with provenance, then a registry install of the published version) and the Homebrew tap update run only when their repository variables are set; the formula is installed, tested and audited with Homebrew on macOS before the tap receives it. A tag that publishes after a higher version, such as a backport or a late re-run, never becomes latest on GitHub or npm and never replaces a newer formula. See [releases](docs/release.md).
- Installation guides, the MCP setup and the agent skill use the installed `session-analytics` command; before the first packaged release, and for contributors, a source checkout runs `node bin/session-analytics.ts`. When another version or a dashboard with other options owns the port, the agent skill relays the message and retries on another port instead of stopping it.
- The changelog links each tagged release to its changes, and `release:check` requires the `[Unreleased]` and current-version links.
- Running `session-analytics` again reuses a dashboard on the same port only when it runs the same version. After an upgrade, a dashboard left running from the older version is named, with its version and how to stop it, instead of being reused silently.
- The index revision hashes the code that runs: TypeScript sources in a checkout, JavaScript in the compiled package. The first scan after an upgrade parses present sessions again once, and on a terminal one line on stderr says so, since that can take minutes (as on a first scan, or after the price list changes). A checkout and an installed copy that share a data directory parse them again on every switch between them, so give a checkout used beside an installed copy its own `SESSION_ANALYTICS_DATA_DIR`. That does not separate a saved machine's index, which belongs to the account read there: a checkout and an installed copy reading the same machine make it parse its history again on every switch, so read each machine from one installation, or from the checkout with `--no-index` or `--runtime installed` (see [from source](docs/cli.md#from-source)). Retained history whose sources are gone is kept.
- The Subscription view is redesigned around accounts. It leads with **Limits now**: one row per account, the most urgent first, with the weekly and 5-hour bars, the share left this week, the next reset (absolute and relative, in your browser's time zone) and one status, such as "Runs out Thu 18:07 · 9h early", "Capped until Fri 04:00", "Using extra usage" or "Last seen 2h ago". **Next** follows with at most three one-line suggestions whose reasoning opens under "Why?", then one card per account with its own meters, this week's chart, banked resets, credits and extra usage, then **What it's worth**, **History** and **Sources and method**. Model-specific limits are collapsed under their readable names, retired and never-used meters are hidden, and stale meters are muted without a pace tick. Weekly closes of every account share one time axis, with early resets hatched rather than grey (grey is Codex's colour) and a week on extra usage said to be past its allowance, as on its card, and 5-hour windows get one lane per account. See the [dashboard guide](docs/dashboard.md#subscription-can-i-keep-working-and-is-it-worth-it).
- Value figures moved below the meters into What it's worth and use plain names: value used, a month of full use, the share of a full week every week, and the typical weekly close (formerly "Extracted", "Monthly potential", "Capacity used" and "Weekly resets used"). Value used states the dates each account is counted from (its first reading, or the start of the selected dates) and the value before the first readings that is not counted, and each account's row counts the sessions active in those dates.
- Recommendations are made per account and name it, and route work between accounts, for example "Claude Team seat runs out before its Fri 04:00 reset; Claude Max 20x is at 16%", with the profile to point background agents at. They are ranked by urgency first; the dollar value at stake only orders suggestions of the same urgency. A 5-hour lockout going on now, while the weekly limit is not the tighter one, names the account to switch to when another has room; the week's 5-hour lockouts are something to watch, the longest locked out first, and an account past 100% on extra usage counts as bound by its weekly limit.
- The limits ledger moved to `limits-v2.json` (and `limits-inbox-v2.jsonl`) so that an older installation sharing the data directory, such as a scheduled 0.9.0 `limits --quiet`, cannot replace it. The 0.9.0 `limits.json` is imported once and on later harvests, attributed by weekly reset time, and never written; readings that match no account are kept as unattributed history.
- Read positions are stored in the ledger, so a scheduled `limits --quiet` reads only new log lines instead of rereading every recently modified file.
- Projections run from now at the current segment's pace and appear only once two readings and a tenth of the window are behind them; a meter without a recent reading gets none and, with the same evidence behind its last pace, says when it may already be used up. Before that evidence, a week used up fast (half of it, or 15% at three times the even pace, over two readings) says when it would run out at the pace so far, such as "66% used in 12h: at this pace it runs out Thu 18:07", in Limits now, on its card, in Next and in `limits`; half used, it ranks in Next with the confident run-outs by how early it runs out. A 5-hour window used up fast in its first 30 minutes says so too, on its card, in `limits` and in Limits now ("5-hour limit runs out 14:05 at this pace"), but not in Next.
- Value per 1% drops cycles whose local value explains almost none of the meter's movement (another machine or the web app did the work), calibrates at the first reading at or past 100% (a cap, or the start of extra usage, where Claude's meter stops near 102% while value keeps accruing), and needs two cycles before it is shown.
- The dashboard no longer waits for the slowest machine: it shows a snapshot as soon as this machine's scan is done, with machines still reading shown from their last good snapshot, and adds each machine's sessions when it answers, asking again after a failed fetch; a failed scan of this machine does not stop the other machines' reads. **Refresh snapshot** reads each machine again unless it is still reading. The sync label says how many machines are ready instead of always "Local snapshot ready".
- The `report` header names the machines it covers, marks stale ones and lists failed ones as not read, followed by a `Machines` block with each machine's counts and read time, or its reason and fix.
- Snapshots that combine machines, including `merge` output, carry the new optional `machines`, session `machine` and profile `machine` fields; earlier versions refuse such files. A single machine's snapshot is unchanged. Merged inputs are listed as `machine-1`, `machine-2` and so on.
- `report --share --snapshot FILE` refuses a snapshot that combines several machines, since one source ID would cover all of them and merge could not detect overlap.
- Every read of another machine runs `ssh` without agent, X11 or port forwarding and ignores a host's `LocalCommand` and `RemoteCommand`, so code running there cannot use your SSH agent and a host's configuration cannot change what is read.
- `--user NAME` replaces hand-written `--remote-command "sudo -n -iu NAME …"`. `SESSION_ANALYTICS_REMOTE` and `SESSION_ANALYTICS_REMOTE_COMMAND` still work but are deprecated in favour of saved machines, with a notice. `~` after `sudo` in a remote command is refused, because the SSH user's shell would expand it to its own home.
- A failed remote read names a fixed reason, the most telling line SSH or the remote printed (no longer Node's `Node.js v24.x` trailer) and the command that fixes it, for each of: SSH login or host key, a dropped connection, sudo needing a password, a missing account, a missing or too old Node.js, a missing or non-executable command, another version (an installed remote is asked for `--version` and both versions are named), a busy or newer remote index, a time-out and an oversized reply. A machine read with no sessions now says that its agents may run as another account. Each machine is reported as soon as its read finishes, and the `report` header names only the machines that were read.
- The Subscription view values the sessions of every machine whose limits and sessions were read, whatever the Machines strip shows: sessions record their machine, so a Claude session joins the account logged into its profile on its machine (other machines' colliding profile keys are remapped as the combined snapshot remaps them) and a Codex session joins the only Codex account on its machine. Limits now says where meters and value come from (`meters and value from this machine + agentbox`), with the age of another machine's last good limits, each row and card names the machines that report the account (`(stale)` when only their last good limits are in), What it's worth reports the value of machines whose limits were not read as not counted and names them, and the sources note names every machine read. A machine whose limits were read but whose sessions were not is named as moving the meters without its value. Without other machines, a session without a profile key joins the only account of its provider logged in here, so history kept from another machine never leaves Codex value unknown. On Subscription, the Machines strip says which machines it counts and labels its chip counts all time. Limit accounts carry `planObservedAt`, when the plan was first read as it is.
- The report's Warnings name the machine each discovery warning came from, as the dashboard does.
- With the bundled runtime, the remote report answers with compact JSON, which only the reading machine sees.
- The dashboard and `report` refuse a value option given twice, such as `--time-zone UTC --time-zone Asia/Tokyo`, instead of silently using the first; `--remote` still adds up. An explicit `--machines` wins over the deprecated `SESSION_ANALYTICS_REMOTE`.
- A machine is identified by `SESSION_ANALYTICS_MACHINE_ID`, `/etc/machine-id`, `/var/lib/dbus/machine-id` or, on a Mac, its platform UUID; only where none exists is the host name used, and then a match is a warning, never a refused or dropped machine, since clones and default-named Macs share host names. Every same-machine fix names `SESSION_ANALYTICS_MACHINE_ID`.
- `report --share` describes this machine only, because one keyed source ID covers what it shares: it no longer reads remote machines, and refuses `--remote` and `--machines`. Share from each machine and merge the files, so that merge can detect overlap.

### Fixed

- Two scans writing the private index at the same moment could fail with "The local index writer coordination is damaged" although nothing was damaged: while one process replaced its writer ticket, another could read the replaced file with no links left and treat that as tampering. The gate now reads such a ticket again.
- On Node.js 24.0 through 24.6, Conductor's database could not be read, because those versions cannot bind the query's numbered parameter. Claude sessions recorded only there were left out with the warning "A provider evidence fallback could not be read", and older Conductor sessions without a provider session ID stopped the whole scan. Both now work on every Node.js 24 release, so session counts and totals on those versions rise to match newer Node.js.
- On Node.js older than 24, the command now stops with "needs Node.js 24 or newer" instead of failing later with a generic analysis error. When an analysis worker cannot start because a module is missing, `node:sqlite` is unavailable or TypeScript runs from `node_modules`, `report`, the MCP tools and the dashboard server's terminal output and API error give that fixed reason instead of a generic failure such as "Session analysis could not be completed."
- Readings from two Claude accounts were folded into one meter, so every weekly cycle looked like an early reset, one account's live week was hidden, and extra usage showed whichever account reported last.
- The Claude plan was read only from `.credentials.json`, which macOS keeps in the Keychain, and only for one profile. It is now read from each profile's `.claude.json` (`oauthAccount` plan enums), and a Team seat is reported as Team even when its user tier looks like Max 5x.
- A Claude limit reached while paid extra usage was in use was recorded as a cap and a lockout. It is now `overage`: work continues, the meter reads above 100%, and the view says the account is on extra usage. A lockout ends at the first reading on extra usage. Full status-line readings, and full windows other than the one an event reports on, are settled from the account's extra-usage state, because hard caps read 101-102% too.
- The headline value multiple divided every provider's value by the price of only the plans that had one (77× where the Codex card said 23×). Ratios now use the same accounts on both sides, and so does a month of full use: the plans you pay for against their price, with employer-paid and unpriced seats beside it. Multiples under 10× keep one decimal. An account no session matched, or with no reading in the selected dates, no longer adds its price to the multiple or claims a free plan has no list price.
- A run-out time could be in the past ("runs out in -53m"), and a 10% reading minutes into a week projected a run-out hours away.
- Weekly cycles whose last reading came long before the reset were counted as fully observed, so "resets left unused", "weekly resets used" and plan advice treated unobserved use as waste. They are now unknown closes and left out.
- Price and capacity were prorated over the whole selected range, including days before the first meter reading and the rest of today.
- With `--remote`, other machines' sessions raised value per 1% for local accounts they never moved. Value now counts only the machines whose limits were read (see Changed).
- Codex windows that had not started yet, reported at 0% with a sliding reset time, created hundreds of one-reading cycles and false early resets; Claude's 5-hour window did the same while it had not started. Reset instants a few seconds apart no longer split one cycle in two, and a capped reading keeps its own time when readings are merged.
- Codex model-scoped limits were shown with internal IDs and labelled "all models". They now carry the provider's limit name, such as "GPT-5.3-Codex-Spark · Weekly", and meters the provider stopped reporting are marked retired instead of idle. `limits`, like the view, leaves out extra limits that never moved off 0%.
- A harvest that overlapped another one (two dashboard tabs, or the dashboard and cron) could erase the other's readings for good, including status-line samples that existed nowhere else. Harvests in one process now run one at a time, the dashboard shares a harvest that is still running, and ledger writes in every process take turns, each merging with the ledger on disk. A claimed status-line inbox is deleted only once the ledger is written, so a failed or stopped harvest leaves it for the next one, and a sample appended while the inbox was being claimed is kept.
- A ledger that could not be read was treated as empty and overwritten. A ledger from another version is now left untouched, and an unparseable one is set aside.
- A provider file that failed to read was skipped for good once a later harvest had passed its modification time; it is now retried.
- Value during the daylight-saving fall-back hour was counted twice, and zones with half-hour offsets read activity 30 minutes off.
- An idle Claude weekly meter said the next request starts a new window; Claude weekly limits reset on a fixed weekly schedule, and the next reset is now shown. A meter with no reading since its reset said "100% left" and "Not used this week" although another machine or the web may have used it; it now says there is no reading this week, unless the provider reported the window as not started.
- A Codex tier change to a plan type this version does not recognise, such as `promax`, kept showing the old plan and price; the newer plan evidence now wins, and Codex's `unknown` plan type is ignored.
- Choosing "No subscription" removed the account's card, and with it the only control that could undo the choice. It is now "Exclude from value totals" on the plan chip: the card, its meters and the control stay.
- The two-minute refresh and plan changes moved keyboard focus to the top of the page and reset an inspected chart reading. They now keep focus, the inspected reading, open sections and the scroll position.
- The meters waited for the full session scan, which can take minutes on a first run. They now render as soon as the limits are read, and value fills in when the scan finishes.
- The icon outline style leaked into Subscription charts, outlining every bar (a black or white barcode on phones).
- Day labels on the 5-hour chart collided at phone widths, and explanations were only in hover tooltips; they now thin out, and every explanation is inline text or a disclosure that keyboard and touch users can open.
- A remote read that times out or is interrupted no longer keeps scanning on the other machine: with the bundled runtime, the remote report and its analysis worker stop within a few seconds of the connection closing.
- `SIGTERM`, `SIGINT` and `SIGHUP` stop the dashboard, `report` and `export` at once, together with their `ssh` and analysis workers, instead of waiting up to 300 seconds for a remote read or leaving `ssh` running. A stopped `report` exits with the signal's status and never prints a partial snapshot. After a signal no new `ssh` starts, every child started meanwhile is stopped too, and an analysis worker stops its Cursor worker instead of leaving it scanning.
- Repeated `--remote` flags are combined; previously only the first was read.
- The same machine and account reached under two names, or this machine reached as another, is counted once: the bundled runtime reports a hash of its machine ID and account (`report --identify-machine`), and a duplicate is listed as not read with the reason `same-machine` instead of doubling its Claude profile statistics. Set `SESSION_ANALYTICS_MACHINE_ID` where several machines share one machine ID, such as cloned containers.
- A machine that could not be read is visible in the dashboard and named with its reason, instead of a single unnamed note behind the Coverage button; the "some sessions appeared on more than one machine" note is shown in the dashboard too.
- A read whose `ssh` exited while a helper it started (a `ProxyCommand` that backgrounds) still held its output settles a second later instead of waiting for the time limit and reporting a time-out.
- Remote stderr lines lose C1 control, format and bidirectional-override characters too, not only C0 controls.
- `mcp --help` lists every documented `mcp` option, as the command reference does, including `--data-dir`, `--offline`, `--time-zone`, `--no-index`, the pricing options and every source path, and says that `mcp` never fetches prices and keeps tool windows in UTC whatever those options say. `dashboard --help` now lists the source paths, `--rate-card`, the repository filters, `--exclude-hidden`, `--no-codex-account` and `--no-index` too.

## [0.9.0] - 2026-10-14

### Added

- `--remote HOST[,HOST]` reads other machines over your own SSH and combines them with this one in the dashboard, `report` and `export`, for example a server where Claude Code, Codex or T3 Code agents run. Each machine analyzes its own history with its own index and returns only its content-free snapshot; fetched reports use `--no-remote` to ignore remote environment settings and prevent further SSH reads. `--no-remote` also scans only this machine when used directly and cannot be combined with `--remote`. A machine that cannot be read leaves a warning instead of failing the scan. `--remote-command` starts session-analytics another way, such as through `sudo` for an agent account. See [combine machines](docs/interop.md#combine-machines).
- `merge` combines full snapshots from several machines into one full snapshot: sessions and repositories are unioned, a session found on two machines is counted once, and every rollup is recomputed. Shared snapshots merge as before; mixed inputs are refused. See [combine machines](docs/interop.md#combine-machines).
- `--portable-ids` gives every repository with a Git remote the same ID on every machine, including repositories registered in Conductor, so combined snapshots show one row per repository. Discovered local Git repositories use hostname-qualified IDs; known Claude and Codex provider identities give registered and discovered copies the same session key. Only the output changes; the index keeps local IDs and reuses its cache.
- `--time-zone ZONE` (or `SESSION_ANALYTICS_TIME_ZONE`) sets the IANA time zone for activity days and hours without changing `TZ` for the whole shell. Snapshots combine only when their zones match.
- A Subscription view (`g u`) shows how much of each Claude and Codex subscription allowance you use. It includes live 5-hour and weekly meters with pace and projected reset levels, the API-equivalent value of a full week calibrated from your own meters, monthly potential against plan price, the closing level of every weekly reset, 5-hour lockouts, and ranked recommendations. Readings come from records already on the machine: Codex session `rate_limits`, Claude Agent SDK `rate_limit_event` logs (T3 Code), and the Claude Code status line. Nothing is requested from Anthropic.
- Resets are first-class. Early resets (redeemed, paid or provider-wide) are valued by the share they restored and not counted as waste. Banked resets get redeem, hold and expiry advice, and their value shows next to monthly potential. Codex banked reset credits and their expiry are read automatically through the local Codex app-server, at most every 10 minutes, and never redeemed; `--no-codex-account` or `--offline` turns this off. The Codex credit balance and Claude extra-usage state are shown from local records.
- `session-analytics limits` harvests limit meters into a private ledger so reset history outlives provider log rotation. `limits statusline` works as a Claude Code status line that records the documented `rate_limits` field.

### Changed

- The dashboard adopts Fluxary's warm neutral surfaces, Geist typography, ink controls and open analytical sections, with Summary totals in a desktop side rail. Provider and model graphs retain their identity colours; the logo and activity heatmap use neutral tones.
- Velocity opens grouped by model. Its series ordering is unchanged.
- README wordmarks and the repository social preview now match the dashboard’s neutral palette and bundled Geist type. Plain metadata links replace coloured badges, and an expandable Velocity preview shows the default model grouping.
- The README is shorter, with the dashboard tour and FAQ in linked guides. Generated Fluxary diagrams replace Mermaid blocks and include editable JSON plus light and dark SVGs. Synthetic screenshots reflect the new dashboard.

### Fixed

- Changing the analysis time zone (`TZ`) between scans no longer fails the index consistency check on every later launch, which fell back to a full scan without retained history until `index rebuild`. Sessions cached under another zone are parsed again; totals are unchanged.

## [0.8.1] - 2026-10-13

### Added

- A compact time-window selector keeps all presets and custom dates available on small screens, synchronized with keyboard shortcuts and bookmarked URLs. KPIs use one column below 400 px.
- `npm run release:check` validates source-release metadata, types, tests, schemas, six-provider synthetic output and required package assets without publishing. The package file list now includes this changelog.
- `npm run test:browser` runs required Chrome checks with isolated synthetic fixtures, including mobile window selection and stale-snapshot overflow.
- Private email contacts for security and conduct reports identify the receiving maintainer.

### Fixed

- Snapshot metadata wraps on narrow screens, including stale-snapshot states, instead of widening the page.
- Tests use an isolated temporary directory outside Git trees, so an unrelated Git marker in the system temporary directory cannot change fixture repository attribution.

### Changed

- All CI and release jobs use GitHub-hosted runners. Linux, macOS and Chrome checks are required for private and public candidates; missing Chrome fails browser checks. Release validation has read-only repository permissions, and tags must agree with package, lockfile, source and changelog versions before the publishing job runs.
- Contributor setup uses HTTPS and locked dependencies. The release runbook records validation, reporting and public-install checks.
- Synthetic mobile screenshots are included in both themes with provenance and a reproducible capture recipe.
- README rewritten as a tour of what the dashboard shows, with light and dark screenshots of every view, repository focus, the coverage dialog and the command palette; the command, option and environment reference moved to `docs/cli.md`.
- Screenshots are regenerated by `node scripts/screenshots.ts` from the running demo as lossless WebP pairs that follow the reader's theme.

## [0.8.0] - 2026-10-13

### Changed

- README screenshots are regenerated from the synthetic demo at the current dashboard; Velocity's chart subtitle uses the shared date-range format.
- Focused repositories show provider breakdowns, a sub-agent summary and an All repositories comparator in the fleet table.
- Windows with one or two active days show daily totals as a list with Show 30d; single-provider session shares use text, quiet repository rows collapse, and pricing cards share one activity-dated subtitle.

- Unchecked provider chips use readable text and solid borders while retaining their hollow dots and dimmed marks.
- Provider marks are larger, and repository row links, footer links and rate-source summaries have targets of at least 24 px.
- Coverage fractions appear as plain text; range adjustments and unavailable reasons are visible without hovering.
- Printed dashboards use static navigation and headers, expand tables, and hide top-bar actions and export controls.
- Dark trend areas and chart grids are clearer; Other and Unknown lines in both themes and dark Claude/Codex light-model shades meet 3:1 contrast on cards.
- Refreshes say “Refreshing…” even with reduced motion enabled.
- Summary has clearer panel titles, shorter notes and six key figures; live snapshot counts appear in the status pill, and full explanations remain in Data coverage.
- History coverage is a collapsed status line; expand it for calibration, estimates and profile details.
- Velocity groups by provider by default and shows the top six series plus Other, with a two-column inspection readout and an average key only when the average is shown.
- Pull requests and pushes now check snapshot schemas, synthetic JSON reports and package contents; pull requests run on Ubuntu and pushes to `master` also run on macOS, where the Chrome dashboard checks run separately without blocking CI. Version tags create a GitHub Release from the matching changelog notes after the full checks pass.
- Dates and money are formatted the same way on every dashboard view; chart axes share day labels and compact dollar amounts, while tables keep cents.
- The synthetic demo cleans up demo temporary directories older than one day when it starts.
- Reusing a running dashboard now requires the same analysis options and a verified launch token. If the port is occupied by a different configuration or an unverified service, stop it or choose `--port`.
- The README and security policy now agree on supported providers, activity-dated usage value, the 1024 MB analysis limit, startup public-price refreshes, offline pricing controls, and explicit export delivery.
- The dashboard URL follows the view, window (`?window=`, custom `?start=`/`?end=`) and repository focus (`?repo=` with the opaque repository ID, never a name or path). View, preset and repository changes add a browser history entry and Back/Forward restores them; reload and bookmarks reopen the same place. `?open=`, `?theme=` and `?density=` apply once and are then removed from the URL; a URL theme or density is no longer saved as your preference, and the system theme is no longer saved on first visit.
- Switching views starts the new view at the top of the page.
- Command palette results are ranked: exact, then prefix, word-start, substring and fuzzy matches, and fuzzy-only matches are dropped when a closer match exists (`help` finds Keyboard shortcuts first). The palette gains an **Export view…** entry.
- Provider chips on Summary, Velocity, Tools and Activity list only the providers present in the snapshot (no empty Unsupported chip), and Velocity's "N of M providers" counts against them. `p 1`–`p 7` toggle the chips in that order on every one of these views, including Velocity.
- A custom range with a cleared or half-typed date keeps the previous date until you leave the field, a reversed range swaps, and dates outside the observed history are clamped, with an inline note. A window with no sessions or activity shows an empty state with **Show all time** and **Clear repository focus** instead of a page of zeros.
- A failed first load shows a "No snapshot" state with **Retry**; a failed refresh keeps the last snapshot on screen, marks its time as stale and offers **Retry**. The export menu says when there is nothing to export because the analysis failed.
- Accessibility: legend entries are list items instead of focusable buttons that did nothing; the Summary repository table's first cell is a real button instead of a focusable row; coverage badges such as `87/116` carry their sentence for screen readers; repository bars, the Coverage button and the repository scope chip have accessible names that include their visible text and values; the density control is a named toggle; the wordmark goes to Summary. Tooltips name a shortcut key only while single-key shortcuts are on, key caps are lowercase everywhere, and `/` is listed in the shortcut help.
- The money metric is called "Usage value" everywhere, with one definition (API list-price equivalent of recorded usage; provider-reported values included; not an invoice). Velocity's value metric, Summary's KPI and daily chart drop "Priced".
- Dashboard visual system: uppercase labels use 11 px, notes 12 px, body and tables 13 px, controls 14 px, panel titles 15 px, view and dialog titles 18 px, secondary figures 20 px and KPI figures 26 px, with explicit larger sizes in comfortable density. Tables use Geist text and Geist Mono figures, and controls share one focus ring. Costs closes its provider list with a separated Total, and values line up whether or not a "% priced" badge follows them.
- Errors and warnings use their own status colours with an icon and title instead of the coral brand accent. Usage deltas are neutral (▲/▼) rather than coral for "went up".
- The coverage dialog is titled "Data coverage", opens on its title instead of flashing a focus ring on Close, and its table scrolls inside the dialog on small screens.
- Phones (390 px): no view scrolls sideways; KPIs sit two per row; cost bars get full-width rows; touch targets are at least 40 px and keyboard hints are hidden on touch screens. Line charts are drawn at the container's pixel width, so axis labels stay readable on narrow screens.
- The view title appears once, in the top bar, with a one-line description under the scope line (Summary included); repeated panel kickers, the KPI accent stripe and the heavy pricing-card stripe are gone.
- Theme and density sit together under Display in the sidebar footer, with a spacing icon for density. Compact money labels (sidebar, daily chart axis) show whole dollars from $10 ("$76", not "$76.2") and one decimal from $1,000 ("$1.9K").
- Pricing: model cards line up row by row (provider, model, prices, value, caption, tokens, share bar and coverage pill each share one row height), with a smaller card value under the KPI figures. Each card's bar is now labelled as its share of the API-equivalent value on the cards ("40% of API-equivalent value") instead of an unlabelled bar relative to the top card. Prices wrap only between "in" and "out". Snapshot ages read "2 days old" instead of "2.0d", "Price policy" becomes "Price updates" (Automatic, Offline or Pinned, with what that means), and the card reconciliation line is shown under the KPIs instead of inside Evidence & limits. When prices are stale and public updates are enabled, the notice has a **Refresh snapshot** button; offline and pinned modes say what to run instead.
- Tools: the ranking is "Top tools" (also on Summary, which said "Tool families") and gains a Provider column, because the same tool name from different providers is a different tool. Calls show the number and its bar on one line, the table no longer scrolls inside itself, and phones get one card per tool instead of a sideways-scrolling table. The selected tool is clearly marked; on wide screens its profile sits beside the ranking and stays in view, on narrower screens selecting a tool scrolls its profile into view, and screen readers hear which profile is shown. A tool used by one provider says so in a sentence instead of a full-width 100% bar. The daily chart has a y-axis maximum, a real tooltip and arrow-key navigation.
- Tools: a change against a previous window with fewer than 5 calls shows "—" with "small baseline" (the rule Velocity uses), instead of percentages such as +126,700%; the Tool calls KPI says when the previous window is too small to compare.
- Activity: the heatmap legend shows its numbers (0 to the busiest hour, with each shade's range on hover) instead of "Less … More". On phones the heatmap turns so hours run down the page and weekdays across, without sideways scrolling; arrow keys follow the layout. With every provider switched off, or none of the selected providers having sessions or known start times, Activity and Tools show an empty state that names the cause, with **Select all providers**, instead of a page of zeros.

### Fixed

- Sub-agent empty states name the missing activity and selected dates; clamped ranges say Clamped to history, and unknown-start notes count only the selected window.

- The fleet comparison table keeps Cache and Priced visible at laptop widths, truncates long repository names, and shows scroll shadows when tables overflow.
- Daily usage provider chips sit on their own row below the title with consistent spacing.
- Pricing and Velocity KPI grids now use the same responsive column breakpoints as the rest of the dashboard.
- Tools CSV exports now match the Tools view's evidence rules: invalid transcripts and unavailable tool evidence no longer inflate calls, and non-finite, zero or negative counts are excluded.
- Velocity's rolling 7-day average now uses prior history at the start of the selected window, instead of leaving the first six days blank. Its dashed-line key appears only when an average is available.
- Malformed HTTP request targets now receive a fixed `400` response instead of stopping the dashboard server.
- Cross-site browser requests and requests from other loopback ports can no longer trigger API refresh scans; header-less local clients remain supported.
- Installation guidance now directs users to a checkout plus `npm link` and explains the Node 24 type-stripping error from GitHub or tarball installs.
- Shared snapshots keep their aggregate view when navigation shortcuts or the wordmark are used; the command palette no longer offers unavailable views or repository focus.
- Keyboard provider toggles close and invalidate the Export view preview, including in Velocity; downloads also check that the selection still matches the preview.
- Tools profile chart footers name the snapshot timezone instead of always saying UTC.
- Velocity shows — with a reason when selected sessions have no activity ledger, and marks partially available selections instead of implying complete $0.00 usage.
- Pricing and Costs show — calls when request counts are unavailable, while preserving observed zero counts as 0.
- Failed refreshes explain the failure in a warning, keep the dated stale snapshot and offer Retry; a failed first load explains that there is no snapshot yet.
- Escape cancels an armed navigation chord, and snapshot and view status changes are announced to screen readers.
- The theme no longer flashes light before a saved dark theme applies: a same-origin script in `<head>` sets theme and density before the first paint.
- Escape in the export menu closes only the menu instead of also clearing the repository focus; the menu also closes on a press outside it, when focus moves away, and when the theme or density changes.
- Single-key shortcuts work while a checkbox or button has focus; only text entry suppresses them.
- `p 4` to `p 7` did nothing; only the first three providers could be toggled from the keyboard.
- Refresh from the button, `r` and the palette now shares one in-flight request instead of starting overlapping scans.
- Clearing the end date of a custom range wiped the start date too, and a custom range could extend past the observed history.
- **One money ledger everywhere.** For the same date window, the Summary KPI, the fleet table, Costs, Pricing, the model mix and the daily CSV export showed different totals, because only Summary and Velocity summed the activity-dated ledger while the rest used whole-session values of sessions started in the window. Every money figure for a window now sums the same ledger (`buildVelocity`, including session-dated value), so they agree to the cent. Costs, Pricing, fleet-table and model-mix totals move **up** where earlier-started sessions used value inside the window, and **down** where a session started inside the window used value after it, or where Cursor's undated provider-reported value was counted (it is now disclosed as all-time, as on Summary).
  - Fleet table: the Usage value and Priced columns (and their sort) read the ledger, so the rows add up to the KPI; a repository with no activity ledger shows — instead of $0.00.
  - Costs: a Usage value card equal to the KPI, a reconciliation line (usage value = API-equivalent + provider-reported, with the dates, timezone and the all-time amounts outside any window), provider bars sorted high to low with a total line, and model rows from the ledger. The cache-write upper estimate moves into the API-equivalent card's note and is scaled to the window per session.
  - Pricing: one card per provider and model (no longer merged across providers), valued from the ledger; the cards add up to Costs' API-equivalent value, with a reconciliation line. "Selected token coverage" is now "Pricing coverage", the same figure as Costs, and rounds down so it shows 100.0% only when complete.
  - Summary model mix: rows are "model · Provider", never a duplicated model name, and add up to the KPI (an "Other" row past eight). The explicit sub-agent value reads the ledger.
  - Exports: the daily value CSV is the window's ledger in the snapshot timezone, including session-dated value, with `providerReportedSpendUsd` populated (Conductor receipts); the menu states each file's value basis. Exports honour the active view's provider filter (Summary's daily-chart chips, Velocity's chips, Activity and Tools filters), and the current snapshot stays exportable while a refresh runs. `export --format csv` writes the same ledger-based `daily.csv` (days in the snapshot timezone; previously UTC `spendByDay`, without session-dated value).
- One calendar: session counts, tokens, tools, the Activity heatmap and every scope line use the snapshot timezone, like the ledger (session starts were filtered by UTC date).
- Session breakdowns add up: mixed top-level and sub-agent sessions are counted once ("· N mixed") in the Sessions KPI and the fleet table.
- Velocity's week card names its weekdays ("Week to date (Mon–Thu) vs same days last week"), so it is not confused with the Summary's last-7-days delta.

## [0.7.0] - 2026-10-09

### Removed

- The Costs repository and visible token-type breakdowns and the Models view (`G M`). Model details now appear in Costs; token-type dollars remain in row tooltips.
- Dashboard Distributions, Reliability, Limits & cache, Workflow, Skills, Outcomes and Insights views, their assets and shortcuts, and the dashboard-only `/api/insights` endpoint.
- **Breaking:** the analysis behind those views, from every remaining surface. Tokens, cost, pricing, velocity, tool counts, compactions, context peaks and history coverage are unchanged (verified identical on the synthetic demo).
  - Commands `insights` and `review`, and the options `--insights-config`, `--reliability-content-rules`, `--outcomes-git`, `--outcomes-github`, `--workflow-content-rules` with their `--no-*` forms and `SESSION_ANALYTICS_INSIGHTS_CONFIG`, `SESSION_ANALYTICS_RELIABILITY_CONTENT_RULES`, `SESSION_ANALYTICS_OUTCOMES_GIT`, `SESSION_ANALYTICS_OUTCOMES_GITHUB` and `SESSION_ANALYTICS_WORKFLOW_CONTENT_RULES`. The flags are now rejected as unknown; the variables are ignored. The opt-in GitHub (`gh`) outcome queries and local Git correlation are gone.
  - Snapshot JSON fields `limitsCache`, `outcomes` and `workflow` (machine and repository), repository rollup `outcomes`, and per-session `reliability`, `limitsCache`, `outcomes`, `workflow`, `insightSignals`, `skills`, `skillEvidence`, `mcpEvidence.toolOutcomes`, `mcpEvidence.rateLimits` and `mcpEvidence.truncated`. `schemaVersion` stays 1: every remaining field keeps its meaning, and snapshots written by earlier versions still load with `--snapshot`, `export` and `merge`; their removed fields are ignored, and any other unknown field is still rejected.
  - Terminal report sections for limits & cache, outcomes, workflow and reliability.
  - MCP tool `unused_extensions`, tool error rates and result coverage in `tool_stats` (it now returns calls per tool), quota headroom in `budget_status`, skills in `repo_profile`/`compare_agents`, and the reliability, limits & cache, outcomes, workflow and insight families in each payload's `metrics`. The MCP worker no longer reads skill or MCP-server configuration.
  - Demo `insights` mode and the synthetic limits, outcomes, reliability and workflow evidence.

### Added

- Per-session `historyProfile` (native Claude sessions): the hashed Claude profile key and deduplicated request tokens per UTC day and model. It carries the machine-wide history coverage inputs that used to live in `limitsCache`. Indexed sessions written by earlier versions are migrated on load, so history coverage for source-deleted sessions is unchanged. The index reparses present sessions once after upgrading.

### Fixed

- Summary's "Priced usage value", its sparkline and delta, the sidebar and repository value bars, Summary's daily chart and Velocity no longer leave out OpenCode, Gemini CLI, Copilot CLI, Cursor SDK and Conductor-result sessions; totals for these sources move **up** from zero to their value. Each source is dated as finely as it records time: OpenCode per request, Gemini per message, Copilot tool calls per event, Cursor SDK per run, and Cursor transcripts stay undated (no times recorded). Value whose own request or run time is not recorded (Conductor result receipts, or a Gemini message or Cursor SDK run without a time) is **session-dated**: placed on the session's last evidenced activity time and stated separately in the Summary and Velocity notes. Summary and Velocity still agree for the same window and scope. Snapshots gain the optional `velocity.sessionDated` cells and the velocity agents `copilot`, `opencode` and `gemini`. Cursor SDK run value now also appears in `spendByDay` on its run's UTC date. Sessions from these sources in older snapshots are disclosed until the next refresh.

### Changed

- Warm indexed scans no longer re-read every Claude transcript for the resumed-copy ownership pass or re-extract every Conductor session's messages: both are cached in the private index (schema version 4) and refreshed per file or per Conductor session when it changes. Output is unchanged. The index stores only keyed identifier hashes and counters for these passes; the first scan after upgrading reads everything once.
- Velocity repository, execution and effort series use a shared non-brand categorical ramp (greens and orchids) instead of the old palette whose coral read as Claude orange. Execution kinds and effort levels keep fixed colours across date and provider filters, repeated colours add texture or dashes, and Other/unknown series are grey.
- The Pricing view shows a grid of model cards instead of the rates table. Each card carries its provider's brand accent and mark, input and output price per 1M tokens, the selected window's usage value with a usage bar, tokens and calls, and a badge when rates are incomplete. Cards are ordered by API-equivalent usage value in the selection, then tokens; rate-card models unused in the selection sit behind a "Show N unused models" toggle. Selecting a card (click, Enter or Space) opens a details dialog with the full rate breakdown (input, cached input or cache read, 5-minute and 1-hour cache writes, output, long-context tiers), the current source, effective date, reviewed override and assumptions, selection coverage and token mix, and the historical rate evidence the usage applied. Source freshness, coverage, policy and refresh guidance stay above the grid. Snapshots gain `rateCard.models[].rate`, a numeric-only projection of each current rate.
- Velocity opens with Average price per active day and Usage value for the selected window and providers, followed by filters and the usage chart.
- Costs shows cost by provider and by model on shared zero-based scales, including value with no model evidence.
- Old `?view=models` links and saved Models preferences open Costs.
- Dashboard charts use provider brand colours (Claude terracotta, OpenAI/Codex grey, Cursor teal, Copilot purple, OpenCode gold, Gemini blue) defined once in `src/public/chart-colors.js`, with stable model shades per family (Opus, Sonnet, Haiku as shades of Claude; GPT models as greys). Legends are larger, show values and shares, follow the chart order, drop zero entries and highlight the matching series on hover or keyboard focus. Bars in a panel share one zero-based scale with no minimum width; bars that are not provider data use one neutral colour.
- Dashboard navigation now groups Summary and Velocity under Overview; Costs and Pricing under Economics; Tools and Activity under Usage, with Activity last in navigation, view stepping, the palette and shortcut help.
- Tools view is tool-first: the per-repository stacked distribution and "Selected repository" drill-down are replaced by KPI cards, a ranked tool table (calls, share, sessions, repositories, change against the previous window) and a profile for the selected tool (calls by session-start day, provider and repository split). Bars are single-colour, zero-based and proportional. Per-tool cost and duration are stated as not recorded rather than estimated.
- Dashboard windows default to the last 30 days of observed history. Explicit `?window=` presets still override the default; the window is not persisted. Under the default, sessions with an unknown start time are excluded (they reappear under **All**), and **Export view** downloads cover only the selected window.
- Dashboard design refinement: honesty guardrails moved into progressive disclosure. The coverage banner became a top-bar "Coverage" indicator that opens an Evidence & coverage dialog (coverage notes, per-provider evidence table, interpretation footnotes); inline "n/m sessions" denominators became hover badges beside the number; unavailable values render as an em dash with the reason on hover instead of "N/A"; long evidence paragraphs sit behind per-panel "Evidence & limits" disclosures.
- One shared component set (`src/public/ui.js`: filter bar with labelled fields, KPI card, data table, evidence disclosure, coverage badge) now renders Velocity and Pricing with the same spacing, type scale and controls as the Summary.
- Fleet table repository IDs show the key's hash tail; the footer collapses rate sources into one disclosure; the donut legend hides empty providers; distinct sidebar icons for each view; `e` opens the coverage dialog.
- Demo: Gemini CLI sessions use a rate-card model so the demo is priced across providers.

### Fixed

- MCP tools report "Session analysis exceeded its 1024 MB worker heap limit." when the analysis worker runs out of heap, instead of the generic "Local metrics are unavailable" message. Raw worker output still never reaches the client.
- The Summary provider donut now draws Copilot, OpenCode, Gemini and unsupported segments (they were listed in its legend but missing from the ring), and its legend no longer truncates names.
- Costs provider rows were each stretched to full width, so a $191 provider looked as long as a $576 one; rows now share the panel's maximum. Cost by model also shares one scale across providers.
- The Summary daily usage chart drew lines only for Claude, Codex and Cursor; every provider now gets its line.
- Folders that are not repositories no longer show up as repositories. Sessions started in the home directory, scratch, download or chat folders, or in a deleted checkout that recorded no Git remote, used to become one `<folder> · <hash> (local directory)` entry each; they now share one `No repository detected` group. Indexed sessions from those entries whose transcripts are gone move into it too, including former temporary-directory entries, because the index never kept their folder. Git repositories, recorded remotes and Conductor workspaces are attributed as before. The old per-folder repository IDs no longer exist: a saved `--repo-id` or a `--share-aliases` entry for one no longer matches, and `--repo-root` on a folder that is not a repository now reports that no evidenced repository has that root.
- Deleted temporary directories recorded under the other macOS spelling (`/private/tmp` for `/tmp`, `/var/folders` for `/private/var/folders`), and existing folders under `/tmp`, are grouped as `Ephemeral automation sessions` instead of one entry per run.
- Warm dashboard snapshots no longer reparse every Claude session when resumed copies share message IDs: only the sessions that share a message (8 of 485 on the measured history) skip the index, as all Claude sessions did before. On a ~5,800-session history a warm snapshot went from 115–269 s to about 51 s (CPU 138 s to 52 s).
- Raise the analysis worker heap cap from 256 MB to 1 GB; large histories exhausted it and the dashboard reported a generic parse failure. Hitting the cap now names the limit in the dashboard and CLI.
- Faster scans with unchanged output: concurrent fingerprinting, memoized source keys and repository lookups, reused HMAC keys, linear JSONL line splitting and cached calendar-day validation.
- Summary and Velocity now show the same usage value for the same window. The Summary "Priced usage value" KPI, its sparkline and delta, sidebar repository values and repository value bars use Velocity's activity-date ledger in the snapshot timezone instead of whole-session value of sessions started in the window (UTC). Undated value and sessions from sources without activity dates are disclosed beside the KPI as all-time amounts, and its delta uses the same guarded comparison as Velocity. Date windows no longer end on a future day when UTC session starts run ahead of the local date.
- Velocity's "This week vs last" and "Month to date vs prior" work again: they no longer depend on the selected window's start, OpenCode/Gemini/Copilot/Cursor SDK/Conductor-result sessions no longer block every comparison, a Monday or the 1st compares the period that just finished, small pricing gaps (at least 90% priced) show a partially-priced change instead of N/A, and a zero prior period shows "New" or "No activity". Unavailable comparisons state why.
- Verify recovered daily value against its UTC history remainder while independently conserving hourly velocity, including finalized output whose day is known but hour is not.
- Recognize canonical OS temporary directories in the independent repository oracle and carry recorded source changes through all native verification comparisons.
- Prove live changes to shared context-curve sampling and recovery calibration from saved public context facts and independently reconstructed SDK pairs, while retaining strict counters and accounting checks.

## [0.6.2] - 2026-10-04

### Fixed

- Recover finalized Claude output from query receipts only when their main-loop input counters and model agree with retained assistant evidence. Preserve cumulative receipt scope and unknown timing/reasoning details.
- Retain a higher Conductor receipt value as a provider-reported floor without discarding recovered message tokens or adding the two monetary sources together.

### Added

- Measure recovery against every surviving native/SDK pair during analysis. History coverage exposes guarded value ratios, denominators, quantiles, receipt floors and above-native exceptions; no multiplier inflates deleted history.

## [0.6.1] - 2026-10-04

### Fixed

- Read checkpointed external SQLite sources in read-only directories without losing sessions when WAL sidecars are absent; reject concurrent source changes (`INTEGRATION-SQLITE-01`).
- Reconcile native request identities, continuation files, billing iterations, replay, output classification and strict request dates across full and indexed scans.
- Correct historical tariffs, conservative receipt scope, partial pricing, repository ownership, provider snapshots and aggregate displays. Preserve unknown evidence and unattributed estimates explicitly.
- Run every imported validation regression in `npm test`; add `npm run verify:real` for independent raw-data comparisons and disposable full/cold/warm index checks.

Fixed or superseded bug IDs by validation area (superseded findings are resolved by a stronger combined fix):

- **aggregation:** `AGG-001`, `AGG-002`, `AGG-003`, `AGG-004`, `AGG-005`, `AGG-006`, `AGG-007`, `AGG-008`, `AGG-009`.
- **claude:** `CLAUDE-D01`, `CLAUDE-TIED-BREAKDOWNS`, `CLAUDE-UNKNOWN-REASONING`, `VC-CROSS-SESSION`, `VC-ITERATIONS`, `VC-STUB`, `VC-UNDATED`.
- **codex:** `CODEX-01`, `CODEX-02`, `CODEX-03`, `CODEX-04`, `CODEX-05`, `CODEX-06`, `CODEX-07`.
- **conductor:** `VC-001`, `VC-O1`, `VC-O2`, `VC-O3`, `VC-P1`, `VC-P2`, `VC-P3`, `VC-P4`.
- **dedup:** `DEDUP-AD-01`, `DEDUP-AD-02`, `DEDUP-AD-03`, `DEDUP-AD-04`, `DEDUP-AD-05`, `DEDUP-CD-01`, `DEDUP-CD-02`, `DEDUP-CD-03`, `DEDUP-CD-04`, `DEDUP-CL-01`, `DEDUP-CL-02`, `DEDUP-CL-03`, `DEDUP-CL-04`, `DEDUP-CX-02`, `DEDUP-CX-03`, `DEDUP-CX-04`, `DEDUP-CX-05`, `DEDUP-CX-07`, `DEDUP-CX-08`, `DEDUP-CX-09`, `DEDUP-CX-10`.
- **history recovery:** `HISTORY-MESSAGE-RECOVERY`, `HISTORY-STREAM-COUNTERS`, `HISTORY-STRIPPED-IDENTITY`.
- **index:** `INDEX-CLAIM-ROLLBACK`, `INDEX-MEMORY-LEDGER`, `INDEX-MEMORY-PROJECTION`, `INDEX-MEMORY-ROLLBACK`, `INDEX-MEMORY-SERIALIZATION`, `INDEX-OUTCOME-SCHEMA`, `INDEX-STALE-AUDIT`.
- **integration:** `INTEGRATION-CLAUDE-MEMORY`, `INTEGRATION-CLAUDE-PRIMARY`, `INTEGRATION-CODEX-FORK-MEMORY`, `INTEGRATION-CODEX-INDEX-CALLS`, `INTEGRATION-CODEX-INDEX-PAGES`, `INTEGRATION-CONDUCTOR-01`, `INTEGRATION-CONDUCTOR-MEMORY`, `INTEGRATION-INDEX-PROJECTION-MEMORY`, `INTEGRATION-PRICE-01`, `INTEGRATION-PRICE-02`, `INTEGRATION-PRICE-03`, `INTEGRATION-PRICE-04`.
- **other-providers:** `ADAPTER-001`, `ADAPTER-002`, `ADAPTER-003`, `ADAPTER-004`, `ADAPTER-005`, `CURSOR-01`, `CURSOR-02`, `CURSOR-03`, `CURSOR-04`, `CURSOR-05`, `CURSOR-06`, `CURSOR-NATIVE-01`, `CURSOR-NATIVE-02`, `CURSOR-NATIVE-03`, `CURSOR-NATIVE-04`, `CURSOR-NATIVE-05`, `CURSOR-NATIVE-06`, `CURSOR-NATIVE-07`, `DESKTOP-01`, `DESKTOP-02`.
- **pricing:** `PRICING-1M-ALIAS`, `PRICING-ITERATIONS`, `PRICING-LAB-PREFIX`, `PRICING-MESSAGE-ITERATIONS`, `PRICING-SPARK`, `PRICING-SUMMARY-TIERS`, `PRICING-TIER-WRITE-UPPER`, `VP-CODEX-HISTORY`, `VP-CODEX-UPPER`.
- **reconcile:** `RC-CODEX-01`, `RC-CODEX-02`, `RC-CONDUCTOR-CARRYOVER`, `RC-CONDUCTOR-LOCAL`, `RC-CONDUCTOR-REPLAY`, `RC-MODEL-01`.
- **repos:** `R-CONDUCTOR-01`, `R-CONDUCTOR-02`, `R-CURSOR-01`, `R-CURSOR-02`, `R-CURSOR-03`, `R-GIT-01`, `R-GIT-02`, `R-GIT-03`, `R-GIT-04`, `R-GIT-05`, `R-GIT-06`.
- **time:** `TIME-01`, `TIME-02`, `TIME-03`, `TIME-04`, `TIME-05`, `TIME-06`, `TIME-07`, `TIME-08`, `TIME-09`, `TIME-10`, `TIME-11`, `TIME-12`.
- **verification:** `INTEGRATION-VERIFY-01`, `INTEGRATION-VERIFY-02`, `INTEGRATION-VERIFY-03`, `INTEGRATION-VERIFY-04`, `INTEGRATION-VERIFY-05`, `INTEGRATION-VERIFY-06`, `INTEGRATION-VERIFY-07`, `INTEGRATION-VERIFY-08`, `INTEGRATION-VERIFY-09`, `INTEGRATION-VERIFY-10`, `INTEGRATION-VERIFY-11`, `INTEGRATION-VERIFY-12`.

### Evidence limits

- `VC-002`, `PRICING-OWNERSHIP-CONTRACT`, `DEDUP-CX-01`, and `DEDUP-CX-06`: retained legacy receipts/counters do not establish exact additional billing or ownership. Diagnostic fixes expose partial evidence; no speculative correction is added.
- `R-SHARED-01`: later reuse of the same missing cwd does not prove repository ownership, so the suspected reattribution is rejected.
- Grok models remain unpriced when the existing offline normalized cache lacks their rates; the fixed xAI importer takes effect on an explicit or subsequently due public-rate refresh.

### Index integrity and recovered history

- Accept the outcome hash formats already emitted by the parsers in the persistent projection schema. Indexed Codex and Claude composite sessions no longer become invalid or lose tokens/value when they carry PR or observation-only outcome references.
- Roll back index-only failures and retry full-scan accounting with a fixed warning, preventing duplicate retries and lost Codex counter ownership. Add rotating warm-cache session/ledger verification and a content-free full/cold/warm parity runner.
- Bound Codex dependency reconstruction to one cached ledger at a time instead of retaining every broadcast receiver's observations in the 256 MB analysis worker.
- Stream and compress prior cached payloads in memory so warm scans can retain rollback evidence without holding a second full JSON string graph; the on-disk format is unchanged.
- Stream worker snapshot output with backpressure instead of allocating the entire serialized history as one string; the JSON format and 256 MB heap cap are unchanged.
- Construct compact allowlisted session objects so cold indexed populations fit the same heap budget as full-scan results, without weakening schema validation.
- Recover missing Claude transcripts from Conductor assistant usage with deduplicated request pricing, dates, tool names, subagent attribution, and explicit receipt reconciliation. Add machine-wide History coverage from Claude statistics with separate, conservatively overlap-adjusted unattributed estimates. Statistics compare matching streamed-block counters, avoiding false gaps from response deduplication; stripped SDK response IDs remain conservative and partial. Previously result-only usage lacked daily attribution; recovered values can increase or decrease when message evidence replaces cumulative receipts.

## [0.6.0] - 2026-10-03

### Added

- Fourteen views in the Control Room dashboard, grouped navigation, command palette, collision-free shortcuts, URL entry points, density controls, and light/dark themes (#17).
- Velocity and guarded period comparisons (#4); cached, dated public price feeds, request-time provenance, Pricing view and `rates` commands (#5).
- Tool reliability, latency, verification and optional local content rules (#6); quota, cache, context and plan-value evidence (#7); outcome linkage and opt-in Git/GitHub enrichment (#8).
- Workflow timing, concurrency, steering, command history and skill inventory (#9); grouped insights and an explicit per-run content review workflow (#10).
- A private SQLite index with complete session replay, source-deleted retention, ownership checkpoints and `index status|path|rebuild|prune` (#11).
- Seven metrics-only MCP tools with repository scope, coverage and summaries from every integrated metric family (#12).
- Provider adapters, Cursor SDK/transcripts, Copilot CLI, OpenCode, Gemini and conservative Conductor result recovery (#13).
- Versioned snapshot schemas, CSV/NDJSON/OTLP exports, aggregate-only sharing and snapshot dashboards (#14).
- Product strategy, information architecture, evidence research and launch proposals (#15, #16).

### Changed

- One dispatcher and shared analysis options across dashboard, reports, pricing, insights, review, exports, index and MCP.
- One synthetic demo covers every view and provider. New views use the Control Room cards, typography, colors, controls and tables.
- The persistent projection and interchange schemas cover all final metric namespaces, pricing provenance and normalized quota evidence; cold/warm/full scans are checked for parity.
- P2 rule settings partition cached history. Public price refreshes and each explicit network feature are documented separately; provider stores remain read-only and runtime dependencies remain zero.

### Fixed

- Preserved streamed-response maxima, Codex ownership/deduplication, partial-accounting coverage and provider-specific N/A semantics across merged parsers and consumers.
- Preserved quota facts on warm scans and invalidated caches for parser, pricing, command-history and option changes; open workflows are reevaluated as they age.
- Unified bounded model identities, numeric UTC comparisons, unknown-start exclusions and full-metric filtered exports.
- Kept source-deleted history warnings visible and excluded historical working observations from live counts.
- Reconciled all reviewed conflict fixes and privacy tests; no lane tests removed.

## [0.5.0] - 2026-10-02

First standalone release.

### Added

- `session-analytics` command with `dashboard` (default) and `report` subcommands; `--no-open` starts the dashboard without launching a browser.
- Discovery of every local Claude Code and Codex profile: `~/.claude-*` and `~/.codex-*` siblings, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `~/.config/claude`, deduplicated through symbolic links. Explicit root options still replace discovery.
- Claude thinking tokens, reported separately as reasoning output, and the recorded reasoning effort per session.
- Cursor workspace and subagent mapping through the `composerHeaders` table used by current Cursor builds.
- Reviewed rate-card entries for `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6-sol`, and `gpt-6.1-sol`; the rate card is effective 2026-10-02.
- Regression tests for streamed Claude usage, current Codex rollouts, profile discovery, and Cursor headers.
- Strict TypeScript checking, `package.json` scripts, a single brand module, and a cross-platform browser opener.

### Fixed

- Claude output tokens were undercounted because the first streamed snapshot of each message was priced instead of the final one. On one real machine this removed 19-47% of output tokens per profile.
- Claude sessions in any profile other than `~/.claude` were never read.
- Codex user turns, assistant messages, and compactions read near zero for current rollouts, which record them as `item_completed` items and top-level `compacted` records.
- Claude Desktop local-agent sessions no longer add a missing-root warning on machines without Claude Desktop.

### Changed

- Moved from the GBrain skillpack layout to `src/`, `test/`, `data/`, `docs/`, and `skills/`. The agent skill now runs the `session-analytics` command.
- Repositories registered in Conductor are identified by a pseudonymous `conductor-<hash>` key instead of Conductor's raw record ID.
- Both `dashboard` and `report` read the same options; environment overrides use the `SESSION_ANALYTICS_*` prefix (for example `SESSION_ANALYTICS_CLAUDE_ROOT`); the `MACHINE_*` and `CONDUCTOR_*` aliases were removed. `CONDUCTOR_PORT` is still honored.
- The dashboard is titled Session Analytics; saved view and theme preferences use new storage keys.

### Removed

- GBrain skillpack manifest, bootstrap runbook, judge evaluations, and routing fixtures.

## [0.4.4] - 2026-08-05

### Changed

- Replace the mixed Activity palette with seven green-only intensity levels while preserving logarithmic bucketing.
- Bump the package to `0.4.4` for the corrected Activity palette.

## [0.4.3] - 2026-08-05

### Changed

- Expand Activity to a seven-level, logarithmically distributed cool-to-warm color scale so low, medium, and peak session counts remain distinguishable.
- Use light mode as the first-run default while preserving an explicit saved theme preference.
- Bump the package to `0.4.3` for the revised Activity scale and theme default.

## [0.4.2] - 2026-08-05

### Changed

- Remove the oversized dashboard hero and explanatory copy, retaining only compact snapshot metadata alongside the scope controls.
- Bump the package to `0.4.2` for the streamlined dashboard layout.

## [0.4.1] - 2026-08-05

### Added

- Show the exact session count and local weekday/hour in a GitHub-style tooltip when an Activity heatmap cell is hovered or keyboard-focused.

### Changed

- Bump the package to `0.4.1` for the new dashboard interaction.

## [0.4.0] - 2026-08-04

### Added

- Add focused dashboard views for multi-repository distributions, local-time session activity, cost components, provider-separated model usage, per-repository tool distribution, and provider-aware skill distribution.
- Parse explicit Claude `Skill` tool events and infer a lower bound for Codex skill use from read-capable calls that reference canonical `SKILL.md` files.
- Publish normalized skill identifiers, counts, and evidence method without returning skill arguments or file paths.

### Changed

- Group model bars by provider and keep Cursor provider-reported value visually separate from Codex and Claude API-equivalent estimates.
- Limit distribution comparisons to six uniquely colored repositories, place selected and high-activity repositories first, and use logarithmic bins for heavy-tailed duration, cost, and tool-call data.
- Bump the package to `0.4.0` for the new public session fields and dashboard views.

### Fixed

- Render only the active analytics view so provider and time-window controls do not rebuild thousands of hidden elements or stall on machine-scale snapshots.
- Keep distribution selectors and repository distribution tables inside the mobile viewport while retaining internal scrolling for the full repository set.
- Represent tool and skill categories outside the six-item legend as an explicit `Other` segment instead of leaving an unexplained blank share.

## [0.3.4] - 2026-09-13

### Fixed

- Stop charging an unobserved process-wide Codex counter baseline to one session and one calendar day. A Codex cumulative counter is shared by every session file its process owns, so a session that starts mid-run opens on a snapshot describing requests it never issued. When that opening snapshot carried no per-request `last_token_usage`, the whole counter was billed as a single request, inflating the spend of heavily parallel sub-agent workspaces by an order of magnitude and concentrating it on the day each sub-agent happened to start. Only deltas between two snapshots the same evidence file observed are now attributable, and a non-monotonic counter re-baselines instead of billing its full total.

### Added

- Warn per session when a process-wide counter baseline is excluded, and distinguish that case from token events that lacked per-request usage but still yielded an observed delta.
- Regression coverage asserting that an unobserved 900M-token opening snapshot contributes neither session value nor daily spend.

## [0.3.3] - 2026-09-12

### Added

- Add reviewed rate-card entries for `gpt-6-astra` (including its 272K long-context modifiers) and `claude-fable-5-1`, so sessions on those models are priced instead of counted as unpriced.

### Fixed

- Correct the `gpt-5.6-sol` and `gpt-5.6-terra` rates to the published $4/$0.40/$20 and $2/$0.20/$12 per million tokens; both entries previously carried the `gpt-5.5` and `gpt-5.4` rates and overstated API-equivalent value.

### Changed

- Move the rate-card effective date to 2026-09-12 after reverifying every entry against its primary source, and document Claude Fable 5.1's 0.025x cache-read multiplier.

## [0.3.2] - 2026-08-02

### Added

- Price Claude Opus 5 usage at Anthropic's standard global API rates, including separate cache-read, five-minute cache-write, one-hour cache-write, input, and output categories.

### Changed

- Document that fast-mode, US-only inference, batch, and partner-platform pricing modifiers remain excluded when local session evidence does not identify them.

## [0.3.1] - 2026-07-22

### Changed

- Reduce the agent-facing skill to a one-command launch workflow plus a concise guide to evidence locations, processing patterns, and available metrics.
- Replace the multi-step bootstrap checklist with the single dashboard command; CLI and path overrides are now explicitly optional rather than preflight steps.

### Fixed

- Make the dashboard command idempotent: rerunning it recognizes a compatible server already using the selected port, reuses it, and opens the existing dashboard instead of failing.

## [0.3.0] - 2026-07-22

### Changed

- Rename the package and canonical skill from `conductor-session-analytics` to `machine-session-analytics`; provider-owned Codex, Claude, and Cursor history now defines the machine-wide scope, while Conductor is documented and routed as optional repository/workspace enrichment.
- Update CLI, server, dashboard, bootstrap, installer, routing, host exposure, judge criteria, and repository guidance to the provider-neutral identity. The installer accepts the former pack name as a compatibility alias but installs only the new canonical skill.

### Fixed

- Assign duplicated Codex process-wide snapshots to the observer with the closest preceding local response activity, with deterministic timestamp/path tie-breaking, so an earlier stale receiver cannot take another repository's, model's, or execution mode's request.
- Recover a Codex owner event that precedes its model marker only when the same evidence file contains exactly one model ID; ambiguous owners remain visibly unknown and unpriced.
- Attribute Claude usage from nested `subagents` evidence files to sub-agent execution while preserving the composite session and globally deduplicating assistant message IDs.
- Ignore relative Cursor bubble timings that are not plausible Unix-millisecond timestamps, preventing 1970 event dates and multi-decade activity spans.
- Clamp malformed negative provider token counters to zero without changing valid observed usage.
- Add the official standard global Claude Opus 4.6 input, cache, and output rates from Anthropic's pricing documentation instead of leaving those evidenced sessions unpriced.

### Added

- Regression coverage for stale-before-owner Codex broadcasts, Claude sub-agent value, unknown models remaining unpriced, negative Cursor counters, plausible timestamps, and session/model/repository/machine accounting invariants.

## [0.2.1] - 2026-07-22

### Fixed

- Treat Codex cumulative token counters as process-wide snapshots, deduplicate identical total/last-request states across session files, and sum only the owning request's `last_token_usage` instead of multiplying global deltas by every observing file.
- Exclude inherited child-session baselines and repeated broadcasts while preserving model and top-level/sub-agent attribution at the earliest recorded observation.

### Changed

- Label input totals as request input processed and state that repeatedly processed cached context is included; these totals are not unique transcript text.

## [0.2.0] - 2026-07-22

### Changed

- Renamed dashboard dollar totals to priced usage value and separated API list-price equivalents from provider-reported Cursor value; neither is presented as an invoice or actual charge.
- Segmented Codex cumulative deltas at every execution-mode transition so transcripts resumed from sub-agent work are no longer attributed wholesale to sub-agents.
- Kept unknown-model tokens in the pricing-coverage denominator instead of silently reporting complete coverage.
- Added provider toggles to the daily chart, honest Cursor daily-timing unavailability, explicit top-level/sub-agent value, and provider-specific model colors.

### Fixed

- Included ten unique archived Codex transcripts and Claude Desktop local-agent transcripts in the default machine union.
- Accumulated Claude transcript identity until both provider ID and working directory are observed, rejected ID-only directory mismatches, and deferred evidence ownership until validation succeeds.
- Hydrated modern Cursor `bubbleId` records, deduplicated real tool calls through `toolFormerData.toolCallId`, read provider-reported `costInCents`, and assigned composers through 84 workspace databases.
- Selected the longest matching registered repository root and treated cumulative-counter decreases as new observed segments.
- Isolated the memory-heavy Cursor scan in a short-lived child process so its parsed local evidence is released before Codex and Claude analysis.

## [0.1.0] - 2026-07-22

### Added

- Product-neutral machine-wide local agent session analytics workflow.
- One-pass Codex and Claude transcript indexing plus read-only Cursor composer history, assigned through Conductor workspaces, recorded working directories, and Git roots.
- Complete calendar-day spend velocity with labeled USD/date axes, keyboard/mouse point inspection, provider branding, and selectable all/7/30/90/custom analysis windows.
- Immediate repository drill-down from charts and the comparison table, with stale database-only session stubs omitted and uniquely matchable legacy sessions recovered.
- Repository, session, model, token, cost, tool-name, duration, compaction, provider, and evidence metrics without transcript browsing or ambiguous context-pressure scoring.
- Content-free human and JSON CLI with explicit repository narrowing.
- Read-only loopback dashboard with repository comparison, drill-down filters, responsive tables, and focused aggregate visualizations.
- Versioned provider rate card, interpretation catalog, routing fixtures, deterministic parser/server/package tests, E2E CLI checks, and judge evaluations.

### Security

- Public results exclude titles, branches, workspace metadata, repository roots/remotes, raw Conductor/provider IDs, transcript paths/content, commands, credentials, and raw local exceptions.
- The server binds to `127.0.0.1`, rejects non-loopback Host/Origin values, has no CORS or telemetry, and coalesces concurrent refresh scans.

[Unreleased]: https://github.com/rokas-tarasevicius/session-analytics/compare/v0.10.3...HEAD
[0.10.3]: https://github.com/rokas-tarasevicius/session-analytics/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/rokas-tarasevicius/session-analytics/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/rokas-tarasevicius/session-analytics/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/rokas-tarasevicius/session-analytics/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/rokas-tarasevicius/session-analytics/compare/67b0281...v0.9.0
[0.8.1]: https://github.com/rokas-tarasevicius/session-analytics/compare/v0.8.0...67b0281
[0.8.0]: https://github.com/rokas-tarasevicius/session-analytics/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/rokas-tarasevicius/session-analytics/releases/tag/v0.7.0
