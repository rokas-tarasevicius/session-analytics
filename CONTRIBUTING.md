# Contributing

Thanks for helping. This project reads some of the most sensitive files on a developer's machine, so the bar for privacy and accounting accuracy is high. Please read the [privacy rules](#privacy-rules) before changing anything that produces output.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Setup

Requirements: Node.js 24 or newer (see `.nvmrc`) and Git. macOS is the primary platform; Linux works for Claude Code and Codex sources.

```bash
git clone https://github.com/rokas-tarasevicius/session-analytics.git
cd session-analytics
npm ci              # TypeScript and Node type definitions only
npm run check       # type check and the full test suite
```

Development has no build step: Node runs the TypeScript sources directly. Releases ship the same code compiled into `dist/`, because Node refuses TypeScript under `node_modules`. Code that names a sibling file by path at run time, such as a worker entry, uses `moduleUrl("./worker.ts", import.meta.url)` from `src/module-url.ts`, which names the emitted `.js` in the compiled package; the build fails on a string path that still names a `.ts` file. The dashboard serves only the files listed in `src/static-routes.ts`, and the release check requires each of them in the package.

| Script | What it does |
| --- | --- |
| `npm start` | Scan your local history and open the dashboard. Add `-- --no-open` to skip the browser. |
| `npm run report` | Print the terminal report for your local history. |
| `npm run demo` | Generate synthetic sessions in a temporary directory and open the dashboard on port 4175 against that data only. `npm run demo -- report` prints the report; `-- --keep` keeps the generated files. |
| `npm run typecheck` | `tsc --noEmit` over `bin/`, `src/`, `test/`, and `scripts/`. |
| `npm test` | `node scripts/test.ts` runs the Node test runner with concurrency 2 over `test/`, `test/validation/` and `verify/` suites, using an isolated temporary directory. |
| `npm run test:browser` | Run the two Chrome suites with isolated fixtures; missing or unlaunchable Chrome fails. Set `SESSION_ANALYTICS_CHROME` to your Chrome/Chromium executable outside the default macOS location. |
| `npm run check` | Type check, then tests. CI requires GitHub-hosted Ubuntu and macOS source checks plus a required Ubuntu Chrome check for pull requests, pushes to `master` and manual runs, in both private and public repositories. |
| `npm run build` | Compile the installable package into `dist/`: JavaScript, dashboard files, rate card, schemas and skill, with a generated manifest that has no install scripts or dependencies. `node scripts/build.ts --out DIR` builds elsewhere. |
| `npm run pack:release` | Build, then pack `dist/` into `release/session-analytics-X.Y.Z.tgz`. |
| `npm run release:check` | Validate a release locally: version metadata, type check, tests, snapshot schemas and synthetic JSON report, then build and pack the package, check its files and manifest, install it into a temporary prefix and run every command, the demo report, MCP and the dashboard from the installed copy (`scripts/smoke-installed.ts`). Does not publish. |

Use the demo for screenshots, bug reproductions, and UI work. Never attach screenshots or JSON from your own history to an issue or pull request.

The test wrapper chooses a writable temporary directory outside ancestor Git repositories and passes it to fixtures through `TMPDIR`, `TMP` and `TEMP`. This prevents repository-discovery tests from inheriting an unrelated parent Git root. It removes only its own run directory on exit. If neither the system temp directory nor `/var/tmp` is usable, set `TMPDIR` to a writable directory outside any Git checkout.

## Project layout

