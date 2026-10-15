import { createHash } from "node:crypto";
import type { AnalyzeOptions, PricingPolicy, PricingSource } from "./types.ts";
import type { MachinesConfig, SavedMachine } from "./machines/config.ts";
import { pricingConfiguration } from "./pricing/catalog.ts";
import { brand } from "./brand.ts";

/** Analysis options shared by the dashboard and the report: flag, then `SESSION_ANALYTICS_*` variable. */
const analysisSettings: Array<[keyof AnalyzeOptions, string, string]> = [
  ["dataDir", "--data-dir", "DATA_DIR"],
  ["claudeRoot", "--claude-root", "CLAUDE_ROOT"],
  ["codexArchiveRoot", "--codex-archive-root", "CODEX_ARCHIVE_ROOT"],
  ["codexRoot", "--codex-root", "CODEX_ROOT"],
  ["cursorDatabasePath", "--cursor-database", "CURSOR_DATABASE"],
  ["cursorSdkRoot", "--cursor-sdk-root", "CURSOR_SDK_ROOT"],
  ["cursorTranscriptRoot", "--cursor-transcript-root", "CURSOR_TRANSCRIPT_ROOT"],
  ["copilotRoot", "--copilot-root", "COPILOT_ROOT"],
  ["opencodeDatabasePath", "--opencode-database", "OPENCODE_DATABASE"],
  ["geminiRoot", "--gemini-root", "GEMINI_ROOT"],
  ["databasePath", "--database", "CONDUCTOR_DATABASE"],
  ["rateCardPath", "--rate-card", "RATE_CARD"],
  ["repositoryId", "--repo-id", "REPO_ID"],
  ["repositoryName", "--repo-name", "REPO_NAME"],
  ["repositoryRemote", "--repo-remote", "REPO_REMOTE"],
  ["repositoryRoot", "--repo-root", "REPO_ROOT"],
  ["timeZone", "--time-zone", "TIME_ZONE"],
];

export const analysisValueFlags = [...analysisSettings.map(([, flag]) => flag), "--pricing-policy", "--pricing-sources", "--pricing-max-age-days"];
export const pricingHelp = `  --offline              Disable public pricing requests (cached prices still work)
  --data-dir PATH        Override the per-user analytics data directory
  --pricing-policy MODE  reviewed-first (default), api-first, or reviewed-only
  --pricing-sources LIST Ordered sources: models.dev,litellm (default)
  --pricing-max-age-days DAYS  Refresh threshold, default 7
`;
export const machineHelp = `  --time-zone ZONE       IANA time zone for activity days and hours (default: TZ, then the system zone)
  --portable-ids         Give repositories with a Git remote the same ID on every machine
`;
export const analysisBooleanFlags = ["--no-index", "--no-additional-providers", "--offline", "--portable-ids"];

/** A rejected option value; the message is fixed and safe to print. */
export class OptionError extends Error {}

export function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** A command-line flag wins over its `SESSION_ANALYTICS_*` environment variable. */
export function setting(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  flag: string,
  variable: string,
): string | undefined {
  return argument(argv, flag) ?? (environment[`SESSION_ANALYTICS_${variable}`] || undefined);
}

/** The canonical IANA name, e.g. `Europe/London`. The name also travels to other machines, so only zone characters pass. */
export function canonicalTimeZone(value: string): string {
  const invalid = (): never => { throw new OptionError("--time-zone must be an IANA time zone such as Europe/London or UTC."); };
  if (value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) invalid();
  try { return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone; }
  catch { return invalid(); }
}

export function analyzeOptionsFrom(argv: string[], environment: NodeJS.ProcessEnv): AnalyzeOptions {
  const options: AnalyzeOptions = { includeHidden: !argv.includes("--exclude-hidden") };
  if (argv.includes("--no-additional-providers") || environment["SESSION_ANALYTICS_ADDITIONAL_PROVIDERS"] === "0") options.additionalProviders = false;
  if (argv.includes("--no-index") || environment["SESSION_ANALYTICS_NO_INDEX"] === "1") options.noIndex = true;
  if (argv.includes("--portable-ids") || environment["SESSION_ANALYTICS_PORTABLE_IDS"] === "1") options.portableIds = true;
  for (const [property, flag, variable] of analysisSettings) {
    const value = setting(argv, environment, flag, variable);
    if (value) options[property] = value as never;
  }
  if (options.timeZone) options.timeZone = canonicalTimeZone(options.timeZone);
  options.offline = argv.includes("--offline") || environment.SESSION_ANALYTICS_OFFLINE === "1";
  const policy = setting(argv, environment, "--pricing-policy", "PRICING_POLICY");
  const sources = setting(argv, environment, "--pricing-sources", "PRICING_SOURCES");
  const age = setting(argv, environment, "--pricing-max-age-days", "PRICING_MAX_AGE_DAYS");
  if (policy !== undefined) options.pricingPolicy = policy as PricingPolicy;
  if (sources !== undefined) options.pricingSources = sources.split(",") as PricingSource[];
  if (age !== undefined) options.pricingMaxAgeDays = Number(age);
  pricingConfiguration(options);
  return options;
}

