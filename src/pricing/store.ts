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

type RateTable = SourceSnapshot["models"];

function validateModels(value: unknown, source: SourceSnapshot["source"]): RateTable {
  const input = record(value);
  if (!input || !Object.keys(input).length || Object.keys(input).length > MAX_MODELS) throw new Error("Invalid pricing models.");
  const models: RateTable = Object.create(null);
  for (const model of Object.keys(input).sort()) {
    if (!validModelId(model)) throw new Error("Invalid pricing model.");
    models[model] = validateRate(input[model], SOURCE_URLS[source]);
  }
  return models;
}

function validateSnapshot(value: unknown, validatedModels?: RateTable): StoredSnapshot {
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
  const source = raw.source;
  if (raw.sourceUrl !== SOURCE_URLS[source] || !Number.isSafeInteger(raw.rejectedModels) ||
      (raw.rejectedModels as number) < 0) throw new Error("Invalid pricing snapshot.");
  const models = validatedModels ?? validateModels(raw.models, source);
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
  const tables = new Map<string, RateTable>();
  const blobs = new Map<string, RateTable>();
  const intern = (models: RateTable): RateTable => {
    const hash = sha256(JSON.stringify(models));
    const existing = tables.get(hash);
    if (existing) return existing;
    tables.set(hash, models);
    return models;
  };
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
      let snapshot: StoredSnapshot;
      if (envelope.storageVersion === 2) {
        const descriptor = record(envelope.snapshot);
        const hash = descriptor?.modelsSha256, source = descriptor?.source;
        if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) ||
            (source !== "models.dev" && source !== "litellm")) throw new Error("Invalid rate table reference.");
        // Scope the validated blob cache by source: trusted URLs must not cross source boundaries.
        const key = `${source}:${hash}`;
        let models = blobs.get(key);
        if (!models) {
          const path = join(directory, `rates-${hash}.json`), info = await lstat(path);
          if (!info.isFile() || info.size > MAX_PAYLOAD_BYTES) throw new Error("Invalid rate table file.");
          const payload = await readFile(path, "utf8");
          if (sha256(payload) !== hash) throw new Error("Rate table checksum mismatch.");
          models = intern(validateModels(JSON.parse(payload), source));
          blobs.set(key, models);
        }
        snapshot = validateSnapshot({ ...descriptor, models }, models);
      } else if (envelope.storageVersion === undefined || envelope.storageVersion === 1) {
        snapshot = validateSnapshot(envelope.snapshot);
        if (snapshot.source !== "reviewed") {
          // Old inline snapshots marked derived 1h prices globally, without identifying the tier.
          // Preserve the warning conservatively; their numerical prices and observation hashes stay intact.
          for (const rate of Object.values(snapshot.models)) {
            if (!rate.assumptions?.includes("anthropic-cache-1h-2x")) continue;
            for (const tier of rate.contextTiers ?? []) {
              if (tier.cacheWrite1hPerMillion !== undefined && tier.assumptions === undefined) tier.assumptions = ["anthropic-cache-1h-2x"];
            }
          }
          snapshot.models = intern(snapshot.models);
        }
      } else throw new Error("Invalid storage version.");
      snapshots.push(snapshot);
    } catch { if (!warnings.includes("invalid-snapshot")) warnings.push("invalid-snapshot"); }
  }
  snapshots.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.payloadSha256.localeCompare(b.payloadSha256));
  return { snapshots, warnings };
}

/** Publish complete files atomically, without replacing an existing snapshot (also safe across processes). */
export async function saveSnapshot(directory: string, snapshot: StoredSnapshot): Promise<void> {
  const clean = validateSnapshot(snapshot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let descriptor: unknown = clean;
  if (clean.source !== "reviewed") {
    const payload = JSON.stringify(clean.models);
    const modelsSha256 = sha256(payload);
    await publish(directory, `rates-${modelsSha256}.json`, payload);
    const { models: _, ...metadata } = clean;
    descriptor = { ...metadata, modelsSha256 };
  }
  const checksum = sha256(JSON.stringify(descriptor));
  const name = `${clean.source}-${clean.fetchedAt.replace(/[:.Z]/g, "")}-${checksum}.json`;
  await publish(directory, name, `${JSON.stringify({ ...(clean.source === "reviewed" ? {} : { storageVersion: 2 }), checksum, snapshot: descriptor })}\n`);
}

async function publish(directory: string, name: string, payload: string): Promise<void> {
  const temporary = join(directory, `.pending-${randomUUID()}`);
  try {
    await writeFile(temporary, payload, { flag: "wx", mode: 0o600 });
    try { await link(temporary, join(directory, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(join(directory, name), "utf8");
      if (existing !== payload) {
        // Reviewed envelopes predate the optional storage-version marker. Keep either valid spelling intact.
        const previous = name.startsWith("reviewed-") ? record(JSON.parse(existing)) : undefined;
        const next = previous ? record(JSON.parse(payload)) : undefined;
        if (!previous || (previous.storageVersion !== undefined && previous.storageVersion !== 1) ||
            previous.checksum !== next?.checksum || sha256(JSON.stringify(previous.snapshot)) !== next?.checksum) {
          throw new Error("Existing pricing evidence is damaged.");
        }
      }
    }
  } finally { await unlink(temporary).catch(() => undefined); }
}
