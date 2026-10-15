import { createHash, randomBytes } from "node:crypto";
import { renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readBoundedFile, readJsonFile } from "../interop/files.ts";
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
  /** Digest of the SSH destination and account read; a machine pointed elsewhere does not reuse it. */
  target: string;
  /** SHA-256 of the snapshot file's bytes, so a record never vouches for another read's snapshot. */
  digest: string;
  readAt: string;
  durationMs: number;
  /** The version that produced the snapshot there, when it said. */
  producer: string | null;
  sessions: number;
  repositories: number;
  identity?: string;
}

/** What `<dataDir>/machines/<key>.limits.json` keeps of a saved machine's last good limits read. Content-free. */
export interface LastGoodLimits {
  version: 1;
  /** The session-analytics that read and stored it; another version reads the machine again instead. */
  tool: string;
  request: string;
  target: string;
  readAt: string;
  durationMs: number;
  /** Whether that machine's reads also ask its Codex app-server: it reports a Codex account whose banked resets are not known here. */
  codexAccount: boolean;
  /** The validated limits snapshot that machine returned. */
  limits: unknown;
}

const directory = (options: Pick<AnalyzeOptions, "dataDir">): string => join(dataDirectory(options), "machines");
const paths = (options: Pick<AnalyzeOptions, "dataDir">, key: string): [string, string, string] =>
  [join(directory(options), `${key}.json`), join(directory(options), `${key}.snapshot.json`), join(directory(options), `${key}.limits.json`)];

/** Private (0600) and atomic; a link or a foreign owner is refused. */
function writePrivate(path: string, content: string): void {
  secureFile(path);
  const temporary = `${path}.${randomBytes(16).toString("hex")}.next`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** Store a machine's validated snapshot after a good read; the snapshot is written before the record that names its digest. */
export function writeLastGood(options: Pick<AnalyzeOptions, "dataDir">, key: string, record: Omit<LastGood, "version" | "tool" | "digest">, snapshot: MachineAnalytics): void {
  secureDirectory(directory(options));
  const [meta, data] = paths(options, key), text = JSON.stringify(snapshot);
  writePrivate(data, text);
  writePrivate(meta, `${JSON.stringify({ version: 1, tool: version, ...record, digest: sha256(text) } satisfies LastGood, null, 2)}\n`);
}

/**
 * The last good snapshot of a machine for this request and target, validated again; null when there is none
 * to trust. A known identity that differs from the recorded one means another machine answered back then.
 */
export async function readLastGood(
  options: Pick<AnalyzeOptions, "dataDir">, key: string, expected: { request: string; target: string; identity?: string }, now = Date.now(),
): Promise<{ record: LastGood; snapshot: MachineAnalytics } | null> {
  const [meta, data] = paths(options, key);
  try {
    const record = await readJsonFile(meta, 64 * 1024) as LastGood;
    const age = now - Date.parse(record.readAt);
    if (record.version !== 1 || record.tool !== version || record.request !== expected.request || record.target !== expected.target || !(age >= 0 && age <= lastGoodMaxAgeMs)) return null;
    if (expected.identity && record.identity && expected.identity !== record.identity) return null;
    const bytes = await readBoundedFile(data);
    if (sha256(bytes) !== record.digest) return null;
    const snapshot = validateSnapshot(JSON.parse(bytes.toString("utf8")));
    return snapshot.summary.sessions === record.sessions && !snapshot.machines ? { record, snapshot } : null;
  } catch { return null; }
}

/** Store a machine's last good limits after a good read. */
export function writeLastGoodLimits(options: Pick<AnalyzeOptions, "dataDir">, key: string, record: Omit<LastGoodLimits, "version" | "tool">): void {
  secureDirectory(directory(options));
  writePrivate(paths(options, key)[2], `${JSON.stringify({ version: 1, tool: version, ...record } satisfies LastGoodLimits)}\n`);
}

/** The last good limits of a machine for this request and target, at most 7 days old; `validate` checks them again. */
export async function readLastGoodLimits<T>(
  options: Pick<AnalyzeOptions, "dataDir">, key: string, expected: { request: string; target: string }, validate: (value: unknown) => T, now = Date.now(),
): Promise<{ record: LastGoodLimits; limits: T } | null> {
  try {
    const record = await readJsonFile(paths(options, key)[2], 64 * 1024 * 1024) as LastGoodLimits;
    const age = now - Date.parse(record.readAt);
    if (record.version !== 1 || record.tool !== version || record.request !== expected.request || record.target !== expected.target || !(age >= 0 && age <= lastGoodMaxAgeMs)) return null;
    if (!Number.isFinite(record.durationMs) || typeof record.codexAccount !== "boolean") return null;
    return { record, limits: validate(record.limits) };
  } catch { return null; }
}

/** Forget a machine's last good snapshot and limits, as when it is removed or now reaches another account. */
export function forgetLastGood(options: Pick<AnalyzeOptions, "dataDir">, key: string): void {
  for (const path of paths(options, key)) rmSync(path, { force: true });
}

/** Keep a renamed machine's last good snapshot and limits. */
export function renameLastGood(options: Pick<AnalyzeOptions, "dataDir">, from: string, to: string): void {
  const source = paths(options, from), target = paths(options, to);
  forgetLastGood(options, to);
  for (const [index, path] of source.entries()) {
    try { renameSync(path, target[index]!); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
