# Competitive landscape: evidence before positioning

Research snapshot: **2026-10-02**. This supports the [product strategy](product-strategy.md); it is a research proposal, not a claim that proposed functionality has shipped.

The category already covers much more than token totals. Our proposed advantage is a consistently enforced, content-free explanation of agent work across repositories, with reproducible accounting and explicit uncertainty. That is a positioning hypothesis to validate with users, not evidence that competitors cannot implement it.

## Method and limits

The comparison uses primary project repositories and official product documentation retrieved on 2026-10-02. These describe documented capabilities; no competitor was installed, benchmarked, security-audited, or tested against our fixtures. Repository default branches can precede packaged releases. AgentsView explicitly says its documentation follows `main` and can include changes newer than its released package. [AgentsView documentation](https://www.agentsview.io/docs/)

**Documented** means a checked primary source describes the capability. **Not checked** means this review did not establish its implementation or availability; it does not mean absent. **Not documented in reviewed sources** is also not an absence claim. Do not turn either into a red cross in a public comparison page. Provider counts, repository stars, and download counts are intentionally excluded: they change quickly and do not establish accounting fidelity or adoption by our target users.

Product identities are explicit:

- **ccusage** is the project now at `ccusage/ccusage`; the README's older `ryoppippi/ccusage` link redirects there. [Repository](https://github.com/ccusage/ccusage)
- **CodeBurn** means `getagentseal/codeburn`, rather than another project sharing the name. [Repository](https://github.com/getagentseal/codeburn)
- **AgentsView** means Kenn Software's `kenn-io/agentsview`, linked by its official documentation. [Documentation](https://www.agentsview.io/docs/)
- **tokscale** means `junhoyeo/tokscale`. [Repository](https://github.com/junhoyeo/tokscale)
- **CodexBar** means `steipete/CodexBar`. [Repository](https://github.com/steipete/CodexBar)
- **Claude Code `/usage` and `/insights`** mean Anthropic's built-in commands. Current documentation treats `/cost` and `/stats` as aliases for `/usage`. [Command reference](https://code.claude.com/docs/en/commands)

## Documented capability matrix

The final column states our proposed response, not an externally verified product fact. Privacy descriptions report the source's stated behavior; they do not assign competitors our P0–P3 tiers or certify their implementation.

| Product | Scope and surfaces documented | Relevant capabilities documented | Data boundary and verification limit | Proposed response |
| --- | --- | --- | --- | --- |
| **ccusage** | Local coding-agent history; unified and source-specific CLI reports | Daily/weekly/monthly/session views; Claude five-hour blocks; cache classes; model breakdowns; JSON; project/instance grouping for Claude; offline pricing mode. [README](https://github.com/ccusage/ccusage) | Broad multi-source support is documented. Exact cross-provider Git-root/worktree canonicalization and a parser-output privacy manifest were **not checked**. | Make basic reports excellent, but do not sell provider aggregation or JSON as unique. |
| **CodeBurn** | CLI, web, desktop, menu/tray surfaces across many tools | Project/branch/task spend; period comparisons; PR-linked spend; optimization findings with apply/undo and follow-up checks; subscription quota and opt-in guard hooks. [README](https://github.com/getagentseal/codeburn) | Local stdio MCP exposes usage and savings analysis; project names are pseudonymized unless requested. Exact returned-field allowlisting was **not checked**. [MCP guide](https://github.com/getagentseal/codeburn/blob/main/docs/mcp.md) | Outcome accounting, recommendations, quotas, and MCP each need a more specific advantage than merely existing. |
| **AgentsView** | Searchable local session archive; web, desktop, CLI and APIs | Transcript search, project analytics, cost views and optional sharing. [README](https://github.com/kenn-io/agentsview) Heuristic failures/retries/edit churn, context pressure and confidence-labeled outcome scoring are documented. [Session Intelligence](https://www.agentsview.io/docs/session-intelligence/) | Default local archive; opt-in external features and an optional-to-disable liveness ping are documented. [Privacy description](https://www.agentsview.io/docs/#privacy) MCP can expose transcript text and paths. [MCP guide](https://www.agentsview.io/docs/mcp/) | Preserve a metrics-only boundary and avoid a universal session grade; do not claim that tool-health or confidence labels are novel. |
| **tokscale** | Broad multi-agent terminal tracker with interactive views, JSON and web/social surfaces | Project/session/model views; input/output/cache/reasoning breakdowns; provider quota retrieval; LLM-assisted task attribution; optional leaderboard sharing. [README](https://github.com/junhoyeo/tokscale) | Pricing retrieval, quota endpoints, task-analysis backends and social features have different data flows. This review did **not check** every default, retention rule or export field. | Compete on decisions and evidence, without rewarding higher consumption. |
| **CodexBar** | Provider limits in desktop/menu-bar surfaces plus CLI | Quota windows/reset times, quota history, status polling, local cost scans, project/session spending views and usage trends. [README](https://github.com/steipete/CodexBar) | Sources vary by provider, including local files and authenticated endpoints; browser-cookie use is described as opt-in. Exact source behavior across all providers was **not checked**. | Treat live quota visibility as a complementary product; explain repository history and clearly timestamp locally observed limits. |
| **Claude Code `/usage`** | Built-in Claude Code session and subscription views | Current-session token/cost estimates; plan bars; cache misses and likely causes; skill/subagent/plugin/MCP attribution; recent behavior flags. These have version and plan conditions. [Cost guide](https://code.claude.com/docs/en/costs) | Cache statistics cover the main conversation; recent attribution is approximate and machine-local. Dollar estimates are not authoritative bills. [Cost guide](https://code.claude.com/docs/en/costs) | Cross-agent/repository history and source coverage must earn installation beyond the built-in screen. |
| **Claude Code `/insights`** | Built-in session-analysis command producing HTML | Analyzes up to 200 previously unanalyzed local sessions per run, skips very short sessions, and suggests workflow improvements. [Cost guide](https://code.claude.com/docs/en/costs) | Analysis uses the regular provider/account and consumes its tokens. Other devices and claude.ai sessions are excluded. [Cost guide](https://code.claude.com/docs/en/costs) | Offer deterministic, inspectable metrics first; make any later content review an explicit separate action. |

**Our current baseline:** Claude Code, Codex and Cursor history, multi-profile discovery, Git repository/worktree grouping, a versioned rate card, distinct cost bases, pricing coverage, tool/skill/execution counters, dashboard, CLI, JSON, and an agent skill. Public session objects carry hashed keys and repository display names; content-free does **not** mean anonymous. This is established in the current [types](../../src/types.ts), [analyzer](../../src/analyzer.ts), [metrics](../metrics.md), [providers](../providers.md), and [privacy contract](../privacy.md). The proposed reliability, outcome and MCP capabilities must not appear in a shipped-feature comparison until implemented and verified.

## What changes in the strategy

These conclusions are our interpretation of the cited matrix:

1. **Generic visibility is a prerequisite.** Counts, costs, charts, provider aggregation, project views and JSON improve usability, but do not establish a defensible position by themselves. Ship them when they remove friction for the target user; do not spend a quarter chasing the longest provider list.
2. **“Local” needs a precise definition.** Storage location, network behavior, output fields, content retention and optional features are separate promises. Our useful distinction is a testable parser-output contract across every surface. Publish the manifest and adversarial fixtures, including its limits: metadata can identify a person or repository, and the parser still reads sensitive local files.
3. **Agent-facing is a distribution channel, not automatically a moat.** A useful agent response should give an evidence window, eligible denominator, freshness, uncertainty and suggested next observation in a bounded schema. Keep the caller from requesting transcript text through that interface. Measure whether those answers actually change a user's next step.
4. **Reliability explanations need independent usefulness.** A repeated failure signal is already category overlap. Our candidate improvement is a drill-down that separates provider/network faults, environment faults, user interruptions and tool failures, with coverage and same-repository comparison. Do not reduce these to a single quality score.
5. **Outcome metrics must survive scrutiny.** A recorded commit or merged PR is evidence of an artifact, not proof the agent caused it or delivered value. Preserve unattributed work, shared sessions and uncertainty. Cost per artifact needs a denominator and attribution method beside it.
6. **The installation must earn its place.** A user with one provider and a simple quota question may already be well served. The initial audience should be developers who combine providers, profiles and parallel sessions and cannot explain a change in their repository's consumption without inspecting private transcripts.

## Differentiation hypotheses and falsification tests

These are proposed experiments, not observed market demand. Recruit at least five consenting multi-agent developers before treating any as validated. Have participants run locally and share only an explicit content-free result or interview answer; do not collect their histories.

| Hypothesis | Concrete product proof | What would falsify or weaken it |
| --- | --- | --- |
| The privacy contract changes willingness to adopt | A participant can inspect the output preview and explain which data survives parsing; audit the JSON against planted sensitive fixtures | Participants treat existing local tools as equally acceptable, or cannot understand the distinction without lengthy explanation |
| Reproducibility is valuable when totals disagree | Show known/unpriced tokens, source coverage, price-card revision and dedupe reason counts for one synthetic discrepancy | Users cannot connect the explanation to a decision, or ordinary provider reports resolve it as quickly |
| Repository-centered explanations beat another global total | In under five minutes, locate a repository's change and identify one supported contributor with its denominator | Users still need raw prompts to decide anything useful, or cross-provider grouping is irrelevant to their routine |
| Parallel-agent users need attribution beyond parent totals | Show own/delegated/shared-or-unknown usage and time overlap without double counting | Delegation is rare, or the added explanation makes basic totals harder to trust |
| Metrics-only agent answers change behavior | An agent retrieves a narrowly scoped baseline, cites coverage and asks for evidence when unavailable | The tool produces generic advice, repeats the dashboard, or its query cost outweighs its utility |
| Weekly review can create a durable habit | A participant selects one change, compares comparable periods, and records whether the signal moved | Review cards become unacted-on alerts or falsely imply savings from a changing task mix |

These tests intentionally allow coexistence. Success can mean that someone keeps another tool for live quota checks or transcript recall while using this one for reproducible, content-free repository analysis.

## Non-goals for the next quarter

- A transcript search/archive product. It changes retention, threat model and user expectations before validating the core analytics job.
- A leaderboard, developer performance ranking, or scalar productivity score. Volume and elapsed time cannot establish delivered value.
- A replacement billing console. Observed token value and subscription headroom are different measures, and neither should masquerade as an invoice.
- A live credential broker or account switcher. Prefer already-recorded quota samples, labeled with source and age; stale history cannot guarantee capacity for a new task.
- Automatic edits to agent settings or policy enforcement. Recommendations should be reviewable and their effect measurable before considering a separately authorized control surface.
- A hosted team control plane. First demonstrate an explicit, minimized aggregate export contract with suppression and preview; pseudonymous records are not inherently anonymous.
- A claim to be first, only, most accurate or most private. This review is insufficient to substantiate any of those superlatives.

## Source register and refresh procedure

All entries were retrieved **2026-10-02**. “Undated” means the inspected page supplied no unambiguous publication/update date; it does not mean unchanged. Copyright years and crawl timestamps are not publication dates. Links to `main` below are mutable references, not release pins.

| ID | Primary source | Source date / version scope |
| --- | --- | --- |
| C1 | [ccusage README](https://github.com/ccusage/ccusage) | Undated default-branch README; packaged behavior not tested |
| C2 | [CodeBurn README](https://github.com/getagentseal/codeburn) | Undated default-branch README; packaged behavior not tested |
| C3 | [CodeBurn MCP guide](https://github.com/getagentseal/codeburn/blob/main/docs/mcp.md) | Undated `main` guide |
| C4 | [AgentsView README](https://github.com/kenn-io/agentsview) | Undated `main`; source warns it can precede release |
| C5 | [AgentsView documentation and privacy](https://www.agentsview.io/docs/) | Undated live docs following `main` |
| C6 | [AgentsView Session Intelligence](https://www.agentsview.io/docs/session-intelligence/) | Undated live guide; described scoring model labeled 0.23.0 |
| C7 | [AgentsView MCP guide](https://www.agentsview.io/docs/mcp/) | Undated live guide |
| C8 | [tokscale README](https://github.com/junhoyeo/tokscale) | Undated default-branch README; packaged behavior not tested |
| C9 | [CodexBar README](https://github.com/steipete/CodexBar) | Undated default-branch README; packaged behavior not tested |
| C10 | [Claude Code cost and usage guide](https://code.claude.com/docs/en/costs) | Undated live docs with feature-specific version conditions |
| C11 | [Claude Code command reference](https://code.claude.com/docs/en/commands) | Undated live command reference |

Before launch, pin the versions used in any public comparison and recheck changed cells against those versions. Test any claimed interoperability using synthetic histories only. Revisit positioning monthly through launch, and whenever a primary source contradicts a proposed advantage. Preserve the distinction between documentation, measured behavior and user preference in every revision.
