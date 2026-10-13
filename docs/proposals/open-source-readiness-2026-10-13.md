# Open-source readiness plan (2026-10-13)

Baseline: `origin/master` at `008c121`, release 0.8.0. Working branch: `release/open-source-readiness`. This plan supersedes the pending-work claims in the [2026-10-12 review](release-readiness-2026-10-12.md), which remains a historical audit. Current source installation, six providers, six views, metrics-only MCP and exports are shipped; npm publication is not.

The user authorized fixes and small improvements without intermediate questions and requested parallel GPT-6.1 Sol reviewers. The follow-up authorized landing this branch and configuring hosted CI, branch protection and reporting contacts. The candidate is version 0.8.1 with a dated changelog; no tag or release has been published. Visibility and publication remain separate launch gates.

**CI policy correction (2026-10-13).** The current candidate requires GitHub-hosted Ubuntu and macOS source validation plus a required Ubuntu Chrome check for CI and tag releases, regardless of repository visibility. This replaces the initial private-preview policy that allowed advisory checks or a self-hosted release fallback. Earlier repository observations and local verification results below remain dated audit evidence; hosted results must still be verified on the final candidate.

## What already shipped

| Earlier finding | Current evidence | Disposition |
| --- | --- | --- |
| Shared snapshot shortcuts, export staleness and missing-value displays | `6cf77e1`, dashboard interaction and accounting suites | Completed before this candidate |
| Malformed requests, cross-site API triggers and compatible port reuse | `2b6d9eb`, server and interop tests | Completed before this candidate; runtime boundaries re-reviewed |
| Tools export eligibility and rolling-average history | `357387d`, export and Velocity tests | Completed before this candidate |
| Laptop table fit, chip rows, KPI breakpoints and demo cleanup | `9f8cccd` | Completed before this candidate; small-screen usability reviewed separately |
| Formatters, shared type/focus/chart tokens, Summary hierarchy and focused-repository panels | `a383526`, `37a3e3d`, `cd65a99`, `20eadba` | PR-E1–E4 already delivered in 0.8.0; do not schedule them again |
| Product tour and synthetic light/dark screenshots | `11fda59`, `008c121`, `assets/screenshot-*.webp` | Reuse the existing assets; refresh when changed behavior warrants it |

## Accepted improvements and owners

| Workstream | Concrete outcome | Verification | Owner |
| --- | --- | --- | --- |
| Contribution CI | PRs, pushes to `master` and manual CI runs require hosted Ubuntu, macOS and Chrome checks in both private and public repositories | Review workflow conditions and actual hosted results before announcement | Release integration |
| Source release preflight | One local `npm run release:check`; tag/package/source/latest changelog agreement; every tag requires hosted Ubuntu/macOS validation plus required Chrome before the publishing job gains write permission | Full suite plus positive/negative metadata regressions, synthetic report validation and hosted platform/browser results | Release integration |
| Reproducible test environment | Node tests use an isolated temp root outside ancestor Git trees; repository oracles use explicit no-filesystem evidence instead of nonexistent hardcoded paths | Targeted discovery/oracle regressions, then the same full suite | Release integration and security/runtime reviewer |
| Runtime privacy/security | Review parser/index/server/export trust boundaries and repair confirmed defects without adding telemetry or broadening public fields | Targeted regressions, full suite and public-schema parity | Security/runtime reviewer |
| Design and browser QA | Exercise the synthetic demo in both themes and laptop/narrow viewports; improve evidenced navigation, keyboard, mobile and edge-state issues | DOM regressions plus a real browser; capture any unavailable browser coverage explicitly | Design/QA reviewer |
| Public onboarding and docs | HTTPS source clone, reproducible `npm ci`, direct source fallback, six-provider skill metadata, release runbook, truthful reporting routes and current backlog | Relative-link/asset checks and consistency against source/workflows | Docs reviewer |

No runtime dependency, new service, schema revision or content feature is needed for this release. Existing provider adapters, the synthetic demo, Node's test runner and current schema generator are reused.

## Review record

Review order follows the gstack autoplan lenses: product scope, design, developer experience, engineering. The installed `/autoplan` and `/document-release` instructions and relevant review methodologies were read. This is a coordinated in-host review, not a claim that the formal dual-voice autoplan pipeline or an outside Claude reviewer completed. `gstack-skill-start` reported `GUARD_NOT_INSTALLED`; publication-order enforcement is unverified. No outside review result is claimed.

