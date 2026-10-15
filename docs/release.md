# Releases and distribution

Every release is one compiled package, `session-analytics-X.Y.Z.tgz`, built from the tagged commit by `scripts/build.ts` and packed from `dist/`. The GitHub Release receives those bytes after the tag workflow has installed and run them, and npm and the Homebrew tap receive the same bytes once their [one-time setup](#one-time-maintainer-steps) is done. The root `package.json` stays `private: true` with the TypeScript bin, so a contributor's `npm link` keeps running the live source and the source layout cannot be published by accident; only the generated `dist/package.json` describes the installable package. Users install as described in [installation](cli.md#install).

## Validate a candidate

From a clean checkout of the candidate commit:

```bash
npm ci
npm run release:check
npm run demo
```

`release:check` checks version agreement, types, tests, public snapshot schemas, a synthetic JSON report containing all six providers and private-fixture sentinel absence. It then builds the compiled package into `dist/` (`npm run build`), packs it, and checks the tarball: every entry point and worker, every file the dashboard serves, the font license, brand notice, rate card, schemas and skill, and no TypeScript, declaration, source map, dotfile or local data. The generated manifest must match the source version, name a `.js` bin with a `node` shebang, require Node.js 24 on macOS and Linux, and declare no scripts or dependencies. Finally `scripts/smoke-installed.ts` installs the tarball with `npm install --global --ignore-scripts --offline` into a temporary prefix whose path contains a space and runs it from there: help and version for every command, the synthetic report (compared with the source run, including Cursor sessions from their separate worker, and failing on any warning that a synthetic source could not be read), an MCP tool call, the dashboard with every static file and API route reporting the expected version, a clean stop on `SIGTERM`, and the report again from a read-only installation. It prints the tarball's SHA-256 and npm integrity. `npm run release:check -- --port PORT` fixes the smoke's dashboard port; otherwise it takes a free one. `node scripts/smoke-installed.ts session-analytics@X.Y.Z` runs the same smoke against a registry install and hashes the tarball npm downloaded. `release:check` does not tag, publish, change repository settings or read real history.

`npm run pack:release` writes the same tarball to `release/`. The index fingerprints the code that runs, so the first scan after an upgrade parses present sessions again, and so does every switch between a checkout and an installed copy that share a data directory; give a checkout its own (see [from source](cli.md#from-source)).

For browser validation, start `npm run demo -- --no-open` and exercise all seven views, repository focus, provider filters, window selection, keyboard navigation, dialogs and exports in both themes. Check a narrow viewport and a laptop viewport, including empty windows and shared snapshots. Use synthetic data for every screenshot and reproduction. [Branding](branding.md#regenerating-images) documents the screenshot assets.

Run `npm run test:browser` for the required automated Chrome suites. On Linux, set `SESSION_ANALYTICS_CHROME` to the Chrome/Chromium executable; macOS defaults to the Google Chrome application path. This command isolates temporary fixtures and fails if Chrome is missing or cannot launch. The general source suite also runs these browser suites when Chrome is installed, including on hosted macOS; it may skip them only when Chrome is unavailable. The dedicated Ubuntu browser job remains mandatory regardless of whether the source suite ran Chrome.

The release version must agree in `package.json`, `package-lock.json`, `src/version.ts` and the latest release section in `CHANGELOG.md`. The release policy chooses the section's date; the metadata check does not validate that date. A pushed tag must be exactly `vX.Y.Z` for that version; prerelease versions are refused. The changelog must also end with compare links for the release: `[Unreleased]: https://github.com/rokas-tarasevicius/session-analytics/compare/vX.Y.Z...HEAD` and an `[X.Y.Z]:` link ending at `vX.Y.Z`.

## Cut a release

1. On a branch, move user-facing entries out of `Unreleased` into `## [X.Y.Z] - YYYY-MM-DD`, preserving existing release history. Set the version with `npm version X.Y.Z --no-git-tag-version` and in `src/version.ts`. Point `[Unreleased]` at `compare/vX.Y.Z...HEAD` and add `[X.Y.Z]: https://github.com/rokas-tarasevicius/session-analytics/compare/vPREVIOUS...vX.Y.Z`. On a new minor version, update the supported versions in [SECURITY.md](../SECURITY.md).
2. Run `npm run release:check`, open a pull request and merge it through the required checks.
3. Tag the merge commit on `master` and push the tag: `git tag vX.Y.Z <commit> && git push origin vX.Y.Z`. A tag push is a publication action, so do not use scratch tags merely to test workflow parsing.

## The tag workflow

`.github/workflows/release.yml` runs on `v*` tags with read-only repository permission by default, one run per tag and no cancellation. Every action is pinned to a full commit SHA.

| Job | Runs on | What it does |
| --- | --- | --- |
| `validate` | Ubuntu, macOS | Checks the tag and release notes, then `npm run release:check`, including the installed smoke of a locally built tarball. |
| `browser` | Ubuntu | Required Chrome suites; a missing Chrome fails. |
| `package` | Ubuntu | `npm ci`, the notes check and `npm run pack:release`; copies the tarball to the unversioned alias `session-analytics.tgz`, writes `SHA256SUMS` for both, and uploads them with the release notes as a workflow artifact kept for 7 days. |
| `smoke` | Ubuntu, macOS × Node.js 24.0.0, 24, 26 | Downloads the artifact, verifies `SHA256SUMS`, and runs `scripts/smoke-installed.ts` on that exact tarball. Node.js 24.0.0 is the oldest version `engines` allows, 24 the newest 24.x, and 26 Homebrew's `node`. The checkout supplies only the smoke script and demo fixtures. |
| `release` | Ubuntu | Publishes the GitHub Release. Runs only when `validate`, `browser`, `package` and every `smoke` leg succeeded and the run was not cancelled. |
| `npm` | Ubuntu | Publishes the same tarball to npm when the repository variable `NPM_PUBLISH` is `true`. |
| `homebrew` | macOS | When the repository variable `HOMEBREW_TAP` is `true`, installs, tests and audits the rendered formula with Homebrew, then updates the tap. |

Every job that downloads the artifact verifies `SHA256SUMS` before using it. Only `release` has `contents: write`, and with `id-token: write` and `attestations: write` it attests build provenance for the tarball (`gh attestation verify session-analytics-X.Y.Z.tgz -R rokas-tarasevicius/session-analytics`). It runs no repository code: REST calls with the workflow token create the release as a draft, or resume this tag's draft on a re-run, upload `session-analytics-X.Y.Z.tgz`, `session-analytics.tgz` and `SHA256SUMS`, check each upload against the verified file, and only then publish the release. It is marked latest unless the current latest release has a higher version, so a backport or a late re-run never moves `/releases/latest/download/session-analytics.tgz` back. That URL also never names a release without files. A published release is never changed: a re-run succeeds only when it already carries identical files.

The `npm` job runs after the GitHub Release in the `npm` environment with `id-token: write` and read-only contents. It installs npm 11.21.0 (trusted publishing needs 11.5.1 or newer) and runs `npm publish` on the release tarball with dist-tag `latest`, or `backport` when the registry's `latest` is already a higher version: an explicit `--tag` turns off npm's own guard against tagging an older version `latest`. Trusted publishing exchanges the job's OIDC token for a short-lived credential and adds provenance, so no npm token is stored. A re-run finds the same bytes already published and skips the publish. The job then waits until `npm view session-analytics@X.Y.Z dist.integrity` equals the tarball's SHA-512 integrity, and runs the installed smoke against `session-analytics@X.Y.Z` from the registry.

The `homebrew` job runs on macOS in the `homebrew` environment after the GitHub Release, and after `npm` when that job ran. `scripts/homebrew-formula.ts` renders `Formula/session-analytics.rb` from the version and the tarball's SHA-256. The job copies it into a throwaway local tap (`brew tap-new --no-git`) and runs `brew install`, `brew test` and `brew audit --strict` on it, because the tap's own CI only checks syntax on pushes to `main`. Then it commits the formula to `main` of [rokas-tarasevicius/homebrew-tap](https://github.com/rokas-tarasevicius/homebrew-tap) through the contents API with the `TAP_TOKEN` secret; an unchanged formula makes no commit, and a tap that already has a higher version is left unchanged. The formula installs the release tarball with `npm install *std_npm_args`, depends on Homebrew's `node`, and pins that Node.js ahead of any older one on `PATH`. Its test runs `--version` and an offline `report --json --no-index` with an empty `HOME`. The script is the formula's only source; the tap's copy is overwritten on each release.

With neither variable set, a tag still produces a complete GitHub Release, and the tarball URL install works. `release:check` refuses prerelease versions today; should it allow one, the workflow would publish a GitHub prerelease that is not marked latest, use npm's `next` dist-tag and leave the tap alone.

An active [tag ruleset](https://github.com/rokas-tarasevicius/session-analytics/rules/24996643), configured and read back on 2026-10-13, blocks updates and deletion of `refs/tags/v*` with no bypass actors. This keeps an existing release tag from moving between validation and publication. When a tag's run fails, re-run the failed jobs from its Actions page. Re-running is safe: a release, npm version or formula that already has these bytes is left alone, and a tag that publishes after a higher version never takes over `latest` on GitHub, npm or the tap. A failure that needs a code change takes the next patch version, because the tag cannot move.

## One-time maintainer steps

These account and repository actions turn on the npm and Homebrew jobs. Until they are done, those jobs are skipped, and the user guides (README, `docs/cli.md#install`, the FAQ and the agent skill) name only the release tarball. Add each channel's install, upgrade and uninstall commands to those guides only after it serves a release, so no guide sends users to a package that does not exist or that someone else could register.

### npm

1. Create or verify an npm account with two-factor authentication, preferably a security key.
2. Release the first packaged version with `NPM_PUBLISH` unset, and claim the name immediately after: download `session-analytics-X.Y.Z.tgz` and `SHA256SUMS` from its GitHub Release, run `shasum -a 256 -c --ignore-missing SHA256SUMS`, then `npm publish session-analytics-X.Y.Z.tgz` with your second factor. This claims the unscoped name with the bytes CI tested; that version has no provenance. Until then anyone can register `session-analytics`, so check `npm view session-analytics maintainers` names only you.
3. On npmjs.com, open the package's **Settings → Trusted publishing** and add GitHub Actions: owner `rokas-tarasevicius`, repository `session-analytics`, workflow `release.yml`, environment `npm`. Leave **Allow npm dist-tag** off: `npm publish --tag` sets `latest` or `next` itself, and you can move a dist-tag with `npm dist-tag add session-analytics@X.Y.Z latest` and your second factor. Then set **Publishing access** to require two-factor authentication and disallow tokens.
4. In the repository settings, create the environment `npm`, limit its deployments to tags matching `v*`, and optionally require your review.
5. Set the repository variable `NPM_PUBLISH` to `true`. The next tag publishes through CI.
6. Add the npm commands (`npm install -g session-analytics`, pinning with `@X.Y.Z`, `npx session-analytics@X.Y.Z`) to the user guides.

### Homebrew

1. Run `brew tap-new rokas-tarasevicius/homebrew-tap`, then publish it as the public repository `rokas-tarasevicius/homebrew-tap` with a `main` branch, for example `gh repo create rokas-tarasevicius/homebrew-tap --public --source "$(brew --repository rokas-tarasevicius/homebrew-tap)" --push`.
2. Create a fine-grained personal access token for that repository only, with **Contents: Read and write**. In this repository, create the environment `homebrew`, limit its deployments to tags matching `v*`, and add the token as its secret `TAP_TOKEN`.
3. Set the repository variable `HOMEBREW_TAP` to `true`. The next tag commits the formula. For a release that is already published, commit the formula yourself: run `node scripts/homebrew-formula.ts --version X.Y.Z --sha256 <SHA-256 from SHA256SUMS>` and save its output as `Formula/session-analytics.rb` in the tap.
4. Check the result with `brew install rokas-tarasevicius/tap/session-analytics` and `brew test session-analytics`, then add the Homebrew install, upgrade and uninstall commands to the user guides.

## Public launch gates

The maintainer made the repository public on 2026-10-13. These repository settings were configured and read back then; recheck them after any change:

- **Required checks.** Branch protection on `master` requires `check (ubuntu-latest)`, `check (macos-latest)` and `browser (ubuntu-latest)`, with up-to-date branches, pull requests and resolved conversations. It applies to administrators; force pushes and deletion are disabled. Pull requests, pushes to `master` and manual runs use GitHub-hosted runners only, regardless of repository visibility; both `check` jobs run `npm run release:check`, so every pull request builds, installs and runs the package on Linux and macOS. No workflow selects `agentbox` or treats a platform as advisory.
- **Runners.** The repository runners API listed zero available self-hosted runners on 2026-10-13. Recheck repository access and any inherited runner policy before adding one: an outside contributor's workflow could otherwise select it. [GitHub Actions security guidance](https://docs.github.com/en/actions/reference/security/secure-use).
- **History and assets.** The [2026-10-13 history review](proposals/evidence/public-history-review-2026-10-13.md) records the reachable text, image and font inventory and its limits. Recheck any added refs or assets. Removing a file from the latest commit does not remove it from history.
- **Private vulnerability reporting** was enabled after the visibility change and read back through GitHub's settings API. Independently check that an ordinary signed-in user can open the route in [SECURITY.md](../SECURITY.md). [GitHub configuration instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
- **Private reporting contacts.** [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) and [SECURITY.md](../SECURITY.md) name the maintainer's existing public email address and recipient. Ownership and publication were verified against the maintainer's public website source; no test email was sent. The maintainer must monitor the mailbox.
- **Social preview.** Upload `assets/social-preview.png` in repository settings; this is still open in [TODOS.md](../TODOS.md).

## Release history

Tags and GitHub Releases start at v0.7.0; v0.7.0 through v0.9.0 carry release notes only, and packages start with the next release. 0.8.1 has a changelog section and a release commit, `67b0281`, but no tag or GitHub Release; its changes first shipped in v0.9.0, and the changelog's compare links name that commit. Do not tag it retroactively: tags are immutable, and a tag publishes.

## After release

Check each channel from a clean shell: `npm install -g https://github.com/rokas-tarasevicius/session-analytics/releases/latest/download/session-analytics.tgz` and `session-analytics --version`, `npm view session-analytics version` once npm publishing is on, and `brew upgrade session-analytics` once the tap is. Recheck the private reporting routes. For an accounting regression, record which totals move and why in the next changelog entry. For a privacy or security issue, follow [SECURITY.md](../SECURITY.md) and withdraw affected release guidance while triaging.

New provider formats, a standalone executable, Windows support, declaration files and consenting user research remain separate work in [TODOS.md](../TODOS.md) and the [roadmap](roadmap.md). The [2026-10-13 readiness plan](proposals/open-source-readiness-2026-10-13.md) records the public launch's decisions and verification limits.
