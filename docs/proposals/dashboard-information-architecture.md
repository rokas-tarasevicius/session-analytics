# Dashboard proposal: investigate a change, keep the evidence in view

Status: design proposal, 2026-10-02. No UI in this document is implemented. All
examples below are synthetic. Related: [strategy](product-strategy.md),
[feature portfolio](feature-portfolio.md), [evidence audit](evidence-audit.md).

## The interaction to optimize

Within two minutes, a developer should be able to answer: **“What changed in this
repository's agent work, which observations support that conclusion, and what is
worth trying next?”** Two minutes is a usability target, not measured performance.
The interface must also make “the evidence cannot answer that” an ordinary result.

The current seven tabs are Summary, Distributions, Activity, Costs, Models, Tools,
and Skills. Date filters select sessions by their start date, then show whole-session
totals; they do not establish exact activity or spend inside that date interval. They organize by chart subject. Repository selection and dates are
global, but provider selections are partly view-specific. Daily cost buckets are
UTC while the activity grid uses local time. These implementation facts come from
[`index.html`](../../src/public/index.html) and
[`app.js`](../../src/public/app.js). A new investigation must not silently change
provider scope or switch the meaning of a day as the user moves between views.

## Navigation and scope

Proposed persistent navigation has five destinations; each answers a distinct
question. Existing charts remain reachable as subviews, avoiding seven more tabs
as new metric families arrive.

| Destination | Question | Contents and current-chart migration |
| --- | --- | --- |
| Overview | What changed, and is the evidence sufficient? | Period comparison, at most three investigation cards, coverage summary; current Summary |
| Repositories | Where should I look? | Sortable repository ledger, one repository's provider/agent/session breakdown; current Distributions |
| Economics | What usage is priced, what drove it, and how fresh is quota evidence? | Value, limits, cache, context, models; current Costs and Models |
| Workflow | Where does execution encounter friction? | Tools, MCP, hooks, delegation, compaction and activity; current Tools, Skills and Activity |
| Evidence | What was found, excluded, estimated, or unavailable? | Source capabilities, reconciliation, snapshot freshness, metric definitions, export preview |

Outcomes is initially a **repository subview**, behind an explicit local-evidence
pilot. It earns a top-level destination only if observed use warrants it. Team
sharing, installation settings and personal preferences do not occupy the main
analytics navigation. A local “Saved views” menu sits beside the scope bar.

One immutable scope descriptor powers every view:

```text
Snapshot: <generatedAt + future schema/rate-card versions>
Repository: all | repositoryKey
Provider: any subset of supported providers
Profile: any subset of opaque local profile keys (future field)
Execution: all | top-level | subagent | mixed | unknown
Period: half-open [start, end), displayed inclusive date labels
Time basis: UTC daily value | local session starts (explicit until migrated)
Comparison: off | preceding equal period | custom matched period
```

The global filter is intersected with a view's capability, never replaced. A view
that supports only two selected providers says “2 of 3 selected providers have
this measure” and shows the excluded provider. Cost bases remain separate. “Agent”
means the provider and execution actor, **not a model, person, session title or
nickname**. Until independent actor records exist, offer provider/execution
filters; do not fabricate a child-session tree from Claude's composite totals.

## Overview wireframe

```text
+--------------------------------------------------------------------------------+
| Session Analytics                         Local snapshot 14:05 UTC   [Refresh] |
| Overview | Repositories | Economics | Workflow | Evidence                     |
| All repositories v  Claude + Codex v  All profiles v  Last 7 days v  [Compare] |
| UTC usage days / local session starts labeled separately          [Saved views]|
+--------------------------------------------------------------------------------+
| OBSERVED THIS PERIOD              | EVIDENCE                                   |
| API-equivalent value $128         | Priced tokens: 94% (47M / 50M)             |
| Previous: $104, same rate card    | Tool outcomes: 800 of 1,000 observed calls |
| Provider-reported: $9, separate   | 3 working snapshots; figures may change   |
| 42 sessions / 4 repositories     | [Why coverage differs]                     |
+--------------------------------------------------------------------------------+
| WORTH INVESTIGATING (at most 3; no overall productivity score)                  |
| 1. Tool timeouts rose in Example App. 9/240 vs 2/260 matched calls.             |
|    Same tool; unequal task mix remains possible. [Inspect comparison]         |
| 2. Cache-read share fell. 8M/20M vs 14M/21M eligible input. [Inspect evidence]  |
| 3. Limit sample is 3 hours old. Current headroom unknown. [View observations]  |
+--------------------------------------------------------------------------------+
| REPOSITORY          VALUE / BASIS       COVERAGE           CHANGE             |
| Example App         $70 API equiv.      92% priced         [Compare]           |
| Sample Service      $58 API equiv.      98% priced         [Compare]           |
| Demo Workspace      $9 reported         API rate N/A       [Open]              |
+--------------------------------------------------------------------------------+
```

