import { canonicalizeRemote } from "../repository-remotes.ts";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { PricingCatalog } from "../pricing/catalog.ts";
import type { AnalyzeOptions, RateCard, SessionAnalytics, SessionDatabaseRow } from "../types.ts";
import type { ClaudeOwnershipCache } from "../providers/claude-ownership.ts";
import type { ConductorRecordCache } from "../providers/conductor.ts";
import { INDEX_INTEGRITY, openIndexDatabase, type IndexConnection, type IndexScanStats } from "./database.ts";
import { projectConductorRecords, projectOwnershipObservations } from "./provider-evidence.ts";
import { fingerprint, keyedHash, stillMatches, type FileFingerprint } from "./fingerprint.ts";
import { readCodexLedger, type CodexLedgerEvidence } from "./codex-ledger.ts";
import { mapConcurrent } from "../concurrency.ts";
import { projectSession, sessionForIndex } from "./projection.ts";
import { assertIndexParity, IndexParityError, rotatingSample } from "./parity.ts";
import { velocityMetadata } from "../metrics/velocity.ts";
import { moduleUrl } from "../module-url.ts";

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
  retention_verified: number;
}
interface Exclusion { identity_key: string; signature: string; source_keys: string }
interface StoredEvidence { fingerprint: string; ledger: string | null; ledger_mac: string | null }
type PreviousSession = Omit<StoredSession, "payload"> & { payload: Buffer };
const previousPayload = (row: PreviousSession): string => inflateRawSync(row.payload).toString("utf8");
export interface CounterOwner { path: string; timestamp: string; modelFallback: string | null }

const normalizeRemote = canonicalizeRemote;

