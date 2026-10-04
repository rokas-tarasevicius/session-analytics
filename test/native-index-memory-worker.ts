/** Cold indexing must retain native metric graphs within the bounded worker heap. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeMachineSessions } from '../src/analyzer.ts';
const root=process.argv[2]!, count=500, events=80;
const codexRoot=join(root,'codex'),claudeRoot=join(root,'claude'),codexArchiveRoot=join(root,'archive');
await Promise.all([codexRoot,claudeRoot,codexArchiveRoot].map(p=>mkdir(p,{recursive:true})));
const usage=(n:number)=>({input_tokens:n,cached_input_tokens:0,output_tokens:Math.floor(n/10),reasoning_output_tokens:0});
for(let i=0;i<count;i++){
 const id=`aaaaaaaa-0000-4000-8000-${String(i).padStart(12,'0')}`,base=(i+1)*1_000_000;
 const records:unknown[]=[{type:'session_meta',timestamp:'2026-08-01T00:00:00Z',payload:{id,cwd:root,source:'cli'}},{type:'turn_context',timestamp:'2026-08-01T00:00:01Z',payload:{model:'gpt-5.6-sol'}}];
 for(let n=0;n<events;n++)records.push({type:'event_msg',timestamp:new Date(Date.UTC(2026,7,1,n)).toISOString(),payload:{type:'token_count',info:{total_token_usage:usage(base+(n+1)*100),last_token_usage:usage(100)}}});
 await writeFile(join(codexRoot,`rollout-${id}.jsonl`),records.map(r=>JSON.stringify(r)).join('\n')+'\n');
}
const snapshot=await analyzeMachineSessions({codexRoot,claudeRoot,codexArchiveRoot,databasePath:join(root,'missing.db'),cursorDatabasePath:join(root,'missing-cursor.db'),dataDir:join(root,'data'),additionalProviders:false,noIndex:false,offline:true});
const input = snapshot.sessions.reduce((n, s) => n + s.tokens.inputTokens, 0);
const output = snapshot.sessions.reduce((n, s) => n + s.tokens.outputTokens, 0);
const calls = snapshot.sessions.reduce((n, s) => n + s.metrics.modelCalls, 0);
assert.equal(snapshot.sessions.length, count);
assert.equal(input, count * events * 100);
assert.equal(output, count * events * 10);
assert.equal(calls, count * events);
assert.ok(Math.abs(snapshot.sessions.reduce((n, s) => n + s.cost.totalUsd, 0) - 32) < 1e-8);
assert.doesNotMatch(JSON.stringify(snapshot), /aaaaaaaa-0000-4000-8000/);
process.stdout.write(JSON.stringify({ sessions: count, calls, input, output }));
