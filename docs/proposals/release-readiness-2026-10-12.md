# Release readiness review and plan (2026-10-12)

Status: findings are being implemented in the pull requests listed in section 6; line numbers refer to commit 8aad1ee.

Scope: the localhost dashboard (six views, dialogs, URL state, exports), the release surface (README, CHANGELOG, SECURITY, CI, packaging) and the visual system. Baseline: branch `t3code/de5949d7` at `8aad1ee`, identical to `master`; `npm run check` passes (typecheck clean, 792 tests, 0 failures) after `npm install`.

How this was produced: gstack `/qa`, `/design-review` and `/review` lenses run against the synthetic demo (`node scripts/demo.ts --no-open --port 4181`) with the gstack browser at 1440, 1280, 1024, 820 and 375 px in light and dark themes and both densities; a shared snapshot served with `--snapshot`; two independent OpenAI Codex runs (`gpt-6-astra`, dashboard code review and release audit); four Claude review agents (core front-end, view modules and CSS, security, release docs); every finding below marked **verified** was reproduced in the browser or confirmed by reading the code path.

Severity: **P1** fix before tagging. **P2** fix before announcing. **P3** backlog.

---

## 1. Verdict

The dashboard is in good shape: no console errors on any view, every URL state round-trips, dialogs manage focus, no `innerHTML` anywhere, exports escape CSV formulas, the server allowlists static files and enforces loopback, and the money ledger agrees across every view. It is not releasable yet because of four P1 defects (shared-snapshot mode throws on most shortcuts, one malformed raw request kills the server process, the export preview goes stale after a keyboard provider toggle, and the flagship table hides two columns on common laptop widths), ten P2 data and layout defects, and a release surface (README, SECURITY, CHANGELOG, tags, CI) that contradicts itself and the code.

Recommendation: ship **0.8.0** (not 0.7.1) as a source install: seven small pull requests (docs, test harness, dashboard correctness, data, server, CI gates, layout) before a named "flip to public" gate, then four visual-system pull requests as 0.8.1 (section 6), and tag `v0.7.0` retroactively on `ef6a984` so the changelog links resolve.

---

## 2. Dashboard defects (verified)

### P1

| # | Finding | Evidence | Fix |
|---|---|---|---|
| D1 | **Shared-snapshot mode is broken by every global shortcut.** With `--snapshot shared.json`: `1`/`2`/`3` throw `RangeError: Invalid time value` in `windowStartFor`; `4`, `[`, `]`, `g s` un-hide the Summary panel beneath the shared table and then throw `TypeError: Cannot read properties of undefined (reading 'filter')` in `activeView()`; `g v` and the wordmark reveal the empty full-dashboard skeleton ("Building snapshot… · Rate card pending" included); `/` opens a palette with one "Focus undefined" entry per shared row plus "Go to…" items that throw; the help overlay still advertises every key. | Browser: after `g v`, visible panels = `["velocity","shared-snapshot"]`; after the wordmark click the whole Summary skeleton renders under the shared table. Node: `windowStartFor("7","","")` (`src/public/view-model.js:243–249`) and `selectSessions(undefined)` (`src/public/app.js:221–224`) throw. Code: `app.js:1542` stores the shared snapshot in `snapshot` (truthy), while the keydown handler (`:1490–1499`), `applyWindowPreset` (`:1231–1240`), `switchView` (`:438–453`) and `paletteItems` (`:1352–1356`) only guard on `!snapshot`; `shared-view.js:9–16` hides nav but not `.scope-line` or `#help-button`. | Preferred: store the shared payload in a separate `sharedSnapshot` variable and leave `snapshot` null, so the ten existing `!snapshot` guards become correct by construction and only `exportSelection` (`:1647`), `markStale` (`:1520`) and `render` change. Alternative: add `snapshot?.kind === "shared"` to the keydown handler, `applyWindowPreset`, `switchView`, `stepView` and `paletteItems` (the guard `syncUrl`/`restoreUrlState` already use at `:270,280`). Either way, `renderSharedSnapshot` hides `.scope-line` and `#help-button`, points the wordmark at `#shared-snapshot`, and the hide/un-hide selector lists in `shared-view.js:10–14` and `app.js:1543–1546` become one constant. Regression test: load a shared snapshot in the DOM harness, fire `1`, `4`, `[`, `g v`, `/`, assert no throw, no panel un-hidden, palette has no view or focus entries. |
| S1 | **One malformed raw request kills the server process.** `new URL(request.url …)` runs outside the `try` in the async handler; an absolute-form target the WHATWG parser rejects becomes an unhandled rejection and Node 24 exits. The Host/Origin gate never runs first. `SECURITY.md:53` puts "crash the server process" in scope. | Confirmed against a sandboxed instance: `printf 'GET http://a:b:c/ HTTP/1.1\r\nHost: 127.0.0.1:4174\r\n\r\n' \| nc 127.0.0.1 4174` → `TypeError: Invalid URL … src/server.ts:187:15`, then `ECONNREFUSED`. Browsers never send this form; any local process or co-tenant can. | Move the parse inside the `try` and answer 400; add a `process.on("unhandledRejection")` backstop that logs a fixed line and keeps serving; regression test with a raw `net` socket. |
| D2 | **Export preview goes stale after a keyboard provider toggle.** Open Export, press `p 1`: the Codex chip unchecks and the chart re-renders, but the menu stays open with the old "265 sessions" description and the download uses the previously captured selection. A mouse click on the chip correctly closes the menu. | Browser: `menu.open === true` and unchanged description after `p 1`; `false` after a chip click. Code: `src/public/app.js:1321` `toggleProvider` calls `renderLine` without `closeExportMenu()`; `toggleTheme`/`toggleDensity` at `:1279`/`:1288` do call it. Codex verified the downloaded JSON still contained both providers. | Call `closeExportMenu()` at the top of `toggleProvider` for every scope (the Velocity scope reaches `velocity.js:318` through `velocityChip(provider)?.click()`, so no change in velocity.js is needed or possible). Cheap systemic guard: at download time `export-menu.js` recomputes `getSelection()`, compares its description to the preview and resets with "Selection changed; reopen Export" on mismatch. Test: open menu, toggle via shortcut on Summary and Velocity, assert menu closed and preview null. |
| D3 | **Fleet comparison table clips Cache and Priced with no affordance.** At 1280 px (and at 1440 px in comfortable density) the table is 1108 px wide in a 968 px wrap; macOS overlay scrollbars are invisible, so the last two columns simply do not exist for the user. | Browser at 1280: `wrapW 968, scrollW 1108`. Screenshots `summary-light-1280.png`, `summary-comfortable.png` show the header ending at "CAC". | Make the table fit: move "ID 5d60b7cc" and "27 top-level · 3 sub-agent · …" sub-lines into a `title`/tooltip, shrink coverage badges, allow the Repository column to truncate. Also add a scroll affordance (sticky first column plus edge fade) for any `.table-wrap` that overflows. |

### P2

