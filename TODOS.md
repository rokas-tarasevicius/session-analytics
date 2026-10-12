# Deferred work

Open work from the [release-readiness plan](docs/proposals/release-readiness-2026-10-12.md). Priority uses P0–P4; P3 denotes backlog. These items are outside the PR-A implementation and the 0.8.0 release scope unless a release step is explicitly noted.

## Dashboard structure and visual system

| Priority | Item | Plan reference |
| --- | --- | --- |
| P3 | Deliver the formatter, token/hygiene, structure/copy and view-finish passes in PR-E1–E4 for 0.8.1. | §6, Not in scope for 0.8.0; §3.2 |
| P2 | D9: replace focused-repository one-bar panels with useful provider breakdowns and a fleet comparator in PR-E4. | §2 P2 D9; §3.3(b); §6 |
| P3 | Add the mobile window selector, card-list fleet table and one-column KPIs below 400 px. | §3.2 deferred mobile pass; §6 |

## Dashboard behavior and copy

| Priority | Item | Plan reference |
| --- | --- | --- |
| P3 | Remove the Conductor source prefix from opaque repository IDs in URLs. | §2 P3, Behavior and copy |
| P3 | Rename the clamped-range label to “Clamped to history”. | §2 P3, Behavior and copy |
| P3 | Scope unknown-start exclusions to the selected window or omit the count for short windows. | §2 P3, Behavior and copy |
| P3 | Collapse repositories without activity in single-day windows into one disclosure. | §2 P3, Behavior and copy |
| P3 | Clarify that last-N-day presets end on the last observed day, or anchor them to today. | §2 P3, Behavior and copy |
| P3 | Use “new” consistently for movers with a zero prior baseline. | §2 P3, Behavior and copy |
| P3 | Give the burn KPI a reason matching the failed date/activity/baseline guard. | §2 P3, Behavior and copy |
| P3 | Cancel armed `g` chords on Escape and allow the promised command palette shortcut inside Pricing. | §2 P3, Behavior and copy |
| P3 | Clear stale repository focus from the URL when a refresh removes that repository. | §2 P3, Behavior and copy |
| P3 | Align Summary exports with visible KPI/table scope or explicitly name the daily-chart chip scope. | §2 P3, Behavior and copy |
| P3 | Preserve history coverage consistently in full-provider Summary and Costs JSON exports. | §2 P3, Behavior and copy |
| P3 | Unify dialog and export coverage-warning implementations. | §2 P3, Behavior and copy |
| P3 | Guard Velocity indicators against timezone-free hand-edited snapshot timestamps. | §2 P3, Behavior and copy |
| P3 | Validate the scheme of Pricing freshness links like model-card links. | §2 P3, Behavior and copy |

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

## Distribution and release metadata

| Priority | Item | Plan reference |
| --- | --- | --- |
| P3 | Pass the compiled installed-artifact gate before npm publication. | §6, Not in scope for 0.8.0; distribution-launch proposal |
| P3 | Evaluate Homebrew distribution separately. | §6, Not in scope for 0.8.0 |
| P3 | Include CHANGELOG and review shipped declaration files in the package file list before npm publication. | §4 P3; §6, Not in scope for 0.8.0 |
| P3 | Add release compare links to CHANGELOG. | §4 P3; §6, Not in scope for 0.8.0 |
| P3 | Reconcile the provider wording in `agents/openai.yaml` in separately authorized metadata work. | §4 P3; excluded from PR-A |
| P3 | Upload the social preview through repository settings at release time. | §4 P3; §6 Release 0.8.0, maintainer step |

## Security tooling and product validation

| Priority | Item | Plan reference |
| --- | --- | --- |
| P3 | Evaluate CodeQL for the repository. | §4 P3; §6, Not in scope for 0.8.0 |
| P3 | Validate the product with consenting pilot users and synthetic tasks. | §6, Not in scope for 0.8.0 |

## Completed

No deferred items have been completed in this pull request.
