// Snapshot side of the independent reconciliation. Never emit repository names.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export function reconcileReference(snapshot, excludedKeys = new Set()) {
  const cutoff = snapshot.generatedAt;
  const sessions = snapshot.sessions.filter((s) => !excludedKeys.has(s.sessionKey) && !(s.lastEventAt > cutoff));
  const zero = () => ({ sessions: 0, inputTokens: 0, outputTokens: 0, valueUsd: 0, apiEquivalentUsd: 0, providerReportedUsd: 0 });
  function add(row, s) {
    row.sessions++;
    row.inputTokens += s.tokens.inputTokens;
    row.outputTokens += s.tokens.outputTokens;
    row.valueUsd += s.cost.totalUsd;
    if (s.costBasis === 'api-list-price-equivalent') row.apiEquivalentUsd += s.cost.totalUsd;
    if (s.costBasis === 'provider-reported') row.providerReportedUsd += s.cost.totalUsd;
  }
  const totals = zero();
  const providers = new Map(), starts = new Map(), activity = new Map(), models = new Map();
  for (const s of sessions) {
    add(totals, s);
    const provider = providers.get(s.provider) ?? { provider: s.provider, ...zero() };
    add(provider, s); providers.set(s.provider, provider);
    const month = s.transcript.startTimeKnown !== false && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(s.createdAt ?? '') ? new Date(s.createdAt).toISOString().slice(0, 7) : 'undated';
    const startKey = `${s.provider}:${month}`;
    const start = starts.get(startKey) ?? { provider: s.provider, month, ...zero() };
    add(start, s); starts.set(startKey, start);
    const obtain = (month) => {
      const key = `${s.provider}:${month}`;
      let row = activity.get(key);
      if (!row) { row = { provider: s.provider, month, sessionKeys: new Set(), inputTokens: 0, outputTokens: 0, valueUsd: 0, apiEquivalentUsd: 0, providerReportedUsd: 0 }; activity.set(key, row); }
      row.sessionKeys.add(s.sessionKey);
      return row;
    };
    let allocatedInput = 0, allocatedOutput = 0;
    for (const [day, , , v] of s.velocity?.buckets ?? []) {
      const row = obtain(day.slice(0, 7));
      row.inputTokens += v[1]; row.outputTokens += v[5];
      allocatedInput += v[1]; allocatedOutput += v[5];
    }
    for (const [, v] of s.velocity?.undated ?? []) {
      const row = obtain('undated'); row.inputTokens += v[1]; row.outputTokens += v[5];
      allocatedInput += v[1]; allocatedOutput += v[5];
    }
    if (allocatedInput !== s.tokens.inputTokens || allocatedOutput !== s.tokens.outputTokens) {
      const row = obtain('undated'); row.inputTokens += s.tokens.inputTokens - allocatedInput; row.outputTokens += s.tokens.outputTokens - allocatedOutput;
    }
    let datedValue = 0;
    for (const [day, value] of Object.entries(s.spendByDay ?? {})) {
      const row = obtain(/^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(0, 7) : 'undated');
      row.valueUsd += value; datedValue += value;
      if (s.costBasis === 'api-list-price-equivalent') row.apiEquivalentUsd += value;
      if (s.costBasis === 'provider-reported') row.providerReportedUsd += value;
    }
    if (Math.abs(s.cost.totalUsd - datedValue) > 1e-9) {
      const row = obtain('undated'), remainder = s.cost.totalUsd - datedValue;
      row.valueUsd += remainder;
      if (s.costBasis === 'api-list-price-equivalent') row.apiEquivalentUsd += remainder;
      if (s.costBasis === 'provider-reported') row.providerReportedUsd += remainder;
    }
    for (const model of s.models) {
      const safeModel = /^(?:[a-zA-Z0-9][a-zA-Z0-9._:-]{0,100}|<unknown>)$/.test(model.model) ? model.model : '<unknown>';
      const key = `${s.provider}:${safeModel}`;
      const row = models.get(key) ?? { provider: s.provider, model: safeModel, sessions: 0, inputTokens: 0, outputTokens: 0, valueUsd: 0 };
      row.sessions++; row.inputTokens += model.inputTokens; row.outputTokens += model.outputTokens; row.valueUsd += model.totalUsd;
      models.set(key, row);
    }
  }
  const sum = (rows, value) => rows.reduce((n, row) => n + value(row), 0);
  const checks = [];
  const check = (name, actual, expected, tolerance = 1e-6) => checks.push({ name, actual, expected, delta: actual - expected, pass: Math.abs(actual - expected) <= tolerance });
  // All-snapshot invariants are deliberately independent of settled-session filtering.
  check('session-count', snapshot.sessions.length, snapshot.summary.sessions, 0);
  check('session-keys-unique', new Set(snapshot.sessions.map((s) => s.sessionKey)).size, snapshot.sessions.length, 0);
  check('session-input-sum', sum(snapshot.sessions, (s) => s.tokens.inputTokens), snapshot.summary.totalInputTokens, 0);
  check('session-output-sum', sum(snapshot.sessions, (s) => s.tokens.outputTokens), snapshot.summary.outputTokens, 0);
  check('session-value-sum', sum(snapshot.sessions, (s) => s.cost.totalUsd), snapshot.summary.estimatedSpendUsd);
  check('basis-sum', snapshot.summary.apiEquivalentSpendUsd + snapshot.summary.providerReportedSpendUsd, snapshot.summary.estimatedSpendUsd);
  check('repository-session-sum', sum(snapshot.repositories, (r) => r.summary.sessions), snapshot.summary.sessions, 0);
  check('repository-input-sum', sum(snapshot.repositories, (r) => r.summary.totalInputTokens), snapshot.summary.totalInputTokens, 0);
  check('repository-output-sum', sum(snapshot.repositories, (r) => r.summary.outputTokens), snapshot.summary.outputTokens, 0);
  check('repository-value-sum', sum(snapshot.repositories, (r) => r.summary.estimatedSpendUsd), snapshot.summary.estimatedSpendUsd);
  check('model-input-sum', sum(snapshot.spendByModel, (m) => m.inputTokens), snapshot.summary.totalInputTokens, 0);
  check('model-output-sum', sum(snapshot.spendByModel, (m) => m.outputTokens), snapshot.summary.outputTokens, 0);
  check('model-value-sum', sum(snapshot.spendByModel, (m) => m.totalUsd), snapshot.summary.estimatedSpendUsd);
  return { cutoff, totalSessions: snapshot.sessions.length, excludedSessions: snapshot.sessions.length - sessions.length,
    totals, providers: [...providers.values()], byStartMonth: [...starts.values()].sort((a,b)=>`${a.month}:${a.provider}`.localeCompare(`${b.month}:${b.provider}`)),
    byActivityMonth: [...activity.values()].map(({sessionKeys, ...row}) => ({...row, sessions: sessionKeys.size})).sort((a,b)=>`${a.month}:${a.provider}`.localeCompare(`${b.month}:${b.provider}`)),
    models: [...models.values()], checks,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  const snapshot = JSON.parse(await readFile(join(homedir(), 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'), 'utf8'));
  const result = reconcileReference(snapshot);
  await writeFile('.lane/reference-aggregates.json', `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ cutoff: result.cutoff, totals: result.totals, providers: result.providers, checks: result.checks }));
} catch { console.error('Reference reconciliation failed; raw error suppressed.'); process.exitCode = 1; }
