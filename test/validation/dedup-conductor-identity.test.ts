import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';
import { validateSnapshot } from '../../src/interop/snapshot.ts';
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from '../fixtures.ts';

const hash=(v:string)=>createHash('sha256').update(v).digest('hex').slice(0,12);
const nativeId='22222222-2222-4222-8222-222222222222';
const nearbyId='33333333-3333-4333-8333-333333333333';
async function fixture(run:(f:SessionAnalyticsFixture)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'dedup-conductor-'));
  try { await run(await createSessionAnalyticsFixture(root)); }
  finally { await rm(root,{recursive:true,force:true}); }
}
const options=(f:SessionAnalyticsFixture)=>({noIndex:true,additionalProviders:false,pricingPolicy:'reviewed-only' as const,dataDir:f.dataDir,claudeRoot:f.claudeRoot,codexRoot:f.codexRoot,codexArchiveRoot:f.codexArchiveRoot,cursorDatabasePath:f.cursorDatabasePath,databasePath:f.databasePath});

test('DEDUP-CD-01: a native candidate matching two legacy rows remains independently attributed',async()=>{
  await fixture(async f=>{
    const db=new DatabaseSync(f.databasePath);
    db.prepare("UPDATE sessions SET claude_session_id=NULL WHERE id='conductor-claude'").run();
    db.exec(`INSERT INTO sessions (id,status,agent_type,title,created_at,updated_at,claude_session_id,model,is_hidden,workspace_id)
      SELECT 'second-legacy-row',status,agent_type,title,'2026-07-20T12:00:01Z',updated_at,NULL,model,0,workspace_id
      FROM sessions WHERE id='conductor-claude'`);
    db.close();
    const result=validateSnapshot(await analyzeMachineSessions(options(f)));
    const claude=result.sessions.filter(s=>s.provider==='claude');
    assert.equal(claude.length,1,'one canonical transcript must still count once');
    assert.equal(claude[0]!.sessionKey,hash(`claude:${nativeId}`),'neither ambiguous legacy row has a unique ownership claim');
  });
});

test('DEDUP-CD-02: result identity prevents a legacy row from claiming an unrelated nearby transcript',async()=>{
  await fixture(async f=>{
    const db=new DatabaseSync(f.databasePath);
    db.exec(`CREATE TABLE session_messages(id TEXT PRIMARY KEY,session_id TEXT,content TEXT,created_at TEXT);
      INSERT INTO sessions (id,status,agent_type,title,created_at,updated_at,claude_session_id,model,is_hidden,workspace_id)
      SELECT 'legacy-with-result',status,agent_type,title,created_at,updated_at,NULL,model,0,workspace_id
      FROM sessions WHERE id='conductor-claude'`);
    db.prepare('INSERT INTO session_messages VALUES (?,?,?,?)').run('receipt','legacy-with-result',JSON.stringify({type:'result',uuid:'result-receipt',session_id:nativeId,total_cost_usd:1,modelUsage:{'claude-opus-5':{inputTokens:10,outputTokens:1,costUSD:1}}}),'2026-07-20T12:01:00Z');
    db.close();
    const path=join(f.claudeRoot,'nearby');await mkdir(path,{recursive:true});
    await writeFile(join(path,`${nearbyId}.jsonl`),JSON.stringify({type:'assistant',sessionId:nearbyId,cwd:'/fixtures/workspaces/conductor/claude-workspace',timestamp:'2026-07-20T12:00:05Z',message:{id:'new-request',model:'claude-opus-5',content:[],usage:{input_tokens:100,output_tokens:10}}})+'\n');
    const result=validateSnapshot(await analyzeMachineSessions(options(f)));
    assert.ok(result.sessions.some(s=>s.sessionKey===hash(`claude:${nearbyId}`)),'explicit result identity points to the already represented native session, not this nearby session');
    assert.equal(result.sessions.filter(s=>s.evidence?.source==='conductor-result').length,0,'canonical native receipt is not billed again');
  });
});

test('DEDUP-CD-03: a mismatched newest registration cannot discard an older validated owner',async()=>{
  await fixture(async f=>{
    const db=new DatabaseSync(f.databasePath);
    db.exec(`INSERT INTO sessions (id,status,agent_type,title,created_at,updated_at,claude_session_id,model,is_hidden,workspace_id)
      SELECT 'newer-invalid-registration',status,agent_type,title,'2026-07-20T12:01:00Z',updated_at,claude_session_id,model,0,'workspace-codex'
      FROM sessions WHERE id='conductor-claude'`);
    db.close();
    const result=validateSnapshot(await analyzeMachineSessions(options(f)));
    const claude=result.sessions.filter(s=>s.provider==='claude');
    assert.equal(claude.length,1,'registration duplicates must not duplicate usage');
    assert.equal(claude[0]!.sessionKey,hash('conductor-claude'),'the row that actually matches provider identity and cwd must own the session');
  });
});

test('DEDUP-CD-04: valid result evidence survives removal of its optional workspace metadata',async()=>{
  await fixture(async f=>{
    const db=new DatabaseSync(f.databasePath);
    db.exec(`CREATE TABLE session_messages(id TEXT PRIMARY KEY,session_id TEXT,content TEXT,created_at TEXT);
      INSERT INTO sessions (id,status,agent_type,title,created_at,updated_at,claude_session_id,model,is_hidden,workspace_id)
      VALUES ('orphan-result','completed','claude','synthetic','2026-07-20T12:00:00Z','2026-07-20T12:01:00Z','orphan-provider','claude-opus-5',0,'deleted-workspace')`);
    db.prepare('INSERT INTO session_messages VALUES (?,?,?,?)').run('orphan-receipt','orphan-result',JSON.stringify({type:'result',uuid:'orphan-receipt',session_id:'orphan-provider',total_cost_usd:2,modelUsage:{'claude-opus-5':{inputTokens:100,outputTokens:10,costUSD:2}}}),'2026-07-20T12:01:00Z');
    db.close();
    const result=validateSnapshot(await analyzeMachineSessions(options(f)));
    const recovered=result.sessions.find(s=>s.sessionKey===hash('orphan-result'));
    assert.ok(recovered,'removing optional attribution metadata must not remove validated provider evidence');
    assert.equal(recovered.cost.totalUsd,2);
    assert.equal(recovered.tokens.inputTokens+recovered.tokens.outputTokens,110);
    assert.match(recovered.repositoryName,/unassigned/i);
  });
});
