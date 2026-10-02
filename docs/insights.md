# Insights and optional review

Insights explain measured signals, with a suggested next step and the limits of the evidence beside every card. They are local deterministic rules over the existing content-free snapshot, plus Claude cache-gap counters and configured extension names. No model is called while generating cards.

```bash
session-analytics insights
session-analytics insights --json
session-analytics insights --repo-name example --from 2026-09-01 --through 2026-09-30
session-analytics --insights-config ./insights.json
npm run demo -- insights --json
```

The dashboard's Insights tab uses `GET /api/insights?repo-id=KEY&from=YYYY-MM-DD&through=YYYY-MM-DD`. It shares the cached analytics snapshot and recomputes rules after selecting sessions by their UTC start day and repository. Filtering does not rescan transcripts. Refresh snapshot reloads the evidence and insights configuration. Date ranges are inclusive; impossible or reversed dates return a fixed 400 response. Ordinary `report --json` continues to return a machine snapshot; `insights --json` returns a separate, versioned `InsightsReport`.

## Reading cards

- Each card has a stable opaque ID, rule ID, machine/repository/session scope, numeric evidence, eligible/selected session counts, confidence, an impact estimate (or unavailable), a guardrail and a suggested action. Session scope uses the existing hashed session key.
- Working snapshots and invalid evidence are excluded. Provider-specific rules exclude unsupported providers. Missing evidence is **unavailable**; evidence below a minimum activity guard is **insufficient**. Neither means a zero-percent metric or a healthy outcome.
- Cards sort by descending estimated USD, then descending token exposure, then unquantified signals. They can overlap. Never sum cards into a savings total. Associated usage means value or tokens in the flagged session/group, not cost caused by the signal and not recoverable savings.
- Confidence describes what can be inferred. Price arithmetic can have high confidence while making no claim about model quality. Idle gaps and absent extension use have low confidence because causation and coverage are incomplete.
- API-equivalent value is not an invoice. Different tasks can require different volumes of work. No rule labels a session successful, failed, productive or unproductive.

Dismiss and seven-day snooze are stored only in this browser's `localStorage` under `session-analytics-insights-v1`. “Show dismissed / snoozed” permits restoration. IDs depend on rule, scope and compared names, so decisions survive a refreshed snapshot and expire only for snoozes; a changed comparison target creates a new card. Decisions contain no evidence, text or repository names. If storage is unavailable they work for the current page only. They do not affect CLI/API output or any provider settings.

## Rules and formulas

| Rule | Eligibility and trigger | Impact and interpretation |
| --- | --- | --- |
| `session-outlier` | Fully priced API-equivalent sessions; same repository, provider and execution kind. At least 5 **other** peers. Candidate has ≥10 calls, ≥$5 value and ≥3× the leave-one-out peer median (a zero median is ineligible). | Value above median, labeled an estimate rather than savings. Task type/difficulty is unknown. Session wall length is not used as a performance score. |
| `cache-waste` | ≥10 calls and ≥100K processed input tokens in a repository/provider. Cache reads / processed input <30%; Claude additionally requires writes / input ≥30%. Codex write share is unavailable. | Non-read input tokens, labeled exposure rather than avoidable tokens. New context and changing tools can legitimately miss cache. |
| `model-pricing` | ≥5 fully priced sessions, ≥10 calls, positive request peaks, and ≥$1 same-token difference. Compare only targets in the same provider with positive input/output rates. Default selects the target with the largest eligible aggregate difference. | Reprice uncached input, cache reads, 5m/1h writes and output separately. Unsplit writes use the rate card's existing 5m assumption. Source costs retain their actual request-level premiums. Targets with long-context pricing exclude sessions whose peak exceeds that target's threshold, since aggregate usage cannot reconstruct those premiums. Excludes zero-rate previews, unpriced sessions and Cursor reported costs. No claim of compatible context limits, tool support, quality or equal token consumption. |
| `compaction-heavy` | ≥5 Claude/Codex sessions with model calls, ≥10 calls total, ≥3 compactions and ≥5 compactions per 100 calls. | Total input in sessions containing compaction, **not** compaction cost. Compaction is normal context management. |
| `subagent-share` | Fully priced and fully attributed API value with no unknown execution cost. Candidate ≥10 calls, ≥$5; ≥5 other same-repository/provider/execution peers. Subagent USD / session USD ≥65% and ≥30 percentage points above median peer share. | Associated subagent value, not redundant spend. Parallel work may be intentional; subagent attribution is a lower bound. |
| `long-context` | ≥5 Claude/Codex sessions with ≥10 calls and an observed request peak. ≥30% reach 200K input on at least one request. | Total input in those sessions, not the volume of long requests or a premium estimate. A peak does not establish frequency or model-specific context fill. |
| `unused-skills` | Current inventory contains names; ≥10 eligible provider sessions and ≥50 tool calls. No observed invocation for a name. | Unquantified. Claude invocations are explicit; Codex reads are a lower bound. Inventory can postdate history; no-use does not mean unnecessary. |
| `unused-mcp` | Same activity guards; compare configured names against structured tool names with `mcp__SERVER__` or `mcp_SERVER_` prefixes. | Unquantified: no schema-token cost inferred. Other naming conventions are incomplete evidence. Current inventory, pooled profiles and a filtered date range cannot prove non-use. |
| `idle-cache` | Claude only, explicit cache TTL counters, valid timestamps, adjacent deduplicated requests within the same evidence file and model. Strictly >5m or >1h followed by writes of that TTL. ≥3 timed transitions and ≥3 TTL-write events. | Sum of `(write rate − read rate) × write tokens`, floored at zero, including known per-request premiums; pricing coverage shown. Missing rates contribute tokens but no dollar estimate. TTL event counts may overlap on a request. A gap and write do not prove expired or unchanged context. Natural breaks are not discouraged. |
| `time-pattern` | ≥20 valid dated starts, excluding standalone subagent sessions. ≥45% start in one fixed six-hour bucket. | Unquantified descriptive pattern. Uses UTC by default or a configured fixed minute offset, not daylight-saving-aware local time. No productivity or wellbeing inference. |

