import { brand } from "../brand.ts";
import {
  argument, commandWords, destinationPattern, machineNamePattern, OptionError, remoteTimeout, savedMachine, type RuntimeKind,
} from "../options.ts";
import { stopOnSignals, stopping } from "../processes.ts";
import { machineKey } from "../remote.ts";
import { version } from "../version.ts";
import { forgetLastGood, renameLastGood } from "./cache.ts";
import { checkHeading, checkLine, checkMachine, type MachineCheck } from "./check.ts";
import { machineProblem, machinesPath, readMachines, updateMachines, type MachinesConfig, type SavedMachine } from "./config.ts";

const command = brand.command;
const help = (): string => `${brand.name} machines

Read the computers where your agents run (servers, VMs, T3 Code hosts) together with this one.
Once a machine is saved, a plain \`${command}\`, \`report\` and \`export\` read it every time.

Usage:
  ${command} machines add <ssh-dest> [--name LABEL] [--user NAME [--no-login-shell]] [--node PATH] [--runtime bundled|installed] [--command WORDS] [--find-users] [--no-check]
  ${command} machines list [--json]
  ${command} machines check [NAME...] [--find-users] [--json]
  ${command} machines set <NAME> [--ssh DEST] [--user NAME | --no-user] [--no-login-shell | --login-shell] [--node PATH] [--runtime bundled|installed] [--command WORDS] [--enable | --disable]
  ${command} machines rename <NAME> <LABEL>   ('local' renames this machine's label)
  ${command} machines remove <NAME>

Options:
  --name LABEL       Label for the machine (default: the host name before the first dot, or the whole IP address)
  --user NAME        Read as this account through sudo -n -iu NAME, when agents run as their own user
  --no-login-shell   With --user: sudo -n -H -u NAME instead, for an account whose shell is nologin or false
  --runtime bundled  Default. Copies this session-analytics into that account's ~/.cache/session-analytics/runtime
                     over ssh and runs it with its Node.js 24 or later
  --runtime installed  Run a session-analytics installed there instead; --command names it (default: session-analytics)
  --node PATH        Node.js for the bundled runtime: node on the login PATH (default) or an absolute path
  --no-check         Save without connecting first
  --find-users       Also list login accounts whose home has .claude, .codex or .t3/userdata (names only; uses sudo -n)
  --remote-timeout SECONDS  Time allowed for the test read (default 300)
  --json             Print JSON: names, destinations, each check's result and fix, and for a failure the one
                     sanitized line ssh or the remote printed. No history or machine ID.
  --data-dir PATH    Private data directory that holds machines.json

check exits 1 when a check fails; each failure prints the command that fixes it.
`;

const commands: Record<string, { values: string[]; switches: string[]; positional: [number, number] }> = {
  add: { values: ["--name", "--user", "--node", "--runtime", "--command", "--data-dir", "--remote-timeout"], switches: ["--no-login-shell", "--find-users", "--no-check"], positional: [1, 1] },
  list: { values: ["--data-dir"], switches: ["--json"], positional: [0, 0] },
  check: { values: ["--data-dir", "--remote-timeout"], switches: ["--find-users", "--json"], positional: [0, 64] },
  set: { values: ["--ssh", "--user", "--node", "--runtime", "--command", "--data-dir"], switches: ["--no-user", "--no-login-shell", "--login-shell", "--enable", "--disable"], positional: [1, 1] },
  rename: { values: ["--data-dir"], switches: [], positional: [2, 2] },
  remove: { values: ["--data-dir"], switches: [], positional: [1, 1] },
};

/** Flags once each, values present, positionals counted. */
function parse(subcommand: string, args: string[]): string[] {
  const spec = commands[subcommand]!;
  const positional: string[] = [], seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (![...spec.values, ...spec.switches].includes(arg)) throw new OptionError(`Unknown machines ${subcommand} argument: ${arg.slice(0, 40)}`);
    if (seen.has(arg)) throw new OptionError(`Give ${arg} once.`);
    seen.add(arg);
    if (spec.values.includes(arg)) {
      if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new OptionError(`${arg} requires a value.`);
      index += 1;
    }
  }
  const [minimum, maximum] = spec.positional;
  if (positional.length < minimum || positional.length > maximum) throw new OptionError(`Wrong arguments for machines ${subcommand}; run ${command} machines --help.`);
  return positional;
}

