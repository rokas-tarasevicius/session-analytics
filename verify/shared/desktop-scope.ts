/** Independent joins separating native request evidence from aggregate Desktop receipts. */
type Row = Record<string, any>;
const number = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Unavailable Desktop scope operand'); return value; };
const rows = (value: unknown): Row[] => { if (!Array.isArray(value)) throw new Error('Unavailable Desktop scope rows'); return value; };
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-7;
const fields = ['inputTokens','uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens','cacheWrite5mInputTokens','cacheWrite1hInputTokens','outputTokens','reasoningOutputTokens'];
export function desktopScopes(desktop: Row, excluded: ReadonlySet<string> = new Set()) {
  const sessions = new Map<string, Row>(), days = new Map<string, number>();
  for (const interval of rows(desktop.intervals)) {
    if (interval.liveAfterReference || excluded.has(interval.sessionKey)) continue;
    if (!interval.preResumeCarryoverVersion || interval.overlappingNativeMessages || interval.missingNativeMessages) throw new Error('Unproved Desktop ownership');
    for (const model of rows(interval.models)) {
      if (!model.inputsMatch || model.missingApiEquivalentUsd === null) throw new Error('Unproved Desktop usage');
      const d = model.delta, values = ['input','read','write','output'].map(k => number(d[k]));
      if (values.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid Desktop usage');
      const count = values.reduce((a,b)=>a+b,0);
      if (count !== model.missingTokens) throw new Error('Desktop delta does not conserve usage');
      if (!count) continue;
      const r = sessions.get(interval.sessionKey) ?? { sessionKey: interval.sessionKey, tokens: Object.fromEntries(fields.map(k=>[k,0])), dollars: 0 };
      const vector = [d.input+d.read+d.write,d.input,d.read,d.write,0,0,d.output,0];
      fields.forEach((k,i)=>r.tokens[k]+=vector[i]); r.dollars += number(model.missingApiEquivalentUsd); sessions.set(interval.sessionKey,r);
      const at = Date.parse(interval.endedAt); if (!Number.isFinite(at)) throw new Error('Undated Desktop scope');
      const key = `${interval.sessionKey}:${new Date(at).toISOString().slice(0,10)}`; days.set(key,(days.get(key)??0)+number(model.missingApiEquivalentUsd));
    }
  }
  return { sessions, days };
}
export function compareDesktopDedup(legacy: Row, desktop: Row, excluded: ReadonlySet<string> = new Set()) {
  const scope = desktopScopes(desktop, excluded), actual = new Map(rows(legacy.tokenMismatches).filter(r=>!excluded.has(r.sessionKey)).map(r=>[r.sessionKey,r])), differences: Row[] = [];
  for (const key of new Set([...actual.keys(),...scope.sessions.keys()])) {
    const a = actual.get(key), expected = scope.sessions.get(key);
    if (!a || !expected) { differences.push({sessionKey:key,field:'unexplained-ownership-delta'}); continue; }
    for (const field of fields) if (number(a.tokens[field]) !== -expected.tokens[field]) differences.push({sessionKey:key,field});
    if (!close(number(a.dollars),-expected.dollars)) differences.push({sessionKey:key,field:'dollars'});
  }
  return { differences, receiptOnlyEvidence: [...scope.sessions.values()], historicalDifferences: rows(legacy.tokenMismatches) };
}
/** Native request oracles exclude aggregate Desktop receipts. Each session's public dated value must
 * equal its native request value plus exactly the independently proved receipt-only Desktop value. */
export function compareTimeScopes(audit: Row, native: Row, desktop: Row, snapshot: Row, excluded: ReadonlySet<string> = new Set()) {
  const scope = desktopScopes(desktop, excluded), differences: Row[] = [], checked: string[] = [];
  const sessions = new Map(rows(snapshot.sessions).map(s=>[s.sessionKey,s]));
  for (const source of rows(native.sessions)) {
    if (excluded.has(source.sessionKey)) continue;
    const session = sessions.get(source.sessionKey); if (!session) throw new Error('Missing native time identity');
    const dated = session.spendByDay ?? {};
    for (const day of new Set([...Object.keys(dated),...Object.keys(source.spendByDay)])) {
      const receipt = scope.days.get(`${source.sessionKey}:${day}`) ?? 0;
      if (!close(number(dated[day] ?? 0) - number(source.spendByDay[day] ?? 0), receipt)) differences.push({sessionKey:source.sessionKey,day,field:'native-request-usd'});
    }
    checked.push(source.sessionKey);
  }
  for (const error of rows(audit.parityErrors)) if (!excluded.has(error.sessionKey)) differences.push(error);
  for (const error of rows(audit.discrepancies)) if (error.reconciliationFailure && !excluded.has(error.sessionKey)) differences.push(error);
  return { differences, nativeRequestSessions: checked, receiptOnlyEvidence: [...scope.sessions.values()], historicalRequestScopeDifferences: rows(audit.parityErrors) };
}
