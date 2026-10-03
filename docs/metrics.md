# Session analytics metric and interpretation catalog

This reference defines the privacy boundary, current metrics, and candidate extensions for the local session analytics dashboard. Update it together with parser tests whenever a metric changes meaning.

## Evidence boundary

The analyzer may read provider transcripts locally, but its returned data is restricted to:

- a stable local repository key and display name;
- a one-way hashed local session key, provider, status, and timestamps;
- provider session identity and workspace CWD used internally only for correlation;
- model and reasoning-effort identifiers;
- physical token counters and context-window sizes;
- event-class counts and timestamps;
- tool names and stable call IDs, never arguments or results;
- normalized skill identifiers derived from explicit Claude `Skill` events or canonical Codex `SKILL.md` reads, never skill arguments or paths;
- transcript file count, validation status, and bounded parser warnings;
- costs derived from the versioned rate card.

The CLI JSON, API, and dashboard must not return prompts, messages, reasoning, session titles, branches, workspace metadata, repository roots/remotes, raw Conductor IDs, provider session IDs, tool arguments, tool results, commands, file paths, transcript paths, process arguments, credentials, raw local errors, or arbitrary environment output.

The default scope is the union of supported local Claude, Codex, Cursor, Copilot CLI, OpenCode, and Gemini CLI history. It is evidence-led rather than application-led or a blind filesystem crawl: provider working directories, Cursor workspace/file references, optional Conductor workspace mappings, and canonical Git roots determine repository assignment. Provider discovery must work without Conductor. When its database is available, Conductor adds repository/workspace correlations and registered zero-session repositories but does not define the machine boundary. Repository summaries and a single flattened session collection share stable repository IDs; sessions are not duplicated inside public repository objects.

Every provider profile on the machine is in scope: `~/.claude/projects`, sibling profiles such as `~/.claude-work/projects`, `$CLAUDE_CONFIG_DIR/projects`, `~/.config/claude/projects`, and Claude Desktop local-agent sessions; `~/.codex/{sessions,archived_sessions}`, sibling `~/.codex-*` profiles, and `$CODEX_HOME`. Roots that resolve to the same directory through symbolic links are read once. An explicit root option replaces discovery for that provider, so narrowed and synthetic scans never mix in the machine's own history.

Provider transcript stores are canonical evidence that a session can be analyzed. Conductor SDK results can recover a lower-fidelity session only after canonical discovery and unique legacy matching have failed. Rows without either kind of validated evidence remain excluded. A legacy row without a provider ID is first matched through a unique provider, working-directory, and start-time match. Fallback never supplements an existing canonical identity, so database stubs and copied summaries cannot inflate its totals.

## Current measures

### Spend and usage

- input, uncached input, cache-read input, and observable cache-write input tokens;
- output and, where exposed, reasoning-output tokens;
- non-reasoning output derived only when reasoning output is separately exposed;
- ordinary API-equivalent estimate and cache-write upper estimate;
- priced usage value by session and model, plus activity day only where cost timestamps are evidenced;
- price coverage: the share of observed input plus output tokens assigned to a known rate, or not applicable when no tokens were observed;
- cache-read ratio and cache-write volume;
- largest per-call input and configured context window, retained as parser diagnostics rather than promoted as a dashboard score.

Codex input is request-context consumption, not unique transcript text: the same cached context is counted again whenever it is processed by another model call. Codex also broadcasts the same process-wide `total_token_usage` snapshot into multiple session files. Deduplicate exact total/last-usage states across the full evidence union, attribute each state to the observing file whose nearest preceding local response event is closest, break equal scores by timestamp and path, and sum `last_token_usage`; never sum a process-wide cumulative delta once per file. When a state carries no usable `last_token_usage`, only a delta between two snapshots that same evidence file observed is attributable to it: treat the file's opening snapshot, and the first snapshot after the counter moves backwards, as a baseline that is recorded and excluded. Billing an opening snapshot charges a whole process history to one request, which lands the parallel work of many sibling sub-agents on a single session and on the calendar day that session started. This activity-backed ownership prevents an earlier stale receiver from taking a request generated by another repository or model. A new `session_meta` can change a file from sub-agent to top-level execution, so allocate each deduplicated request to the execution segment active at the owning observation. Claude cache creation and reads are separate physical counters. Attribute Claude main-file usage to top-level execution and usage from its `subagents` evidence tree to sub-agent execution before aggregating the composite session. Provider reasoning output remains included in output pricing.

