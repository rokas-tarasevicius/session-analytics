import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { serviceId } from "../brand.ts";
import type { ProfileConfig } from "./limits-cache-types.ts";
import { nonnegative, oneOf, record } from "./limits-utils.ts";

export function defaultDataDirectory(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", serviceId)
    : join(process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"), serviceId);
}

export async function optionalJson(file: string, warnings: string[], description: string, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) throw new Error("bounded input");
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (record(error)?.["code"] !== "ENOENT") warnings.push(`${description} could not be read within the supported format and size limit.`);
    return null;
  }
}

export async function readLimitsConfig(dataDirectory: string, warnings: string[]): Promise<ProfileConfig[]> {
  const root = record(await optionalJson(join(dataDirectory, "config.json"), warnings, "Optional limits configuration", 1024 * 1024));
  const section = record(root?.["limitsCache"]);
  if (!section) return [];
  const entries = section["profiles"];
  if (!Array.isArray(entries) || entries.length > 100) {
    warnings.push("Optional limits configuration must contain at most 100 profile settings.");
    return [];
  }
  const result: ProfileConfig[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = record(raw);
    const provider = oneOf(entry?.["provider"], ["claude", "codex"] as const);
    const profile = nonnegative(entry?.["profile"]);
    const profileKey = entry?.["profileKey"];
    const label = entry?.["label"];
    const price = entry?.["monthlyPriceUsd"];
    const validTarget = profileKey !== undefined
      ? typeof profileKey === "string" && /^profile-[a-f0-9]{20}$/.test(profileKey)
      : profile !== null && Number.isInteger(profile) && profile > 0;
    if (!entry || !provider || !validTarget ||
      label !== undefined && !(typeof label === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(label)) ||
      price !== undefined && (nonnegative(price) === null || (price as number) > 1_000_000)) {
      warnings.push("An invalid limits profile setting was ignored; labels must be short display names and monthly prices non-negative USD amounts.");
      continue;
    }
    const identity = `${provider}:${profileKey ?? profile}`;
    if (seen.has(identity)) {
      warnings.push("A duplicate limits profile setting was ignored.");
      continue;
    }
    seen.add(identity);
    result.push({ provider, ...(typeof profileKey === "string" ? { profileKey } : { profile: profile! }),
      ...(typeof label === "string" ? { label } : {}), ...(typeof price === "number" ? { monthlyPriceUsd: price } : {}) });
  }
  return result;
}
