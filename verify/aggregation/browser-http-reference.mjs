/** Actual production HTTP server, disposable schema-only staging; no real-history scan. */
import { cpSync,mkdirSync,readFileSync,readdirSync,writeFileSync,statSync,existsSync } from 'node:fs';
import { resolve,join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
const root=process.cwd(),stage=resolve('.lane/reference-server'),reference=fileURLToPath(new URL('../../../reference/snapshot-noindex-51ea561.json',import.meta.url));
mkdirSync(stage,{recursive:true});
for(const name of ['src','bin','schemas','data'])cpSync(join(root,name),join(stage,name),{recursive:true,force:true});
cpSync('package.json',join(stage,'package.json'));mkdirSync(join(stage,'scripts'),{recursive:true});cpSync('scripts/metric-schema.ts',join(stage,'scripts/metric-schema.ts'));
const patch=spawnSync('patch',['-p1','-i',resolve('.lane/fixes/AGG-009.patch')],{cwd:stage,encoding:'utf8'});
if(patch.status!==0)throw Error('Schema-only patch failed to apply');
const files=(dir)=>readdirSync(dir).flatMap(name=>{const p=join(dir,name);return statSync(p).isDirectory()?files(p):[p]});
const changed=files(stage).filter(p=>existsSync(join(root,relative(stage,p)))&&!readFileSync(p).equals(readFileSync(join(root,relative(stage,p))))).map(p=>relative(stage,p)).sort();
if(!isDeepStrictEqual(changed,['schemas/snapshot.v1.schema.json','scripts/metric-schema.ts']))throw Error('Staging differs beyond the two schema patch files');
const result={mode:'production-http-schema-only-staging',appliedPatch:'AGG-009',stagedChanges:changed,realHistoryScan:false,browser:false,checks:[],numericLeaves:0,numericMismatches:0,shapeMismatches:0};
const check=(name,actual,expected)=>{result.checks.push({name,actual,expected});if(!isDeepStrictEqual(actual,expected))process.exitCode=1};
const child=spawn(process.execPath,['bin/session-analytics.ts','--snapshot',reference,'--no-open','--port','4223'],{cwd:stage,env:{...process.env,SESSION_ANALYTICS_DATA_DIR:resolve('.lane/data'),SESSION_ANALYTICS_OFFLINE:'1'},stdio:['ignore','ignore','pipe']});
let childError=false;child.stderr.on('data',()=>{childError=true});
try{
 const origin='http://127.0.0.1:4223';let health;
 for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error('Schema-only server exited');try{health=await(await fetch(origin+'/api/health')).json();if(health.status==='ok')break}catch{}await delay(100)}
 check('health.status',health?.status,'ok');check('health.dataSource',health?.dataSource,'snapshot');
 const response=await fetch(origin+'/api/analytics');check('analytics.status',response.status,200);
 if(response.status!==200)throw Error('Reference rejected after schema-only patch');
 const actual=await response.json(),expected=JSON.parse(readFileSync(reference,'utf8'));
 function compare(a,b){if(typeof b==='number'){result.numericLeaves++;if(!Object.is(a,b))result.numericMismatches++;return}if(Array.isArray(b)){if(!Array.isArray(a)||a.length!==b.length){result.shapeMismatches++;return}for(let i=0;i<b.length;i++)compare(a[i],b[i]);return}if(b&&typeof b==='object'){if(!a||typeof a!=='object'||!isDeepStrictEqual(Object.keys(a).sort(),Object.keys(b).sort())){result.shapeMismatches++;return}for(const key of Object.keys(b))compare(a[key],b[key]);}}
 compare(actual,expected);check('completeNumericProjection.mismatches',result.numericMismatches,0);check('completeNumericProjection.shapeMismatches',result.shapeMismatches,0);check('completeSnapshot.deepEqual',isDeepStrictEqual(actual,expected),true);
 result.summary={sessions:actual.sessions.length,repositories:actual.repositories.length,apiEquivalentSpendUsd:actual.summary.apiEquivalentSpendUsd,providerReportedSpendUsd:actual.summary.providerReportedSpendUsd,estimatedSpendUsd:actual.summary.estimatedSpendUsd,totalInputTokens:actual.summary.totalInputTokens,outputTokens:actual.summary.outputTokens};
 health=await(await fetch(origin+'/api/health')).json();check('health.ready',health.snapshot,'ready');
 const source=readFileSync(join(stage,'src/static-routes.ts'),'utf8');
 const assets=[...source.matchAll(/\["(\/[^"\n]*)",\s*"/g)].map(x=>x[1]);const fetched=new Map();
 const expectedCsp="default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
 for(const asset of assets){const r=await fetch(origin+asset),body=await r.text();fetched.set(asset,body);check(`asset.${asset}.status`,r.status,200);check(`asset.${asset}.nonempty`,body.length>0,true);check(`asset.${asset}.csp`,r.headers.get('content-security-policy'),expectedCsp);check(`asset.${asset}.nosniff`,r.headers.get('x-content-type-options'),'nosniff');if(asset.endsWith('.js'))check(`asset.${asset}.javascriptMime`,r.headers.get('content-type')?.includes('javascript'),true);}
 const importUrls=new Set();for(const [asset,body]of fetched){if(!asset.endsWith('.js'))continue;for(const m of body.matchAll(/(?:from\s*|import\s*)["']([./][^"']+\.js)["']/g))importUrls.add(new URL(m[1],origin+asset).pathname);for(const m of body.matchAll(/new\s+URL\(["']([./][^"']+\.js)["']\s*,\s*import\.meta\.url/g))importUrls.add(new URL(m[1],origin+asset).pathname);}
 for(const asset of importUrls){check(`import.${asset}.allowlisted`,assets.includes(asset),true);if(!fetched.has(asset)){const r=await fetch(origin+asset);check(`import.${asset}.status`,r.status,200);}}
 check('analytics.csp',response.headers.get('content-security-policy'),expectedCsp);check('analytics.cacheControl',response.headers.get('cache-control'),'no-store');
 result.staticAssets=assets.length;result.importTargets=importUrls.size;result.childWroteStderr=childError;
}catch(error){result.failure=error.message;process.exitCode=1}
finally{
 if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await Promise.race([exited,delay(5000)]);}
 result.serverStopped=child.exitCode!==null||child.signalCode!==null;
 result.failedChecks=result.checks.filter(c=>!isDeepStrictEqual(c.actual,c.expected)).length;
 writeFileSync('.lane/browser-http-reference.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({mode:result.mode,numericLeaves:result.numericLeaves,numericMismatches:result.numericMismatches,shapeMismatches:result.shapeMismatches,checks:result.checks.length,failedChecks:result.failedChecks,staticAssets:result.staticAssets,importTargets:result.importTargets,serverStopped:result.serverStopped,failure:result.failure}));
}
