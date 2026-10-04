import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monthly, privateAuditSnapshot, strictFields, compareStableSnapshots, compareSnapshotAggregates, verifyPricingAges } from '../scripts/verify-real.ts';
import type { MachineAnalytics } from '../src/types.ts';
const snapshot = (sessions: unknown[], repositories: unknown[] = []) => ({ sessions, repositories }) as unknown as MachineAnalytics;

test('real verification keeps counters exact and only tolerates USD roundoff', () => {
  assert.deepEqual(strictFields({ inputTokens: 1e10, totalUsd: 100 }, { inputTokens: 1e10 + 1, totalUsd: 100 + 1e-9 }), ['inputTokens']);
  assert.deepEqual(strictFields({ totalUsd: 100 }, { totalUsd: 100.001 }), ['totalUsd']);
});

test('real parity only excludes precisely changed session keys', () => {
  const a = snapshot([{ sessionKey: 'aaaaaaaaaaaa', tokens: 1 }, { sessionKey: 'bbbbbbbbbbbb', tokens: 1 }]);
  const b = snapshot([{ sessionKey: 'aaaaaaaaaaaa', tokens: 2 }, { sessionKey: 'bbbbbbbbbbbb', tokens: 2 }]);
  assert.deepEqual(compareStableSnapshots(a, b, new Set(['aaaaaaaaaaaa'])), [{ sessionKey: 'bbbbbbbbbbbb', fields: ['tokens'] }]);
});

test('phase parity includes aggregate and schema mutations independently of session changes', () => {
  const a = { ...snapshot([]), generatedAt: '2026-01-01', schemaVersion: 1, summary: { outputTokens: 3 } } as MachineAnalytics;
  const b = { ...a, generatedAt: '2026-01-02', summary: { ...a.summary, outputTokens: 4 } };
  assert.deepEqual(compareSnapshotAggregates(a, b), ['summary.outputTokens']);
  assert.deepEqual(compareSnapshotAggregates(a, { ...a, generatedAt: '2026-01-02' }), []);
  const duplicate = snapshot([{ sessionKey: 'aaaaaaaaaaaa' }, { sessionKey: 'aaaaaaaaaaaa' }]);
  assert.deepEqual(compareStableSnapshots(duplicate, duplicate, new Set()), [{ sessionKey: 'aaaaaaaaaaaa', fields: ['sessionKey.multiplicity'] }]);
});

test('independent event calendar checks UTC offsets, London hours, unknown time and exact counters', async () => {
  const { addEvent, compareEventBuckets } = await import('../verify/shared/event-buckets.ts');
  const rows = new Map();
  const tokens = { inputTokens: 7, uncachedInputTokens: 2, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 1 };
  addEvent(rows, { at: '2026-09-30T23:30:00Z', model: 'claude-opus-4-6', executionKind: 'top-level', tokens, totalUsd: 0.5, calls: 1 });
  const row = [...rows.values()][0]!;
  assert.equal(row.day, '2026-10-01'); assert.equal(row.hour, 0);
  const session = { sessionKey: 'aaaaaaaaaaaa', velocity: { dimensions: [{ model: 'claude-opus-4-6', executionKind: 'top-level' }], buckets: [['2026-10-01', 0, 0, [.5, 7, 2, 5, 0, 3, 1, 1]]], undated: [] } };
  assert.deepEqual(compareEventBuckets(session, [...rows.values()]), []);
  session.velocity.buckets[0]![3] = [.5, 8, 2, 5, 0, 3, 1, 1];
  assert.equal(compareEventBuckets(session, [...rows.values()])[0]!.field, 'velocity.inputTokens');
  const undated = new Map(); addEvent(undated, { at: null, model: 'claude-opus-4-6', executionKind: 'unknown', tokens, totalUsd: .5, calls: 0 });
  assert.equal([...undated.values()][0]!.day, null);
});

