import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { brand } from "./brand.ts";
import { version } from "./version.ts";

const help = `${brand.name} upgrade

Usage:
  ${brand.command} upgrade           Upgrade this installation with the package manager that installed it
  ${brand.command} upgrade --check   Print the installed and latest versions and the upgrade command; change nothing

Homebrew installs run brew upgrade; npm and release-tarball installs run npm install -g in the same prefix.
A source checkout is never changed: pull or check out a newer release tag instead.

Options:
  --check   Only check for a newer release
  --help    Show this help
`;

export const formula = "rokas-tarasevicius/tap/session-analytics";
const registry = "https://registry.npmjs.org/session-analytics/latest";

export type Installation =
  | { kind: "homebrew" }
  | { kind: "npm"; prefix: string; global: boolean }
  | { kind: "checkout"; root: string };

/**
 * Where the running package came from, by the real path of its package root: Homebrew keeps it in its Cellar
 * (npm-installed under libexec), npm in <prefix>/lib/node_modules, and anything else is a source checkout.
 */
export function installation(packageRoot: string): Installation {
  const parts = packageRoot.split(sep);
  if (parts.some((part, index) => part === "Cellar" && parts[index + 1] === "session-analytics")) return { kind: "homebrew" };
  if (parts.at(-1) === "session-analytics" && parts.at(-2) === "node_modules") {
    // A global install sits in <prefix>/lib/node_modules, a project dependency in <project>/node_modules.
    const parent = dirname(dirname(packageRoot)), global = parent.endsWith(`${sep}lib`);
    return { kind: "npm", prefix: global ? dirname(parent) : parent, global };
  }
  return { kind: "checkout", root: packageRoot };
}

/** The command that upgrades an installation, or null when it is a checkout the user updates with Git. */
export function upgradeCommand(install: Installation): string[] | null {
  if (install.kind === "homebrew") return ["brew", "upgrade", formula];
  if (install.kind === "npm") return ["npm", "install", ...(install.global ? ["--global"] : []), "--prefix", install.prefix, "session-analytics@latest"];
  return null;
}

/** Numeric X.Y.Z order; a pre-release or malformed version never counts as newer. */
export function newer(candidate: string, current: string): boolean {
  const parse = (value: string): number[] | null => /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null;
  const left = parse(candidate), right = parse(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index]! > right[index]!;
  return false;
}

export async function latestVersion(fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(registry, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`the npm registry answered ${response.status}`);
  const latest = (await response.json() as { version?: unknown }).version;
  if (typeof latest !== "string") throw new Error("the npm registry named no version");
  return latest;
}

export interface UpgradeDependencies {
  packageRoot: string;
  latest: () => Promise<string>;
  run: (command: string[]) => number;
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaults: UpgradeDependencies = {
  packageRoot: realpathSync(fileURLToPath(new URL("..", import.meta.url))),
  latest: () => latestVersion(),
  run: ([command, ...args]) => spawnSync(command!, args, { stdio: "inherit" }).status ?? 1,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export async function runUpgrade(args: string[], dependencies: Partial<UpgradeDependencies> = {}): Promise<number> {
  const { packageRoot, latest, run, out, err } = { ...defaults, ...dependencies };
  if (args.includes("--help")) { out(help.trimEnd()); return 0; }
  const unknown = args.find((arg) => arg !== "--check");
  if (unknown) { err(`Unknown upgrade argument: ${unknown}`); return 2; }
  const check = args.includes("--check");

  const install = installation(packageRoot);
  const command = upgradeCommand(install);
  if (!command) {
    err(`${brand.name} ${version} runs from the source checkout ${packageRoot}; upgrade it with git pull, or check out a newer release tag.`);
    return 1;
  }

  let available: string | null = null;
  try { available = await latest(); } catch (error) {
    if (check) { err(`Could not read the latest release: ${error instanceof Error ? error.message : String(error)}.`); return 1; }
    err(`Could not read the latest release; asking ${install.kind === "homebrew" ? "Homebrew" : "npm"} directly.`);
  }
  if (available && !newer(available, version)) { out(`${brand.name} ${version} is the latest release.`); return 0; }
  if (check) {
    out(`${brand.name} ${available} is available; ${version} is installed (${install.kind === "homebrew" ? "Homebrew" : "npm"}).`);
    out(`Run ${brand.command} upgrade, or: ${command.join(" ")}`);
    return 0;
  }
  out(`Upgrading ${brand.name} ${version}${available ? ` to ${available}` : ""}: ${command.join(" ")}`);
  const status = run(command);
  if (status !== 0) { err(`${command[0]} exited with ${status}; ${brand.name} was not upgraded.`); return status; }
  out(`Upgraded. A dashboard still running ${version} is not reused; stop it and start ${brand.command} again.`);
  return 0;
}
