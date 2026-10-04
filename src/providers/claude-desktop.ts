import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";

/** A Desktop container metadata file is identity evidence, never a transcript. */
export function desktopMetadataPath(mainPath: string): string | null {
  const projects = dirname(dirname(mainPath));
  const profile = dirname(projects), container = dirname(profile);
  if (basename(projects) !== "projects" || basename(profile) !== ".claude" ||
      !/^local_[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(basename(container)) ||
      basename(dirname(dirname(dirname(container)))) !== "local-agent-mode-sessions") return null;
  return `${container}.json`;
}

export async function desktopIdentityMatches(mainPath: string, providerSessionId: string | null): Promise<boolean> {
  const metadata = desktopMetadataPath(mainPath);
  if (!metadata || !providerSessionId) return false;
  try {
    if ((await stat(metadata)).size > 1024 * 1024) return false;
    const record: unknown = JSON.parse(await readFile(metadata, "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const identity = record as Record<string, unknown>;
    return identity["cliSessionId"] === providerSessionId &&
      identity["sessionId"] === basename(metadata).slice(0, -5);
  } catch { return false; }
}
