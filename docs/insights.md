# Insights and optional review

Insights explain measured signals, with a suggested next step and the limits of the evidence beside every card. They are local deterministic rules over the existing content-free snapshot, plus Claude cache-gap counters and configured extension names. No model is called while generating cards.

```bash
session-analytics insights
session-analytics insights --json
session-analytics insights --repo-name example --from 2026-09-01 --through 2026-09-30
session-analytics insights --insights-config ./insights.json
npm run demo -- insights --json
```

Ordinary `report --json` continues to return a machine snapshot; `insights --json` returns a separate, versioned `InsightsReport`.

Date filters parse the timestamp's instant and compare it to UTC midnight boundaries, including the whole `through` day. Offset spellings of the same instant select the same sessions. Invalid or missing starts are excluded when either date bound is present; without a date filter they remain available to other rules. A fixed warning reports their count. Time-pattern rules always exclude them.

## Reading grouped insights

Insights group findings by **rule and scope level**, combining providers and repositories. There are ten current rules; repeated findings are scope items inside a group.

- A group shows its total estimated impact, unique affected repository/session counts with selected denominators, rule evidence coverage, quantified-scope coverage, and the lowest confidence of its scopes. Counts are unions of actual contributing sessions, never sums of peer denominators. Compaction/context/gap counts include only sessions with the flagged evidence; time patterns count starts in the flagged bucket. Inventory groups describe repositories/sessions **checked**, not proof that those workflows were harmed.
- Group totals add disjoint scope estimates **within the same rule and unit**. USD groups rank first, then token exposure, then unquantified signals; descending value within each band and stable ID for ties. Rows use the same order. Groups can overlap: never add their totals into savings. A partial total explicitly counts quantified scopes; no quantified scope means `null`, not zero. Associated usage is not causal cost or recoverable savings.
- Known partial/active/invalid evidence remains excluded. Peer comparisons additionally require parse-complete, observed inactive evidence; unknown states lower aggregate confidence. Missing evidence is **unavailable**, too little activity **insufficient**. Neither means zero percent or a healthy outcome. Confidence concerns interpretation, never quality or success. API-equivalent value is not an invoice.

## CLI and JSON contract

`insights` prints the ranked grouped list and up to three leading scopes per group. `insights --rule session-outlier --all-scopes` prints all rows for that rule with complete evidence and guardrails. Rule selection happens **after** evaluation, preserving peer baselines and denominators. Use the shared `--repo-id` / date options to recompute evidence for a repository/time selection.

`insights --json` returns **`schemaVersion: 2`**:

- `groups[]`: ranked rule/scope summaries, `itemIds` in row order, unique `affected` counts, `coverage`, `estimatedImpact`, `impactCoverage`, conservative confidence, guardrails/action and stable group/rule decision IDs.
- `items[]`: all original per-scope findings, including numeric evidence and denominators, plus the pricing strategy and source/target model transitions where applicable. Join a group's `itemIds` to `items[].id`; each item belongs to exactly one group.
- `coverage[]`: evidence/status by rule, `findings` counting scope items and `groups` counting summary cards. Thresholds, evidence-coverage reasons, timestamps, rate-card date and warnings remain present.

This is an intentional Insights JSON migration: v1 consumers of `cards[]` should use `items[]`, or join groups to items for the new display. The ordinary `report --json` snapshot shape is unchanged by grouping. Review continues to authorize the original contributing findings; grouped summaries cannot widen the P3 boundary.

## Rules and formulas

