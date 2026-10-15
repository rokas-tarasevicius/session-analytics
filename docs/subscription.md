# Subscription limits and value

A Claude or ChatGPT subscription is a fixed price for a rolling allowance. Unused allowance expires at each reset. The Subscription view and the `limits` command show how much of each allowance you use, what it is worth at API list prices, and what to change.

## What is measured

| Term | Meaning |
| --- | --- |
| Meter | One provider allowance, reported by the provider as percent used: Claude's 5-hour and weekly limits, Codex's weekly limit (and 5-hour limit on plans that have one). |
| Cycle | One reset window of a meter, identified by its reset instant. A Codex cycle can end early when OpenAI resets limits; that remainder is not counted as waste. |
| Value per 1% | API-equivalent value of the activity the dashboard reads (this machine, plus any saved or `--remote` machines, whatever the Machines strip shows; the view names them) inside a cycle, divided by the meter reading at that time. The median across cycles is used. |
| Weekly capacity | Value per 1% × 100: what one full weekly allowance is worth at list prices. |
| Monthly potential | Weekly capacity × 30.44 / 7: the value of using every weekly reset fully. |
| Extracted | The provider's API-equivalent value for the selected dates, from the same activity ledger as Summary, Velocity and Costs. |
| Capacity used | Extracted ÷ (weekly capacity × days / 7). Over 100% means usage outpaces what the limits refill, so limits will be hit. |
| Weekly resets used | Meter only: the mean highest reading of recent weekly cycles before they reset, plus the live cycle's projection once 15% of it has elapsed. |
| Value multiple | Extracted ÷ the plan price prorated to the selected dates. |

Weekly limits bound total value; 5-hour limits bound bursts. The view reports both. Each live meter shows used percent, a tick for linear pace through the window, a hatched projection to the reset, and the time it runs out at the current average pace.

## Resets, banked resets and credits

A reset restarts a window at 0%. It is worth what had been used when it happened: a reset at 100% restores a full week, while a reset at 14% restores 14%.

| Kind | How it is tracked |
| --- | --- |
| Scheduled reset | The meter's own `resets_at`. The closing reading of each cycle is the share used; the rest expired. |
| Early reset (a redeemed credit, a paid reset, or a provider-wide reset) | Detected when a new cycle starts before the old one's scheduled reset. It is not counted as waste. Its value is the share restored. When the banked count drops across it, it is labelled as a redeemed credit. |
| Codex banked reset credits | Read automatically through the local Codex app-server's `account/rateLimits/read`, the same read Codex's usage display makes. Kept: count, scope, grant and expiry times. Dropped: credit IDs, titles, the account ID. At most one read every 10 minutes; `account/rateLimitResetCredit/consume` is never sent. Off with `--no-codex-account`, `SESSION_ANALYTICS_CODEX_ACCOUNT=0` or `--offline`. Banked resets usually expire 30 days after they are granted. |
| Codex credits | The balance from every Codex `rate_limits` record (`credits.balance`, in Codex credits, not dollars). Credits pay for usage after the included allowance runs out. |
| Claude extra usage | On, in use or off (with the reason, such as `org_level_disabled`) from Agent SDK events. Extra usage is billed at API rates. |
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
| Codex session files | `event_msg` / `token_count` → `rate_limits.primary` / `secondary`: `used_percent`, `window_minutes`, `resets_at`, `plan_type` | Written by the Codex CLI on every turn. Windows are identified by length (300 = 5-hour, 10080 = weekly), not by slot. |
| Claude Agent SDK event logs | `rate_limit_event` → `rate_limit_info.unifiedWindows`: `utilization` (0–1), `resetsAt` | Hosts that drive Claude Code through the Agent SDK log these. T3 Code keeps them in `~/.t3/userdata/logs/provider`; set `SESSION_ANALYTICS_CLAUDE_EVENT_LOGS` (path-separated) for other hosts. |
| Claude Code status line | stdin `rate_limits.five_hour` / `seven_day`: `used_percentage`, `resets_at` | The documented status-line field. Set your status line command to `session-analytics limits statusline`; it records the readings and prints them. |
| Codex account | Local `codex app-server` → `account/rateLimits/read`: meters, credit balance, `rateLimitResetCredits` | On by default, at most every 10 minutes. Codex contacts OpenAI with its own login; this tool never sees a token. Off with `--no-codex-account` or `--offline`; never runs for explicit `--codex-root` scans. |
| Claude plan | `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) → `subscriptionType`, `rateLimitTier` | Only these two fields are inspected and only a plan name (`pro`, `max-5x`, `max-20x`, `team`, `enterprise`) leaves the reader. Tokens are never read into results. On macOS the record lives in the Keychain; choose the plan on the card instead. |

Provider logs rotate quickly: T3 Code keeps roughly a day of events. Every harvest folds new readings into a private ledger, `limits.json` in the data directory (mode `0600`), so reset history accumulates beyond log retention. Readings are merged into 15-minute buckets per meter and cycle (3-hour buckets for cycles older than 14 days) and kept for 120 days. Each harvest reads only the bytes appended since the previous one.

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

`session-analytics limits` prints every meter with its reset time and projection; `--json` prints the content-free snapshot.

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

- Meters count usage from every client on the account: other machines, claude.ai, the desktop apps, Codex cloud tasks. Value covers only the machines the dashboard reads, so value per percent and capacity are conservative (lower bounds), and capacity used is an upper bound, as long as those machines use the same accounts. Meters are still read from this machine only, so a saved machine on a different Claude or Codex account inflates value per percent.
- API-equivalent value is a list-price comparison, not an invoice.
- Projections assume the cycle's average pace continues.
- Plan prices were reviewed on 2026-10-13 from [claude.com/pricing](https://claude.com/pricing), the [Max plan article](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) and [ChatGPT pricing](https://learn.chatgpt.com/docs/pricing). Override the detected plan on each card; the choice is stored in the browser.
- Limit meters are live-only and are not part of saved or shared snapshots.
