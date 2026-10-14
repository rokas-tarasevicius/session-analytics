import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { brand } from "../brand.ts";
import { argument, setting } from "../options.ts";
import { dataDirectory, secureDirectory, secureFile } from "../store/database.ts";
import { buildMeters, formatDuration, identified, latestReading, liveMeter, providerNames, type LiveMeter } from "../public/subscription-data.js";
import { planFor } from "../public/subscription-plans.js";
import { collectLimits, statuslineAccount, type LimitsOptions } from "./index.ts";
import { appendInbox } from "./ledger.ts";
import { statuslineObservations } from "./sources.ts";
import type { LimitAccount, LimitMeterInfo, LimitObservation, LimitsSnapshot } from "./types.ts";

const help = `${brand.name} limits

Usage:
  ${brand.command} limits [--json] [--quiet]   Harvest subscription limit meters and print where each account stands
  ${brand.command} limits statusline            Claude Code status line: records rate_limits from stdin, prints them

Sources (read-only): Codex session rate_limits records, Claude Agent SDK rate_limit_event records in host
event logs (T3 Code by default; SESSION_ANALYTICS_CLAUDE_EVENT_LOGS overrides), and statusline readings.
Readings are attributed to accounts (a Claude profile's login, a Codex rollout's account) and kept in a private
ledger in the data directory so reset history survives log rotation.
Run it on a schedule to keep history continuous, e.g. cron: */20 * * * * ${brand.command} limits --quiet

Options:
  --json             Print the content-free limits snapshot
  --quiet            Harvest only; print nothing
  --data-dir PATH    Private data directory (ledger location)
  --no-index         Do not read or write the ledger
  --codex-root PATH  Read Codex sessions from PATH instead of discovered profiles
  --claude-root PATH Explicit Claude projects root: skips event-log and profile discovery; only that
                     profile's login and plan are read
  --no-codex-account Do not read banked reset credits through the local Codex app-server. By default the
                     app-server is asked at most once per 10 minutes (Codex contacts OpenAI with its own
                     login); it never redeems a reset. SESSION_ANALYTICS_CODEX_ACCOUNT=0 does the same
  --offline          No network reads, including the Codex account read
`;

const valueFlags = new Set(["--data-dir", "--codex-root", "--codex-archive-root", "--claude-root"]);
const booleanFlags = new Set(["--json", "--quiet", "--no-index", "--help", "--no-codex-account", "--offline"]);

function options(args: string[]): LimitsOptions {
  return {
    dataDir: setting(args, process.env, "--data-dir", "DATA_DIR"),
    codexRoot: argument(args, "--codex-root"),
    codexArchiveRoot: argument(args, "--codex-archive-root"),
    claudeRoot: argument(args, "--claude-root"),
    noIndex: args.includes("--no-index") || process.env["SESSION_ANALYTICS_NO_INDEX"] === "1",
    codexAccount: !args.includes("--no-codex-account"),
    offline: args.includes("--offline") || process.env["SESSION_ANALYTICS_OFFLINE"] === "1",
  };
}

