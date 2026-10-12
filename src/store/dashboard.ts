import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalyzeOptions } from "../types.ts";
import { dataDirectory, INDEX_UNAVAILABLE, secureDirectory, secureFile } from "./database.ts";

function tokenPath(options: Pick<AnalyzeOptions, "dataDir">, port: number): string {
  return join(dataDirectory(options), `dashboard-${port}.token`);
}

/** Only the process that bound this port publishes its token; replacement is atomic. */
export function writeDashboardToken(options: Pick<AnalyzeOptions, "dataDir">, port: number, token: string): void {
  secureDirectory(dataDirectory(options));
  const path = tokenPath(options, port);
  secureFile(path);
  const temporary = `${path}.${randomBytes(16).toString("hex")}.next`;
  writeFileSync(temporary, token, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

export function readDashboardToken(options: Pick<AnalyzeOptions, "dataDir">, port: number): string {
  const directory = lstatSync(dataDirectory(options));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 ||
      (process.getuid && directory.uid !== process.getuid())) throw new Error(INDEX_UNAVAILABLE);
  const descriptor = openSync(tokenPath(options, port), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size !== 64 || (info.mode & 0o777) !== 0o600 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error(INDEX_UNAVAILABLE);
    const token = readFileSync(descriptor, "utf8");
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(INDEX_UNAVAILABLE);
    return token;
  } finally { closeSync(descriptor); }
}
