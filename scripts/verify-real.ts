#!/usr/bin/env node
/** Content-free, read-only real-machine release verification. No external dependencies. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AnalysisHeapLimitError, analyzeMachineSessionsIsolated } from '../src/analysis-process.ts';
import { indexStatus } from '../src/store/database.ts';
import { indexParityWarning } from '../src/public/evidence.js';
import type { AnalyzeOptions, MachineAnalytics } from '../src/types.ts';
import { captureInventoryEvidence, scopeInventoryEvidence, verifyPhaseInventory, type InventoryCapture } from './verify-real-inventory-evidence.ts';
import { proveDeferralWarning } from './verify-real-warnings.ts';
import { proveLiveLimits } from './verify-real-live-limits.ts';
import { proveLiveWorkflow } from './verify-real-live-workflow.ts';
import { proveLiveAggregates } from './verify-real-live.ts';
import { changedEvidence } from './parity-evidence.ts';
import { captureSourceGeneration, changedSourceSessions, readSourceGenerations, type SourceGeneration } from './verify-real-source-changes.ts';
import { captureContextInputs, proveContextCurves, readContextInputs } from './verify-real-context.ts';
import { calibrationSummary, proveCalibration, sameCalibration } from './verify-real-calibration.ts';
import { NO_REPOSITORY_NAME } from '../verify/repos/git-oracle.ts';
import { oraclePipelines, type OracleStep } from './verify-real-manifest.ts';
import { resetOracleArtifacts, copyPricingEvidence, requireUnchangedProduction, validateOracleExecution, verifyPricingProvenance } from './verify-real-evidence.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
type Json = Record<string, any>;
const json = async (file: string): Promise<Json> => JSON.parse(await readFile(file, 'utf8')) as Json;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7 + Math.max(Math.abs(a), Math.abs(b)) * 1e-12;

export async function productionFingerprint(): Promise<string> {
  const digest=createHash('sha256');
  const walk=async(relative:string):Promise<void>=>{for(const entry of (await readdir(join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(relative,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()){digest.update(file);digest.update(await readFile(join(root,file)));}}};
  for(const directory of ['src','data','schemas'])await walk(directory);
  digest.update(await readFile(join(root,'package.json')));
  return digest.digest('hex');
}

/** Names are never retained in audit snapshots. Known bucket labels preserve oracle routing. */
export function privateAuditSnapshot(snapshot: MachineAnalytics): MachineAnalytics {
  // The two fixed bucket labels carry no private value and drive oracle routing.
  const labels = new Map(snapshot.repositories.map(r => [r.repository.id,
    r.repository.name === 'Ephemeral automation sessions' || r.repository.name === NO_REPOSITORY_NAME ? r.repository.name :
      `repository-${hash(r.repository.id)}`]));
  for (const r of snapshot.repositories) r.repository.name = labels.get(r.repository.id)!;
  for (const s of snapshot.sessions) s.repositoryName = labels.get(s.repositoryId) ?? `repository-${hash(s.repositoryId)}`;
  return snapshot;
}

/** Compare every session field, preserving exact counters; only USD has rounding tolerance. */
export function strictFields(a: unknown, b: unknown, path = '', differences: Set<string> = new Set()): string[] {
  if (a === b) return [...differences];
  if (typeof a === 'number' && typeof b === 'number' && /(?:Usd|USD)(?:\.|$)/.test(path) && close(a, b)) return [...differences];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aa = a as Json, bb = b as Json;
    for (const key of new Set([...Object.keys(aa), ...Object.keys(bb)])) {
      // Dynamic keys are represented by a wildcard; no names or private values in diagnostics.
      const safe = /^\d+$/.test(key) || /^[a-f0-9]{12,64}$/.test(key) || key.includes('/') ? '*' : key;
      strictFields(aa[key], bb[key], path ? `${path}.${safe}` : safe, differences);
    }
  } else differences.add(path);
  return [...differences].sort();
}
export function compareStableSnapshots(a: MachineAnalytics, b: MachineAnalytics, excluded: Set<string>, provedCurves: ReadonlySet<string> = new Set()) {
  const aa = new Map(a.sessions.map(s => [s.sessionKey, s])), bb = new Map(b.sessions.map(s => [s.sessionKey, s]));
  return [...new Set([...aa.keys(), ...bb.keys()])].sort().filter(key => !excluded.has(key)).flatMap(sessionKey => {
    const fields = strictFields(aa.get(sessionKey), bb.get(sessionKey)).filter(field =>
      !provedCurves.has(sessionKey) || !/^limitsCache\.context\.(?:curve(?:\.|$)|curveSampled$)/.test(field));
    if (a.sessions.filter(s => s.sessionKey === sessionKey).length !== 1 || b.sessions.filter(s => s.sessionKey === sessionKey).length !== 1) fields.push('sessionKey.multiplicity');
    return fields.length ? [{ sessionKey, fields }] : [];
  });
}