Session-level insight coverage can describe the eligible **peers**, so the candidate is not part of its own baseline. Every ratio carries a numeric denominator and a denominator label; a null denominator means a scalar, not a missing ratio silently replaced by zero. Rule coverage counts the selected sessions with usable evidence before activity guards. A rule can have eligible sessions but no sufficiently large comparison cohort.

## Configuration

`--insights-config PATH` wins over `SESSION_ANALYTICS_INSIGHTS_CONFIG`. Paths remain internal. Invalid keys, types, non-finite numbers, invalid names and unknown rules fail with a fixed message. No config means the defaults below and local inventory discovery. Changes apply on the next command or dashboard snapshot refresh.

```json
{
  "thresholds": {
    "minRepoSessions": 5,
    "outlierMultiplier": 3,
    "cacheReadShare": 0.3,
    "utcOffsetMinutes": 0
  },
  "disabledRules": ["time-pattern"],
  "comparisonModels": { "claude": "claude-sonnet-5", "codex": "gpt-5.4-mini" },
  "inventory": {
    "claude": { "skills": ["code-review"], "mcpServers": ["docs"] },
    "codex": { "skills": [], "mcpServers": [] }
  }
}
```

Omit `comparisonModels` to evaluate positive priced targets in the selected rate card. A configured target must exist and belong to that provider. Explicit `inventory` replaces all discovery, including empty arrays. Names are bounded canonical identifiers; commands, URLs, environment variables and skill contents are never projected. Maximum 200 names per provider/category. For discovery:

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

The review worker scans the selected **main** Claude/Codex transcript. It retains at most three windows around compactions, large inputs and TTL-length pauses with writes, falling back to larger observed requests for aggregate flags. Nearby human/assistant prose is bounded to 12 excerpts of 1,000 characters each (60 KB total prompt hard limit). This is scaffolding for a closer look, not exact causal attribution of a card's cost to text. Tool arguments/results, tool commands, thinking/reasoning blocks and subagent transcripts are omitted. Oversized sources (>256 MB) are refused; oversized records (>1 MB) are skipped; excerpts are truncated and reported as such.

Redaction removes common credential forms and assignments, private-key blocks, URLs, email addresses, path forms, UUIDs/long hex identifiers, inline/fenced code and known local identifiers discovered in metadata. It is **best effort**: names, facts and unusual secret formats in remaining prose can still be sensitive. Redaction counts and truncation are visible in the preview, but the prose itself is never printed. Arbitrary prose cannot be guaranteed anonymous by regex. Do not authorize a send if this tradeoff is unacceptable.

On an explicitly authorized send, the worker invokes `claude -p` or `codex exec` from `PATH`, with the prompt on stdin (never shell interpolation or a process argument), from a fresh empty temporary working directory. Claude is given no tools, no skills, no configured MCP servers, empty setting sources and no session persistence. Codex is ephemeral, skips user config/rules, uses a read-only sandbox, disables shell/exec/multi-agent features and web search, and supplies no MCP servers. CLI versions must support these options; unsupported flags fail closed with no weaker retry. Authentication remains the user's own. Provider billing/retention and CLI-managed or organization-managed behavior remain outside this package's control.

Agent input explicitly treats excerpts as untrusted data and asks for `unknown` when evidence is insufficient. Raw stdout/stderr never reach the user. Only these projected labels are returned:

- `assessment`: `unknown`, `expected`, `worth-review`;
- `confidence`: `low`, `medium`, `high`;
- `suggestion`: `none`, `compare-similar-task`, `check-context`, `check-cache`, `check-delegation`.

Malformed or unstructured responses become `unknown`. Agent output is capped at 64 KB and execution at 120 seconds; the complete isolated workflow is capped at five minutes with a 256 MB heap. Temporary directories are removed. This package persists no excerpts, prompt, agent response or assessment. The assessment is model advice, never independent evidence of success, failure or a root cause.
