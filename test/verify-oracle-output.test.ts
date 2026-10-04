import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,mkdir,writeFile,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{fileURLToPath}from'node:url';import{spawnSync}from'node:child_process';
test('imported dedup producers write the exact consumer filenames inside the fresh workspace',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'verify-dedup-output-'));
 try{
  const fakeHome=join(directory,'empty-provider-home');await mkdir(fakeHome);await mkdir(join(directory,'.lane'));
  const snapshot=join(directory,'snapshot.json');await writeFile(snapshot,JSON.stringify({generatedAt:'2026-01-01T00:00:00Z',sessions:[]}));
  const preload=join(directory,'fake-home.mjs');await writeFile(preload,`import os from'node:os';import{syncBuiltinESMExports}from'node:module';os.homedir=()=>${JSON.stringify(fakeHome)};syncBuiltinESMExports();`);
  const env:NodeJS.ProcessEnv={...process.env,SESSION_ANALYTICS_VERIFY_REFERENCE:snapshot,NODE_NO_WARNINGS:'1'};delete env.CODEX_HOME;
  for(const [script,artifact]of [['codex-oracle.ts','codex-oracle-initial.json'],['adapters-oracle.ts','adapters-oracle.json']]){
   const child=spawnSync(process.execPath,['--import',preload,'--import',fileURLToPath(new URL('../scripts/verify-reference.mjs',import.meta.url)),fileURLToPath(new URL('../verify/dedup/'+script,import.meta.url))],{cwd:directory,encoding:'utf8',env});
   assert.equal(child.status,0,'Synthetic collector must complete');assert.equal(typeof JSON.parse(await readFile(join(directory,'.lane',artifact!),'utf8')),'object');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