Raw counts precede percentages. Evidence chips expand in place and link to the
same scoped Evidence page. A card is suppressed when its denominator or baseline
is too small. The empty card slot says “No supported change detected in this
selection,” not “Everything is healthy.” Each card has its detector version,
eligible observations, baseline, exclusions and one reversible next experiment.

## Repository, agent, session, day

```text
Machine > Example App > Codex / top-level > Session 7c31... > 2026-09-29 (UTC)

+----------------------------------------------------------------------------+
| Example App       18 sessions      Compare: prior 7 days                    |
| Summary | Economics | Workflow | Sessions | Outcomes (pilot)               |
| [Claude 8] [Codex 10] [Unknown actor 2]         Model and effort: optional   |
+----------------------------------------------------------------------------+
| SESSION KEY  PROVIDER  VALUE + BASIS  TOOL OUTCOMES  EVENT SPAN  EVIDENCE    |
| 7c31...      Codex     $8 API equiv.  3/90 errors    28 minutes  partial     |
| d09a...      Claude    $6 API equiv.  0/75 errors    19 minutes  matched     |
+----------------------------------------------------------------------------+
| Session 7c31...: model/effort, execution kind, observed start/end            |
| [All observed days] [Sep 29 UTC] [Sep 30 UTC]                                |
| 10:03  task start                                                          |
| 10:07  tool timeout (enum), 1 observed outcome; no command/result            |
| 10:09  compaction; sizes unavailable                                       |
| 10:12  1 model request, 12k input, 800 output, reviewed rate                 |
| [Metric definitions] [Evidence coverage] [Export selection preview]        |
+----------------------------------------------------------------------------+
```

The literal requested path **machine → repository → agent → session → day** is
available through these filters and breadcrumbs. Day is also a cross-cutting
entry point: Economics → daily chart → selected day → repository → agent →
session. Neither path changes identity; the breadcrumb reflects the route, while
the scope descriptor gives the full active intersection. Back restores filters,
sort order, scroll and keyboard focus.

No transcript detail view exists in this proposal. A session detail is a timeline
of allowlisted event classes and aggregates. It needs a future normalized event
projection; today's session totals cannot reconstruct it. Cross-midnight sessions
stay one session, with observed per-request costs partitioned by day. Session-wide
tool totals or Cursor reported costs cannot be apportioned to a day without event
timestamps; show “session total; daily allocation unavailable.”

## Comparison wireframe and rules

```text
+----------------------------------------------------------------------------+
| Example App / Codex / top-level                     [Edit cohort]           |
| A: Sep 16-22 UTC                B: Sep 23-29 UTC                             |
| Same metric version; both repriced with selected rate card                  |
| Eligibility                    A                    B                      |
| Terminal-evidenced sessions    24                   21                      |
| Matched tool outcomes        420/480              390/500                    |
| Tool errors                   12/420 (2.9%)        18/390 (4.6%)             |
| Difference                                         +1.7 percentage points  |
| Model-call coverage changed; tasks not matched. Association only.           |
| [Inspect excluded observations] [Pin locally] [Preview export]              |
+----------------------------------------------------------------------------+
```

- Default to the previous equal-length period. Complete-week presets have the
  same weekday mix; arbitrary 10/30-day or custom periods may not. Show that
  mismatch and offer complete weeks. Exclude the incomplete current day unless
  the user includes it; then label it clearly. Keep “sessions started in this
  period” separate from a future exact event-window mode. Until event allocation
  exists, never relabel the former as spend occurring inside the period.
- Keep repository, provider, execution kind, available model/effort, metric
  version and cost basis constant. A task cohort exists only through explicit
  user labels or independent outcomes; do not invent task classes from duration.
- Show totals, eligible counts and coverage for both periods before a delta.
  If either period is ineligible, show its raw count and suppress the delta.
- Compare percentages in percentage points; never calculate relative growth from
  a zero baseline. Price comparisons use one selected rate card or display a
  price-change decomposition. Shared-card repricing requires a rescan or retained
  per-request token and modifier inputs; current model/session aggregates cannot
  reconstruct long-context pricing. Without that evidence, mark the values
  incomparable. Do not mix rate changes with behavior changes.