| Rule | Eligibility and trigger | Impact and interpretation |
| --- | --- | --- |
| `session-outlier` | Fully priced, parse-complete, observed inactive API-equivalent sessions; same repository, provider and execution kind. At least 5 **other** peers. Candidate has ≥10 calls, ≥$5 value and ≥3× the leave-one-out peer median (a zero median is ineligible). | Value above median, labeled an estimate rather than savings. Task type/difficulty is unknown. Session wall length is not used as a performance score. |
| `cache-waste` | ≥10 calls and ≥100K processed input tokens in a repository/provider. Cache reads / processed input <30%; Claude additionally requires writes / input ≥30%. Codex write share is unavailable. | Non-read input tokens, labeled exposure rather than avoidable tokens. New context and changing tools can legitimately miss cache. |
| `model-pricing` | ≥5 fully priced sessions, ≥10 calls and ≥$1 same-token difference. Move each recorded model one step through the same-provider next-tier mapping (or use an explicit provider target). Require sufficient eligible sessions/calls after applying every mapped target's guards; never substitute a cheaper model to fill a cohort. | Reprice each mapped model's uncached input, cache reads, 5m/1h writes and output separately. Mixed-model sessions appear once. Unmapped/already-target usage keeps its recorded value; sessions with no move are excluded. Show the moved-token denominator as well as the full scenario coverage. Unsplit writes use the existing 5m assumption. A target with context premiums requires complete request-size coverage and an owned peak at or below its threshold; aggregate usage cannot reconstruct premiums above it. Unknown sizes also exclude premium-sensitive source prices. Flat-price scenarios need no request-size assumption. Session and input-plus-output token denominators include excluded selected provider sessions. Excludes zero-rate previews, unpriced sessions and Cursor reported costs. No capability, quality or equal-consumption claim. |
| `compaction-heavy` | ≥5 Claude/Codex sessions with model calls, ≥10 calls total, ≥3 compactions and ≥5 compactions per 100 calls. | Total input in sessions containing compaction, **not** compaction cost. Compaction is normal context management. |
| `subagent-share` | Parse-complete, observed inactive sessions with fully priced/attributed API value and no unknown execution cost. Candidate ≥10 calls, ≥$5; ≥5 other same-repository/provider/execution peers. Subagent USD / session USD ≥65% and ≥30 percentage points above median peer share. | Associated subagent value, not redundant spend. Parallel work may be intentional; subagent attribution is a lower bound. |
| `long-context` | ≥5 Claude/Codex sessions with ≥10 calls and an observed request peak. ≥30% reach 200K input on at least one request. | Total input in those sessions, not the volume of long requests or a premium estimate. A peak does not establish frequency or model-specific context fill. |
| `unused-skills` | Current inventory contains names; ≥10 eligible provider sessions and ≥50 tool calls. No observed invocation for a name. | Unquantified. Claude invocations are explicit; Codex reads are a lower bound. Inventory can postdate history; no-use does not mean unnecessary. |
| `unused-mcp` | Same activity guards. Prefer bounded structured server attribution and canonical `mcp__SERVER__TOOL` names. Legacy `mcp_SERVER_TOOL` only confirms use when there is one possible separator and one configured match. | Ambiguous legacy names never confirm use; affected names remain in the no-confirmed-use list with an ambiguous-name denominator. No schema-token cost inferred. Current inventory, pooled profiles and filtered history cannot prove non-use. |
| `idle-cache` | Claude only, explicit cache TTL counters, valid timestamps, adjacent deduplicated requests within the same evidence file and model. Strictly >5m or >1h followed by writes of that TTL. ≥3 timed transitions and ≥3 TTL-write events. | Sum of `(write rate − read rate) × write tokens`, floored at zero, including known per-request premiums; pricing coverage shown. Missing rates contribute tokens but no dollar estimate. TTL event counts may overlap on a request. A gap and write do not prove expired or unchanged context. Natural breaks are not discouraged. |
| `time-pattern` | ≥20 valid dated starts, excluding standalone subagent sessions. ≥45% start in one fixed six-hour bucket. | Unquantified descriptive pattern. Uses UTC by default or a configured fixed minute offset, not daylight-saving-aware local time. No productivity or wellbeing inference. |

Session-level insight coverage can describe the eligible **peers**, so the candidate is not part of its own baseline. Every ratio carries a numeric denominator and a denominator label; a null denominator means a scalar, not a missing ratio silently replaced by zero. Rule coverage counts the selected sessions with usable evidence before activity guards. A rule can have eligible sessions but no sufficiently large comparison cohort.

`transcript.completeness` describes **the observed files**, not retention of the entire historical session: `complete` means no malformed records or file-version change during parsing; `partial` means either was observed; `unknown` means the adapter cannot establish this. `transcript.liveness` is `active`, `inactive` or `unknown`. Conductor `working` means active. Codex's last task-complete/turn-aborted marker and Claude's end-turn/stop-sequence/turn-duration marker establish observed inactivity. A later open marker is active only if timestamped within the last 15 minutes; older, missing or future starts are unknown. An active Claude subagent makes the composite session active; unknown child liveness makes it unknown. Start/completion count imbalance alone never proves current activity, and a session can resume after a scan.

`evidenceCoverage` contains five fixed reasons and selected-session denominators: partial transcript, active session, unknown liveness, unknown completeness and unknown request size. Counts can overlap. No raw parser warning is copied into Insights. `insightSignals.requestSizes` counts input-plus-output tokens with observed (`observedTokens`) or unknown (`unknownTokens`) request input size after ownership/deduplication. A nonzero maximum is only a lower bound unless **all** accounted usage has known size. Codex broadcast peaks owned by another file do not contribute.

## Configuration

`--insights-config PATH` wins over `SESSION_ANALYTICS_INSIGHTS_CONFIG`. Paths remain internal. Invalid keys, types, non-finite numbers, invalid names and unknown rules fail with a fixed message. No config means the defaults below and local inventory discovery. Changes apply on the next insights or review command.