**Product scope.** The release problem is public source-install readiness and trustworthy contributions, rather than missing product breadth. Repeating the already-delivered dashboard roadmap would delay the launch without changing the outcome. Keep small repairs in this branch and defer compiled packaging, new metrics and new provider formats to their own acceptance gates.

**Design.** Retained the shipped Geist/Geist Mono system, provider palette, six-view navigation and synthetic screenshot tour. Added a narrow-screen time-window selector, single-column KPIs below 400 px, and wrapping for stale-snapshot metadata. The six views were checked through the collaborative browser at 375, 768 and 1440 px, with both themes and densities checked at 375 px. The failed-refresh overflow was reproduced at 406 px on a 375 px viewport and verified at 375 px after repair. New light/dark mobile screenshots and their provenance are included; the existing desktop tour remains unchanged.

**Developer experience.** A contributor should clone over HTTPS, run `npm ci`, inspect the demo and run `npm run check`; a user can launch the source directly if linking is inconvenient. The README now explains private-preview access, the unsupported npm install path, network/offline boundaries and where the detailed references live. No fresh anonymous public-clone measurement is possible while the repository remains private, and no installation-time benchmark is claimed.

**Engineering.** Keep validation in existing scripts and workflows, isolate publication permissions, and gate release metadata before any write. A hosted workflow cannot secure an attached self-hosted runner against a proposed workflow, so external runner removal/restriction is mandatory. Local tests cannot prove GitHub account capacity, runner policy, branch rules, vulnerability-reporting availability or the behavior of the actual hosted jobs.

## Flow and failure handling

```text
private candidate -> local source preflight -> reviews and browser evidence
                                            -> runner/history/branch-rule gates
                                            -> public visibility
                                            -> reporting + hosted CI verification
                                            -> checked version/tag -> GitHub Release

missing/mismatched version or invalid schema -> fail validation; no release write
missing Chrome on a required browser check  -> fail check; no silent skip
blocked hosted jobs or unverified reporting -> keep announcement gate open
unsupported node_modules TypeScript install -> use checkout + direct Node/npm link
```

Publication rollback can withdraw a GitHub Release or fix documentation, but public Git history cannot reliably be made private again. That asymmetry is why runner policy and history review precede visibility changes.

## Completion and release gates

Status: **DONE_WITH_CONCERNS** for local preparation. Public launch remains gated by the repository/account actions below.

| Verification | Result and limits |
| --- | --- |
| `npm ci` | Locked development tooling installed; npm reported zero known dependency vulnerabilities. No runtime dependencies were added. |
| `npm run release:check` on Linux, Node 24.21.0 | Passed: type check; 873 tests discovered, 871 passed, zero failed, two optional Chrome tests skipped by default; schema consistency; a validated synthetic report with 461 sessions from all six providers; required assets/notices and the 147-file package allowlist. |
| Required Chrome suites on the final browser test file | `SESSION_ANALYTICS_CHROME=/usr/bin/google-chrome npm run test:browser`: both suites passed in 80 seconds, zero failures and zero skips. Layout and interaction coverage includes six views, both themes/densities, responsive widths, navigation, dialogs, filters, custom dates and refresh recovery. A separate missing-browser run failed as required, with no skips. |
| Release integration regressions | Seven passed. Public runner conditions, tag/version mismatch rejection, release notes, package exclusions, all six view renderers and publication dependencies are exercised. |
| Independent release review | Found and fixed a tag workflow that could bypass macOS/browser checks. Every tag publication now depends on both hosted platform validations and required Chrome success; failure, cancellation and skipped jobs block publication, regardless of repository visibility. |
| Runtime security and text history | Assessed server/origin/reuse, import/export/sharing, index and MCP boundaries with no supported runtime finding. A separate credential-pattern scan reviewed 2,074 reachable text blobs; flagged candidates were synthetic security fixtures. Binary history (259 blobs), exhaustive provider branches and a full external security audit remain outside this evidence. |
| Design | Six-view responsive checks and synthetic desktop/mobile light/dark captures completed. Native selector state, URL/preset synchronization, custom-date focus, dialog Escape and error-state overflow were checked; OS-native popup interaction was not independently automated through the collaborative browser. |
| Documentation | All 255 checked relative links and image targets across 29 selected Markdown files resolve; whitespace checks pass. External routes and every fragment anchor were not certified by the local link check. |

