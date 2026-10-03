# Limits, cache, and context

The **Limits & cache** tab and terminal report show quota observations, input-cache economics, and request-context pressure. These are not invoices, live quota checks, or measures of work quality.

## Evidence and profile scope

| Source | Evidence read | Meaning |
| --- | --- | --- |
| Codex rollouts | `event_msg.token_count.rate_limits`, even without `info` | Account-wide primary/secondary windows, utilization, resets, plan enum and credit counters |
| Claude transcripts | `quotaLimits`; numeric HTTP 429 status | Status/reset/overage evidence; a warning or rejection does not invent numeric utilization |
| Default Claude profile | `~/.claude.json` → `cachedUsageUtilization.{fetchedAtMs,utilization}` | The cache's fetch time dates the observation, not file modification time |
| Other Claude profiles | `<config-directory>/.claude.json`, including `CLAUDE_CONFIG_DIR` profiles | Each cache attaches to its own transcript profile |
| Claude Desktop | `~/Library/Application Support/Claude/plan-usage-history.json` → `samples[].{t,org,u.{fh,sd}}` | Separate pseudonymous Desktop account histories; this format lacks reset times |

Codex active/archive stores under the same directory share a profile; canonical identities deduplicate symlink aliases. Labels are ordinal, such as **Claude profile 2**, never directory names. Profile keys are truncated SHA-256 hashes with a `profile-` prefix. Desktop organizations receive separate hashed keys and ordinal labels. `scope` distinguishes transcript profiles from Desktop accounts.

History does not establish whether Code profiles share a login or changed accounts. Profiles remain separate, quotas are never summed, and Desktop history is not joined to Code by guesswork. Code account IDs and credentials are not read for identity. Explicit provider roots replace discovery as before; supplemental Claude caches are read beside selected `projects` roots, and an explicit Claude root disables automatic Desktop history. The demo supplies its own data directory.

Missing optional files are normal. Malformed, unreadable or oversized files produce fixed warnings, without paths or raw errors. Configuration is capped at 1 MiB; other supplemental JSON at 16 MiB. CodexBar ingestion is deferred.

## Quota statistics

Snapshots deduplicate by **profile, hashed limit ID, window kind/duration, source and normalized UTC timestamp**, independently of token ownership. Numeric and status sources at the same instant remain separate evidence. Simultaneous numeric conflicts retain higher utilization, never an average; conflicting statuses prefer rejection. Unknown limit IDs are hashed and labeled “Additional limit”; unknown plan strings and arbitrary metadata are discarded. Credit balances accept finite numbers or bounded decimal strings; provider units are not converted to money.

- **Headroom:** `100 − usedPercent` at `latestNumeric`, separately from `latest` status/reset evidence. `headroomExpiresAt` is the earlier of that numeric fetch time plus 15 minutes and its evidenced reset. A later allowed status does not erase the numeric observation or renew its freshness. An incompatible reset or a rejection contradicting a value below 100% invalidates it, including simultaneous evidence, until a newer numeric fetch. Future/expired observations and status-only histories have no headroom number.
- **Time at ≥90%:** hold the earlier numeric value between adjacent numeric observations only when the gap is at most 15 minutes, stopping at its reset. Divide minutes at ≥90% by these observed minutes. Quiet gaps are unknown. Ratios need three numeric observations and five observed minutes.
- **Time to limit:** project linearly from the last three numeric observations in the same reset window. Require at least five minutes, no gap over 15 minutes, non-decreasing usage and positive total growth. Suppress stale observations and projections reaching the limit after reset. At 100%, a fresh sample has zero minutes to limit. Duration is **from the last observation**, not from the present.
- **Limit events:** `http-429`, `usage-limit-exceeded`, `quota-rejected`. Quota statuses deduplicate by profile/timestamp/class; request errors prefer a session-qualified message/turn identity when available, falling back to timestamp/class. Identities stay internal. Sessions with limit errors are counted from request errors, not inferred from account snapshots. A 429 can be transient. Different classes may describe one incident; totals count observations, not outages or failed tasks.