```text
bin/session-analytics.ts     command dispatcher (dashboard, report, rates, export, merge, index, mcp, limits)
src/
  analyzer.ts                discovery, identity, repository assignment, parsers, pricing, aggregation
  analysis-process.ts        runs an analysis in a child process
  analysis-worker.ts         child-process entry point
  cursor-worker.ts           child process for the Cursor database
  server.ts                  loopback dashboard server
  static-routes.ts           every file the dashboard serves
  module-url.ts              sibling module paths for source and compiled runs
  cli.ts                     terminal report and JSON snapshot
  types.ts                   public snapshot types and internal correlation types
  brand.ts, version.ts       product identity and version
  providers/                 content-free provider adapters
  pricing/                   public feeds, dated catalog and private cache
  interop/                   snapshot schemas, exports, sharing and merge
  mcp/                       metrics-only stdio server
  store/                     private derived index and incremental ingest
  public/                    dashboard (HTML, ES module, CSS, fonts, provider marks)
data/rate-cards.json         versioned model rates with source URLs
skills/session-analytics/    agent skill
scripts/demo.ts              synthetic dataset and demo launcher (--bin runs another build)
scripts/build.ts             compiles the installable package into dist/
scripts/smoke-installed.ts   installs a packed tarball and runs it end to end
scripts/homebrew-formula.ts  renders the Homebrew tap formula for a release
test/                        node:test suites and fixtures
verify/                      independent accounting oracles and verification guide
schemas/                     closed public snapshot and sharing schemas
docs/                        metrics, privacy, architecture, providers, roadmap, branding
assets/                      logo, social preview, screenshots
```

[docs/architecture.md](docs/architecture.md) explains how these fit together.

## Privacy rules

These rules apply to every change, including dashboard and documentation changes.

