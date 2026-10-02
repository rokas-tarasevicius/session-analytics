# Proposed metric contracts and decision gates

Status: proposal, 2026-10-02. These definitions guide future implementation;
**no field, option, persistence store, export or detector described here is added
to the current public schema.** See the current [metrics](../metrics.md) and
[privacy field manifest](../privacy.md#field-manifest) for shipped behavior.

## Common envelope

Every future metric needs a registry entry containing an ID, definition version,
unit, formula, eligible population, deduplication rule, privacy tier, source-format
capability, exclusions, minimum activity and interpretation. Every result needs
the numerator and denominator (where applicable), eligible and excluded counts,
snapshot time, evidence quality and a bounded unavailable reason. Source coverage
and metric value are separate: a low error rate from 10% of calls is not a healthy
tool rating. Unknown results must survive aggregation as unknown.

Suggested names here are conceptual, not an API commitment. A versioned schema
must be designed with the index-store and mcp-agent lanes before adding fields.
Session counts differ across providers: Claude currently folds child transcripts
into a composite session, whereas Codex exposes spawned threads as separate
sessions. Never average their “per session” values as interchangeable task units.

P0/P1 outputs may still be identifying. P2 rules inspect command/diff text locally
and emit only bounded rule IDs and counts; they require explicit opt-in. P3
content review is per-run opt-in and separate from the default projection. A
feature's tier is the most sensitive processing required, not merely the shape
of the final counter. Unknown/unbounded error strings never become labels.

## Initial metric definitions

| Metric / feature ID | Definition and evidence | Eligibility, dedupe and guard | What it cannot establish |
| --- | --- | --- | --- |
| Price coverage / PR01, CO02 | Priced observed input+output tokens / all price-eligible observed input+output tokens; keep provider-reported value outside this ratio | Unknown models stay in denominator; zero tokens → N/A; separate coverage of token capture from coverage of pricing | That all requests were captured or an invoice was reconstructed |
| Receipt reconciliation / CO01 | Computed API-equivalent value minus provider-reported value for the same bounded session/period and matching cost basis | If billing modifiers or aggregation boundaries differ, display both values and “basis mismatch”; never force equality; match/dedupe source identity internally | That any discrepancy is a parser bug or money owed |
| Subscription multiple / CO04 | Selected-period API-equivalent value / manually entered plan price for the same currency and period | Explicit manual account grouping, complete plan-period alignment, nonzero price; show coverage and no automatic profile-to-account join | ROI, savings, cash cost, or that two profiles have separate subscriptions |
| Observed quota / CO05 | Provider's used percentage and reset timestamp for each limit identifier/window | Source timestamp required; newest observation per source-profile/window, account identity unknown unless explicitly established; never sum profiles or assume one profile kept the same login; show age; current indicator expires after a provisional 5 minutes or reset, whichever occurs first | True live headroom between observations; tokens remaining; future admission |
| Quota trend / CO06 | Slope of provider percentage over samples within one unchanged window; extrapolated crossing with an uncertainty label | Explicit stable account/window identity first; at least 3 monotone samples spanning 15 minutes, latest <=5 minutes old; no reset, plan switch or missing time; suppress if assumptions fail | A guaranteed time-to-limit or conversion between tokens and percentage |
| Cache read share / TC01 | Cache-read input / (uncached input + cache-read input + cache-write input), using provider-normalized non-overlapping classes | Sum numerator/denominator before dividing; provider fidelity shown; no denominator → N/A; comparisons require 20 matched requests per cohort | Unique text reuse, provider cache hit probability, or wasted work |
| Re-cache burden / TC03 | Cost of observed cache creation on the deduplicated request carrying an explicit provider cache-miss reason | Join the same request first; only use a later request if its provider schema defines that relationship; unknown reason and inferred TTL expiry separate; never count creation again as an extra cost; no request chronology → unavailable | Avoidable cost or a reason caused the miss; no recommendation to suppress security/context changes |
| Context fill / TC04 | For each request, provider-normalized total processed input (including cache reads/writes without overlap) / that request's contemporaneous context-window size | Join model/window/request, do not divide independent maxima; unknown window → unavailable; label provider accounting limits | Probability of quality failure, useful information density or a universal 60% danger threshold |
| Compaction reduction / TC05 | (preTokens - postTokens) / preTokens per explicit boundary, plus recorded duration | Sizes from the same event; preTokens >0; incomplete sizes → count only; repeated records deduped | Lost useful knowledge or compaction success |
| Tool error share / TR01 | Matched terminal error outcomes / matched terminal success+error outcomes; interruptions and pending/unknown separate | Join call and result IDs internally, count once; state calls/outcomes/unknown; comparative flag requires >=30 outcomes each and >=5 error outcomes in flagged cohort | Agent competence, environmental blame or success of the task |
| Tool latency / TR02 | p50/p95 recorded call durations by tool and outcome class | Nonnegative durations in known units; report sample count and missing-duration count; p50 at n>=20, p95 at n>=100; no runtime inferred from human gaps | User wait or total critical-path time when calls overlap |
| Repeat-failure flag / TR04 | >=3 failed calls with the same keyed tool+argument fingerprint within 5 minutes | P1 secret local; source permission must allow internal argument hashing; secrets and values discarded; use completed matched failures, not polling; no key → unavailable | That retries were irrational; automatic blocking is excluded |
| Provider retries / TR07 | Explicit retry attempts/delays and structured rate-limit/server errors | Separate API attempts from model responses, structured bounded codes only; no double counting streamed error blocks | Tool failure or provider downtime outside observed sessions |
| Change volume / OU01 | Added/removed lines from structured counts or locally classified diff hunks | Structured integer totals P0; computing from raw diffs is P2; skip unparseable/binary records, distinguish repeated edits from final delta | Delivered value, durable lines, correctness or net repository change |
| Artifact linkage / OU03 | Sessions grouped by explicit artifact evidence; strongest: structured commit/PR marker; weaker: workspace relationship; weakest: time overlap | Resolve IDs internally; output salted opaque artifact keys and evidence enum; raw SHA/PR number/URL, branch and path omitted by this proposal; uncertain many-to-many links retained | Exclusive authorship or causal credit for a merge |
| Value per merged artifact / OU04 | Sum eligible API-equivalent session value allocated to independently confirmed merged artifacts / unique eligible merged artifacts | Allocate shared sessions by explicit user choice or show unallocated pool; default no equal split; terminal-evidenced sessions and closed period, matched cost basis, >=5 artifacts for a comparison | Profit, productivity or individual contribution; never hide unlinked work |
| Verification transition / OU05 | Bounded P2 test/build class with failing outcome followed by passing outcome within a session | Rule version and opt-in required; parsed command classes remain internal; join same verification class, not arbitrary shell exits; report eligible sessions | Correctness, test completeness or that the final artifact passed CI |
| Verification gap / OU06 | A recorded edit with no later recorded eligible verification before an observed terminal event | P2 command rules; source must expose edits, verification and terminal state; live/incomplete sessions excluded | “No tests were run”; tests outside captured history remain unknown |
| Concurrent spans / WF02 | Interval sweep of session firstEventAt/lastEventAt; report peak and area/union duration | Same clock; explicitly live spans bounded at snapshot, unknown lifecycle retained; exclude missing/inverted intervals; call it observed overlapping spans | Effective active parallelism or speedup; resumed sessions have idle gaps |
| Turn activity / WF03 | Sum union of explicit task/turn start-end intervals; separate recorded tool/API durations | Nested/parallel intervals unioned; missing ends excluded; reported provider units normalized | Human labor saved or an unobserved split between thinking, waiting and permission time |
| Intervention / WF05 | Explicit interrupts and replaced turns; optionally separate observable steering events | Denominator eligible turns, not tool calls; compare same provider/repository/task cohort; no automatic negative scoring | Dissatisfaction or failure; expert users may steer frequently |
| Plan rejection / WF06 | Explicit rejected plan decisions / observed plan decisions, separate from permission denials | If source emits only permission denials, plan rejection is unavailable; >=20 decisions for a comparison | Whether a permission approval is thoughtful, safe or unnecessary |
| Matched experiment / CH02 | User-selected reversible change, baseline/cohort and follow-up interval; show changes in chosen metrics with both denominators | Metadata is local; no free-text experiment notes in public outputs; freeze definition/rate card, retain exclusions; enough observations before results | Causal effect from an uncontrolled before/after comparison |

All activity thresholds above are **provisional product suppression rules**, not
statistical significance thresholds or published scientific constants. They aim
to prevent one event from generating an alarming card. Validate them in pilots;
changing a threshold versions the detector. Confidence intervals may be added
with documented assumptions; serially correlated agent calls must not be treated
as independent trials to manufacture certainty. Do not rank 84 metrics by noisy
p-values and surface the largest apparent change.

## Worked synthetic checks

1. A tool has 100 calls, 70 matched successes, 10 matched errors and 20 unknown
   results: error share is 10/80 = 12.5%, outcome coverage is 80/100 = 80%, and
   unknown is 20. It is neither 10% nor 30% error. Interrupted outcomes would be
   listed separately and excluded from that success/error denominator.
2. Two groups have cache counts 1/2 and 9/98. Combined share is 10/100 = 10%,
   not the mean of 50% and 9.18%. Their tiny first group cannot drive a comparison.
3. Two session spans are 10:00–10:20 and 10:10–10:30. Overlap peak is 2, summed
   spans 40 minutes, union 30 minutes, mean overlap 1.33. No claim about active
   compute or a 1.33× speedup follows.
4. A session contains 30k input at a 100k window and later 40k at a 200k window.
   Peak request-aligned fill is 30%, not 40k/200k = 20%. Current independent
   maxima cannot reconstruct this peak; parse the aligned observations first.
5. Yesterday's 80% quota sample followed by a reset time is historical evidence,
   not today's 20% headroom. There is no current percentage until a fresh sample.
6. A composite session links two artifacts with no allocation evidence. Show its
   value in “shared/unallocated”; copying it into both artifacts double counts,
   while dividing equally invents attribution.

## Release gates for any metric family

Before a metric ships, its owner supplies synthetic fixtures with content
sentinels; unknown, zero, negative, truncated and malformed inputs; streamed or
broadcast duplicates; working-session behavior; source-format capability and
fallback precedence; units and timezone boundaries; and accounting reconciliation
where applicable. Sentinel assertions cover serialized API/JSON, terminal report,
dashboard text, future MCP and exports through the same public projection.
No new output adapter may serialize raw provider objects.

Privacy review specifically checks bounded labels, model/tool name treatment,
error mapping, inferred command rules, hashing secret lifetime and export
linkability. Read-only file/SQLite behavior, bounded memory and network-disabled
analysis remain invariants. Tests must assert expected arithmetic and exclusion
reasons, not just absence of crashes. Novel public fields update types, the field
manifest and metrics documentation together. Snapshot schema changes need an
explicit version and migration story, coordinated across lanes.

Raw archive retention, arbitrary local file browsing, automatically editing agent
settings, writing hooks into provider profiles, shared dashboards and sending
review windows to a model are separate trust-boundary changes. A high feature
score never authorizes them. The current proposal's quarter roadmap keeps P3
review and a shared service outside the default release path.
