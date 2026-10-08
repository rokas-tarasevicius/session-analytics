import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { NO_REPOSITORY_ID, globalInventoryRoots, inventoryRootCandidates, inventorySkillRoots } from '../verify/repos/inventory-roots.ts';
const id=(namespace:string,value:string)=>namespace+'-'+createHash('sha256').update(value).digest('hex').slice(0,20);
test('directories without repository evidence share one rootless group; temporary ones share the ephemeral root',()=>{
 const outside=`/inventory-fixture-${process.pid}`,ephemeral=id('discovered','/private/var/folders/session-analytics-ephemeral');
 const result=inventoryRootCandidates([],[{cwd:join(outside,'home')},{cwd:join(outside,'home/Downloads/scratch')},{cwd:'/private/tmp/synthetic-run'}],new Set([NO_REPOSITORY_ID,ephemeral]));
 assert.deepEqual(result.get(NO_REPOSITORY_ID),[]);
 assert.deepEqual(result.get(ephemeral),['/private/var/folders/session-analytics-ephemeral']);
 const bridge=inventorySkillRoots(result,new Set([NO_REPOSITORY_ID]),[]);
 assert.deepEqual(bridge.coverage,[{repositoryId:NO_REPOSITORY_ID,candidates:0,status:'rootless'}]);
 assert.deepEqual(bridge.failures,[]);assert.deepEqual(bridge.roots,[]);
 // Without evidence that any session used the group, absence still fails.
 assert.deepEqual(inventorySkillRoots(new Map(),new Set([NO_REPOSITORY_ID]),[]).failures,[`repository:${NO_REPOSITORY_ID}:missing`]);
});
test('independent inventory roots retain authoritative registered and home-directory mappings',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'inventory-roots-')),root=await realpath(temporary);
 try {await mkdir(join(root,'.git'));await writeFile(join(root,'.git/config'),'');const selected=new Set([id('conductor','conductor:synthetic'),id('discovered',root),id('conductor','conductor:unassigned:conductor')]);const result=inventoryRootCandidates([{id:'synthetic',root_path:join(root,'registered')}],[{cwd:root}],selected);assert.deepEqual(result.get(id('discovered',root)),[root]);assert.deepEqual(result.get(id('conductor','conductor:synthetic')),[join(root,'registered')]);assert.deepEqual(result.get(id('conductor','conductor:unassigned:conductor')),[resolve('unassigned:conductor')]);assert.equal(result.size,3);}finally{await rm(root,{recursive:true,force:true});}
});
test('inventory scope bridge rejects missing and ambiguous repositories instead of merging them',()=>{
 const candidates=new Map([['one',['/synthetic/one']],['two',['/synthetic/a','/synthetic/b']],['unassigned',[]]]);
 const result=inventorySkillRoots(candidates,new Set(['one','two','unassigned','missing']),[]);
 assert.equal(result.roots.length,3);
 assert.ok(result.roots.every(row=>row.repositoryId==='one'));
 assert.deepEqual(result.coverage.map(row=>[row.repositoryId,row.status]),[['missing','missing'],['one','resolved'],['two','ambiguous'],['unassigned','missing']]);
 assert.deepEqual(result.failures,['repository:missing:missing','repository:two:ambiguous','repository:unassigned:missing']);
 assert.equal(result.alternatives.length,1);assert.equal(result.alternatives[0]!.candidates.length,2);assert.ok(result.alternatives[0]!.candidates.every(roots=>roots.length===3));
});
test('independent global inventory follows existing stores and explicit profile roots',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'inventory-profiles-')));
 try{await mkdir(join(root,'.claude-extra','projects'),{recursive:true});await mkdir(join(root,'explicit-codex','archived_sessions'),{recursive:true});await mkdir(join(root,'.codex-no-history'),{recursive:true});
 const roots=globalInventoryRoots(root,{CODEX_HOME:join(root,'explicit-codex')});assert.equal(roots.length,5);assert.ok(roots.every(row=>row.repositoryId===null));assert.ok(roots.some(row=>row.path===join(root,'.claude-extra','skills')));assert.ok(roots.some(row=>row.path===join(root,'explicit-codex','skills')));assert.ok(!roots.some(row=>row.path.includes('.codex-no-history')));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('independent inventory roots preserve ambiguity between two physical clones of one remote',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'inventory-clones-')),root=await realpath(temporary);
 try {for(const name of ['first','second']){await mkdir(join(root,name,'.git'),{recursive:true});await writeFile(join(root,name,'.git/config'),'[remote "origin"]\nurl = https://example.invalid/owner/project.git\n');}const key=id('discovered','remote:example.invalid/owner/project'),result=inventoryRootCandidates([],[{cwd:join(root,'first')},{cwd:join(root,'second')}],new Set([key]));assert.deepEqual(result.get(key),[join(root,'first'),join(root,'second')]);}finally{await rm(root,{recursive:true,force:true});}
});