const find = (config: MachinesConfig, name: string): SavedMachine | undefined => config.machines.find((machine) => machine.name.toLowerCase() === name.toLowerCase());
function named(config: MachinesConfig, name: string): SavedMachine {
  const machine = find(config, name);
  if (!machine) throw new OptionError(`No saved machine is named ${machineNamePattern.test(name) ? name : "that"}; see ${command} machines list.`);
  return machine;
}

/** `ci@build-box.example.com` is saved as `build-box`; an address names itself, so `192.168.1.20` is `192-168-1-20`. */
function defaultName(destination: string): string {
  const host = destination.replace(/^ssh:\/\//, "").replace(/^.*@/, "").replace(/^\[(.*)\](?::\d+)?$/, "$1").replace(/^([^:]*):\d+$/, "$1");
  const name = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":") ? host.replace(/[.:]+/g, "-").replace(/^-+|-+$/g, "") : host.split(".")[0] ?? "";
  if (!machineNamePattern.test(name) || name.toLowerCase() === "local") throw new OptionError("Name this machine with --name LABEL (letters, digits, . _ -).");
  return name;
}

function runtimeFrom(args: string[]): RuntimeKind | undefined {
  const runtime = argument(args, "--runtime");
  if (runtime !== undefined && runtime !== "bundled" && runtime !== "installed") throw new OptionError("--runtime takes bundled or installed.");
  return runtime;
}

/** A machine with these fields, or a fixed reason it cannot be saved. */
function validMachine(machine: SavedMachine, config: MachinesConfig, previous?: SavedMachine): SavedMachine {
  if (machine.runtime === "bundled" && machine.command) throw new OptionError("--command needs --runtime installed.");
  if (machine.runtime === "installed" && machine.node) throw new OptionError("--node applies to the bundled runtime; name node in --command instead.");
  if (machine.loginShell === false && !machine.user) throw new OptionError("--no-login-shell applies to an account named with --user.");
  const problem = machineProblem(machine);
  if (problem) throw new OptionError(`That machine cannot be saved: ${problem}.`);
  const others = config.machines.filter((other) => other !== previous);
  if (find({ ...config, machines: others }, machine.name)) throw new OptionError(`A machine named ${machine.name} is already saved; change it with ${command} machines set ${machine.name}, or choose another --name.`);
  if (config.local?.label.toLowerCase() === machine.name.toLowerCase()) throw new OptionError(`${machine.name} is this machine's label; choose another --name.`);
  const same = others.find((other) => other.ssh === machine.ssh && other.user === machine.user);
  if (same) throw new OptionError(`${same.name} already reads ${machine.ssh}${machine.user ? ` as ${machine.user}` : ""}.`);
  return machine;
}

const label = (config: MachinesConfig): string => config.local?.label ?? "this machine";
const readOrEmpty = (options: { dataDir?: string }): MachinesConfig => readMachines(options) ?? { version: 1, machines: [] };

async function check(machines: SavedMachine[], config: MachinesConfig, timeoutMs: number, findUsers: boolean, json: boolean, adding = false): Promise<MachineCheck[]> {
  const results: MachineCheck[] = [];
  for (const machine of machines) {
    const target = savedMachine(machine);
    if (!json) process.stdout.write(checkHeading(target, machine.enabled));
    results.push(await checkMachine(target, { timeoutMs, others: config.machines, findUsers, adding, onCheck: (item) => { if (!json && !stopping()) process.stdout.write(checkLine(item)); } }));
    // A signal stopped the checks; its handler exits once the children are gone.
    if (stopping()) await new Promise(() => {});
  }
  return results;
}

