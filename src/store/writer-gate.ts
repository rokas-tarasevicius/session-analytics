import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const COORDINATION_ERROR = "The local index writer coordination is damaged; run index rebuild or use --no-index.";
const BUSY = "The local index is busy; another ingest or maintenance command is running.";
const pause = new Int32Array(new SharedArrayBuffer(4));
const ticketPattern = /^writer-ticket-(\d+)-[a-f0-9]{32}$/;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/**
 * Lamport's bakery mutex over atomic, private filesystem tickets. Every participant
 * publishes "choosing" (0), then max+1 by atomic rename, and waits for smaller
 * (number, name) pairs. New arrivals see our published ticket. Dead processes are
 * ignored; only uniquely named tickets are removed, never a shared lock pathname.
 * This keeps recovery independent of SQLite and avoids stale-lock unlink races.
 */
export function acquireWriterGate(directory: string): () => void {
  const name = `writer-ticket-${process.pid}-${randomBytes(16).toString("hex")}`;
  const path = join(directory, name), next = `${path}.next`;
  const deadline = Date.now() + 5_000;
  const remove = (file: string): void => {
    try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  const ticket = (entry: string): bigint | null => {
    const match = ticketPattern.exec(entry);
    if (!match) return null;
    const file = join(directory, entry);
    if (!alive(Number(match[1]))) { remove(file); remove(`${file}.next`); return null; }
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new Error(COORDINATION_ERROR);
      const value = readFileSync(file, "utf8");
      if (!/^\d{1,32}$/.test(value)) throw new Error(COORDINATION_ERROR);
      return BigInt(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const wait = (): void => {
    if (Date.now() >= deadline) throw new Error(BUSY);
    Atomics.wait(pause, 0, 0, 20);
  };
  try {
    // A reader can observe the newly created empty file before write completes.
    // Publish a complete choosing ticket using the same atomic rename as numbers.
    writeFileSync(next, "0", { mode: 0o600, flag: "wx" }); renameSync(next, path);
    let maximum = 0n;
    for (const entry of readdirSync(directory)) {
      const value = ticket(entry);
      if (value !== null && value > maximum) maximum = value;
    }
    const number = maximum + 1n;
    writeFileSync(next, String(number), { mode: 0o600, flag: "wx" }); renameSync(next, path);
    for (const entry of readdirSync(directory)) {
      if (entry === name || !ticketPattern.test(entry)) continue;
      for (;;) {
        const value = ticket(entry);
        if (value === null || (value > 0n && (value > number || (value === number && entry > name)))) break;
        wait();
      }
    }
    return () => remove(path);
  } catch (error) {
    remove(path); remove(next);
    if (error instanceof Error && error.message === BUSY) throw error;
    throw new Error(COORDINATION_ERROR);
  }
}
