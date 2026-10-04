// Render only safe aggregate artifacts; no provider files or application imports.
import { readFile, writeFile } from 'node:fs/promises';
const integer = value => Math.round(value).toLocaleString('en-US');
const usd = value => Number(value).toLocaleString('en-US',{minimumFractionDigits:6,maximumFractionDigits:6});
const tokenSum = value => value.input + value.cacheRead + value.cacheWrite + value.output;
const table = (headers, rows) => ['| '+headers.join(' | ')+' |','| '+headers.map(()=>'---').join(' | ')+' |',...rows.map(row=>'| '+row.join(' | ')+' |')].join('\n');
try {
  const read = async name => JSON.parse(await readFile(`.lane/${name}.json`,'utf8'));
  const reference = await read('reference-settled-aggregates');
  const claude = await read('claude-aggregates');
  const codex = await read('codex-aggregates');
  const conductor = await read('conductor-aggregates');
  const codexReceipts = await read('codex-conductor-coverage');
  const quota = await read('quota-aggregates');
  const sections = [
    '# Monthly reconciliation',
    `Frozen reference: ${reference.cutoff}. Excludes ${reference.excludedSessions} sessions with independently observed post-cutoff activity. Remaining reference: ${integer(reference.totals.sessions)} sessions, ${integer(reference.totals.inputTokens+reference.totals.outputTokens)} tokens, $${usd(reference.totals.valueUsd)} mixed-basis value. This is the existing reference, before proposed corrections.`,
    '## Activity-month reference',
    'Native request timestamps assign API value to an activity month. Summary-only evidence remains undated. Monthly session counts overlap and zero-activity/zero-value rows can be absent: the 318 undated rows with usage/value do not replace the inventory of 326 recovered sessions. Zero observed Cursor value means pricing unavailable, not free consumption. These rows include different source coverage; they are not invoices.',
    table(['Month','Provider','Sessions with activity/evidence','Reference tokens','API-equivalent USD','Reported USD'],reference.byActivityMonth.map(r=>[r.month,r.provider,integer(r.sessions),integer(r.inputTokens+r.outputTokens),r.provider==='cursor'?'unavailable':usd(r.apiEquivalentUsd),r.provider==='cursor'?'unavailable':usd(r.providerReportedUsd)])),
    '## Claude stats-cache: one profile, matching day/model cells',
    'Profile `3657d3b67e24` is the only profile with a stats cache. Its counters count streamed records repeatedly. The remainder for absent raw records is in those same duplicated-record units and cannot be priced or added to Conductor recovery. The other profiles have no independent stats-cache denominator.',
    table(['Month','Covered dates / model-day cells','Provider cache tokens','Surviving raw-record sum','Deduplicated native/reference tokens','Repeated-snapshot tokens','Unavailable-record remainder'],claude.statsReconciliationMonthly.map(r=>[r.month,`${r.reportedDays} / ${r.reportedModelDayCells}`,r.reportedDays?integer(r.reportedTokens):'unavailable',r.reportedDays?integer(r.survivingRawAssistantRecordTokens):'unavailable',r.reportedDays?integer(r.referenceNativeTokensOnReportedModelDays):'outside cache coverage',r.reportedDays?integer(r.repeatedSnapshotTokens):'unavailable',r.reportedDays?integer(r.unavailableRawRecordTokenRemainder):'unavailable'])),
    'Stats-cache monetary coverage: all eight lifetime model `costUSD` values are zero despite positive tokens; no meaningful month-level reported-dollar total exists.',
    '## Codex: physical request counters reconciled by activity month',
    'One canonical profile (`18244b46e840`), two directory aliases. The oracle removes physical-counter broadcasts and admits only uncovered cumulative fallback intervals. Positive token difference is usage missing from the reference; negative is overcount. The database row sums shown separately are not additive consumption.',
    table(['Month','Oracle physical tokens','Reference tokens','Oracle minus reference','Reference API USD','Corrected API USD','Unexplained tokens'],Object.entries(codex.months).sort(([a],[b])=>a.localeCompare(b)).map(([month,r])=>[month,integer(r.correctedOracleTokens),integer(r.referenceTokensByActivity),integer(r.correctedOracleTokens-r.referenceTokensByActivity),usd(r.referenceValueByActivity),usd(r.correctedReferenceUsd),integer(r.unexplainedTokens)])),
    table(['Thread-start cohort','SQLite threads','SQLite cumulative row sum (diagnostic)','Reference sessions starting here'],Object.entries(codex.months).sort(([a],[b])=>a.localeCompare(b)).map(([month,r])=>[month,integer(r.dbThreads),integer(r.dbCumulativeTokenSum),integer(r.referenceSessionsByStart)])),
    'Codex history coverage: 226 records from 15 unique sessions, March–April only. All 15 session identities are present. No token or dollar denominator exists in history records.',
    '## Conductor Codex receipts: observation scope',
    'All 372 identities already have native/reference coverage. March receipt sequences are proven cumulative: subtracting repeated prefixes gives the same 154,908,511 tokens as native counters. Later receipt scopes are partial or unknown; the native-minus-observation difference describes receipt coverage, not missing analyzer usage. Reference activity totals below are restricted to the matched identity population. Provider-reported USD is unavailable in every receipt; reference USD remains an API estimate. Account attribution is unknown.',
    table(['Month','Receipt identities / results','Raw receipt token sum','Proven cumulative repetition','Scope-adjusted observations','Native/reference tokens','Reference API USD'],Object.entries(codexReceipts.months).sort(([a],[b])=>a.localeCompare(b)).map(([month,r])=>[month,`${r.receiptSessions} / ${r.receiptRecords}`,integer(r.receiptPhysicalTokens),integer(r.cumulativeRepeatIfSummed),integer(r.scopeResolvedObservationTokens),integer(r.referenceTokens),usd(r.referenceUsd)])),
    'Cursor SDK coverage: 82 results across 26 matched identities have no usage/cost payload at all. Their native/reference sessions already contain 212,994,525 tokens. These envelopes cannot provide an independent monthly token or dollar denominator.',
    '## Conductor receipts: session-start cohorts, account unknown',
    'Each row selects the same session-start cohort. Provider observations give conservative lower bounds; they do not establish an exact corrected cumulative total. The reference combines native sessions and recovered summaries. Differences include repeated epoch accounting, partial receipts, subagent scope, metadata-only models and missing main-loop lower bounds. Do not subtract this table wholesale to calculate a bug impact. Proven defects are quantified separately in BUGS.md.',
    table(['Start cohort','SDK identities / results','Observed token lower bound','Reference tokens in matched identities','Observed cost lower bound USD','Reference USD','Known main-loop tokens omitted'],conductor.monthly.map(r=>[r.month,`${r.sessions} / ${r.resultRecords}`,integer(tokenSum(r.reportedLowerBound)),integer(tokenSum(r.reference)),usd(r.reportedLowerBound.costUsd),usd(r.reference.costUsd),integer(r.omittedTopLevelTokens)])),
    'Per-session receipt sequences, SDK versions, canonical/fallback categories and model maxima are in `conductor-aggregates.json`; their scopes are not interchangeable. Exact request-month or profile attribution is unavailable for recovered cumulative receipts.',
    '## Quota evidence: coverage only',
    table(['Source','Provider/account key','Month','Window minutes','Samples','Observed percent range'],[
      ...quota.desktop.accounts.flatMap(a=>[['fh',300],['sd',10080]].flatMap(([field,minutes])=>a.fields[field].months.map(m=>['Claude Desktop',a.accountKey,m.month,minutes,m.samples,`${m.min}–${m.max}`]))),
      ...quota.codexbar.flatMap(w=>w.months.map(m=>['CodexBar',`${w.provider}/${w.accountKey}`,m.month,w.windowMinutes,m.samples,`${m.min}–${m.max}`])),
    ]),
    'Percent samples are non-additive and overlapping windows cannot be combined. CodexBar account keys cannot be mapped reliably to CLI profiles. No token or dollar remainder can be calculated from these samples. Desktop raw field `xu` is retained as uncalibrated numeric evidence only.',
    '## What cannot be established',
    'July/August missing raw-record cache coverage, undated lifetime cache totals, undated project last-session summaries, unknown SDK reset scopes, missing auxiliary requests and deleted sources prevent a uniquely exact machine lifetime bill. The concrete corrections and their limits are listed in BUGS.md; this table deliberately preserves unavailable denominators.',
  ];
  await writeFile('.lane/MONTHLY.md',sections.join('\n\n')+'\n');
  console.log('Wrote monthly reconciliation from safe aggregate artifacts.');
} catch { console.error('Monthly report failed; raw error suppressed.'); process.exitCode=1; }
