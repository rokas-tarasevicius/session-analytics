# Metrics for coding agents over MCP

Run `session-analytics mcp` to let an agent query local metrics. The server communicates only over stdin/stdout, has no runtime dependencies, and makes no network requests. Every tool returns a short summary, compact JSON text, and the same JSON as `structuredContent`. No tool returns transcripts, titles, commands, paths, credentials, raw provider IDs, or raw local errors. Repository and session keys are pseudonymous; repository display names are omitted from this surface.

## Install

Install this checkout with `npm link` and use Node 24 or newer. The package is not published: do not use an `npx` package download. Alternatively, replace the command below with an absolute Node executable and the absolute path to `bin/session-analytics.ts`, followed by `mcp`.

### Claude Code

```sh
claude mcp add --transport stdio --scope user session-analytics -- session-analytics mcp
```

The server uses Claude Code's `CLAUDE_PROJECT_DIR` as its default launch context when present. Use `/mcp` to inspect the connection. Project registration is also possible with `--scope project`. [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

### Codex

Add to `~/.codex/config.toml` (or your active profile's config):

```toml
[mcp_servers.session-analytics]
command = "session-analytics"
args = ["mcp"]
startup_timeout_sec = 10
tool_timeout_sec = 240
```

The server inherits its working directory. If your launcher uses a fixed directory, set `cwd = "/absolute/path/to/your/repository"` in that table. This is local configuration, never a tool argument or returned field. [Codex MCP configuration](https://developers.openai.com/codex/mcp/).

### Cursor

Add this entry to the project's `.cursor/mcp.json`, merging it with existing servers:

```json
{
  "mcpServers": {
    "session-analytics": {
      "type": "stdio",
      "command": "session-analytics",
      "args": ["mcp"],
      "env": {
        "SESSION_ANALYTICS_MCP_CWD": "${workspaceFolder}"
      }
    }
  }
}
```

Use a project configuration so `${workspaceFolder}` supplies the intended scope. Cursor also supports global configuration in `~/.cursor/mcp.json`. [Cursor MCP configuration and interpolation](https://cursor.com/docs/mcp).

Startup, discovery, listing and pings are immediate and do not scan history. The first tool call runs a fresh scan, which can take over a minute on large histories. Where supported, allow 240 seconds for a tool call; the worker itself has a 180-second deadline. A client that cancels a slow call can retry on the same server after the shared scan finishes. Closing stdin stops the server and cancels its worker.

## Tools

| Tool | Answers | Extra arguments |
| --- | --- | --- |
| `usage_summary` | Tokens and value by repository key, provider, model, or agent execution kind | `groupBy`: `repository`, `provider` (default), `model`, `agent`; `limit`, `offset` |
| `budget_status` | Dated API-equivalent value today/this week, elapsed-time burn rate, fresh recorded headroom | No `window`; always UTC today and Monday-to-date |
| `repo_profile` | Typical session value, turns and duration; tool mix, skills, cache hits and compactions | Requires one repository; top 20 tools and skills |
| `tool_stats` | Calls, structured results and errors, with coverage and sample guards | `limit`, `offset` |
| `recent_sessions` | Hashed session keys, provider, models, duration and value, newest activity first | `limit`, `offset` |
| `unused_extensions` | Installed skills and configured servers without observed use | `limit` per list and provider |
| `compare_agents` | Claude Code, Codex and Cursor on the same repository | Requires one repository; no provider filter |

Shared arguments are optional and strictly validated:

- `window`: `today`, `week`, `7d`, `30d` (default), `90d`, `all`. Calendar windows use UTC; `week` starts Monday; `7d` includes today and six preceding dates.
- `scope`: `repository` or `machine`. Default is the launch repository when one is found; otherwise machine. `repo_profile` and `compare_agents` accept repository scope only.
- `repositoryId`: a `conductor-<20 hex>` or `discovered-<20 hex>` key returned by this server. It cannot be combined with machine scope.
- `provider`: `claude`, `codex`, or `cursor`, except on `compare_agents`.
- Where listed, `limit`: 1–50 (default 10); `offset`: 0–100000 (default 0). `nextOffset` is `null` at the end. Pagination uses the current cached snapshot; compare `snapshot.generatedAt` across pages and restart if it changes.

For example, `usage_summary({"window":"7d","groupBy":"provider"})` describes the launch repository. Discover other repository keys with `usage_summary({"scope":"machine","groupBy":"repository","window":"all"})`, then pass a returned key to `repo_profile`. No tool accepts a working directory, filename, command, URL, SQL, glob, or transcript selector. Unknown arguments are rejected rather than ignored.

## Scope and freshness

The launch context is chosen from `--mcp-cwd`, `SESSION_ANALYTICS_MCP_CWD`, `CLAUDE_PROJECT_DIR`, then the process working directory. It uses the analyzer's Git/worktree and optional Conductor assignment. A Git repository with no history yields an empty repository scope. It never silently broadens to machine scope.

All existing analysis flags and `SESSION_ANALYTICS_*` environment settings work at process launch, including source overrides, `--exclude-hidden`, and `--rate-card`. Startup `--repo-*` filters are a ceiling: even `scope: "machine"` cannot query outside them. A caller-supplied repository key must be present in that snapshot (or be the empty launch repository's key). MCP client root notifications do not change the launch context or grant access to other paths.

Snapshots stay in memory for 60 seconds after a successful scan completes. `--mcp-ttl 300` or `SESSION_ANALYTICS_MCP_TTL=300` changes this to 1–3600 seconds. Concurrent requests share one scan; expiry triggers a refresh on the next tool call. Failed refreshes return a fixed tool error, never an old snapshot labeled fresh. Responses carry generation time, age and configured TTL. Restarting discards the cache. There is no disk cache, force-refresh tool, or background timer.

## Interpretation and evidence limits

`usage_summary`, profiles, tool/extension statistics, comparisons and recent sessions select whole sessions by start time; they do not prorate a session across days. `budget_status` instead sums the existing dated API-value ledger, including activity from sessions that started earlier. Its envelope totals explicitly carry `basis: session-start`; `data.today` and `data.week` each expose dated priced/eligible token coverage alongside value and burn rate, including unpriced activity from older sessions.

API-equivalent values are not invoices or subscription charges. Provider-reported value stays separate. Unknown models remain unpriced with an explicit token denominator. Cursor value cannot be assigned to a day and is excluded from the budget periods. Each period reports the all-history scoped provider-reported value excluded for lack of timing, not a claim about that period's Cursor spend.

Typical-session medians/p90 need five eligible sessions with settled provider lifecycle evidence. Active and unknown sessions, incomplete prices and missing measurements are excluded with counts; `activityStates` shows the lifecycle population. Standalone `idle` metadata is insufficient. Settled describes the last recorded turn, which can resume later; Cursor currently lacks this evidence. Durations include idle time, and task mix remains uncontrolled even in one repository. Model groups cannot attribute turns/tools or Cursor tokens; these fields are `null`. Model session counts can overlap. Agent grouping means `top-level`, `subagent`, `mixed` or `unknown`, never agent nicknames or raw identities.

Error rates require 20 structured results and carry their observed-result denominator. Missing result flags are not successes. Results of a transported code-mode call do not prove the status of its inner tools. Cursor outcomes and textual exit-code parsing are not supported by this lane. Call counts and structured completion counts can differ; unjoinable result coverage is unavailable.

Headroom uses Codex numeric five-hour/seven-day windows only. Samples must be no more than 15 minutes old with a future reset. The most conservative eligible sample is returned across observed sessions/profiles. These are provider-account observations, not a live quota request or repository-specific entitlement. Claude quota statuses alone do not establish a percentage, and missing evidence stays unavailable. Burn rate requires three dated sessions and at least one elapsed UTC hour; it is a historical wall-clock average, not a forecast or budget guard.

Extension inventory is deliberately partial. It reads only conventional skill directories (including symlinked `SKILL.md` entries, with at most 16 KiB read to resolve a scalar frontmatter name), Claude JSON server maps, Codex `[mcp_servers.NAME]` tables, and Cursor JSON server maps. It includes fixed project locations plus discovered Claude/Codex profiles; explicit provider roots replace home-profile discovery for that provider. It does not follow config includes, execute commands, connect to servers, inspect credentials, or enumerate plugin/managed registries. Canonical files deduplicate skill aliases; frontmatter names and directory aliases join to invocations. Ambiguous metadata is counted as unresolved and excluded from non-use lists. Configured MCP names containing `__` use the longest matching configured prefix. TOML escaped multiline delimiters stay inside values; malformed string syntax rejects the source. Codex inline-table configuration is not interpreted. Inventory is the launch context's installation, even when the usage query selects another repository. “Without observed use” never means “never used,” disabled, broken, or safe to remove. Cursor skill usage remains unavailable.

See [metric definitions](metrics.md#mcp-query-semantics) and the [field manifest](privacy.md#mcp-fields) for exact formulas and privacy tiers.

Every payload includes provider `sourceHealth`, independent of selected sessions. Missing or unreadable stores stay visible even when a provider-filtered query is empty. Fixed coverage notes never repeat local paths or exceptions.

## Protocol and verification

As verified on 2026-10-02, the server supports MCP **2026-07-28**, including `server/discover`, required per-request version/capability metadata and `resultType: "complete"`. It also supports the `initialize` → `notifications/initialized` lifecycle for **2025-11-25** and **2025-06-18**. Unsupported modern versions receive `-32022`; legacy initialization negotiates a supported legacy version. `ping` is also accepted. The transport is one JSON-RPC 2.0 message per UTF-8 line. No batches, HTTP transport, resources, prompts, sampling, elicitation, tasks or roots capability is advertised. Sources: [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [legacy lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).

Input frames are capped at 64 KiB, at most 16 tool requests can wait concurrently, and output buffering is bounded. Malformed input receives fixed errors. Valid notifications receive no response; cancelled requests receive no later result. Tool/input/analysis failures use `isError: true` where appropriate without forwarding exception text. Worker V8 old space is limited with `--max-old-space-size=256`; this is not a 256 MiB total-heap or RSS guarantee. Serialized snapshots are capped at 64 MiB. EOF/signals abort and reap the worker; stdout gets at most 250 ms to drain. Buffer overflow at 4 MiB forces immediate output teardown. The CLI explicitly exits after cleanup because Node does not close standard stdout through `destroy()`.

```sh
npm run check
node --test test/mcp*.test.ts
node scripts/demo.ts mcp
```

The last command runs a stdio server over synthetic data, with an `acme-web` launch scope, sample extension inventories and recent quota windows. Connect an MCP client to `node /absolute/path/to/scripts/demo.ts mcp`; do not pipe the server's output through the non-silent npm script runner, which prints its own banners. `npm run demo -- mcp` is also available for manual terminal use. No dashboard screenshots change in this feature.