| # | Finding | Evidence | Fix |
|---|---|---|---|
| D4 | **Tools profile footer says "UTC"; buckets use the snapshot timezone.** | `src/public/tools.js:143` hard-codes `· UTC`; `:92` (the accessible description) correctly interpolates `timeZone`. Visible on the Tools screenshot. | Interpolate `timeZone` at `:143`. One-line test. |
| D5 | **Velocity shows "$0.00" when selected sessions have no activity ledger.** Summary and Costs show "—" for the same snapshot; Velocity's lead cards format zero-initialised totals. Affects legacy `--snapshot` files. | `src/public/velocity.js:253` `kpi({ label: "Usage value", value: formatMetric(price.total, "value") … })` with no availability check; the card two lines above already uses the `value: null` + `reason` contract of `ui.js:105`. Codex reproduced with an in-memory snapshot. | Apply the same availability guard as Summary; show "—" with a reason when every ledger is missing and "partial" when some are. |
| D6 | **Pricing card shows "0 calls" where there is no call evidence.** The Cursor `claude-opus-5` card reads "5,025,500 tokens · 0 calls"; Costs shows the same model without a call count. The product's own rule (Coverage dialog) is "unavailable is shown as a dash, never as zero". | `src/public/pricing.js:92` `["Calls", integer(usage.calls)]`. | Render "—" when `usage.calls` is null/undefined or the provider has no call evidence. |
| D7 | **Error copy concatenates the raw error.** Refresh failure banner reads "Failed to fetch Showing the snapshot from 12 Oct 2026, 15:59." | Browser with `fetch` rejected: `#error-message` = "Failed to fetch Showing the snapshot…". | Compose: "The local server did not answer (Failed to fetch). Showing the snapshot from …". |
| D8 | **Daily usage header wraps at 1280 px.** The panel title breaks onto two lines and the provider chips wrap onto two rows. | Browser at 1280: `h2 41 px tall, chip row 64 px`. | Put the chip row on its own line under the title below 1440 px. |
| D9 | **Repository focus leaves three one-bar panels.** With a repository focused, "Usage value by repository", "Request input processed by repository" and "Delegation" each show a single bar. | Screenshot `repo-focus.png`. | When focused, swap these panels for a per-provider or per-model breakdown of the focused repository, or hide them. |
| D10 | **Demo temp directories leak.** 47 `session-analytics-demo-*` directories in `$TMPDIR` dated 2026-10-02 to today. | `scripts/demo.ts:645–648` already forwards `SIGINT`/`SIGTERM`/`SIGHUP` and cleans up on any child exit; the leak comes from test watchdogs that `SIGKILL` the demo (`test/index-coordination.test.ts:56,60`, `test/mcp.test.ts:111,311`) and from parent crashes. | Sweep stale `session-analytics-demo-*` directories older than a day on demo start, and have the test watchdogs send `SIGTERM` first and `SIGKILL` only after a grace period. Test: a pre-created stale root is gone after `demo.ts report --json`. |
| D11 | **tools.csv disagrees with the Tools view.** The export sums `Object.entries(s.tools)` for every session; the view only counts sessions where `metricEligible(session, "tools")` holds and values that pass `callCount`. An `invalid` transcript carrying `{ Invalid: 1000 }` (the fixture at `test/tools-data.test.ts:35–36`) is excluded on screen but adds 1000 calls to the CSV; NaN or negative counts reach the file. | `src/public/export-data.js:84–87` vs `src/public/tools-data.js:33–36`, `src/public/providers.js:60,64`. | Gate on `metricEligible(s, "tools")` and reuse `callCount` in `csvTables` and `aggregateSessions` (`:133`). Test: export with the invalid fixture, assert the tool is absent. |
| D12 | **Rolling 7-day average is missing for the first six days of every window.** It is computed from the window's own `daily` array only, although the comparison cards already load two extra months. On the default 30-day window the dashed line covers 80% of the chart; a 7-day custom window shows one point; the "Dashed: total · rolling 7-day average" key is appended even when every value is null. | `src/public/velocity-data.js:192`; `comparisonSpan` at `:220`; key at `src/public/velocity.js:162`. | Build the rolling series from `comparisonData.daily` and slice to the window; append the key only when `data.rolling.some(v => v !== null)`. |
| D13 | **Pricing and Velocity KPI grids ignore the shared 1000 px breakpoint.** `#pricing-panel .kpi-grid` (ID specificity) and `.velocity-lead`/`.velocity-totals` (later in the cascade) override `styles.css:702`; they only collapse at 520 px. At 820 px Summary KPIs are 2-up while Velocity's comparison row stays 3-up with 225 px cards and Pricing auto-fits 15 rem columns. | `src/public/pricing.css:4`, `src/public/velocity.css:5–6`, `src/public/styles.css:702`. | Express per-view column counts as a `--kpi-columns` custom property consumed by the shared rule, or scope the overrides to `min-width: 1001px`. |
| S2 | **Cross-site requests without an `Origin`, or from another loopback port, are accepted.** `SECURITY.md:35` says the Origin rule blocks cross-site requests; it only blocks requests that carry an Origin. `<img src="http://127.0.0.1:4174/api/analytics?refresh=1">` on any website forces a full rescan and a fresh 1 GB-heap worker each time; a page on another localhost port can `fetch` it. CORP/COOP stop the body being read, so this is a trigger, not a leak. | `src/server.ts:107,109–110,207`; probes returned 200 with no Origin and with `Origin: http://localhost:3000`. | For `/api/*`, require `Sec-Fetch-Site` to be `same-origin` or `none` when present; compare the Origin `host` (with port) to the request `Host`; update SECURITY.md to say what is blocked. Tests for `Origin: https://evil.example`, `Origin: null`, `Origin: http://localhost:3000`. |
| S3 | **Port reuse trusts any process that answers the health probe and ignores analysis options.** "Compatible" is three JSON fields anyone can serve; a squatter on 4174 makes the default launch print "already running" and open the squatter's page; a second launch with `--exclude-hidden`, `--data-dir` or `--rate-card` silently reuses an instance started with other options. | `src/server.ts:254–259,267–270`; `test/server.test.ts:239–250` covers identical arguments only; `scripts/demo.ts:597–600` already refuses to reuse. | Put a per-launch random token (stored 0600 under the data dir) and a SHA-256 of the normalised `analyzeOptions` in `/api/health`; reuse only on a match, otherwise exit 1 with "port in use by a dashboard started with different options". |

### P3

Behaviour and copy:

- `?repo=conductor-2e990ef5…`: the "opaque" repository ID carries a `conductor-` source prefix. Hash it or drop the prefix before it goes in the URL.
- The "Adjusted" label next to a clamped custom range is cryptic; say "Clamped to history".
- "24 unknown starts excluded" appears in a one-day custom window; scope the count to the window or drop it when the window is short.
- Single-day custom window shows a page of `$0.00` rows and six `$0` repositories in the sidebar; collapse rows with no sessions in the window into one "5 repositories had no activity" line.
- "Last 7/30/90 days" ends on the last observed day, not today (`app.js:1208–1218`, `view-model.js:243–249`); the segment, palette and help say "Last 7 days" while Velocity's "Today / 14-day median" uses the real today. Label the presets "last N observed days" or anchor them at today.
- Velocity movers label a zero prior as "— small baseline" while Tools calls the same case "new" (`velocity-data.js:346`, `tools-data.js:11`). Use "new" in both.
- Burn KPI reason is always "Needs a 14-day baseline" even when the window ends before today or has under three active days (`velocity.js:275`, `velocity-data.js:300–302`).
- Escape does not cancel an armed `g` chord (`app.js:1475–1480`); ⌘K is swallowed inside the pricing dialog (`pricing.js:124`) although the help promises it always works.
- A refresh that removes the focused repository leaves `?repo=<gone>` in the address bar (`app.js:922–927`; `render` never re-syncs once `urlReady`).
- Summary exports follow the daily-chart provider chips while the KPIs and fleet table do not (`app.js:1635–1657`); disclosed only as "2 of 3 providers". Either export what the KPIs show or name the chips in the description.
- `historyCoverage` appears in the JSON export from Costs but not from Summary for the same selection, because `providers` is passed as an array even when every provider is selected (`export-data.js:194`, `app.js:1655`).
- Two divergent `coverageWarnings` implementations (`view-model.js:63–81` for the dialog, `evidence.js:139–155` for exports) warn about different things; make one delegate to the other.
- `velocityIndicators(data, null)` throws for a `generatedAt` without a timezone suffix (`velocity-data.js:271,295`); only hand-edited snapshots reach it.
- Pricing freshness link `href` has no scheme guard (`pricing.js:206–207`) while the model-card link does (`:81`).

