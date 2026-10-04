import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadNativeHeads} from './native-heads.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,12);
const first='11111111-1111-1111-1111-111111111111';const second='22222222-2222-2222-2222-222222222222';
const write=(p:string,rows:unknown[])=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');};
function fixture(t:any):string{const home=fs.mkdtempSync(path.join(os.tmpdir(),'native-heads-'));const codex=process.env.CODEX_HOME,claude=process.env.CLAUDE_CONFIG_DIR;delete process.env.CODEX_HOME;delete process.env.CLAUDE_CONFIG_DIR;t.after(()=>{fs.rmSync(home,{recursive:true,force:true});if(codex!==undefined)process.env.CODEX_HOME=codex;if(claude!==undefined)process.env.CLAUDE_CONFIG_DIR=claude;});return home;}

test('head census stops after first Codex metadata and preserves first identity during targeted full pass',async t=>{
 const home=fixture(t);const file=path.join(home,'.codex/sessions',`rollout-${first}.jsonl`);const cwd=path.join(home,'synthetic-project');
 write(file,[{type:'session_meta',timestamp:'2026-01-01T00:00:00Z',payload:{id:first,cwd}},{type:'session_meta',timestamp:'2026-01-02T00:00:00Z',payload:{id:second,cwd:path.join(home,'other-project')}},{type:'event_msg',timestamp:'2026-01-03T00:00:00Z',payload:{type:'task_complete'}}]);
 const heads=await loadNativeHeads(home);assert.equal(heads.records[0]?.id,first);assert.equal(heads.counts.lines,1);assert.equal(heads.records[0]?.completeTimestampPass,false);
 const full=await loadNativeHeads(home,new Set([hash('codex:'+first)]));assert.equal(full.records[0]?.id,first);assert.equal(full.records[0]?.lastAt,'2026-01-03T00:00:00.000Z');assert.deepEqual(full.records[0]?.metadataIds,[first,second]);assert.equal(full.records[0]?.completeTimestampPass,true);
});

test('head census joins Claude child evidence to its parent and prefers parent cwd',async t=>{
 const home=fixture(t);const project=path.join(home,'.claude/projects/synthetic');const parent=path.join(home,'synthetic-parent');
 write(path.join(project,first,'subagents/agent-child.jsonl'),[{type:'user',cwd:path.join(home,'synthetic-child'),sessionId:first,timestamp:'2026-01-01T00:00:00Z'}]);
 write(path.join(project,first+'.jsonl'),[{type:'user',cwd:parent,sessionId:first,timestamp:'2026-01-02T00:00:00Z'}]);
 const r=await loadNativeHeads(home);assert.equal(r.records.length,1);assert.equal(r.records[0]?.id,first);assert.equal(r.records[0]?.cwd,parent);assert.equal(r.records[0]?.childFiles,1);assert.equal(r.records[0]?.cwds.length,2);
});

test('head census reads Desktop host metadata and excludes unrelated JSONL fixtures',async t=>{
 const home=fixture(t);const root=path.join(home,'Library/Application Support/Claude/local-agent-mode-sessions/account/project');
 write(path.join(root,'sessions',first+'.jsonl'),[{type:'user',sessionId:first,timestamp:'2026-01-01T00:00:00Z'}]);
 write(path.join(root,'examples.jsonl'),[{expected_skill:'synthetic',intent:'private-content-not-exported'}]);
 write(path.join(root,second+'.json'),[{sessionId:second,cliSessionId:first,cwd:path.join(home,'desktop-cwd'),createdAt:Date.UTC(2026,0,1),lastActivityAt:Date.UTC(2026,0,2)}]);
 const r=await loadNativeHeads(home);assert.equal(r.counts.skippedDesktopNonSessionFiles,1);assert.equal(r.records.length,1);assert.equal(r.records[0]?.source,'claude-desktop');assert.deepEqual(r.records[0]?.identityAliases,[second]);assert.equal(r.records[0]?.lastAt,'2026-01-02T00:00:00.000Z');assert.equal(r.records[0]?.cwd,path.join(home,'desktop-cwd'));
});

test('head oracle full pass never promotes a later session_meta remote over the initial absent or present value',async t=>{
 const home=fixture(t);const root=path.join(home,'.codex/sessions');
 for(const [id,initial]of [[first,null],[second,'https://example.test/synthetic/first.git']]as const){
   write(path.join(root,`rollout-${id}.jsonl`),[
     {type:'session_meta',payload:{id,cwd:path.join(home,'synthetic-first'),...(initial?{git:{repository_url:initial}}:{})}},
     {type:'session_meta',payload:{id:'later-unrelated',cwd:path.join(home,'synthetic-later'),git:{repository_url:'https://example.test/synthetic/later.git'}}},
   ]);
 }
 const result=await loadNativeHeads(home,new Set([hash('codex:'+first),hash('codex:'+second)]));
 const absent=result.records.find(r=>r.id===first)!;assert.equal(absent.initialMetadataRemote,null);assert.deepEqual(absent.metadataRemotes,['https://example.test/synthetic/later.git']);
 const present=result.records.find(r=>r.id===second)!;assert.equal(present.initialMetadataRemote,'https://example.test/synthetic/first.git');assert.equal(present.metadataRemotes.length,2);
});
