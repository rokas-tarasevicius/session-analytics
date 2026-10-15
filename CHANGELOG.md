# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Versions before 0.5.0 shipped as the `machine-session-analytics` skillpack.

## [Unreleased]

### Added

- Subscription limits are tracked per account. Two Claude logins used on one machine, such as a Max plan and a Team seat in separate `CLAUDE_CONFIG_DIR` profiles, are now separate meters with their own plan, weekly reset time and extra-usage state; profiles logged into the same account share one. Agent SDK events find their account through the session's transcript file name, status-line readings through the inherited `CLAUDE_CONFIG_DIR` or transcript path, and Codex readings through the rollout's or app-server's account ID. Account IDs are hashed where they are read. `limits` prints each account labelled with its plan and local profile names, and `limits --json` (schema version 2) adds `accounts`, `meters` and an `account` on every reading. See [Accounts](docs/subscription.md#accounts).
- In-place resets: when a provider restarts a meter at 0% without moving its reset, the readings after it form a new segment of the cycle. Pace, projection, calibration and the closing level use the latest segment, and the restored level is shown as a reset, never as waste. The ledger never merges readings after such a reset with the higher ones before it, and keeps each meter's latest reading on its own, so the level shown is the current one.
- Value is matched to the account whose meters it moved: Claude sessions through their profile, Codex sessions when there is one Codex account on this machine. Value on employer-paid seats, on plans without a price and on sessions that match no account is reported beside the totals instead of inside them.
- The plan list, reviewed on 2026-10-14, adds Claude Team standard and premium seats, ChatGPT Pro 100, 200 and 500, and who pays for each plan. Team, Enterprise and Business seats are treated as paid by the organization: they show API value without a personal multiple and get no plan advice. A plan with a list price can be marked as paid by you or by an employer in the view.
- The privacy manifest lists every field of the limits snapshot, including which fields are local-only. See [Limits endpoint](docs/privacy.md#limits-endpoint-limitssnapshot).
- The demo includes synthetic subscription limits for two Claude profiles (a Team seat that resets on Fridays and runs onto extra usage, and a Max plan without extra usage that resets on Mondays, with a capped 5-hour window and an in-place reset) and a ChatGPT Pro account with a banked reset, and `scripts/screenshots.ts` captures the Subscription view. The demo now discovers Claude inside its synthetic home instead of passing `--claude-root`.

### Changed

- The Subscription view is redesigned around accounts. It leads with **Limits now**: one row per account, the most urgent first, with the weekly and 5-hour bars, the share left this week, the next reset (absolute and relative, in your browser's time zone) and one status, such as "Runs out Thu 18:07 · 9h early", "Capped until Fri 04:00", "Using extra usage" or "Last seen 2h ago". **Next** follows with at most three one-line suggestions whose reasoning opens under "Why?", then one card per account with its own meters, this week's chart, banked resets, credits and extra usage, then **What it's worth**, **History** and **Sources and method**. Model-specific limits are collapsed under their readable names, retired and never-used meters are hidden, and stale meters are muted without a pace tick. Weekly closes of every account share one time axis, with early resets hatched rather than grey (grey is Codex's colour), and 5-hour windows get one lane per account. See the [dashboard guide](docs/dashboard.md#subscription-can-i-keep-working-and-is-it-worth-it).
- Value figures moved below the meters into What it's worth and use plain names: value used, a month of full use, the share of a full week every week, and the typical weekly close (formerly "Extracted", "Monthly potential", "Capacity used" and "Weekly resets used"). Value used states the dates each account is counted from and the value before the first readings that is not counted, and each account's row counts the sessions active in those dates.
- Recommendations are made per account and name it, and route work between accounts, for example "Claude Team seat runs out before its Fri 04:00 reset; Claude Max 20x is at 16%", with the profile to point background agents at. They are ranked by urgency first; the dollar value at stake only orders suggestions of the same urgency.
- The limits ledger moved to `limits-v2.json` (and `limits-inbox-v2.jsonl`) so that an older installation sharing the data directory, such as a scheduled 0.9.0 `limits --quiet`, cannot replace it. The 0.9.0 `limits.json` is imported once and on later harvests, attributed by weekly reset time, and never written; readings that match no account are kept as unattributed history.
- Read positions are stored in the ledger, so a scheduled `limits --quiet` reads only new log lines instead of rereading every recently modified file.
- Projections run from now at the current segment's pace and appear only once two readings and a tenth of the window are behind them; a meter without a recent reading gets none and, with the same evidence behind its last pace, says when it may already be used up.
- Value per 1% drops cycles whose local value explains almost none of the meter's movement (another machine or the web app did the work), calibrates at the first reading at or past 100% (a cap, or the start of extra usage, where Claude's meter stops near 102% while value keeps accruing), and needs two cycles before it is shown.

### Fixed

- Readings from two Claude accounts were folded into one meter, so every weekly cycle looked like an early reset, one account's live week was hidden, and extra usage showed whichever account reported last.
- The Claude plan was read only from `.credentials.json`, which macOS keeps in the Keychain, and only for one profile. It is now read from each profile's `.claude.json` (`oauthAccount` plan enums), and a Team seat is reported as Team even when its user tier looks like Max 5x.
- A Claude limit reached while paid extra usage was in use was recorded as a cap and a lockout. It is now `overage`: work continues, the meter reads above 100%, and the view says the account is on extra usage. A lockout ends at the first reading on extra usage. Full status-line readings, and full windows other than the one an event reports on, are settled from the account's extra-usage state, because hard caps read 101-102% too.
- The headline value multiple divided every provider's value by the price of only the plans that had one (77× where the Codex card said 23×). Ratios now use the same accounts on both sides, and so does a month of full use: the plans you pay for against their price, with employer-paid and unpriced seats beside it. Multiples under 10× keep one decimal. An account no session matched, or with no reading in the selected dates, no longer adds its price to the multiple or claims a free plan has no list price.
- A run-out time could be in the past ("runs out in -53m"), and a 10% reading minutes into a week projected a run-out hours away.
- Weekly cycles whose last reading came long before the reset were counted as fully observed, so "resets left unused", "weekly resets used" and plan advice treated unobserved use as waste. They are now unknown closes and left out.
- Price and capacity were prorated over the whole selected range, including days before the first meter reading and the rest of today.
- With `--remote`, other machines' sessions raised value per 1% for local accounts they never moved. Until sessions record their machine, Codex value is left out while other machines are combined, and the view says so.
- Codex windows that had not started yet, reported at 0% with a sliding reset time, created hundreds of one-reading cycles and false early resets; Claude's 5-hour window did the same while it had not started. Reset instants a few seconds apart no longer split one cycle in two, and a capped reading keeps its own time when readings are merged.
- Codex model-scoped limits were shown with internal IDs and labelled "all models". They now carry the provider's limit name, such as "GPT-5.3-Codex-Spark · Weekly", and meters the provider stopped reporting are marked retired instead of idle.
- A harvest that overlapped another one (two dashboard tabs, or the dashboard and cron) could erase the other's readings for good, including status-line samples that existed nowhere else. Harvests in one process now run one at a time, the dashboard shares a harvest that is still running, and ledger writes in every process take turns, each merging with the ledger on disk. A claimed status-line inbox is deleted only once the ledger is written, so a failed or stopped harvest leaves it for the next one, and a sample appended while the inbox was being claimed is kept.
- A ledger that could not be read was treated as empty and overwritten. A ledger from another version is now left untouched, and an unparseable one is set aside.
- A provider file that failed to read was skipped for good once a later harvest had passed its modification time; it is now retried.
- Value during the daylight-saving fall-back hour was counted twice, and zones with half-hour offsets read activity 30 minutes off.
- An idle Claude weekly meter said the next request starts a new window; Claude weekly limits reset on a fixed weekly schedule, and the next reset is now shown. A meter with no reading since its reset said "100% left" and "Not used this week" although another machine or the web may have used it; it now says there is no reading this week, unless the provider reported the window as not started.
- A Codex tier change to a plan type this version does not recognise, such as `promax`, kept showing the old plan and price; the newer plan evidence now wins, and Codex's `unknown` plan type is ignored. Codex readings without an account joined whichever account a later harvest happened to see in the same home; they now join a home's account only while exactly one account has ever been seen there, and the account the Codex app-server answers for counts.
- Choosing "No subscription" removed the account's card, and with it the only control that could undo the choice. It is now "Exclude from value totals" on the plan chip: the card, its meters and the control stay.
- The two-minute refresh and plan changes moved keyboard focus to the top of the page and reset an inspected chart reading. They now keep focus, the inspected reading, open sections and the scroll position.
- The meters waited for the full session scan, which can take minutes on a first run. They now render as soon as the limits are read, and value fills in when the scan finishes.
- The icon outline style leaked into Subscription charts, outlining every bar (a black or white barcode on phones).
- Day labels on the 5-hour chart collided at phone widths, and explanations were only in hover tooltips; they now thin out, and every explanation is inline text or a disclosure that keyboard and touch users can open.

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
