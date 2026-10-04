import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {analyzeMachineSessions} from '../../src/analyzer.ts';
import type {SessionAnalytics} from '../../src/types.ts';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const at=(day:number,ms=0)=>new Date(Date.UTC(2026,0,day,0,0,0,ms)).toISOString();
const record=(type:string,payload:object,timestamp:string)=>({type,payload,timestamp});
const meta=(id:string,day:number,fork?:string)=>record('session_meta',{id,cwd:'/synthetic/codex-dedup',timestamp:at(day),source:'cli',...(fork?{forked_from_id:fork}:{})},at(day));
const context=(day:number)=>record('turn_context',{model:'gpt-5.4'},at(day));
const response=(id:string,day:number,ms:number)=>record('response_item',{type:'function_call',name:'exec_command',call_id:id,arguments:'SYNTHETIC_PRIVATE_SENTINEL'},at(day,ms));
const usage=(n:number)=>({input_tokens:n,cached_input_tokens:0,output_tokens:n/10,reasoning_output_tokens:0,total_tokens:n*1.1});
const token=(total:number,last:number|null,day:number,ms:number)=>record('event_msg',{type:'token_count',info:{total_token_usage:usage(total),...(last===null?{}:{last_token_usage:usage(last)})}},at(day,ms));
const key=(id:string)=>createHash('sha256').update(`codex:${id}`).digest('hex').slice(0,12);
async function scan(files:Array<{id:string,rows:Array<object|string>,archive?:boolean}>,registered=false):Promise<SessionAnalytics[]> {
  const root=await mkdtemp(join(tmpdir(),'dedup-codex-validation-'));
  try {
    const active=join(root,'active'),archive=join(root,'archive'),claude=join(root,'claude');
    await Promise.all([mkdir(active),mkdir(archive),mkdir(claude)]);
    if(registered){
      const db=new DatabaseSync(join(root,'absent.db'));
      db.exec("CREATE TABLE repos(id TEXT,name TEXT,root_path TEXT,remote_url TEXT,default_branch TEXT,hidden INTEGER); CREATE TABLE workspaces(id TEXT,repository_id TEXT,workspace_name TEXT,workspace_path TEXT,branch TEXT); CREATE TABLE sessions(id TEXT,status TEXT,agent_type TEXT,title TEXT,created_at TEXT,updated_at TEXT,claude_session_id TEXT,model TEXT,is_hidden INTEGER,workspace_id TEXT);");
      db.prepare('INSERT INTO repos VALUES(?,?,?,?,?,?)').run('repo','Synthetic','/synthetic/codex-dedup',null,'main',0);
      db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?)').run('workspace','repo','Synthetic','/synthetic/codex-dedup','main');
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?)').run('registered','completed','codex','Synthetic',at(1),at(1),A,'gpt-5.4',0,'workspace');db.close();
    }
    for(const f of files)await writeFile(join(f.archive?archive:active,`rollout-${f.id}.jsonl`),f.rows.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('\n')+'\n');
    const result=await analyzeMachineSessions({noIndex:true,additionalProviders:false,offline:true,pricingPolicy:'reviewed-only',dataDir:join(root,'data'),databasePath:join(root,'absent.db'),cursorDatabasePath:join(root,'absent-cursor.db'),claudeRoot:claude,codexRoot:active,codexArchiveRoot:archive});
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_SENTINEL'));
    return result.sessions.filter(s=>s.provider==='codex');
  } finally {await rm(root,{recursive:true,force:true});}
}

test('DEDUP-CX-01: counter-only coincidence is explicitly incomplete until a request identity resolves it',async()=>{
  const sessions=await scan([{id:A,rows:[meta(A,1),context(1),response('a',1,1),token(100,100,1,2)]},{id:B,rows:[meta(B,2),context(2),response('b',2,1),token(100,100,2,2)]}]);
  assert.equal(sessions.reduce((n,s)=>n+s.tokens.inputTokens,0),100);
  assert.ok(sessions.some(session => session.transcript.completeness === "partial" && session.transcript.warnings.some(warning => warning.includes("without a proven process/request identity"))));
});