/** Retention comparisons use UTC instants; provider timestamps may include an offset. */
export function lastActivityAt(session: Pick<SessionAnalytics, "lastEventAt" | "updatedAt" | "createdAt">): string {
  for (const value of [session.lastEventAt, session.updatedAt, session.createdAt]) {
    const timestamp = value ? Date.parse(value) : NaN;
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return ""; // Unknown activity time is never treated as proof that a session is old.
}

const FINGERPRINT_CONCURRENCY = 16;

/** One writer transaction per scan. Failed scans roll back facts, fingerprints, and deletion marks together. */
export class IndexScan {
  private connection: IndexConnection;
  private scope: string;
  private revision: string;
  // Hourly activity cells are local to the worker's zone; a cached session from another zone is parsed again.
  private timeZone = velocityMetadata().timeZone;
  private started = performance.now();
  private fingerprints = new Map<string, { path: string; value: FileFingerprint }>();
  private sessions = new Map<string, PreviousSession>();
  private seen = new Set<string>();
  private pending = new Map<string, string[]>();
  private exclusions = new Map<string, Exclusion>();
  private pendingRetirements = new Map<string, string[]>();
  private unverifiedRetention = new Set<string>();
  private components = new Map<string, string>();
  private unobservedClaims = new Map<string, string>();
  private retiredCounters: Set<string>;
  private providerOwners = new Map<string, string>();
  private priorProviderClaims = new Map<string, Set<string>>();
  private providerClaims = new WeakMap<SessionAnalytics, Array<[string, string, string | null]>>();
  private ledgerPaths = new Set<string>();
  private sourceKeys = new Map<string, string>();
  private prefetched = new Map<string, FileFingerprint>();
  private retainedOrphanCount = 0;
  private dependencies = new Map<string, string>();
  private ambiguousCounters = false;
  private repositories = new Map<string, { root: string; remote: string }>();
  private committed = false;
  /** The index was cold, or written by other code or prices: every present session is parsed again in this scan. */
  readonly fullParse: boolean;
  private pruneBefore: string;
  private auditSessions: Set<string>;
  private auditLedgers: Set<string>;
  private auditOwnership: Set<string>;
  private auditConductor: Set<string>;
  private ownershipSeen = new Set<string>();
  private conductorSeen = new Set<string>();
  readonly stats: Required<IndexScanStats> = {
    fingerprintedFiles: 0, parsedSessions: 0, reusedSessions: 0, retainedSessions: 0, deferredSessions: 0,
    ledgerReads: 0, ledgerHits: 0, ledgerAppends: 0, auditedSessions: 0, auditedLedgers: 0,
    ownershipHits: 0, ownershipReads: 0, conductorHits: 0, conductorReads: 0, auditedOwnership: 0, auditedConductor: 0, elapsedMilliseconds: 0,
  };

  private constructor(connection: IndexConnection, scope: string, revision: string) {
    this.connection = connection; this.scope = scope; this.revision = revision;
    connection.database.exec("BEGIN IMMEDIATE");
    const revisionKey = `parser:${scope}`;
    this.fullParse = connection.database.prepare("SELECT value FROM metadata WHERE key=?").get(revisionKey)?.["value"] !== revision;
    if (this.fullParse) {
      for (const table of ["evidence", "claude_ownership", "conductor_records"]) connection.database.prepare(`DELETE FROM ${table} WHERE scope=?`).run(scope);
      connection.database.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)").run(revisionKey, revision);
    }
    this.pruneBefore = String(connection.database.prepare("SELECT value FROM metadata WHERE key='prune_before'").get()?.["value"] ?? "");
    this.retiredCounters = new Set(connection.database.prepare("SELECT counter_key FROM retired_counters WHERE scope=?").all(scope).map((row) => String(row["counter_key"])));
    for (const row of connection.database.prepare("SELECT identity_key,signature,source_keys FROM exclusions WHERE scope=?").all(scope) as unknown as Exclusion[]) {
      this.exclusions.set(row.identity_key, row);
    }
    const nativeIdentities: string[] = [];
    for (const row of connection.database.prepare("SELECT * FROM sessions WHERE scope=? ORDER BY rowid").iterate(scope) as unknown as Iterable<StoredSession>) {
      // A damaged payload must never cross the projection boundary or silently erase retained history.
      if (this.hash(row.payload) !== row.payload_mac) throw new Error("The local index failed an integrity check; run index rebuild.");
      const session = projectSession(JSON.parse(row.payload) as SessionAnalytics);
      // Rollback needs the prior generation, not a second full JSON graph in V8's heap.
      this.sessions.set(row.identity_key, { ...row, payload: deflateRawSync(row.payload) });
      if (session.provider === "antigravity") for (const [key, , owner] of JSON.parse(row.owned_counters) as Array<[string, string, string | null]>) {
        if (key.startsWith("provider-request:") && owner) {
          this.providerOwners.set(key, owner);
          const claims = this.priorProviderClaims.get(owner) ?? new Set<string>();
          claims.add(key); this.priorProviderClaims.set(owner, claims);
        }
      }
      if (!row.retention_verified) this.unverifiedRetention.add(session.sessionKey);
      this.repositories.set(session.repositoryId, { root: row.root_key, remote: row.remote_key });
      if (session.provider === "codex" || session.provider === "claude") nativeIdentities.push(row.identity_key);
    }
    const cursor = (kind: string) => String(connection.database.prepare("SELECT value FROM metadata WHERE key=?").get(`audit:${kind}:${scope}`)?.["value"] ?? "");
    this.auditSessions = new Set(rotatingSample(nativeIdentities, cursor("sessions"), 4));
    const ledgers = connection.database.prepare("SELECT source_key FROM evidence WHERE scope=? AND ledger IS NOT NULL").all(scope).map((row) => String(row["source_key"]));
    this.auditLedgers = new Set(rotatingSample(ledgers, cursor("ledgers"), 1));
    const stored = (table: string, column: string) => connection.database.prepare(`SELECT ${column} AS key FROM ${table} WHERE scope=?`).all(scope).map((row) => String(row["key"]));
    this.auditOwnership = new Set(rotatingSample(stored("claude_ownership", "source_key"), cursor("ownership"), 1));
    this.auditConductor = new Set(rotatingSample(stored("conductor_records", "session_key"), cursor("conductor"), 1));
  }

  static async open(options: AnalyzeOptions, rateCard: RateCard, includeHidden: boolean): Promise<IndexScan | null> {
    if (options.noIndex ?? process.env["SESSION_ANALYTICS_NO_INDEX"] === "1") return null;
    const connection = openIndexDatabase(options);
    try {
      const source = await readFile(moduleUrl("../analyzer.ts", import.meta.url), "utf8");
      const ledgerSource = await readFile(moduleUrl("./codex-ledger.ts", import.meta.url), "utf8");
      const storeSource = await readFile(moduleUrl("./index.ts", import.meta.url), "utf8");
      const projectionSource = await readFile(moduleUrl("./projection.ts", import.meta.url), "utf8");
      // Every parser/metric module participates; moving the Claude adapter cannot hide a revision.
      const parserSources: string[] = [];
      const directory = async (root: URL): Promise<void> => {
        for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), root);
          if (entry.isDirectory()) await directory(child);
          else if (/\.(?:ts|js)$/.test(entry.name)) parserSources.push(await readFile(child, "utf8"));
        }
      };
      await directory(new URL("../", import.meta.url));
      parserSources.push(await readFile(new URL("../../schemas/snapshot.v1.schema.json", import.meta.url), "utf8"));
      const catalog = rateCard as Partial<PricingCatalog>;
      const pricing = { currency: rateCard.currency, effectiveDate: rateCard.effectiveDate, models: rateCard.models,
        reviewedOverrides: rateCard.reviewedOverrides, history: catalog.history, policy: catalog.status?.policy };
      const hash = (value: unknown): string => keyedHash(connection.secret, JSON.stringify(value));
      // Filters are projections, not separate datasets. Explicit roots are isolated from machine discovery.
      const scope = hash([
        options.claudeRoot ? resolve(options.claudeRoot) : [homedir(), process.env["CLAUDE_CONFIG_DIR"] ?? "", "claude-discovery"],
        options.codexRoot || options.codexArchiveRoot ? [options.codexRoot ? resolve(options.codexRoot) : "", options.codexArchiveRoot ? resolve(options.codexArchiveRoot) : ""]
          : [homedir(), process.env["CODEX_HOME"] ?? "", "codex-discovery"],
        options.databasePath ? resolve(options.databasePath) : "default-conductor",
        options.cursorDatabasePath ? resolve(options.cursorDatabasePath) : "default-cursor", includeHidden,
        // Two retired content-rule flags stay as constants so existing scopes, and their retained history, keep their keys.
        options.additionalProviders !== false, false, false,
        [options.cursorSdkRoot, options.cursorTranscriptRoot, options.copilotRoot, options.opencodeDatabasePath, options.geminiRoot]
          .map((root) => root ? resolve(root) : "default"),
        ...(options.antigravityRoot ? [resolve(options.antigravityRoot)] : []),
      ]);
      return new IndexScan(connection, scope, hash(["parser-v061-native-accounting", source, ledgerSource, storeSource, projectionSource, parserSources, pricing]));
    } catch (error) { connection.close(); throw error; }
  }

  hash(value: string | Uint8Array): string { return keyedHash(this.connection.secret, value); }
  /** Index-side failures are consistency failures (full rescan), never provider evidence failures. */
  private indexed<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) { throw error instanceof IndexParityError || (error instanceof Error && error.message === INDEX_INTEGRITY) ? error : new IndexParityError(); }
  }
  sourceKey(path: string): string {
    let key = this.sourceKeys.get(path);
    if (key === undefined) { key = this.hash(`source:${resolve(path)}`); this.sourceKeys.set(path, key); }
    return key;
  }
  identity(provider: string, id: string): string { return this.hash(`identity:${provider}:${id}`); }
  isPrunedCounter(fingerprint: string): boolean { return this.retiredCounters.size > 0 && this.retiredCounters.has(this.hash(fingerprint)); }

  /** Fingerprint upcoming sources concurrently. Commit still re-checks every value it saves. */
  async prefetch(paths: string[]): Promise<void> {
    const pending = [...new Set(paths)].filter((path) => !this.fingerprints.has(this.sourceKey(path)) && !this.prefetched.has(this.sourceKey(path)));
    await mapConcurrent(pending, FINGERPRINT_CONCURRENCY, async (path) => {
      // A failed prefetch is retried, and reported, by the session that needs the file.
      try { this.prefetched.set(this.sourceKey(path), await fingerprint(path, this.connection.secret)); } catch { /* retried */ }
    });
  }

  private async file(path: string): Promise<FileFingerprint> {
    const key = this.sourceKey(path);
    const existing = this.fingerprints.get(key);
    if (existing) return existing.value;
    let value = this.prefetched.get(key);
    this.prefetched.delete(key);
    // A source that changed or vanished since the prefetch is fingerprinted at use, as before.
    if (!value || !(await stillMatches(path, value))) {
      try { value = await fingerprint(path, this.connection.secret); }
      catch { throw new IndexParityError(); }
    }
    this.fingerprints.set(key, { path, value }); this.stats.fingerprintedFiles += 1;
    return value;
  }

  async codexLedger(path: string): Promise<CodexLedgerEvidence> {
    const sourceKey = this.sourceKey(path), current = await this.file(path);
    const row = this.connection.database.prepare("SELECT fingerprint,ledger,ledger_mac FROM evidence WHERE scope=? AND source_key=?").get(this.scope, sourceKey) as unknown as StoredEvidence | undefined;
    let evidence: CodexLedgerEvidence;
    if (row?.ledger && this.hash(row.ledger) !== row.ledger_mac) throw new Error("The local index failed an integrity check; run index rebuild.");
    if (row?.ledger && row.fingerprint === JSON.stringify(current) && JSON.parse(row.ledger).observations.every((observation: { earliestTimestamp?: string }) => typeof observation.earliestTimestamp === "string")) {
      evidence = JSON.parse(row.ledger) as CodexLedgerEvidence; this.stats.ledgerHits += 1;
      if (this.auditLedgers.has(sourceKey)) {
        const fresh = (await readCodexLedger(path, current, this.connection.secret)).evidence;
        // Live appends are handled by component deferral, not diagnosed as cache corruption.
        if (await stillMatches(path, current)) {
          assertIndexParity(evidence, fresh);
          this.stats.auditedLedgers += 1;
        }
      }
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
    this.ledgerPaths.add(path);
    return evidence;
  }

  /** A private identifier's keyed hash, truncated to 128 bits: compared for equality only. */
  privateKey(kind: string, value: string): string { return this.hash(`${kind}:${value}`).slice(0, 32); }

  /** A current fingerprint shared with the session pass, without fixing it for the commit-time stability check. */
  private async peek(path: string): Promise<FileFingerprint> {
    const key = this.sourceKey(path);
    const fixed = this.fingerprints.get(key)?.value ?? this.prefetched.get(key);
    if (fixed && await stillMatches(path, fixed)) return fixed;
    const value = await fingerprint(path, this.connection.secret);
    if (!this.fingerprints.has(key)) this.prefetched.set(key, value);
    return value;
  }

  /** The Claude ownership pre-pass for one file: replayed while its fingerprint is unchanged. */
  readonly ownership: ClaudeOwnershipCache = {
    key: (id) => this.privateKey("claude-message", id),
    prefetch: (paths) => this.prefetch(paths),
    observations: async (path, read) => {
      let current: FileFingerprint;
      try { current = await this.peek(path); } catch { return read(); } // The pass records an unreadable file as not visited.
      const sourceKey = this.sourceKey(path), signature = JSON.stringify(current);
      this.ownershipSeen.add(sourceKey);
      const cached = this.indexed(() => {
        const row = this.connection.database.prepare("SELECT fingerprint,observations,observations_mac FROM claude_ownership WHERE scope=? AND source_key=?")
          .get(this.scope, sourceKey) as { fingerprint: string; observations: Uint8Array; observations_mac: string } | undefined;
        if (!row || row.fingerprint !== signature) return null;
        if (this.hash(row.observations) !== row.observations_mac) throw new Error(INDEX_INTEGRITY);
        return projectOwnershipObservations(JSON.parse(inflateRawSync(row.observations).toString("utf8")));
      });
      if (cached) {
        this.stats.ownershipHits += 1;
        if (this.auditOwnership.has(sourceKey)) {
          const fresh = await read();
          // A file changing during the audit is a later generation, not cache corruption.
          if (fresh.complete && await stillMatches(path, current)) {
            this.indexed(() => assertIndexParity(cached, projectOwnershipObservations(JSON.parse(JSON.stringify(fresh.observations)))));
            this.stats.auditedOwnership += 1;
          }
        }
        return { observations: cached, complete: true };
      }
      const fresh = await read();
      this.stats.ownershipReads += 1;
      // Only a complete read of an unchanged file describes this fingerprint.
      if (!fresh.complete || !await stillMatches(path, current)) return fresh;
      // Cold and warm scans replay the same allowlisted projection.
      return { complete: true, observations: this.indexed(() => {
        const observations = projectOwnershipObservations(JSON.parse(JSON.stringify(fresh.observations)));
        const payload = deflateRawSync(JSON.stringify(observations), { level: 1 });
        this.connection.database.prepare(`INSERT INTO claude_ownership(scope,source_key,fingerprint,observations,observations_mac) VALUES (?,?,?,?,?)
          ON CONFLICT(scope,source_key) DO UPDATE SET fingerprint=excluded.fingerprint,observations=excluded.observations,observations_mac=excluded.observations_mac`)
          .run(this.scope, sourceKey, signature, payload, this.hash(payload));
        return observations;
      }) };
    },
  };

  /** One Conductor session's projected records: replayed while its change signature is unchanged. */
  readonly conductor: ConductorRecordCache = {
    key: (value) => this.privateKey("conductor-id", value),
    records: (conductorSessionId, signature, read) => {
      const sessionKey = this.hash(`conductor-session:${conductorSessionId}`);
      const sign = (): string => this.hash(JSON.stringify([this.revision, signature()]));
      const before = sign();
      this.conductorSeen.add(sessionKey);
      const cached = this.indexed(() => {
        const row = this.connection.database.prepare("SELECT signature,payload,payload_mac FROM conductor_records WHERE scope=? AND session_key=?")
          .get(this.scope, sessionKey) as { signature: string; payload: Uint8Array; payload_mac: string } | undefined;
        if (!row || row.signature !== before) return null;
        if (this.hash(row.payload) !== row.payload_mac) throw new Error(INDEX_INTEGRITY);
        return projectConductorRecords(JSON.parse(inflateRawSync(row.payload).toString("utf8")));
      });
      if (cached) {
        this.stats.conductorHits += 1;
        if (this.auditConductor.has(sessionKey)) {
          const fresh = JSON.stringify(read());
          // Rows written during the audit are a later generation, not cache corruption.
          if (sign() === before) {
            this.indexed(() => assertIndexParity(cached, projectConductorRecords(JSON.parse(fresh))));
            this.stats.auditedConductor += 1;
          }
        }
        return cached;
      }
      const fresh = JSON.stringify(read());
      this.stats.conductorReads += 1;
      const stable = sign() === before;
      // Cold and warm scans replay the same allowlisted projection.
      return this.indexed(() => {
        const records = projectConductorRecords(JSON.parse(fresh));
        if (stable) {
          const payload = deflateRawSync(JSON.stringify(records), { level: 1 });
          this.connection.database.prepare(`INSERT INTO conductor_records(scope,session_key,signature,payload,payload_mac) VALUES (?,?,?,?,?)
            ON CONFLICT(scope,session_key) DO UPDATE SET signature=excluded.signature,payload=excluded.payload,payload_mac=excluded.payload_mac`)
            .run(this.scope, sessionKey, before, payload, this.hash(payload));
        }
        return records;
      });
    },
  };

  /** Owners retained from deleted sessions remain reserved, so live broadcast receivers cannot charge them again. */
  retainedCounterOwners(liveIds: Set<string>, livePaths: string[]): Map<string, CounterOwner> {
    const owners = new Map<string, CounterOwner>();
    const liveSources = new Set(livePaths.map((path) => this.sourceKey(path)));
    for (const [identity, row] of this.sessions) {
      const session = JSON.parse(previousPayload(row)) as SessionAnalytics;
      if (session.provider !== "codex" || liveIds.has(identity) || (JSON.parse(row.source_keys) as string[]).some((key) => liveSources.has(key))) continue;
      for (const counter of JSON.parse(row.owned_counters) as Array<[string, string, string | null]>) {
        owners.set(counter[0], { path: `retained:${identity}`, timestamp: counter[1], modelFallback: counter[2] });
      }
    }
    return owners;
  }

  setCounterDependencies(owners: Map<string, CounterOwner>): void {
    this.ambiguousCounters = false;
    // Connect old owners, new owners and every consumer, even if the old owner stopped
    // observing a counter. Deferral must restore one whole accounting generation.
    const counters = new Map<string, string>();
    const observe = (counter: string, source: string): void => {
      const previous = counters.get(counter);
      if (previous) this.joinSources([previous, source]);
      else counters.set(counter, source);
    };
    for (const row of this.sessions.values()) {
      const sources = JSON.parse(row.source_keys) as string[];
      this.joinSources(sources);
      if (sources[0]) for (const [counter] of JSON.parse(row.owned_counters) as Array<[string, string, string | null]>) observe(counter, sources[0]);
    }
    const ledger = this.connection.database.prepare("SELECT ledger FROM evidence WHERE scope=? AND source_key=?");
    for (const path of this.ledgerPaths) {
      const source = this.sourceKey(path);
      // Broadcast receivers can repeat millions of observations. Hydrate one file at a time.
      const evidence = JSON.parse(String(ledger.get(this.scope, source)?.["ledger"])) as CodexLedgerEvidence;
      this.ambiguousCounters ||= evidence.unownedCounters;
      for (const { fingerprint } of evidence.observations) observe(fingerprint, source);
      for (const fingerprint of evidence.unownedFingerprints) observe(fingerprint, source);
      // Native-only producers can reserve a legacy state observed by another file.
      // A commit-time source change must defer the entire ownership transfer.
      for (const fingerprint of evidence.nativeFingerprints ?? []) observe(fingerprint, source);
      const dependencies = new Set([...evidence.observations.map(({ fingerprint }) => fingerprint), ...(evidence.nativeFingerprints ?? [])]);
      this.dependencies.set(path, this.hash(JSON.stringify([...dependencies].map((fingerprint) => {
        const owner = owners.get(fingerprint);
        return [fingerprint, owner ? this.sourceKey(owner.path) : "", owner?.timestamp, owner?.modelFallback];
      }))));
    }
    // Only the derived dependency signatures are needed during session parsing.
    this.ledgerPaths.clear();
  }

  private component(source: string): string {
    let root = source;
    while (this.components.has(root)) root = this.components.get(root)!;
    while (this.components.has(source)) {
      const parent = this.components.get(source)!;
      this.components.set(source, root); source = parent;
    }
    return root;
  }

  private joinSources(sources: string[]): void {
    if (!sources[0]) return;
    const root = this.component(sources[0]);
    for (const source of sources.slice(1)) {
      const other = this.component(source);
      if (other !== root) this.components.set(other, root);
    }
  }

  async session(
    row: SessionDatabaseRow, paths: string[], warnings: string[],
    analyze: () => Promise<SessionAnalytics | null>, claimedCounters?: Set<string>,
    owners?: Map<string, CounterOwner> | null,
    attributedCounters?: Set<string>,
    parseDependencies?: unknown,
  ): Promise<SessionAnalytics | null> {
    let sourceFailed = false;
    try {
      const mainPath = paths[0] as string;
      const providerId = row.provider_session_id ?? mainPath.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.(?:jsonl|json)$/i)?.[1] ?? row.conductor_session_id;
      const identity = this.identity(row.agent_type, providerId);
      this.seen.add(identity);
      const sources = await Promise.all(paths.map(async (path) => [this.sourceKey(path), await this.file(path)]));
      const signature = this.hash(JSON.stringify([
        this.revision, this.timeZone, sources, warnings, paths.map(path => this.dependencies.get(path) ?? null), parseDependencies,
        // Private correlation metadata only influences the keyed signature, never a payload.
        row.conductor_session_id, row.database_model, row.created_at, row.updated_at, row.status,
        row.repository_id, row.repository_name, row.root_path, row.repository_remote, row,
      ]));
      const previous = this.sessions.get(identity);
      // A missing-timestamp token record has no ledger owner; preserve the full-scan claimed-counter order.
      const previousSession = previous ? JSON.parse(previousPayload(previous)) as SessionAnalytics : null;
      const canReuse = !(previousSession?.transcript.liveness === "active" && !previousSession.transcript.snapshotWhileWorking) &&
        (row.agent_type !== "codex" || Boolean(this.dependencies.get(mainPath)) && !this.ambiguousCounters);
      // Exclusion depends on verified activity time, not on which undated request won.
      // Previously removed ownership is already reserved independently of cache reuse.
      if (this.exclusions.get(identity)?.signature === signature) {
        this.stats.reusedSessions += 1;
        return null;
      }
      let result: SessionAnalytics;
      let owned: Array<[string, string, string | null]> = [];
      if (previous?.signature === signature && previous.retention_verified && canReuse) {
        result = projectSession(previousSession!);
        owned = JSON.parse(previous.owned_counters) as typeof owned;
        if (this.auditSessions.has(identity)) {
          // Audit before replaying claims: the full parser must see the same prior owners.
          const fresh = await analyze();
          const stable = (await Promise.all(paths.map(async (path) => stillMatches(path, await this.file(path))))).every(Boolean);
          if (stable) {
            assertIndexParity(result, fresh && projectSession(fresh));
            this.stats.auditedSessions += 1;
          } else {
            // A raced audit must not claim requests absent from the cached response.
            for (const counter of attributedCounters ?? []) claimedCounters?.delete(counter);
          }
        }
        for (const [counter] of owned) claimedCounters?.add(counter);
        delete result.transcript.sourceDeleted;
        this.stats.reusedSessions += 1;
      } else {
        let analyzed: SessionAnalytics | null;
        try { analyzed = await analyze(); }
        catch (error) { sourceFailed = true; throw error; }
        if (!analyzed) return null;
        result = sessionForIndex(analyzed);
        for (const counter of attributedCounters ?? []) {
          const owner = owners?.get(counter);
          owned.push([counter, owner?.timestamp ?? "", owner?.modelFallback ?? null]);
          if (!owner) this.unobservedClaims.set(counter, this.sourceKey(mainPath));
        }
        this.stats.parsedSessions += 1;
      }
      return this.save(identity, signature, result, paths.map((path) => this.sourceKey(path)), row.root_path, row.repository_remote, owned) ? result : null;
    } catch (error) {
      if (sourceFailed) throw error;
      throw new IndexParityError();
    }
  }

  private save(
    identity: string, signature: string, session: SessionAnalytics, sourceKeys: string[], root: string, remote: string,
    owned: Array<[string, string, string | null]>,
  ): boolean {
    const lastEvent = lastActivityAt(session);
    this.unverifiedRetention.delete(session.sessionKey);
    this.pending.set(identity, sourceKeys);
    this.joinSources(sourceKeys);
    if (lastEvent && lastEvent < this.pruneBefore) {
      this.connection.database.prepare("DELETE FROM sessions WHERE scope=? AND identity_key=?").run(this.scope, identity);
      this.connection.database.prepare("INSERT OR REPLACE INTO exclusions(scope,identity_key,signature,source_keys) VALUES (?,?,?,?)")
        .run(this.scope, identity, signature, JSON.stringify(sourceKeys));
      this.pendingRetirements.set(identity, owned.map(([counter]) => counter));
      return false;
    }
    this.connection.database.prepare("DELETE FROM exclusions WHERE scope=? AND identity_key=?").run(this.scope, identity);
    const rootKey = root ? this.hash(`root:${resolve(root)}`) : "", remoteKey = remote ? this.hash(`remote:${normalizeRemote(remote)}`) : "";
    this.repositories.set(session.repositoryId, { root: rootKey, remote: remoteKey });
    const payload = JSON.stringify(sessionForIndex(session));
    this.connection.database.prepare(`INSERT INTO sessions(scope,identity_key,signature,payload,payload_mac,source_keys,root_key,remote_key,owned_counters,last_event_at,source_deleted,retention_verified)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,1) ON CONFLICT(scope,identity_key) DO UPDATE SET signature=excluded.signature,
      payload=excluded.payload,payload_mac=excluded.payload_mac,source_keys=excluded.source_keys,root_key=excluded.root_key,
      remote_key=excluded.remote_key,owned_counters=excluded.owned_counters,last_event_at=excluded.last_event_at,source_deleted=0,retention_verified=1`)
      .run(this.scope, identity, signature, payload, this.hash(payload), JSON.stringify(sourceKeys), rootKey, remoteKey, JSON.stringify(owned), lastEvent);
    return true;
  }

  /** Cursor is a mutable relational store; always refresh it through its existing isolated reader. */
  recordCursor(session: SessionAnalytics, root: string, remote: string): void { this.recordFresh(session, root, remote); }

  /** Additional mutable provider stores retain their complete public projection after a fresh read. */
  recordFresh(session: SessionAnalytics, root: string, remote: string): void {
    const identity = this.identity(session.provider, session.sessionKey);
    this.seen.add(identity);
    this.save(identity, "", session, [], root, remote, this.providerClaims.get(session) ?? []);
  }

  /** Reserve native response identities across source loss, fork replay and prune.
   * Reuse the existing retirement ledger; only namespaced keyed hashes go on disk.
   * The object key survives a later Conductor public-session-key remapping. */
  claimProviderRequest(session: SessionAnalytics, requestId: string): boolean {
    const key = `provider-request:${this.privateKey(session.provider, requestId)}`;
    if (this.isPrunedCounter(key)) return false;
    const owner = this.privateKey("provider-owner", `${session.provider}:${session.sessionKey}`);
    const previous = this.providerOwners.get(key);
    if (previous && previous !== owner) return false;
    this.providerOwners.set(key, owner);
    const owned = this.providerClaims.get(session) ?? [];
    owned.push([key, "", owner]);
    this.providerClaims.set(session, owned);
    return true;
  }

  /** A successful complete reparse replaces its old reservations before forks
   * are read. Partial reads keep unseen reservations until evidence is repaired. */
  completeProviderRequests(session: SessionAnalytics): void {
    if (session.provider !== "antigravity") return;
    const owner = this.privateKey("provider-owner", `${session.provider}:${session.sessionKey}`);
    const prior = this.priorProviderClaims.get(owner);
    if (!prior) return;
    const owned = this.providerClaims.get(session) ?? [], seen = new Set(owned.map(([key]) => key));
    for (const key of prior) {
      if (seen.has(key) || this.providerOwners.get(key) !== owner) continue;
      if (session.evidence?.accounting === "partial") owned.push([key, "", owner]);
      else this.providerOwners.delete(key);
    }
    this.providerClaims.set(session, owned);
    this.priorProviderClaims.delete(owner);
  }

  supersedeFallback(provider: string, sessionKey: string): void {
    const identity = this.identity(provider, sessionKey);
    if (!this.sessions.has(identity)) return;
    this.seen.add(identity); this.pending.set(identity, []);
    this.connection.database.prepare("DELETE FROM sessions WHERE scope=? AND identity_key=?").run(this.scope, identity);
  }

  /** Surviving children must not overwrite already retained main-file accounting. */
  retainedClaudeParent(providerId: string, childPath: string): SessionAnalytics | null {
    const identity = this.identity("claude", providerId), previous = this.sessions.get(identity);
    if (!previous) return null;
    const root = childPath.split("/subagents/")[0]!;
    const sources = JSON.parse(previous.source_keys) as string[];
    if (![`${root}.jsonl`, `${root}.json`].some(path => sources.includes(this.sourceKey(path)))) return null;
    const session = projectSession(JSON.parse(previousPayload(previous)) as SessionAnalytics);
    session.transcript.sourceDeleted = true;
    session.transcript.warnings.push("Source-deleted history retains the pricing and parser results from its last successful ingest.");
    this.seen.add(identity); this.retainedOrphanCount++;
    this.connection.database.prepare("UPDATE sessions SET source_deleted=1 WHERE scope=? AND identity_key=?").run(this.scope, identity);
    return session;
  }

  retained(livePaths: string[], complete: boolean, cursorComplete: boolean, additionalComplete = true): SessionAnalytics[] {
    const live = new Set(livePaths.map((path) => this.sourceKey(path)));
    const retained: SessionAnalytics[] = [];
    for (const [identity, row] of this.sessions) {
      if (this.seen.has(identity)) continue;
      const session = projectSession(JSON.parse(previousPayload(row)) as SessionAnalytics);
      const sourceKeys = JSON.parse(row.source_keys) as string[];
      if (sourceKeys.some((key) => live.has(key))) {
        // Present-but-invalid/mismatched evidence must not resurrect a previously validated session.
        this.pending.set(identity, sourceKeys);
        this.connection.database.prepare("DELETE FROM sessions WHERE scope=? AND identity_key=?").run(this.scope, identity);
        continue;
      }
      if (!sourceKeys.length && session.evidence ? additionalComplete : session.provider === "cursor" ? cursorComplete : complete) {
        session.transcript.sourceDeleted = true;
        this.connection.database.prepare("UPDATE sessions SET source_deleted=1 WHERE scope=? AND identity_key=?").run(this.scope, identity);
      } else {
        if (row.source_deleted) session.transcript.sourceDeleted = true;
        session.transcript.warnings.push("Source availability could not be checked; showing the last indexed facts.");
      }
      if (session.transcript.sourceDeleted) session.transcript.warnings.push("Source-deleted history retains the pricing and parser results from its last successful ingest.");
      if (!row.retention_verified) session.transcript.warnings.push("Legacy activity dates could not be verified; history is kept until its source can be read again.");
      retained.push(session);
    }
    this.stats.retainedSessions = retained.length + this.retainedOrphanCount;
    return retained;
  }

  matchesRoot(repositoryId: string, root: string): boolean { return this.repositories.get(repositoryId)?.root === this.hash(`root:${resolve(root)}`); }
  matchesRemote(repositoryId: string, remote: string): boolean { return this.repositories.get(repositoryId)?.remote === this.hash(`remote:${normalizeRemote(remote)}`); }
  inRetention(session: SessionAnalytics): boolean {
    if (this.unverifiedRetention.has(session.sessionKey)) return true;
    const timestamp = lastActivityAt(session);
    return !timestamp || timestamp >= this.pruneBefore;
  }

  async commit(): Promise<boolean> {
    // A growing file can reveal a request only during session parsing, after the
    // ledger pass. Connect such claims to prior owners before choosing deferrals.
    if (this.unobservedClaims.size) for (const row of this.sessions.values()) {
      const sources = JSON.parse(row.source_keys) as string[];
      for (const [counter] of JSON.parse(row.owned_counters) as Array<[string, string, string | null]>) {
        const claimant = this.unobservedClaims.get(counter);
        if (claimant) this.joinSources([...sources, claimant]);
      }
    }
    const unstable = new Set<string>();
    this.prefetched.clear();
    const sources = [...this.fingerprints];
    const stable = await mapConcurrent(sources, FINGERPRINT_CONCURRENCY, ([, { path, value }]) => stillMatches(path, value));
    sources.forEach(([key], position) => { if (!stable[position]) unstable.add(key); });
    const unstableComponents = new Set([...unstable].map((source) => this.component(source)));
    const deferredSources = new Set([...this.fingerprints.keys()].filter((source) => unstableComponents.has(this.component(source))));
    // One active agent must not prevent thousands of stable sessions from ever reaching the index.
    // Keep the prior good facts for unstable groups; their ledger is re-read on the next launch.
    for (const [identity, sources] of this.pending) {
      if (!sources.some((key) => unstableComponents.has(this.component(key)))) continue;
      const previous = this.sessions.get(identity);
      this.connection.database.prepare("DELETE FROM sessions WHERE scope=? AND identity_key=?").run(this.scope, identity);
      if (previous) this.connection.database.prepare(`INSERT INTO sessions(scope,identity_key,signature,payload,payload_mac,source_keys,root_key,remote_key,owned_counters,last_event_at,source_deleted,retention_verified)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(this.scope, identity, previous.signature, previousPayload(previous), previous.payload_mac,
          previous.source_keys, previous.root_key, previous.remote_key, previous.owned_counters, previous.last_event_at, previous.source_deleted, previous.retention_verified);
      this.connection.database.prepare("DELETE FROM exclusions WHERE scope=? AND identity_key=?").run(this.scope, identity);
      const excluded = this.exclusions.get(identity);
      if (excluded) this.connection.database.prepare("INSERT INTO exclusions(scope,identity_key,signature,source_keys) VALUES (?,?,?,?)")
        .run(this.scope, identity, excluded.signature, excluded.source_keys);
      this.pendingRetirements.delete(identity);
      this.stats.deferredSessions += 1;
    }
    const saveFile = this.connection.database.prepare(`INSERT INTO evidence(scope,source_key,fingerprint) VALUES (?,?,?)
      ON CONFLICT(scope,source_key) DO UPDATE SET
        ledger=CASE WHEN evidence.fingerprint=excluded.fingerprint THEN evidence.ledger ELSE NULL END,
        ledger_mac=CASE WHEN evidence.fingerprint=excluded.fingerprint THEN evidence.ledger_mac ELSE NULL END,
        fingerprint=excluded.fingerprint`);
    for (const [key, { value }] of this.fingerprints) {
      if (deferredSources.has(key)) this.connection.database.prepare("DELETE FROM evidence WHERE scope=? AND source_key=?").run(this.scope, key);
      else saveFile.run(this.scope, key, JSON.stringify(value));
    }
    const reserve = this.connection.database.prepare("INSERT OR IGNORE INTO retired_counters(scope,counter_key) VALUES (?,?)");
    for (const counters of this.pendingRetirements.values()) for (const counter of counters) reserve.run(this.scope, this.hash(counter));
    // Pre-pass evidence for sources this scan no longer saw is dropped once the pass ran.
    for (const [table, column, seen] of [["claude_ownership", "source_key", this.ownershipSeen], ["conductor_records", "session_key", this.conductorSeen]] as const) {
      if (!seen.size) continue;
      const remove = this.connection.database.prepare(`DELETE FROM ${table} WHERE scope=? AND ${column}=?`);
      for (const row of this.connection.database.prepare(`SELECT ${column} AS key FROM ${table} WHERE scope=?`).all(this.scope)) {
        if (!seen.has(String(row["key"]))) remove.run(this.scope, String(row["key"]));
      }
    }
    for (const [kind, sample] of [["sessions", this.auditSessions], ["ledgers", this.auditLedgers], ["ownership", this.auditOwnership], ["conductor", this.auditConductor]] as const) {
      const last = [...sample].at(-1);
      if (last) this.connection.database.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)").run(`audit:${kind}:${this.scope}`, last);
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
