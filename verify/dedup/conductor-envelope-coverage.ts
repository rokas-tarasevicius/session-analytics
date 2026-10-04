/** Exhaustive JSON-type check for the oracle's compact/spaced envelope prefilter. */
import {DatabaseSync} from '../shared/sqlite.ts';import {homedir} from 'node:os';import {join} from 'node:path';import {writeFileSync} from 'node:fs';
process.on('uncaughtException',()=>{console.error('Conductor envelope coverage could not complete a local read.');process.exitCode=1;});
const db=new DatabaseSync(join(homedir(),'Library','Application Support','com.conductor.app','conductor.db'),{readOnly:true});
const coverage:Record<string,unknown>={};
for(const column of ['content','full_message'])coverage[column]=db.prepare(`select count(*) resultRecords,sum(case when instr(${column},'"type":"result"')>0 or instr(${column},'"type": "result"')>0 then 1 else 0 end) patternMatched from session_messages where json_valid(${column}) and json_extract(${column},'$.type')='result'`).get();
writeFileSync('.lane/conductor-envelope-coverage.json',JSON.stringify(coverage,null,2)+'\n');console.log(JSON.stringify(coverage));