test('changing price ages require a consistent independently bounded catalog clock', () => {
  const start = Date.parse('2026-09-02T00:00:00Z');
  const pricing = { policy: 'reviewed-first', refreshAfterDays: 7, newestSnapshotAt: '2026-09-01T00:00:00Z', ageDays: 1, stale: false, sources: [{ fetchedAt: '2026-09-01T00:00:00Z', ageDays: 1, stale: false }] };
  const a = { ...snapshot([]), rateCard: { pricing } } as unknown as MachineAnalytics;
  assert.deepEqual(verifyPricingAges(a, start, start + 1000), []);
  const b = structuredClone(a); b.rateCard.pricing!.ageDays = 2;
  assert.ok(verifyPricingAges(b, start, start + 1000).includes('pricing.ageOutsideScan'));
  assert.deepEqual(compareSnapshotAggregates(a, b), []);
  b.rateCard.pricing!.sources[0]!.stale = true;
  assert.ok(compareSnapshotAggregates(a, b).includes('rateCard.pricing.sources.*.stale'));
});

test('audit snapshots redact repository names without losing grouping or bucket category', () => {
  const data = snapshot([{ repositoryId: 'opaque', repositoryName: 'PRIVATE_NAME' }], [{ repository: { id: 'opaque', name: 'PRIVATE_NAME (local directory)' } }]);
  const result = privateAuditSnapshot(data);
  assert.equal(JSON.stringify(result).includes('PRIVATE_NAME'), false);
  assert.equal(result.repositories[0]!.repository.name.endsWith(' (local directory)'), true);
  assert.equal(result.sessions[0]!.repositoryId, 'opaque');
});

test('monthly accounting distinguishes event date, creation cohort and undated recovery', () => {
  const data = snapshot([{ provider: 'claude', createdAt: '2026-01-31T23:00:00Z', tokens: { inputTokens: 10, outputTokens: 2 }, cost: { totalUsd: 5 }, spendByDay: { '2026-02-01': 2 }, costBasis: 'provider-reported', evidence: { source: 'conductor-result' } }]);
  assert.deepEqual(monthly(data), [
    { month: '2026-01', provider: 'claude', sessions: 1, datedUsd: 0, creationUsd: 5, recoveredUsd: 5, undatedUsd: 3, inputTokens: 10, outputTokens: 2 },
    { month: '2026-02', provider: 'claude', sessions: 0, datedUsd: 2, creationUsd: 0, recoveredUsd: 0, undatedUsd: 0, inputTokens: 0, outputTokens: 0 },
  ]);
});