Accessibility:

- `#sync-context` and `#view-status` are not live regions; "Refreshing…"/"Local snapshot ready" and the empty-window state are silent (`index.html:118,145`).
- Keyboard focus drops to `<body>` after an export download because `reset()` disables the activated button (`export-menu.js:87`).
- Velocity's inspection block is `aria-live` and rewritten on every `pointermove` and resize (`velocity.js:163–191`), so mouse movement re-announces every series value.

Performance and dead code:

- Per-repository `topTools` and `warnings` are computed on every render and never read (`app.js:207–208`); chip toggles rebuild the whole view model to read one field (`app.js:1328,1617`); `renderActivity` is O(repositories × sessions) (`app.js:577–580`).
- Six copies of the `el`/`node` element factory; `renderWarnings` runs twice per Summary render (`app.js:1083,1153`); `renderSummaryVelocity` is unused (`velocity.js:336`); several exports are used only by tests.

Security (Low/Info, from the security review):

- GitHub Actions pinned by tag, not SHA (`.github/workflows/ci.yml:29,34`); Dependabot already tracks `github-actions`.
- `docs/privacy.md:446` documents `/api/health` without the `dataSource` field the code returns.
- No test sends `Origin: https://evil.example`, `Origin: null`, `Origin: http://localhost:3000` or an absolute-form request target (`test/server.test.ts:61–73`).

### Checked and clean

No console errors on any view, theme, density or width. Bad URL parameters (`view=bogus`, `repo=nope`, `start=garbage`, `end=2026-13-99`) fall back silently without errors. Custom range writes `?window=custom&start=…&end=…`; Back/Forward restore state. Palette ranking ("cos" finds Costs), help overlay (`?`), coverage dialog (`e`) and pricing dialog all move focus to their title and restore it on close; Escape closes the export menu first. Tab order is logical. Fonts: Geist Sans and Geist Mono only. No horizontal document overflow at 375, 820, 1024 or 1280 px. Ledger totals agree across Summary KPI, daily chart legend, Costs, Pricing cards and the fleet table ($940.63). CSV cells are formula-escaped and the server static allowlist is explicit.

---

## 3. Visual system review and proposed styling changes

First impression (1440 px, light): the site communicates competence and density. The eye goes first to the `$940.63` figure, then to the coral Claude area in the daily chart, then to the History coverage table. The third is wrong: a machine-wide evidence table should not out-rank the charts. One word: **crowded**.

Trunk test: PASS. Site ID, current view, sections, options and search are all visible without context.

Rendered system (extracted from the live DOM): font sizes in use are 8, 11, 12.5, 14 and 26 px; `h1` (page title) and every `h2` (panel title) render at 14 px / 600; 232 leaf text nodes on Summary are 11 px; the Copilot/OpenCode/Gemini mark pills are 8 px text; repository-name buttons in the fleet table are 17 px tall; 24 more controls are between 24 and 32 px.

Calibration source: there is no DESIGN.md; `docs/branding.md` is the stated system and the proposals below stay inside it. A first draft of this section was rated 6/10 by the gstack design lens because its token values collided with existing consumers (renumbering `--fs-lg` from 20 to 16 px would have shrunk every secondary figure that uses it) and because it named values without diffs or edge-state copy. This version carries the diffs.

### 3.1 What to keep

The token set in `styles.css` is a real system: layered neutrals, 1 px lines, 8 px radius, provider brand ramps, a validated categorical palette, light and dark themes, two densities, reduced-motion-safe transitions, and reusable pieces that the fixes below should build on rather than replace: the `.evidence` disclosure (`styles.css:783`), the Tools card-list table pattern (`tools.css:63–77`), `.chart-legend[data-layout="list"]` (`styles.css:463`), the `(pointer: coarse)` block that already sets 40 px controls and 44 px rows (`:880–889`), `.status-banner[data-tone="warn"]`, and `.empty-state` with `.status-actions`.

### 3.2 Proposed changes, in execution order

Effort: S under an hour, M a few hours. Each item names the principle it serves.

**Tokens and hygiene (do first, measurable):**

1. **S · Add type roles instead of renumbering** (hierarchy as service; numbers must outrank titles on a dashboard). Diff for `:root` (`styles.css:126–130`) and the comfortable block (`:241`):

   ```css
   /* :root */
   -  --fs-xs: 11px;  --fs-sm: 12.5px;  --fs-md: 14px;  --fs-lg: 20px;  --fs-figure: 26px;
   +  --fs-caps: 11px;    /* mono uppercase labels */
   +  --fs-xs: 12px;      /* sans notes, legends, deltas, badges */
   +  --fs-sm: 13px;      /* body, table cells */
   +  --fs-md: 14px;      /* controls */
   +  --fs-title: 15px;   /* panel h2/h3 (:396, :772) */
   +  --fs-h1: 18px;      /* topbar h1 (:308), dialog h2, #shared-snapshot h1 */
   +  --fs-lg: 20px;      /* secondary figures, unchanged */
   +  --fs-figure: 26px;  /* unchanged: the 1.8vw clamp at :377 never reaches 28 under max-width 1520 */
   /* [data-density="comfortable"], explicit values rather than a multiplier */
   -  --fs-xs: 11.5px; --fs-sm: 13.5px; --fs-md: 15px; --fs-lg: 21px; --fs-figure: 28px;
   +  --fs-caps: 11.5px; --fs-xs: 12.5px; --fs-sm: 13.5px; --fs-md: 15px; --fs-title: 16px; --fs-h1: 19px; --fs-lg: 21px; --fs-figure: 28px;
   ```
   Point `:308`, `:396`, `:772` and `interop.css:5` at the new title/h1 tokens; the seven mono-caps labels at `--fs-caps`. Use `--fs-figure` flat for `.kpi strong` instead of the `clamp()` at `:377`, which makes figures 23 px at 1280 and 25.9 px at 1440 and resizes them when the sidebar collapses (`:878` already handles ≤ 520 px).
