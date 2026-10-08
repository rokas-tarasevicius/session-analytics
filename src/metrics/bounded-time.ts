import { timestampMilliseconds } from "../public/timestamps.js";

/** Normalizes ISO strings and epoch seconds or milliseconds; instants outside 2000–2099 are unavailable. */
export function boundedTimestamp(value: unknown): string | null {
  const milliseconds = typeof value === "number" && Number.isFinite(value)
    ? value < 100_000_000_000 ? value * 1000 : value
    : timestampMilliseconds(value);
  return Number.isFinite(milliseconds) && milliseconds >= 946_684_800_000 && milliseconds < 4_102_444_800_000
    ? new Date(milliseconds).toISOString() : null;
}
