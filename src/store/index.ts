import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AnalyzeOptions, RateCard, SessionAnalytics, SessionDatabaseRow } from "../types.ts";
import { openIndexDatabase, type IndexConnection, type IndexScanStats } from "./database.ts";
import { fingerprint, keyedHash, stillMatches, type FileFingerprint } from "./fingerprint.ts";
import { readCodexLedger, type CodexLedgerEvidence } from "./codex-ledger.ts";
import { projectSession } from "./projection.ts";

interface StoredSession {
  identity_key: string;
  signature: string;
  payload: string;
  payload_mac: string;
  source_keys: string;
  root_key: string;
  remote_key: string;
  owned_counters: string;
  last_event_at: string;
  source_deleted: number;
}
interface StoredEvidence { fingerprint: string; ledger: string | null; ledger_mac: string | null }
export interface CounterOwner { path: string; timestamp: string; modelFallback: string | null }

function normalizeRemote(value: string): string {
  return value.trim().replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
}

/** Retention comparisons use UTC instants; provider timestamps may include an offset. */
export function lastActivityAt(session: Pick<SessionAnalytics, "lastEventAt" | "updatedAt" | "createdAt">): string {
  for (const value of [session.lastEventAt, session.updatedAt, session.createdAt]) {
    const timestamp = value ? Date.parse(value) : NaN;
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return ""; // Unknown activity time is never treated as proof that a session is old.
}

/** One writer transaction per scan. Failed scans roll back facts, fingerprints, and deletion marks together. */
export class IndexScan {
  private connection: IndexConnection;
  private scope: string;
  private revision: string;
  private started = performance.now();
  private fingerprints = new Map<string, { path: string; value: FileFingerprint }>();
  private sessions = new Map<string, StoredSession>();
  private seen = new Set<string>();
  private pending = new Map<string, string[]>();
  private retiredCounters: Set<string>;
  private ledgerEvidence = new Map<string, CodexLedgerEvidence>();
  private dependencies = new Map<string, string>();
  private ambiguousCounters = false;
  private repositories = new Map<string, { root: string; remote: string }>();
  private committed = false;
  private pruneBefore: string;
  readonly stats: IndexScanStats = {
    fingerprintedFiles: 0, parsedSessions: 0, reusedSessions: 0, retainedSessions: 0, deferredSessions: 0,
    ledgerReads: 0, ledgerHits: 0, ledgerAppends: 0, elapsedMilliseconds: 0,
  };

  private constructor(connection: IndexConnection, scope: string, revision: string) {
    this.connection = connection; this.scope = scope; this.revision = revision;
    connection.database.exec("BEGIN IMMEDIATE");
    const revisionKey = `parser:${scope}`;
    if (connection.database.prepare("SELECT value FROM metadata WHERE key=?").get(revisionKey)?.["value"] !== revision) {
      connection.database.prepare("DELETE FROM evidence WHERE scope=?").run(scope);
      connection.database.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)").run(revisionKey, revision);
    }
    this.pruneBefore = String(connection.database.prepare("SELECT value FROM metadata WHERE key='prune_before'").get()?.["value"] ?? "");
    this.retiredCounters = new Set(connection.database.prepare("SELECT counter_key FROM retired_counters WHERE scope=?").all(scope).map((row) => String(row["counter_key"])));
    for (const row of connection.database.prepare("SELECT * FROM sessions WHERE scope=? ORDER BY rowid").all(scope) as unknown as StoredSession[]) {
      // A damaged payload must never cross the projection boundary or silently erase retained history.
      if (this.hash(row.payload) !== row.payload_mac) throw new Error("The local index failed an integrity check; run index rebuild.");
      const session = projectSession(JSON.parse(row.payload) as SessionAnalytics);
      this.sessions.set(row.identity_key, row);
      this.repositories.set(session.repositoryId, { root: row.root_key, remote: row.remote_key });
    }
  }

  static async open(options: AnalyzeOptions, rateCard: RateCard, includeHidden: boolean): Promise<IndexScan | null> {
    if (options.noIndex ?? process.env["SESSION_ANALYTICS_NO_INDEX"] === "1") return null;
    const connection = openIndexDatabase(options);
    try {
      const source = await readFile(new URL("../analyzer.ts", import.meta.url), "utf8");
      const ledgerSource = await readFile(new URL("./codex-ledger.ts", import.meta.url), "utf8");
      const hash = (value: unknown): string => keyedHash(connection.secret, JSON.stringify(value));
      // Filters are projections, not separate datasets. Explicit roots are isolated from machine discovery.
      const scope = hash([
        options.claudeRoot ? resolve(options.claudeRoot) : [homedir(), process.env["CLAUDE_CONFIG_DIR"] ?? "", "claude-discovery"],
        options.codexRoot || options.codexArchiveRoot ? [options.codexRoot ? resolve(options.codexRoot) : "", options.codexArchiveRoot ? resolve(options.codexArchiveRoot) : ""]
          : [homedir(), process.env["CODEX_HOME"] ?? "", "codex-discovery"],
        options.databasePath ? resolve(options.databasePath) : "default-conductor",
        options.cursorDatabasePath ? resolve(options.cursorDatabasePath) : "default-cursor", includeHidden,
      ]);
      return new IndexScan(connection, scope, hash(["parser-v1", source, ledgerSource, rateCard]));
    } catch (error) { connection.close(); throw error; }
  }

  hash(value: string): string { return keyedHash(this.connection.secret, value); }
  sourceKey(path: string): string { return this.hash(`source:${resolve(path)}`); }
  identity(provider: string, id: string): string { return this.hash(`identity:${provider}:${id}`); }
  isPrunedCounter(fingerprint: string): boolean { return this.retiredCounters.has(this.hash(fingerprint)); }

  private async file(path: string): Promise<FileFingerprint> {
    const key = this.sourceKey(path);
    const existing = this.fingerprints.get(key);
    if (existing) return existing.value;
    const value = await fingerprint(path, this.connection.secret);
    this.fingerprints.set(key, { path, value }); this.stats.fingerprintedFiles += 1;
    return value;
  }

  async codexLedger(path: string): Promise<CodexLedgerEvidence> {
    const sourceKey = this.sourceKey(path), current = await this.file(path);
    const row = this.connection.database.prepare("SELECT fingerprint,ledger,ledger_mac FROM evidence WHERE scope=? AND source_key=?").get(this.scope, sourceKey) as unknown as StoredEvidence | undefined;
    let evidence: CodexLedgerEvidence;
    if (row?.ledger && this.hash(row.ledger) !== row.ledger_mac) throw new Error("The local index failed an integrity check; run index rebuild.");
    if (row?.ledger && row.fingerprint === JSON.stringify(current)) {
      evidence = JSON.parse(row.ledger) as CodexLedgerEvidence; this.stats.ledgerHits += 1;
    } else {
      const result = await readCodexLedger(path, current, this.connection.secret, row?.ledger
        ? { fingerprint: JSON.parse(row.fingerprint) as FileFingerprint, evidence: JSON.parse(row.ledger) as CodexLedgerEvidence } : undefined);
      evidence = result.evidence;
      this.stats.ledgerReads += 1;
      if (result.appended) this.stats.ledgerAppends += 1;
      const payload = JSON.stringify(evidence);
      this.connection.database.prepare(`INSERT INTO evidence(scope,source_key,fingerprint,ledger,ledger_mac) VALUES (?,?,?,?,?)
        ON CONFLICT(scope,source_key) DO UPDATE SET fingerprint=excluded.fingerprint,ledger=excluded.ledger,ledger_mac=excluded.ledger_mac`)
        .run(this.scope, sourceKey, JSON.stringify(current), payload, this.hash(payload));
    }
    this.ledgerEvidence.set(path, evidence);
    return evidence;
  }

  /** Owners retained from deleted sessions remain reserved, so live broadcast receivers cannot charge them again. */
  retainedCounterOwners(liveIds: Set<string>, livePaths: string[]): Map<string, CounterOwner> {
    const owners = new Map<string, CounterOwner>();
    const liveSources = new Set(livePaths.map((path) => this.sourceKey(path)));
    for (const [identity, row] of this.sessions) {
      const session = JSON.parse(row.payload) as SessionAnalytics;
      if (session.provider !== "codex" || liveIds.has(identity) || (JSON.parse(row.source_keys) as string[]).some((key) => liveSources.has(key))) continue;
      for (const counter of JSON.parse(row.owned_counters) as Array<[string, string, string | null]>) {
        owners.set(counter[0], { path: `retained:${identity}`, timestamp: counter[1], modelFallback: counter[2] });
      }
    }
    return owners;
  }

  setCounterDependencies(owners: Map<string, CounterOwner>): void {
    this.ambiguousCounters = [...this.ledgerEvidence.values()].some((evidence) => evidence.unownedCounters);
    for (const [path, evidence] of this.ledgerEvidence) {
      this.dependencies.set(path, this.hash(JSON.stringify(evidence.observations.map(({ fingerprint }) => {
        const owner = owners.get(fingerprint);
        return [fingerprint, owner ? this.sourceKey(owner.path) : "", owner?.timestamp, owner?.modelFallback];
      }))));
    }
  }

  async session(
    row: SessionDatabaseRow, paths: string[], warnings: string[],
    analyze: () => Promise<SessionAnalytics>, claimedCounters?: Set<string>,
    owners?: Map<string, CounterOwner> | null,
    attributedCounters?: Set<string>,
  ): Promise<SessionAnalytics> {
    const mainPath = paths[0] as string;
    const providerId = row.provider_session_id ?? mainPath.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.(?:jsonl|json)$/i)?.[1] ?? row.conductor_session_id;
    const identity = this.identity(row.agent_type, providerId);
    this.seen.add(identity);
    const sources = await Promise.all(paths.map(async (path) => [this.sourceKey(path), await this.file(path)]));
    const signature = this.hash(JSON.stringify([
      this.revision, sources, warnings, this.dependencies.get(mainPath),
      // Only fields used by finalizeSession/pricing. Titles and branches cannot affect a cache hit.
      row.conductor_session_id, row.database_model, row.created_at, row.updated_at, row.status,
      row.repository_id, row.repository_name, row.root_path, row.repository_remote,
    ]));
    const previous = this.sessions.get(identity);
    // A missing-timestamp token record has no ledger owner; preserve the full-scan claimed-counter order.
    const canReuse = row.agent_type !== "codex" || Boolean(this.dependencies.get(mainPath)) &&
      !this.ambiguousCounters;
    let result: SessionAnalytics;
    let owned: Array<[string, string, string | null]> = [];
    if (previous?.signature === signature && canReuse) {
      result = projectSession(JSON.parse(previous.payload) as SessionAnalytics);
      owned = JSON.parse(previous.owned_counters) as typeof owned;
      for (const [counter] of owned) claimedCounters?.add(counter);
      delete result.transcript.sourceDeleted;
      this.stats.reusedSessions += 1;
    } else {
      result = projectSession(await analyze());
      for (const counter of attributedCounters ?? []) {
        const owner = owners?.get(counter);
        owned.push([counter, owner?.timestamp ?? "", owner?.modelFallback ?? null]);
      }
      this.stats.parsedSessions += 1;
    }
    this.save(identity, signature, result, paths.map((path) => this.sourceKey(path)), row.root_path, row.repository_remote, owned);
    return result;
  }

  private save(
    identity: string, signature: string, session: SessionAnalytics, sourceKeys: string[], root: string, remote: string,
    owned: Array<[string, string, string | null]>,
  ): void {
    const lastEvent = lastActivityAt(session);
    if (lastEvent && lastEvent < this.pruneBefore) return;
    const rootKey = root ? this.hash(`root:${resolve(root)}`) : "", remoteKey = remote ? this.hash(`remote:${normalizeRemote(remote)}`) : "";
    this.repositories.set(session.repositoryId, { root: rootKey, remote: remoteKey });
    const payload = JSON.stringify(projectSession(session));
    this.pending.set(identity, sourceKeys);
    this.connection.database.prepare(`INSERT INTO sessions(scope,identity_key,signature,payload,payload_mac,source_keys,root_key,remote_key,owned_counters,last_event_at,source_deleted)
      VALUES (?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(scope,identity_key) DO UPDATE SET signature=excluded.signature,
      payload=excluded.payload,payload_mac=excluded.payload_mac,source_keys=excluded.source_keys,root_key=excluded.root_key,
      remote_key=excluded.remote_key,owned_counters=excluded.owned_counters,last_event_at=excluded.last_event_at,source_deleted=0`)
      .run(this.scope, identity, signature, payload, this.hash(payload), JSON.stringify(sourceKeys), rootKey, remoteKey, JSON.stringify(owned), lastEvent);
  }

  /** Cursor is a mutable relational store; always refresh it through its existing isolated reader. */
  recordCursor(session: SessionAnalytics, root: string, remote: string): void {
    const identity = this.identity("cursor", session.sessionKey);
    this.seen.add(identity);
    this.save(identity, "", session, [], root, remote, []);
  }

  retained(livePaths: string[], complete: boolean, cursorComplete: boolean): SessionAnalytics[] {
    const live = new Set(livePaths.map((path) => this.sourceKey(path)));
    const retained: SessionAnalytics[] = [];
    for (const [identity, row] of this.sessions) {
      if (this.seen.has(identity)) continue;
      const session = projectSession(JSON.parse(row.payload) as SessionAnalytics);
      const sourceKeys = JSON.parse(row.source_keys) as string[];
      if (sourceKeys.some((key) => live.has(key))) {
        // Present-but-invalid/mismatched evidence must not resurrect a previously validated session.
        this.connection.database.prepare("DELETE FROM sessions WHERE scope=? AND identity_key=?").run(this.scope, identity);
        continue;
      }
      if (session.provider === "cursor" ? cursorComplete : complete) {
        session.transcript.sourceDeleted = true;
        this.connection.database.prepare("UPDATE sessions SET source_deleted=1 WHERE scope=? AND identity_key=?").run(this.scope, identity);
      } else {
        if (row.source_deleted) session.transcript.sourceDeleted = true;
        session.transcript.warnings.push("Source availability could not be checked; showing the last indexed facts.");
      }
      if (session.transcript.sourceDeleted) session.transcript.warnings.push("Source-deleted history retains the pricing and parser results from its last successful ingest.");
      retained.push(session);
    }
    this.stats.retainedSessions = retained.length;
    return retained;
  }

  matchesRoot(repositoryId: string, root: string): boolean { return this.repositories.get(repositoryId)?.root === this.hash(`root:${resolve(root)}`); }
  matchesRemote(repositoryId: string, remote: string): boolean { return this.repositories.get(repositoryId)?.remote === this.hash(`remote:${normalizeRemote(remote)}`); }
  inRetention(session: SessionAnalytics): boolean {
    const timestamp = lastActivityAt(session);
    return !timestamp || timestamp >= this.pruneBefore;
  }

  async commit(): Promise<boolean> {
    const unstable = new Set<string>();
    for (const [key, { path, value }] of this.fingerprints) {
      if (!(await stillMatches(path, value))) unstable.add(key);
    }
    // One active agent must not prevent thousands of stable sessions from ever reaching the index.
    // Keep the prior good facts for unstable groups; their ledger is re-read on the next launch.
    for (const [identity, sources] of this.pending) {
      if (!sources.some((key) => unstable.has(key))) continue;
      const previous = this.sessions.get(identity);
      this.connection.database.prepare("DELETE FROM sessions WHERE scope=? AND identity_key=?").run(this.scope, identity);
      if (previous) this.connection.database.prepare(`INSERT INTO sessions(scope,identity_key,signature,payload,payload_mac,source_keys,root_key,remote_key,owned_counters,last_event_at,source_deleted)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(this.scope, identity, previous.signature, previous.payload, previous.payload_mac,
          previous.source_keys, previous.root_key, previous.remote_key, previous.owned_counters, previous.last_event_at, previous.source_deleted);
      this.stats.deferredSessions += 1;
    }
    const saveFile = this.connection.database.prepare(`INSERT INTO evidence(scope,source_key,fingerprint) VALUES (?,?,?)
      ON CONFLICT(scope,source_key) DO UPDATE SET
        ledger=CASE WHEN evidence.fingerprint=excluded.fingerprint THEN evidence.ledger ELSE NULL END,
        ledger_mac=CASE WHEN evidence.fingerprint=excluded.fingerprint THEN evidence.ledger_mac ELSE NULL END,
        fingerprint=excluded.fingerprint`);
    for (const [key, { value }] of this.fingerprints) {
      if (unstable.has(key)) this.connection.database.prepare("DELETE FROM evidence WHERE scope=? AND source_key=?").run(this.scope, key);
      else saveFile.run(this.scope, key, JSON.stringify(value));
    }
    this.stats.elapsedMilliseconds = Math.round(performance.now() - this.started);
    this.connection.database.prepare(`INSERT INTO scans(scope,completed_at,stats) VALUES (?,?,?)
      ON CONFLICT(scope) DO UPDATE SET completed_at=excluded.completed_at,stats=excluded.stats`)
      .run(this.scope, new Date().toISOString(), JSON.stringify(this.stats));
    this.connection.database.exec("COMMIT"); this.committed = true;
    return unstable.size === 0;
  }

  close(): void {
    if (!this.committed) this.connection.database.exec("ROLLBACK");
    this.connection.close();
  }
}