Retain the latest 20,000 observations per window and expose `historyLimited`. Duplicate counts describe collisions encountered in retained collection, not lifetime totals after eviction. Charts retain at most 480 representative points (`timelineSampled`); statistics use all retained observations. Sparse gaps are not continuous measured exposure.

Quota panels remain account-wide and show full retained history despite repository/date filters. The browser expires displayed headroom at its numeric observation's freshness/reset deadline even if the page is left open; refresh gathers newer evidence. Cache/context panels filter **request dates**, including requests from sessions that began earlier. Compactions use their own event dates, repository and execution filters, including sessions/days without requests; the date picker includes trailing compaction days. The shared caption describes these populations separately. Select repository/model/provider grouping and a trend series for daily cache comparisons. Undated requests remain in session/report totals but are excluded from dated charts and monthly comparisons, with a coverage note.

## Cache economics

Accounting runs after existing request deduplication: final streamed Claude usage and the owning Codex `last_token_usage` observation. A fallback cumulative Codex delta, including a present but all-zero last-usage record, counts as one usage observation, not proof of one request; it is ineligible for context and no-cache pricing. Observed totals retain the delta. Daily buckets carry model/execution dimensions; the containing session supplies repository/profile. Public models must pass the shared bounded identifier policy in [privacy.md](privacy.md); malformed values become `<unknown>`. Claude sub-agents have separate cache sequences. Timestamps normalize to UTC before sorting; missing/invalid times retain stable input order after dated requests, so offset spellings cannot reverse the cache sequence.

**Hit share** is cache-read input / total input, including uncached input and creation. Ratios require three requests and 1,000 input tokens, with numerator/denominator shown. Missing evidence is N/A.

```text
no-cache input value = all processed input × uncached input rate
actual input value  = uncached input + cache-read + cache-write value
net input savings   = no-cache input value − actual input value
```

The comparison uses the existing reviewed rate card and per-request long-context multiplier. Outputs cancel; write premiums remain, so savings may be negative. Unknown models and Codex cumulative deltas without known request input are excluded from this comparison's pricing coverage. Codex writes are unobservable: its comparison uses the ordinary estimate, not an assertion of zero write cost or an invoice.

Provider reasons are a closed enum: `previous_message_not_found`, `messages_changed`, `tools_changed`, `system_changed`, `model_changed`. Diagnostics survive streamed-snapshot replacement; no diagnostic text is retained. Heuristics require a subsequent Claude request with observable writes:

- **idle-ttl:** the gap exceeds the previous explicitly evidenced TTL. Cache hits refresh inferred expiry. Five-minute/one-hour TTLs come from the write breakdown; mixed writes use the longer duration. Aggregate-only creation never produces an idle flag from its assumed pricing TTL.
- **model-switch:** model changed within the same execution stream.
- **compaction:** a boundary occurred since that stream's preceding request.

These are correlations, not proven invalidation causes. A reason and multiple flags can coexist. `breakRequests` counts each request once; reported/heuristic counts can overlap. `recacheWriteUsd` counts the full write value on flagged requests once, not incremental loss or avoidable waste. Unknown write prices are null in event detail.

## Context and compaction

Fill is **that request's input including all cache tokens / that request's window**. Peak is the maximum of paired ratios, fixing the old ratio of independently maximized input/window sizes. Output headroom is not subtracted. Missing Codex per-request input/window is ineligible rather than zero fill. Strictly-above-40/60/80% shares use eligible requests and need three; both eligible and total counts are shown.