```json
{
  "thresholds": {
    "minRepoSessions": 5,
    "outlierMultiplier": 3,
    "cacheReadShare": 0.3,
    "utcOffsetMinutes": 0
  },
  "disabledRules": ["time-pattern"],
  "nextTierModels": {
    "claude": { "claude-opus-5": "claude-sonnet-5", "claude-sonnet-5": null },
    "codex": { "gpt-6-astra": "gpt-6.1-sol" }
  },
  "inventory": {
    "claude": { "skills": ["code-review"], "mcpServers": ["docs"] },
    "codex": { "skills": [], "mcpServers": [] }
  }
}
```

The default scenario is **next tier down within the same provider**, using the explicit table below in `src/insights/pricing-policy.ts`. This is a scenario policy for the bundled rate card, not a live model list or a claim about relative capability. Every edge applies **once**, never transitively; premium → middle does not mean premium → smallest. The full source/target transitions appear in the scope evidence. The engine does not search for the cheapest model.

| Source model(s) | Next scenario tier |
| --- | --- |
| `claude-fable-5` | `claude-opus-5` |
| `claude-fable-5-1` | `claude-opus-5-5` |
| `claude-opus-4-6`, `claude-opus-4-8`, `claude-opus-5` | `claude-sonnet-5` |
| `claude-opus-5-5` | `claude-sonnet-5-5` |
| `claude-sonnet-5`, `claude-sonnet-5-5` | `claude-haiku-4-5-20251001` |
| `gpt-6-astra` | `gpt-6.1-sol` |
| `gpt-6-sol`, `gpt-6.1-sol` | `gpt-5.4-mini` |
| `gpt-5.6-sol` | `gpt-5.6-terra` |
| `gpt-5.6-terra` | `gpt-5.4-mini` |
| `gpt-5.5` | `gpt-5.4` |
| `gpt-5.4`, `gpt-5.3-codex` | `gpt-5.4-mini` |

`nextTierModels` overrides individual edges per provider; `null` disables a source edge. Names must be bounded, sources/targets present in the selected rate card and from that provider, targets positive-priced, and source/target different. At most 200 overrides per provider. Default edges absent from an alternative rate card are omitted without guessing; its custom models need explicit mappings. Unmapped usage stays unchanged inside mixed sessions, and sessions with no mapped usage do not enter the scenario. Context-premium restrictions can exclude a session even with a known mapping. The mapped difference need not be positive for every session/token class: the repository/provider net must meet `minDifferenceUsd`.

For a deliberate fixed-target scenario, `"comparisonModels": { "claude": "claude-sonnet-5" }` takes precedence over that provider's mapping and is labeled `configured-target`. An explicit target must exist and belong to that provider. Source premium coverage and target-size guards still apply; this is never a model quality recommendation.

Explicit `inventory` replaces all discovery, including empty arrays. Names are bounded canonical identifiers; commands, URLs, environment variables and skill contents are never projected. Maximum 200 names per provider/category. For discovery:

- Claude: top-level `mcpServers` keys from `~/.claude.json` (only without an explicit transcript root); `settings.json` and `.mcp.json` beside each discovered profile's `projects`; explicit `skills` map keys when present; installed `<profile>/skills/<name>/SKILL.md` directory names. `skillUsage` is not an installed inventory. Disabled MCP servers and false skill entries are skipped. Project-local config and plugin manifests are not crawled.
- Codex: bounded `[mcp_servers.NAME]` or quoted table names from profile `config.toml`, ignoring tables with `enabled = false`; installed skill directory names. This is a deliberately narrow TOML reader, not a general configuration interpreter. Dynamic configuration and plugins may be missed.
- Explicit provider roots replace discovery for that provider. Only standard `projects`, `sessions` or `archived_sessions` root layouts are inspected for adjacent profile settings. Each settings file has a 2 MB read limit. Unreadable settings produce a fixed partial-coverage warning; no settings text is returned.

| Threshold | Default | Meaning |
| --- | ---: | --- |
| `minRepoSessions` | 5 | Minimum cohort sessions (other peers for outlier/delegation). |
| `minModelCalls` | 10 | Minimum candidate/group calls; per-session guard for large context. |
| `minInputTokens` | 100000 | Cache rule's minimum processed input. |
| `outlierMultiplier` | 3 | Minimum multiple of peer median; must exceed 1. |
| `minOutlierUsd` | 5 | Minimum candidate API value for outlier/delegation. |
| `minDifferenceUsd` | 1 | Minimum positive pricing scenario difference. |
| `cacheReadShare` | 0.3 | Reads below this share trigger cache evaluation. |
| `cacheWriteShare` | 0.3 | Minimum Claude write share. |
| `compactionsPer100Calls` | 5 | Minimum compaction density. |
| `minCompactions` | 3 | Minimum compaction count. |
| `subagentShare` | 0.65 | Minimum subagent value share. |
| `subagentDelta` | 0.3 | Minimum absolute share difference from peer median. |
| `longContextInputTokens` | 200000 | Large-request threshold; also guides review window selection. |
| `longContextShare` | 0.3 | Minimum fraction of eligible sessions with a large peak. |
| `extensionMinSessions` | 10 | Minimum provider sessions for no-use cards. |
| `extensionMinToolCalls` | 50 | Minimum provider tool-call volume for no-use cards. |
| `idleGapMinEvents` | 3 | Minimum timed transitions and TTL-write events. |
| `timeMinSessions` | 20 | Minimum dated non-subagent starts. |
| `timeBucketShare` | 0.45 | Minimum share in a six-hour bucket. |
| `utcOffsetMinutes` | 0 | Fixed offset, −840 to +840 inclusive; no DST adjustment. |

