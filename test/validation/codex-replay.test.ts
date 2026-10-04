import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,context,counter,response,usage,timestamp} from './codex-fixture.ts';
const parent='33333333-3333-4333-8333-333333333333',child='44444444-4444-4444-8444-444444444444';
test('CODEX-02: replayed ancestor request keeps original thread and model',async()=>fixture(async f=>{
 const old=usage(1000,100,500),fresh=usage(200,20,100);
 await f.write(parent,[context(1,'gpt-6-astra'),response(2),counter(4,old,old)]);
 // Fork replay rebases event timestamps. Copied response has zero activity gap
 // but its counter already existed in the ancestor before the fork was born.
 await f.write(child,[{type:'session_meta',timestamp:timestamp(10),payload:{id:child,cwd:f.root,source:'cli',forked_from_id:parent}},context(11),response(12),counter(12,old,old),response(13,'fresh'),counter(14,usage(1200,120,600),fresh)],{timestamp:timestamp(10),forked_from_id:parent});
 const result=await f.analyze();
 const p=result.sessions.find(s=>s.models.some(m=>m.model==='gpt-6-astra'));
 const c=result.sessions.find(s=>s.models.some(m=>m.model==='gpt-5.6-sol'));
 assert.equal(p?.tokens.inputTokens,1000,'Historical request remains on its original model/thread');
 assert.equal(c?.tokens.inputTokens,200,'Only the new child request is charged to child');
 assert.equal(result.summary.totalInputTokens,1200);
}));

test('CODEX-02: later closer duplicate cannot erase the ancestor observation before fork birth',async()=>fixture(async f=>{
 const old=usage(1700,170,700),fresh=usage(300,30,100);
 await f.write(parent,[context(1,'gpt-6-astra'),response(2),counter(4,old,old),
  response(20,'later-ancestor-activity'),counter(20,old,old)]);
 await f.write(child,[context(11),response(12),counter(12,old,old),
  response(13,'fresh-child-response'),counter(14,usage(2000,200,800),fresh)],
  {timestamp:timestamp(10),forked_from_id:parent});
 const result=await f.analyze();
 const p=result.sessions.find(s=>s.models.some(m=>m.model==='gpt-6-astra'));
 const c=result.sessions.find(s=>s.models.some(m=>m.model==='gpt-5.6-sol'));
 assert.equal(p?.tokens.inputTokens,1700,'Earliest ancestor observation proves replay even when nearest activity selects its later duplicate');
 assert.equal(c?.tokens.inputTokens,300);
 assert.equal(result.summary.totalInputTokens,2000);
}));

test('CODEX-02 control: ancestry uses payload birth without changing public wrapper timestamp',async()=>fixture(async f=>{
 const u=usage(1900,190,900);
 await f.write(parent,[context(1,'gpt-6-astra'),response(2),counter(20,u,u)]);
 await f.write(child,[context(31),response(32),counter(32,u,u)],{timestamp:timestamp(10),forked_from_id:parent});
 const file=join(f.root,'sessions',`rollout-${child}.jsonl`);
 const records=(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {timestamp:string});
 records[0]!.timestamp=timestamp(30);
 await writeFile(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const result=await f.analyze();
 const c=result.sessions.find(s=>s.models.some(m=>m.model==='gpt-5.6-sol'));
 assert.equal(c?.tokens.inputTokens,1900,'Ancestor state observed after true fork birth is not proof of inherited replay');
 assert.equal(c.createdAt,timestamp(30),'Private fork provenance must not silently change existing public createdAt semantics');
}));
