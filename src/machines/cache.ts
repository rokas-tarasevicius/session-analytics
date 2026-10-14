import { randomBytes } from "node:crypto";
import { renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readJsonFile } from "../interop/files.ts";
import { validateSnapshot } from "../interop/snapshot.ts";
import { dataDirectory, secureDirectory, secureFile } from "../store/database.ts";
import type { AnalyzeOptions, MachineAnalytics } from "../types.ts";
import { version } from "../version.ts";

/** A last good snapshot older than this is not shown, even as stale. */
export const lastGoodMaxAgeMs = 7 * 24 * 3_600_000;

/** What `<dataDir>/machines/<key>.json` records about the snapshot stored next to it. Content-free. */
export interface LastGood {
  version: 1;
  /** The session-analytics that read and stored it; another version reads the machine again instead. */
  tool: string;
  /** Digest of the request (time zone, pricing and scan switches); another request does not reuse it. */
  request: string;
  readAt: string;
  durationMs: number;
  /** The version that produced the snapshot there, when it said. */
  producer: string | null;
  sessions: number;
  repositories: number;
  identity?: string;
}

const directory = (options: Pick<AnalyzeOptions, "dataDir">): string => join(dataDirectory(options), "machines");
const paths = (options: Pick<AnalyzeOptions, "dataDir">, key: string): [string, string] => [join(directory(options), `${key}.json`), join(directory(options), `${key}.snapshot.json`)];

/** Private (0600) and atomic; a link or a foreign owner is refused. */
function writePrivate(path: string, content: string): void {
  secureFile(path);
  const temporary = `${path}.${randomBytes(16).toString("hex")}.next`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

/** Store a machine's validated snapshot after a good read; the snapshot is written before the record that points to it. */
export function writeLastGood(options: Pick<AnalyzeOptions, "dataDir">, key: string, record: Omit<LastGood, "version" | "tool">, snapshot: MachineAnalytics): void {
  secureDirectory(directory(options));
  const [meta, data] = paths(options, key);
  writePrivate(data, JSON.stringify(snapshot));
  writePrivate(meta, `${JSON.stringify({ version: 1, tool: version, ...record } satisfies LastGood, null, 2)}\n`);
}

/** The last good snapshot of a machine for this request, validated again; null when there is none to trust. */
export async function readLastGood(options: Pick<AnalyzeOptions, "dataDir">, key: string, request: string, now = Date.now()): Promise<{ record: LastGood; snapshot: MachineAnalytics } | null> {
  const [meta, data] = paths(options, key);
  try {
    const record = await readJsonFile(meta, 64 * 1024) as LastGood;
    const age = now - Date.parse(record.readAt);
    if (record.version !== 1 || record.tool !== version || record.request !== request || !(age >= 0 && age <= lastGoodMaxAgeMs)) return null;
    const snapshot = validateSnapshot(await readJsonFile(data));
    return snapshot.summary.sessions === record.sessions && !snapshot.machines ? { record, snapshot } : null;
  } catch { return null; }
}

/** Forget a machine's last good snapshot, as when it is removed or now reaches another account. */
export function forgetLastGood(options: Pick<AnalyzeOptions, "dataDir">, key: string): void {
  for (const path of paths(options, key)) rmSync(path, { force: true });
}

/** Keep a renamed machine's last good snapshot. */
export function renameLastGood(options: Pick<AnalyzeOptions, "dataDir">, from: string, to: string): void {
  const source = paths(options, from), target = paths(options, to);
  forgetLastGood(options, to);
  for (const [index, path] of source.entries()) {
    try { renameSync(path, target[index]!); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
