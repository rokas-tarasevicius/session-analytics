import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { brand } from "../brand.ts";
import {
  accountPattern, commandWords, destinationPattern, localOnlyAnalysis, machineNamePattern, nodePattern, OptionError, remoteOptionsFrom,
  type RemoteOptions, type RuntimeKind,
} from "../options.ts";
import { dataDirectory, secureDirectory, secureFile } from "../store/database.ts";
import type { AnalyzeOptions } from "../types.ts";

/** A machine saved with `machines add`. Content-free: a label, an SSH destination, an account name and how to start the tool. */
export interface SavedMachine {
  name: string;
  ssh: string;
  user?: string;
  node?: string;
  runtime: RuntimeKind;
  command?: string[];
  enabled: boolean;
  addedAt?: string;
  /** Hash of the machine ID and account, recorded by check, to refuse the same machine saved twice. */
  identity?: string;
}

export interface MachinesConfig {
  version: 1;
  local?: { label: string };
  machines: SavedMachine[];
}

export const machinesFileName = "machines.json";
const maximumBytes = 256 * 1024;
const maximumMachines = 64;

export function machinesPath(options: Pick<AnalyzeOptions, "dataDir">): string {
  return join(dataDirectory(options), machinesFileName);
}

const keysOnly = (value: object, keys: string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Validate one machine; the reason is a fixed phrase. */
export function machineProblem(value: unknown): string | null {
  if (!isObject(value) || !keysOnly(value, ["name", "ssh", "user", "node", "runtime", "command", "enabled", "addedAt", "identity"])) return "a machine has unknown fields";
  const { name, ssh, user, node, runtime, command, enabled, addedAt, identity } = value;
  if (typeof name !== "string" || !machineNamePattern.test(name) || name.toLowerCase() === "local") return "a machine name is not a plain label";
  if (typeof ssh !== "string" || !destinationPattern.test(ssh)) return "an SSH destination is not plain";
  if (user !== undefined && (typeof user !== "string" || !accountPattern.test(user))) return "an account name is not valid";
  if (runtime !== "bundled" && runtime !== "installed") return "a runtime is not bundled or installed";
  if (node !== undefined && (typeof node !== "string" || !nodePattern.test(node) || runtime !== "bundled")) return "a node path is not node or an absolute path";
  if (command !== undefined) {
    if (runtime !== "installed" || !Array.isArray(command) || !command.length || !command.every((word) => typeof word === "string")) return "a command is not a list of plain words";
    try { if (commandWords(command.join(" "), typeof user === "string" ? user : undefined).length !== command.length) return "a command is not a list of plain words"; }
    catch { return "a command is not a list of plain words"; }
  }
  if (typeof enabled !== "boolean") return "enabled is not true or false";
  if (addedAt !== undefined && (typeof addedAt !== "string" || addedAt.length > 40 || Number.isNaN(Date.parse(addedAt)))) return "addedAt is not a timestamp";
  if (identity !== undefined && (typeof identity !== "string" || !/^[0-9a-f]{16}$/.test(identity))) return "an identity is not a 16-digit hash";
  return null;
}

/** Strict: an unknown field or version is an error, never silently dropped. */
export function parseMachines(value: unknown): MachinesConfig {
  const invalid = (reason: string): never => { throw new OptionError(reason); };
  if (!isObject(value) || !keysOnly(value, ["version", "local", "machines"])) return invalid("it has unknown fields");
  if (value.version !== 1) return invalid("its version is not 1");
  if (value.local !== undefined && (!isObject(value.local) || !keysOnly(value.local, ["label"]) || typeof value.local.label !== "string" || !machineNamePattern.test(value.local.label))) return invalid("the local label is not a plain label");
  if (!Array.isArray(value.machines) || value.machines.length > maximumMachines) return invalid(`machines is not a list of at most ${maximumMachines}`);
  for (const machine of value.machines) { const problem = machineProblem(machine); if (problem) invalid(problem); }
  const machines = value.machines as SavedMachine[];
  if (new Set(machines.map(({ name }) => name.toLowerCase())).size !== machines.length) invalid("two machines share a name");
  return { version: 1, ...(value.local ? { local: { label: value.local.label as string } } : {}), machines };
}

/** The saved machines, or null when none were saved. A link, a foreign owner or invalid content is refused. */
export function readMachines(options: Pick<AnalyzeOptions, "dataDir">): MachinesConfig | null {
  const path = machinesPath(options);
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new OptionError(`The saved machines file ${path} could not be read safely; fix or remove it.`);
  }
  let text: string;
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > maximumBytes || (process.getuid && info.uid !== process.getuid())) {
      throw new OptionError(`The saved machines file ${path} could not be read safely; fix or remove it.`);
    }
    text = readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
  try { return parseMachines(JSON.parse(text)); }
  catch (error) { throw new OptionError(`The saved machines file ${path} is invalid${error instanceof OptionError ? `: ${error.message}` : ""}. Fix or remove it.`); }
}

/** Private (0600) and atomic, like the other files in the data directory. */
export function writeMachines(options: Pick<AnalyzeOptions, "dataDir">, config: MachinesConfig): void {
  const directory = dataDirectory(options);
  secureDirectory(directory);
  const path = machinesPath(options);
  secureFile(path);
  const temporary = `${path}.${randomBytes(16).toString("hex")}.next`;
  writeFileSync(temporary, `${JSON.stringify(parseMachines(config), null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

/**
 * The machines a dashboard, report or export reads. The saved file is read only when no flag or
 * variable decides, and saved machines step aside for options that describe this machine alone.
 */
export function remoteFor(argv: string[], environment: NodeJS.ProcessEnv, options: AnalyzeOptions, notice: (line: string) => void = () => {}): RemoteOptions {
  const flagged = argv.includes("--no-remote") || argv.includes("--remote");
  const variable = !flagged && Boolean(environment["SESSION_ANALYTICS_REMOTE"]);
  if (variable) notice(`SESSION_ANALYTICS_REMOTE is deprecated; save machines with ${brand.command} machines add HOST.`);
  let saved: MachinesConfig | null = null;
  // When a flag or variable decides, the file only supplies this machine's label, so a broken one does not block that run.
  try { saved = readMachines(options); } catch (error) { if (!flagged && !variable) throw error; }
  const remote = remoteOptionsFrom(argv, environment, saved);
  if (flagged || variable || argv.includes("--machines") || !remote.machines.length || !localOnlyAnalysis(options)) return remote;
  notice("Saved machines are not read: repository filters and --rate-card describe this machine only.");
  return { ...remote, machines: [], digest: null };
}