/** Report all aggregate, schema and metadata changes; live sessions never waive these. */
export function compareSnapshotAggregates(a: MachineAnalytics, b: MachineAnalytics): string[] {
  const card = (rateCard: Json | undefined) => {
    if (!rateCard?.['pricing']) return rateCard;
    const { ageDays: _age, ...pricing } = rateCard['pricing'];
    return { ...rateCard, pricing: { ...pricing, sources: pricing.sources.map((source: Json) => {
      const { ageDays: _sourceAge, ...rest } = source; return rest;
    }) } };
  };
  const project = (snapshot: MachineAnalytics) => {
    const { generatedAt: _generatedAt, sessions: _sessions, ...aggregate } = snapshot;
    return { ...aggregate, rateCard: card(aggregate.rateCard), repositories: aggregate.repositories.map(repository => {
      const { generatedAt: _repositoryGeneratedAt, ...row } = repository as unknown as Json;
      if (row['rateCard']) row['rateCard'] = card(row['rateCard']);
      return row;
    }) };
  };
  return strictFields(project(a), project(b));
}

/** Elapsed ages use a scan clock. Independently verify their defining timestamps. */
export function verifyPricingAges(snapshot: MachineAnalytics, startedAt: number, finishedAt: number): string[] {
  const failures = new Set<string>();
  for (const [index, card] of [snapshot.rateCard, ...snapshot.repositories.map(r => (r as unknown as Json)['rateCard']).filter(Boolean)].entries()) {
    const pricing = card?.pricing; if (!pricing) { failures.add('pricing.unavailable'); continue; }
    const sources = pricing.sources; if (!Array.isArray(sources) || !Number.isFinite(pricing.refreshAfterDays)) { failures.add('pricing.shape'); continue; }
    const clocks: number[] = [];
    for (const source of [...sources, { fetchedAt: pricing.newestSnapshotAt, ageDays: pricing.ageDays }]) {
      if (source.fetchedAt === null) { if (source.ageDays !== null) failures.add('pricing.ageWithoutTimestamp'); continue; }
      const fetched = Date.parse(source.fetchedAt), age = source.ageDays;
      if (!Number.isFinite(fetched) || !Number.isFinite(age) || age < 0) { failures.add('pricing.invalidAge'); continue; }
      const clock = fetched + age * 86_400_000;
      if (age !== 0 && (clock < startedAt - 1 || clock > finishedAt + 1)) failures.add('pricing.ageOutsideScan');
      if (age === 0 && fetched < startedAt - 1) failures.add('pricing.zeroAgeForPastTimestamp');
      if (age !== 0) clocks.push(clock);
      if ('stale' in source && source.stale !== (age > pricing.refreshAfterDays)) failures.add('pricing.sourceStaleness');
    }
    if (clocks.length && Math.max(...clocks) - Math.min(...clocks) > 1) failures.add('pricing.inconsistentClocks');
    if (pricing.stale !== (pricing.policy !== 'reviewed-only' && sources.some((s: Json) => s.stale))) failures.add('pricing.staleness');
    if (index > 0 && strictFields(card.pricing, snapshot.rateCard.pricing).length) failures.add('pricing.repositoryMismatch');
  }
  return [...failures];
}

