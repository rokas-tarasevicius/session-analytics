# Generate reviewable source patches without editing src/.
from pathlib import Path
import difflib
app=Path('src/public/app.js').read_text()
def emit(bug,changes):
 out=[]
 for path,old,new in changes:
  out.extend(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+path,tofile='b/'+path))
 Path('.lane/fixes/'+bug+'.patch').write_text(''.join(out))
old='''    const providerModels = models.filter((model) => model.provider === provider);
    if (providerModels.length === 0) continue;'''
new='''    const providerModels = models.filter((model) => model.provider === provider);
    const providerSessions = sessions.filter((session) => session.provider === provider);
    const sourceMetric = { value: "cost", input: "tokens", output: "tokens", calls: "calls" }[modelMetric];
    const sourceValue = (session) => ({ value: session.cost.totalUsd, input: session.tokens.inputTokens, output: session.tokens.outputTokens, calls: session.metrics.modelCalls })[modelMetric];
    const eligibleSessions = providerSessions.filter((session) => metricEligible(session, sourceMetric));
    const unattributed = Math.max(0, eligibleSessions.reduce((total, session) => total + sourceValue(session), 0) - providerModels.reduce((total, model) => total + metric.value(model), 0));
    if (providerModels.length === 0 && !unattributed) continue;'''
newapp=app.replace(old,new).replace('''    elements.modelsByProvider.append(group);''','''    if (unattributed > 0.000001) {
      const row = node("div", null, "model-row");
      row.append(node("span", "Unattributed · no model evidence"), node("div"), node("strong", metric.format(unattributed)));
      group.append(row);
    }
    elements.modelsByProvider.append(group);''')
emit('AGG-003',[('src/public/app.js',app,newapp)])
newapp=app.replace('''  return dailySpendByProvider(sessions, elements.windowStart.value, elements.windowEnd.value);''','''  const days = new Map(daysBetween(elements.windowStart.value, elements.windowEnd.value).map((name) => [name, { name, ...Object.fromEntries(providerOrder.map((provider) => [provider, 0])) }]));
  for (const session of sessions) {
    if (!providerOrder.includes(session.provider)) continue;
    for (const [day, , , values] of session.velocity?.buckets || []) {
      const row = days.get(day);
      if (row) row[session.provider] += values[0];
    }
  }
  return [...days.values()];''')
html=Path('src/public/index.html').read_text()
newhtml=html.replace('Codex and Claude use reviewed API list-price equivalents. Cursor totals use its provider-reported local cost record, but Cursor is not plotted by day because the local store has no per-call cost timestamps. None of these values proves an amount charged.','Activity dates use the snapshot timezone, as in Velocity. The chart includes only dated API-equivalent value; provider-reported value and sessions without velocity evidence remain outside the chart. Whole-session KPI totals have a different scope. API-equivalent value is not an invoice.')
emit('AGG-004',[('src/public/app.js',app,newapp),('src/public/index.html',html,newhtml)])
newapp=app.replace('["spend", "Daily priced usage value",','["spend", "Dated API-equivalent value only (UTC); undated and out-of-window value excluded",')
emit('AGG-005',[('src/public/app.js',app,newapp)])
newapp=app.replace('''  const sessions = eligible.filter((s) => s.evidence?.timing !== "file-mtime");''','''  const sessions = eligible.filter((s) => s.transcript.startTimeKnown !== false && s.evidence?.timing !== "file-mtime" && normalizeTimestamp(s.createdAt) !== null);''').replace('sessions have provider start timestamps. File modification dates are excluded.','sessions have provider start timestamps. Unknown starts and file modification dates are excluded.')
emit('AGG-006',[('src/public/app.js',app,newapp)])