### Execution shape

- user-visible turns;
- assistant/model responses;
- model calls inferred from distinct positive usage increments or response IDs;
- task starts and completions when the provider emits them;
- context compactions and summary boundaries (Codex records the same lifecycle events as legacy `event_msg` notifications, `item_completed` items, and top-level `compacted` records; a file can carry several shapes for one event, so user turns, assistant messages, and compactions take the largest shape count rather than the sum);
- effective tool calls by tool name;
- skill invocations by normalized identifier, with evidence labeled explicit for Claude, inferred lower bound for Codex, and unavailable for Cursor;
- transport/orchestrator tool calls before code-mode expansion;
- Claude queue operations and delegated-agent identities;
- session wall span and provider-event span;
- live versus terminal status when observable.

Machine views also include repository count, repositories with selected sessions, working-snapshot count, explicit top-level/sub-agent execution value, and per-repository comparison dimensions. Usage-value comparisons must show transcript and pricing coverage beside totals.

Tool names are useful for workload shape. Tool call counts do not prove useful work, failure, or causal responsibility.

Skill names are a reviewed derived field rather than raw tool input. Accept only bounded canonical identifiers. Claude exposes an explicit `Skill` tool with the skill identifier in structured input. Codex does not expose a dedicated skill event, so count at most one invocation per tool call and skill identifier when a read-capable call references a canonical `<skill>/SKILL.md`; label these counts as an inferred lower bound. Do not infer skill usage from system instructions, user messages, arbitrary transcript text, directory enumeration, or an installed-skill inventory. Cursor skill coverage is not applicable until its local history exposes a stable invocation signal.

### Evidence health

- provider evidence validation status;
- provider session ID and workspace CWD validation;
- transcript files in the evidence set;
- stable versus working snapshot;
- cumulative-counter monotonicity;
- malformed records skipped;
- unsupported provider, schema, or model price.

## Useful derived indicators

These can be added without reading content, provided they are labeled as indicators:

- priced usage value per user turn, task completion, model call, effective tool call, or active hour;
- cache savings compared with pricing all input as uncached;
- context churn: cumulative input divided by largest context window or event span;
- compactions per hour and spend between compactions;
- tool diversity and concentration by family;
- delegation fan-out and tool use per delegated actor for Claude;
- model-switch count and spend allocation across model changes;
- concurrency timeline: number of repository sessions with overlapping event spans;
- priced-usage velocity by day or week and rolling change from the preceding period;
- analyzed-session count, price coverage, working-snapshot share, and the eligible denominator for provider-specific measures;
- outlier ranks for priced usage value, duration, tool calls, and compactions.

Ratios with tiny denominators need a minimum-activity guard. Ratios with no denominator are not applicable, never 0% or 100%. A session with one task-complete marker is not necessarily more efficient than a session whose provider does not emit that marker.

## Metrics requiring independent evidence

Do not derive these from transcripts alone:

- successful or failed outcome;
- merged pull requests, closed issues, deployed artifacts, or recovered systems;
- value delivered, human time saved, correctness, or quality;
- root cause, death-spiral diagnosis, or missed stop point;
- cloud, provider-tool, CI, or human labor cost not present in usage receipts;
- billable invoice amounts under a subscription, enterprise agreement, discount, priority tier, region modifier, tax, or provider credit.

These require Git, GitHub, CI, deployment, provider billing, or explicit human evidence. Correlate them through a bounded forensic or product-ledger workflow rather than inferring them from volume.

## Pricing semantics

`rate-cards.json` is a reproducibility input, not a claim that prices never change. Each entry records an effective date and primary source. An unrecognized model remains unpriced until a reviewed entry is added.