Counts must be positive integers, shares range from 0 to 1, money/densities are non-negative, and absolute numeric values are bounded to one billion. These are adjustable signal thresholds, not universal standards of good agent work.

## Opt-in review (P3)

```bash
session-analytics report --json                  # find an existing hashed session key
session-analytics review --session a1b2c3d4e5f6 --via claude
session-analytics review --session a1b2c3d4e5f6 --via codex --send-content --json
```

The first review command is always a metadata-only dry-run unless the explicit `--send-content` flag is present. An environment variable cannot authorize a send. The selected source is resolved through the existing analyzer's validated identity/repository matching, including Conductor-correlated keys; there is no user-supplied transcript-path option and no browser review endpoint. Ambiguous keys, unsupported Cursor sessions and unavailable sources fail closed. No eligible flags or no supported prose excerpts means no agent invocation, even with the flag.

Review shares the engine's eligibility check and rejects partial or observed-active targets before excerpt selection. Repository cards only authorize context from the sessions contributing relevant eligible evidence (for example, a session must qualify for the selected price target or actually contain the compactions/large requests/cache rewrites). Machine inventory/time cards do not authorize prose. Internal source identity and file version (device, inode, size, modification/change time) are checked around analysis, before and after excerpt reading, and again immediately before invocation. Changes fail closed with a fixed error. Unknown liveness remains explicitly uncertain; these checks establish a consistent observed source, not a guarantee it will never resume.

The review worker scans the selected **main** Claude/Codex transcript. It retains at most three windows around compactions, large inputs and TTL-length pauses with writes, falling back to larger observed requests for aggregate flags. Nearby human/assistant prose is bounded to 12 excerpts of 1,000 characters each (60 KB total prompt hard limit). This is scaffolding for a closer look, not exact causal attribution of a card's cost to text. Tool arguments/results, tool commands, thinking/reasoning blocks and subagent transcripts are omitted. Oversized sources (>256 MB) are refused; oversized records (>1 MB) are skipped; excerpts are truncated and reported as such.

Redaction removes common credential forms and assignments, private-key blocks, URLs, email addresses, path forms, UUIDs/long hex identifiers, inline/fenced code and known local identifiers discovered in metadata. It is **best effort**: names, facts and unusual secret formats in remaining prose can still be sensitive. Redaction counts and truncation are visible in the preview, but the prose itself is never printed. Arbitrary prose cannot be guaranteed anonymous by regex. Do not authorize a send if this tradeoff is unacceptable.

On an explicitly authorized send, the worker invokes `claude -p` or `codex exec` from `PATH`, with the prompt on stdin (never shell interpolation or a process argument), from a fresh empty temporary working directory. Claude is given no tools, no skills, no configured MCP servers, empty setting sources and no session persistence. Codex is ephemeral, skips user config/rules, uses a read-only sandbox, disables shell/exec/multi-agent features and web search, and supplies no MCP servers. CLI versions must support these options; unsupported flags fail closed with no weaker retry. Authentication remains the user's own. Provider billing/retention and CLI-managed or organization-managed behavior remain outside this package's control.

Agent input explicitly treats excerpts as untrusted data and asks for `unknown` when evidence is insufficient. Raw stdout/stderr never reach the user. Only these projected labels are returned:

- `assessment`: `unknown`, `expected`, `worth-review`;
- `confidence`: `low`, `medium`, `high`;
- `suggestion`: `none`, `compare-similar-task`, `check-context`, `check-cache`, `check-delegation`.

Malformed or unstructured responses become `unknown`. Every enum must be a primitive string; arrays, nested arrays, objects and nulls fail closed, including inside native CLI envelopes. A malformed structured result cannot fall back to another envelope field. Agent output is capped at 64 KB and execution at 120 seconds; the complete isolated workflow is capped at five minutes with a 256 MB heap. Temporary directories are removed. This package persists no excerpts, prompt, agent response or assessment. The assessment is model advice, never independent evidence of success, failure or a root cause.