test('DEDUP-CX-02: copied process counters without last usage must count each delta once',async()=>{
  const rows=(id:string)=>[meta(id,1,id===B?A:undefined),context(1),token(100,null,1,1),response(`call-${id}`,1,2),token(150,null,1,3)];
  const sessions=await scan([{id:A,rows:rows(A)},{id:B,rows:rows(B)}]);
  assert.equal(sessions.reduce((n,s)=>n+s.tokens.inputTokens,0),50);
});

test('DEDUP-CX-03: archive copy with additional requests must not lose its unique suffix',async()=>{
  const prefix=[meta(A,1),context(1),response('first',1,1),token(100,100,1,2)];
  const sessions=await scan([{id:A,rows:prefix},{id:A,archive:true,rows:[...prefix,response('second',1,3),token(300,200,1,4)]}]);
  assert.equal(sessions.length,1);assert.equal(sessions[0]!.tokens.inputTokens,300);
});

test('DEDUP-CX-04: fork replay with rewritten timestamps must not steal original request ownership',async()=>{
  const sessions=await scan([{id:A,rows:[meta(A,1),context(1),response('inherited',1,1),token(100,100,1,20)]},{id:B,rows:[meta(B,2,A),context(2),response('inherited',2,0),token(100,100,2,0),response('new',2,1),token(300,200,2,20)]}]);
  assert.equal(sessions.find(s=>s.sessionKey===key(A))!.tokens.inputTokens,100);
  assert.equal(sessions.find(s=>s.sessionKey===key(B))!.tokens.inputTokens,200);
});

test('DEDUP-CX-05: inherited fork tool calls must not become new child activity',async()=>{
  const sessions=await scan([{id:A,rows:[meta(A,1),context(1),response('inherited',1,1),token(100,100,1,2)]},{id:B,rows:[meta(B,2,A),context(2),response('inherited',1,1),token(100,100,1,2),response('new',2,1),token(300,200,2,2)]}]);
  assert.equal(sessions.find(s=>s.sessionKey===key(B))!.metrics.toolCalls,1);
  assert.equal(sessions.reduce((n,s)=>n+s.metrics.toolCalls,0),2);
});

test('DEDUP-CX-06: repeated counter after a decrease is explicitly incomplete without request identity',async()=>{
  const sessions=await scan([{id:A,rows:[meta(A,1),context(1),response('one',1,1),token(100,100,1,2),response('two',1,3),token(300,200,1,4),response('three',1,5),token(100,100,1,6)]}]);
  assert.equal(sessions[0]!.tokens.inputTokens,300);
  assert.ok(sessions[0]!.transcript.warnings.some(warning => warning.includes("without a proven reset/request identity")));
});

test('DEDUP-CX-07: registered parser and ledger must select the same physical copy',async()=>{
  const prefix=[context(1),response('first',1,1),token(100,100,1,2)];
  const first=meta(A,1);first.payload={...first.payload,cwd:'/synthetic/other-workspace'};
  const sessions=await scan([{id:A,rows:[first,...prefix]},{id:A,archive:true,rows:[meta(A,1),...prefix]}],true);
  assert.equal(sessions.length,1);assert.equal(sessions[0]!.tokens.inputTokens,100);
});

test('DEDUP-CX-08: replayed ancestor metadata must not change child execution ownership',async()=>{
  const child=record('session_meta',{id:B,cwd:'/synthetic/codex-dedup',timestamp:at(2),source:{subagent:{thread_spawn:{parent_thread_id:A,depth:1}}},forked_from_id:A},at(2));
  const replay=meta(A,1);replay.timestamp=at(2);
  const sessions=await scan([{id:B,rows:[child,replay,context(2),response('new',2,1),token(100,100,2,2)]}]);
  assert.equal(sessions[0]!.executionKind,'subagent');
  assert.equal(sessions[0]!.costByExecution.topLevelUsd,0);
  assert.equal(sessions[0]!.costByExecution.subagentUsd,sessions[0]!.cost.totalUsd);
});

