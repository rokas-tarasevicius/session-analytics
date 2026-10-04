/** Independent raw Conductor attribution inventory. Never serialize the private maps. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from '../shared/sqlite.ts';
import { fileURLToPath } from 'node:url';

export interface GitDirectory {
  worktreeRoot: string;
  commonDirectory: string;
  mainRoot: string;
  origin: string | null;
  remoteIdentity: string | null;
}

export interface RepoRow {
  id: string;
  name: string;
  root_path: string;
  remote_url: string | null;
  remote: string | null;
  created_at: string;
  updated_at: string;
  git: GitDirectory | null;
  remoteIdentity: string | null;
}

export interface WorkspaceRow {
  local_id: string;
  id: string;
  repository_id: string;
  directory_name: string;
  secondary_directory_name: string | null;
  workspace_path: string | null;
  linked_directory_paths: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  candidatePaths: string[];
}

export interface SessionRow {
  id: string;
  claude_session_id: string | null;
  agent_type: string;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
  last_user_message_at: string | null;
}

export interface ConductorData {
  repos: RepoRow[];
  workspaces: WorkspaceRow[];
  sessions: SessionRow[];
  reposById: Map<string, RepoRow>;
  workspacesById: Map<string, WorkspaceRow>;
  sessionsById: Map<string, SessionRow>;
  sessionsByProviderId: Map<string, SessionRow[]>;
}

export const hashId = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12);

/** Preserve owner/project case: arbitrary Git hosts can have case-sensitive paths. */
export function canonicalRemote(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  try {
    const match = text.match(/^(?:[^/@\s]+@)?([^/:\s]+):(.+)$/);
    const url = new URL(match && !text.includes('://') ? `ssh://${match[1]}/${match[2]}` : text);
    if (url.protocol === 'file:') return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}/${path}`;
  } catch {
    return null;
  }
}

const canonicalPath = (value: string): string => {
  try { return realpathSync(value); } catch { return resolve(value); }
};

/** Read nearest actual .git marker, following gitdir/commondir without invoking analyzer code. */
export function resolveGitDirectory(input: string): GitDirectory | null {
  if (!existsSync(input)) return null;
  let current = canonicalPath(input);
  try { if (!statSync(current).isDirectory()) current = dirname(current); } catch { return null; }
  for (;;) {
    const marker = join(current, '.git');
    if (existsSync(marker)) {
      try {
        let gitDirectory = marker;
        if (!statSync(marker).isDirectory()) {
          const target = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(marker, 'utf8'))?.[1];
          if (!target) return null;
          gitDirectory = resolve(current, target);
        }
        const commonPointer = join(gitDirectory, 'commondir');
        const commonDirectory = canonicalPath(existsSync(commonPointer)
          ? resolve(gitDirectory, readFileSync(commonPointer, 'utf8').trim()) : gitDirectory);
        let origin: string | null = null;
        let section = '';
        try {
          for (const line of readFileSync(join(commonDirectory, 'config'), 'utf8').split(/\r?\n/)) {
            const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
            if (header) { section = header[1]!; continue; }
            if (/^remote\s+"origin"$/i.test(section)) {
              const entry = /^\s*url\s*=\s*(.*?)\s*$/.exec(line);
              if (entry) origin = entry[1]!;
            }
          }
        } catch { /* Missing config is valid evidence of a damaged/unavailable Git root. */ }
        return {
          worktreeRoot: current,
          commonDirectory,
          mainRoot: basename(commonDirectory) === '.git' ? dirname(commonDirectory) : current,
          origin,
          remoteIdentity: canonicalRemote(origin),
        };
      } catch { return null; }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function linkedPaths(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && isAbsolute(item)) : [];
  } catch { return []; }
}

export function loadConductor(home: string): ConductorData {
  const file = join(home, 'Library/Application Support/com.conductor.app/conductor.db');
  if (!existsSync(file)) return { repos: [], workspaces: [], sessions: [], reposById: new Map(), workspacesById: new Map(), sessionsById: new Map(), sessionsByProviderId: new Map() };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const repos = db.prepare('SELECT id, name, root_path, remote_url, remote, created_at, updated_at FROM repos').all() as unknown as RepoRow[];
    for (const repo of repos) {
      repo.git = resolveGitDirectory(repo.root_path);
      repo.remoteIdentity = repo.git?.remoteIdentity ?? canonicalRemote(repo.remote_url);
    }
    const reposById = new Map(repos.map(repo => [repo.id, repo]));
    const workspaces = db.prepare('SELECT local_id, id, repository_id, directory_name, secondary_directory_name, workspace_path, linked_directory_paths, state, created_at, updated_at FROM workspaces').all() as unknown as WorkspaceRow[];
    for (const workspace of workspaces) {
      const repo = reposById.get(workspace.repository_id);
      const candidates = [workspace.workspace_path, ...linkedPaths(workspace.linked_directory_paths)];
      if (repo) {
        for (const repoDirectory of new Set([repo.name, basename(repo.root_path)])) {
          for (const workspaceDirectory of [workspace.directory_name, workspace.secondary_directory_name]) {
            if (workspaceDirectory) candidates.push(join(home, 'conductor/workspaces', repoDirectory, workspaceDirectory));
          }
        }
      }
      workspace.candidatePaths = [...new Set(candidates.filter((path): path is string => !!path && isAbsolute(path)))];
    }
    const sessions = db.prepare('SELECT id, claude_session_id, agent_type, workspace_id, created_at, updated_at, last_user_message_at FROM sessions').all() as unknown as SessionRow[];
    const workspacesById = new Map<string, WorkspaceRow>();
    for (const workspace of workspaces) {
      workspacesById.set(workspace.local_id, workspace);
      if (workspace.id) workspacesById.set(workspace.id, workspace);
    }
    const sessionsById = new Map(sessions.map(session => [session.id, session]));
    const sessionsByProviderId = new Map<string, SessionRow[]>();
    for (const session of sessions) {
      if (!session.claude_session_id) continue;
      const rows = sessionsByProviderId.get(session.claude_session_id) ?? [];
      rows.push(session);
      sessionsByProviderId.set(session.claude_session_id, rows);
    }
    return { repos, workspaces, sessions, reposById, workspacesById, sessionsById, sessionsByProviderId };
  } finally { db.close(); }
}

export function conductorEvidence(data: ConductorData): Record<string, unknown> {
  const countBy = <T>(items: T[], key: (row: T) => string): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const item of items) { const value = key(item); result[value] = (result[value] ?? 0) + 1; }
    return result;
  };
  const workspaces = data.workspaces.map(workspace => {
    const repo = data.reposById.get(workspace.repository_id);
    const existingPaths = workspace.candidatePaths.filter(existsSync);
    const gitRoots = existingPaths.map(resolveGitDirectory).filter((git): git is GitDirectory => !!git);
    return {
      workspaceKey: hashId(workspace.local_id),
      repoKey: hashId(workspace.repository_id),
      state: workspace.state === 'archived' ? 'archived' : workspace.state === 'ready' ? 'ready' : 'other',
      candidatePathCount: workspace.candidatePaths.length,
      existingPathCount: existingPaths.length,
      gitRootCount: gitRoots.length,
      sameCommonDirectory: gitRoots.filter(git => git.commonDirectory === repo?.git?.commonDirectory).length,
      differentCommonDirectory: gitRoots.filter(git => git.commonDirectory !== repo?.git?.commonDirectory).length,
      sameRemote: gitRoots.filter(git => git.remoteIdentity && git.remoteIdentity === repo?.remoteIdentity).length,
      missingRepository: !repo,
    };
  });
  const orphanSessions = data.sessions.filter(session => !session.workspace_id || !data.workspacesById.has(session.workspace_id));
  const duplicateProviderRows = [...data.sessionsByProviderId.values()].filter(rows => rows.length > 1);
  const pathWorkspaces = new Map<string, WorkspaceRow[]>();
  for (const workspace of data.workspaces) {
    for (const path of workspace.candidatePaths) {
      const rows = pathWorkspaces.get(path) ?? [];
      rows.push(workspace);
      pathWorkspaces.set(path, rows);
    }
  }
  const collidingPaths = [...pathWorkspaces.values()].filter(rows => rows.length > 1);
  const repositoryRemoteGroups = new Map<string, string[]>();
  for (const repo of data.repos) {
    if (!repo.remoteIdentity) continue;
    const values = repositoryRemoteGroups.get(repo.remoteIdentity) ?? [];
    values.push(hashId(repo.id));
    repositoryRemoteGroups.set(repo.remoteIdentity, values);
  }
  return {
    schemaVersion: 1,
    counts: {
      repositories: data.repos.length,
      existingRepositoryRoots: data.repos.filter(repo => existsSync(repo.root_path)).length,
      repositoriesWithGit: data.repos.filter(repo => !!repo.git).length,
      changedConfiguredOrigin: data.repos.filter(repo => repo.git?.remoteIdentity && canonicalRemote(repo.remote_url) !== repo.git.remoteIdentity).length,
      workspaces: data.workspaces.length,
      workspaceStates: countBy(workspaces, workspace => workspace.state),
      explicitWorkspacePaths: data.workspaces.filter(workspace => !!workspace.workspace_path).length,
      secondaryDirectoryNames: data.workspaces.filter(workspace => !!workspace.secondary_directory_name).length,
      linkedDirectoryPaths: data.workspaces.filter(workspace => linkedPaths(workspace.linked_directory_paths).length > 0).length,
      existingExplicitWorkspacePaths: data.workspaces.filter(workspace => workspace.workspace_path && existsSync(workspace.workspace_path)).length,
      workspacesWithExistingPaths: workspaces.filter(workspace => workspace.existingPathCount > 0).length,
      workspacesWithGit: workspaces.filter(workspace => workspace.gitRootCount > 0).length,
      workspacePathCollisions: collidingPaths.length,
      crossRepositoryWorkspacePathCollisions: collidingPaths.filter(rows => new Set(rows.map(row => row.repository_id)).size > 1).length,
      symlinkCandidatePaths: [...pathWorkspaces.keys()].filter(path => existsSync(path) && canonicalPath(path) !== path).length,
      sessions: data.sessions.length,
      sessionsByAgent: countBy(data.sessions, session => ['claude', 'codex', 'cursor'].includes(session.agent_type) ? session.agent_type : 'other'),
      providerIds: data.sessions.filter(session => !!session.claude_session_id).length,
      missingWorkspaceSessions: orphanSessions.length,
      duplicateProviderIds: duplicateProviderRows.length,
      sameRemoteRepositoryGroups: [...repositoryRemoteGroups.values()].filter(keys => keys.length > 1).length,
    },
    workspaces,
    orphanSessions: orphanSessions.map(session => ({ sessionKey: hashId(session.id), agentType: ['claude', 'codex', 'cursor'].includes(session.agent_type) ? session.agent_type : 'other', hasProviderId: !!session.claude_session_id })),
    duplicateProviderIds: duplicateProviderRows.map(rows => ({ sessionKeys: rows.map(session => hashId(session.id)), repositoryCount: new Set(rows.map(session => session.workspace_id && data.workspacesById.get(session.workspace_id)?.repository_id).filter(Boolean)).size })),
    sameRemoteRepositories: [...repositoryRemoteGroups.values()].filter(keys => keys.length > 1),
    changedConfiguredOrigins: data.repos.filter(repo => repo.git?.remoteIdentity && canonicalRemote(repo.remote_url) !== repo.git.remoteIdentity).map(repo => ({
      repoKey: hashId(repo.id),
      configuredRemoteKey: repo.remote_url ? hashId(canonicalRemote(repo.remote_url) ?? repo.remote_url) : null,
      currentRemoteKey: repo.git?.remoteIdentity ? hashId(repo.git.remoteIdentity) : null,
      workspaceCount: data.workspaces.filter(workspace => workspace.repository_id === repo.id).length,
      sessionKeys: data.sessions.filter(session => session.workspace_id && data.workspacesById.get(session.workspace_id)?.repository_id === repo.id).map(session => hashId(session.id)),
    })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const evidence = conductorEvidence(loadConductor(homedir()));
    const output = process.argv[2];
    if (output) writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence.counts, null, 2));
  } catch { console.error('Conductor oracle failed; no local error text emitted.'); process.exitCode = 1; }
}
