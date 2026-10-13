# Source releases and public launch

The supported distribution is a source checkout on Node.js 24 or newer. `package.json` remains `private: true`, and the executable is TypeScript. A GitHub Release does not make npm, GitHub package installs, tarball installs under `node_modules`, Homebrew or a standalone executable supported. See [CLI installation](cli.md#install).

## Validate a candidate

From a clean checkout of the candidate commit:

```bash
npm ci
npm run release:check
npm run demo
```

`release:check` checks version agreement, types, tests, public snapshot schemas, a synthetic JSON report containing all six providers, private-fixture sentinel absence and the package allowlist with required assets/notices. It does not tag, publish, change repository settings or read real history for its demo checks. A successful `npm pack --dry-run` verifies the file list only; it does not prove an installed npm artifact works.

For browser validation, start `npm run demo -- --no-open` and exercise all six views, repository focus, provider filters, window selection, keyboard navigation, dialogs and exports in both themes. Check a narrow viewport and a laptop viewport, including empty windows and shared snapshots. Use synthetic data for every screenshot and reproduction. [Branding](branding.md#regenerating-images) documents the screenshot assets.

Run `npm run test:browser` for the required automated Chrome suites. On Linux, set `SESSION_ANALYTICS_CHROME` to the Chrome/Chromium executable; macOS defaults to the Google Chrome application path. This command isolates temporary fixtures and fails if Chrome is missing or cannot launch. The general source suite also runs these browser suites when Chrome is installed, including on hosted macOS; it may skip them only when Chrome is unavailable. The dedicated Ubuntu browser job remains mandatory regardless of whether the source suite ran Chrome.

The release version must agree in `package.json`, `src/version.ts` and the latest release section in `CHANGELOG.md`. The release policy chooses the section's date; the metadata check does not validate that date. A pushed tag must be exactly `vX.Y.Z` for that version. Move user-facing entries out of `Unreleased` when cutting the release; preserve existing release history.

## CI and publication

Pull requests, pushes to `master` and manual CI runs require GitHub-hosted Ubuntu and macOS checks and a hosted Ubuntu browser check, regardless of repository visibility. No workflow selects `agentbox` or treats a platform as advisory. CI validates types, tests, schemas, synthetic output and package contents; browser runs fail when Chrome is unavailable. Private-repository hosted capacity must be available while preparing the candidate; a billing or capacity failure is not a passing check.

The tag workflow validates the candidate with read-only repository permission. Every tag requires the source preflight on GitHub-hosted Ubuntu and macOS plus a required Ubuntu Chrome check. Only after both platform validation and the browser job succeed does the publishing job receive `contents: write` and create the GitHub Release from the matching changelog section. Publication itself uses hosted Ubuntu. A tag push is a publication action, so do not use scratch tags merely to test workflow parsing.

An active [tag ruleset](https://github.com/rokas-tarasevicius/session-analytics/rules/24996643), configured and read back on 2026-10-13, blocks updates and deletion of `refs/tags/v*` with no bypass actors. This keeps an existing release tag from moving between validation and publication.

## Public launch gates

The readiness branch prepares code and documentation. These repository/account actions require a maintainer before public announcement:

1. **Confirm self-hosted runners are unavailable to untrusted workflows before changing visibility.** Routing current jobs to hosted Ubuntu is insufficient: an outside contributor can propose a workflow selecting an available `agentbox` runner. The repository runners API listed zero available runners on 2026-10-13; the existence of `agentbox` elsewhere does not grant this repository access. Recheck repository access and any inherited runner policy at the visibility change. [GitHub Actions security guidance](https://docs.github.com/en/actions/reference/security/secure-use).
2. **Review history and tracked assets.** The [2026-10-13 history review](proposals/evidence/public-history-review-2026-10-13.md) records the reachable text, image and font inventory and its limits. Recheck any added refs or assets before visibility changes. Removing a file from the latest commit does not remove it from history.
3. **Require passing checks.** Branch protection was configured and read back on 2026-10-13 for `master`: `check (ubuntu-latest)`, `check (macos-latest)` and `browser (ubuntu-latest)`, with up-to-date branches, pull requests and resolved conversations required. The rule applies to administrators; force pushes and deletion are disabled. Verify these exact checks pass on the final candidate before merging.
4. **Make visibility public only after the preceding gates.** Retain `private: true` in the npm manifest until a compiled installed-artifact release has its own verification. Update the README preview badge and access note once visibility actually changes.
5. **Enable and verify private vulnerability reporting.** GitHub's feature is available for public repositories. The settings API returned `404` while this repository was private, so availability remains unverified. After the visibility change, enable reporting and check that an ordinary signed-in user can open the route in [SECURITY.md](../SECURITY.md). [GitHub configuration instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
6. **Maintain private reporting contacts.** [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) and [SECURITY.md](../SECURITY.md) name the maintainer's existing public email address and recipient. Ownership and publication were verified against the maintainer's public website source; no test email was sent. The maintainer must monitor the mailbox.
7. **Finish public presentation and verification.** Upload `assets/social-preview.png` in repository settings. Confirm hosted Linux, macOS and browser checks execute successfully, then test the documented HTTPS clone and source launch from a fresh public checkout. Publish a GitHub Release and announcement only after these checks; use the checked candidate's synthetic screenshots.

## After release

Recheck the public clone instructions, download/release links and private reporting routes. For an accounting regression, record which totals move and why in the next changelog entry. For a privacy or security issue, follow [SECURITY.md](../SECURITY.md) and withdraw affected release guidance while triaging.

New provider formats, compiled npm packaging, Homebrew, Windows support and consenting user research remain separate work in [TODOS.md](../TODOS.md) and the [roadmap](roadmap.md). The [2026-10-13 readiness plan](proposals/open-source-readiness-2026-10-13.md) records this candidate's decisions and verification limits.