async function verifyPhaseAggregates(directory: string, phase: string, snapshotPath: string, cutoff: string) {
  const workspace = join(directory, `phase-${phase}`); await resetOracleArtifacts(workspace);
  const commands = [];
  for (const file of ['aggregation/snapshot-oracle.mjs', 'aggregation/schema-rejection.mjs']) commands.push(await runStep({ file }, workspace, snapshotPath, cutoff));
  commands.push(await runStep({ file: 'conductor/current-oracle.mjs', args: ['--calibration'] }, workspace, snapshotPath, cutoff));
  const checks: { check: string; differences: number; unavailable?: boolean }[] = [];
  for (const [file, field] of [['snapshot-oracle-results.json', 'mismatches'], ['schema-rejection-results.json', 'failures']] as const) {
    try {
      const artifact = await json(join(workspace, '.lane', file));
      if (!Array.isArray(artifact[field])) throw new Error('Missing oracle result.');
      checks.push({ check: file, differences: artifact[field].length });
    } catch { checks.push({ check: file, differences: 1, unavailable: true }); }
  }
  try {
    const snapshot = await json(snapshotPath), pairs = await json(join(workspace, '.lane/calibration-pairs.json'));
    if (pairs['generatedAt'] !== snapshot['generatedAt'] || !Array.isArray(pairs['pairs'])) throw new Error('Calibration evidence unavailable.');
    checks.push({ check: 'independent-recovery-calibration', differences: Number(!sameCalibration(snapshot['historyCoverage']?.recoveryCalibration, calibrationSummary(snapshot, pairs['pairs']))) });
  } catch { checks.push({ check: 'independent-recovery-calibration', differences: 1, unavailable: true }); }
  return { commands, checks, failed: commands.some(c => c.exitCode !== 0) || checks.some(c => c.differences > 0) };
}

async function normalizeLiveCalibration(directory: string, phase: string, before: Json, after: Json, left: Json, right: Json, changed: Set<string>) {
  let a: Json, b: Json;
  try {
    a = await json(join(directory, 'phase-full/.lane/calibration-pairs.json'));
    b = await json(join(directory, `phase-${phase}/.lane/calibration-pairs.json`));
  } catch { return null; } // Phase checks already fail closed on missing evidence.
  const proof = proveCalibration(before, after, a['pairs'], b['pairs'], changed);
  if (proof) {
    left['historyCoverage'] = { ...left['historyCoverage'], recoveryCalibration: proof.stable };
    right['historyCoverage'] = { ...right['historyCoverage'], recoveryCalibration: proof.stable };
  }
  return proof;
}

export function monthly(snapshot: MachineAnalytics) {
  const groups = new Map<string, { month: string; provider: string; sessions: number; datedUsd: number; creationUsd: number; recoveredUsd: number; undatedUsd: number; inputTokens: number; outputTokens: number }>();
  const cell = (month: string, provider: string) => { const key = `${month}:${provider}`; let row = groups.get(key); if (!row) { row = { month, provider, sessions: 0, datedUsd: 0, creationUsd: 0, recoveredUsd: 0, undatedUsd: 0, inputTokens: 0, outputTokens: 0 }; groups.set(key, row); } return row; };
  for (const s of snapshot.sessions) {
    const date = new Date(s.createdAt), evidence = (s as unknown as Json)['evidence'];
    const cohort = s.transcript?.startTimeKnown === false || evidence?.timing === 'file-mtime' || !Number.isFinite(+date) ? 'undated' : date.toISOString().slice(0, 7);
    const row = cell(cohort, s.provider); row.sessions++; row.creationUsd += s.cost.totalUsd;
    row.inputTokens += s.tokens.inputTokens; row.outputTokens += s.tokens.outputTokens;
    const dated = Object.values(s.spendByDay).reduce((n, v) => n + v, 0); row.undatedUsd += s.cost.totalUsd - dated;
    if (evidence?.source?.startsWith('conductor')) row.recoveredUsd += s.cost.totalUsd;
    for (const [day, value] of Object.entries(s.spendByDay)) cell(day.slice(0, 7), s.provider).datedUsd += value;
  }
  return [...groups.values()].sort((a, b) => a.month.localeCompare(b.month) || a.provider.localeCompare(b.provider));
}