The Claude Opus 5 entry uses Anthropic's standard global API rates. The analyzer does not apply fast-mode, US-only inference, batch, or partner-platform modifiers because local Claude history does not establish those billing dimensions.

The Claude Fable 5.1 entry prices cache hits at 0.025x base input, the published exception to Anthropic's standard 0.1x cache-read multiplier; its base input, cache-write, and output rates match Claude Fable 5.

The Claude Opus 5.5 entry prices cache hits at 0.05x base input ($0.20 per million tokens), the published exception for that model; its 5-minute and 1-hour cache writes use the standard 1.25x and 2x multipliers. Claude 4.6 and later models carry no long-context modifier. The `gpt-6-sol` and `gpt-6.1-sol` entries apply OpenAI's published 2x input and cache, 1.5x output modifier above 272K input tokens per request.

Current Cursor builds keep global composer headers in a `composerHeaders` table that maps each composer to its workspace storage ID and marks subagent composers; older builds keep them in `ItemTable`. Both are read. Cursor local composer history exposes modern `bubbleId` token counters and stable `toolFormerData` tool-call IDs. `usageData.costInCents` is a provider-reported local usage value and may be aggregated by session, repository, and model. Bubble token counters are session-level because the local bubble schema does not retain a model identifier that can be joined safely to provider-reported model cost. It is not assigned to a day because the local store does not retain per-call cost timestamps. Relative timing values are not Unix timestamps and must not affect session spans. Cursor composer API rate coverage remains not applicable; the SDK source below has separate semantics.

## Additional provider evidence

New sources populate the optional `evidence` namespace. `source` identifies the store; `fidelity` distinguishes message, summary, and activity-only evidence. `tokens` is reported/unavailable; `tools` and `turns` are observed/unavailable. `timing` distinguishes provider timestamps from file modification times. `usageUnit` describes request/run/session granularity, or unavailable. Original native-provider outputs keep their previous shape. Availability labels apply to existing numeric fields: an unavailable numeric placeholder is not an observation of zero activity. The terminal and dashboard share metric-specific eligibility: invalid/missing transcripts are ineligible; tools, compactions, tokens, requests, durations, and costs have separate coverage. Totals with no eligible sessions display N/A; partial totals carry eligible/selected counts. Only eligible values enter rankings. Distributions show each repository's eligible/selected count, omit empty series, and require at least five observations. Successful parsing does not imply complete metric coverage. `evidence.accounting` is an optional complete/partial label for retained accounting, independent of parser success.