export type RuntimeKind = "bundled" | "installed";

/** One machine to read: a saved one, or an ad-hoc --remote destination. */
export interface RemoteMachine {
  /** Its label in messages; the key `--machines` selects. */
  name: string;
  /** SSH destination. */
  ssh: string;
  /** Account to run as, through `sudo -n -iu` (its login shell), or `sudo -n -H -u` when `loginShell` is false. */
  user?: string;
  /** False for an account whose login shell refuses commands (nologin, false), such as a service account. */
  loginShell?: false;
  runtime: RuntimeKind;
  /** Node that runs the bundled runtime. */
  node: string;
  /** Words that start an installed session-analytics. */
  command: string[];
  /** Saved in machines.json, so a fix can name `machines set` and its last good snapshot is kept. */
  saved: boolean;
  /** Hash of the machine ID and account that `machines check` recorded. */
  identity?: string;
}

export interface RemoteOptions {
  machines: RemoteMachine[];
  /** A machine that has not answered by then is stopped. */
  timeoutMs: number;
  /** Identifies the machines read, so a plain launch matches a running dashboard; null for this machine alone. */
  digest: string | null;
  /** This machine's label. */
  local: string;
}

export const remoteValueFlags = ["--remote", "--remote-command", "--machines", "--remote-timeout"];
export const remoteBooleanFlags = ["--no-remote"];
export const remoteHelp = `  --machines NAME[,NAME] Read only these saved machines (default: every enabled one; see machines --help)
  --remote HOST[,HOST]   Read these machines over SSH for this run instead (repeatable); needs session-analytics there
  --remote-command CMD   How --remote starts it there (default: session-analytics)
  --remote-timeout SECONDS  Stop a machine that has not answered by then (default 300)
  --no-remote            Scan only this machine; ignore saved machines and remote settings
`;

/** SSH destinations, accounts, node paths, labels and command words reach a remote shell, so only plain words pass. */
export const destinationPattern = /^[A-Za-z0-9_][A-Za-z0-9._@%:+/-]{0,254}$/;
export const accountPattern = /^[a-z_][a-z0-9_-]{0,31}$/;
export const nodePattern = /^(?:node|\/[A-Za-z0-9._/+-]{1,255})$/;
export const machineNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const commandWordPattern = /^[A-Za-z0-9_./~@%+=:,-]+$/;
export const defaultRemoteTimeoutSeconds = 300;
const thisMachine = "this machine";

export function allArguments(argv: string[], name: string): string[] {
  return argv.flatMap((value, index) => value === name && index + 1 < argv.length ? [argv[index + 1]!] : []);
}

/** Plain words only. `~` would expand to the SSH user's home before sudo switches account. */
export function commandWords(text: string, user?: string): string[] {
  const words = text.trim().split(/\s+/);
  const sudo = words.indexOf("sudo");
  if (text.length > 512 || !words.every((word) => commandWordPattern.test(word))) {
    throw new OptionError("--remote-command takes plain words, such as session-analytics or node /opt/session-analytics/bin/session-analytics.ts.");
  }
  if ((user || sudo >= 0) && words.slice(user ? 0 : sudo).some((word) => word.includes("~"))) {
    throw new OptionError("~ after sudo expands to the SSH user's home, not the other account's; use an absolute path.");
  }
  return words;
}

/** Ad-hoc destinations, each given once, from repeated or comma-separated values. */
export function destinations(values: string[], flag = "--remote"): string[] {
  const list = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (list.some((value) => !destinationPattern.test(value))) throw new OptionError(`${flag} takes SSH destinations such as server or user@server, separated by commas.`);
  if (new Set(list).size !== list.length) throw new OptionError(`List each ${flag} machine once.`);
  return list;
}

export function remoteTimeout(argv: string[], environment: NodeJS.ProcessEnv): number {
  const raw = setting(argv, environment, "--remote-timeout", "REMOTE_TIMEOUT");
  if (raw === undefined) return defaultRemoteTimeoutSeconds * 1000;
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || seconds < 1 || seconds > 86_400) throw new OptionError("--remote-timeout takes whole seconds from 1 to 86400.");
  return seconds * 1000;
}

export function machinesDigest(machines: RemoteMachine[]): string | null {
  if (!machines.length) return null;
  return createHash("sha256").update(JSON.stringify(machines.map(({ name, ssh, user, loginShell, runtime, node, command }) => [name, ssh, user ?? null, runtime, node, command, ...(loginShell === false ? [false] : [])]))).digest("hex");
}

