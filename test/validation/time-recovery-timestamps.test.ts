import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { timestamp } from '../../src/providers/common.ts';

const commonUrl = new URL('../../src/providers/common.ts', import.meta.url).href;
const conductorUrl = new URL('../../src/providers/conductor.ts', import.meta.url).href;
function evaluate(source: string, zone: string) {
 const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding:'utf8', env:{...process.env,TZ:zone} });
 assert.equal(result.status,0, 'Synthetic child must complete');
 return JSON.parse(result.stdout);
}

test('TIME-RECOVERY-TZ: offset-free provider/database times mean UTC in every host timezone', () => {
 for (const zone of ['Europe/London','America/New_York','UTC']) {
  const actual = evaluate(`import { timestamp } from ${JSON.stringify(commonUrl)}; console.log(JSON.stringify(timestamp('2026-08-01 00:30:00')));`,zone);
  assert.equal(actual,'2026-08-01T00:30:00.000Z',zone);
 }
});

test('TIME-RECOVERY-TZ: invalid calendar dates and 24:00 never become another date', () => {
 for(const value of ['2026-02-30T12:00:00Z','2026-04-31T12:00:00Z','2026-07-31T24:00:00Z']) {
  assert.equal(timestamp(value),null,value);
 }
});

test('TIME-RECOVERY-TZ: recovery does not move an offset-free August session into July', () => {
 const actual = evaluate(`
 import { DatabaseSync } from 'node:sqlite';
 import { conductorFallback } from ${JSON.stringify(conductorUrl)};
 import { zeroCost } from ${JSON.stringify(commonUrl)};
 const db = new DatabaseSync(':memory:');
 db.exec('CREATE TABLE session_messages (id TEXT, session_id TEXT, content TEXT, created_at TEXT)');
 db.prepare('INSERT INTO session_messages VALUES (?,?,?,?)').run('synthetic-receipt','synthetic-session',JSON.stringify({type:'result',uuid:'synthetic-receipt',session_id:'synthetic-provider',total_cost_usd:2,usage:{input_tokens:100,output_tokens:20}}),'2026-08-01 01:00:00');
 const [session] = conductorFallback(db,[{conductor_session_id:'synthetic-session',provider_session_id:'synthetic-provider',agent_type:'claude',status:'completed',created_at:'2026-08-01 00:30:00',updated_at:'2026-08-01 01:00:00',repository_id:'example',repository_name:'Example'}],new Set(),{rateCard:{currency:'USD',effectiveDate:'2026-08-01',models:{}},price:()=>zeroCost()});
 console.log(JSON.stringify({createdAt:session.createdAt,updatedAt:session.updatedAt,spendByDay:session.spendByDay,cost:session.cost.totalUsd}));
 db.close();`, 'Europe/London');
 assert.equal(actual.createdAt,'2026-08-01T00:30:00.000Z');
 assert.equal(actual.updatedAt,'2026-08-01T01:00:00.000Z');
 assert.deepEqual(actual.spendByDay,{},'Cumulative recovery must remain undated');
 assert.equal(actual.cost,2);
});

test('time recovery invariant: explicit offsets normalize, numeric millisecond timestamps remain supported', () => {
 assert.equal(timestamp('2026-08-01T00:30:00+01:00'),'2026-07-31T23:30:00.000Z');
 assert.equal(timestamp(Date.parse('2026-08-01T00:30:00Z')),'2026-08-01T00:30:00.000Z');
 assert.equal(timestamp('sentinel-private-message'),null);
});
