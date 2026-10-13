import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { brand } from "../brand.ts";
import { argument, setting } from "../options.ts";
import { dataDirectory, secureDirectory, secureFile } from "../store/database.ts";
import { buildMeters, formatDuration, latestReading, liveMeter, providerNames, type LiveMeter } from "../public/subscription-data.js";
import { planFor } from "../public/subscription-plans.js";
import { collectLimits, type LimitsOptions } from "./index.ts";
import { appendInbox } from "./ledger.ts";
import { statuslineObservations } from "./sources.ts";
import type { LimitObservation } from "./types.ts";

const help = `${brand.name} limits

Usage:
  ${brand.command} limits [--json] [--quiet]   Harvest subscription limit meters and print where each stands
  ${brand.command} limits statusline            Claude Code status line: records rate_limits from stdin, prints them

Sources (read-only): Codex session rate_limits records, Claude Agent SDK rate_limit_event records in host
event logs (T3 Code by default; SESSION_ANALYTICS_CLAUDE_EVENT_LOGS overrides), and statusline readings.
Readings are kept in a private ledger in the data directory so reset history survives log rotation.
Run it on a schedule to keep history continuous, e.g. cron: */20 * * * * ${brand.command} limits --quiet

Options:
  --json             Print the content-free limits snapshot
  --quiet            Harvest only; print nothing
  --data-dir PATH    Private data directory (ledger location)
  --no-index         Do not read or write the ledger
  --codex-root PATH  Read Codex sessions from PATH instead of discovered profiles
  --claude-root PATH Explicit Claude root: skips Claude event-log and plan discovery
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

function describe(live: LiveMeter, now: number): string {
  const label = live.meter.label.padEnd(28);
  if (!live.cycle) return `  ${label} idle · the next request starts a new window`;
  const parts = [`${live.used.toFixed(0).padStart(3)}% used`, `resets ${clock(live.cycle.resetsAt)} (in ${formatDuration(Math.max(0, live.cycle.resetsAt - now))})`];
  if (live.state === "unreported") return `  ${label} ${live.used.toFixed(0).padStart(3)}% at last report ${clock(live.observedAt ?? now)} · no longer reported by the provider`;
  if (live.state === "capped") parts.push(`capped since ${clock(live.capAt ?? live.cycle.last.t)}`);
  else if (live.capsEarly && live.capAt) parts.push(`at this pace runs out ${clock(live.capAt)}`);
  else if (live.projected === null) parts.push("too early in the window to project");
  else if (live.projected !== undefined && live.elapsed !== null && (live.elapsed ?? 0) > 0.05) parts.push(`on pace for ${Math.min(100, live.projected).toFixed(0)}% at reset`);
  if (live.stale) parts.push(`last reading ${formatDuration(now - (live.observedAt ?? now))} ago`);
  return `  ${label} ${parts.join(" · ")}`;
}

async function report(args: string[]): Promise<number> {
  const snapshot = await collectLimits(options(args));
  if (args.includes("--quiet")) return 0;
  if (args.includes("--json")) { process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`); return 0; }
  const now = Date.now() / 1000;
  const meters = buildMeters(snapshot.observations, now);
  const lines = [`${brand.name} · subscription limits`, ""];
  for (const provider of ["claude", "codex"] as const) {
    const plan = planFor(provider, snapshot.plans[provider]);
    const own = meters.filter((meter) => meter.provider === provider);
    lines.push(`${providerNames[provider]}${plan ? ` · ${plan.label}${plan.monthlyUsd ? ` ($${plan.monthlyUsd}/mo)` : ""}` : ""}`);
    if (!own.length) lines.push("  No meter readings yet.");
    for (const meter of own) lines.push(describe(liveMeter(meter, now, latestReading(own)), now));
    lines.push("");
  }
  const resets = snapshot.accounts.codex?.resetCredits;
  if (resets) {
    const next = (resets.credits ?? []).filter((credit) => credit.status === "available" && credit.expiresAt).sort((a, b) => a.expiresAt! - b.expiresAt!)[0];
    lines.push(`Codex banked resets: ${resets.available} available${next?.expiresAt ? `, next expires ${clock(next.expiresAt)} (in ${formatDuration(next.expiresAt - now)})` : ""}`);
  } else if (snapshot.codexAccount === "off") lines.push("Codex banked resets: not read (turned off)");
  else if (snapshot.codexAccount === "unavailable") lines.push("Codex banked resets: the local Codex app-server did not answer");
  const balance = snapshot.accounts.codex?.credits;
  if (balance?.balance !== null && balance?.balance !== undefined) lines.push(`Codex credit balance: ${Math.round(balance.balance).toLocaleString("en")} credits`);
  const extra = snapshot.accounts.claude;
  if (extra) lines.push(`Claude extra usage: ${extra.extraUsage}${extra.disabledReason ? ` (${extra.disabledReason.replace(/_/g, " ")})` : ""}`);
  lines.push("");
  for (const source of snapshot.sources) lines.push(`Source ${source.source}: ${source.status}${source.latest ? `, latest ${clock(source.latest)}` : ""}`);
  lines.push(snapshot.persisted ? "History is kept in the private ledger. Value, capacity and reset history: open the dashboard's Subscription view." : "History is not persisted (--no-index).");
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/** Skip appending when nothing changed since the last statusline refresh; status lines redraw many times a minute. */
function changedSinceLast(directory: string, observations: LimitObservation[]): boolean {
  const path = join(directory, "limits-statusline.last");
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
      if (changedSinceLast(directory, observations)) appendInbox(directory, observations);
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
