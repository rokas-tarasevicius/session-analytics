## Summary

<!-- What changes, and why. Link related issues. -->

## Type

<!-- Conventional Commits type for the squash commit: feat, fix, docs, test, refactor, perf, chore, ci. Mark breaking changes to the CLI or JSON shape with ! -->

## Testing

- [ ] `npm run check` passes
- [ ] Verified behavior with `npm run demo` (dashboard, report, or both) where relevant
- [ ] Added or updated tests for changed parsing, accounting, or output

## Privacy checklist

- [ ] No new public field, **or** every new field is declared in `src/types.ts`, listed with its tier in the field manifest in `docs/privacy.md`, defined in `docs/metrics.md`, and covered by a test that plants sentinel content and asserts it does not appear in the output
- [ ] Public objects are built field by field; no provider records are spread or passed through
- [ ] No prompts, messages, reasoning, tool arguments or results, commands, paths, raw IDs, titles, branches, credentials, or raw errors can reach the dashboard, API, report, JSON, or skill
- [ ] Network requests are limited to documented fixed public-pricing GETs, explicit `export --otlp-endpoint` delivery and explicit `--remote` snapshot reads over the user's `ssh`; offline pricing behavior, absence of local data in pricing URLs/headers/bodies, the OTLP allowlist and opt-in boundary, and the remote command line are tested
- [ ] No telemetry, CORS headers, or non-loopback binds
- [ ] Provider stores are still opened read-only
- [ ] No new runtime dependencies
- [ ] Screenshots and examples come from the synthetic demo, not real history
- [ ] Any content-dependent feature (P2 or P3) is opt-in and off by default

## Accounting checklist

<!-- Delete if not applicable. -->

- [ ] Rate changes cite a primary source URL and update `effectiveDate`
- [ ] Changes to totals are explained, with the direction of the change
- [ ] Fidelity labels (exact, estimated, reported, inferred, unavailable) remain accurate in `docs/providers.md` and the README

## Changelog

- [ ] User-visible change recorded under `## [Unreleased]` in `CHANGELOG.md`, or not user-visible