test('DEDUP-CX-09: corroborated embedded session identity must retain a renamed continuation',async()=>{
  const continuation=record('session_meta',{id:A,session_id:A,cwd:'/synthetic/codex-dedup',timestamp:at(2),source:'cli'},at(2));
  const second=token(300,200,2,2);second.payload={...second.payload,thread_id:A};
  const sessions=await scan([{id:A,rows:[meta(A,1),context(1),response('one',1,1),token(100,100,1,2)]},{id:B,rows:[continuation,context(2),response('two',2,1),second]}]);
  assert.equal(sessions.length,1);assert.equal(sessions[0]!.tokens.inputTokens,300);
});


test('DEDUP-CX-10: valid JSON whitespace CR must not split a token record',async()=>{
  const valid=JSON.stringify(token(100,100,1,2)).replace(',"payload"',',\r"payload"');
  assert.equal(JSON.parse(valid).type,'event_msg');
  const sessions=await scan([{id:A,rows:[meta(A,1),context(1),response('one',1,1),valid]}]);
  assert.equal(sessions[0]!.tokens.inputTokens,100);
});

test('DEDUP-CX-10: valid JSON whitespace CR must not hide session metadata',async()=>{
  const valid=JSON.stringify(meta(A,1)).replace(',"payload"',',\r"payload"');
  assert.equal(JSON.parse(valid).type,'session_meta');
  const sessions=await scan([{id:A,rows:[valid,context(1),response('one',1,1),token(100,100,1,2)]}]);
  assert.equal(sessions.length,1);
});

test('DEDUP-CX-09 control: a corroborated renamed copy must not double count',async()=>{
  const header=record('session_meta',{id:A,session_id:A,cwd:'/synthetic/codex-dedup',timestamp:at(1),source:'cli'},at(1));
  const observed=token(100,100,1,2);observed.payload={...observed.payload,thread_id:A};
  const rows=[header,context(1),response('one',1,1),observed];
  const sessions=await scan([{id:A,rows},{id:B,rows}]);
  assert.equal(sessions.length,1);assert.equal(sessions[0]!.tokens.inputTokens,100);
});

test('DEDUP-CX-09 control: contradictory embedded thread identities remain rejected',async()=>{
  const header=record('session_meta',{id:A,session_id:A,cwd:'/synthetic/codex-dedup',timestamp:at(2),source:'cli'},at(2));
  const observed=token(300,200,2,2);observed.payload={...observed.payload,thread_id:B};
  const sessions=await scan([{id:A,rows:[meta(A,1),context(1),response('one',1,1),token(100,100,1,2)]},{id:B,rows:[header,context(2),response('two',2,1),observed]}]);
  assert.equal(sessions.length,1);assert.equal(sessions[0]!.tokens.inputTokens,100);
});

test('DEDUP-CX-02: a replayed cumulative interval covered by original requests is counted once',async()=>{
  const sessions=await scan([{id:A,rows:[meta(A,1),context(1),response('one',1,1),token(100,100,1,2),response('two',1,3),token(300,200,1,4)]},{id:B,rows:[meta(B,2,A),context(2),token(0,0,2,0),token(300,0,2,1)]}]);
  assert.equal(sessions.reduce((n,s)=>n+s.tokens.inputTokens,0),300);
});

test('DEDUP-CX-10: Unicode line separators inside JSON strings must not split token records',async()=>{
  for(const separator of ['\u2028','\u2029']){
    const observed=token(100,100,1,2);observed.payload={...observed.payload,note:`SYNTHETIC_PRIVATE_SENTINEL${separator}suffix`};
    const sessions=await scan([{id:A,rows:[meta(A,1),context(1),response('one',1,1),observed]}]);
    assert.equal(sessions[0]!.tokens.inputTokens,100);
  }
});