test('missing expected oracle result fields fail closed', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { inspectOracleResults } = await import('../scripts/verify-real-results.ts');
  const dir = await mkdtemp(join(tmpdir(), 'verify-real-result-'));
  try {
    await mkdir(join(dir, 'time/.lane'), { recursive: true });
    await writeFile(join(dir, 'time/.lane/time-reference-audit.json'), '{}');
    await writeFile(join(dir, 'time/.lane/time-final-report.json'), '{}');
    const result = (await inspectOracleResults(dir, ['time']))[0]!;
    assert.equal(result.unresolved, result.checks.length);
    assert.equal(result.checks.every(c => c.unavailable), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('SDK oracle independently verifies receipt floors and stripped stream groups without leaking content', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createHash } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'verify-real-sdk-'));
  const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);
  const tokens = (input: number, cached: number, output: number, nonReasoning = 0) => ({ inputTokens: input + cached, uncachedInputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0, nonReasoningOutputTokens: nonReasoning });
  try {
    await mkdir(join(dir, '.lane')); await mkdir(join(dir, 'prices'));
    const dbFile = join(dir, 'fixture.db'), db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE sessions(id TEXT,claude_session_id TEXT,created_at TEXT,updated_at TEXT,agent_type TEXT); CREATE TABLE session_messages(id INTEGER,session_id TEXT,content TEXT,full_message TEXT,created_at TEXT,sdk_message_id TEXT);');
    const stamp = '2026-09-01T12:00:00Z';
    for (const id of ['receipts', 'messages']) db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(id, id, stamp, stamp, 'claude');
    const put = (id: number, owner: string, record: unknown) => db.prepare('INSERT INTO session_messages VALUES(?,?,?,?,?,?)').run(id, owner, JSON.stringify(record), null, stamp, `block-${id}`);
    put(1, 'receipts', { type: 'system', subtype: 'init', uuid: 'i1', session_id: 'receipts', claude_code_version: '2.1.100' });
    put(2, 'receipts', { type: 'result', uuid: 'r1', session_id: 'receipts', total_cost_usd: 1, modelUsage: { 'claude-opus-4-6': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1 } } });
    put(3, 'receipts', { type: 'system', subtype: 'init', uuid: 'i2', session_id: 'receipts', claude_code_version: '2.1.100' });
    put(4, 'receipts', { type: 'result', uuid: 'r2', session_id: 'receipts', total_cost_usd: 2, modelUsage: { 'claude-opus-4-6': { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 2 } } });
    for (const [id, input, out, known] of [[5, 200, 1, true], [6, 10, 2, true], [7, 10, 3, false]] as const) put(id, 'messages', { type: 'assistant', session_id: 'messages', uuid: `m${id}`, message: { ...(known ? { id: 'response-one' } : {}), model: 'claude-opus-4-6', usage: { input_tokens: input, cache_read_input_tokens: 20, output_tokens: out }, content: [{ type: 'text', text: 'PRIVATE_PROMPT_SENTINEL' }] } });
    db.close();
    const receiptTokens = tokens(20, 0, 10, 10), messageTokens = tokens(10, 20, 3), usd = .000135;
    const data = { generatedAt: '2026-09-02T00:00:00Z', rateCard: { pricing: { sources: [], policy: 'reviewed-first' } }, sessions: [
      { sessionKey: hash('receipts'), evidence: { source: 'conductor-result' }, tokens: receiptTokens, cost: { totalUsd: 2 }, spendByDay: {}, models: [{ model: 'claude-opus-4-6', ...receiptTokens, totalUsd: 2 }] },
      { sessionKey: hash('messages'), evidence: { source: 'conductor-messages' }, tokens: messageTokens, cost: { totalUsd: usd }, spendByDay: { '2026-09-01': usd }, costByExecution: { topLevelUsd: usd, subagentUsd: 0, unknownUsd: 0 }, models: [{ model: 'claude-opus-4-6', ...messageTokens, totalUsd: usd, calls: 1 }], metrics: { modelCalls: 1, assistantMessages: 1 }, historyStatistics: { days: [{ day: '2026-09-01', model: 'claude-opus-4-6', tokens: 286 }] }, velocity: { dimensions: [{model:'claude-opus-4-6',executionKind:'top-level'}], buckets: [['2026-09-01',13,0,[usd,30,10,20,0,3,0,1]]], undated: [] }, costComplete: false, conductor: { reconciliation: { messageValueUsd: usd, reportedUsd: null, messagesWithoutIdentity: 1, messagesWithoutUsage: 0 } } },
    ] };
    const source = join(dir, 'snapshot.json'); await writeFile(source, JSON.stringify(data));
    const script = fileURLToPath(new URL('../verify/conductor/current-oracle.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('../scripts/verify-reference.mjs', import.meta.url)), script], { cwd: dir, env: { ...process.env, SESSION_ANALYTICS_VERIFY_REFERENCE: source, CONDUCTOR_DATABASE: dbFile, CLAUDE_ORACLE_PRICING_DIR: join(dir, 'prices') }, encoding: 'utf8' });
    assert.equal(result.status, 0, 'Independent SDK oracle must run');
    const artifact = await readFile(join(dir, '.lane/conductor-current.json'), 'utf8');
    assert.equal(artifact.includes('PRIVATE_PROMPT_SENTINEL'), false);
    const audit = JSON.parse(artifact) as { differences: unknown[]; sessions: unknown[] };
    assert.deepEqual(audit.differences, []);
    assert.equal(audit.sessions.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing or malformed scalar oracle operands cannot pass', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { inspectOracleResults } = await import('../scripts/verify-real-results.ts');
  const dir = await mkdtemp(join(tmpdir(), 'verify-real-scalars-'));
  try {
    await mkdir(join(dir, 'codex/.lane'), { recursive: true });
    await writeFile(join(dir, 'codex/.lane/codex-reconciled.json'), JSON.stringify({ comparison: { sessions: [{ delta: [0, 0, 0, 0, 0] }] } }));
    await writeFile(join(dir, 'codex/.lane/codex-receipt-reconciliation-check.json'), JSON.stringify({ unmatched: [], receipts: 1, exactMatches: null, acrossTurnMatches: 0, unmatchedAfterFallback: 1 }));
    const result = (await inspectOracleResults(dir, ['codex']))[0]!;
    assert.equal(result.unresolved, 3);
    assert.equal(result.checks.every(c => c.unavailable), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('raw statistics oracle separates streamed counters and reserves shared overlap exactly once', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createHash } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'verify-history-'));
  try {
    await mkdir(join(dir, '.lane')); await mkdir(join(dir, 'prices'));
    const model = 'claude-opus-4-6', day = '2026-09-01', month = '2026-09';
    const profiles = [];
    for (const [name, overlap, remainder, sessionTokens, statisticsTokens] of [['.claude', 19, 41, 20, 40], ['.claude-second', 31, 69, 0, 0]] as const) {
      const root = join(dir, name); await mkdir(root);
      await writeFile(join(root, 'stats-cache.json'), JSON.stringify({ dailyModelTokensVersion: 5, lastComputedDate: day, modelUsage: { [model]: { inputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 } }, dailyModelTokens: [{ date: day, tokensByModel: { [model]: 100 } }] }));
      profiles.push({ profileKey: 'profile-' + createHash('sha256').update('claude:directory:' + await realpath(root)).digest('hex').slice(0, 20), status: 'available', dailyTokensVersion: 5, statisticsThrough: day, firstStatisticsDay: day, firstTranscriptDay: sessionTokens ? day : null, lifetimeTokens: 100, sessionsWithoutStatisticsCounters: 0, months: [{ month, models: [{ model, statisticsDays: 1, providerTokens: 100, sessionTokens, sessionStatisticsTokens: statisticsTokens, gapTokens: 100 - statisticsTokens, possibleOverlapTokens: overlap, unattributedTokens: remainder, pricedUnattributedTokens: remainder, unattributedEstimateUsd: remainder * 5 / 1e6, tokenMixSource: 'lifetime-model' }] }] });
    }
    const snapshot = { generatedAt: '2026-09-02T00:00:00Z', rateCard: { pricing: { sources: [], policy: 'reviewed-only' } }, sessions: [
      { provider: 'claude', transcript: {}, firstEventAt: day + 'T12:00:00Z', cost: { totalUsd: .1 }, spendByDay: { [day]: .1 }, limitsCache: { profileKey: profiles[0]!.profileKey, buckets: [{ day, model, observedTokens: 20 }] }, historyStatistics: { days: [{ day, model, tokens: 40 }] } },
      { provider: 'claude', cost: { totalUsd: .2 }, spendByDay: { [day]: .2 }, history: { days: [{ day, model, tokens: 10, valueUsd: .2 }], undatedTokens: 0 }, historyStatistics: { days: [{ day, model, tokens: 50 }] } },
    ], historyCoverage: { profiles, months: [{ month, sessionsWithDatedValue: 2, statisticsCells: 2, sessionEvidenceUsd: .3, unattributedEstimateUsd: .00055, unattributedTokens: 110, pricedUnattributedTokens: 110, possibleOverlapTokens: 50, recoveredMessageUsd: .2 }], undatedSessionValueUsd: 0, unassignedProfileTokens: 10 } };
    const source = join(dir, 'snapshot.json'); await writeFile(source, JSON.stringify(snapshot));
    const child = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('../scripts/verify-reference.mjs', import.meta.url)), fileURLToPath(new URL('../verify/reconcile/history-coverage-current.mjs', import.meta.url))], { cwd: dir, encoding: 'utf8', env: { ...process.env, SESSION_ANALYTICS_VERIFY_REFERENCE: source, HISTORY_ORACLE_HOME: dir, CLAUDE_ORACLE_PRICING_DIR: join(dir, 'prices') } });
    assert.equal(child.status, 0, 'Independent statistics oracle must run');
    const result = JSON.parse(await readFile(join(dir, '.lane/history-coverage-current.json'), 'utf8'));
    assert.deepEqual(result.differences, []);
    assert.equal(result.rawStatisticsCells, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('read-only oracle SQLite opening does not create WAL sidecars in an unwritable source directory', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, chmod, access, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'verify-sqlite-')), source = join(dir, 'source with spaces');
  await mkdir(source); await mkdir(join(dir, '.lane'));
  const file = join(source, 'fixture.db');
  try {
    const db = new DatabaseSync(file); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE counts(n INTEGER); INSERT INTO counts VALUES(7)'); db.close();
    await chmod(source, 0o555);
    const probe = join(dir, 'probe.mjs');
    await writeFile(probe, `import{DatabaseSync}from${JSON.stringify(fileURLToPath(new URL('../verify/shared/sqlite.ts', import.meta.url)))};const d=new DatabaseSync(${JSON.stringify(file)},{readOnly:true});console.log(JSON.stringify(d.prepare('SELECT n FROM counts').get()));d.close();`);
    const result = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('../scripts/verify-reference.mjs', import.meta.url)), probe], { cwd: dir, encoding: 'utf8', env: { ...process.env, SESSION_ANALYTICS_VERIFY_REFERENCE: 'unused', NODE_NO_WARNINGS: '1' } });
    assert.equal(result.status, 0, 'Read-only SQLite proof must run');
    assert.deepEqual(JSON.parse(result.stdout), { n: 7 });
    const proof = JSON.parse(await readFile(join(dir, '.lane/sqlite-proof-probe.mjs.json'), 'utf8'));
    assert.equal(proof.proofs[0].unchanged, true);
    await assert.rejects(access(file + '-wal')); await assert.rejects(access(file + '-shm'));
  } finally { await chmod(source, 0o755); await rm(dir, { recursive: true, force: true }); }
});

