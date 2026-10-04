import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { conductorFallback } from '../../src/providers/conductor.ts';
import type { RateCard, SessionDatabaseRow } from '../../src/types.ts';

const row: SessionDatabaseRow = {
  agent_type:'claude', branch:null, conductor_session_id:'synthetic-conductor',
  created_at:'2026-07-01T10:00:00Z', database_model:'claude-opus-4-6', default_branch:'main', is_hidden:0,
  provider_session_id:'synthetic-provider', repository_id:'synthetic-repository', repository_name:'synthetic',
  repository_remote:'',root_path:'/synthetic',status:'idle',title:'synthetic',updated_at:'2026-07-01T11:00:00Z',
  workspace_name:null,workspace_path:'/synthetic/workspace',
};
function analyze(version: string, receipts: Array<{cost:number;input:number;marginal?:number;crash?:boolean}>) {
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE session_messages (id TEXT, session_id TEXT, content TEXT, created_at TEXT)');
  const insert=db.prepare('INSERT INTO session_messages VALUES (?,?,?,?)');
  for(const [i,r] of receipts.entries()) {
    const minute=String(i*2).padStart(2,'0');
    insert.run(`init-${i}`,row.conductor_session_id,JSON.stringify({type:'system',subtype:'init',uuid:`init-${i}`,claude_code_version:version}),`2026-07-01T10:${minute}:00Z`);
    insert.run(`result-${i}`,row.conductor_session_id,JSON.stringify({type:'result',subtype:r.crash?'error_during_execution':'success',is_error:!!r.crash,uuid:`receipt-${i}`,session_id:row.provider_session_id,total_cost_usd:r.cost,modelUsage:{'claude-opus-4-6':{inputTokens:r.input,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0,costUSD:r.cost}},...(r.marginal===undefined?{}:{conductor_sdk_metadata:{marginalCostUsd:r.marginal}})}),`2026-07-01T10:${minute}:01Z`);
  }
  try {return conductorFallback(db,[row],new Set(),{rateCard:{models:{}} as RateCard,price:()=>{throw new Error('Synthetic provider-reported cost must not require repricing');}})[0]!;} finally {db.close();}
}

test('VC-001: repeated old SDK init envelopes do not make cumulative query results disjoint costs',()=>{
  const s=analyze('2.1.100',[{cost:10,input:100},{cost:15,input:150}]);
  assert.equal(s.cost.totalUsd,15);
});
test('VC-001: repeated old SDK init envelopes do not duplicate cumulative model tokens',()=>{
  const s=analyze('2.1.100',[{cost:10,input:100},{cost:15,input:150}]);
  assert.equal(s.tokens.inputTokens,150);
});
test('VC-001: explicitly process-scoped marginal metadata conserves cumulative query costs',()=>{
  const s=analyze('2.1.100',[{cost:10,input:100,marginal:10},{cost:15,input:150,marginal:5}]);
  assert.equal(s.cost.totalUsd,15);
});
test('VC-002 control: a restored lifetime counter overrides a stale marginal tracker baseline',()=>{
  const s=analyze('2.1.300',[{cost:10,input:100,marginal:10},{cost:15,input:150,marginal:15}]);
  assert.equal(s.cost.totalUsd,15);
});
test('VC-002 control: unknown SDK scope does not turn marginal metadata into proof of disjoint cost',()=>{
  const s=analyze('unreported',[{cost:10,input:100,marginal:10},{cost:5,input:50,marginal:5}]);
  assert.equal(s.cost.totalUsd,10);
  assert.equal(s.costComplete,false);
});
test('VC-002 control: a zeroed crash alone never establishes complete zero cost',()=>{
  const s=analyze('2.1.100',[{cost:0,input:0,crash:true}]);
  assert.equal(s.cost.totalUsd,0);
  assert.equal(s.costComplete,false);
});
test('VC-002 control: valid old marginal evidence followed by a zeroed crash stays partial',()=>{
  const s=analyze('2.1.100',[{cost:10,input:100,marginal:10},{cost:0,input:0,crash:true}]);
  assert.equal(s.cost.totalUsd,10);
  assert.equal(s.costComplete,false);
});
