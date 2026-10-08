import { normalizeTimestamp } from "../public/timestamps.js";

/** Strict metadata identifiers, never arbitrary text or paths. */
export function safeName(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value : null;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function timestamp(value: unknown): string | null {
  return normalizeTimestamp(value);
}
