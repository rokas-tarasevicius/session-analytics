import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNative } from './native-oracle.ts';
test('native oracle deduplicates root aliases, joins child metadata, and observes live tails', async () => {
 const home=mkdtempSync(join(tmpdir(),'repo-oracle-'));
 const saved={CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR,CODEX_HOME:process.env.CODEX_HOME};
 delete process.env.CLAUDE_CONFIG_DIR;delete process.env.CODEX_HOME;
 try {
 const put=(p:string,records:unknown[])=>{p=join(home,p);mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,records.map(r=>JSON.stringify(r)).join('\n')+'\n');};
 put('.claude/projects/synthetic/primary.jsonl',[{type:'user',cwd:'/synthetic/project',sessionId:'primary',timestamp:'2026-01-01T00:00:00Z'}]);
 put('.claude/projects/synthetic/primary/subagents/child.jsonl',[{type:'assistant',cwd:'/synthetic/project',timestamp:'2026-01-02T00:00:00Z'}]);
 put('.codex/sessions/rollout.jsonl',[{type:'session_meta',timestamp:'2026-02-01T00:00:00Z',payload:{id:'codex-id',cwd:'/synthetic/project',git:{repository_url:'https://example.test/owner/repo.git'}}},{type:'turn_context',timestamp:'2026-02-02T00:00:00Z',payload:{cwd:'/synthetic/other'}},{type:'session_meta',timestamp:'2026-02-03T00:00:00Z',payload:{id:'resumed-metadata',cwd:'/synthetic/other'}}]);
 symlinkSync(join(home,'.codex'),join(home,'.codex-alias'));
 const data=await loadNative(home);
 assert.equal(data.counts.files,3);assert.equal(data.records.length,2);
 const claude=data.records.find(r=>r.provider==='claude')!;
 assert.equal(claude.id,'primary');assert.equal(claude.files.length,2);assert.equal(claude.childFiles,1);assert.equal(claude.lastAt,'2026-01-02T00:00:00.000Z');
 const codex=data.records.find(r=>r.provider==='codex')!;
 assert.equal(codex.id,'codex-id');assert.equal(codex.metadataIds.length,2);assert.equal(codex.cwds.length,2);assert.equal(codex.metadataRemotes.length,1);
 } finally {rmSync(home,{recursive:true,force:true});for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});

test('native full oracle pins repository metadata to the first session_meta including an absent remote', async () => {
 const home=mkdtempSync(join(tmpdir(),'repo-oracle-first-remote-'));
 const saved={CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR,CODEX_HOME:process.env.CODEX_HOME};
 delete process.env.CLAUDE_CONFIG_DIR;delete process.env.CODEX_HOME;
 try {
 const root=join(home,'.codex/sessions');mkdirSync(root,{recursive:true});
 for(const initial of [null,'https://example.test/synthetic/first.git']) {
   const id=initial?'with-remote':'without-remote';
   writeFileSync(join(root,id+'.jsonl'),[
     {type:'session_meta',payload:{id,cwd:'/synthetic/first',...(initial?{git:{repository_url:initial}}:{})}},
     {type:'session_meta',payload:{id:'unrelated-later',cwd:'/synthetic/later',git:{repository_url:'https://example.test/synthetic/later.git'}}},
   ].map(r=>JSON.stringify(r)).join('\n')+'\n');
 }
 const result=await loadNative(home);
 const absent=result.records.find(r=>r.id==='without-remote')!;assert.equal(absent.initialMetadataRemote,null);assert.deepEqual(absent.metadataRemotes,['https://example.test/synthetic/later.git']);
 const present=result.records.find(r=>r.id==='with-remote')!;assert.equal(present.initialMetadataRemote,'https://example.test/synthetic/first.git');assert.equal(present.metadataRemotes.length,2);
 }finally{rmSync(home,{recursive:true,force:true});for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
