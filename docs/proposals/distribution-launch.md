# Distribution and open-source launch proposal

Status: proposed 2026-10-02; npm, the GitHub Release tarball and the Homebrew tap implemented 2026-10-14 as described in [releases](../release.md), and the standalone executable is still open. The package layout differs from the sketch below: `dist/` is the package root with its own generated manifest, while the root `package.json` stays private. The rest of this document is the original proposal and claims no published package, tap, executable, or docs deployment. It accompanies [the product strategy](product-strategy.md). External references were checked on the date above; packaging experiments below remain release gates, not completed validation.

## Decision

Launch **Session Analytics** with compiled JavaScript on npm, then a maintained Homebrew tap that installs the same release payload with a Node dependency. Keep the source-checkout workflow for contributors. Spend at most two engineering days investigating a standalone executable after those routes work; defer its public release until it preserves the process and privacy boundaries. Do not make a binary a launch dependency.

The first promise is: **“Understand your coding-agent work across repositories, without exposing conversation content.”** Pair it immediately with “Runs locally. No telemetry. API-equivalent value is not your bill.” The product earns trust through inspectable calculations, coverage, and reproducible examples. A new name or installer cannot substitute for those properties.

## What exists, and what does not

| Inspected evidence | Current behavior | Distribution consequence |
| --- | --- | --- |
| [package.json](../../package.json), [tsconfig.json](../../tsconfig.json) | `private: true`; version `0.5.0`; Node `>=24`; `bin` targets `bin/session-analytics.ts`; no emit/build script; no runtime dependencies | A source checkout is the documented execution route. Registry availability and installability are not established. |
| [command dispatcher](../../bin/session-analytics.ts) | ESM, top-level `await`, dynamic relative `.ts` imports | Preserve ESM for npm; a CommonJS bundle requires an intentional wrapper/refactor. |
| [analysis process](../../src/analysis-process.ts), [analyzer](../../src/analyzer.ts) | Spawn `process.execPath` with sibling `.ts` worker filenames and separate 256/192 MB heap limits | Transpiling imports alone will leave broken worker paths. Packaging must exercise both child processes. |
| [server](../../src/server.ts), [analyzer](../../src/analyzer.ts) | Dashboard files and rate card resolve relative to module location | Assets must move with the code in a defined release layout, independent of the user's working directory. |
| [CI](../../.github/workflows/ci.yml) | Typecheck/tests on Ubuntu and macOS with Node 24 | Good source validation; no clean-machine package installation matrix exists. |
| [README](../../README.md), [security policy](../../SECURITY.md), [privacy contract](../privacy.md) | Local GET-only dashboard, read-only provider stores, no telemetry; macOS primary, Linux Claude/Codex support; Windows unsupported | Keep the support claim this narrow until platform-specific installation and discovery have passed. |
| [brand](../../src/brand.ts), [branding guide](../branding.md) | Display/command identity separated from stable service, storage, and environment identifiers | Keep compatibility identifiers through any future rename. |
| [contribution guide](../../CONTRIBUTING.md), `.github/` | MIT license, ownership file, issue templates, private security reporting instructions, synthetic fixtures and demo | Launch needs operational verification and release automation, not a replacement governance framework. |

