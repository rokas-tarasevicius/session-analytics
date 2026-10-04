// Production comparison driver. Run only after the independent oracle.
import { mkdir, rmdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import { analyzeMachineSessions, calculateCost } from '../../src/analyzer.ts';
import { conductorFallback } from '../../src/providers/conductor.ts';
import { discover, hash } from './oracle.mjs';

process.on('uncaughtException', () => { process.stderr.write('Recovery verification failed; private local details withheld.\n'); process.exit(1); });
process.on('unhandledRejection', () => { process.stderr.write('Recovery verification failed; private local details withheld.\n'); process.exit(1); });
const label = process.argv[2] ?? 'before';
if (!/^[a-z-]+$/.test(label)) throw new Error('Invalid comparison label.');
const lock = '/tmp/session-analytics-realscan.lock';
await mkdir('.lane/data', { recursive: true });
await mkdir('.lane/empty', { recursive: true });
process.env.SESSION_ANALYTICS_DATA_DIR = resolve('.lane/data');
let locked = false;
while (!locked) { try { await mkdir(lock); locked = true; } catch (e) { if (e.code !== 'EEXIST') throw new Error('Scan lock unavailable.'); await setTimeout(5000); } }
console.log(JSON.stringify({ phase:'lock-acquired' }));
try {
  const rates = JSON.parse(await readFile('data/rate-cards.json','utf8'));
  const { db,sessions } = await discover();
  const rows = sessions.map(s => ({ conductor_session_id:s.id,provider_session_id:s.claude_session_id,agent_type:'claude',
    created_at:s.created_at,updated_at:s.updated_at,status:s.status,repository_id:'discovered-00000000000000000000',repository_name:'Synthetic',
    repository_remote:'',root_path:'',workspace_path:'',default_branch:'',is_hidden:0,branch:null,title:'',database_model:null,workspace_name:null }));
  const recovered = conductorFallback(db,rows,new Set(),{rateCard:rates,price:calculateCost}); db.close();
  const projection = s => ({ sessionKey:s.sessionKey,tokens:s.tokens,valueUsd:s.cost.totalUsd,costBasis:s.costBasis,
    models:s.models,days:s.spendByDay,history:s.history,reconciliation:s.conductor?.reconciliation,
    calls:s.metrics.modelCalls,source:s.evidence?.source,status:s.status });
  await writeFile(`.lane/recovery-${label}.json`,JSON.stringify({generatedAt:new Date().toISOString(),sessions:recovered.map(projection)},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({phase:'forced-recovery',sessions:recovered.length}));
  if (!process.argv.includes('--recovery-only')) {
    const snapshot = await analyzeMachineSessions({ noIndex:true,includeHidden:true,offline:true,rateCardPath:resolve('data/rate-cards.json'),
      codexRoot:resolve('.lane/empty'),codexArchiveRoot:resolve('.lane/empty'),cursorDatabasePath:resolve('.lane/empty/absent'),additionalProviders:false });
    for (const r of snapshot.repositories) r.repository.name = `repository-${hash(r.repository.id)}`;
    for (const s of snapshot.sessions) s.repositoryName = `repository-${hash(s.repositoryId)}`;
    await writeFile(`.lane/native-${label}.json`,JSON.stringify(snapshot)+'\n',{mode:0o600});
    console.log(JSON.stringify({phase:'native-analysis',sessions:snapshot.sessions.length}));
  }
} catch { console.error('Paired comparison failed; raw error suppressed.'); process.exitCode=1; }
finally { await rmdir(lock); }
