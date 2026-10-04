// Independent raw-store oracle. No production imports and no content in output.
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const cutoff = (process.env.ORACLE_CUTOFF ?? '2026-10-03T12:17:26.745Z');
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const date = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

export function summarizeSeries(points, maxTime = cutoff) {
  const eligible = points.filter((p) => p.at && p.at <= maxTime && finite(p.value))
    .sort((a, b) => a.at.localeCompare(b.at));
  const months = new Map();
  for (const p of eligible) {
    const month = p.at.slice(0, 7);
    const row = months.get(month) ?? { month, samples: 0, min: Infinity, max: -Infinity, first: null, last: null };
    row.samples++;
    row.min = Math.min(row.min, p.value);
    row.max = Math.max(row.max, p.value);
    row.first ??= p.at;
    row.last = p.at;
    months.set(month, row);
  }
  let decreasesWithinWindow = 0;
  let increasesWithinWindow = 0;
  let repeatedSamples = 0;
  for (let i = 1; i < eligible.length; i++) {
    const prev = eligible[i - 1];
    const next = eligible[i];
    if (prev.at === next.at && prev.value === next.value && prev.reset === next.reset) repeatedSamples++;
    if (!prev.reset || prev.reset !== next.reset) continue;
    if (next.value < prev.value) decreasesWithinWindow++;
    if (next.value > prev.value) increasesWithinWindow++;
  }
  return {
    samples: eligible.length,
    excludedAfterCutoff: points.filter((p) => p.at && p.at > maxTime).length,
    invalidSamples: points.filter((p) => !p.at || !finite(p.value)).length,
    first: eligible[0]?.at ?? null,
    last: eligible.at(-1)?.at ?? null,
    latestValue: eligible.at(-1)?.value ?? null,
    distinctResets: new Set(eligible.map((p) => p.reset).filter(Boolean)).size,
    decreasesWithinWindow, increasesWithinWindow, repeatedSamples,
    months: [...months.values()],
  };
}

async function findNamed(root, wanted) {
  const output = [];
  const seen = new Set();
  async function walk(dir) {
    let physical;
    try { physical = await realpath(dir); } catch { return; }
    if (seen.has(physical)) return;
    seen.add(physical);
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === wanted) output.push(join(dir, entry.name));
      else if (entry.isDirectory() && !['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'node_modules'].includes(entry.name)) await walk(join(dir, entry.name));
    }
  }
  await walk(root);
  return output;
}

export async function collectQuota(home = homedir()) {
  const desktop = [];
  const files = await findNamed(join(home, 'Library/Application Support/Claude'), 'plan-usage-history.json');
  let parseFailures = 0;
  for (const file of files) {
    let raw;
    try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { parseFailures++; continue; }
    const accounts = new Map();
    for (const sample of Array.isArray(raw.samples) ? raw.samples : []) {
      const key = hash(`desktop-org:${String(sample.org ?? 'unknown')}`);
      const group = accounts.get(key) ?? { fh: [], sd: [], xu: [] };
      for (const field of ['fh', 'sd', 'xu']) if (finite(sample.u?.[field])) group[field].push({ at: date(sample.t), value: sample.u[field] });
      accounts.set(key, group);
    }
    for (const [accountKey, group] of accounts) desktop.push({
      accountKey,
      fields: Object.fromEntries(Object.entries(group).map(([field, points]) => [field, summarizeSeries(points)])),
    });
  }
  const codexbar = [];
  for (const provider of ['claude', 'codex']) {
    let raw;
    try { raw = JSON.parse(await readFile(join(home, 'Library/Application Support/com.steipete.codexbar/history', `${provider}.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') parseFailures++; continue; }
    const accounts = Object.entries(raw.accounts ?? {}).map(([key, windows]) => [hash(`codexbar-account:${key}`), windows]);
    if (Array.isArray(raw.unscoped) && raw.unscoped.length) accounts.push([hash('codexbar-unscoped'), raw.unscoped]);
    for (const [accountKey, windows] of accounts) {
      for (const window of Array.isArray(windows) ? windows : []) {
        const points = (Array.isArray(window.entries) ? window.entries : []).map((p) => ({ at: date(p.capturedAt), reset: date(p.resetsAt), value: p.usedPercent }));
        codexbar.push({ provider, accountKey, windowMinutes: finite(window.windowMinutes) ? window.windowMinutes : null, ...summarizeSeries(points) });
      }
    }
  }
  return {
    schemaVersion: 1, cutoff, parseFailures,
    semantics: {
      fh: 'Observed five-hour utilization percentage; no token or dollar conversion.',
      sd: 'Observed seven-day utilization percentage; no token or dollar conversion.',
      xu: 'Uncalibrated raw numeric field. No dollar or token meaning assumed.',
      codexbar: 'Point samples of utilization; neither additive across samples nor across overlapping windows.',
    },
    desktop: { sourceFiles: files.length, accounts: desktop }, codexbar,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await collectQuota();
    await mkdir('.lane', { recursive: true });
    await writeFile('.lane/quota-aggregates.json', `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(result));
  } catch { console.error('Quota oracle failed; raw error suppressed.'); process.exitCode = 1; }
}