const clock = (seconds: number): string => new Date(seconds * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function describe(live: LiveMeter, info: LimitMeterInfo | undefined, now: number, width: number): string {
  const label = live.meter.label.padEnd(width);
  if (info?.retired) return `  ${label} not reported since ${clock(info.lastObservedAt)}`;
  // Claude's weekly limits reset on a fixed weekly schedule; other windows start with the next request.
  if (!live.cycle) return live.nextResetAt ? `  ${label} no reading since the last reset · resets ${clock(live.nextResetAt)} on its weekly schedule` : `  ${label} idle · the next request starts a new window`;
  const used = `${live.used.toFixed(0).padStart(3)}%`;
  if (live.state === "unreported") return `  ${label} ${used} at last report ${clock(live.observedAt ?? now)} · no longer reported by the provider`;
  const parts = [`${used} used`, `resets ${clock(live.cycle.resetsAt)} (in ${formatDuration(live.cycle.resetsAt - now)})`];
  if (live.segment?.before) parts.push(`restarted in place ${clock(live.segment.start)}`);
  if (live.state === "overage") parts.push("past the included allowance, on extra usage");
  else if (live.state === "capped") parts.push(`capped since ${clock(live.capAt ?? live.cycle.last.t)}`);
  else if (live.capsEarly && live.capAt) parts.push(`at this pace runs out ${clock(live.capAt)}`);
  else if (live.mayBeUsedUp) parts.push("may already be used up");
  else if (live.stale) { /* The last reading below says how old it is; no projection. */ }
  else if (live.tooEarly) parts.push("too early in the window to project");
  else if (live.projected !== null && live.projected !== undefined) parts.push(`on pace for ${Math.min(100, live.projected).toFixed(0)}% at reset`);
  if (live.stale) parts.push(`last reading ${formatDuration(now - (live.observedAt ?? now))} ago`);
  return `  ${label} ${parts.join(" · ")}`;
}

/** Facts that belong to one account: plan evidence, Claude extra usage, Codex credits and banked resets. */
function accountFacts(account: LimitAccount, codexAccount: LimitsSnapshot["codexAccount"], now: number): string[] {
  const lines: string[] = [];
  const evidence = account.planEvidence;
  if (account.plan === "team" && (evidence?.seatTier || evidence?.userRateLimitTier)) {
    lines.push(`  Seat: ${[evidence.seatTier && `tier ${evidence.seatTier}`, evidence.userRateLimitTier && `user rate-limit tier ${evidence.userRateLimitTier}`].filter(Boolean).join(", ")} (seat type and price not recorded locally)`);
  }
  if (account.attribution === "unattributed") lines.push("  Readings that could not be tied to an account; left out of pace and value.");
  if (account.attribution === "weekly-phase") lines.push("  Readings whose session was not found in any profile; grouped by weekly reset time.");
  const extra = account.extraUsage;
  if (extra) lines.push(`  Extra usage: ${extra.extraUsage}${extra.disabledReason ? ` (${extra.disabledReason.replace(/_/g, " ")})` : ""}`);
  if (account.provider !== "codex" || account.attribution === "unattributed") return lines;
  const resets = account.codex?.resetCredits;
  if (resets) {
    const next = (resets.credits ?? []).filter((credit) => credit.status === "available" && credit.expiresAt).sort((a, b) => a.expiresAt! - b.expiresAt!)[0];
    lines.push(`  Banked resets: ${resets.available} available${next?.expiresAt ? `, next expires ${clock(next.expiresAt)} (in ${formatDuration(Math.max(0, next.expiresAt - now))})` : ""}`);
  } else if (codexAccount === "off") lines.push("  Banked resets: not read (turned off)");
  else if (codexAccount === "unavailable") lines.push("  Banked resets: the local Codex app-server did not answer");
  const balance = account.codex?.credits?.balance;
  if (balance !== null && balance !== undefined) lines.push(`  Credit balance: ${Math.round(balance).toLocaleString("en")} credits`);
  return lines;
}

async function report(args: string[]): Promise<number> {
  const snapshot = await collectLimits(options(args));
  if (args.includes("--quiet")) return 0;
  if (args.includes("--json")) { process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`); return 0; }
  const now = Date.now() / 1000;
  const lines = [`${brand.name} · subscription limits`, ""];
  for (const provider of ["claude", "codex"] as const) {
    const accounts = snapshot.accounts.filter((account) => account.provider === provider);
    if (!accounts.length) lines.push(providerNames[provider], "  No meter readings yet.", "");
    for (const account of accounts) {
      // Only a plan you pay for yourself has a price here; organization seats are billed to the organization.
      const plan = planFor(provider, account.plan);
      lines.push(`${account.label}${plan?.payer === "individual" && plan.monthlyUsd ? ` ($${plan.monthlyUsd}/mo)` : ""}`);
      // Each account is its own series: cycles, pace and "no longer reported" never mix two accounts.
      const own = buildMeters(snapshot.observations.filter((row) => row.provider === provider && row.account === account.key), now, snapshot.meters);
      if (!own.length) lines.push("  No meter readings yet.");
      const infos = own.map((meter) => snapshot.meters.find((item) => item.provider === provider && item.account === account.key && item.meter === meter.meter));
      const width = Math.max(28, ...own.map((meter) => meter.label.length + 1));
      const reportedUntil = latestReading(own);
      for (const [index, meter] of own.entries()) lines.push(describe(liveMeter(meter, now, reportedUntil, { project: identified(account.key) }), infos[index], now, width));
      lines.push(...accountFacts(account, snapshot.codexAccount, now), "");
    }
  }
  for (const source of snapshot.sources) lines.push(`Source ${source.source}: ${source.status}${source.latest ? `, latest ${clock(source.latest)}` : ""}`);
  lines.push(snapshot.persisted ? "History is kept in the private ledger. Value, capacity and reset history: open the dashboard's Subscription view."
    : snapshot.ledger === "unreadable" ? "History is not kept: the ledger was written by another version of session-analytics and was left untouched."
    : snapshot.ledger === "unwritable" ? "History could not be saved this time; the next harvest reads the same records again."
    : "History is not persisted (--no-index).");
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/** Skip appending when nothing changed since the account's last statusline refresh; status lines redraw many times a minute. */
function changedSinceLast(directory: string, account: string, observations: LimitObservation[]): boolean {
  const path = join(directory, `limits-statusline-${account || "unattributed"}.last`);
  const signature = JSON.stringify(observations.map((item) => [item.meter, item.resetsAt, Math.round(item.usedPercent * 10)]));
  let previous = "";
  try { previous = readFileSync(path, "utf8"); } catch { /* First run. */ }
  if (previous === signature) return false;
  secureDirectory(directory);
  secureFile(path);
  writeFileSync(path, signature, { mode: 0o600 });
  return true;
}

async function statusline(args: string[]): Promise<number> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1024 * 1024) break;
  }
  const now = Date.now() / 1000;
  let value: unknown = null;
  try { value = JSON.parse(input); } catch { /* Print nothing useful rather than fail the status line. */ }
  const observations = statuslineObservations(value, now);
  const settings = options(args);
  if (observations.length && !settings.noIndex) {
    try {
      const directory = dataDirectory(settings);
      const account = await statuslineAccount(value);
      const attributed = observations.map((item) => ({ ...item, account }));
      if (changedSinceLast(directory, account, attributed)) appendInbox(directory, attributed);
    } catch { /* Recording is best-effort; the status line still prints. */ }
  }
  const short: Record<string, string> = { five_hour: "5h", seven_day: "week" };
  const text = observations.map((item) => `${short[item.meter] ?? item.meter.replace(/_/g, " ")} ${item.usedPercent.toFixed(0)}% ↻${formatDuration(item.resetsAt - now)}`).join(" · ");
  process.stdout.write(`${text}\n`);
  return 0;
}

export async function runLimits(args: string[]): Promise<number> {
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (index === 0 && flag === "statusline") continue;
    if (valueFlags.has(flag)) {
      if (!args[index + 1] || args[index + 1]!.startsWith("--")) { process.stderr.write(`${flag} requires a value.\n`); return 2; }
      index += 1; continue;
    }
    if (!booleanFlags.has(flag)) { process.stderr.write(`Unknown limits argument: ${flag}\n`); return 2; }
  }
  if (args.includes("--help")) { process.stdout.write(help); return 0; }
  try {
    return args[0] === "statusline" ? await statusline(args) : await report(args);
  } catch {
    process.stderr.write("Limit meters could not be collected.\n");
    return 1;
  }
}
