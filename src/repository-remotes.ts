import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";

/** Remote equivalence uses host + full namespace, never only the repo basename. */
export function canonicalizeRemote(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const value = raw.trim().replace(/^git\+/, '');
  let host: string;
  let path: string;
  let port = '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === 'file:') return `file:${url.hostname ? `//${url.hostname.toLowerCase()}` : ''}${resolve(decodeURIComponent(url.pathname)).replace(/\/+$/, '')}`;
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      host = url.hostname.toLowerCase();
      path = url.pathname;
      if (url.port && !((url.protocol === 'ssh:' && url.port === '22') || (url.protocol === 'git:' && url.port === '9418'))) port = `:${url.port}`;
    } catch { return null; }
  } else {
    const scp = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/.exec(value);
    if (scp) {
      host = scp[1]!.toLowerCase();
      path = scp[2]!;
    } else if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
      return `file:${resolve(value).replace(/\/+$/, '')}`;
    } else return null;
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!host || !path) return null;
  // GitHub/Bitbucket namespaces are case insensitive; arbitrary SSH hosts needn't be.
  if (host === 'github.com' || host === 'bitbucket.org') path = path.toLowerCase();
  return `${host}${port}/${path}`;
}

/** Private Git config input; never project URLs to public output. */
export async function repositoryRemoteAtRoot(root: string): Promise<string | null> {
  const config = await readFile(join(root, ".git", "config"), "utf8")
    .catch(() => readFile(join(root, "config"), "utf8")).catch(() => null);
  let origin = false;
  for (const line of (config ?? "").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) origin = /^\s*\[remote\s+"origin"\]/i.test(line);
    if (origin) {
      const match = /^\s*url\s*=\s*(.*?)\s*$/.exec(line);
      if (match) {
        const value = match[1]!.replace(/^"|"$/g, "");
        return canonicalizeRemote(value) ? value : null;
      }
    }
  }
  return null;
}
