/** Strict current-snapshot gates over the independent lane artifacts. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
type Json = Record<string, any>;
export type OracleComparison = { area: string; unresolved: number; checks: { check: string; differences: number; unavailable?: boolean; historicalDiagnostic?: boolean }[]; liveExclusions: { check: string; sessionKey: string; rows: number }[] };
const array = (value: unknown): any[] => { if (!Array.isArray(value)) throw new Error('Required oracle result is unavailable.'); return value; };
const numeric = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Required numeric oracle result is unavailable.'); return value; };
const counter = (value: unknown): number => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Required nonnegative oracle count is unavailable.'); return value; };
const nonzero = (value: unknown): boolean => Math.abs(numeric(value)) > 1e-7;
const usageDelta = (value: unknown): boolean => { const values = array(value); if (values.length !== 5 || values.some(v => !Number.isSafeInteger(v))) throw new Error('Required usage delta is unavailable.'); return values.some(v => v !== 0); };

export async function inspectOracleResults(directory: string, areas: string[], snapshotPath?: string, changedSources: ReadonlySet<string> = new Set()): Promise<OracleComparison[]> {
  const results: OracleComparison[] = [];
  const readSnapshot = async () => {
    if (snapshotPath) return JSON.parse(await readFile(snapshotPath, 'utf8')) as Json;
    try { return JSON.parse(await readFile(join(directory, 'full.json'), 'utf8')) as Json; }
    catch { return JSON.parse(await readFile(join(directory, 'supplied.json'), 'utf8')) as Json; }
  };
  for (const area of areas) {
    const checks: OracleComparison['checks'] = [];
    const liveExclusions: OracleComparison['liveExclusions'] = [];
    const stable = (value: unknown, label: string) => array(value).filter(row => {
      const key = row.sessionKey ?? row.key;
      if (!changedSources.has(key)) return true;
      const prior = liveExclusions.find(r => r.check === label && r.sessionKey === key);
      if (prior) prior.rows++; else liveExclusions.push({ check: label, sessionKey: key, rows: 1 });
      return false;
    });
    const check = async (file: string, label: string, count: (value: Json) => number, historicalDiagnostic = false) => {
      try { const artifact = JSON.parse(await readFile(join(directory, area, '.lane', file), 'utf8')) as Json; checks.push({ check: label, differences: counter(count(artifact)), ...(historicalDiagnostic ? { historicalDiagnostic: true } : {}) }); }
      catch { checks.push({ check: label, differences: 1, unavailable: true }); }
    };
    if (area === 'claude') {
      try {
        const oracle = JSON.parse(await readFile(join(directory, area, '.lane/claude-oracle.json'), 'utf8'));
        const desktop = JSON.parse(await readFile(join(directory, 'other-providers/.lane/desktop-audit-oracle.json'), 'utf8'));
        const snapshot = await readSnapshot();
        const { compareClaude } = await import('../verify/claude/integration-compare.ts');
        const comparison = compareClaude(oracle, snapshot, desktop);
        checks.push({ check: 'native-session-token-cost-model-day', differences: stable(comparison.differences, 'native-session-token-cost-model-day').length });
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(directory, area, '.lane/claude-current-comparison.json'), JSON.stringify(comparison, null, 2));
      } catch { checks.push({ check: 'native-session-token-cost-model-day', differences: 1, unavailable: true }); }
    } else if (area === 'codex') {
      await check('codex-current.json', 'current-independent-retained-native-events', d => {
        const differences=array(d['differences']),missing=array(d['missing']),unclassified=array(d['unclassifiedDiscovery']),live=array(d['excludedLive']),summary=d['summary'];array(d['retained']);
        return stable([...differences,...missing,...unclassified], 'current-independent-retained-native-events').length+Number(counter(summary?.differences)!==differences.length)+Number(counter(summary?.missing)!==missing.length)+Number(counter(summary?.unclassifiedDiscovery)!==unclassified.length)+Number(counter(summary?.live)!==live.length)+Number(counter(summary?.eligibleIdentities)!==counter(summary?.matched)+live.length+missing.length);
      });
      await check('codex-reconciled.json', 'receipt-and-ancestry-reconciled-sessions', d => array(d['comparison']?.sessions).filter(r => usageDelta(r.delta) || nonzero(r.deltaUsd)).length, true);
      await check('codex-receipt-reconciliation-check.json', 'receipt-multiplicity', d => { array(d['unmatched']); return counter(d['receipts']) === counter(d['exactMatches']) + counter(d['acrossTurnMatches']) + counter(d['unmatchedAfterFallback']) ? 0 : 1; });
    } else if (area === 'conductor') {
      await check('conductor-current.json', 'independent-message-receipt-model-day-arithmetic', d => stable(d['differences'], 'independent-message-receipt-model-day-arithmetic').length);
      await check('conductor-current.json', 'positive-raw-recovery-discovery-coverage', d => stable(array(d['unmatched']).filter(r=>counter(r.positiveUsageBlocks)>0||counter(r.positiveReceipts)>0), 'positive-raw-recovery-discovery-coverage').length);
    } else if (area === 'reconcile') {
      await check('history-coverage-current.json', 'raw-statistics-denominator-overlap-and-estimates', d => array(d['differences']).length);
      await check('../../conductor/.lane/conductor-current.json', 'independent-recovered-allocation', d => stable(d['differences'], 'independent-recovered-allocation').length);
      await check('reference-aggregates.json', 'provider-repository-model-conservation', d => array(d['checks']).filter(c => c.pass !== true).length);
      await check('model-rollup-gaps.json', 'model-allocation-conservation', d => array(d['sessions']).length);
      await check('quota-diff.json', 'desktop-quota-raw-latest-and-timeline', d => array(d['desktop']).filter(w => counter(w.timelineMismatches) !== 0 || w.latestMatches !== true).length);
    } else if (area === 'pricing') {
      try {
        const {verifyPricingProvenance}=await import('./verify-real-evidence.ts');
        let differences=0;for(const phase of ['full','cold','warm']){let value:Json;try{value=JSON.parse(await readFile(join(directory,`${phase}.json`),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}differences+=(await verifyPricingProvenance(value,join(directory,'pricing-evidence'))).length;}
        differences+=(await verifyPricingProvenance(await readSnapshot(),join(directory,'pricing-evidence'))).length;
        checks.push({check:'independent-copied-pricing-source-provenance',differences});
      } catch { checks.push({check:'independent-copied-pricing-source-provenance',differences:1,unavailable:true}); }

      await check('pricing-snapshot-oracle.json', 'scalar-price-and-coverage', d => array(d['mismatches']).length);
      try {
        const pricing=JSON.parse(await readFile(join(directory,area,'.lane/pricing-snapshot-oracle.json'),'utf8')) as Json;
        const codex=JSON.parse(await readFile(join(directory,'codex/.lane/codex-current.json'),'utf8')) as Json;
        const snapshot = await readSnapshot();
        const differences:Json[]=[],excluded:Json[]=[],checked:Json[]=[];
        for(const row of array(pricing['rawRequestPricingRequired'])){
          if (!stable([row], 'context-and-historical-tariff-raw-request-pricing').length) { excluded.push({sessionKey:row.sessionKey,model:row.model,reason:'source-generation-changed-during-verification'}); continue; }
          const live=array(codex['excludedLive']).find(r=>r.key===row.sessionKey);if(live){excluded.push({sessionKey:row.sessionKey,model:row.model,reason:'exact-raw-session-active-after-snapshot',snapshot:live.snapshot});continue;}
          const events=array(codex['retained']).filter(e=>e.key===row.sessionKey&&e.model===row.model&&!e.live);
          const session=array(snapshot.sessions).find(s=>s.sessionKey===row.sessionKey),model=session?.models?.find((m:Json)=>m.model===row.model);
          if(!events.length||!model){differences.push({sessionKey:row.sessionKey,model:row.model,field:'raw-pricing-coverage'});continue;}
          for(const field of ['inputUsd','cachedInputUsd','cacheWriteUsd','outputUsd','totalUsd','upperEstimateUsd']){const expected=events.reduce((n,e)=>n+numeric(e.cost?.[field]),0),actual=numeric(model[field]);if(Math.abs(expected-actual)>1e-7)differences.push({sessionKey:row.sessionKey,model:row.model,field,actual,expected});}
          checked.push({sessionKey:row.sessionKey,model:row.model,requests:events.length});
        }
        const {writeFile}=await import('node:fs/promises');await writeFile(join(directory,area,'.lane/raw-request-pricing-joined.json'),JSON.stringify({checked,excluded,differences},null,2));
        checks.push({check:'context-and-historical-tariff-raw-request-pricing',differences:differences.length});
      } catch {checks.push({check:'context-and-historical-tariff-raw-request-pricing',differences:1,unavailable:true});}
    } else if (area === 'dedup') {
      try {
        const read=async(a:string,f:string)=>JSON.parse(await readFile(join(directory,a,'.lane',f),'utf8'));
        const {compareDesktopDedup}=await import('../verify/shared/desktop-scope.ts');
        const legacy=await read('dedup','claude-summary.json'),desktop=await read('other-providers','desktop-audit-oracle.json');
        stable([...array(legacy.tokenMismatches),...array(desktop.intervals)], 'claude-identity-token-ownership-with-proven-desktop-receipts');
        const result=compareDesktopDedup(legacy,desktop,changedSources);
        const {writeFile}=await import('node:fs/promises');await writeFile(join(directory,area,'.lane/claude-current-dedup.json'),JSON.stringify(result,null,2));
        checks.push({check:'claude-identity-token-ownership-with-proven-desktop-receipts',differences:result.differences.length});
      }catch{checks.push({check:'claude-identity-token-ownership-with-proven-desktop-receipts',differences:1,unavailable:true});}
      await check('claude-summary.json', 'historical-native-only-claude-ownership', d => array(d['tokenMismatches']).length, true);
      await check('../../claude/.lane/claude-current-comparison.json','current-native-and-desktop-identity-coverage',d=>stable(d['differences'], 'current-native-and-desktop-identity-coverage').length);
      await check('../../codex/.lane/codex-current.json','current-codex-retained-request-ownership',d=>stable([...array(d['differences']),...array(d['missing'])], 'current-codex-retained-request-ownership').length);
      await check('conductor-oracle.json', 'registered-provider-identity-uniqueness-and-continuity', d => {
        const rows = array(d['registrations']), counts = new Map<string, number>();
        for (const r of rows) if (r.hasProviderId) counts.set(r.providerKey, (counts.get(r.providerKey) ?? 0) + 1);
        return stable(rows.filter(r => !r.live && r.hasProviderId && (
          r.registeredPresent && r.discoveredPresent ||
          r.hasCanonical && !r.registeredPresent && !r.discoveredPresent ||
          counts.get(r.providerKey) === 1 && r.discoveredPresent && !r.registeredPresent)), 'registered-provider-identity-uniqueness-and-continuity').length;
      });
      await check('../../conductor/.lane/conductor-current.json', 'recovered-message-and-receipt-deduplication', d => stable(d['differences'], 'recovered-message-and-receipt-deduplication').length);
    } else if (area === 'aggregation') {
      await check('snapshot-oracle-results.json', 'session-repository-machine-reconciliation', d => array(d['mismatches']).length);
      await check('schema-rejection-results.json', 'public-schema', d => array(d['failures']).length);
    } else if (area === 'repos') {
      await check('repos-oracle.json', 'raw-repository-ownership', d => {
        const mismatches = array(d['rows']).filter(r => !r.active && !r.matches);
        return Number(counter(d['mismatches']?.sessions) !== mismatches.length) + stable([...mismatches, ...array(d['missing'])], 'raw-repository-ownership').length;
      });
    } else if (area === 'time') {
      try {
        const read=async(a:string,f:string)=>JSON.parse(await readFile(join(directory,a,'.lane',f),'utf8'));
        const {compareTimeScopes}=await import('../verify/shared/desktop-scope.ts');
        const audit=await read('time','time-reference-audit.json'),native=await read('claude','claude-oracle.json'),desktop=await read('other-providers','desktop-audit-oracle.json');
        stable([...array(native.sessions),...array(audit.parityErrors),...array(audit.discrepancies),...array(desktop.intervals)], 'native-request-scope-and-complete-event-conservation');
        const result=compareTimeScopes(audit,native,desktop,await readSnapshot(),changedSources);
        const {writeFile}=await import('node:fs/promises');await writeFile(join(directory,area,'.lane/time-current-scope.json'),JSON.stringify(result,null,2));
        checks.push({check:'native-request-scope-and-complete-event-conservation',differences:result.differences.length});
      }catch{checks.push({check:'native-request-scope-and-complete-event-conservation',differences:1,unavailable:true});}
      await check('../../claude/.lane/claude-current-comparison.json','independent-claude-utc-and-local-hour-events',d=>stable(d['differences'], 'independent-claude-utc-and-local-hour-events').length);
      await check('../../codex/.lane/codex-current.json','independent-codex-utc-and-local-hour-events',d=>stable([...array(d['differences']),...array(d['missing'])], 'independent-codex-utc-and-local-hour-events').length);
      await check('../../conductor/.lane/conductor-current.json','independent-recovered-utc-and-local-hour-events',d=>stable(d['differences'], 'independent-recovered-utc-and-local-hour-events').length);
      await check('../../other-providers/.lane/cursor-sdk.json','independent-cursor-summary-time-absence',d=>array(d['differences']?.timeFields).length);
      await check('../../other-providers/.lane/cursor-native-oracle.json','independent-cursor-transcript-time-absence',d=>array(d['comparison']?.timeFields).length);
      await check('time-final-report.json', 'historical-native-event-day-attribution', d => {const differences=array(d['differences']);for(const row of differences){numeric(row.valueUsd);numeric(row.inputTokens);numeric(row.outputTokens);for(const day of array(row.dayDifferences))numeric(day.valueUsd);}return differences.length;}, true);
    } else if (area === 'other-providers') {
      await check('cursor-sdk.json', 'cursor-sdk-counters-identities-repositories', d => {
        const r = d['differences']; return array(r?.modelFields).length + array(r?.referenceOnlySdk).length + array(r?.timeFields).length + ['repositorySessions', 'tokenSessions', 'toolSessions', 'turnSessions', 'keySessions', 'missingSessions', 'registeredRepositorySessions', 'unpricedEvidenceSessions'].reduce((n, k) => n + counter(r?.[k]), 0);
      });
      await check('cursor-native-oracle.json', 'cursor-native-activity-and-hierarchy', d => array(d['comparison']?.diffs).length + array(d['comparison']?.composerDiffs).length + array(d['comparison']?.timeFields).length + array(d['comparison']?.hierarchy).filter(r => r.expectedExecutionKind !== r.actualExecutionKind).length);
      await check('adapters-oracle.json', 'optional-provider-history-absence-confirmed', d => {
        const providers = array(d['providers']);
        if (providers.length !== 3 || [...new Set(providers.map(p => p.provider))].sort().join(',') !== 'copilot,gemini,opencode') {
          throw new Error('Required provider census is unavailable.');
        }
        return Number(d['status'] !== 'verified-empty-population') +
          providers.filter(p => counter(p.historyFiles) > 0 || counter(p.referenceSessions) > 0).length;
      });
      try {
        const native = JSON.parse(await readFile(join(directory, area, '.lane/desktop-oracle.json'), 'utf8')) as Json;
        const audit = JSON.parse(await readFile(join(directory, area, '.lane/desktop-audit-oracle.json'), 'utf8')) as Json;
        let differences = 0;
        for (const s of array(native['sessions'])) {
          if (s.liveAfterReference || !stable([s], 'desktop-native-plus-proven-receipt-supplement').length) continue;
          const supplemental = array(audit['intervals']).filter(r => r.sessionKey === s.sessionKey && !r.liveAfterReference);
          const expected = { ...s.tokens }; let usd = Number(s.listEstimateUsd);
          for (const interval of supplemental) {
            if (!interval.preResumeCarryoverVersion || interval.overlappingNativeMessages || interval.missingNativeMessages) { differences++; continue; }
            for (const m of array(interval.models)) {
              if (!m.inputsMatch || m.missingApiEquivalentUsd === null) { differences++; continue; }
              expected.inputTokens += m.delta.input + m.delta.read + m.delta.write;
              expected.uncachedInputTokens += m.delta.input; expected.cachedInputTokens += m.delta.read;
              expected.cacheWriteInputTokens += m.delta.write; expected.outputTokens += m.delta.output;
              usd += m.missingApiEquivalentUsd;
            }
          }
          if (!s.referencePresent) differences++;
          for (const [field, value] of Object.entries(expected)) if (s.referenceTokens?.[field] !== value) differences++;
          if (!Number.isFinite(usd) || Math.abs(numeric(s.referenceCost?.totalUsd) - usd) > 1e-7) differences++;
        }
        checks.push({ check: 'desktop-native-plus-proven-receipt-supplement', differences });
      } catch { checks.push({ check: 'desktop-native-plus-proven-receipt-supplement', differences: 1, unavailable: true }); }
    }
    results.push({ area, unresolved: checks.reduce((n, c) => n + (c.historicalDiagnostic && !c.unavailable ? 0 : c.differences), 0), checks, liveExclusions });
  }
  return results;
}
