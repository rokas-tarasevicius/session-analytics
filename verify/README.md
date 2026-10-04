# Independent real-machine verification

Run with Node 24: `npm run verify:real`. This opens provider history read-only, seeds immutable pricing observations into a throwaway analyzer data directory, and serializes full/cold/warm scans plus independent oracles with `/tmp/session-analytics-realscan.lock`.

The ten original validation oracle trees are retained. They do not import production parsers for ground truth. `scripts/verify-real-manifest.ts` lists operational collection and reconciliation entrypoints in dependency order. Historical patch builders, browser drivers and frozen-baseline impact assertions are retained for audit but are not current numerical gates.

Each area has a separate artifact workspace under `.lane/verify-real/`; incompatible historical filenames therefore cannot overwrite another lane's evidence. `scripts/verify-reference.mjs` redirects only the frozen reference filename to the explicitly selected current snapshot. The `ORACLE_CUTOFF` override advances literal baseline cutoffs without changing request arithmetic. Repository names in persisted snapshots are replaced with hashed labels. Errors never echo local source paths or content.

For focused investigation against an already generated snapshot:

```
node scripts/verify-real.ts --snapshot .lane/verify-real/full.json --areas claude,codex,conductor,other-providers --output .lane/verify-real-native
```

A successful process is not a verification result. `results.json` contains strict per-area numerical gates; missing required artifact shapes fail. Any unresolved difference returns a nonzero exit status. `execution.json` records every command and exit status. `.lane/MONTHLY.md` separates UTC dated value, creation cohorts, recovered value, undated value and unattributed statistics estimates.

Every scan mode separately runs public-schema and independent aggregate-conservation checks. Session counters are exact; only USD roundoff has tolerance. Cross-mode comparisons retain every top-level field except serialization clocks and independently checked pricing ages. The pricing-age proof reconstructs a single catalog clock from source timestamps and requires it to fall within the measured scan interval.

After correcting an oracle expectation, `node scripts/verify-real.ts --recheck` reruns the saved phase arithmetic and inspects existing oracle artifacts without rescanning native data. It requires all three phase records and an unchanged SHA-256 fingerprint of production source, schemas, rate data and package metadata. It does not treat a supplied snapshot as indexed parity proof. Dependent areas require their sibling artifacts: Claude joins Desktop receipts; pricing joins current Codex request costs; reconciliation joins recovered SDK accounting.

The imported oracles carry documented limits: historical cumulative SDK receipts do not prove disjoint process epochs; stripped response IDs cannot establish every physical request; native history that changed during the scan has no reconstructable frozen state. Exact retained counters and chosen conservative projections are still verified. Explicit observed scope residuals and all oracle corrections are documented in `.lane/oracle-ledger.md`; no tolerance budget turns unknown differences into accepted results.

Current versus historical checks are explicit. The original Codex aggregate reconciliation and native-only time report remain visible with `historicalDiagnostic: true`; current certification instead requires the independent retained-request census and exact token/cost/calendar checks. The original Claude dedup residual is joined to independently proved Desktop receipt deltas, with no unrestricted exception. Native limits denominators contain observed requests; aggregate Desktop receipts contribute usage/spend/velocity without inventing another native request or context size. Every historical artifact still has to exist with the required schema, and every declared command must complete successfully.

Pricing inputs must point directly at the pricing cache, not a parent data directory. The harness rejects a nested `pricing/` input, independently verifies envelope/table SHA-256 checksums, and compares copied source dates, payload hashes, model counts and observation count to every analyzer phase. A source generation that changes during an immutable SQLite read invalidates that oracle; reads never enable provider-store writes or manufacture sidecars.