Codex windows are recorded. Claude's exact-model fallback table was reviewed **2026-10-02** against [Anthropic's context-window reference](https://platform.claude.com/docs/en/build-with-claude/context-windows). It covers documented 1M-token families (Opus 4.6–4.8/5/5.5, Sonnet 4.6/5/5.5, Fable 5/5.1 and Mythos Preview/5/5.1) and reviewed 200K-token older Opus/Sonnet/Haiku entries. Dated aliases use the reviewed base ID; unknown families stay unknown. These are API **model capacities**, not evidence of a harness's configured budget or plan entitlement. Recorded/reviewed coverage is separate. Table changes need a new review date and tests. TTL semantics follow [Anthropic's caching reference](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Long curves retain maxima in request-count bins plus endpoints, at most 240 points per session and **20,000 total points per snapshot** (`curveSampled`). The global budget is shared evenly across sessions, redistributing unused slots from short curves, in stable session-key order. Allocations of three or more keep peaks and endpoints; one/two-point allocations prioritize the peak. When sessions outnumber slots, some curves are empty and marked sampled. Counts, shares, daily peaks and session peak use all eligible requests. Composite Claude curves may interleave main/sub-agent requests; the execution filter separates them. The budget bounds exported detail; parsing still processes every request.

Claude `compact_boundary.compactMetadata` supplies trigger and optional pre/post tokens. Missing sizes are null. Turn intervals count human turns in the same stream; tool results are excluded and the first boundary has no preceding interval. Individual boundaries reconcile by shared explicit identity or equal UTC timestamps across different representations, without merging conflicting explicit IDs. Distinct dated boundaries survive client-format changes. Legacy Claude markers remain included. The same reconciled count feeds `metrics.compactions` and `compactionCount`. Missing timestamps or ambiguous matches set `compactionCountExact: false`; unmatched evidence remains visible, and uncertain/undated turn intervals stay null. This is a count of observed evidence, not a completeness claim about provider history. Compaction and cache-break details each cap at 240 representative points per session with sampling flags; request counters and costs remain exact.

## Optional labels and monthly plans

Set `--data-dir PATH` or `SESSION_ANALYTICS_DATA_DIR` on either command. Defaults: `~/Library/Application Support/session-analytics` on macOS; `$XDG_DATA_HOME/session-analytics` or `~/.local/share/session-analytics` elsewhere. Only `config.json` is read; no directory or provider/config file is written.

```json
{
  "limitsCache": {
    "profiles": [
      { "provider": "claude", "profile": 1, "label": "Personal", "monthlyPriceUsd": 50 },
      { "provider": "codex", "profileKey": "profile-00000000000000000000", "label": "Work", "monthlyPriceUsd": 35 }
    ]
  }
}
```

Prices above are illustrative user inputs, not advertised prices. Copy `profileKey` from your local snapshot: keys are preferable because ordinals can shift as discovery changes. A key takes precedence over an ordinal within an entry. Labels are explicitly public: 1–40 ASCII letters/digits/spaces/periods/underscores/hyphens, starting with a letter/digit. Paths and account IDs are not config targets. Invalid entries and duplicate targets produce generic warnings. Other configuration sections are ignored, and the file remains untouched.

Monthly API-equivalent value includes dated input **and output**, compared with the full configured monthly USD amount without extrapolation or proration. Ratios need positive price, three active days and complete observed-token pricing coverage. Zero prices never produce infinity. Plan type alone never supplies a price. Cursor's provider-reported value is excluded.

The current configured price applies to all observed months; historical price schedules are not modeled. `partialMonth` means the month in progress, not complete history for other months. Active days, token coverage and repository scope accompany the comparison. Dashboard dates/repository/execution restrict the numerator; the denominator stays a full month. Profiles sharing a subscription must not be summed into separate plan charges.

## Verification

```bash
npm run check
node scripts/demo.ts report
node scripts/demo.ts --no-open --port 4175
# Open http://127.0.0.1:4175/#limits-cache
```

The demo supplies synthetic quotas, diagnostics, compaction sizes and fictional configured prices. Tests cover deduplication, freshness, resets, sparse evidence, profile locations, cost arithmetic, paired context windows, compaction intervals, configuration, filtering and privacy sentinels. No runtime network request or dependency was added.