/**
 * Which machines a run reads, first match wins: --no-remote; --remote (+ --remote-command) for this run;
 * SESSION_ANALYTICS_REMOTE (deprecated); otherwise the enabled saved machines, narrowed by --machines.
 */
export function remoteOptionsFrom(argv: string[], environment: NodeJS.ProcessEnv, saved: MachinesConfig | null = null): RemoteOptions {
  for (const flag of ["--remote-command", "--machines", "--remote-timeout"]) {
    if (argv.filter((value) => value === flag).length > 1) throw new OptionError(`Give ${flag} once.`);
  }
  const timeoutMs = remoteTimeout(argv, environment);
  const local = saved?.local?.label ?? thisMachine;
  if (argv.includes("--no-remote")) {
    if (argv.includes("--remote") || argv.includes("--machines")) throw new OptionError(`--no-remote cannot be combined with ${argv.includes("--remote") ? "--remote" : "--machines"}.`);
    return { machines: [], timeoutMs, digest: null, local };
  }
  const flagged = allArguments(argv, "--remote");
  // An explicit --machines wins over the deprecated variable, as any flag wins over the environment.
  const raw = flagged.length ? flagged : environment["SESSION_ANALYTICS_REMOTE"] && !argv.includes("--machines") ? [environment["SESSION_ANALYTICS_REMOTE"]] : [];
  let machines: RemoteMachine[];
  if (raw.length) {
    if (argv.includes("--machines")) throw new OptionError("--machines cannot be combined with --remote.");
    const command = commandWords(setting(argv, environment, "--remote-command", "REMOTE_COMMAND") ?? "session-analytics");
    machines = destinations(raw).map((destination) => ({ name: destination, ssh: destination, runtime: "installed", node: "node", command, saved: false }));
  } else {
    if (argv.includes("--remote-command")) throw new OptionError("--remote-command applies to --remote; set a saved machine's command with machines set NAME --command WORDS.");
    const all = saved?.machines ?? [];
    const selection = argument(argv, "--machines");
    let chosen = all.filter((machine) => machine.enabled);
    if (selection !== undefined) {
      const names = selection.split(",").map((name) => name.trim().toLowerCase());
      if (names.some((name) => !machineNamePattern.test(name))) throw new OptionError("--machines takes saved machine names separated by commas.");
      if (new Set(names).size !== names.length) throw new OptionError("List each --machines name once.");
      if (names.some((name) => !all.some((machine) => machine.name.toLowerCase() === name))) throw new OptionError(`--machines names a machine that is not saved; see ${brand.command} machines list.`);
      chosen = names.map((name) => all.find((machine) => machine.name.toLowerCase() === name)!);
    }
    machines = chosen.map(savedMachine);
  }
  return { machines, timeoutMs, digest: machinesDigest(machines), local };
}

/** A saved machine as a read target. */
export function savedMachine(machine: SavedMachine): RemoteMachine {
  return {
    name: machine.name, ssh: machine.ssh, ...(machine.user ? { user: machine.user } : {}), ...(machine.loginShell === false ? { loginShell: false as const } : {}), runtime: machine.runtime,
    node: machine.node ?? "node", command: machine.command ?? ["session-analytics"], saved: true, ...(machine.identity ? { identity: machine.identity } : {}),
  };
}

/** Options that describe only this machine; saved machines step aside for them. */
export function localOnlyAnalysis(options: AnalyzeOptions): boolean {
  return Boolean(options.repositoryId || options.repositoryName || options.repositoryRemote || options.repositoryRoot || options.rateCardPath);
}

/** Options that describe only this machine cannot be honoured on another one. */
export function assertRemoteAnalysis(options: AnalyzeOptions, remote: RemoteOptions): void {
  if (!remote.machines.length) return;
  if (options.repositoryId || options.repositoryName || options.repositoryRemote || options.repositoryRoot) {
    throw new OptionError("Repository filters cannot be combined with --remote or --machines; focus a repository in the dashboard instead.");
  }
  if (options.rateCardPath) throw new OptionError("--rate-card prices this machine only and cannot be combined with --remote or --machines.");
}

/** Fixed text for a rejected analysis option: the time-zone message, else the pricing one. */
export function optionErrorMessage(error: unknown): string {
  return error instanceof OptionError ? error.message : "Invalid pricing configuration.";
}

/** The worker environment for an analysis: `TZ` carries an explicit time zone. */
export function analysisEnvironment(options: Pick<AnalyzeOptions, "timeZone">): NodeJS.ProcessEnv {
  return options.timeZone ? { ...process.env, TZ: options.timeZone } : process.env;
}
