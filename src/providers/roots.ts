import { lstat, stat } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";

/** Default stores are optional. Keep every other failure for the reader to report. */
export async function providerRoots(explicit: string | undefined, defaults: string[]): Promise<string[]> {
  if (explicit !== undefined) return [explicit];
  const present = await Promise.all(defaults.map(async (root) => {
    try { await stat(root); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      // ENOENT can mean a configured link (including a profile ancestor) lost
      // its target. Keep that source; a healthy link with no store is optional.
      for (let entry = root; ; entry = dirname(entry)) {
        try {
          if (!(await lstat(entry)).isSymbolicLink()) return false;
          try { await stat(entry); return false; } catch { return true; }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
        }
        if (dirname(entry) === entry) return false;
      }
    }
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
