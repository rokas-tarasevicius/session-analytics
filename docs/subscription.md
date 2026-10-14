# Subscription limits and value

A Claude or ChatGPT subscription is a fixed price for a rolling allowance. Unused allowance expires at each reset. The Subscription view and the `limits` command show how much of each allowance you use, what it is worth at API list prices, and what to change.

## What is measured

| Term | Meaning |
| --- | --- |
| Account | One subscription login. Every meter belongs to one account: two Claude logins used on one machine are two sets of meters, never one. See [Accounts](#accounts). |
| Meter | One provider allowance of one account, reported by the provider as percent used: Claude's 5-hour and weekly limits, Codex's weekly limit (and 5-hour limit on plans that have one). Claude reports more than 100% while paid extra usage covers the overflow. |
| Cycle | One reset window of a meter, identified by its reset instant. Instants within two minutes of each other are one cycle, because providers report them with a few seconds of drift. A Codex cycle can end early when OpenAI resets limits; that remainder is not counted as waste. |
| Value per 1% | API-equivalent value of this machine's activity inside a cycle, divided by the meter reading at that time. The median across cycles is used. |
| Weekly capacity | Value per 1% × 100: what one full weekly allowance is worth at list prices. |
| Monthly potential | Weekly capacity × 30.44 / 7: the value of using every weekly reset fully. |
| Extracted | The provider's API-equivalent value for the selected dates, from the same activity ledger as Summary, Velocity and Costs. |
| Capacity used | Extracted ÷ (weekly capacity × days / 7). Over 100% means usage outpaces what the limits refill, so limits will be hit. |
| Weekly resets used | Meter only: the mean highest reading of recent weekly cycles before they reset, plus the live cycle's projection once 15% of it has elapsed. |
| Value multiple | Extracted ÷ the plan price prorated to the selected dates. |

Weekly limits bound total value; 5-hour limits bound bursts. The view reports both. Each live meter shows used percent, a tick for linear pace through the window, a hatched projection to the reset, and the time it runs out at the current average pace.

## Accounts

Limits belong to a login, not to a machine or a profile directory. Each reading is tied to an account when it is harvested, and the account is stored with it, because transcripts and host logs are deleted later.

| Provider | How a reading finds its account |
| --- | --- |
| Claude, Agent SDK events | The event's `session_id` names a transcript, `<profile>/projects/*/<session_id>.jsonl`, in one of the discovered Claude profiles (`~/.claude`, `~/.claude-*`, `CLAUDE_CONFIG_DIR`). Only directory listings are read; transcripts are never opened. The profile's `.claude.json` (`~/.claude.json` for `~/.claude`) names the login. |
| Claude, status line | The `CLAUDE_CONFIG_DIR` Claude Code passes to the status-line command, else the profile holding `transcript_path`, else the profile holding `session_id`. |
| Codex, session files | The rollout's `session_meta.creator_account_id`. Older rollouts without one join the only account seen in the same Codex home. |
| Codex, account read | The `accountId` the app-server reports, which matches the rollouts' account. |

The account key is a hash computed where the login is read: Claude hashes the organization and account IDs from `oauthAccount`, Codex hashes the ChatGPT account ID. Profiles logged into the same account, such as `~/.claude` and `~/.claude-work`, therefore share one set of meters, and the same login has the same key on every machine. A profile without an `oauthAccount` record gets a key from its directory until its login is known; its readings then join that account. The IDs themselves are never stored or returned.

A Claude reading whose session is in no profile is grouped by its weekly reset instant, because each Claude account resets its weekly limit at its own fixed weekday and time. The group joins an account only when that account reported a weekly reading with exactly the same reset instant; otherwise it stays a separate "unidentified account" and is never folded into another account's meters.

Each account is labelled with its plan and the names of its non-default profile directories, without the `.claude-` or `.codex-` prefix: for example `Claude Max 20x · work` and `Claude Team · client`. These names come from local directory names, may name an employer, and appear only in the live `limits` output and the loopback dashboard API, never in saved or shared snapshots. Each account also lists its `profileKeys`, the same pseudonymous keys as a session's `historyProfile.profileKey`, so value can be matched to the account whose meters it moved.

Plans are read per account. Claude's plan comes from the profile's `oauthAccount` enums (`organizationType`, `organizationRateLimitTier`, `userRateLimitTier`, `seatTier`, `billingType`), then `.credentials.json`, then the last plan seen. The organization type decides: `claude_max` is Max 20x or Max 5x by its rate-limit tier, `claude_team` is Team even when the seat carries a Max-like user tier, `claude_pro` is Pro and `claude_enterprise` is Enterprise. A Team seat's type (standard or premium) is not recorded locally, so Team is not priced. Codex's plan is the account's latest `plan_type`; an unrecognized value is kept as plan evidence. Claude extra usage is tracked per account from that account's own events, starting from the profile's `hasExtraUsageEnabled`.

## Resets, banked resets and credits

A reset restarts a window at 0%. It is worth what had been used when it happened: a reset at 100% restores a full week, while a reset at 14% restores 14%.

| Kind | How it is tracked |
| --- | --- |
| Scheduled reset | The meter's own `resets_at`. The closing reading of each cycle is the share used; the rest expired. |
| Early reset (a redeemed credit, a paid reset, or a provider-wide reset) | Detected when a new cycle starts before the old one's scheduled reset. It is not counted as waste. Its value is the share restored. When the banked count drops across it, it is labelled as a redeemed credit. |
| Codex banked reset credits | Read automatically through the local Codex app-server's `account/rateLimits/read`, the same read Codex's usage display makes, once for each Codex home. Kept per account: count, scope, grant and expiry times. Dropped: credit IDs, titles, the account ID (only its hash is kept). At most one read every 10 minutes; `account/rateLimitResetCredit/consume` is never sent. Off with `--no-codex-account`, `SESSION_ANALYTICS_CODEX_ACCOUNT=0` or `--offline`. Banked resets usually expire 30 days after they are granted. |
| Codex credits | The balance from every Codex `rate_limits` record (`credits.balance`, in Codex credits, not dollars). Credits pay for usage after the included allowance runs out. |
| Claude extra usage | On, in use or off (with the reason, such as `org_level_disabled`) per account, from that account's Agent SDK events. Extra usage is billed at API rates. A limit reached while extra usage is in use is recorded as `overage`, not as a cap: work continues and the meter reads above 100%. |
| Paid instant resets | Bought at `chatgpt.com/codex/purchase/reset`; they apply immediately and cannot be saved. They appear as early resets. |

Banked-reset advice follows from the value rule:

- **Redeem now** when the weekly meter is at 90% or more, or capped, with more than a day until the scheduled reset.
- **Hold** while the meter is on course to cap: redeem near 100%, not before.
- **Expiring**: a reset that expires within three days, or before you would need it at the current pace, is worth nothing unused. Plan a heavy run, let the meter climb, then redeem.
- **Badly timed**: an early reset in the last 30 days that restored less than 60% is flagged, with the value a reset at 100% would have restored.

Monthly potential notes the value of banked resets separately: each adds up to one more full window if redeemed near 100%.

## Where the readings come from

Nothing is requested from Anthropic. Readings are copied from records already on the machine, except the Codex account read, which asks the local Codex app-server (Codex contacts OpenAI with its own login).

| Source | Record | Notes |
| --- | --- | --- |
| Codex session files | `session_meta.creator_account_id` (hashed); `event_msg` / `token_count` → `rate_limits.primary` / `secondary`: `used_percent`, `window_minutes`, `resets_at`, `plan_type`, `limit_id`, `limit_name` | Written by the Codex CLI on every turn. Windows are identified by length (300 = 5-hour, 10080 = weekly), not by slot. A model-scoped limit (`limit_id` other than `codex`) is its own meter, labelled with its `limit_name` when that is a short plain name, else "Model-scoped limit". |
| Claude Agent SDK event logs | `rate_limit_event` → `rate_limit_info.unifiedWindows`: `utilization` (0–1, above 1 on extra usage), `resetsAt`; `session_id` (used only to find the profile, never stored) | Hosts that drive Claude Code through the Agent SDK log these. T3 Code keeps them in `~/.t3/userdata/logs/provider`; set `SESSION_ANALYTICS_CLAUDE_EVENT_LOGS` (path-separated) for other hosts. |
| Claude Code status line | stdin `rate_limits.five_hour` / `seven_day`: `used_percentage`, `resets_at`; `transcript_path` and `session_id` to find the profile | The documented status-line field. Set your status line command to `session-analytics limits statusline`; it records the readings and prints them. |
| Codex account | Local `codex app-server` → `account/rateLimits/read`: meters, credit balance, `rateLimitResetCredits`, `accountId` (hashed) | On by default, at most every 10 minutes, once for each Codex home (`~/.codex`, `~/.codex-*`, `CODEX_HOME`) with `CODEX_HOME` set to it. Codex contacts OpenAI with its own login; this tool never sees a token. Off with `--no-codex-account` or `--offline`; never runs for explicit `--codex-root` scans. |
| Claude plan and login | Each profile's `.claude.json` (`~/.claude.json` for `~/.claude`) → `oauthAccount`; then `.credentials.json` → `subscriptionType`, `rateLimitTier` | From `.claude.json` (read up to 8 MB), only the organization and account IDs (hashed in the reader), the five plan enums listed under [Accounts](#accounts) (each must match `^[a-z0-9_]{1,48}$`) and `hasExtraUsageEnabled` are kept. Email addresses, names, organization names, project history and tokens are never read into results. On macOS the credentials record lives in the Keychain, so `.claude.json` is usually the only source. |

Provider logs rotate: T3 Code keeps several days of events, and Claude Code deletes old transcripts. Every harvest folds new readings, with their accounts, into a private ledger, `limits-v2.json` in the data directory (mode `0600`), so reset history accumulates beyond log retention. Readings are merged into 15-minute buckets per account, meter and cycle (3-hour buckets for cycles older than 14 days) and kept for 120 days. Each bucket keeps its highest reading; a reading that hit a cap keeps its own time, so a lockout never starts earlier than it did.

- **Incremental reads.** Each harvest reads only the bytes appended since the previous one. Read positions are stored in the ledger, keyed by file identity and checked against a hash of the bytes before them, so a scheduled `limits --quiet` does not reread whole files, and a file that was rewritten or replaced is read again from the start. A file that could not be read is retried by the next harvest even if it has not changed.
- **Concurrent harvests.** Harvests in one process run one at a time, and the dashboard shares a harvest that is still running. Every write rereads the ledger and merges it before replacing it, so the dashboard and a scheduled harvest never erase each other's readings. Status-line samples are appended to `limits-inbox-v2.jsonl` and claimed by renaming, so two harvests never take the same samples.
- **Unstarted Codex windows.** Codex reports a window that has not started at 0% with a reset one window after each reading. Such readings never form cycles; the latest one is kept as an `idle` marker until a later reading supersedes it.
- **Conflicting Codex readings.** One account is in one weekly cycle at a time. A cycle whose readings all fall inside a busier cycle of the same account and meter came from another limit context, so it is moved to unattributed history.
- **Retired meters.** A meter the provider stopped reporting while still reporting the account's other meters, for longer than its window, is marked retired rather than shown as idle.
- **Unreadable ledgers.** A ledger written by another version, or one this user may not replace, is left untouched and history is not kept until that is resolved. A ledger that cannot be parsed is renamed `limits-v2.json.unreadable-<time>` and a new one is started.
- **Earlier versions.** Version 0.9.0 kept a ledger without accounts in `limits.json`. It is read, never written: Claude weekly readings join the account with the same weekly reset time, 5-hour readings follow the weekly readings taken with them, and Codex readings join the only Codex account. Readings that match no account are shown as "Unattributed history" and left out of pace and value. Readings that an older installation keeps adding to `limits.json` are imported on later harvests.

## Keeping it up to date

- The dashboard harvests when the Subscription view opens and every two minutes while it stays open.
- Schedule a harvest so history stays continuous when the dashboard is closed:

  ```sh
  # crontab -e
  */20 * * * * session-analytics limits --quiet
  ```

- In the interactive Claude Code CLI, add the status line to `~/.claude/settings.json`:

  ```json
  { "statusLine": { "type": "command", "command": "session-analytics limits statusline" } }
  ```

`session-analytics limits` prints each account with its plan and every meter's reset time and projection; `--json` prints the content-free snapshot (`schemaVersion` 2: `accounts`, `meters` and `observations` carry the account key).

## Recommendations

Suggestions are rules over the same numbers, ranked by urgency and value at stake:

- **Runs out early**: the weekly meter's projection reaches 100% before the reset. Shows the daily rate the remaining allowance supports, and the other subscription's headroom if it has some.
- **Capacity-bound**: every subscription runs out early. You already extract more than the limits refill, so the advice is to ration by priority rather than to use more.
- **Will expire unused**: the weekly projection closes below 85% with more than 12 hours left. Shows the expiring share and its API-equivalent value, and the daily rate that would use all of it.
- **Resets left unused**: two or more closed weekly cycles averaged 15% or more unused.
- **5-hour lockouts**: windows that hit the limit in the last seven days, with time locked out. If the weekly limit is also binding, the lockouts are treated as pacing.
- **Banked resets**: redeem now, hold, or use before expiry (see above).
- **Plan fit**: capped in two of the last four weeks on a lower tier, or under 30% average use on a higher tier.

## Caveats

- Meters count usage from every client on the account: other machines, claude.ai, the desktop apps, Codex cloud tasks. Local value covers this machine only, so value per percent and capacity are conservative (lower bounds), and capacity used is an upper bound.
- API-equivalent value is a list-price comparison, not an invoice.
- Projections assume the cycle's average pace continues.
- Plan prices were reviewed on 2026-10-13 from [claude.com/pricing](https://claude.com/pricing), the [Max plan article](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) and [ChatGPT pricing](https://learn.chatgpt.com/docs/pricing). Override the detected plan on each card; the choice is stored in the browser.
- Limit meters are live-only and are not part of saved or shared snapshots.