2. **S · One `.caps` rule.** Seven copies of the mono-uppercase label with three trackings (`styles.css:274`, `:395`, `:475`, `:505`, `:636`, `:651`, `:745`; .04/.06/.08 em). One rule with `--track-caps: .06em`. Eight shimmer gradients (`:610–623`) become one `.shimmer`.
3. **S · Merge duplicated selectors** where the second silently wins: `main > footer` `:603`/`:840`, `.compact-metrics` `:388`/`:780`, `.help` `:648`/`:734`, `.field` `:744`/`:747`, `.kpi` `:374`/`:759` (first `grid-template-areas` dead), row cursor set three times (`:491`, `:806`, `:866`), the no-op `max-width: 1240px` KPI rule (`:672`), the 1120/760/520 px media blocks split across the file and duplicated in `pricing.css:62`. The "shared view components" block from `:730` is an append log; fold it into the sections it overrides.
4. **S · One focus ring.** Fourteen `:focus-visible` rules (eleven in styles.css, one each in velocity, tools, pricing) with offsets −2, 1, 2, 3, 4 and 6 px, while `:257` already covers every control and `docs/branding.md:38` promises one ring. Keep `:257`, `:333` (chip), `:756` (checkbox) and `tools.css:15` (inset for clipped cells); delete the rest; remove `border-radius` from `:257`, which snaps the repository select's corners from 6 px to 4 px on keyboard focus.
5. **S · Theme-scoped chart tokens** (fix the cause: `:423` is a flat `fill-opacity: .1` in both themes, so dim orange over near-black composites to brown `#281e17`):

   ```css
   :root                    { --grid-line: var(--line);        --area-alpha: .1; }
   :root[data-theme="dark"] { --grid-line: var(--line-strong); --area-alpha: .18; } /* #363831 is 1.53:1 on --surface; --line is 1.22:1 */
   -.grid-line  { stroke: var(--line); }      +.grid-line  { stroke: var(--grid-line); }
   -.trend-area { fill-opacity: .1; }         +.trend-area { fill-opacity: var(--area-alpha); }
   ```
   Do not lift `--line` globally (60+ borders depend on it). A per-series `<linearGradient>` (24 % at the line to 0 at the baseline, `app.js:787`) is the follow-up. Replace the only hex literals outside the token blocks, the dark logo tile `#2a2c26`/`#4a4d44` at `:302`, with `--surface-3`/`--line-strong`; add `--radius-lg: 12px` (dialogs `:630`, `:648`) and `--radius-bar: 3px` (`:413`, `:522`, `:542`, `:570`, `:598`); map the 30/34/36 px literals (`:475`, `:478`, `:637`, `:654`, `:784`, `:833`) to `--control`/`--row`.
6. **S · Chips** (state must be visible in both themes). The unchecked chip today is muted text with a dashed `--line` border at 1.16:1 on `--bg`. Keep the hollow dot (`:335`) and the 45 % mark (`:336`) as the state carrier and make the text readable:

   ```css
   -.chip:has(input:not(:checked)) { color: var(--muted); background: transparent; border-style: dashed; }
   +.chip:has(input:not(:checked)) { color: var(--text-2); background: transparent; border-color: var(--line); }
   ```
   A `--surface-2` fill would invert prominence in dark (`#1b1d19` is lighter than the checked `#151613`). Put the provider chip row on its own line under the Daily usage title at every width: "Gemini" already orphans at 1440 px and the title breaks at 1280 (D8).
7. **S · Marks and targets** (WCAG 2.5.8, 24 px). `.pill.mark` from a 16 px tile with 8 px text (`:504`) to 18 px / 10 px; delete the three 9 px overrides (`:462`, `tools.css:21`, `pricing.css:28`). `.row-link` (`:867`) gets `min-height: 24px; padding: 3px 0`; footer and rate links `display: inline-block; min-height: 24px; line-height: 24px`. Leave the coarse-pointer block alone; it already exceeds this.
8. **S · Coverage badges as text, not hover.** `cursor: help` carries information at `:764` (KPI title), `:766` (coverage badges), `:869` ("Adjusted"), `:870` (stale timestamp): invisible to touch and keyboard. Render the badge as plain `45/49` in `--muted`, put the reason in the banner or note, delete the "hover a badge for coverage" instruction at `index.html:203`.
9. **S · Tables that fit** (visible affordances). Scope `table { min-width: 880px }` (`styles.css:474`) to the fleet table only; a CSS-only scroll shadow (`background-attachment: local` pattern, no scroll listener) on `.table-wrap`; sticky first column only below 1280 px with an opaque `var(--surface)` and `z-index: 3` at the corner because `thead th` is already sticky at `z-index: 2` (`:475`); the ID and session-breakdown sub-lines move to `title`; sticky header stays. Top movers: widen NAME, narrow EVIDENCE. Ten-line `@media print`: static sidebar and top bar, `max-height: none` on `.table-wrap`, hide `.topbar-actions` and `.export-menu`.
10. **S · Reduced motion needs a textual cue.** `:726` blanket-kills the refresh spin (`:352`) and the status pulse (`:343`), leaving only `opacity: .55` on `main`; `#sync-label` must read "Refreshing…" during a refresh in every mode.

**Structure and copy (the hierarchy fixes):**

