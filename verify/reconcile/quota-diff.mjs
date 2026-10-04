import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Run only after quota.mjs: this file is the explicit reference comparison stage.
try {
  const home = homedir();
  const raw = JSON.parse(await readFile(join(home, 'Library/Application Support/Claude/plan-usage-history.json'), 'utf8'));
  const snapshot = JSON.parse(await readFile(join(home, 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'), 'utf8'));
  const quota = JSON.parse(await readFile('.lane/quota-aggregates.json', 'utf8'));
  const rawProfiles = new Map();
  for (const point of raw.samples ?? []) {
    const at = new Date(point.t).toISOString();
    if (at > snapshot.generatedAt || typeof point.org !== 'string') continue;
    const key = `profile-${createHash('sha256').update(`claude:desktop:${point.org}`).digest('hex').slice(0,20)}`;
    const windows = rawProfiles.get(key) ?? new Map();
    for (const [field, minutes] of [['fh',300],['sd',10080]]) {
      const value = point.u?.[field];
      if (typeof value !== 'number' || value < 0 || value > 100) continue;
      const series = windows.get(minutes) ?? new Map();
      series.set(at, Math.max(series.get(at) ?? -1, value));
      windows.set(minutes, series);
    }
    rawProfiles.set(key, windows);
  }
  const desktop = [];
  for (const profile of snapshot.limitsCache.profiles.filter((p) => p.scope === 'desktop-account')) {
    for (const window of profile.windows) {
      const rawSeries = rawProfiles.get(profile.key)?.get(window.windowMinutes) ?? new Map();
      const mismatches = window.timeline.filter((point) => rawSeries.get(point.timestamp) !== point.usedPercent).length;
      const ordered = [...rawSeries].sort(([a],[b])=>a.localeCompare(b));
      desktop.push({profileKey:profile.key,windowMinutes:window.windowMinutes,rawSamples:rawSeries.size,
        referenceObservations:window.observations,referenceTimelineSamples:window.timeline.length,timelineMismatches:mismatches,
        latestMatches:ordered.at(-1)?.[0] === window.latest.timestamp && ordered.at(-1)?.[1] === window.latest.usedPercent,
        staleHeadroomCorrect:Date.parse(snapshot.generatedAt)-Date.parse(window.latest.timestamp)>15*60000 && window.stale && window.headroomPercent===null});
    }
  }
  const result={cutoff:snapshot.generatedAt,desktop,codexbar:{
    accountsByProvider:Object.fromEntries(['claude','codex'].map((p)=>[p,new Set(quota.codexbar.filter((w)=>w.provider===p).map((w)=>w.accountKey)).size])),
    samplesAtOrBeforeCutoff:quota.codexbar.reduce((n,w)=>n+w.samples,0),
    samplesAfterCutoff:quota.codexbar.reduce((n,w)=>n+w.excludedAfterCutoff,0),
    referenceObservationsWithCodexbarSource:snapshot.limitsCache.profiles.reduce((n,p)=>n+p.windows.reduce((k,w)=>k+w.timeline.filter((t)=>t.source==='codexbar').length,0),0),
    interpretation:'CodexBar is not ingested. No account-to-profile mapping or conversion from quota percentage to tokens/dollars is established.'}};
  await writeFile('.lane/quota-diff.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result));
} catch { console.error('Quota comparison failed; raw error suppressed.'); process.exitCode=1; }
