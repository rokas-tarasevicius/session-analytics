import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { timestamp } from '../../src/mcp/names.ts';
const source=new URL('../../src/mcp/names.ts',import.meta.url).href;

test('time-mcp: offset-free UTC metadata cannot move into the previous MCP day',()=>{
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import { timestamp } from ${JSON.stringify(source)};console.log(JSON.stringify(timestamp('2026-09-01T00:30:00')));`],{encoding:'utf8',env:{...process.env,TZ:'Europe/London'}});
 assert.equal(child.status,0);
 assert.equal(JSON.parse(child.stdout),'2026-09-01T00:30:00.000Z');
});

test('time-mcp: supported SQLite UTC timestamps remain timestamped',()=>{
 assert.equal(timestamp('2026-09-01 00:30:00'),'2026-09-01T00:30:00.000Z');
});

test('time-mcp: impossible calendar days never become another MCP month',()=>{
 assert.equal(timestamp('2026-02-30T12:00:00Z'),null);
 assert.equal(timestamp('2026-08-31T24:00:00Z'),null);
});

test('time-mcp: explicit UTC offsets and malformed content preserve their existing treatment',()=>{
 assert.equal(timestamp('2026-09-01T00:30:00+01:00'),'2026-08-31T23:30:00.000Z');
 assert.equal(timestamp('synthetic-private-message'),null);
 assert.equal(timestamp(null),null);
});