11. **M · Zero kickers on Summary; noun-phrase titles** (subtraction; by the plan's own rule a kicker labels a group, and every Summary panel labels one panel). Remove `.kicker` from Summary, Tools, Pricing and Velocity panels where it restates the heading ("End-of-month scenario", "Rates used by selected models"); keep only the Evidence line. Retitle: "Sessions by provider", "Usage value by model", "Sub-agent value" (qualifier "lower bound" in the note), "Repositories", "Sessions by repository"; never "Every repository, one ledger".
12. **M · Copy cuts as a rule, not a hope** (Krug's third law). `.chart-note` and `.kpi-note` are one line; sentences move into the Coverage dialog, which exists for exactly this. The Usage value KPI note goes from four lines to one, which equalises KPI card heights (204 vs 146 px today).
13. **M · History coverage becomes a status line** built on the `.evidence` disclosure (`:783`): "History coverage: 86 % of native value recovered on 5 paired sessions · details". Same component as "Evidence & limits", so it reads as one system.
14. **M · Six KPIs.** "Live snapshots" moves into the status pill ("Local snapshot ready · 0 live"); "Repositories 6 / 6 with sessions" is already in the scope line and the sidebar count.
15. **M · One formatter module** (`src/public/format.js`), pulled forward as its own small PR because eight modules build their own `Intl` formatters today (`app.js:114–126`, `view-model.js:11,327,338`, `velocity.js:19–29`, `tools.js:7–8,101`, `shared-view.js:6–7`, `history-coverage.js:1–2`) and `pricing-data.js:11` uses a different locale. Axes: `en-GB { day: "numeric", month: "short" }` ("13 Sept"); ranges "13 Sept – 12 Oct 2026"; axes drop cents at or above $10, tables keep cents so the ledger still reconciles. Add a `design-system.test.ts` rule that view modules do not call `new Intl.` directly. The daily legend (`:450`, flex-wrap) orphans "OpenCode $5.00" at 1440; use `[data-layout="list"]` in two columns.
16. **M · Velocity defaults.** Group by Provider (six series), cap visible series at six plus "Other", render the readout (`velocity.css:17`) as a two-column grid, show "Dashed: total · rolling 7-day average" only when the box is checked and the series has a value (D12).

**View-level finishes:**

17. **S · Pricing cards.** Remove the twelve repeated "API-equivalent value · activity-dated" lines (say it once in the section subtitle; the subgrid `span 8` at `pricing.css:20` becomes `span 7`); "— calls" when there is no call evidence (D6).
18. **S · Error and empty copy** per 3.3 below; refresh failure uses the warn tone. Keep "Coverage · 3" visible (it is a convention and the label already hides at ≤ 1120 px, `:861`); give it the accessible name "Coverage: 3 notes".
19. **M · Focused-repository panels** per 3.3(b).
20. **S · Regenerate `assets/screenshot-*.png`** and gate on measurable checks: no `font-size` literal outside `:root`, one global focus rule, no interactive element under 24 px, no non-text colour under 3:1, equal KPI heights within a row.

Deferred (0.8.2 or later): the mobile pass. What it should be when it comes: a window `<select>` beside the repository select (two 160 px controls fit 375 px), the fleet table rendered with the Tools card-list pattern (`tools.css:63–77`), 1-up KPI grid below 400 px (the 2-up grid leaves 113 px for a 20 px mono value and `$12,345.67` wraps mid-number via `overflow-wrap: anywhere`, `:875–878`). Not a horizontally scrolling KPI strip: that hides cards with no affordance, which is D3 again.

### 3.3 Edge states, with copy

**(a) A window with one session** (today: eight cards, a one-dot chart with a $0.16 axis, a 100 % donut, five `$0.00` rows, "24 unknown starts excluded"). A chart with one point is not a chart.

- Scope line: `1 session · 24 Jul 2026 · data-pipeline · Claude · $0.15`.
- Daily usage value: at two or fewer active days, replace the SVG with the legend list and one line, `Only 24 Jul has activity · widen the window for a trend`, plus a **Show 30d** button.
- Session share: one series renders as text, `1 session · Claude`, no ring.
- By-repository panels: rows with activity, then one muted line `5 repositories had no activity in this window`.
- Fleet table: rows with sessions only; footer row `5 repositories without sessions · Show them`.
- Delegation: `No sub-agent sessions on 24 Jul 2026.` (name the absent thing and the window; "No activity in this view", `app.js:306`, is false because the view has activity).
- "Adjusted" becomes "Clamped to history"; scope the excluded-starts count to the window.

**(b) A focused repository** (today: three one-bar panels and a one-row table titled "Every repository, one ledger"). The focused user's question is how this repository compares.

- Scope line: `data-pipeline · 49 sessions · 13 Sept – 12 Oct 2026 (Europe/London)`.
- "Usage value by repository" becomes **Usage value by provider** (Claude $264.03, Codex $54.05, Cursor $2.97, Gemini CLI $0.89, OpenCode $0.83); "Request input processed by repository" becomes **Request input by provider**.
- Delegation: hide the bar list; header note `Sub-agent value $11.90 · 3 sub-agent sessions`.
- Fleet table: title **data-pipeline vs fleet**; focused row highlighted plus a muted `All repositories` total row as the comparator; the hint becomes `Showing data-pipeline · Clear focus`.

**(c) Refresh failure** (today: a red banner, a red status pill and an amber "stale" with `cursor: help` for one event, with the raw error concatenated and the data underneath intact). This is a warning, not danger.

- `data-tone="warn"`. Title **Couldn't refresh**. Body: `The local server did not answer (Failed to fetch). You are looking at the snapshot from 12 Oct 2026, 15:59.` Action **Retry**.
- `app.js:1586`: a pure `describeLoadError(error)` returns `The local server did not answer (${message without trailing period}).` for network errors and `The analysis failed (HTTP 500).` for HTTP errors; `showError` appends `You are looking at the snapshot from …`.
- Status pill `Stale · 15:59`; the timestamp keeps "· stale" and loses `cursor: help`.
- First-load failure: title **No snapshot yet**, body `The local analysis did not finish. Retry, or check the terminal running the dashboard.`

### 3.4 Dimension ratings (gstack design-review method)

| Dimension | Today | What makes it 10 |
|---|---|---|
| Hierarchy | 5 | Seven-role type scale (1), zero kickers on Summary (11), History as one line (13), notes at most one line (12) |
| Consistency | 6 | One caps rule (2), one focus rule (4), one formatter (15), one mark size (7), no duplicate selectors (3) |
| Empty, error and edge states | 5 | The three states in 3.3 shipped as written |
| Responsive | 6 | Fleet table fits 1280 px unscrolled (9), chip row (6), KPI breakpoint shared (D13), two selects at 375 px (deferred) |
| Accessibility | 7 | 24 px inline minimum and 10 px marks (7), badges as text (8), textual refresh cue (10) |
| Data visualisation | 7 | Provider default and six-series cap (16), theme-scoped fills (5), axis formatter (15), tiny windows as a list (3.3a) |
| Trust and tone | 7 | "—" never "$0.00" for absence (D5, D6), one signal per failure (3.3c), noun-phrase titles (11) |

### 3.5 Contrast reference (WCAG AA 4.5:1 for text, 3:1 for non-text)

| Pair | Light | Dark | Note |
|---|---|---|---|
| `--text-2` on `--surface` / `--surface-2` | 6.50 / 6.01 | 7.55 / 7.06 | pass |
| `--muted` on `--surface` / `--surface-2` | 5.26 / 4.85 | 5.32 / 4.97 | pass; thinnest margin is light muted on surface-2, so do not lighten `--muted` |
| `--muted` on `--surface-3` | 4.44 | – | fail; no text pairing uses it today, keep it that way |
| `--provider-unknown` line on `--surface` | 1.75 | 2.09 | fail (non-text); draws "Other (N)" and "Unknown" Velocity lines; lift to ≥ 3:1 |
| Dark tier-3 model shades `#555551` / `#87402a` | – | 2.4 | fail (non-text) |
| Dark `--category-0 #357101` | – | 3.04 | pass, no margin |
| Unchecked chip border `--line` on `--bg` | 1.16 | – | replaced by item 6 |
| `--line` / `--line-strong` grid on dark `--surface` | – | 1.22 / 1.53 | item 5 |

---

## 4. Release surface (docs, CI, packaging, security)

Items from the Claude release-docs audit and the Codex release audit, de-duplicated and checked against the worktree.

### P1 (blocking a tag)

| # | Item | Evidence |
|---|---|---|
| R1 | **Cut the version.** `package.json`, `package-lock.json` and `src/version.ts` say 0.7.0 while four substantial dashboard PRs sit under `[Unreleased]`. Assign 0.8.0 and a date, keep the accounting-change explanations. | `CHANGELOG.md:5–40`; commits `7ad28f3`, `9f99c0a`, `21663e9`, `8aad1ee` all reflected. |
| R2 | **No git tags exist.** `git tag` is empty across 18 changelog versions, so a GitHub Release has nothing to attach to and the changelog cannot link compares. Tag `v0.7.0` on `ef6a984`, then `v0.8.0` on the release commit. | `git tag` output. |
| R3 | **README contradicts itself twice.** The numbered list after "three commitments" (`README.md:50–55`) contains items 1–2 twice and the two item 2s disagree on where prices come from (feeds plus reviewed card is correct: `src/pricing/sources.ts:10`, `src/pricing/catalog.ts:26`). Two privacy paragraphs (`:278` vs `:280`) disagree on network behaviour; the dashboard does refresh stale prices at startup (`src/server.ts:297`). Two FAQ answers to "Does anything leave my machine?" (`:362`, `:364`). Delete the stale copies. | Quoted lines. |
| R4 | **SECURITY.md is stale and self-contradictory.** Supported versions table lists only 0.5.x (`SECURITY.md:9–10`); "Offline by default. No background network requests" (`:33`) contradicts the startup pricing refresh described three lines earlier (`:30`). | Quoted lines. |
| R5 | **Status badge says "private preview"** (`README.md:18`) and links to a roadmap intro that calls 0.5.0 "in progress" (`docs/roadmap.md:18`). | Quoted lines. |
| R6 | **Pre-publication review of history and tracked research material** is an unchecked gate in `docs/proposals/distribution-launch.md:160`. The audit's pickaxe over history found no secrets or home paths, but the gate itself has not been signed off. | Audit result. |
| R7 | **Private vulnerability reporting** must be enabled in repository settings before the SECURITY.md link works for the public. | `SECURITY.md:16`. |

### P2 (before announcing)

- Heap limit: README `:177`, `docs/mcp.md:105`, `docs/providers.md:256`, `docs/architecture.md:177` say 256 MB; code is 1024 MB (`src/analysis-process.ts:8`).
- `package.json:4` description still advertises "reliability", removed in 0.7.0; it also names only three providers.
- `docs/mcp.md:63,70` and `docs/metrics.md:563` list three providers for `compare_agents`; code has seven (`src/mcp/tools.ts:11`).
- `docs/interop.md:127` "The initial v1 contract is still unreleased." It shipped in 0.6.0.
- README options table lists `--rate-card` twice (`:206`, `:212`) with different scopes; `merge` does not accept pricing flags although the table says "all".
- README `:106` says non-velocity totals use start dates; every money total now uses activity dates (`ledgerMoney`, `src/public/view-model.js:138`).
- `docs/privacy.md:197–273` has duplicated and conflicting field rows (provider, status, effort, snapshotWhileWorking, warnings) and a prose paragraph inside the table; `:117` says the proposed team/export controls "are not protections available today" although sharing shipped.
- `docs/metrics.md:164` vs `:654` disagree on whether Codex Spark is zero-rated or unpriced; `:646` references the removed Models view.
- `docs/roadmap.md:125–143` lists shipped providers and OTLP as unshipped and says both "will move" and "now ingests".
- README `:316`, `:338` prose still speaks of v0.6.0/v0.6.1 as current.
- CI: no CLI smoke (`--version`, `--help`, `demo report --json`, `npm pack --dry-run`), no `scripts/snapshot-schema.ts --check`, and the macOS PR label has no `labeled` trigger (`.github/workflows/ci.yml:6,25`). Once public, macOS minutes are free: run both OSes on PRs.
- `npm install github:…` fails on Node 24 (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` for a `.ts` bin under `node_modules`); `npm link` from a checkout works. Say so in README.
- `.lane/` (verification artifacts, referenced by README `:177` and `docs/privacy.md:3`) is not in `.gitignore`.
- Screenshots `assets/screenshot-dashboard.png` and `screenshot-velocity.png` predate 12 dashboard commits (Models view removal, grouped nav, brand colours, visual rewrite). Regenerate from the release commit after the styling pass.
- README `:427–434` has an orphan "History coverage" section after `## License`.
- CONTRIBUTING privacy rule 5 appears three times (`:67–70`) with conflicting network statements; two "Adding a provider" bodies (`:76–89`); project layout (`:34`) lists two commands instead of seven.
- Issue templates: version placeholder 0.5.0, provider list lacks Copilot/OpenCode/Gemini/Cursor SDK, surface list lacks MCP and Export; PR template network checklist omits OTLP.
- CODE_OF_CONDUCT `:63` reporting contact is "private message on GitHub"; give a working channel.

### P3

- Pin GitHub Actions to SHAs (Dependabot already covers `github-actions`); add a release workflow that drafts a GitHub Release from a tag; consider CodeQL.
- `files` in package.json omits CHANGELOG.md and ships twelve `.d.ts` files; harmless until npm.
- `skills/session-analytics/SKILL.md` and `agents/openai.yaml` describe three providers.
- `assets/social-preview.png` must be uploaded manually in repository settings.
- CHANGELOG has no compare links despite claiming Keep a Changelog.

### Verified consistent

Commands (`dashboard, report, rates, export, merge, index, mcp`), every README flag, env vars, default ports (4174, demo 4175, `CONDUCTOR_PORT + 4`), data directories and modes, pricing defaults and fixed URLs, six MCP tools, six views, all shortcuts, provider adapters, LICENSE/MIT, CODEOWNERS, zero broken relative links across 27 markdown files, `permissions: contents: read`, `persist-credentials: false`, Node 24 everywhere, no secrets or home paths in history.

---

## 5. Security and privacy (dashboard and server)

Method: gstack `/cso` phases run by a review agent against a sandboxed instance (empty `HOME`, `--offline`, `--no-index`, empty provider roots) plus the Codex release audit. Findings S1–S3 are in section 2 with the dashboard defects so they land in the same pull requests; the rest is here.

### Verified safe

- **Bind, Host and Origin (when present).** Listens on `127.0.0.1` only (`src/server.ts:281`); `evil.example`, `127.1` and `[::1]` Hosts get 403; `Origin: https://evil.example`, `null` and `http://localhost.evil.example` get 403; no `Access-Control-*` headers; COOP/CORP `same-origin`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer` on every response.
- **Static files and API surface.** Exact-match allowlist map; `/../package.json` and `/%2e%2e/package.json` 404; exactly two routes (`/api/health`, `/api/analytics[?refresh=1]`); `refresh` is the only server-side query parameter; repository, window and dates never leave the browser; HEAD/POST 405.
- **Error leakage.** `safeError` returns fixed strings; worker stderr is regex-matched and never forwarded; index errors are an allowlisted table.
- **CSP and XSS.** No `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval` or `new Function` anywhere in `src/public/`; every name, model ID, tool name, warning and metadata string reaches the DOM through `textContent`, `new Option`, `title` or `aria-label`; colours go through CSSOM `style.setProperty`, which `style-src 'self'` allows; the only `href` sinks are rate-card URLs validated to `https:` with no userinfo/search/hash, opened with `rel="noreferrer"`; fonts are same-origin `@font-face`; downloads use `a[download]` blobs.
- **Privacy contract.** Both JSON schemas are `additionalProperties: false`; strings reject control characters and prototype keys; model IDs are bounded by a 160-character grammar that also rejects path roots, `..`, file suffixes, UUIDs and key shapes; repository names exclude slashes; warnings are enum constants; OTLP attributes are an explicit allowlist without repository names; shared snapshots use HMAC pseudonyms; CSV cells starting with `= + - @`, tab, CR or LF are prefixed. Sentinel tests cover the API, all three export formats, sharing and tampered snapshots.
- **Pricing refresh.** Exactly two fixed HTTPS GETs (models.dev, LiteLLM raw on GitHub), only at dashboard start after the first scan and only when a source is older than seven days; `redirect: "error"`, `credentials: "omit"`, `referrerPolicy: "no-referrer"`, 15 s timeout, 32 MiB cap; default TLS verification with no overrides anywhere; `--offline`/`SESSION_ANALYTICS_OFFLINE=1` is checked at three layers, so offline disables every pricing request; the only other outbound call is the explicit `export --otlp-endpoint` POST (https-only except loopback, no redirects, 64 KiB response cap). Cache files are created 0700/0600, written `wx` then hard-linked, read through a filename regex, `lstat`, size cap and SHA-256.
- **CLI and demo.** Fixed flag sets with value checks; `--port` 1024–65535; browser opener is `execFile` with a literal argv; workers are `process.execPath` with fixed script paths; the demo points `HOME` at an empty directory, strips every provider/config env var, forces offline, passes every root explicitly, and aborts on a busy port.
- **Supply chain.** Zero runtime dependencies; lockfile v3 with integrity hashes; `npm ci`; `permissions: contents: read`; `persist-credentials: false`; no `pull_request_target`; no secrets; CODEOWNERS covers workflows; Dependabot weekly for npm and actions; history sweep for key shapes, private-key blocks, `.env`/`.pem`/`.key` and home paths found nothing.

Not run: `npm audit`/OSV (network); exposure is the two dev dependencies in CI.

### What changes for release

S1 (process crash on malformed target), S2 (no-Origin trigger) and S3 (port-reuse trust) go together in PR-B3 with the Origin, malformed-target and different-options tests, separate from the dashboard PRs because the blast radius and the reviewer differ. SECURITY.md (R4) is rewritten to describe what the Origin rule actually blocks and to list `0.7.x`/`0.8.x` as supported.

---

## 6. The plan

The only irreversible act in this release is flipping the repository to public. Everything below is ordered by whether it must precede that flip. Effort is for one person with an agent: S under half a day, M one day, L two days. Pull requests are listed in merge order and sized to stay under about eight source files each (the last four dashboard PRs ran 20–36 files; this is the habit to break). The gstack engineering lens's smallest safe public release is D1, D2, S1, R1–R7, `.gitignore` and tags; everything else is quality, not safety, and is kept because it is cheap.

| Step | Scope | Effort | Gate |
|---|---|---|---|
| **PR-A docs and hygiene** | R3, R4 (with the corrected Origin statement), R5 and every P2/P3 doc item in section 4; `.lane/` in `.gitignore`; issue and PR templates; package description; `/api/health` field list in privacy.md; create `TODOS.md` (it does not exist) with the deferred list below; README states that 0.8.0 is a source install (`git clone` + `npm link`) and that `npm install github:…` fails on Node 24 with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` (so search finds it); rewrite the `[Unreleased]` line that promises an 11 / 12.5 / 14 / 20 px type scale (`CHANGELOG.md:17`) to describe what ships. Conflict-free with every code PR, so it goes first. | M | A fresh reader follows README from clone to dashboard without meeting a contradiction; link checker clean. |
| **PR-B0 harness** | `test/validation/aggregation-ui-harness.ts:38` truncates `app.js` at `const urlParameters =` (`app.js:1504`), so the keydown handler (`:1470–1500`), the wordmark listener (`:1607`), `render()` (`:1540`) and the real `resetExportMenu` (`:1660`) are never loaded, and `shared-view` is not in its module list. Move the cut point below the keydown handler (or export the handler) and add `shared-view` so D1 and D2 can be tested by firing keys. | S | An existing test fires `g v` through the harness and passes. |
| **PR-B1 dashboard correctness** | D1 (separate `sharedSnapshot` variable, hide lists as one constant), D2 (`closeExportMenu()` in `toggleProvider`, download-time staleness check), D4, D5 (extract `ledgerAvailability(sessions)` into `view-model.js` beside `ledgerMoney`, reuse the `kpi({ value: null, reason })` contract), D6 (count `callsEligible` from the `providers.js:66` predicate inside `ledgerMoney` rows; `app.js:648` has the same zero-means-absent bug), D7 (pure `describeLoadError`). | M | Regression tests in the table below pass; the browser and node reproductions in section 2 no longer reproduce. |
| **PR-B2 data** | D11 tools.csv eligibility (`csvTables` and `aggregateSessions`), D12 rolling average from `comparisonData.daily` (already built at `velocity.js:256`; do not add a fourth `buildVelocity`), conditional hatch key. | S | tools.csv excludes the `invalid` fixture; rolling series non-null from day one of a 30-day window. |
| **PR-B3 server** | S1 parse inside `try` with a 400 and an `unhandledRejection` backstop; S2 `Sec-Fetch-Site` and host-with-port check plus server-side single-flight on `refresh=1`; S3 per-launch token and options hash in `/api/health`; tests for `Origin: https://evil.example`, `Origin: null`, `Origin: http://localhost:3000`, a raw-socket absolute-form target, and a second launch with different options. Different blast radius and reviewer from the dashboard PRs, so it stands alone. | M | All new server tests pass; `test/interop-server.test.ts` still passes. |
| **PR-C CI and release gates** | Steps added to the existing `check` job, not a new job (`test/cli.test.ts:21` and `test/integration-release.test.ts:16` already run `--version`/`--help` for every command): `node scripts/snapshot-schema.ts --check` (exists, `:113`), `node scripts/demo.ts report --json \| node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))'`, `npm pack --dry-run`; a version-triple test (`package.json`, `src/version.ts`, top CHANGELOG heading) in `test/integration-release.test.ts`; `os: [ubuntu-latest, macos-latest]` in place of the ternary at `ci.yml:25`; SHA-pinned actions; a 20-line tag-driven workflow (`on: push: tags: ['v*']`, `permissions: contents: write`, `gh release create` from the matching CHANGELOG section); `test/dashboard.browser.test.ts` on `macos-latest` as a non-blocking job first. | S | Workflow green on a scratch tag; the browser job runs and reports. |
| **PR-D layout** | D3 (fleet table fit, CSS-only scroll shadow, sticky first column below 1280 px, scoped `min-width`), D8 chip row, D13 shared KPI breakpoint, D10 stale-directory sweep plus `SIGTERM`-before-`SIGKILL` in the test watchdogs. | M | A CDP assertion in `test/dashboard.browser.test.ts` that `.table-wrap` has `scrollWidth <= clientWidth` at 1280 and 1440 px in both densities; screenshots are evidence, not the gate. |
| **Pre-flip sign-off** | R6: a second, independent history sweep recorded in the PR (`git log -p \| grep -E '/Users/\|ghp_\|sk-'` plus the tracked research evidence under `docs/proposals/evidence`); R7: enable private vulnerability reporting and confirm the SECURITY.md link resolves; confirm `.lane/` and `.gstack/` are ignored and absent from history. | S | Both checkboxes ticked by the maintainer, with the sweep output attached. |
| **Flip visibility to public** | Repository settings. One-way door. | – | Pre-flip sign-off complete; PR-A through PR-D merged. |
| **Release 0.8.0** | R1 version cut with date; R2 tags `v0.7.0` (retro, on `ef6a984`) and `v0.8.0`; flip the badge; upload `assets/social-preview.png`; regenerate `assets/screenshot-*.png` from the demo at the release commit; publish the GitHub Release from the changelog section. | S | `session-analytics --version` prints 0.8.0 from a fresh clone plus `npm link`; the release page shows current screenshots. |
| **PR-E1 formatters (0.8.1)** | Section 3.2 item 15: `src/public/format.js`, the `design-system.test.ts` rule against direct `Intl` use, the legend list layout. Small and mechanical, so it precedes the visual work it unblocks. | S | No `new Intl.` outside `format.js`; ledger totals unchanged (`test/money-reconciliation.test.ts`). |
| **PR-E2 tokens and hygiene (0.8.1)** | Section 3.2 items 1–10 in order (type roles, `.caps`, merged selectors, one focus rule, theme-scoped chart tokens, chips, marks and targets, badges as text, tables and print, reduced-motion cue). | M | Measurable: no `font-size` literal outside `:root`, one global `:focus-visible` rule, no interactive element under 24 px, no non-text colour under 3:1, `test/design-system.test.ts` extended to `border-left-color`, inset box-shadow stripes and literal radii/sizes. |
| **PR-E3 structure and copy (0.8.1)** | Section 3.2 items 11–14 and 16 (kickers and titles, copy cuts, History coverage status line, six KPIs, Velocity defaults). Holds decisions 3, 4 and 5. | M | Equal KPI heights within a row; every `.chart-note` one line; Summary has no `.kicker`. |
| **PR-E4 view finishes (0.8.1)** | Section 3.2 items 17–20 (pricing cards, error and empty copy per 3.3, focused-repository panels per 3.3(b), screenshots). | M | The three edge states in 3.3 render as written; screenshots regenerated. |

### Regression tests per fix

| Fix | File · test name | Setup | Assertion |
|---|---|---|---|
| D1 | `dashboard-interactions.test.ts` · "shared snapshot ignores view, window and provider shortcuts" | harness with `shared-view` loaded; `run("sharedSnapshot = fixture; renderSharedSnapshot(fixture)")` | `switchView('velocity')`, `stepView(1)`, `applyWindowPreset('7')`, `toggleProvider('claude')` and the `1`, `4`, `[`, `g v`, `/` keys do not throw; every `[data-view-panel]` stays hidden; `paletteItems()` has no view or repository group; `.scope-line` and `#help-button` hidden |
| D2 | same file · "a keyboard provider toggle closes the export menu" | `resetExportMenu = installExportMenu(() => fixedSelection)`; open the menu | after `toggleProvider('codex')`: `menu.open === false`, `#export-description` empty; repeat with `currentViewName() === 'velocity'` |
| D4 | `tools-data.test.ts` · "profile footer names the snapshot timezone" | render the Tools trend with `timeZone: "Europe/London"` | footer text contains `Europe/London`, not `UTC` |
| D5 | `velocity-dom.test.ts` · "lead cards show a dash when no session has a ledger" | `renderVelocity(container, [sessionWithoutVelocity], context)` | Usage value card is unavailable with a reason; one ledgered plus one unledgered session shows the partial badge |
| D6 | `pricing-view.test.ts` · "a model without call evidence shows — calls" | Cursor session with `evidence.usageUnit !== "request"` | the Calls cell is `DASH`; a Claude session with `calls: 3` shows `3` |
| D7 | `dashboard-interactions.test.ts` · "refresh failure composes a sentence" | `describeLoadError(new TypeError("Failed to fetch"))` | equals `The local server did not answer (Failed to fetch).` |
| D11 | `interop.test.ts` · "tools.csv applies the Tools eligibility rule" | export with the `invalid` fixture from `tools-data.test.ts:35` | the tool is absent from `tools.csv`; no `NaN` cells |
| D12 | `velocity.test.ts` · "rolling average covers the first six days from prior history" | 30-day window with two months of prior activity | `rolling[0..5]` non-null; key absent when every value is null |
| D13 / D3 / D8 | `design-system.test.ts` (CSS literal rules) and `dashboard.browser.test.ts` | read `styles.css`; CDP at 1280 and 1440 px | no `#pricing-panel .kpi-grid` override below 1001 px; `.table-wrap` `scrollWidth <= clientWidth`; chip row height equals one chip |
| D10 | `cli.test.ts` · "demo sweeps stale temp roots" | pre-create `session-analytics-demo-x` with an old mtime in a temp `TMPDIR` | the directory is gone after `demo.ts report --json` |
| S1 | `server.test.ts` · "a malformed request target gets 400 and the server survives" | raw `net` socket sends `GET http://a:b:c/ HTTP/1.1` | 400 response; a following `/api/health` returns 200 |
| S2 | `server.test.ts` · three Origin cases plus `Sec-Fetch-Site: cross-site` | `requestWithHost` extended to arbitrary headers | 403 for `https://evil.example`, `null`, `http://localhost:3000`, cross-site; 200 for same-origin |
| S3 | `server.test.ts` · "a second launch with different options refuses to reuse the port" | start with `--exclude-hidden`, start again without | second process exits 1 with the fixed message |

Launch-day watch (the five ways week one goes wrong, and what covers each):

1. A secret or home path in history. Covered by the pre-flip sweep; the sweep output is attached to the PR.
2. "Your README says no network, your code fetches prices." Covered by PR-A (R3, R4, `docs/privacy.md:117`).
3. `npm install github:…` fails. Covered by the README FAQ line with the exact error string.
4. "The fleet table is missing columns." Covered by PR-D before the flip.
5. CHANGELOG says 0.8.0 but `--version` says 0.7.0. Covered by the version-triple test in PR-C.

Not in scope for 0.8.0 (goes into `TODOS.md` in PR-A): the visual system (PR-E1–E4, 0.8.1); D9 focused-repository panels (a design choice, no wrong output; shipped in PR-E4); the mobile pass (end of 3.2); the P3 behaviour, accessibility, performance and dead-code items in section 2 (do the live-region and chord-cancel ones if PR-B1 has room); npm publication and the compiled-artifact gate (`docs/proposals/distribution-launch.md`); Homebrew; pilot-user validation; CodeQL; CHANGELOG compare links; `files` in package.json.

Cherry-pick candidates (neutral; each about 30 minutes, low risk):

- A `scripts/docs-check.ts` that reads provider names from `src/mcp/tools.ts:11`, flags from the CLI parsers and the heap limit from `src/analysis-process.ts:8`, and fails CI when README or docs disagree. This is the one change that stops the drift PR-A cleans up from returning by 0.9.0. Effort M.
- A demo shortcut that writes `shared.json` so the D1 reproduction is one command.
- CHANGELOG compare links generated by a short script at release time.
- Empty-state copy for a public user with no agent history ("No sessions found under …; run `npm run demo` to see the dashboard").

### Decisions for the maintainer

1. **Version number.** 0.8.0 (recommended: navigation, accounting and visual changes are more than a patch) or 0.7.1.
2. **Visual pass timing.** PR-E1–E4 after the flip as 0.8.1 (recommended: largest, least testable change and a two-way door) or before the flip as part of 0.8.0.
3. **History coverage placement.** Collapsed status line on Summary (recommended) or moved into the Coverage dialog entirely.
4. **KPI count.** Six (recommended) or keep eight and accept the orphan row.
5. **Velocity default grouping.** Provider (recommended) or keep Agent and cap series.
6. **macOS on pull requests.** Enable now that the repository is going public and minutes are free (recommended) or keep label-gated.
7. **D1 guard strategy.** Separate `sharedSnapshot` variable (recommended: existing guards become correct) or `snapshot?.kind` checks in five functions.
8. **Docs-from-code check.** Adopt the `docs-check.ts` candidate in PR-C (recommended) or keep docs hand-maintained.
9. **Design details** (all recommended, adopted in 3.2 unless overridden): h1 at 18 px rather than 20; unchecked chips as ghost-solid rather than filled; dark area fill `.18` now with the gradient as a follow-up; zero kickers on Summary; daily legend as a two-column list.

---

## 7. Appendix: evidence

- Screenshots covered six views × light/dark at 1440; summary/velocity/tools at 375, 820, 1024, 1280; palette, help, coverage, export, pricing dialog, error state, comfortable density, repository focus, empty window, shared snapshot before/after navigation.
- Shared snapshot reproduction: `node scripts/demo.ts report --json > full.json`, `session-analytics report --share --snapshot full.json > shared.json`, `session-analytics dashboard --snapshot shared.json --port 4182 --no-open`.
- Independent Codex dashboard and release audits used 212k and 148k tokens respectively.
- DOM extraction (fonts, sizes, headings, targets, table widths, KPI heights) was run with the gstack browser `js` command against port 4181.
- Plan reviews: gstack `/plan-ceo-review`, `/plan-eng-review` and `/plan-design-review` lenses were run by three review agents against the first draft of this document; their citation corrections, PR splits, harness prerequisite, regression-test table, token diffs and edge-state copy are incorporated above.