Node explicitly refuses TypeScript files below a `node_modules` directory. Consequently, changing `private` to `false` and publishing the current source layout is not an acceptable npm plan. This is a documented platform limitation; a full package-install reproduction has not been run in this proposal. [Node 24 TypeScript documentation](https://nodejs.org/docs/latest-v24.x/api/typescript.html#type-stripping-in-dependencies)

## Compiled npm package: first supported artifact

Use the existing TypeScript development dependency to emit ordinary ESM JavaScript. Keep `npm start` and source tests unchanged for contributors. Add a separate build configuration scoped to production `bin/` and `src/`, with a deliberate allowlist for copied resources. Do not add a runtime loader, transpiler, bundler, download hook, or native SQLite dependency.

Proposed artifact layout:

```text
package.json                  bin -> dist/bin/session-analytics.js
dist/
  bin/session-analytics.js
  src/*.js                    includes analysis and Cursor worker entries
  src/public/                 HTML, JS, CSS, fonts, marks, notices
  data/rate-cards.json
skills/session-analytics/     skill plus its agent metadata
README.md
LICENSE
```

This retains the server's `src/public` relationship and analyzer's `../data` relationship within `dist`. Build code must copy every static route target and accompanying font/provider notices. The skill's published instructions must prefer the installed command; a source-checkout fallback cannot point to TypeScript files absent from the package.

TypeScript's `rewriteRelativeImportExtensions` rewrites supported relative TypeScript imports when emitting JavaScript. It is not a filesystem-path transformation facility. In particular, this repository's `new URL("./analysis-worker.ts", import.meta.url)` and Cursor equivalent need an explicit source/emitted worker resolver or an equally narrow build transformation. Test the actual emitted paths; do not apply a global string replacement over arbitrary code or documentation. [TypeScript extension rewriting](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-7.html#path-rewriting-for-relative-paths)

The release build should fail if the package contains execution references to `.ts` files, lacks an asset, differs in version between CLI/package/health, or gains a runtime dependency. Sources and sourcemaps may be distributed separately for auditability; avoid embedding local absolute build paths. Keep developer tools out of the installed runtime graph.

Use `npm pack --dry-run --json` to review the allowlist, then create a real tarball and install **that tarball** in a temporary, isolated prefix. The dry run is a file-list check, not proof the installed CLI runs. npm documents packing and its machine-readable/dry-run options. [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/)

Proposed release sequence:

1. Establish package-name ownership or select an owned npm scope. Neither the unscoped name nor any alternative is assumed available. Keep the executable name `session-analytics` even if npm requires a scope.
2. In CI, install locked development dependencies, run `npm run check`, build, inspect the tarball, install with lifecycle scripts disabled, and test from outside the checkout. Record artifact hashes and the Node/npm versions used.
3. Remove `private: true` only in the reviewed release change after publication identity and package contents are settled. No `postinstall` script: installation must not scan history, open a browser, or fetch executables.
4. Publish a prerelease under `next`, verify the registry-fetched package independently, then promote the exact validated version to `latest`. Keep documented exact-version install and rollback commands; users control updates.
5. Use GitHub Actions trusted publishing with narrowly configured repository/workflow identity and maintainer-controlled release authorization. Pin and test the npm version required by the chosen publishing operations. Confirm bootstrap requirements for a new package before the first release. npm supports short-lived OIDC publishing and automatic provenance for a public package built from a public repository; a private repository does not qualify for that provenance. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

Provenance helps connect a release to its build; it is not proof that the parser is correct or that a package cannot leak content. Keep privacy tests and artifact review as separate gates. Do not claim byte-for-byte reproducible builds until an independent rebuild has actually matched.

## Homebrew: a tap after npm parity

Offer a maintained project tap with a formula that installs the versioned compiled JavaScript payload and declares a compatible Node dependency. That is the same application with a different package manager, not a second parser or a second runtime. Pin the artifact URL and SHA-256; invoke no online price updates, post-install analysis, self-updater, or background service.

A project-owned tap is a supported external source of Homebrew formulae and can be installed using its fully qualified formula name. It avoids making Homebrew core admission a launch dependency. The future install command belongs in release docs only after the repository/formula exists and the install test passes. [Homebrew tap documentation](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap)

For a later core submission, review the rules then in force: current guidance requires stable, versioned, verifiable sources, compatible open-source licensing, and successful supported-platform builds/tests; self-updating behavior conflicts with Homebrew management. Core acceptance is an external review outcome, not a promised milestone. [Homebrew acceptable formulae](https://docs.brew.sh/Acceptable-Formulae)

The tap test must run a synthetic report with an isolated home, explicit provider overrides, and a synthetic SQLite database; `--version` alone misses the worker/SQLite failures most likely to break this app. Verify upgrades from the previous release and uninstall behavior. A future persistent index must remain in the documented user data directory, never in a read-only package-manager prefix. Uninstall should not silently destroy that user's data.

## Single executable: a bounded technical experiment

The user benefit is substantial for developers who do not already maintain Node: download one verified artifact and run it. The maintenance cost is also substantial: the project would distribute and patch a runtime, sign multiple platform artifacts, and retain the current worker boundaries. “Zero npm runtime dependencies” remains accurate; “no runtime or supply chain” does not.

Node 24.0's documented single-executable application (SEA) path embeds a CommonJS script and supports bundled assets; it requires the preparation blob and target Node binary to use the same version. Current Node documentation includes newer ESM and CLI-generation capabilities, so a recipe for a newer release must not be assumed to work on the supported Node 24 floor. Pin a specific runtime patch and its documentation during the experiment. [Node 24.0 SEA documentation](https://nodejs.org/download/release/v24.0.0/docs/api/single-executable-applications.html), [current Node SEA documentation](https://nodejs.org/api/single-executable-applications.html)

`node:sqlite` is a Node built-in used by this repository, not an npm `.node` addon to vendor. Its presence in Node does not prove a particular executable build supports our read-only SQLite behavior; run that test. [Node 24 SQLite documentation](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html)

Experiment order and stop conditions:

| Gate | Experiment | Acceptance / stop condition |
| --- | --- | --- |
| SEA-1 | Bundle a tiny CLI with `node:sqlite`, create a synthetic DB outside provider directories, reopen it read-only, and query it | Runs on a machine without Node; unsupported built-ins or platform linkage halt this route. |
| SEA-2 | Bundle the real dispatcher and static resources; run `--help`, `report --json`, dashboard, and custom rate card | ESM/top-level await/dynamic imports handled deliberately; embedded HTML/fonts/rates match npm output. No dependency on checkout files. |
| SEA-3 | Re-execute the packaged binary in internal analysis and Cursor worker modes | Preserve bounded heaps, stdin/stdout allowlisted protocol, failure isolation, and fixed public errors. `process.execPath` now identifies the application binary; the existing “Node flags + worker filename” call cannot be presumed valid. |
| SEA-4 | Run from read-only installation directories, directories with spaces, and an isolated empty home; cancel and force worker failure | No provider writes, orphan workers, unsafe extraction locations, or raw errors. If resources require extraction, document ownership, permissions, cleanup, and race handling before release. |
| SEA-5 | Build native targets, verify downloaded artifacts, and exercise macOS quarantine/signing requirements | Produce a documented signing/notarization result and a tested Linux compatibility floor; no “disable Gatekeeper” onboarding. Keep unsupported architectures unavailable. |
| SEA-6 | Rebuild against a Node security patch and rerun parity suite | Maintainer can ship runtime updates promptly. If not, retain npm/Homebrew as supported routes. |

These are experiments, not completed work. A development-only bundler or injection tool could be justified for this route after the spike; runtime dependency count must stay zero. Prefer an ordinary archive containing Node plus JavaScript over calling an extraction-based launcher “a single binary.” Do not replace the parser with another runtime merely to obtain an easy compiler flag.

## Release acceptance matrix

Every cell below is **required before claiming the corresponding channel supported**. None of the packaging rows is certified by this proposal or by source tests alone.

| Check | Source checkout | Compiled npm | Homebrew tap | Standalone executable |
| --- | --- | --- | --- | --- |
| Supported environments | Existing macOS/Linux Node 24 CI; document exact minimum patch | macOS arm64/x64 and Linux x64 initially; minimum supported and current Node 24 patch | Every OS/architecture advertised by the formula | Every published OS/architecture; no system Node present |
| Entry/relocation | Start, help, report, JSON | Local prefix, global prefix, registry execution, outside checkout, paths with spaces | Formula install/upgrade/uninstall, read-only prefix | Relocated download; read-only install directory |
| Isolation | Analysis and Cursor children exercised | Both emitted `.js` workers execute with existing caps | Same installed-worker checks | Internal worker dispatch and caps demonstrated |
| Assets/accounting | Synthetic demo and fixture tests | Rate card, custom rate card, fonts, marks, skill, notices present | Same artifact manifest | Embedded resources and custom files both work |
| Functional parity | Baseline synthetic snapshot | Compare stable fields with source, excluding generation timestamps | Compare with the same npm release | Compare with the same npm release |
| Privacy/security | Existing sentinels, loopback, Host/Origin, GET-only, CSP tests | Repeat against installed artifact; malformed evidence and worker failure included | Repeat smoke checks; never read tester history | Same checks plus extraction and signing behavior |
| Offline operation | Explicit local sources after setup | Installed runtime works without network | Installed runtime works without network | Runtime works without network |
| Supply chain | Locked dev tooling, source review | Tarball allowlist/hash, no install scripts or runtime deps, verified provenance | Checksummed artifact and dependency declaration | Runtime version/license inventory, hash/signature, patch procedure |

Windows stays unsupported until discovery, SQLite, path handling, worker spawning, and browser opening pass on Windows. A platform-neutral JavaScript artifact does not establish platform support. Linux arm64 likewise stays unadvertised until the chosen package/runtime and fixtures are exercised there.

## Name, brand, and docs site

Keep **Session Analytics** for the public preview. The descriptive name immediately explains the tool to a developer reading an install command; its weakness is generic searchability. Address that with the consistent descriptor “local coding-agent analytics,” a distinctive existing session-span mark, and strong repository metadata. Revisit the name only if early users repeatedly confuse it with web session replay or an existing product.

Before any rename, check npm and Homebrew names, GitHub owner/repository availability, domain availability, and relevant product/trademark conflicts. Those checks have not been completed here; candidate availability is not asserted. Prefer an owned scope over a rushed name change. Never imply affiliation with the providers whose marks identify data sources. Preserve the service ID, environment aliases, local storage keys, and JSON schema compatibility described in [branding](../branding.md).

Make repository Markdown the canonical documentation and render a static docs site from it in CI. Start with GitHub Pages or an equivalent static host; this is a hosting proposal, not a deployed site. Use bundled fonts, no analytics script, no CDN runtime assets, no account requirement, and no remote transcript upload. Host-provider access logs may still exist; describe that separately from the local app's no-network contract.

Proposed navigation:

| Page | First question answered | Required content |
| --- | --- | --- |
| Start | “Can I trust and run this?” | Supported install routes, Node requirement, synthetic preview, uninstall/update, exact platform support |
| Understand the numbers | “Why does this disagree with my subscription?” | API-equivalent versus provider-reported basis, coverage, missing evidence, UTC/day handling, worked synthetic examples |
| Privacy | “What reads my history and what can leave the parser?” | Existing field manifest, tiers, process boundary, repository-name sensitivity, no-telemetry statement |
| Workflows | “What decision can I make now?” | Three short tasks: compare repositories, diagnose missing coverage, inspect tool usage; label proposed tasks |
| Providers | “Which fields are supported for my source?” | Versioned evidence matrix, discovery overrides, format limitations, synthetic bug reproduction |
| Agent interface | “How does my agent query safely?” | Current skill/report workflow; future MCP separately labeled until shipped |
| Contribute and release | “Where is a useful small change?” | Fixtures, pricing review, adapter checklist, release artifacts, security reporting |

The landing page gets one primary CTA per supported environment, one synthetic screenshot, one “why these numbers are trustworthy” example, and a link to the privacy manifest. Publish planned metrics under a visibly separate roadmap. Do not advertise an MCP server, coaching, a live limit monitor, or outcome attribution just because a proposal exists.

## Contribution and maintenance model

Retain MIT and the existing single-maintainer decision model. Create clear areas of work rather than a plugin marketplace: provider formats/fixtures, accounting/rates, privacy/security, dashboard accessibility, and packaging. Each adapter contribution needs identity validation, explicit fidelity, dedupe reasoning, synthetic samples, and sentinel tests. No production transcript donation program.

Require small decision notes for public schema additions: user decision served, numerator/denominator, available versus missing evidence, tier, and failure cases. The release maintainer reviews privacy and accounting changes; a second subject-matter reviewer is desirable when available, not an invented staffing requirement that blocks ordinary documentation fixes. Submissions involving P2/P3 require explicit opt-in design before implementation.

Use the existing provider issue form, but strengthen launch copy from “redact your log” to “construct a minimal synthetic record with the same field structure.” Redaction misses identifying strings. Never request real dashboard exports or screenshots for triage. Provide fixed diagnostic categories and a synthetic fixture recipe before proposing an automated diagnostics bundle.

Start with weekly issue triage and a monthly routine release, with security fixes outside that cadence. These are proposed maintainer commitments, not an SLA. Mark unsupported provider versions and stale issues visibly. Keep pricing changes reviewable in small PRs with dated primary sources; no live rate-feed dependency. Publish versioned schema compatibility notes before agent consumers become widespread.

## Telemetry stance and launch learning

Keep the application telemetry-free: no first-run event, installation identifier, error upload, update check, remote font, experiment assignment, or silent feedback prompt. Installation through a registry/package manager involves network access; installed analysis does not. Future user-directed exports are distinct features requiring explicit destinations and a documented field contract. P1 repository names and stable hashes remain identifying metadata even when conversation content is absent.

Learn through public issues, voluntary structured interviews, synthetic walkthroughs, and opt-in feedback written by the user. Keep a small public release scorecard with package-download counts labeled as downloads, installation failures by supported channel, synthetic reproduction issues resolved, and user-described decisions enabled. Downloads are not active users; GitHub stars are not retention. Do not infer either from telemetry the product intentionally does not collect.

For the first cohort, recruit six volunteers: two subscription users, two parallel-agent users, one Linux user, and one security-conscious reviewer. Ask them to install independently, explain the cost basis back, find a repository-level question they can answer, and report only their conclusion plus any synthetic reproduction. Treat this as directional learning, not market validation. Proposed release bar: all six complete supported installation, at least five explain the cost caveat correctly, and at least four describe a concrete decision the tool helped them make. If they cannot, improve onboarding/semantics before promoting another chart.

## Staged launch and checklist

| Window | Deliverable | Owner role | Exit gate |
| --- | --- | --- | --- |
| Next 2 weeks | Compiled npm prerelease; installed-artifact CI; source-based docs; synthetic launch assets | Maintainer plus packaging contributor | npm matrix passes; package contents reviewed; no unearned install/support claims |
| By 6 weeks | Stable npm release and cohort findings; Homebrew tap/docs deployment only with additional capacity or replacement of another planned slice | Maintainer plus docs/packaging contributors | Registry artifact and tap parity; cohort comprehension; usable update/rollback instructions |
| Quarter | Decide on standalone artifacts from capped SEA spike; broaden platforms only with tests | Packaging owner | SEA gates passed and runtime patch ownership accepted, otherwise explicit deferral |

Publication checklist for a future release (unchecked means not verified here):

- [ ] Review repository history and release files for secrets and private material before changing visibility; never publish local evidence artifacts.
- [ ] Verify ownership/name and package visibility; confirm that MIT, third-party notices, provider-mark notices, and copyright are present in each artifact.
- [ ] Confirm private vulnerability reporting is enabled, contact paths work, and the security policy names the release's supported versions.
- [ ] Run `npm run check`, install the packed artifact in clean environments, and pass the relevant matrix above.
- [ ] Review tarball file manifest, artifact checksums, version consistency, locked build-tool inventory, and registry provenance.
- [ ] Confirm screenshots, walkthroughs, social images, and hosted preview data come only from the synthetic demo.
- [ ] Verify every documented install command verbatim after publication, including the `next`/`latest` distinction and minimum runtime requirement.
- [ ] Publish release notes that separate new capability, accounting changes, known coverage gaps, and unsupported platforms.
- [ ] Put one maintainer on launch-day install/support triage; record install defects without requesting private history.
- [ ] Check the exact-version rollback path and rehearse deprecating a broken release without deleting user data or rewriting release history.

Launch in the repository first, then in the coding-agent communities where these workflows already exist. Use a short synthetic walkthrough of one useful decision, not a gallery of expensive token totals. Share a precise comparison and limitations link. Do not post externally as part of this proposal.