async function run(subcommand: string, args: string[]): Promise<number> {
  const positional = parse(subcommand, args);
  const options = { dataDir: argument(args, "--data-dir") };
  const write = (line: string): void => { process.stdout.write(`${line}\n`); };
  if (subcommand === "list") {
    const config = readOrEmpty(options);
    if (args.includes("--json")) { write(JSON.stringify(config, null, 2)); return 0; }
    write(config.local ? `This machine: ${config.local.label}` : `This machine has no label; ${command} machines rename local LABEL sets one.`);
    if (!config.machines.length) { write(`No saved machines. Add one with ${command} machines add HOST [--user NAME].`); return 0; }
    const rows = [["NAME", "SSH", "ACCOUNT", "RUNTIME", "STATE"], ...config.machines.map((machine) => [
      machine.name, machine.ssh, machine.user ?? "-", machine.runtime === "bundled" ? `bundled${machine.node ? ` (${machine.node})` : ""}` : `installed: ${(machine.command ?? ["session-analytics"]).join(" ")}`, machine.enabled ? "enabled" : "disabled",
    ])];
    const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
    for (const row of rows) write(row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd());
    return 0;
  }
  if (subcommand === "check") {
    const config = readOrEmpty(options);
    const machines = positional.length ? positional.map((name) => named(config, name)) : config.machines;
    if (!machines.length) { write(`No saved machines to check. Add one with ${command} machines add HOST [--user NAME].`); return 0; }
    stopOnSignals();
    const json = args.includes("--json");
    const results = await check(machines, config, remoteTimeout(args, process.env), args.includes("--find-users"), json);
    // Record each machine's keyed identity, so the same machine cannot be saved again under another name. The file
    // is read again first: another command may have changed it during the checks, and a machine since pointed elsewhere keeps its own.
    updateMachines(options, (current) => {
      let changed = false;
      results.forEach((result, index) => {
        const checked = machines[index]!, saved = find(current, checked.name);
        if (!saved || !result.identity || saved.ssh !== checked.ssh || saved.user !== checked.user || saved.identity === result.identity) return;
        if (result.checks.some((item) => item.check === "machine" && item.status !== "fail")) { saved.identity = result.identity; changed = true; }
      });
      return changed;
    });
    if (json) {
      write(JSON.stringify({ version: 1, machines: results.map(({ identity: _, reachable: __, refused: ___, ...result }, index) => ({ ...result, ssh: machines[index]!.ssh, ...(machines[index]!.user ? { user: machines[index]!.user } : {}), runtime: machines[index]!.runtime, enabled: machines[index]!.enabled })) }, null, 2));
    } else {
      const failing = results.filter((result) => !result.ok).map(({ name }) => name);
      write(failing.length ? `\n${failing.join(", ")} failed a check; run the Fix lines above, then check again.` : `\nAll ${results.length === 1 ? "checks" : `${results.length} machines`} passed.`);
    }
    return results.every((result) => result.ok) ? 0 : 1;
  }
  if (subcommand === "add") {
    const config = readOrEmpty(options);
    const destination = positional[0]!;
    if (!destinationPattern.test(destination)) throw new OptionError("machines add takes an SSH destination such as server or user@server.");
    const user = argument(args, "--user"), node = argument(args, "--node"), words = argument(args, "--command");
    const runtime = runtimeFrom(args) ?? (words ? "installed" : "bundled");
    const machine = validMachine({
      name: argument(args, "--name") ?? defaultName(destination), ssh: destination, ...(user ? { user } : {}), ...(args.includes("--no-login-shell") ? { loginShell: false as const } : {}),
      ...(node && node !== "node" ? { node } : {}), runtime, ...(words ? { command: commandWords(words, user) } : {}), enabled: true, addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }, config);
    let result: MachineCheck | undefined;
    if (!args.includes("--no-check")) {
      stopOnSignals();
      [result] = await check([machine], config, remoteTimeout(args, process.env), args.includes("--find-users"), false, true);
      if (result!.refused) {
        process.stderr.write(`Not saved: fix the failure above, then run ${command} machines add again.\n`);
        return 1;
      }
      if (result!.identity) machine.identity = result!.identity;
    }
    // Saved into the file as it is now; another add may have saved this name or destination meanwhile.
    const saved = updateMachines(options, (current) => { current.machines.push(validMachine(machine, current)); return current; });
    const passed = (name: string): boolean => result?.checks.some(({ check: item, status }) => item === name && status === "ok") ?? false;
    const owner = `${machine.user ?? "your"}${machine.user ? "'s" : ""} ~/.cache/session-analytics/runtime on ${machine.ssh}`;
    if (machine.runtime === "bundled" && (passed("runtime") || !result)) write(`\nThe bundled runtime is this session-analytics ${version}, ${result ? "copied into" : "copied on the first read into"} ${owner} and run there; use --runtime installed to run your own install instead.`);
    const failing = result?.checks.find(({ check: item, status }) => status === "fail" && item !== "accounts"), empty = result?.checks.find(({ check: item, status }) => item === "history" && status === "warn");
    if (failing) {
      write(`${result ? "\n" : ""}Saved ${machine.name}, but it cannot be read until this is fixed: ${failing.fix ?? failing.text}`);
      process.stderr.write(`Warning: ${machine.name} failed a check; after the fix, run ${command} machines check ${machine.name}.\n`);
    } else {
      write(`${result ? "\n" : ""}Saved ${machine.name}. A plain ${command} now reads ${label(saved)} and ${saved.machines.filter(({ enabled }) => enabled).map(({ name }) => name).join(", ")}.`);
      if (empty) write(`No sessions were observed for that account; ${empty.fix ?? ""}`);
      if (!result) write(`Test it with ${command} machines check ${machine.name}.`);
    }
    return 0;
  }
  if (subcommand === "set") {
    if (args.includes("--user") && args.includes("--no-user")) throw new OptionError("Give --user or --no-user, not both.");
    if (args.includes("--login-shell") && args.includes("--no-login-shell")) throw new OptionError("Give --login-shell or --no-login-shell, not both.");
    if (args.includes("--enable") && args.includes("--disable")) throw new OptionError("Give --enable or --disable, not both.");
    const next = updateMachines(options, (config) => {
      const previous = named(config, positional[0]!);
      const next: SavedMachine = { ...previous };
      const ssh = argument(args, "--ssh"), user = argument(args, "--user"), node = argument(args, "--node"), words = argument(args, "--command");
      const runtime = runtimeFrom(args) ?? (words ? "installed" : node ? "bundled" : undefined);
      if (ssh) { if (!destinationPattern.test(ssh)) throw new OptionError("--ssh takes an SSH destination such as server or user@server."); next.ssh = ssh; }
      if (user) next.user = user;
      if (args.includes("--no-user")) { delete next.user; delete next.loginShell; }
      if (args.includes("--no-login-shell")) next.loginShell = false;
      if (args.includes("--login-shell")) delete next.loginShell;
      if (runtime) { next.runtime = runtime; if (runtime === "bundled") delete next.command; else delete next.node; }
      if (node) { if (node === "node") delete next.node; else next.node = node; }
      if (words) next.command = commandWords(words, next.user);
      if (args.includes("--enable")) next.enabled = true;
      if (args.includes("--disable")) next.enabled = false;
      const moved = next.ssh !== previous.ssh || next.user !== previous.user;
      if (moved) delete next.identity;
      config.machines[config.machines.indexOf(previous)] = validMachine(next, config, previous);
      // Its last good snapshot describes another host or account.
      if (moved) forgetLastGood(options, machineKey(next.name));
      return next;
    });
    write(`Updated ${next.name}${next.enabled ? "" : " (disabled)"}. Test it with ${command} machines check ${next.name}.`);
    return 0;
  }
  if (subcommand === "rename") {
    const [name, label] = positional as [string, string];
    if (!machineNamePattern.test(label) || label.toLowerCase() === "local") throw new OptionError("A label is letters, digits, . _ - (up to 32), and not local.");
    updateMachines(options, (config) => {
      if (name.toLowerCase() === "local") {
        if (find(config, label)) throw new OptionError(`A saved machine is already named ${label}; choose another label.`);
        config.local = { label };
        return;
      }
      const previous = named(config, name);
      config.machines[config.machines.indexOf(previous)] = validMachine({ ...previous, name: label }, config, previous);
      if (machineKey(previous.name) !== machineKey(label)) renameLastGood(options, machineKey(previous.name), machineKey(label));
    });
    write(name.toLowerCase() === "local" ? `This machine is now labelled ${label}.` : `Renamed ${name} to ${label}.`);
    return 0;
  }
  const removed = updateMachines(options, (config) => {
    const removed = named(config, positional[0]!);
    config.machines = config.machines.filter((machine) => machine !== removed);
    forgetLastGood(options, machineKey(removed.name));
    return removed;
  });
  write(`Removed ${removed.name}.${removed.runtime === "bundled" ? ` Its bundled runtime stays in ${removed.user ?? "your"}${removed.user ? "'s" : ""} ~/.cache/session-analytics/runtime on ${removed.ssh}; delete that directory there to reclaim the space.` : ""}`);
  return 0;
}

export async function runMachines(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || (commands[subcommand] && rest.includes("--help"))) { process.stdout.write(help()); return 0; }
  if (!commands[subcommand]) { process.stderr.write(`Unknown machines command. Run ${command} machines --help.\n`); return 2; }
  try { return await run(subcommand, rest); }
  catch (error) {
    if (error instanceof OptionError) { process.stderr.write(`${error.message}\n`); return 2; }
    process.stderr.write(`The saved machines file ${machinesPath({ dataDir: argument(rest, "--data-dir") })} could not be read or written safely.\n`);
    return 1;
  }
}
