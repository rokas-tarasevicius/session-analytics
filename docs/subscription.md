# Subscription limits and value

A Claude or ChatGPT subscription is a fixed price for a rolling allowance. Unused allowance expires at each reset. The Subscription view and the `limits` command show how much of each allowance is left and when it resets, what to change, and what each allowance is worth at API list prices.

The view leads with **Limits now**, one row per account with the most urgent first, then at most three next steps, the account cards, **What it's worth**, the reset history and the sources. The [dashboard guide](dashboard.md#subscription-can-i-keep-working-and-is-it-worth-it) walks through it. Times are shown in your browser's time zone; value is counted in the snapshot's time zone, like the rest of the dashboard.

## What is measured

| Term | Meaning |
| --- | --- |
| Account | One subscription login. Every meter belongs to one account: two Claude logins used on one machine are two sets of meters, never one. See [Accounts](#accounts). |
| Meter | One provider allowance of one account, reported by the provider as percent used: Claude's 5-hour and weekly limits, Codex's weekly limit (and 5-hour limit on plans that have one). Claude reports more than 100% while paid extra usage covers the overflow. |
| Cycle | One reset window of a meter, identified by its reset instant. Instants within three minutes of each other are one cycle, because providers report them with a few seconds of drift. A cycle can end early when the provider resets limits or a banked reset is redeemed; that remainder is not counted as waste. |
| Segment | Part of a cycle. A provider can restart a meter at 0% without moving its reset (an in-place reset); the readings after it are a new segment of the same cycle. Pace, projection and the closing level use the latest segment. |
| Value per 1% | API-equivalent value of the account's own sessions inside a segment, divided by the meter reading at that time; at a cap, the first capped reading, because value after it did not move the meter. Segments whose value per 1% is under a quarter of the median moved mostly elsewhere (another machine, the web app) and are dropped. The median of the rest is used and needs at least two segments; with fewer, the view says there is not enough history. |
| Weekly capacity | Value per 1% × 100: what one full weekly allowance is worth at list prices. |
| A month of full use | Weekly capacity × 30.44 / 7 (monthly potential): the value of using every weekly reset fully. |
| Value used | The account's API-equivalent value for the selected dates, from the same activity ledger as Summary, Velocity and Costs, counted from the account's first meter reading up to now. |
| Share of what limits refill | Value used ÷ (weekly capacity × days / 7), over calibrated accounts. Over 100% means usage outpaces what the limits refill, so limits will be hit. |
| Typical week closes at | Meter only: the mean closing level of recent weekly cycles whose close was observed, plus the live cycle's projection once 15% of the time to its reset has passed. |
| Value multiple | Value used ÷ the plan price prorated to the same time, for an account you pay for. Team, Enterprise and Business seats are paid by the organization, so they show API value without a multiple unless you mark the seat as paid by you. |

Weekly limits bound total value; 5-hour limits bound bursts. The view reports both. Each live meter shows used percent, a tick for even pace to the reset, a hatched projection to the reset, and the time it runs out at the current pace.

- **Pace** runs from the start of the current segment through now. Hours without readings count as hours without use, so a run-out time is never in the past.
- **Projection** needs two readings and a tenth of the window behind them: 17 hours of a week, 30 minutes of a 5-hour window. Before that the meter says it is too early to project, however fast it is rising.
- **Stale meters** have no reading for a tenth of their window (at least an hour) and get no projection. If the pace before the last reading would have used the allowance up by now, the meter says it may already be used up.
- **Idle meters**: Claude resets each weekly limit at a fixed time of the week, so an idle Claude weekly meter shows its next scheduled reset. Other windows start with the next request.

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

### Which value belongs to which account

Value is matched to accounts through sessions, never by provider alone:

- A Claude session belongs to the account whose profile holds its transcript: its `historyProfile.profileKey` is one of the account's `profileKeys`.
- Codex sessions do not record their account yet. With one Codex account, every Codex session on this machine is that account's; with two or more, Codex value is not calibrated.
- A session without a profile key joins its provider's only account, if there is exactly one.
- When the dashboard combines other machines (`--remote`), their sessions cannot yet be told apart from this machine's. Claude sessions still match through this machine's profiles; Codex value is left out of every account, and the view says so. The dashboard's `/api/limits` reports the number of combined machines as `remoteMachines`.
- Sessions that match no account are reported as unattributed value. They never calibrate a meter. Readings without an account (weekly-phase groups and unattributed history) are shown as reported, without pace, value or advice.

An account with no matched sessions has unknown value, not zero: it is left out of the headline ratios.

Plans are read per account. Claude's plan comes from the profile's `oauthAccount` enums (`organizationType`, `organizationRateLimitTier`, `userRateLimitTier`, `seatTier`, `billingType`), then `.credentials.json`, then the last plan seen. The organization type decides: `claude_max` is Max 20x or Max 5x by its rate-limit tier, `claude_team` is Team even when the seat carries a Max-like user tier, `claude_pro` is Pro and `claude_enterprise` is Enterprise. A Team seat's type (standard or premium) is not recorded locally, so Team is not priced. Codex's plan is the account's latest `plan_type`; an unrecognized value is kept as plan evidence. Claude extra usage is tracked per account from that account's own events, starting from the profile's `hasExtraUsageEnabled`.

## Resets, banked resets and credits

A reset restarts a window at 0%. It is worth what had been used when it happened: a reset at 100% restores a full week, while a reset at 14% restores 14%.

| Kind | How it is tracked |
| --- | --- |
| Scheduled reset | The meter's own `resets_at`. The closing reading of each cycle is the share used; the rest expired. A closing reading taken more than a tenth of the window (at least an hour) before the reset is a lower bound: the close is unknown, and the cycle is left out of unused-allowance figures, the typical weekly close and plan advice. |
| Early reset (a redeemed credit, a paid reset, or a provider-wide reset) | Detected when a new cycle starts before the old one's scheduled reset. It is not counted as waste. Its value is the share restored, when the level just before it was observed. When the account's banked count drops across it, it is labelled as a redeemed credit. |
| In-place reset | The provider restarts a meter at 0% and keeps its reset instant. A fall of 5 points or more that the next reading confirms starts a new segment; a latest reading counts on its own only when it halves the level. The reset is placed midway between the readings on either side. It is not counted as waste; its value is the level before the fall, when observed close to it. |
| Codex banked reset credits | Read automatically through the local Codex app-server's `account/rateLimits/read`, the same read Codex's usage display makes, once for each Codex home. Kept per account: count, scope, grant and expiry times. Dropped: credit IDs, titles, the account ID (only its hash is kept). At most one read every 10 minutes; `account/rateLimitResetCredit/consume` is never sent. Off with `--no-codex-account`, `SESSION_ANALYTICS_CODEX_ACCOUNT=0` or `--offline`. Banked resets usually expire 30 days after they are granted. |
| Codex credits | The balance from every Codex `rate_limits` record (`credits.balance`, in Codex credits, not dollars). Credits pay for usage after the included allowance runs out. |
| Claude extra usage | On, in use or off (with the reason, such as `org_level_disabled`) per account, from that account's Agent SDK events. Extra usage is billed at API rates. A limit reached while extra usage is in use is recorded as `overage`, not as a cap: work continues and the meter reads above 100%. |
| Paid instant resets | Bought at `chatgpt.com/codex/purchase/reset`; they apply immediately and cannot be saved. They appear as early resets. |

Banked-reset advice follows from the value rule:

- **Redeem now** when the weekly meter is at 90% or more, or capped, with more than a day until the scheduled reset.
- **Hold** while the meter is on course to cap: redeem near 100%, not before.
- **Expiring**: a reset that expires within three days, or before you would need it at the current pace, is worth nothing unused. Plan a heavy run, let the meter climb, then redeem.
- **Badly timed**: an early reset in the last 30 days that restored less than 60% is flagged, with the value a reset at 100% would have restored.

A month of full use notes the value of banked resets separately: each adds up to one more full window if redeemed near 100%.

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

- The dashboard harvests when the Subscription view opens and every two minutes while it stays open. The meters appear as soon as they are read, before the session scan finishes; value fills in when it does. A refresh keeps keyboard focus, the inspected chart reading and open sections.
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

Suggestions are rules over the same numbers, made per account. They are ranked by urgency: act now, then opportunities, then setup, then what is going well. The view shows the first three as one line each, with the reasoning under "Why?", and the rest under a toggle. The value at stake only orders suggestions of the same rank, so a large expiring allowance never outranks an account that is about to run out.

- **Runs out early**: the weekly meter's projection reaches 100% before the reset. Shows the daily rate the remaining allowance supports. When another account has room, the same provider first, it is named with the profile to switch to, for example "Claude Team seat runs out before its Fri 04:00 reset; Claude Max 20x is at 16%", then "Point background agents and long-running work at the personal profile".
- **Used up or on extra usage**: the weekly meter is capped or past 100% on paid extra usage, with another account's headroom when there is some.
- **May already be used up**: a stale meter whose earlier pace would have reached 100% by now.
- **Capacity-bound**: every account with a fresh weekly reading runs out early or is used up. You already extract more than the limits refill, so the advice is to ration by priority rather than to use more.
- **Will expire unused**: the weekly projection closes below 85% with more than 12 hours left. Shows the expiring share and its API-equivalent value, and the daily rate that would use all of it.
- **Resets left unused**: two or more weekly cycles with an observed close averaged 15% or more unused.
- **Closes not observed**: two or more weekly closes were lower bounds and fewer than two were observed; a scheduled harvest records them.
- **5-hour lockouts**: windows that hit the limit in the last seven days, with time locked out. If the weekly limit is also binding, the lockouts are treated as pacing. Otherwise another account with room is suggested for lockouts.
- **Banked resets**: redeem now, hold, or use before expiry (see above), for each Codex account.
- **Plan fit**: on a plan you pay for, from at least three observed closes: capped in two of the last four observed weeks on a plan below the top tier, or under 30% average use on a higher tier. Employer-paid seats get no plan advice.

## Caveats

- Meters count usage from every client on the account: other machines, claude.ai, the desktop apps, Codex cloud tasks. Local value covers this machine's matched sessions only, so value per percent and capacity are conservative (lower bounds), and the share of what limits refill is an upper bound. The outlier rule drops cycles that another client moved almost entirely.
- API-equivalent value is a list-price comparison, not an invoice.
- Projections assume the current segment's pace, measured through now, continues.
- Headline ratios compare like with like. The value multiple divides the value of accounts you pay for by their prorated price; the potential multiple divides their monthly potential by their monthly price. Value on employer-paid seats, on plans without a price and outside any account is reported beside them, never divided by another account's price. Price and capacity are prorated over the time since each account's first meter reading, up to now, so days before the ledger and the rest of today are not counted.
- Plan prices were reviewed on 2026-10-14 from [claude.com/pricing](https://claude.com/pricing) (Pro $20 a month or $17 billed yearly; Team standard seat $25 or $20 billed yearly, premium seat $125 or $100 billed yearly; Enterprise $20 a seat a month billed yearly plus usage at API rates), the [Max plan article](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) (Max 5x $100, Max 20x $200), [ChatGPT pricing](https://learn.chatgpt.com/docs/pricing) (Go $8, Plus $20, Business $25 a seat or $20 billed yearly; Enterprise and Edu by contract) and OpenAI's [Pro tiers article](https://help.openai.com/articles/9793128-about-chatgpt-pro-tiers) (Pro 100, Pro 200 and Pro 500). A Team seat's type is not recorded locally; Team, Enterprise and Business seats are treated as paid by the organization. Codex reports a `promax` plan type that is not mapped to Pro 500 because nothing confirms the match; choose it on the card. The plan chip on each card overrides the detected plan or excludes the account from value totals; an excluded account keeps its card, meters and the control that undoes it. In What it's worth, a plan with a list price can be marked as paid by you or by an employer, for example a Team seat you pay for yourself. These choices are stored in the browser.
- Limit meters are live-only and are not part of saved or shared snapshots.
