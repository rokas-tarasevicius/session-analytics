import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import test from 'node:test';
import { safeModel, safeTimestamp, safeFieldNames, costRecordFields } from './claude-privacy.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url));
const sentinel='SENTINEL_PRIVATE_CLAUDE_VALUE';
const session='99999999-9999-4999-8999-999999999999';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,12);
async function fixture(run) {
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'claude-oracle-privacy-')));
 try {
  await mkdir(path.join(root,'.claude/projects/synthetic'),{recursive:true});await mkdir(path.join(root,'.lane'));
  const records=[
   {type:'assistant',sessionId:session,cwd:`/${sentinel}`,timestamp:'2026-09-01T00:00:00Z',message:{id:'synthetic-response',model:'claude-opus-4-8',content:sentinel,usage:{input_tokens:10,output_tokens:2}}},
   {type:'assistant',sessionId:session,cwd:`/${sentinel}`,timestamp:sentinel,message:{id:'synthetic-response',model:`claude-${session}`,content:sentinel,usage:{input_tokens:9,output_tokens:3}}},
   {type:'cost-state',sessionId:session,startTime:Date.parse('2026-09-01T00:00:00Z'),totalCostUSD:1,[sentinel]:123,modelUsage:{'claude-opus-4-8':{inputTokens:10,outputTokens:3,costUSD:1,[sentinel]:123}}},
  ];
  await writeFile(path.join(root,'.claude/projects/synthetic',`${session}.jsonl`),records.map(r=>JSON.stringify(r)).join('\n'));
  await writeFile(path.join(root,'.claude/stats-cache.json'),JSON.stringify({dailyModelTokens:[{date:sentinel,tokensByModel:{'claude-opus-4-8':1}},{date:'2026-09-01',tokensByModel:{'claude-opus-4-8':25}}],dailyActivity:[{date:sentinel,messageCount:1},{date:'2026-09-01',messageCount:2,sessionCount:1,toolCallCount:0}],modelUsage:{'claude-opus-4-8':{inputTokens:19,outputTokens:5,costUSD:0}}}));
  await writeFile(path.join(root,'.claude.json'),JSON.stringify({projects:{[`/${sentinel}`]:{lastCost:1,[`last${sentinel}`]:10,lastSessionId:session}},cachedUsageUtilization:{fetchedAtMs:Date.parse('2026-09-01T00:00:00Z'),accountUuid:sentinel,utilization:{five_hour:{utilization:20,resets_at:sentinel}}}}));
  await run(root);
 } finally {await rm(root,{recursive:true,force:true});}
}
function execute(root,script,args=[]) {
 const program=`import os from 'node:os';os.homedir=()=>${JSON.stringify(root)};process.chdir(${JSON.stringify(root)});delete process.env.CLAUDE_CONFIG_DIR;process.argv=['node',${JSON.stringify(script)},...${JSON.stringify(args)}];await import(${JSON.stringify(new URL(script,`file://${directory}/`).href)});`;
 return spawnSync(process.execPath,['--input-type=module','--eval',program],{encoding:'utf8'});
}
function privateFree(value) {assert.equal(value.includes(sentinel),false);assert.equal(value.includes(session),false);}

test('Claude validators project model IDs, timestamps and fixed schema names',()=>{
 assert.equal(safeModel('claude-opus-5-5[1m]'),'claude-opus-5-5[1m]');
 assert.equal(safeModel(`claude-${session}`),'<unknown>');
 assert.equal(safeTimestamp(sentinel),null);
 assert.deepEqual(safeFieldNames({type:'cost-state',[sentinel]:1},costRecordFields),['type']);
});

test('Claude raw/config/stats collectors omit planted values and arbitrary field names',async()=>fixture(async root=>{
 for(const [script,artifact]of [['claude.mjs','claude-raw.json'],['claude-stats.mjs','claude-stats-audit.json'],['claude-config.mjs','claude-config-audit.json']]){
  const result=execute(root,script);assert.equal(result.status,0,result.stderr);privateFree(result.stdout+result.stderr);privateFree(await readFile(path.join(root,'.lane',artifact),'utf8'));
 }
 const raw=JSON.parse(await readFile(path.join(root,'.lane/claude-raw.json'),'utf8'));assert.equal(raw.sessions.length,1);assert.equal(raw.sessions[0].tokens.outputTokens,3);assert.deepEqual(Object.keys(raw.profiles[0].config.projects[0].fields),['lastCost']);
 await writeFile(path.join(root,'.lane/claude-aggregates.json'),JSON.stringify({sessions:[{sessionKey:hash('claude:'+session),referenceSessionKey:'aaaaaaaaaaaa',liveAfterCutoff:false,tokenDelta:{input:1}}]}));
 const audit=execute(root,'claude-audit.mjs');assert.equal(audit.status,0,audit.stderr);privateFree(audit.stdout+audit.stderr);privateFree(await readFile(path.join(root,'.lane/claude-raw-conflicts.json'),'utf8'));
}));

test('Claude entrypoints suppress raw filesystem errors',async()=>fixture(async root=>{
 const missing=`/${sentinel}/missing.json`;
 for(const [script,args]of [['claude.mjs',[missing]],['claude-diff.mjs',[missing]],['claude-conductor-crosscheck.mjs',[]]]){
  const result=execute(root,script,args);assert.equal(result.status,1);assert.match(result.stderr,/Claude reconciliation failed; raw error suppressed/);privateFree(result.stdout+result.stderr);
 }
}));
