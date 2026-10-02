import { createHmac } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

/** No path or source bytes are persisted. Nanosecond times avoid float rounding. */
export interface FileFingerprint {
  device: string;
  inode: string;
  size: number;
  mtime: string;
  ctime: string;
  head: string;
  tail: string;
}

const SAMPLE_BYTES = 4096;

export function keyedHash(secret: Uint8Array, value: string | Uint8Array): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export async function fingerprint(path: string, secret: Uint8Array): Promise<FileFingerprint> {
  const file = await open(path, constants.O_RDONLY);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Unsupported evidence file.");
    }
    const size = Number(before.size);
    const head = Buffer.alloc(Math.min(size, SAMPLE_BYTES));
    const tail = Buffer.alloc(Math.min(size, SAMPLE_BYTES));
    await file.read(head, 0, head.length, 0);
    await file.read(tail, 0, tail.length, Math.max(0, size - SAMPLE_BYTES));
    const after = await file.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Evidence changed during fingerprinting.");
    }
    return {
      device: before.dev.toString(), inode: before.ino.toString(), size,
      mtime: before.mtimeNs.toString(), ctime: before.ctimeNs.toString(),
      head: keyedHash(secret, head), tail: keyedHash(secret, tail),
    };
  } finally {
    await file.close();
  }
}

export async function stillMatches(path: string, previous: FileFingerprint): Promise<boolean> {
  try {
    const current = await stat(path, { bigint: true });
    return current.dev.toString() === previous.device && current.ino.toString() === previous.inode &&
      Number(current.size) === previous.size && current.mtimeNs.toString() === previous.mtime &&
      current.ctimeNs.toString() === previous.ctime;
  } catch { return false; }
}

/** Verify the entire old prefix before resuming: edge samples alone cannot prove append-only growth. */
export async function hashPrefix(path: string, bytes: number, secret: Uint8Array): Promise<string> {
  const hash = createHmac("sha256", secret);
  if (bytes > 0) {
    for await (const chunk of createReadStream(path, { start: 0, end: bytes - 1 })) hash.update(chunk);
  }
  return hash.digest("hex");
}
