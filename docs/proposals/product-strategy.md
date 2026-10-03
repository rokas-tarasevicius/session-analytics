# Product strategy: a local evidence ledger for agent work

**Decision proposal · 2026-10-02 · grounded in the 0.5.0 checkout.** This lane
changes documentation only. The features, interfaces, release dates and success
targets below are proposals, not shipped capabilities or measured adoption.

Build Session Analytics for developers who run several coding agents across
repositories and want to understand a change in their workflow without exposing
conversation content. The product should answer **“What changed, what evidence
supports that, and what should I inspect or try next?”** Its durable asset is a
reviewed accounting and evidence contract that every surface shares. More token
charts, a productivity score, or a hosted team dashboard would dilute that job.

The first repeatable workflow is a weekly repository review: compare like-for-like
observations, inspect one discrepancy or friction signal, choose one reversible
change, and return to see what moved. Prove that people can make a useful decision
from this loop before building automatic coaching or team infrastructure.

## Reading map

| Artifact | Decision it supports |
| --- | --- |
| [Evidence audit](evidence-audit.md) | What the code does; which real local fields were observed; what is missing or unverified |
| [Competitive landscape](competitive-landscape.md) | Seven named alternatives, current primary sources, overlap and falsifiable positioning |
| [84-feature portfolio](feature-portfolio.md) and [sortable CSV](feature-scores.csv) | All 12 requested categories, individual scores, exact data mappings, risks, ranks and dependencies |
| [Metric contracts](metric-contracts.md) | Initial formulas, minimum-activity rules, missing-data semantics and synthetic examples |
| [Dashboard architecture](dashboard-information-architecture.md) | Navigation, ASCII wireframes, drill-downs, saved views, comparisons and empty states |
| [Distribution and launch](distribution-launch.md) | Compiled npm, Homebrew, executable gates, docs, naming, governance and launch checklist |

## What exists today, and what the audit changed

