import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { serviceId } from "../brand.ts";

export function reliabilityDataDirectory(): string {
  return process.env["SESSION_ANALYTICS_DATA_DIR"] || (process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", serviceId)
    : join(process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"), serviceId));
}

/** Fail closed. Never fall back to unkeyed hashes or replace an existing key. */
export async function loadReliabilitySecret(directory = reliabilityDataDirectory()): Promise<Buffer | null> {
  const path = join(directory, "reliability-hmac.key");
  async function read(): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== 32 || (info.mode & 0o777) !== 0o600 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error("Invalid reliability key.");
      const key = await file.readFile();
      if (key.length !== 32) throw new Error("Invalid reliability key.");
      return key;
    } finally { await file.close(); }
  }
  try {
    try { return await read(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Publish only a completely written key. Concurrent scans adopt the winner.
    const temporary = join(directory, `.reliability-key-${randomBytes(12).toString("hex")}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      try { await file.writeFile(randomBytes(32)); await file.sync(); }
      finally { await file.close(); }
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await unlink(temporary).catch(() => {}); }
    return await read();
  } catch { return null; }
}