The first full run failed because an unrelated empty `/tmp/.git` gave fixtures the wrong repository ancestry. The test launcher now selects private temporary storage outside Git ancestors. Fixed-path oracle fixtures explicitly state absent filesystem evidence; real temporary-directory tests exercise symlink and canonical spellings. A permissions fixture now establishes its initial mode explicitly so the test also works under `umask 077`. Production repository attribution and the shared host directory were not changed.

Making Chrome mandatory also exposed stale browser fixtures and assertions that optional skips had hidden. Updated them to cover the shipped compact one/two-day chart legends, consistent repository names, current error copy and provider evidence. Costs notes may occupy two unclipped lines only at 1280 px in comfortable density; other desktop note checks retain their one-line bound. The final combined browser run passed after these updates. Synthetic preview services were temporary; committed screenshot assets remain reproducible using their recorded recipe.

The gstack health result is **10/10 with partial coverage (2/6 categories)**: types and tests passed. Lint and dead-code tools are not configured, ShellCheck is unavailable, and gbrain is not configured; these are excluded rather than scored as passing. This is the first comparable health record, so no trend is claimed.

Before announcement, complete every gate in [docs/release.md](../release.md#public-launch-gates): self-hosted runner removal/restriction, history and asset review, branch rules, visibility change, verified private vulnerability and conduct-reporting routes, social preview upload, hosted Linux/macOS/browser execution and a fresh public source install.

Initial read-only repository observations on 2026-10-13: visibility `PRIVATE`, MIT license recognized by GitHub, default branch `master`; private-reporting settings returned `404`; the branch-protection endpoint returned “Branch not protected”; repository rulesets returned an empty list. The reporting API response does not prove reporting is disabled. Actions were enabled with all actions allowed.

## Follow-up release preparation (2026-10-13)

- Prepared version 0.8.1 consistently in the source, package manifest, lockfile, README and dated changelog. The original design is retained; the Fluxary styling branch is excluded.
- Re-ran `npm run release:check` at 0.8.1: 873 tests discovered, 871 passed, two optional browser skips, no failures; schemas, the six-provider synthetic report and 147-file package allowlist passed. The separate required Chrome command passed both suites with zero skips in 111 seconds.
- Configured and read back `master` protection: required hosted Ubuntu, macOS and browser checks, up-to-date branches, pull requests and resolved conversations, including administrators. Force pushes and deletion are disabled. Hosted execution and the protected merge remain outstanding until the PR completes.
- Configured and read back active [tag ruleset 24996643](https://github.com/rokas-tarasevicius/session-analytics/rules/24996643): updates and deletion of `refs/tags/v*` are blocked with no bypass actors, so an existing release tag cannot move between validation and publication.
- Published the maintainer's existing public email as the private conduct-reporting contact and security fallback. Ownership/publication was verified in the maintainer's [public website source](https://github.com/rokas-tarasevicius/personal-website/blob/0be0898b1137e674d1447e0d48566fcce6dcdc53/WEBSITE_CONTENT.md#L22). No email was sent and mailbox delivery/monitoring was not tested.
- Extended the history/privacy review to every fetched remote branch and tag plus local candidate refs. The [history and binary-asset evidence](evidence/public-history-review-2026-10-13.md) records the inventory, image/font review, findings and exclusions, superseding the binary-review gap above.
- The repository runners API returned zero available runners. `agentbox` exists elsewhere; current workflows use GitHub-hosted runners exclusively. Recheck inherited runner access before changing visibility.
- `assets/social-preview.png` is ready. GitHub reports no custom social preview yet. Upload is pending because the connected API exposes no setter and the collaborative GitHub browser is signed out.

The README's private-preview badge and access note remain accurate until visibility changes. GitHub's private vulnerability-reporting route and an anonymous public clone cannot be verified while the repository is private.

## Deferred

- Compiled npm artifacts, package-file/declaration review and installed-artifact tests; keep the manifest private until these pass.
- Homebrew, standalone executables and Windows support, each with its own install/update checks.
- Additional provider formats, profile dimensions and task-matched comparisons; see [roadmap](../roadmap.md).
- Fleet table card layout, remaining lower-priority UI/performance cleanup and consenting pilot-user research; see [TODOS.md](../../TODOS.md).
- Brand-mark provenance precision and terms review before making any broader redistribution claim; bundled MIT/OFL notices do not license third-party trademarks.

This plan is the current handoff for the readiness candidate. Once released, the runbook and backlog remain authoritative; do not reuse this dated plan as a promise of unimplemented features.