test('immutable oracle reads fail closed when the source generation changes before close', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url'); const { spawnSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite'); const dir = await mkdtemp(join(tmpdir(),'verify-sqlite-change-'));
  try {
    await mkdir(join(dir,'.lane'));const file=join(dir,'fixture.db');const db=new DatabaseSync(file);db.exec('CREATE TABLE counts(n INTEGER); INSERT INTO counts VALUES(7)');db.close();
    const probe=join(dir,'probe.mjs');await writeFile(probe,`import{DatabaseSync}from${JSON.stringify(fileURLToPath(new URL('../verify/shared/sqlite.ts',import.meta.url)))};import{utimesSync}from'node:fs';const path=${JSON.stringify(file)},db=new DatabaseSync(path,{readOnly:true});db.prepare('SELECT n FROM counts').get();utimesSync(path,new Date(1),new Date(1));db.close();`);
    const result=spawnSync(process.execPath,['--import',fileURLToPath(new URL('../scripts/verify-reference.mjs',import.meta.url)),probe],{cwd:dir,encoding:'utf8',env:{...process.env,SESSION_ANALYTICS_VERIFY_REFERENCE:'unused',NODE_NO_WARNINGS:'1'}});
    assert.notEqual(result.status,0);const proof=JSON.parse(await readFile(join(dir,'.lane/sqlite-proof-probe.mjs.json'),'utf8'));assert.equal(proof.proofs[0].unchanged,false);
  } finally {await rm(dir,{recursive:true,force:true});}
});
