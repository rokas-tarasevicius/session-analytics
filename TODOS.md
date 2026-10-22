# Deferred work

Open work after the [2026-10-13 readiness plan](docs/proposals/open-source-readiness-2026-10-13.md). Priority uses P0–P4; P3 denotes backlog. The [2026-10-12 review](docs/proposals/release-readiness-2026-10-12.md) is historical: its PR-E1–E4 visual passes shipped in 0.8.0. External public-launch gates are tracked in [docs/release.md](docs/release.md#public-launch-gates), rather than presented as completed code work.

## Dashboard structure and visual system

| Priority | Item | Plan reference |
| --- | --- | --- |
| P3 | Finish the mobile fleet table card layout. | §3.2 deferred mobile pass; §6 |

## Dashboard behavior and copy

| Priority | Item | Plan reference |
| --- | --- | --- |
| P3 | Remove the Conductor source prefix from opaque repository IDs in URLs. | §2 P3, Behavior and copy |
| P3 | Scope unknown-start exclusions to the selected window or omit the count for short windows. | §2 P3, Behavior and copy |
| P3 | Clarify that last-N-day presets end on the last observed day, or anchor them to today. | §2 P3, Behavior and copy |
| P3 | Use “new” consistently for movers with a zero prior baseline. Fixed by /qa on `t3/test-dashboard-logic`, 2026-10-20. | §2 P3, Behavior and copy |
| P3 | Clear stale repository focus from the URL when a refresh removes that repository. Fixed by /qa on `t3/test-dashboard-logic`, 2026-10-20. | §2 P3, Behavior and copy |
| P3 | Align Summary exports with visible KPI/table scope or explicitly name the daily-chart chip scope. | §2 P3, Behavior and copy |
| P3 | Preserve history coverage consistently in full-provider Summary and Costs JSON exports. | §2 P3, Behavior and copy |
| P3 | Unify dialog and export coverage-warning implementations. | §2 P3, Behavior and copy |
| P3 | Guard Velocity indicators against timezone-free hand-edited snapshot timestamps. Fixed by /qa on `t3/test-dashboard-logic`, 2026-10-20. | §2 P3, Behavior and copy |
| P3 | Validate the scheme of Pricing freshness links like model-card links. Fixed by /qa on `t3/test-dashboard-logic`, 2026-10-20. | §2 P3, Behavior and copy |

## Accessibility

| Priority | Item | Plan reference |
| --- | --- | --- |
| P3 | Announce refresh and empty-window status through live regions. | §2 P3, Accessibility; §6 optional PR-B1 work |
| P3 | Restore keyboard focus after export disables the activated download button. | §2 P3, Accessibility |
| P3 | Avoid repeated Velocity live-region announcements during pointer movement and resize. | §2 P3, Accessibility |

## Rendering performance and dead code

| Priority | Item | Plan reference |
| --- | --- | --- |
| P3 | Remove unused per-repository tools/warnings, avoid full model rebuilds on chip toggles and reduce repository-by-session activity scans. | §2 P3, Performance and dead code |
| P3 | Consolidate element factories and duplicate warning renders; remove unused Summary Velocity code and review test-only exports. | §2 P3, Performance and dead code |

## Multiple machines

| Priority | Item | Plan reference |
| --- | --- | --- |
| P3 | Persist portable repository IDs and session keys with retained index facts, so history whose sources were deleted keeps its portable identity across exports. | #62 review |
| P3 | Compare pricing freshness across machines: each machine prices its own sessions with its own cache, and a remote's stale or older rate card is not flagged. | Machines review (no-cross-machine-consistency) |
| P3 | Stop the remote work of `--runtime installed` and `--remote` reads when the connection closes, as the bundled runtime does; needs a report flag that older versions reject. | Machines review |
| P3 | Compare ad-hoc `--remote` machines, and installed ones without a recorded check, for the same machine twice; needs `--identify-machine` there, which older versions reject. Return compact JSON from installed runtimes for the same reason. | Machines review (same-machine-twice, uncompressed-pretty-json) |
| P3 | Add a Machines column (or filter chips) to the repository table. | Machines review (no-machine-dimension) |
| P3 | Stop every saved Linux server from adding "Cursor local session history is missing." and an incomplete Cursor source: the default Cursor database is the macOS path on every platform. Use each platform's default (`~/.config/Cursor` on Linux, `%APPDATA%\Cursor` on Windows), and count an absent default store as not installed rather than missing for every provider's default roots alike, the Codex archive root included, so source health stays consistent. | Machines end-to-end review (cursor-missing-on-every-server) |

## Subscription limits

| Priority | Item | Plan reference |
| --- | --- | --- |
| P2 | Store Codex `plan_type` with each ledger reading, calibrate value per 1% per plan and prorate price per plan period; today every cycle uses the account's latest plan, so value per 1% spans plan changes. A plan type that changes within one stream could also set apart readings from a conflicting limit context, such as a cycle that looks like an early reset. | Subscription review (codex-conflicting-cycles) |
| P3 | Accept a UTF-8 BOM when attributing Codex limit readings to accounts: `src/limits/accounts.ts` and the private limits inbox parse rollout metadata directly, so a BOM-prefixed rollout caches missing attribution even though the provider-history readers accept a BOM since #99. | #99 review (multi-machine) |

## Distribution and release metadata

| Priority | Item | Plan reference |
| --- | --- | --- |
| P3 | Decide whether the package should ship declaration files; it ships none today. The release check already installs and runs the compiled artifact and requires CHANGELOG and license assets. | §4 P3; §6, Not in scope for 0.8.0 |
| P3 | Upload the social preview through repository settings at release time. | §4 P3; §6 Release 0.8.0, maintainer step |
| P3 | Make `release:check` compare the CHANGELOG's versions with `git tag` (fetching tags in the check job), with a documented exception list: 0.8.1 was prepared at `67b0281` but never tagged. | Release review (changelog versions without a tag) |

## Security tooling and product validation

| Priority | Item | Plan reference |
| --- | --- | --- |
| P3 | Evaluate CodeQL for the repository. | §4 P3; §6, Not in scope for 0.8.0 |
| P3 | Validate the product with consenting pilot users and synthetic tasks. | §6, Not in scope for 0.8.0 |

## Completed

- **Completed: 2026-10-15 (unreleased).** Subscription limits from saved machines: `limits --json --no-remote` on each machine through the same bootstrap, merged by account key, cached last good limits, folded into this machine's ledger, and a Subscription value join that counts every machine whose limits were read: `src/limits/machines.ts`.
- **Completed: 2026-10-14 (unreleased).** Machines as a dimension: saved machines with a bundled runtime and `machines check`, per-machine status in combined snapshots, the report and the dashboard (Machines strip and filter, Machine details, Usage value by machine), last good snapshots and progressive loading: `src/machines/`, `src/remote.ts`, `src/remote/` and `src/public/machines.js`.
- **Completed: 2026-10-14 (unreleased).** The tag workflow publishes the compiled package that `release:check` installs: a GitHub Release tarball with an unversioned alias and `SHA256SUMS`, attested for build provenance, after an installed smoke on Linux and macOS under Node.js 24.0.0, the newest 24.x and 26. It can send the same bytes to npm through trusted publishing and to a Homebrew tap formula, which it installs and tests with Homebrew first; each waits for a repository variable and its one-time setup. CHANGELOG compare links are added and required by `release:check`.
- **Completed: 2026-10-13 (readiness candidate).** Mobile time-window selector, single-column KPIs below 400 px, and wrapped snapshot metadata: six views checked at 375, 768 and 1440 px through the collaborative preview; 375 px also checked in both themes and densities. Custom ranges focus the start date, and failed refreshes preserve the snapshot without widening the page. Synthetic mobile captures and their provenance are in `assets/SCREENSHOTS.md`.
- **Completed: 2026-10-13 (0.8.0).** Formatter, shared type/focus/chart tokens, Summary hierarchy and view finishes (PR-E1–E4): `a383526`, `37a3e3d`, `cd65a99`, `20eadba`.
- **Completed: 2026-10-13 (0.8.0).** Focused-repository provider breakdowns and fleet comparator: `20eadba` and current `src/public/app.js`.
- **Completed: 2026-10-13 (0.8.0).** “Clamped to history” range copy, quiet repository disclosure, Escape chord cancellation and the command-palette shortcut in Pricing: current `src/public/app.js`/`src/public/pricing.js` and the 0.8.0 dashboard work.
- **Completed: 2026-10-13 (readiness candidate).** Agent launch metadata now names all six providers; public onboarding uses HTTPS, and a source-release runbook records validation and external gates.