export async function runStep(step: OracleStep, workspace: string, snapshot: string, cutoff: string): Promise<{ file: string; exitCode: number; milliseconds: number }> {
  const start = performance.now();
  const result = await new Promise<{ code: number; stdout: string }>(resolveChild => {
    const child = spawn(process.execPath, ['--max-old-space-size=2048', '--import', join(root, 'scripts/verify-reference.mjs'), join(root, 'verify', step.file), ...(step.args ?? [])], {
      cwd: workspace, env: { ...process.env, SESSION_ANALYTICS_VERIFY_REFERENCE: snapshot, CODEX_ORACLE_REFERENCE: snapshot, CONDUCTOR_REFERENCE: snapshot, ORACLE_CUTOFF: cutoff, NODE_NO_WARNINGS: '1', CLAUDE_ORACLE_PRICING_DIR: process.env['SESSION_ANALYTICS_VERIFY_PRICING_DIR'] ?? process.env['CLAUDE_ORACLE_PRICING_DIR'], PRICING_ORACLE_CACHE_DIR: process.env['SESSION_ANALYTICS_VERIFY_PRICING_DIR'] ?? process.env['PRICING_ORACLE_CACHE_DIR'] }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    // Never forward local errors (which can contain source paths or transcript fragments).
    child.stderr.resume(); child.once('error', () => resolveChild({ code: 2, stdout: '' }));
    child.once('close', code => resolveChild({ code: code ?? 2, stdout }));
  });
  if (step.stdout && result.code === 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { return { file: step.file, exitCode: 2, milliseconds: Math.round(performance.now() - start) }; }
    await writeFile(join(workspace, '.lane', step.stdout), JSON.stringify(parsed) + '\n', { mode: 0o600 });
  }
  return { file: step.file, exitCode: result.code, milliseconds: Math.round(performance.now() - start) };
}

async function writeMonthly(before: MachineAnalytics, after: MachineAnalytics, destination: string, desktop?: Json) {
  const previous = new Map(monthly(before).map(r => [`${r.month}:${r.provider}`, r])), current = new Map(monthly(after).map(r => [`${r.month}:${r.provider}`, r]));
  const lines = ['# Corrected monthly accounting', '', `Reference: ${before.generatedAt}. Current: ${after.generatedAt}.`, '', 'USD values are API-equivalent or provider-reported estimates, not invoices. Creation cohorts and UTC activity months have different denominators. Recovered Conductor value is a subset of creation value; undated value is not assigned an event month. Token columns use creation cohorts; input includes cached and cache-write tokens. Before/current differences include live-history growth during validation.', '', '| Month | Provider | Before dated $ | Current dated $ | Before creation $ | Current creation $ | Recovered Conductor $ | Undated $ | Sessions | Input tokens | Output tokens |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const key of [...new Set([...previous.keys(), ...current.keys()])].sort()) { const a = previous.get(key), b = current.get(key), r = b ?? a!; lines.push(`| ${r.month} | ${r.provider} | ${(a?.datedUsd ?? 0).toFixed(6)} | ${(b?.datedUsd ?? 0).toFixed(6)} | ${(a?.creationUsd ?? 0).toFixed(6)} | ${(b?.creationUsd ?? 0).toFixed(6)} | ${(b?.recoveredUsd ?? 0).toFixed(6)} | ${(Math.abs(b?.undatedUsd ?? 0) < 0.0000005 ? 0 : b?.undatedUsd ?? 0).toFixed(6)} | ${b?.sessions ?? 0} | ${b?.inputTokens ?? 0} | ${b?.outputTokens ?? 0} |`); }
  lines.push('', '## Unattributed statistics estimates', '', 'These counters come from retained provider statistics and are excluded from dated and creation-cohort session value above. Possible overlap is a separate coverage signal.', '', '| Month | Before estimate $ | Current estimate $ | Unattributed tokens | Priced unattributed tokens | Possible overlap tokens |', '|---|---:|---:|---:|---:|---:|');
  const oldCoverage = new Map((before.historyCoverage?.months ?? []).map(r => [r.month, r]));
  const newCoverage = new Map((after.historyCoverage?.months ?? []).map(r => [r.month, r]));
  for (const month of [...new Set([...oldCoverage.keys(), ...newCoverage.keys()])].sort()) { const a = oldCoverage.get(month), b = newCoverage.get(month); lines.push(`| ${month} | ${(a?.unattributedEstimateUsd ?? 0).toFixed(6)} | ${(b?.unattributedEstimateUsd ?? 0).toFixed(6)} | ${b?.unattributedTokens ?? 0} | ${b?.pricedUnattributedTokens ?? 0} | ${b?.possibleOverlapTokens ?? 0} |`); }
  lines.push('', '## Value bases', '', '| Provider | API-equivalent $ | Provider-reported $ |', '|---|---:|---:|');
  for (const provider of [...new Set(after.sessions.map(s => s.provider))].sort()) { const rows = after.sessions.filter(s => s.provider === provider); lines.push(`| ${provider} | ${rows.filter(s => s.costBasis === 'api-list-price-equivalent').reduce((n,s)=>n+s.cost.totalUsd,0).toFixed(6)} | ${rows.filter(s => s.costBasis === 'provider-reported').reduce((n,s)=>n+s.cost.totalUsd,0).toFixed(6)} |`); }
  if (desktop) {
    const {desktopScopes}=await import('../verify/shared/desktop-scope.ts');desktopScopes(desktop);
    const supplements=new Map<string,{tokens:number;usd:number}>();
    for(const interval of desktop['intervals'])if(!interval.liveAfterReference)for(const model of interval.models){const month=new Date(interval.endedAt).toISOString().slice(0,7),row=supplements.get(month)??{tokens:0,usd:0};row.tokens+=model.missingTokens;row.usd+=model.missingApiEquivalentUsd;supplements.set(month,row);}
    lines.push('', '## Native Desktop receipt supplements', '', 'These independently proved receipt-only amounts are already included in session value above. They are separate from recovered Conductor value and add no native request count or per-request context size.', '', '| UTC month | Supplemental tokens | API-equivalent $ |', '|---|---:|---:|');
    for(const [month,row]of [...supplements].sort(([a],[b])=>a.localeCompare(b)))if(row.tokens||row.usd)lines.push(`| ${month} | ${row.tokens} | ${row.usd.toFixed(6)} |`);
  }
  await writeFile(destination, lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2), value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const recheck=args.includes('--recheck');
  if (recheck && value('--snapshot')) throw new Error('Recheck cannot select a different snapshot.');
  const requested = value('--areas')?.split(',') ?? Object.keys(oraclePipelines);
  if (requested.some(area => !oraclePipelines[area])) throw new Error('Unknown oracle area.');
  const directory = resolve(value('--output') ?? join(root, '.lane/verify-real'));
  await mkdir(directory, { recursive: true });
  const lock = '/tmp/session-analytics-realscan.lock'; let locked = false;
  process.stderr.write('Real verification: waiting for the shared scan lock.\n');
  while (!locked) { try { await mkdir(lock); locked = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await setTimeout(5000); } }
  let dataDir: string | undefined;
  const previousDataDir = process.env['SESSION_ANALYTICS_DATA_DIR'];
  const previousPricingDir = process.env['SESSION_ANALYTICS_VERIFY_PRICING_DIR'];
  try {
    const sourceFingerprint = await productionFingerprint();
    if (!recheck) {
      await writeFile(join(directory, 'source-fingerprint.json'), JSON.stringify({ sha256: sourceFingerprint, recordedAt: new Date().toISOString() }));
      const pricingEvidence = join(directory, 'pricing-evidence');
      await copyPricingEvidence(previousPricingDir ?? join(previousDataDir ?? join(homedir(), 'Library/Application Support/session-analytics'), 'pricing'), pricingEvidence);
      process.env['SESSION_ANALYTICS_VERIFY_PRICING_DIR'] = pricingEvidence;
      dataDir = await mkdtemp(join(directory, 'data-'));
      await cp(pricingEvidence, join(dataDir, 'pricing'), { recursive: true });
      process.env['SESSION_ANALYTICS_DATA_DIR'] = dataDir;
    }
    let snapshotPath = value('--snapshot') ? resolve(value('--snapshot')!) : join(directory, 'full.json');
    let snapshot: MachineAnalytics;
    const phases: Json[] = [];
    const sourceGenerations: SourceGeneration[] = [];
    let existingExecution: Json[] | undefined;
    if(recheck){
      process.env['SESSION_ANALYTICS_VERIFY_PRICING_DIR'] = join(directory, 'pricing-evidence');
      const provenance=await json(join(directory,'source-fingerprint.json'));
      requireUnchangedProduction(provenance['sha256'], sourceFingerprint);
      const existing=await json(join(directory,'execution.json'));existingExecution=existing['areas'];
      if(!Array.isArray(existingExecution)||!Array.isArray(existing['phases'])||existing['phases'].length!==3)throw new Error('Complete scan evidence unavailable.');
      snapshot=await json(join(directory,'full.json')) as MachineAnalytics;
      const fullInventory=[await json(join(directory,'inventory-full-before.json')),await json(join(directory,'inventory-full-after.json'))] as unknown as [InventoryCapture,InventoryCapture];
      for(const phase of ['full','cold','warm']){
        const previous=existing['phases'].find((p:Json)=>p['phase']===phase);
        if(!previous||!Array.isArray(previous['changedEvidenceSessions'])||!Array.isArray(previous['pricingAgeFailures']))throw new Error('Scan evidence unavailable.');
        const current=await json(join(directory,`${phase}.json`)) as MachineAnalytics;
        const contextCurveProof = proveContextCurves(snapshot, current, new Set(previous['changedEvidenceSessions']), await readContextInputs(directory, phase));
        const phaseInventory=[await json(join(directory,`inventory-${phase}-before.json`)),await json(join(directory,`inventory-${phase}-after.json`))] as unknown as [InventoryCapture,InventoryCapture];
        const inventoryVerification=verifyPhaseInventory(current,...phaseInventory);
        const aggregateVerification=await verifyPhaseAggregates(directory,phase,join(directory,`${phase}.json`),current.generatedAt);
        const liveProof=proveLiveAggregates(snapshot,current,new Set(previous['changedEvidenceSessions']));
        const workflowProof=proveLiveWorkflow(liveProof.left,liveProof.right,new Set(previous['changedEvidenceSessions']),{before:[scopeInventoryEvidence(snapshot,fullInventory[0]).census,scopeInventoryEvidence(snapshot,fullInventory[1]).census],after:[scopeInventoryEvidence(current,phaseInventory[0]).census,scopeInventoryEvidence(current,phaseInventory[1]).census]});
        const limitsProof=proveLiveLimits(workflowProof.left,workflowProof.right,new Set(previous['changedEvidenceSessions']));
        const warningProof=proveDeferralWarning(limitsProof.right,previous['index'],new Set(previous['changedEvidenceSessions']));
        const calibrationProof = await normalizeLiveCalibration(directory, phase, snapshot, current, limitsProof.left, warningProof.snapshot, new Set(previous['changedEvidenceSessions']));
        const pricingProvenanceFailures=await verifyPricingProvenance(current,join(directory,'pricing-evidence'));
        const result={...previous,contextCurveProof,aggregateVerification,pricingProvenanceFailures,inventoryVerification,differences:phase==='full'?[]:compareStableSnapshots(snapshot,current,new Set(previous['changedEvidenceSessions']),new Set(contextCurveProof.map(r=>r.sessionKey))),aggregateDifferences:phase==='full'?[]:compareSnapshotAggregates(limitsProof.left as MachineAnalytics,warningProof.snapshot as MachineAnalytics),limitsAggregateProof:limitsProof.accepted,limitsAggregateFailures:limitsProof.failures,workflowAggregateProof:workflowProof.accepted,workflowAggregateFailures:workflowProof.failures,warningProof:warningProof.accepted,warningFailures:warningProof.failures,liveAggregateProof:liveProof.accepted,liveAggregateFailures:liveProof.failures};
        Object.assign(result, { calibrationProof }); phases.push(result);output(result);
      }
    }
    else if (value('--snapshot')) snapshot = await json(snapshotPath) as MachineAnalytics;
    else {
      const options: AnalyzeOptions = { dataDir, offline: true, includeHidden: true };
      let full: MachineAnalytics | undefined; let initialGenerations: Map<string, string>[] = []; let fullInventory:[InventoryCapture,InventoryCapture] | undefined;
      for (const phase of ['full', 'cold', 'warm'] as const) {
        process.stderr.write(`Real verification: ${phase} analyzer scan.\n`);
        const sourceBefore = await captureSourceGeneration(directory, `${phase}-before`, options);
        sourceGenerations.push(sourceBefore);
        const before = new Map(sourceBefore.sessions);
        const inventoryBefore=await captureInventoryEvidence();
        await writeFile(join(directory,`inventory-${phase}-before.json`),JSON.stringify(inventoryBefore),{mode:0o600});
        const startedAt = Date.now(), start = performance.now();
        const current = privateAuditSnapshot(await analyzeMachineSessionsIsolated({ ...options, noIndex: phase === 'full' }));
        const pricingAgeFailures = verifyPricingAges(current, startedAt, Date.now());
        const inventoryAfter=await captureInventoryEvidence();
        await writeFile(join(directory,`inventory-${phase}-after.json`),JSON.stringify(inventoryAfter),{mode:0o600});
        const inventoryVerification=verifyPhaseInventory(current,inventoryBefore,inventoryAfter);
        const sourceAfter = await captureSourceGeneration(directory, `${phase}-after`, options);
        sourceGenerations.push(sourceAfter);
        const after = new Map(sourceAfter.sessions);
        if (!full) { full = current; initialGenerations = [before, after]; fullInventory=[inventoryBefore,inventoryAfter]; }
        const changed = changedEvidence(...initialGenerations, before, after);
        const contextInputs = phase === 'full' ? undefined : await captureContextInputs(directory, phase, dataDir!);
        const contextCurveProof = proveContextCurves(full, current, changed, contextInputs);
        // Changed evidence is accepted only for those explicit hashed sessions, never a broad tolerance.
        const differences = phase === 'full' ? [] : compareStableSnapshots(full, current, changed, new Set(contextCurveProof.map(r=>r.sessionKey)));
        const index = phase === 'full' ? null : indexStatus(options).lastScan;
        const fellBack = current.warnings.includes(indexParityWarning);
        await writeFile(join(directory, `${phase}.json`), JSON.stringify(current), { mode: 0o600 });
        const liveProof = proveLiveAggregates(full, current, changed);
        const workflowProof=proveLiveWorkflow(liveProof.left,liveProof.right,changed,{before:[scopeInventoryEvidence(full,fullInventory![0]).census,scopeInventoryEvidence(full,fullInventory![1]).census],after:[scopeInventoryEvidence(current,inventoryBefore).census,scopeInventoryEvidence(current,inventoryAfter).census]});
        const limitsProof=proveLiveLimits(workflowProof.left,workflowProof.right,changed);
        const warningProof=proveDeferralWarning(limitsProof.right,index,changed);
        const aggregateVerification = await verifyPhaseAggregates(directory, phase, join(directory, `${phase}.json`), current.generatedAt);
        const calibrationProof = await normalizeLiveCalibration(directory, phase, full, current, limitsProof.left, warningProof.snapshot, changed);
        const aggregateDifferences = phase === 'full' ? [] : compareSnapshotAggregates(limitsProof.left as MachineAnalytics, warningProof.snapshot as MachineAnalytics);
        const pricingProvenanceFailures=await verifyPricingProvenance(current,join(directory,'pricing-evidence'));
        const result = { phase, inventoryVerification, milliseconds: Math.round(performance.now() - start), sessions: current.sessions.length, changedEvidenceSessions: [...changed].sort(), differences, aggregateDifferences, limitsAggregateProof:limitsProof.accepted,limitsAggregateFailures:limitsProof.failures, workflowAggregateProof:workflowProof.accepted,workflowAggregateFailures:workflowProof.failures, warningProof:warningProof.accepted, warningFailures:warningProof.failures, liveAggregateProof: liveProof.accepted, liveAggregateFailures: liveProof.failures, aggregateVerification, pricingAgeFailures, pricingProvenanceFailures, index, fellBack, pricing: current.rateCard.pricing };
        Object.assign(result, { contextCurveProof, calibrationProof }); phases.push(result); output(result);
      }
      snapshot = full!;
    }
    requireUnchangedProduction(sourceFingerprint, await productionFingerprint());
    // Store supplied snapshots with the same name redaction boundary as analyzer output.
    if (value('--snapshot')) { snapshot = privateAuditSnapshot(snapshot); snapshotPath = join(directory, 'supplied.json'); await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 }); }
    const before = await json(resolve(root, '../reference/snapshot-noindex-51ea561.json')) as MachineAnalytics;
    await writeMonthly(before, snapshot, join(root, '.lane/MONTHLY.md'));
    const results: Json[] = [];
    // Supplied snapshots cannot prove changes before this run, but changes
    // during independent collection still have exact per-session witnesses.
    if (!recheck && !sourceGenerations.length) sourceGenerations.push(await captureSourceGeneration(directory, 'oracles-before', {}));
    for (const area of requested) {
      if(recheck){
        const previous=existingExecution!.filter(r=>r&&r['area']===area);
        if(previous.length!==1)throw new Error('Unique area execution unavailable.');
        results.push(validateOracleExecution(previous[0], area, oraclePipelines[area]!));continue;
      }
      const workspace = join(directory, area); await resetOracleArtifacts(workspace);
      for (const name of ['data', 'verify', 'src', 'schemas']) { try { await symlink(join(root, name), join(workspace, name)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
      process.stderr.write(`Real verification: independent ${area} oracle pipeline.\n`);
      const commands = [];
      for (const step of oraclePipelines[area]!) { const result = await runStep(step, workspace, snapshotPath, snapshot.generatedAt); commands.push(result); output({ area, ...result }); }
      const result = { area, commands, failedCommands: commands.filter(r => r.exitCode !== 0).length }; results.push(result);
      await writeFile(join(directory, 'execution.json'), JSON.stringify({ generatedAt: snapshot.generatedAt, phases, areas: results }, null, 2));
    }
    output({ monthly: monthly(snapshot) });
    // Comparison gates are intentionally strict. A completed process alone never certifies matching numbers.
    const { inspectOracleResults } = await import('./verify-real-results.ts');
    if (recheck) sourceGenerations.push(...await readSourceGenerations(directory));
    else sourceGenerations.push(await captureSourceGeneration(directory, 'oracles-after', {}));
    const liveSessions = changedSourceSessions(sourceGenerations);
    const liveEvidence = { version: 1, referenceGeneratedAt: snapshot.generatedAt,
      reason: 'source-generation-changed-during-verification', sessionKeys: [...liveSessions].sort(),
      generations: sourceGenerations.map(g => ({ phase: g.phase, capturedAt: g.capturedAt, sessions: g.sessions.length })) };
    await writeFile(join(directory, 'live-source-changes.json'), JSON.stringify(liveEvidence, null, 2), { mode: 0o600 });
    const comparisons = await inspectOracleResults(directory, requested, snapshotPath, liveSessions);
    if(requested.includes('other-providers'))await writeMonthly(before,snapshot,join(root,'.lane/MONTHLY.md'),await json(join(directory,'other-providers/.lane/desktop-audit-oracle.json')));
    requireUnchangedProduction(sourceFingerprint, await productionFingerprint());
    await writeFile(join(directory, 'results.json'), JSON.stringify({ generatedAt: snapshot.generatedAt, liveEvidence, phases, execution: results, comparisons }, null, 2));
    for (const result of comparisons) output(result);
    const failed = results.some(r => r['failedCommands'] > 0) || comparisons.some(r => r.unresolved > 0) || phases.some(p => p['differences'].length || p['aggregateDifferences'].length || p['inventoryVerification'].failures.length || p['limitsAggregateFailures'].length || p['workflowAggregateFailures'].length || p['warningFailures'].length || p['liveAggregateFailures'].length || p['aggregateVerification'].failed || p['pricingAgeFailures'].length || p['pricingProvenanceFailures'].length || p['fellBack'] || p['phase'] !== 'full' && !p['index']);
    if (failed) process.exitCode = 1;
  } finally {
    if (previousDataDir === undefined) delete process.env['SESSION_ANALYTICS_DATA_DIR']; else process.env['SESSION_ANALYTICS_DATA_DIR'] = previousDataDir;
    if (previousPricingDir === undefined) delete process.env['SESSION_ANALYTICS_VERIFY_PRICING_DIR']; else process.env['SESSION_ANALYTICS_VERIFY_PRICING_DIR'] = previousPricingDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true }); if (locked) await rmdir(lock);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error: unknown) => {
  const fixed = new Set(['Session analysis process exited before returning a result.', 'Session analysis process returned an invalid result.']);
  const frames = error instanceof Error ? (error.stack ?? '').split('\n').filter(line => line.includes(root)).map(line => line.slice(line.indexOf(root) + root.length + 1).replace(/[) ]+$/, '')).filter(line => /^(?:scripts|src)\/[A-Za-z0-9_./-]+\.(?:ts|js|mjs):\d+:\d+$/.test(line)) : [];
  output({ failure: error instanceof AnalysisHeapLimitError ? 'worker-heap-limit' : error instanceof Error && fixed.has(error.message) ? error.message : 'verification-unavailable', ...(error instanceof AnalysisHeapLimitError ? { stage: error.stage } : {}), frames });
  process.stderr.write('Real verification failed; private local details withheld.\n'); process.exitCode = 2;
});
