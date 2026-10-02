/** Only fixed error codes/messages may cross the analysis process boundary. */
const messages = {
  "index-unavailable": "The local index is unavailable; use --no-index or run index rebuild.",
  "index-busy": "The local index is busy; another ingest or maintenance command is running.",
  "index-incompatible": "The local index was created by a newer version; upgrade or use --no-index.",
  "index-integrity": "The local index failed an integrity check; run index rebuild.",
} as const;

export function indexErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  return Object.entries(messages).find(([, value]) => value === message)?.[0] ?? null;
}

export function indexErrorMessage(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(messages, code) ? messages[code as keyof typeof messages] : null;
}
