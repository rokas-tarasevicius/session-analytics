// Validate proposals in a disposable copy. Never alter the working tree's src/.
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=process.cwd();
const scratch=mkdtempSync(join(tmpdir(),'session-time-patches-'));
for(const path of ['src','test','verify','data','scripts','bin','schemas','docs','README.md','package.json','tsconfig.json'])cpSync(join(root,path),join(scratch,path),{recursive:true});
symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir');
let log='Disposable source copy; original src is untouched.\n';
for(const file of readdirSync('.lane/fixes').filter(f=>f.endsWith('.patch')).sort()) {
  const applied=spawnSync('patch',['-p1','--batch','--forward'],{cwd:scratch,input:readFileSync(join(root,'.lane/fixes',file)),encoding:'utf8'});
  log+=`\n${file}\n${applied.stdout}${applied.stderr}`;
  if(applied.status!==0){writeFileSync('.lane/patch-check.log',log);process.exit(1);}
}
const tests=readdirSync(join(scratch,'test/validation')).filter(f=>/^time-.*\.test\.ts$/.test(f)).map(f=>`test/validation/${f}`);
const existing = ['test/interop-timestamps.test.ts','test/dashboard-helpers.test.ts','test/velocity.test.ts','test/analyzer.test.ts','test/providers.test.ts','test/interop.test.ts'];
const run=spawnSync(process.execPath,['--test','--test-concurrency=2',...tests,...existing],{cwd:scratch,encoding:'utf8',timeout:600000});
log+=`\n${run.stdout}${run.stderr}\nexit=${run.status}\n`;
const types=spawnSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--noEmit'],{cwd:scratch,encoding:'utf8',timeout:120000});
log+=`\nPatched typecheck: ${types.status}\n${types.stdout}${types.stderr}`;
writeFileSync('.lane/patch-check.log',log);
console.log(JSON.stringify({patches:readdirSync('.lane/fixes').filter(f=>f.endsWith('.patch')).length,testExit:run.status,typecheckExit:types.status}));
process.exitCode=run.status===0&&types.status===0?0:1;