- Session-duration comparisons need the same repository and explicit task cohort;
  otherwise provide distributions without an efficiency judgment. Even matched
  observational cohorts cannot establish that a model or setting caused a change.
- Repository comparison remains capped at six visible series, as today. A table
  can list the rest. No person ranking, inferred human hours or composite score.

## Saved views and local navigation

Save filters, grouping, sort, visible columns, relative period and comparison mode
locally in versioned browser storage. Use predefined labels such as “Recent tool
errors” by default. Optional user-authored names stay local and are excluded from
exports, MCP and diagnostics because they can contain sensitive text. Clear
controls reset browser preferences; they do not delete provider data.

Local URL fragments can encode a bounded route and opaque repository/session
keys, never names, paths or commands. They are not advertised as share links;
even opaque keys are P1. Links may not resolve on another machine, but current
unkeyed hashes can remain linkable when IDs or paths are replicated; do not
promise machine isolation until a per-machine namespace exists. An exported saved
view strips keys, profile identifiers and custom names, leaving portable generic
filters. Schema migrations reset unsupported filters with an explanation rather
than silently broadening the scope. Read-only GET server behavior can remain.

## Empty, stale and partial states

| State | Required copy and next action |
| --- | --- |
| No supported stores found | “No supported local history found. Try synthetic demo or review discovery instructions.” No zero-cost summary implying work never occurred. |
| Stores present, no eligible sessions | “History found; no sessions passed identity checks.” Count fixed exclusion reasons, keep raw errors private. |
| Filter matches nothing | “No observed sessions match these filters.” One action resets filters; source health remains visible. |
| Provider lacks a measure | “Not recorded by this source.” Keep other providers' data; denominator excludes this one and says so. |
| Too little activity | “3 matched outcomes; comparison needs 30.” Show counts, suppress rate warning. Thresholds are provisional product rules. |
| No priced tokens | “Price unavailable.” Show tokens and model IDs; link reviewed rate-card contribution instructions. Never $0 as a substitute. |
| No denominator | “Not applicable.” Never 0% or 100%. |
| Old quota sample | “Last observed 3 hours ago; current headroom unknown.” Never continue a live countdown past a stale sample or reset. |
| Scan in progress | Keep prior snapshot labeled with its timestamp; show fixed progress phases if available. Refresh coalesces; no second scan loop. |
| Scan failed | Keep prior snapshot explicitly stale, provide fixed-text recovery steps. No paths or stack traces. |
| Live or unknown lifecycle | “Working snapshot; totals may change” or “Terminal state not observed.” Closed-session comparison requires explicit terminal evidence; an `idle` label or `snapshotWhileWorking=false` does not prove closure. |
| Missing comparison coverage | “Source coverage changed; comparison unavailable.” Offer like-for-like subset with the excluded counts. |

## Access, scale and migration

All key results have text/table alternatives. Charts support keyboard navigation,
visible focus, non-color encodings and descriptive value/denominator labels.
Focus moves to a session heading on drill-down and returns to its source row on
back. Tables scroll within their region on mobile. Density controls alter row
spacing, not metric semantics. Reduced motion and the current light/dark themes
remain supported; this proposal prescribes no new global visual style.

Implementation should follow the existing active-view-only rendering. A future
index enables bounded session pages and aggregate queries; do not send a growing
event stream to the browser merely to hide most of it. Performance targets must
be measured against a published synthetic corpus, including missing fields and
malformed records, on a specified machine. They are acceptance targets, not
promised benchmarks.

Migration proceeds additively: (1) Evidence panel and denominator components;
(2) one investigation card with a drill-down and matched comparison; (3) unified
scope descriptor and session table; (4) regroup existing tabs only after task-based
testing. Preserve old saved tab selections with a mapping to the new subview.
Coordinate with UI theme lanes through semantic classes and existing CSS
variables; do not merge competing wholesale `app.js` rewrites.

## Design acceptance exercises

Use demo fixtures, never a real-history screenshot. Test these before adopting
the navigation: find an unpriced model, explain a changed error denominator,
follow both day/session paths, return without losing a filter, identify stale
quota evidence, compare a working session with terminal-evidenced baselines, and
preview an export without a repository name. Include a keyboard-only run, a
mobile-width run and a source with zero supported tool outcomes. The success
criterion is an accurate answer with its limitation, not time spent exploring
charts. See the strategy's pilot thresholds for the decision to proceed.
