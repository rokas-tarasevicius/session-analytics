import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { localClock } from '../../src/metrics/velocity.ts';
import { boundedTimestamp as timestamp } from '../../src/metrics/bounded-time.ts';
import { localDay } from '../../src/public/velocity-data.js';
import { calendarDay, inUtcWindow } from '../../verify/time/calendar-oracle.ts';

test('time-calendar: malformed calendar days never become dated velocity or limits usage', () => {
  assert.equal(localClock('2026-02-30T12:00:00Z'), null);
  assert.equal(timestamp('2026-02-30T12:00:00Z'), null);
  assert.equal(localDay('2026-02-30T12:00:00Z', 'UTC'), null);
});

test('time-calendar: offset-free limits timestamps normalize as UTC before entering absolute velocity clocks', () => {
  const script = `
    import { localClock } from './src/metrics/velocity.ts';
    import { boundedTimestamp as timestamp } from './src/metrics/bounded-time.ts';
    console.log(JSON.stringify({ limits: timestamp('2026-09-01T00:30:00'), velocity: localClock(timestamp('2026-09-01T00:30:00')) }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'Europe/London' } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { limits: '2026-09-01T00:30:00.000Z', velocity: { day: '2026-09-01', hour: 1 } });
  assert.equal(localClock('2026-09-01T00:30:00'),null);
  assert.equal(localDay('2026-09-01T00:30:00','UTC'),null);
});

test('time-calendar: London DST folds clock hours and preserves UTC window boundaries', () => {
  const script = `
    import { localClock } from './src/metrics/velocity.ts';
    console.log(JSON.stringify(['2026-03-29T00:30:00Z','2026-03-29T01:30:00Z','2026-10-25T00:30:00Z','2026-10-25T01:30:00Z','2026-10-25T02:30:00Z'].map(localClock)));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'Europe/London' } });
  assert.equal(child.status, 0, child.stderr);
  const clocks = JSON.parse(child.stdout);
  assert.deepEqual(clocks.map((x: {hour: number})=>x.hour), [0,2,1,1,2]);
  assert.equal(calendarDay('2026-09-30T23:30:00Z','Europe/London'),'2026-10-01');
  assert.equal(inUtcWindow('2026-10-25T23:59:59.999Z','2026-10-25','2026-10-25'),true);
  assert.equal(inUtcWindow('2026-10-26T00:00:00Z','2026-10-25','2026-10-25'),false);
});
