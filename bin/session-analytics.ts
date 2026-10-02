#!/usr/bin/env node
// Command dispatcher: `session-analytics [dashboard|report] [options]`.
import { brand } from "../src/brand.ts";
import { version } from "../src/version.ts";

const [command, ...rest] = process.argv.slice(2);
const forward = (args: string[]): void => {
  process.argv = [process.argv[0] ?? process.execPath, process.argv[1] ?? "", ...args];
};

if (command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(`${brand.name} ${version}
Content-free analytics for local coding-agent sessions.

Usage:
  ${brand.command} [dashboard] [options]  Scan local sessions and open the localhost dashboard
  ${brand.command} report [options]       Print a terminal report (add --json for a snapshot)
  ${brand.command} insights [options]     Explain measured signals (add --json for cards)
  ${brand.command} review [options]       Preview an opt-in bounded session review
  ${brand.command} <command> --help       Show options for a command
  ${brand.command} --version              Print the version
`);
} else if (command === "--version" || command === "-v") {
  process.stdout.write(`${version}\n`);
} else if (command === "report") {
  forward(rest);
  await import("../src/cli.ts");
} else if (command === "insights" || command === "review") {
  forward(rest);
  if (command === "insights") await import("../src/insights/cli.ts");
  else await import("../src/insights/review-cli.ts");
} else {
  const args = command === "dashboard" ? rest : process.argv.slice(2);
  const informational = args.includes("--help") || args.includes("--version");
  const open = !args.includes("--no-open") && !informational;
  forward([...args.filter((arg) => arg !== "--no-open"), ...(open && !args.includes("--open") ? ["--open"] : [])]);
  await import("../src/server.ts");
}