1. **Allowlist, never pass through.** Public objects are built field by field. Do not spread or copy provider records, and do not add a field that can carry free text from a transcript.
2. **Any new public field** must be:
   - declared in the public types in `src/types.ts`;
   - listed in the [field manifest](docs/privacy.md#field-manifest) in `docs/privacy.md` with its privacy tier;
   - defined in [`docs/metrics.md`](docs/metrics.md);
   - covered by a test that plants sentinel content in the relevant provider records (see `test/fixtures.ts`) and asserts with `assert.doesNotMatch` that it does not appear in the serialized output.
3. **Names must be bounded.** Tool names come from structured tool-call records. Do not derive names from prompts, system instructions, or arbitrary text.
4. **No paths, IDs, or errors in output.** File paths, working directories, repository roots and remotes, raw session or provider IDs, branch names, titles, and raw exception messages stay inside the analysis process. Use the existing hashed keys and fixed error messages.
5. **Read-only sources and local storage.** Open provider SQLite databases with `readOnly: true`, never write to provider directories, and do not add telemetry, CORS headers, or non-loopback binds. Network requests are limited to documented fixed public-pricing GETs (`--offline` disables them), explicit `export --otlp-endpoint` delivery, independent of the pricing setting, and explicit `--remote` snapshot reads through the user's `ssh`; see [pricing](docs/pricing.md) and [the delivery boundary](docs/interop.md#opentelemetry-mapping). Only `src/store/` may write the private derived index. Extend its explicit disk projection when adding public session fields; test full-scan/index parity and sentinel absence on disk as well as in output. Give fixtures and demo runs their own `dataDir`.
6. **No runtime dependencies.** Use Node built-ins. A new development dependency needs a reason in the pull request.
7. **Opt-in for content.** Features that need content (privacy tiers P2 and P3) must be off by default, behind an explicit option, and labeled in the interface.

## Adding a provider

Provider adapters live in `src/providers/`. Implement `ProviderAdapter` (`discoverRoots`, `identify`, `analyze`) and register the source in `src/providers/index.ts`; the host in `src/analyzer.ts` supplies shared repository assignment, pricing, and aggregation. A new source needs:

1. **Discovery.** Default locations, profile handling if the tool supports several profiles, and an explicit override option added to `src/options.ts`, which gives both commands the flag and its `SESSION_ANALYTICS_*` environment variable. An explicit override must replace discovery so synthetic and narrowed scans never read real history.
2. **Identity.** Read the provider's own session ID and working directory, and only accept a file whose recorded ID matches its name or key.
3. **Parser.** Stream records and accumulate counters into an explicit allowlist projection. Decide and document the dedupe key for every counter (message IDs, call IDs, cumulative counters).
4. **Cost basis.** Use the rate card when the provider records model IDs and token classes; otherwise use a provider-reported value on its own basis, or mark cost unavailable. Never present an imputed token-class price as observed evidence; any documented substitution must carry a bounded assumption and exclude affected tokens from explicit-rate coverage.
5. **Evidence labels.** Set `executionKind` and fidelity honestly. Missing data is `unavailable`, not zero.
6. **Types and UI.** Extend `SessionProvider` and the dashboard provider registry. Prefer text labels for new providers; a vendor mark requires a license/provenance note in `src/public/brands/NOTICE.md`.
7. **Fixtures and tests.** Add records in the provider's real shape to `test/fixtures.ts`, including sentinel content, and test counts, dedupe, cost, and the absence of content. Preserve native-provider outputs with parity fixtures when migrating a parser. Extend `scripts/demo-providers.ts` so visual QA stays synthetic.
8. **Docs.** Add a section to [docs/providers.md](docs/providers.md) and a row to the README's "Which agents it reads" table.

Open a [provider support issue](https://github.com/rokas-tarasevicius/session-analytics/issues/new?template=provider_support.yml) first so the record format can be discussed with redacted samples.

## Rate-card changes

`data/rate-cards.json` is a reproducibility input. A rate change must:

- cite a primary source URL from the model's provider in `source`;
- update `effectiveDate` to the date the rates were verified;
- note pricing exceptions (cache multipliers, long-context thresholds) in the pricing section of `docs/metrics.md`;
- keep `test/contract.test.ts` passing, and add a test when the change exercises new pricing logic.

Public pricing fetches belong only in `src/pricing/`; analysis stays network-free. Tests use loopback HTTP fixtures, never real sources. Preserve immutable observations, shared rate tables (including legacy snapshot readability), the reviewed override list, model-specific exceptions, and content-free provenance when changing normalization or precedence. Exercise the history-size benchmark when changing lookup/storage, and test both report modes for fixed errors when changing failure handling.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `chore:`, `ci:`. Use a scope when it helps, such as `fix(codex): ...` or `feat(dashboard): ...`. Mark breaking changes to the CLI or the JSON shape with `!` and explain them in the body.
- Keep pull requests focused, and fill in the pull request template, including the privacy checklist.
- `npm run check` must pass.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). User-visible changes (new metrics, changed numbers, CLI options, dashboard behavior, rate-card updates) add a line under `## [Unreleased]`. Accounting fixes say what was wrong and in which direction totals move. Maintainers move entries into a version section at release time and update the compare links at the bottom of the file.

Pushing a `vX.Y.Z` tag runs the release workflow. Every release requires GitHub-hosted Ubuntu and macOS validation, the required Ubuntu Chrome check, and an installed smoke of the packed tarball on Ubuntu and macOS under Node.js 24 and 26 before publication. Validation checks that the tag, package, source version, latest changelog release and its compare links agree, then runs `release:check`. Only the publishing job has write permission: it attests the tarball's provenance and creates the GitHub Release with the tarball, an unversioned alias and `SHA256SUMS`, using the matching `## [X.Y.Z]` section from `CHANGELOG.md` as its notes. The same bytes then go to npm and the Homebrew tap when those channels are enabled. See [docs/release.md](docs/release.md) for the preflight, the jobs and the one-time maintainer steps.

## Style

- Strict TypeScript that Node can run without a build: only erasable syntax (no enums, namespaces, or parameter properties), `import type` for types, and `.ts` extensions in relative imports.
- Prefer small pure functions and explicit field-by-field construction for anything public.
- Keep the dashboard dependency-free, with no inline scripts or styles, so the Content Security Policy stays strict.
- Formatting follows `.editorconfig`: UTF-8, LF, two-space indentation, final newline.
