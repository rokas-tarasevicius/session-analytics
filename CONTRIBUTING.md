# Contributing

Thanks for helping. This project reads some of the most sensitive files on a developer's machine, so the bar for privacy and accounting accuracy is high. Please read the [privacy rules](#privacy-rules) before changing anything that produces output.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Setup

Requirements: Node.js 24 or newer (see `.nvmrc`) and Git. macOS is the primary platform; Linux works for Claude Code and Codex sources.

```bash
git clone git@github.com:rokas-tarasevicius/session-analytics.git
cd session-analytics
npm install         # TypeScript and Node type definitions only
npm run check       # type check and the full test suite
```

There is no build step. Node runs the TypeScript sources directly.

| Script | What it does |
| --- | --- |
| `npm start` | Scan your local history and open the dashboard. Add `-- --no-open` to skip the browser. |
| `npm run report` | Print the terminal report for your local history. |
| `npm run demo` | Generate synthetic sessions in a temporary directory and open the dashboard on port 4175 against that data only. `npm run demo -- report` prints the report; `-- --keep` keeps the generated files. |
| `npm run typecheck` | `tsc --noEmit` over `bin/`, `src/`, `test/`, and `scripts/`. |
| `npm test` | `node --test test/*.test.ts` |
| `npm run check` | Type check, then tests. CI runs this on Ubuntu and macOS. |

Use the demo for screenshots, bug reproductions, and UI work. Never attach screenshots or JSON from your own history to an issue or pull request.

## Project layout

```text
bin/session-analytics.ts     command dispatcher (dashboard, report)
src/
  analyzer.ts                discovery, identity, repository assignment, parsers, pricing, aggregation
  analysis-process.ts        runs an analysis in a child process
  analysis-worker.ts         child-process entry point
  cursor-worker.ts           child process for the Cursor database
  server.ts                  loopback dashboard server
  cli.ts                     terminal report and JSON snapshot
  types.ts                   public snapshot types and internal correlation types
  brand.ts, version.ts       product identity and version
  public/                    dashboard (HTML, ES module, CSS, fonts, provider marks)
data/rate-cards.json         versioned model rates with source URLs
skills/session-analytics/    agent skill
scripts/demo.ts              synthetic dataset and demo launcher
test/                        node:test suites and fixtures
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
3. **Names must be bounded.** Tool names come from structured tool-call records. Skill identifiers must pass `normalizedSkillName`. Do not derive names from prompts, system instructions, or arbitrary text.
4. **No paths, IDs, or errors in output.** File paths, working directories, repository roots and remotes, raw session or provider IDs, branch names, titles, and raw exception messages stay inside the analysis process. Use the existing hashed keys and fixed error messages.
5. **Read-only and local.** Open SQLite with `readOnly: true`, never write to provider directories, and do not add network requests, telemetry, CORS headers, or non-loopback binds.
6. **No runtime dependencies.** Use Node built-ins. A new development dependency needs a reason in the pull request.
7. **Opt-in for content.** Features that need content (privacy tiers P2 and P3) must be off by default, behind an explicit option, and labeled in the interface.

## Adding a provider

Provider adapters live in `src/providers/`; the host in `src/analyzer.ts` supplies shared repository assignment, pricing, and aggregation. A new source needs:

1. **Discovery.** Default locations, profile handling if the tool supports several profiles, and an explicit override option added to `src/options.ts`, which gives both commands the flag and its `SESSION_ANALYTICS_*` environment variable. An explicit override must replace discovery so synthetic and narrowed scans never read real history.
2. **Identity.** Read the provider's own session ID and working directory, and only accept a file whose recorded ID matches its name or key.
3. **Parser.** Stream records and accumulate counters into an explicit allowlist projection. Decide and document the dedupe key for every counter (message IDs, call IDs, cumulative counters).
4. **Cost basis.** Use the rate card when the provider records model IDs and token classes; otherwise use a provider-reported value on its own basis, or mark cost unavailable. Never guess a price.
5. **Evidence labels.** Set `executionKind`, `skillEvidence`, and fidelity honestly. Missing data is `unavailable`, not zero.
6. **Types and UI.** Extend `SessionProvider` and the dashboard provider registry. Prefer text labels for new providers; a vendor mark requires a license/provenance note in `src/public/brands/NOTICE.md`.
7. **Fixtures and tests.** Add records in the provider's real shape to `test/fixtures.ts`, including sentinel content, and test counts, dedupe, cost, and the absence of content.
8. **Docs.** Add a section to [docs/providers.md](docs/providers.md) and a column or row to the README's evidence table.

Open a [provider support issue](https://github.com/rokas-tarasevicius/session-analytics/issues/new?template=provider_support.yml) first so the record format can be discussed with redacted samples.

Provider implementations live in `src/providers/`. Implement `ProviderAdapter` (`discoverRoots`, `identify`, `analyze`), register the source in `src/providers/index.ts`, and inject pricing/repository assignment through the host. Keep raw IDs, paths, and source objects behind that boundary. Add explicit path options, primary-source schema references, synthetic sentinel fixtures, and fidelity/availability labels. Preserve native-provider outputs with parity fixtures when migrating a parser. Extend `scripts/demo-providers.ts` when adding a source so visual QA remains entirely synthetic.

## Rate-card changes

`data/rate-cards.json` is a reproducibility input. A rate change must:

- cite a primary source URL from the model's provider in `source`;
- update `effectiveDate` to the date the rates were verified;
- note pricing exceptions (cache multipliers, long-context thresholds) in the pricing section of `docs/metrics.md`;
- keep `test/contract.test.ts` passing, and add a test when the change exercises new pricing logic.

Do not add live price fetching. Prices are reviewed and versioned on purpose.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `chore:`, `ci:`. Use a scope when it helps, such as `fix(codex): ...` or `feat(dashboard): ...`. Mark breaking changes to the CLI or the JSON shape with `!` and explain them in the body.
- Keep pull requests focused, and fill in the pull request template, including the privacy checklist.
- `npm run check` must pass.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). User-visible changes (new metrics, changed numbers, CLI options, dashboard behavior, rate-card updates) add a line under `## [Unreleased]`. Accounting fixes say what was wrong and in which direction totals move. Maintainers move entries into a version section at release time.

## Style

- Strict TypeScript that Node can run without a build: only erasable syntax (no enums, namespaces, or parameter properties), `import type` for types, and `.ts` extensions in relative imports.
- Prefer small pure functions and explicit field-by-field construction for anything public.
- Keep the dashboard dependency-free, with no inline scripts or styles, so the Content Security Policy stays strict.
- Formatting follows `.editorconfig`: UTF-8, LF, two-space indentation, final newline.
