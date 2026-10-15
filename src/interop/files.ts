import { InteropError } from "./error.ts";
import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

// The complete v0.6.0 machine snapshot can exceed 64 MiB before formatting.
export const maximumSnapshotBytes = 256 * 1024 * 1024;

/** Bounded read, including files that grow during the read. Never follow a symlink. */
export async function readJsonFile(path: string, limit = maximumSnapshotBytes): Promise<unknown> {
  return JSON.parse((await readBoundedFile(path, limit)).toString("utf8")) as unknown;
}

/** A regular file's bytes, never through a link, refused when larger than `limit` or changed while read. */
export async function readBoundedFile(path: string, limit = maximumSnapshotBytes): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > limit) throw new InteropError("Snapshot file is invalid or too large.");
    const buffer = Buffer.alloc(Math.min(stats.size + 1, limit + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (offset > limit || offset !== stats.size || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) throw new InteropError("Snapshot changed during reading.");
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}

/** Exclusive files: an export must never truncate an earlier export or follow a symlink. */
export async function writeNewFiles(directory: string, files: Record<string, string>): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  try {
    for (const [name, content] of Object.entries(files)) {
      if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw new InteropError("Invalid export filename.");
      const path = join(directory, name);
      const file = await open(path, "wx", 0o600);
      created.push(path);
      try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
    }
  } catch {
    await Promise.all(created.map((path) => unlink(path)));
    throw new InteropError("Export could not be written. Use a writable directory without existing export files.");
  }
}

export async function writeNewFile(path: string, content: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(content, "utf8"); await file.sync(); }
  catch (error) { await unlink(path); throw error; }
  finally { await file.close(); }
}
