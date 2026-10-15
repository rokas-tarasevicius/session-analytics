# Dashboard tour

[Back to the README](../README.md) · [Run the demo](cli.md#demo-and-developer-scripts)

All screenshots use synthetic demo data and follow your light or dark theme.

The dashboard runs on `127.0.0.1` and has six views in three groups: **Overview** (Summary, Velocity), **Economics** (Costs, Pricing) and **Usage** (Tools, Activity). A window selector at the top switches between the last 7, 30 or 90 days, all history, or a custom range. The sidebar lists every repository with a sparkline and its value, and clicking one focuses every view on that repository. A command palette (<kbd>⌘K</kbd>), `g`-prefixed shortcuts, light and dark themes, two densities and an address bar that follows the view, window and focus make it quick to move around and to share a link to exactly what you are looking at.

### Summary: the state of the machine

On narrow screens, repository and time-window selectors share the header, and metrics stack into one column below 400 pixels. Custom ranges keep the native date inputs.

<details>
<summary>Phone layout</summary>
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screenshot-mobile-dark.webp" />
    <img alt="Summary at 375 pixels: repository and time-window selectors above a single column of usage and session metrics" src="../assets/screenshot-mobile.webp" width="375" />
  </picture>
</p>
</details>

Summary answers "what happened in this window?" Six metrics show usage value, sessions analyzed, request input processed, output tokens, effective tool calls and compactions. Each metric shows how many of the selected sessions carry the evidence behind the number, the change against the previous window, and a sparkline. On wide desktops, the metrics form a totals rail beside the daily usage chart and session mix; narrower layouts put totals first. Repository and model breakdowns, top tools, sub-agent value and a sortable fleet table follow below.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screenshot-summary-breakdowns-dark.webp" />
    <img alt="Summary breakdown panels: usage value by repository, request input by repository, usage value by model, top tools and sub-agent value" src="../assets/screenshot-summary-breakdowns.webp" width="100%" />
  </picture>
</p>

### Focus on one repository

Click a repository in the sidebar, or pick one from the command palette, and every view narrows to it. Summary adds a provider breakdown for value and request input, a sub-agent summary and a comparison row against the whole fleet. The focus is part of the URL, so a bookmark or a shared link opens the same repository.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screenshot-repository-dark.webp" />
    <img alt="A focused repository: usage value and request input by provider, value by model, top tools, sub-agent value, and a repository-versus-fleet comparison table" src="../assets/screenshot-repository.webp" width="100%" />
  </picture>
</p>

### Machines: more than one computer

With [other machines](interop.md#combine-machines) saved, a **Machines** strip above the scope line lists each machine with its session count over all time, such as `laptop 6,398 · agentbox 722 · snapshot 11:44`. Each chip switches that machine's sessions in or out of every view, total and export, as the provider chips do for a chart. Subscription is the exception: its value is account-wide, so it counts every machine read whatever the strip shows, names them, and the strip says so on that view. A machine that could not be read is marked with its reason: a stale one (`agentbox 722 unreachable · showing 2 h ago`) still counts its last good snapshot, and a failed one is a button that opens **Machine details**. That dialog, also in the command palette, lists every machine's state, sessions, repositories, read time, duration and version, and the command that fixes a failure; after running it, **Read them again** reads the other machines without scanning this one again. The sync label says how many machines are ready and names the others, such as `1 of 2 machines ready · agentbox stale` (or `not read` when nothing of it is shown), Summary adds **Usage value by machine**, and Coverage notes name the machine they came from. History coverage spans every machine whichever are switched on, and labels each Claude profile with its machine.

The dashboard shows this machine's sessions as soon as its own scan is done, rather than waiting for the slowest machine: a machine still reading appears from its last good snapshot (or without its sessions), with a pulsing dot, and its sessions join the views when it answers. **Refresh snapshot** reads each machine again unless it is still reading; if this machine's scan fails, the other machines' reads carry on. Machines added, changed or removed with `session-analytics machines` reach the open dashboard on its next request, without a restart.

### Velocity: where usage is moving

Velocity answers "is this going up, and what is driving it?" It opens grouped by model, with shades of each provider's colour. You can also group by provider, agent, repository, execution kind or reasoning effort; plot usage value, any token class, model calls, tool calls or sessions started; by day, week or month, or as an hour-of-day profile; as a stacked area, lines or a cumulative curve, with an optional 7-day average. Below the chart, week-to-date, month-to-date and today-versus-median comparisons show the evidence on both sides of every percentage, and a **Top movers** table ranks the models, agents and other dimensions whose value changed most over the last seven completed days. When enough complete history exists, a projection band shows the month's likely range as a workload scenario, never as a forecast of your bill.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screenshot-velocity-dark.webp" />
    <img alt="Velocity view: usage value by model as a stacked area chart with a 7-day average, an opened Evidence & limits note, and week-to-date, month-to-date and today comparisons" src="../assets/screenshot-velocity.webp" width="100%" />
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screenshot-velocity-movers-dark.webp" />
    <img alt="Top movers table: models and agents ranked by their change over the last seven completed days, with the priced-token evidence behind each comparison" src="../assets/screenshot-velocity-movers.webp" width="100%" />
  </picture>
</p>

Every panel has an **Evidence & limits** note that states what the number includes, what was excluded, and why a comparison is partial or unavailable. A missing comparison is shown as a dash with its reason, never as zero.

### Costs: one money ledger

Costs answers "where does the value go?" The usage value is the sum of an API-equivalent part, priced from observed tokens, and a provider-reported part for sources such as Cursor that record their own figure and have no rate card. Cost by provider shows each provider's bar segmented by model with its priced share; cost by model lists every model with its provider, sessions, calls, input and output tokens, value and share. Summary, Velocity and Costs read the same activity-dated ledger, so their totals agree for any window.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screenshot-costs-dark.webp" />
    <img alt="Costs view: usage value, API-equivalent value, provider-reported value and pricing coverage metrics, cost by provider with model segments, and cost by model with sessions, calls and tokens" src="../assets/screenshot-costs.webp" width="100%" />
  </picture>
</p>

### Pricing: where the prices come from

Pricing answers "can I trust that dollar figure?" It shows pricing coverage (the share of eligible tokens with an explicit rate), the age of each public price source, whether updates are offline, and the effective date of the reviewed rate card. Each API-priced model used in the window gets a card with its input and output rates per million tokens, its value, tokens, calls and share, and a badge when part of its tokens could not be priced. A model with no matching rate is shown as unpriced rather than as free, and provider-reported value, such as Cursor's own figure, is kept in the totals line rather than given a rate card. A stale source raises a warning at the top; the demo seeds one deliberately stale source so that warning is visible.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screenshot-pricing-dark.webp" />
    <img alt="Pricing view: a stale-source warning, pricing coverage and per-source freshness cards, and model price cards with rates, value, tokens and priced share" src="../assets/screenshot-pricing.webp" width="100%" />
  </picture>
</p>

### Subscription: are you using what you pay for?

Subscription answers "how much of my Claude and Codex allowance turns into work?" Each subscription card shows its live meters: the 5-hour window and weekly limits as used percent, with a tick for linear pace, a hatched projection to the reset, and when it runs out at the current pace. A chart of the current weekly cycle sits beside the value of 1% of the week, weekly capacity and monthly potential, all calibrated from your own meter readings and the activity ledger. Headline figures compare monthly potential, extracted value and plan price. Weekly resets shows how full each allowance was when it reset, and 5-hour windows shows each window's peak and any time locked out. Ranked recommendations come first. Limits are account-wide, so the repository focus does not apply. See [Subscription limits and value](subscription.md).

### Tools: what the agents reach for

Tools answers "how do the agents work?" using tool-call names only; arguments and results never reach any output. The table ranks tools by calls, share, sessions and repositories, with the change against the previous window, and provider chips narrow it to one or more agents. Selecting a tool opens its detail: calls by session-start day, the providers that made them, and the repositories they went into.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screenshot-tools-dark.webp" />
    <img alt="Tools view: tool calls, distinct tools, calls per session and most-used tool metrics, a ranked tool table with provider marks, and the start of the Read detail panel with call totals and a daily chart" src="../assets/screenshot-tools.webp" width="100%" />
  </picture>
</p>

### Activity: when the work happens

Activity answers "when do sessions start?" A weekday-by-hour heatmap counts session starts in your local timezone for the selected providers, and a repository list shows where those sessions went. Sessions without a provider-recorded start time are excluded rather than guessed from file dates.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screenshot-activity-dark.webp" />
    <img alt="Activity view: a weekday-by-hour heatmap of session starts and a sessions-by-repository list" src="../assets/screenshot-activity.webp" width="100%" />
  </picture>
</p>

### Coverage, evidence and the command palette

Every number on the dashboard is a lower bound from local evidence. The **Coverage** button lists, for each source, how many selected sessions carry token evidence, tool evidence and timestamps, and explains how to read the figures on the current view. Unavailable is shown as a dash, never as zero activity, and counts never claim to measure quality or outcome.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screenshot-coverage-dark.webp" />
    <img alt="The Data coverage dialog: coverage notes, a per-source table of fidelity, sessions, token evidence, tool evidence and time basis, and notes on how to read the numbers" src="../assets/screenshot-coverage.webp" width="720" />
  </picture>
</p>

The command palette jumps to any view or repository, toggles provider chips and switches theme or density. The same actions have keyboard shortcuts: `g` then a letter for views, `[` and `]` for the previous and next view, `1` to `4` for the window presets, `e` for coverage and `t` for the theme.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screenshot-palette-dark.webp" />
    <img alt="The command palette: Go to Summary, Velocity, Costs, Pricing, Tools and Activity with their g-shortcuts, then All repositories and Focus entries for each repository" src="../assets/screenshot-palette.webp" width="600" />
  </picture>
</p>

