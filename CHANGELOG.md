# Changelog

All notable changes to this package are documented here.

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
