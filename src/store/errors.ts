/** Only fixed error codes/messages may cross the analysis process boundary. */
const messages = {
  "index-unavailable": "The local index is unavailable; use --no-index or run index rebuild.",
  "index-busy": "The local index is busy; another ingest or maintenance command is running.",
  "index-incompatible": "The local index was created by a newer version; upgrade or use --no-index.",
  "index-integrity": "The local index failed an integrity check; run index rebuild.",
  "index-coordination": "The local index writer coordination is damaged; run index rebuild or use --no-index.",
  "runtime-unsupported": "Session analysis needs Node.js 24 or newer with node:sqlite.",
  "install-incomplete": "This session-analytics installation is incomplete: a module it runs is missing. Reinstall it.",
  "install-typescript": "Node.js cannot run TypeScript from node_modules; install the published session-analytics package instead of the source.",
} as const;

const workerFailures: ReadonlyArray<readonly [RegExp, keyof typeof messages]> = [
  [/\bERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING\b/, "install-typescript"],
  [/\bERR_UNKNOWN_BUILTIN_MODULE\b|\bERR_UNKNOWN_FILE_EXTENSION\b/, "runtime-unsupported"],
  [/\b(?:ERR_)?MODULE_NOT_FOUND\b/, "install-incomplete"],
];

export function indexErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  return Object.entries(messages).find(([, value]) => value === message)?.[0] ?? null;
}

export function indexErrorMessage(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(messages, code) ? messages[code as keyof typeof messages] : null;
}

/** Why a worker exited, as a fixed message: its own code on stdout, else Node's error code on stderr. Raw output never crosses. */
export function workerExitMessage(output: string, stderr: string): string | null {
  let code: unknown = null;
  try { code = (JSON.parse(output) as { analysisError?: unknown }).analysisError; } catch { /* Only a fixed code is read. */ }
  return indexErrorMessage(code) ?? indexErrorMessage(workerFailures.find(([pattern]) => pattern.test(stderr))?.[1]);
}
