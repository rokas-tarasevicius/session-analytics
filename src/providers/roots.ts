import { stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

/** Default stores are optional. Keep every other failure for the reader to report. */
export async function providerRoots(explicit: string | undefined, defaults: string[]): Promise<string[]> {
  if (explicit !== undefined) return [explicit];
  const present = await Promise.all(defaults.map(async (root) => {
    try { await stat(root); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  }));
  return defaults.filter((_root, index) => present[index]);
}

/** Private discovery input, injectable without changing the host's platform or environment. */
export function cursorDatabaseDefault({ home, environment, platform = process.platform }: {
  home: string;
  environment: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string {
  if (platform === "win32") return win32.join(environment["APPDATA"] || win32.join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  const config = platform === "darwin" ? posix.join(home, "Library", "Application Support") : environment["XDG_CONFIG_HOME"] || posix.join(home, ".config");
  return posix.join(config, "Cursor", "User", "globalStorage", "state.vscdb");
}