The current product already discovers Claude Code profiles and Desktop local
agents, Codex active/archive stores, and Cursor SQLite history; optionally uses
Conductor metadata; validates source identity; groups by canonical Git repository;
deduplicates streamed/broadcast usage; and calculates API-equivalent value from a
versioned rate card. It exposes tools, skills, execution counters and coverage
through a loopback dashboard, report, JSON snapshot and agent skill. Analysis
runs in capped child processes and returns a field-by-field projection. These are
verified in [types](../../src/types.ts), [analyzer](../../src/analyzer.ts),
[architecture](../architecture.md), [providers](../providers.md), and evidence
[E01](evidence-audit.md#e01-current-product-and-public-contract).

It does **not** yet have a persistent index, metrics-only MCP, tool-result
reliability ledger, quota-history parser, artifact outcome attribution or coaching
system. Repository names and stable hashes already appear in local outputs;
content-free is not anonymous. Discovery of several profiles does not expose a
profile dimension and does not identify billing accounts.

The real-data audit sampled shapes, not transcript meaning. It inspected 36
Claude profile files (9,707 object records), 12 Desktop files, and 22 Codex files
(3,915 records), plus bounded Cursor, Conductor, auxiliary and SQLite checks.
Selection used modification-time ranks and prefix caps, with profile aliases
deduplicated. It was not a random sample or a full scan. No real names, IDs,
paths or content are reproduced in these documents. Exact denominators and
limits are in [the audit method](evidence-audit.md#method-and-interpretation).

Five findings change the sequence:

1. **Structured tool outcomes are usable now, but coverage is uneven.** Claude
   result error fields and Codex command statuses appeared in the sample. Some
   attractive fields in the brief—Codex structured MCP outcomes, detailed
   compactions, parent-thread edges—remain inventory-only in this audit. Ship a
   bounded observed subset first; do not infer cross-provider parity.
2. **Quota history is observable, not live.** 477 of 573 sampled Codex token-count
   records carried primary-window fields. This is sample field presence, not
   83% of all requests or files. Profile/account ambiguity and freshness must be
   solved before presenting a remaining-capacity claim.
3. **Receipt enrichment is a reconciliation problem.** Conductor SDK results
   were found inside `session_messages.content`; the `full_message` column was
   null in the sampled rows. Cumulative cost-state and stats-cache receipts can
   overlap canonical transcript usage. More sources cannot simply be summed.
4. **New comparisons need semantic fixes first.** Current date filters select
   sessions by start date and use their whole-session totals. API and browser
   cache ratios disagree when the denominator is zero. The context diagnostic
   divides independent maxima, which can come from different requests. Preserve
   existing labels and fix these prerequisites before claiming exact period
   spend, comparable ratios or a true context-fill peak.
5. **Distribution needs real engineering.** The package is private and its bin
   is TypeScript. Node refuses TypeScript under `node_modules`; a compiled npm
   artifact must also handle worker URLs and bundled assets. See the
   [Node 24 dependency restriction](https://nodejs.org/docs/latest-v24.x/api/typescript.html#type-stripping-in-dependencies)
   and [release plan](distribution-launch.md#compiled-npm-package-first-supported-artifact).

## Who to serve, in order

These personas are hypotheses inferred from the product and available evidence,
not interview findings. Validate their jobs with volunteers before investing in
personalization or a commercial offering.

| Persona and priority | Trigger / job to be done | Useful decision and first experience | Evidence limits / what to avoid |
| --- | --- | --- | --- |
| **Parallel-agent power user — primary** | “I ran several agents on a repository; why did usage or friction jump?” | Isolate a provider/profile/execution cohort; distinguish a tool error burst, shared-counter attribution or unpriced model; review one change weekly | Child sessions and Claude composites are different units. Do not call span overlap speedup or attribute all child value to one parent twice. |
| **Solo subscription developer — secondary entry audience** | “Where did my work go, and is there a useful change before my next reset?” | Open with credible repository value/coverage and timestamped quota observations; compare one repository, optionally enter a plan price | API-equivalent value is not subscription cost, money saved or ROI. A one-provider quota-only user may not need this tool. |
| **Tech lead / team — design partners later** | “Can we identify shared tool friction and improve our working environment without evaluating people?” | Receive a user-previewed coarse aggregate from willing contributors; see coverage differences before comparison | No individual rankings, task-completion score or inference about hours worked. Incomplete team participation and different capture policies invalidate simple totals. |
| **Security-conscious organization — trust reviewer now, deployment later** | “Can developers investigate agent usage without creating a second transcript store?” | Inspect manifest/process boundary, run synthetic sentinels/offline checks and approve a narrow local workflow | Local parsing still reads sensitive content; names, timestamps and hashes can identify work. No claim of certification, anonymity or guaranteed policy compliance. |
| **The coding agent — bounded machine consumer** | “Before choosing a tool, what is the observed baseline for this repository?” | Query a small metrics response with scope, sample count, coverage, freshness and unknowns; cite that evidence in its suggestion | No transcript retrieval, arbitrary SQL/path access or permission-policy control. Historical failure counts do not authorize changing tools, budgets or settings. |

The power user is the lead audience because profile/provider/delegation ambiguity
is a repeated structural problem the present architecture can address. The solo
developer provides a simple installation path and a check against excessive
complexity. Team requests should influence the sharing contract early, but should
not force a hosted service or identity system into the first release.

## Positioning and alternatives

The proposed promise is **“Understand your coding-agent work across repositories,
without exposing conversation content.”** Demonstrate it with one discrepancy
explained, one unsupported conclusion refused, and one reversible experiment.

Basic aggregation is crowded. CodeBurn documents quota, optimization and PR-linked
spend; AgentsView documents reliability heuristics and confidence-labeled session
intelligence; Claude Code documents cache and attribution insights. These are
documentation claims, not features we benchmarked. [CodeBurn](https://github.com/getagentseal/codeburn),
[AgentsView Session Intelligence](https://www.agentsview.io/docs/session-intelligence/),
[Claude Code usage guide](https://code.claude.com/docs/en/costs)

The [full comparison](competitive-landscape.md) also covers ccusage, tokscale,
CodexBar and `/insights`, with identities, source dates and limits. Do not claim
“the only repository view,” “the first agent MCP,” or “more accurate than X.”
Users may keep a quota menu bar or transcript browser alongside this product.

Three specific bets deserve validation:

- **Trust can be demonstrated rather than asserted.** A user can reconcile a
  figure through rate-card revision, dedupe rule, coverage and an allowlisted
  observation. Publish synthetic adversarial examples. The promise fails if
  users still need to reveal raw histories to resolve routine discrepancies.
- **Same-repository explanations can reduce investigation effort.** A changed
  error share should show matched outcomes and alternative explanations, not
  label a model bad. The promise fails if the report only restates totals or
  task-mix changes swamp its usefulness.
- **One contract can serve both humans and agents.** Dashboard, CLI, JSON and
  future MCP answer with the same scope and semantics. The promise fails if
  agents produce generic advice, overinterpret thin evidence or require broad
  content access to use the metrics.

None is a permanent moat. A durable open-source advantage would be a growing,
reviewed corpus of provider-format fixtures, reproducible accounting rules,
well-documented uncertainty and trusted contributors. This is an operating
strategy, not a claim that competitors lack the same discipline.

## The first product loop

Use the proposed five destinations: **Overview, Repositories, Economics,
Workflow, Evidence**. The complete [navigation and wireframes](dashboard-information-architecture.md)
preserve current charts as subviews. The default overview has at most three
investigation cards; every card leads to a scoped table or event ledger with
denominators, exclusions and metric definition. Evidence is visible beside the
number, not buried in a footer.

The core path is machine → repository → agent/provider/execution actor → session
→ day. A day chart can enter the same path in reverse order. Preserve filters
and back-navigation state; do not invent independent Claude child sessions from
composite totals. A session detail contains allowlisted event classes, never a
transcript. Exact day-level tool counts require a future event projection.

Saved views are local bounded scope descriptors, not share URLs. Comparisons
default to adjacent equal-duration periods; only complete weeks guarantee matched
weekday mix. They hold repository/provider/execution, metric version and cost
basis constant. Duration needs an explicit same-task cohort before an efficiency
judgment; model/session labels cannot establish one. Repricing needs request
inputs or a rescan. Unknown lifecycle is not a closed session.

The weekly loop is deliberately modest: inspect a supported change, choose a
reversible experiment, freeze comparison scope, and revisit. No automatic prompt
rewrites, skill removal, account switching or settings edits. Report “signal
changed; task mix may differ,” not “you saved $50” or “your agent improved 20%.”

## Ranked portfolio and decisions

The [84-row portfolio](feature-portfolio.md) spans cost/limits; tokens/context/cache;
tools/reliability; outcomes; workflow/behavior; agent-facing; coaching; team;
privacy; UX; integrations/exports; distribution. Each row has an exact data path
or an explicit missing input, a concrete risk, dependencies and a planned or
deferred horizon. It scores value, effort, availability and risk separately from
a seven-alternative differentiation vector.

The ranking weights value and evidence above novelty:
`5 × value + 4 × mean differentiation + 2 × availability − 2 × effort − 2 × risk`.
Scores are editorial decision aids; they do not represent measured demand or
competitor performance. The machine-readable CSV retains the exact numerator
and deterministic tie-breaks.

The leading items are the projection/sentinel kit (PR05), source capability
inspector (PR01), metric explainers (UX05), snapshot versioning (IN01), and
unpriced-usage triage (CO02). They make existing work trustworthy and future work
reviewable. The launch package (DS01) comes earlier than its rank because nobody
benefits from a correct feature they cannot install. Team/content features can
remain deferred even when their potential value is high.

Reject these alternatives for the next quarter:

| Alternative | Why reject it now | What would justify reconsideration |
| --- | --- | --- |
| A broad token/cost dashboard race | Existing tools already cover these questions; feature count does not test our decision workflow | A missing provider prevents the chosen pilot users from answering the core question |
| A scalar productivity or agent-quality score | Activity, interruptions, errors and test markers do not establish outcome quality | Independent task outcomes plus a specific validated use; still no worker ranking |
| Automatic “optimization” changes | Causal evidence and authorization are missing; interventions broaden a read-only trust boundary | Repeated useful advisory experiments and a separately reviewed control surface |
| Content-based coaching by default | Creates a new content-retention/send path before validating deterministic metrics | Explicit demand, per-run preview/consent, separate storage and evaluation; no quarter commitment |
| Hosted team control plane | Authentication, access control, identity, consent and operational obligations dominate scope | A reviewed aggregate-sharing pilot demonstrates recurring demand and funded maintenance |
| Single binary as launch gate | Worker/runtime/assets/signing parity is unproven | Capped packaging spike passes the executable gates and a runtime patch owner accepts maintenance |
| “Cost per surviving line” as the flagship | Refactors, squashes, task difficulty and selection effects undermine interpretation | A narrow opt-in artifact study with independent outcome evidence; never line-count leaderboards |

## Roadmap: two weeks, six weeks, quarter

These are **planning horizons from acceptance**, not release promises or a
rewriting of the repository's existing milestone status. Assume two engineering
contributors, ten workdays per two weeks, with maintainer review inside the
budget. This is a capacity scenario, not a staffing fact. If only one contributor
is available, reduce breadth or extend dates; never waive correctness gates.
Other lanes' work is an integration dependency, not free completed capacity.

### Next two weeks: an installable, understandable evidence baseline

Budget **20 contributor-days**: 14 scoped implementation days, 3 integration and
review days, 3 contingency. Full portfolio ideas can exceed their initial slices.

| Scoped deliverable | IDs / initial days | Acceptance gate |
| --- | --- | --- |
| Projection checklist and sentinel extension recipe | PR05 / 2 | New fields/surfaces have one review contract; source/installed-output sentinel parity is specified |
| Versioned snapshot foundation | IN01 / 1 | Agree schemaVersion with other lanes; document compatibility; no conflicting envelope |
| Capability/semantics baseline | PR01 / 3 | Fixed supported/unavailable reasons; reconcile zero-denominator behavior; expose existing context proxy honestly; preserve start-date cohort labels |
| Metric explanation and unknown-model investigation | UX05 + CO02 / 3 | A synthetic user can explain cost basis, price coverage, one unpriced model and N/A without reading source |
| Compiled npm prerelease | DS01 / 5 | Packed artifact runs outside checkout with both workers, SQLite, rate card/assets and offline synthetic parity |

If the package exceeds five days, cut decorative UI and broad capability coverage;
ship a minimal Evidence panel and the source checkout while completing the
installer. Do not publish an untested npm command. The exit is a credible public
preview foundation, not six finished analytics families.

### By six weeks: prove one recurring investigation

Additional **40 contributor-days**: target 31 implementation, 8 integration/pilot,
1 contingency. Source sampling and normalized index design are part of this
work; an unmerged index-store lane cannot be assumed ready.

| Selected slice | IDs / days | Exit evidence |
| --- | --- | --- |
| Matched tool outcomes on verified source shapes | TR01 / 7 | Correct call/result dedupe, interruptions/unknown separated, outcome coverage, synthetic adverse cases |
| Machine-local profile keys and dimension | PR03 + WF01 / 9 | Alias dedupe, no profile path or account assumption, rotation/reset semantics, restricted key storage |
| Observed quota history | CO05 / 5 | Source-profile/window observations, account identity unknown; sample age and stale/reset state; no cross-profile sums, live forecast or token conversion |
| Matched comparison, then one overview investigation | UX04 + UX01 / 10 | Same-cohort scope and both denominators; current period semantics explicit; at most three cards and accurate empty state |

TR01 is the lead hypothesis; do not implement seven reliability measures before
testing it. CO05 can ship first for Codex with Claude unavailable where sparse.
If profile identity work overruns, restrict the pilot to one explicitly selected
source profile and defer profile comparison; retain ambiguity labels. That is a
scope cut, not a silent account merge.

Candidates DS02/DS04/DS05/DS06 (tap, docs site, fixture kit, launch walkthrough),
TC01/PR07 (cache comparison, drift) and UX07 (expanded accessibility audit) enter
only by replacing a planned slice or adding measured capacity. Basic accessibility,
privacy documentation and fixtures are part of every slice, not optional extras.
The distribution plan's six-week tap/site target is therefore conditional on
packaging/docs contribution capacity. Prefer a good README and npm release to an
unmaintained second installer.

### Quarter: bounded agent and artifact pilots

Additional **60 contributor-days**: allocate at most 45 implementation/experiment
days, 12 integration/review days, 3 contingency. Advance only if the six-week
pilot validates the core job. This tranche is deliberately a mix of small shipped
contracts and capped research; it does not promise a complete outcome or team system.

| Work | IDs / cap | Go/no-go condition |
| --- | --- | --- |
| Bounded metrics-only queries plus tool baseline | AF05 + AF02 / 11 days | Read-only narrow scope; explicit unknowns and limits; agent can cite denominator without inferring success |
| Exact export preview and coarse bundle pilot | PR02 + TE01 / 12 days | Synthetic-only bundle pilot until coarse fields and static small-cell/complementary-total policy pass review; repeat-export risks explicit; no upload/service. PR02 preview can ship separately |
| Artifact evidence pipeline pilot | OU02 + IN03 + OU03 / 16 days | Structured event → bounded local Git check → opaque evidence link; many-to-many/unknowns visible; no merged-PR efficiency claim without independent merge evidence |
| Delegation graph schema spike | WF04 / 4 days | Verify actual parent-edge formats; handle aliases/resumes; prove sums invariant. Stop if source fidelity cannot support it. |
| Standalone executable feasibility | DS03 / 2 days | SQLite/assets/worker isolation demonstrated or explicitly deferred; full release remains separate |

Cut order if capacity is tight: executable spike, delegation graph, team bundle,
then artifact pilot. Preserve core accounting, installed-artifact tests, privacy
and the one validated investigation path. CH02 experiment notebook, PR04 index
lifecycle, DS07 broader verifiability and TE07 adoption kit remain candidates
until an owner and estimate exist. No team collector, P3 review, automatic hook,
GitHub upload/enrichment or OpenTelemetry endpoint is a default quarter feature.

### Cross-lane integration contract

| Lane(s) | Input this strategy expects | Coordination constraint |
| --- | --- | --- |
| pricing-api, limits-cache | Cost basis, reviewed modifiers, aligned cache/context, sample freshness | Keep prices versioned; no current-headroom claims from stale history |
| reliability, behavior, velocity | Normalized result statuses, durations, intervals and explicit eligibility | One enum/denominator vocabulary; no raw errors or productivity interpretation |
| index-store, providers | Versioned bounded events, ingest provenance, source drift/capability | Correlation metadata may contain local paths internally; never serialize it; define rebuild/retention separately |
| outcomes | Evidence-ranked artifact relationships | Preserve shared/unlinked value and independent outcome checks |
| mcp-agent, interop | Bounded queries and minimized serializers | Reuse projection/metric semantics; no transcript or arbitrary SQL escape hatch |
| insights, ideation-research | Signal evaluation and evidence limitations | Calibrate provisional thresholds; avoid competing “success” scores |
| UI theme lanes | Readable controls and existing visual tokens | Add panels/modules; IA migration later, not concurrent wholesale app rewrites |

## Validation without telemetry

The application remains telemetry-free. Pilot learning uses voluntary interviews,
synthetic tasks and user-authored conclusions. Do not add an installation ID,
silent event stream, error upload or automatic feedback prompt to measure success.
Aggregate download counts can inform release logistics but are not active usage.

Recruit six consenting volunteers: two subscription users, two parallel-agent
users, one Linux user and one security-focused reviewer; at least five should use
multiple providers/profiles or parallel sessions so the lead hypothesis is tested.
Roles can overlap. Give them a synthetic task first; let them choose whether to
run on local history privately. Receive only their conclusion or a synthetic
reproduction, never a real screenshot or transcript export.

| Stage | Proposed success threshold | Failure response |
| --- | --- | --- |
| Installation | All six finish a supported install; all advertised artifact checks pass | Fix packaging/support scope before broader launch |
| Comprehension | At least five distinguish API-equivalent value, reported value and missing evidence; none receives a misleading invoice claim | Rewrite labels and unknown states before new charts |
| Investigation | At least four find a supported contributor to a synthetic repository change within five minutes and state one limitation; two minutes is the design target | Simplify scope/drill-down; remove unhelpful metrics |
| Useful decision | At least four describe a concrete next step; “no supported change” is acceptable when correct | Reconsider the lead job if decisions require raw content or unrelated external data |
| Return use | At least three voluntarily report a second repository review within two weeks; no passive tracking | Improve the weekly task or narrow the audience; do not add alert volume to manufacture engagement |
| Agent pilot | Five scripted synthetic queries, including insufficient/stale evidence, all return correct bounds and no content; human evaluates advice quality | Restrict tool scope or defer MCP rollout |

These small counts are release-learning heuristics, not statistical market
validation. Measure task correctness and understanding alongside elapsed time;
a fast wrong conclusion is a failed design. Record source/provider/version gaps
without treating one developer's machine as population evidence.

## Distribution, open source and stewardship

Keep the descriptive working brand for preview; check naming/registry ownership
before publishing and prefer an owned npm scope if necessary. No trademark,
domain or registry availability is asserted here. Publish compiled ESM on npm
first, a project Homebrew tap after parity, and a standalone runtime only after
its separate gates. Keep source-checkout development and zero runtime dependencies.
The [release plan](distribution-launch.md) gives exact layout, worker/asset issues,
minimum-runtime tests, artifact review, provenance limits and a publication checklist.

Use repository Markdown as canonical documentation, later rendered statically
without tracking scripts or remote assets. Launch with a synthetic discrepancy
walkthrough and an honest privacy/coverage example, not high consumption as a
badge of success. Make public comparison claims version-specific and recheck
them before release. No publication or outreach is performed by this proposal.

Retain MIT and maintainer-led review. The best first contribution is a synthetic
provider-format fixture, a rate-card correction with a dated primary source, or
an accessible explanation of a confusing measure. Ask for synthetic reproductions,
not “redacted” production logs. New fields require types, manifest, definitions and
sentinel coverage together. Encourage small modules so current parallel lanes can
merge without redesigning the analyzer at once.

Do not choose a revenue model before validating repeated usefulness. If an
organization later funds support, packaging or aggregate deployment, price the
maintenance/service explicitly; keep the local privacy contract and export control
intact. No paywall or hosted-service implementation is proposed here.

## Decisions to revisit, with triggers

- Revisit the primary persona if fewer than three eligible multi-provider/profile/parallel
  pilot users report a repeat review, or if cross-provider/profile ambiguity rarely affects a decision.
- Revisit outcome work if explicit artifact links cover too few eligible sessions
  to support a useful review; report coverage instead of adding weak time matches.
- Revisit a profile/account mapping only when there is stable explicit evidence
  or user-controlled configuration; never infer it from directory naming.
- Revisit team sharing only after a recipient can use the minimized bundle and a
  reviewer can explain its reidentification limits. A k threshold alone is not
  sufficient; complementary totals and repeated exports leak differences.
- Revisit content review only through a separate opt-in design with concrete
  demand. The inability of counters to answer a question can be the right answer.
- Revisit calendar commitments after integrating the other lanes' actual code.
  A proposal, a sampled field and a passing source test are three different kinds
  of evidence; none substitutes for a shipped, usable, correctly interpreted feature.
