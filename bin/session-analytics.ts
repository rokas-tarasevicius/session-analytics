#!/usr/bin/env node
// One dispatcher for every local analytics surface.
// Only plain constants load statically; every command loads below the guard, so an older Node stops with a reason.
import { brand } from "../src/brand.ts";
import { version } from "../src/version.ts";

if (Number(process.versions.node.split(".")[0]) < 24) {
  process.stderr.write(`${brand.name} needs Node.js 24 or newer; this is ${process.version}.\n`);
  process.exit(1);
}

const [command, ...rawRest] = process.argv.slice(2);
const rest = rawRest.map((arg) => arg === "-h" ? "--help" : arg);
const commands = new Set(["dashboard", "report", "rates", "export", "merge", "index", "mcp", "limits", "machines", "upgrade"]);
const forward = (args: string[]): void => {
  process.argv = [process.argv[0] ?? process.execPath, process.argv[1] ?? "", ...args];
};

if (command && commands.has(command) && rest.length === 1 && rest[0] === "--version") {
  process.stdout.write(`${version}\n`);
} else if (command && !command.startsWith("-") && !commands.has(command) && command !== "help") {
  process.stderr.write("Unknown command. Run session-analytics --help.\n");
  process.exitCode = 2;
} else if (command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(`${brand.name} ${version}
Content-free analytics for local coding-agent sessions.

Usage:
  ${brand.command} [dashboard] [options]  Scan local sessions and open the localhost dashboard
  ${brand.command} report [options]       Print a terminal report (add --json for a snapshot)
  ${brand.command} rates <command>        Update, show, diff, or inspect cached pricing
  ${brand.command} export [options]       Write CSV, NDJSON, or OTLP/JSON files
  ${brand.command} merge FILE...          Combine shared snapshots, or full snapshots from several machines
  ${brand.command} mcp [options]          Serve metrics-only MCP tools over stdio
  ${brand.command} index <action>         Manage the local index: status, path, rebuild, prune
  ${brand.command} limits [statusline]    Harvest subscription limit meters (Claude, Codex) and show where they stand
  ${brand.command} machines <command>     Save, check and manage other machines to read over SSH (add, list, check, set, rename, remove)
  ${brand.command} upgrade [--check]      Upgrade with the package manager that installed it (Homebrew or npm)
  ${brand.command} <command> --help       Show options for a command
  ${brand.command} --version              Print the version

No sessions found? Complete a supported agent session, then Refresh snapshot.
Provider setup: https://github.com/rokas-tarasevicius/session-analytics/blob/master/docs/providers.md
Dashboard tour: https://github.com/rokas-tarasevicius/session-analytics/blob/master/docs/dashboard.md
`);
} else if (command === "--version" || command === "-v") {
  process.stdout.write(`${version}\n`);
} else if (command === "report") {
  forward(rest);
  await import("../src/cli.ts");
} else if (command === "rates") {
  const { runRates } = await import("../src/pricing/cli.ts");
  process.exitCode = await runRates(rest);

} else if (command === "export" || command === "merge") {
  const { runInterop, reportInteropFailure } = await import("../src/interop/cli.ts");
  try { await runInterop(command, rest); } catch (error) { reportInteropFailure(error); }
} else if (command === "mcp") {
  forward(rest);
  await import("../src/mcp/cli.ts");
} else if (command === "limits") {
  const { runLimits } = await import("../src/limits/cli.ts");
  process.exitCode = await runLimits(rest);
} else if (command === "machines") {
  const { runMachines } = await import("../src/machines/cli.ts");
  process.exitCode = await runMachines(rest);
} else if (command === "upgrade") {
  const { runUpgrade } = await import("../src/upgrade.ts");
  process.exitCode = await runUpgrade(rest);
} else if (command === "index") {
  forward(rest);
  await import("../src/store/cli.ts");
} else {
  const args = command === "dashboard" ? rest : process.argv.slice(2);
  const informational = args.includes("--help") || args.includes("--version");
  const open = !args.includes("--no-open") && !informational;
  forward([...args.filter((arg) => arg !== "--no-open"), ...(open && !args.includes("--open") ? ["--open"] : [])]);
  await import("../src/server.ts");
}
