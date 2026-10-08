/** Every independent lane's executable collection/reconciliation pipeline.
 * Historical patch builders, browser drivers, fixed-baseline impact assertions and
 * test modules remain imported under verify/, but are not real-machine collectors.
 */
export type OracleStep = { file: string; args?: string[]; stdout?: string };
const steps = (area: string, names: string): OracleStep[] => names.trim().split(/\s+/).map(file => ({ file: `${area}/${file}` }));
export const oraclePipelines: Record<string, OracleStep[]> = {
  claude: steps('claude', `discovery-audit.mjs raw-audit.mjs oracle.mjs`),
  codex: steps('codex', `oracle.mjs raw-audit.mjs db-oracle.mjs legacy-key-map.mjs db-oracle.mjs db-raw-sample.mjs db-crosscheck.mjs db-wal-check.mjs source-control.mjs compare.mjs receipts-audit.mjs fork-replay-audit.mjs collisions-audit.mjs owner-audit.mjs owner-event-shapes.mjs reconcile.mjs receipt-reconciliation-check.mjs current-reconciliation.mjs`),
  conductor: steps('conductor', `current-oracle.mjs assistants.mjs diff.mjs semantics.mjs accounting.mjs overlap-certificates.mjs review-overlap-certificates.mjs overlap.mjs codex-legacy.mjs partial-coverage.mjs review-conductor-evidence.mjs probe-modern-request-identity.mjs modern-lower-bound.mjs calibrate-marginal.mjs review-projection-incidence.mjs confirmed-impact.mjs`),
  reconcile: [
    ...steps('reconcile', `claude.mjs claude-stats.mjs claude-config.mjs claude-diff.mjs`),
    { file: 'reconcile/codex.mjs', args: ['--raw-only'] },
    ...steps('reconcile', `codex-segments.mjs codex-accounting.mjs codex-fallbacks.mjs codex-diff.mjs conductor-evidence.mjs conductor.mjs conductor-proof.mjs claude-conductor-crosscheck.mjs conductor-other-providers.mjs codex-conductor.mjs codex-orphans.mjs reference.mjs model-allocation.mjs settled-reference.mjs monthly.mjs history-coverage-current.mjs`),
  ],
  pricing: [
    ...steps('pricing', `snapshot-oracle.mjs claude-raw-oracle.mjs claude-price-oracle.mjs claude-iterations-oracle.mjs claude-billing-boundary-oracle.mjs codex-raw-oracle.ts`),
    { file: 'pricing/codex-prepare-adjudication.mjs', args: ['--preserve-first'] },
    { file: 'pricing/codex-raw-oracle.ts', args: ['../reference/snapshot-noindex-51ea561.json', '.lane/codex-source-explanation.json', '--source-activity'] },
    ...steps('pricing', `codex-identity.mjs codex-prepare-adjudication.mjs codex-targeted-evidence.mjs codex-adjudicate.mjs codex-impact.mjs codex-tier-schema.mjs`),
  ],
  dedup: steps('dedup', `claude-oracle.mjs claude-framing.ts summarize-claude.mjs codex-projection.ts codex-oracle.ts codex-reconcile.ts codex-findings-evidence.ts codex-inherited-tools.ts conductor-oracle.ts conductor-diff.ts conductor-exclusions.ts conductor-envelope-coverage.ts conductor-orphans.ts adapters-oracle.ts`),
  aggregation: steps('aggregation', `snapshot-oracle.mjs schema-rejection.mjs window-oracle.mjs raw-oracle.mjs raw-desktop.mjs raw-residuals.mjs raw-legacy-identity.mjs raw-reconcile.mjs raw-classify.mjs raw-partial-pricing.mjs summarize-findings.mjs`),
  repos: steps('repos', `oracle.ts summarize.ts conductor-diff.ts conductor-provider-diff.ts cursor-oracle.ts cursor-compare.ts shared-cwd-audit.ts git-inventory.ts`),
  time: steps('time', `claude-oracle.ts claude-diff.ts codex-oracle.ts codex-compare.ts codex-native-audit.ts native-codex-audit.ts native-codex-reconcile.ts codex-compare.ts codex-finalize.ts recovery-oracle.ts reference-audit.ts final-report.ts`),
  'other-providers': steps('other-providers', `cursor-sdk.ts cursor-receipts.ts cursor-native-oracle.ts adapters-oracle.ts desktop-oracle.ts desktop-audit-oracle.ts desktop-inventory.ts desktop-roots-oracle.ts`).map(step => ({ ...step, stdout: `${step.file.split('/')[1]!.replace(/\.ts$/, '')}.json` })),
};
