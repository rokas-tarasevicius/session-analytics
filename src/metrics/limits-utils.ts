import { createHash } from "node:crypto";
import { timestampMilliseconds } from "../public/timestamps.js";

export const MIN_REQUESTS = 3;
export const MIN_INPUT_TOKENS = 1_000;
export const FRESHNESS_MINUTES = 15;
export const MIN_OBSERVED_MINUTES = 5;
export const MAX_OBSERVATIONS = 20_000;

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
export function oneOf<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === "string" && values.includes(value as T) ? value as T : null;
}
export function timestamp(value: unknown): string | null {
  const milliseconds = typeof value === "number" && Number.isFinite(value)
    ? value < 100_000_000_000 ? value * 1000 : value
    : timestampMilliseconds(value);
  return Number.isFinite(milliseconds) && milliseconds >= 946_684_800_000 && milliseconds < 4_102_444_800_000
    ? new Date(milliseconds).toISOString() : null;
}
export function key(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}
export function percent(value: unknown): number | null {
  const number = nonnegative(value);
  return number !== null && number <= 100 ? number : null;
}
/** Keep endpoints and uniformly spaced points; statistics always use the full retained evidence. */
export function sample<T>(values: T[], maximum: number): T[] {
  if (values.length <= maximum) return values;
  return Array.from({ length: maximum }, (_, index) => values[Math.round(index * (values.length - 1) / (maximum - 1))]!);
}
