/** Public model IDs are bounded identifiers, never paths, URLs or free-form text.
 * Reject the whole value rather than extracting a plausible ID from private text.
 * Unknown but well-formed IDs remain visible (and unpriced without a rate).
 */
export function publicModel(value: unknown): string {
  return typeof value === "string" && value.length <= 96 &&
    /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(value)
    ? value : "<unknown>";
}
