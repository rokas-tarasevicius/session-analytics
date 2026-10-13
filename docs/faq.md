# Frequently asked questions

[Back to the README](../README.md) · [Command-line reference](cli.md)

<details>
<summary><strong>Can I install from npm, GitHub, or a tarball?</strong></summary>

The package is not on npm. Install from a checkout with `npm link`; see [installation](cli.md#install). `npm install github:rokas-tarasevicius/session-analytics` or a tarball install fails on Node 24 with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` because the executable is a `.ts` file under `node_modules`. Without `npm link`, run `node bin/session-analytics.ts` from the checkout.
</details>

<details>
<summary><strong>Does anything leave my machine?</strong></summary>

There is no telemetry. Analysis reads cached prices; dashboard startup may refresh fixed public price feeds without sending local evidence. `--offline` or `SESSION_ANALYTICS_OFFLINE=1` disables those pricing requests. `export --otlp-endpoint` allows delivery of selected content-free export data; that explicit option is independent of the pricing offline setting. Fonts and provider marks are bundled; `--no-open` disables opening the loopback page.
</details>

<details>
<summary><strong>Why does the dollar figure differ from my bill?</strong></summary>

It is an API list-price equivalent, not an invoice. Subscriptions, discounts, credits, and pricing tiers are not modeled. See [metric definitions](metrics.md).
</details>

<details>
<summary><strong>Does it modify my agent history?</strong></summary>

No. JSONL files are streamed read-only and provider SQLite databases are opened with `readOnly: true`. Nothing is written to provider directories. A separate private SQLite index stores only derived facts and keyed fingerprints; use `--no-index` to bypass it.
</details>

<details>
<summary><strong>Do I need Conductor?</strong></summary>

No. Provider stores define the scan. When Conductor's database is present it adds workspace-to-repository mappings, registered repositories that have no sessions yet, hidden flags, and live-session status.
</details>

<details>
<summary><strong>What are "No repository detected" and "Ephemeral automation sessions" in the repository list?</strong></summary>

A folder is only listed as a repository when there is evidence for one: a Git root, a Git remote recorded by the provider, or a Conductor repository or workspace. Sessions started anywhere else (your home directory, a download or scratch folder, a deleted checkout whose remote was never recorded) are grouped together under "No repository detected" instead of one entry per folder. Sessions that ran in temporary directories are grouped together as ephemeral automation sessions.
</details>

<details>
<summary><strong>I use several Claude or Codex accounts. Are they all included?</strong></summary>

Yes. Sibling profile directories such as `~/.claude-work` or `~/.codex-personal`, plus `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, are discovered automatically. Directories that resolve to the same place through symbolic links are read once.
</details>

<details>
<summary><strong>Which platforms are supported?</strong></summary>

macOS is the primary platform. Claude Code and Codex history paths are the same on Linux, so those sources work there; the default Cursor, Claude Desktop, and Conductor paths are macOS paths today, and Cursor can be pointed at another location with `--cursor-database`. Windows is not supported yet. Pull requests and pushes require GitHub-hosted Ubuntu, macOS and browser checks. See [release validation](release.md).
</details>

<details>
<summary><strong>Can I see the prompt behind an expensive session?</strong></summary>

Not from this tool, by design. The session key is a truncated hash; use your agent's own history or resume feature to open the session.
</details>

<details>
<summary><strong>How do I add or correct a model price?</strong></summary>

Edit [`data/rate-cards.json`](../data/rate-cards.json) with the rate and a primary source URL, update the effective date, and open a pull request. [CONTRIBUTING.md](../CONTRIBUTING.md#rate-card-changes) has the checklist.
</details>