- **Conductor results:** `conductor.resultRecords` counts distinct receipts, not runs. All eligible rows are grouped by provider identity before accounting. Cumulative `total_cost_usd`/`modelUsage` snapshots replace earlier progress. Explicit reset identities remain separate. Verified Claude Code 2.1 versions before 2.1.277 with distinct SDK `init` UUIDs establish disjoint process epochs; their final snapshots can be added. Newer resumes restore totals and remain one cumulative interval. Without sufficient boundary/version evidence, retain one observed snapshot and mark `evidence.accounting: partial`; counter decreases alone never establish disjoint usage. Zeroed crash receipts cannot erase earlier snapshots. See the [SDK accounting scopes](https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode).
- **Conductor counter scopes:** `conductor.turnLocalTokens` sums deduplicated turn-local `usage` into the existing nine-field `TokenUsage` shape (null when no usage counters are recorded), separately from session/model cumulative totals. It is never added to `modelUsage`. A lone receipt can supply session tokens when model counters are absent; multiple turn-local receipts do not substitute for cumulative session usage. `reportedTurns`, `durationMilliseconds`, `apiDurationMilliseconds`, and `permissionDenials` retain a lone receipt's values; with multiple receipts their scopes are not established, so they are null. `errorResults` and `terminalReasons` count receipts regardless of snapshot selection. Missing counters remain null. These flags are not task-success verdicts. Top-level reported USD takes precedence over model allocations; neither is an invoice. No daily attribution or model-request counts are inferred.
- **Cursor SDK:** latest retained snapshot per run ID; input, cache reads, cache writes, and output are disjoint counters. Reasoning is included in output. One started run is one observed run turn, not an inferred number of human messages or model requests. Tool calls are deduplicated by run plus call ID. Exact rate-card model matches are priced, with unknown models unpriced. Run aggregates cannot establish request context sizes: ordinary rates form the lower estimate, and the upper estimate applies any configured long-context premium to all aggregate usage. No aggregate cost is assigned to a day or `maxInputTokensPerCall`. When cache-write TTL is absent, the ordinary estimate uses the default write rate and the upper estimate also allows the configured one-hour rate; both assumptions are labeled.
- **Cursor transcripts:** human-message turns and structured assistant tool-use blocks only; tool IDs deduplicate streamed copies. `createdAt`/`updatedAt` are explicitly labeled file mtime, `firstEventAt`/`lastEventAt` remain null, and duration is unavailable. The session-start heatmap and duration distributions exclude these sessions. Date filters use their labeled file date. Models, tokens, cost, skills, and compactions are unavailable.
- **Copilot CLI:** persisted user/assistant messages, tool starts, turn lifecycle, and successful compaction markers, deduplicated by event and call/message IDs. Per-call usage is transient and shutdown token semantics are not calibrated here, so tokens and value remain unavailable. Request multipliers, premium requests, and AI credits are never USD. Skill evidence is unavailable.
- **OpenCode:** retained step-finish token counters are per request; the assistant snapshot contains the last step and is used only when no step counters survive for that message. Input/cache classes are disjoint, output includes reasoning. Tools deduplicate by call ID; `parent_id` supplies subagent evidence. Provider-calculated `cost` is not added to API estimates. Models use exact rate-card matches, including namespaced IDs. Pre-session messages in forks are matched to compact original-evidence fingerprints and excluded from the fork. Unmatched or undated request ownership is marked partial and excluded from additive tokens/cost; new post-fork requests remain independent. Daily values use owned request evidence only.
- **Gemini:** saved message counters are deduplicated by message ID, with JSONL checkpoints, rewinds, removals, and reorder operations applied to a content-free projection. Input includes cached input; output is candidate output plus separately recorded thought tokens. Tool-call IDs are deduplicated. Removed history cannot be recovered. Exact known rates are used; the bundled card currently has no Gemini rates, so those observed tokens remain visibly unpriced.

New activity-only sessions have `costBasis: unavailable`, `costComplete: false`, and `pricedTokenCoverage: null`. They do not become sessions “with an unpriced model.” Conductor API coverage is likewise N/A; `costComplete` requires supported, non-conflicting accounting boundaries and reported cost for every selected snapshot. It never proves complete historical retention. Numeric summary fields remain backward compatible. Evidence counts describe observations, never work quality, success, or value delivered.

The `gpt-5.3-codex-spark` entry uses zero rates because the provider documents the model as a research preview available through a subscription workflow rather than a separately metered API model. Zero here means “no observable API-equivalent charge,” not a claim that the subscription is free.

For OpenAI Codex transcripts, cached input is observable but cache writes are not separately identified in the cumulative usage counter. The ordinary estimate prices uncached input at the base rate. The upper estimate applies the configured cache-write premium to every uncached input token. The API-equivalent value should fall between those values when no other pricing modifier applies; neither value proves a subscription invoice or cash charge.

For Claude transcripts, deduplicate assistant `message.id` values before summing usage. Claude Code writes one record per streamed content block; every record of a message repeats the same input and cache counters while `output_tokens` grows, so keep the final snapshot (the one with the most output) for each message. Pricing the first snapshot undercounts output and thinking tokens. `usage.output_tokens_details.thinking_tokens` is reported as reasoning output and remains included in output pricing; record-level `effort` is the session's reasoning effort. Use the cache-creation TTL breakdown when present. If only aggregate cache creation exists, label the assumed TTL rather than silently claiming an exact cache-write price.

Apply long-context modifiers per request, not to the repository aggregate. Separately priced hosted tools, containers, search calls, storage, and network services require their own observable counters before they can enter the estimate.
