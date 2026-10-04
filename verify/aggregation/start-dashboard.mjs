import './safe-failures.mjs';
// One serialized live smoke run. Private snapshots are never persisted.
import { mkdir, rmdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
const lock='/tmp/session-analytics-realscan.lock';
let acquired=false,child,released=false,finished=false;
const json=url=>new Promise((resolve,reject)=>{const req=get(url,res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())});}catch{reject(Error('Invalid safe response'))}})});req.on('error',()=>reject(Error('Local dashboard unavailable')));});
async function release(){if(acquired&&!released){released=true;await rmdir(lock);}}
async function stop(){if(child&&child.exitCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);}await release();}
process.on('SIGTERM',()=>{void stop().then(()=>process.exit());});process.on('SIGINT',()=>{void stop().then(()=>process.exit());});
const deadline=Date.now()+20*60_000;
try {
 while(!acquired){if(Date.now()>deadline)throw Error('Shared scan lock wait expired');try{await mkdir(lock);acquired=true;}catch{await delay(5000);}}
 console.log('Acquired real-scan lock');
 child=spawn(process.execPath,['bin/session-analytics.ts','--no-index','--no-open','--port','4220'],{env:{...process.env,SESSION_ANALYTICS_OFFLINE:'1',SESSION_ANALYTICS_DATA_DIR:process.cwd()+'/.lane/data'},stdio:'ignore'});
 for(let i=0;i<100;i++){try{await json('http://127.0.0.1:4220/api/health');break;}catch{await delay(200);}}
 const response=await Promise.race([json('http://127.0.0.1:4220/api/analytics'),delay(15*60_000).then(()=>{throw Error('Live scan deadline exceeded')})]);
 console.log(JSON.stringify({httpStatus:response.status,generatedAt:response.data.generatedAt,sessions:response.data.sessions?.length,summary:response.data.summary}));
 finished=true;await release();console.log('Released real-scan lock; dashboard remains running');
} catch {console.log('Live dashboard scan did not complete; no raw error or data retained');await stop();process.exitCode=1;}
if(!finished)await stop();
