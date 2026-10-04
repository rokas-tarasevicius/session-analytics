import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';

// U+2028/U+2029 are valid unescaped JSON string characters, not JSONL delimiters.
for (const [label, separator] of [['U+2028', '\u2028'], ['U+2029', '\u2029']] as const) {
  test(`DEDUP-CX-10: Claude final usage snapshot survives literal ${label}`, async () => {
    const root=await mkdtemp(join(tmpdir(),'dedup-claude-framing-'));
    try {
      const claudeRoot=join(root,'claude'),codexRoot=join(root,'codex');
      await mkdir(claudeRoot);await mkdir(codexRoot);
      const id='11111111-1111-4111-8111-111111111111', at='2026-09-01T10:00:00.000Z';
      const record=(output:number,text:string)=>({type:'assistant',sessionId:id,cwd:'/synthetic/claude-framing',timestamp:at,uuid:'synthetic-stream-block-'+output,requestId:'synthetic-request',message:{id:'synthetic-response',model:'claude-opus-5',content:[{type:'text',text}],usage:{input_tokens:100,output_tokens:output},stop_reason:'end_turn'}});
      const final=JSON.stringify(record(50,'private-framing-sentinel'+separator+'synthetic-tail'));
      assert.ok(final.includes(separator));JSON.parse(final);
      await writeFile(join(claudeRoot,id+'.jsonl'),JSON.stringify(record(3,'synthetic-partial'))+'\n'+final+'\n');
      const result=await analyzeMachineSessions({claudeRoot,codexRoot,codexArchiveRoot:join(root,'archive'),databasePath:join(root,'missing-conductor.db'),cursorDatabasePath:join(root,'missing-cursor.db'),dataDir:join(root,'data'),noIndex:true,additionalProviders:false,pricingPolicy:'reviewed-only'});
      assert.doesNotMatch(JSON.stringify(result),/private-framing-sentinel/);
      assert.equal(result.sessions.length,1);
      assert.equal(result.sessions[0]!.tokens.inputTokens,100);
      assert.equal(result.sessions[0]!.tokens.outputTokens,50,'valid final response snapshot must supersede the streamed partial counter');
      assert.equal(result.sessions[0]!.metrics.modelCalls,1);
    } finally {await rm(root,{recursive:true,force:true});}
  });
}
