// Independent filesystem/remote attribution oracle. No analyzer imports.
// Raw values returned by this module are PRIVATE, in-memory evidence only.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

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

function textFile(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function realOrResolved(path: string): string {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? resolve(path) : join(realOrResolved(parent), path.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
  }
}

function remotesFromConfig(contents: string): Map<string, string> {
  const remotes = new Map<string, string>();
  let section: string | null = null;
  for (const line of contents.split(/\r?\n/)) {
    const header = /^\s*\[\s*remote\s+"((?:[^"\\]|\\.)*)"\s*\]/i.exec(line);
    if (header) { section = header[1]!.replace(/\\"/g, '"'); continue; }
    if (/^\s*\[/.test(line)) { section = null; continue; }
    if (!section) continue;
    const entry = /^\s*url\s*=\s*(.*?)\s*$/i.exec(line);
    if (!entry || remotes.has(section)) continue;
    let url = entry[1]!;
    if (url.startsWith('"') && url.endsWith('"')) url = url.slice(1, -1).replace(/\\(["\\])/g, '$1');
    else url = url.replace(/\s[;#].*$/, '').trim();
    remotes.set(section, url);
  }
  return remotes;
}

export interface RepositoryEvidence {
  /** Raw private fields: do not serialize these to reports. */
  identity: string;
  remote: string | null;
  root: string | null;
  commonDir: string | null;
  confidence: 'filesystem' | 'metadata' | 'unresolved';
  directoryExists: boolean;
  metadataRemote: string | null;
  metadataDisagrees: boolean;
  evidence: string[];
}

/** Last-resort bucket only after Git, remote and registered ownership checks. */
export function localDirectoryAttribution(cwd: string, git: RepositoryEvidence): { root: string; route: 'ephemeral' | 'local-directory' } {
  // Existing paths canonicalize; deleted CWDs keep their recorded spelling.
  // The product's fallback contract recognizes the current OS temp root and
  // literal /tmp, not every missing descendant of a symlinked ancestor.
  let path = resolve(cwd); try { path = realpathSync(cwd); } catch { /* absent directory */ }
  const inside = (root: string) => path === root || path.startsWith(root.replace(/\/$/, '') + '/');
  const temporary = !git.root && !git.remote && (
    path.startsWith('/private/var/folders/') && path.includes('/T/') ||
    inside(realOrResolved(tmpdir())) || inside('/tmp'));
  return { root: temporary ? '/private/var/folders/session-analytics-ephemeral' : path, route: temporary ? 'ephemeral' : 'local-directory' };
}

/** Resolves nearest Git root, following .git and commondir pointers independently. */
export function resolveRepository(cwd: string | null | undefined, metadataRemote?: string | null): RepositoryEvidence {
  const metadata = canonicalizeRemote(metadataRemote);
  const directoryExists = !!cwd && existsSync(cwd);
  const result: RepositoryEvidence = {
    identity: metadata ? `remote:${metadata}` : `directory:${cwd ? realOrResolved(resolve(cwd)) : 'unknown'}`,
    remote: metadata, root: null, commonDir: null,
    confidence: metadata ? 'metadata' : 'unresolved', directoryExists,
    metadataRemote: metadata, metadataDisagrees: false,
    evidence: [directoryExists ? 'cwd_exists' : 'cwd_missing', ...(metadata ? ['metadata_remote'] : [])],
  };
  if (!cwd || !isAbsolute(cwd)) { result.evidence.push('no_absolute_cwd'); return result; }
  let cursor = realOrResolved(cwd);
  try { if (statSync(cursor).isFile()) cursor = dirname(cursor); } catch { /* preserve missing cwd, walk to existing parents */ }
  while (true) {
    const marker = join(cursor, '.git');
    let gitDir: string | null = null;
    if (existsSync(marker)) {
      try {
        if (statSync(marker).isDirectory()) gitDir = realOrResolved(marker);
        else {
          const pointer = /^gitdir:\s*(.+?)\s*$/im.exec(textFile(marker) ?? '');
          if (pointer) { gitDir = realOrResolved(resolve(cursor, pointer[1]!)); result.evidence.push('gitfile'); }
        }
      } catch { result.evidence.push('unreadable_git_marker'); }
      // A broken inner repository must not inherit an unrelated enclosing repo.
      if (!gitDir) { result.root = cursor; result.evidence.push('broken_git_marker'); return result; }
    } else if (existsSync(join(cursor, 'HEAD')) && existsSync(join(cursor, 'objects')) && existsSync(join(cursor, 'refs')) && existsSync(join(cursor, 'config'))) {
      gitDir = cursor;
      result.evidence.push('bare_repository');
    }
    if (gitDir) {
      const commonPointer = textFile(join(gitDir, 'commondir'))?.trim();
      const commonDir = commonPointer ? realOrResolved(resolve(gitDir, commonPointer)) : gitDir;
      if (commonPointer) result.evidence.push('commondir');
      const config = textFile(join(commonDir, 'config'));
      const remotes = remotesFromConfig(config ?? '');
      const selected = remotes.get('origin') ?? (remotes.size === 1 ? [...remotes.values()][0] : undefined);
      const remote = canonicalizeRemote(selected);
      result.root = cursor;
      result.commonDir = commonDir;
      result.metadataDisagrees = !!metadata && !!remote && metadata !== remote;
      if (!directoryExists && metadata && result.metadataDisagrees) {
        result.evidence.push('missing_cwd_metadata_preferred_over_ancestor');
        return result;
      }
      if (remote) {
        result.identity = `remote:${remote}`;
        result.remote = remote;
        result.confidence = 'filesystem';
        result.evidence.push('git_remote');
      } else if (!metadata) {
        result.identity = `git:${commonDir}`;
        result.remote = null;
        result.confidence = config === null ? 'unresolved' : 'filesystem';
        result.evidence.push(config === null ? 'git_config_missing' : 'git_without_remote');
      } else result.evidence.push('git_metadata_fallback');
      return result;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  result.evidence.push('git_not_found');
  return result;
}

if (process.argv[1]?.endsWith('/git-oracle.ts')) {
  const result = resolveRepository(process.argv[2], process.argv[3]);
  process.stdout.write(JSON.stringify({ identityHash: hash(result.identity), confidence: result.confidence, directoryExists: result.directoryExists, metadataDisagrees: result.metadataDisagrees, evidence: result.evidence }) + '\n');
}
