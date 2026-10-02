import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { PricingOptions, PricingStatus, RateCard } from "../types.ts";
import { SOURCE_URLS, sha256, type SourceSnapshot } from "./sources.ts";
import { isoTimestamp, MAX_MODELS, MAX_PAYLOAD_BYTES, record, validateCard, validateRate } from "./validation.ts";
import { validModelId } from "./aliases.ts";
import { serviceId } from "../brand.ts";

export interface ReviewedSnapshot {
  version: 1;
  source: "reviewed";
  fetchedAt: string;
  payloadSha256: string;
  card: RateCard;
}
export type StoredSnapshot = SourceSnapshot | ReviewedSnapshot;

export function pricingDirectory(options: PricingOptions = {}, environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform, home: string = homedir()): string {
  const override = options.dataDir ?? environment.SESSION_ANALYTICS_DATA_DIR;
  const xdg = environment.XDG_DATA_HOME;
  const base = override ? resolve(override) : platform === "darwin"
    ? join(home, "Library", "Application Support", serviceId)
    : join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), serviceId);
  return join(base, "pricing");
}

function validateSnapshot(value: unknown): StoredSnapshot {
  const raw = record(value);
  if (!raw || raw.version !== 1 || !isoTimestamp(raw.fetchedAt) ||
      typeof raw.payloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.payloadSha256)) {
    throw new Error("Invalid pricing snapshot.");
  }
  if (raw.source === "reviewed") {
    const card = validateCard(raw.card);
    if (raw.fetchedAt !== `${card.effectiveDate}T00:00:00.000Z`) throw new Error("Invalid reviewed date.");
    return { version: 1, source: "reviewed", fetchedAt: raw.fetchedAt, payloadSha256: raw.payloadSha256, card };
  }
  if (raw.source !== "models.dev" && raw.source !== "litellm") throw new Error("Invalid pricing source.");
  const source = raw.source, input = record(raw.models);
  if (raw.sourceUrl !== SOURCE_URLS[source] || !input || !Object.keys(input).length ||
      Object.keys(input).length > MAX_MODELS || !Number.isSafeInteger(raw.rejectedModels) ||
      (raw.rejectedModels as number) < 0) throw new Error("Invalid pricing snapshot.");
  const models: SourceSnapshot["models"] = Object.create(null);
  for (const [model, rate] of Object.entries(input)) {
    if (!validModelId(model)) throw new Error("Invalid pricing model.");
    models[model] = validateRate(rate, SOURCE_URLS[source]);
  }
  return { version: 1, source, sourceUrl: SOURCE_URLS[source], fetchedAt: raw.fetchedAt,
    payloadSha256: raw.payloadSha256, models, rejectedModels: raw.rejectedModels as number };
}

export async function readSnapshots(directory: string): Promise<{
  snapshots: StoredSnapshot[]; warnings: PricingStatus["warnings"];
}> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    return { snapshots: [], warnings: (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : ["cache-unavailable"] };
  }
  const snapshots: StoredSnapshot[] = [], warnings: PricingStatus["warnings"] = [];
  for (const name of names.sort()) {
    if (!/^(?:models\.dev|litellm|reviewed)-[\dT-]+-[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const path = join(directory, name), info = await lstat(path);
      if (!info.isFile() || info.size > MAX_PAYLOAD_BYTES) throw new Error("Invalid pricing snapshot file.");
      const envelope = record(JSON.parse(await readFile(path, "utf8")));
      if (!envelope || typeof envelope.checksum !== "string" ||
          sha256(JSON.stringify(envelope.snapshot)) !== envelope.checksum || !name.endsWith(`-${envelope.checksum}.json`)) {
        throw new Error("Pricing snapshot checksum mismatch.");
      }
      snapshots.push(validateSnapshot(envelope.snapshot));
    } catch { if (!warnings.includes("invalid-snapshot")) warnings.push("invalid-snapshot"); }
  }
  snapshots.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.payloadSha256.localeCompare(b.payloadSha256));
  return { snapshots, warnings };
}

/** Publish complete files atomically, without replacing an existing snapshot (also safe across processes). */
export async function saveSnapshot(directory: string, snapshot: StoredSnapshot): Promise<void> {
  const clean = validateSnapshot(snapshot);
  const checksum = sha256(JSON.stringify(clean));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `${clean.source}-${clean.fetchedAt.replace(/[:.Z]/g, "")}-${checksum}.json`;
  const temporary = join(directory, `.pending-${randomUUID()}`);
  try {
    await writeFile(temporary, `${JSON.stringify({ checksum, snapshot: clean })}\n`, { flag: "wx", mode: 0o600 });
    try { await link(temporary, join(directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(temporary).catch(() => undefined); }
}
