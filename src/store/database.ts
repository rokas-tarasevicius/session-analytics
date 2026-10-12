import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serviceId } from "../brand.ts";
import type { AnalyzeOptions } from "../types.ts";
import { keyedHash } from "./fingerprint.ts";
import { acquireWriterGate, COORDINATION_ERROR } from "./writer-gate.ts";

export const SCHEMA_VERSION = 4;
export const INDEX_UNAVAILABLE = "The local index is unavailable; use --no-index or run index rebuild.";
export const INDEX_BUSY = "The local index is busy; another ingest or maintenance command is running.";
export const INDEX_INTEGRITY = "The local index failed an integrity check; run index rebuild.";

export function dataDirectory(
  options: Pick<AnalyzeOptions, "dataDir"> = {},
  environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const override = options.dataDir ?? environment["SESSION_ANALYTICS_DATA_DIR"];
  if (override) return resolve(override);
  if (platform === "darwin") return join(home, "Library", "Application Support", serviceId);
  const xdg = environment["XDG_DATA_HOME"];
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), serviceId);
}

export function indexPath(options: Pick<AnalyzeOptions, "dataDir"> = {}): string {
  return join(dataDirectory(options), "index.sqlite");
}

export function secureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(INDEX_UNAVAILABLE);
  }
  chmodSync(path, 0o700);
}

/** Refuse links and foreign-owned files rather than chmod-ing their targets. */
export function secureFile(path: string, create = false): void {
  if (!existsSync(path) && create) {
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  let info;
  try { info = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(INDEX_UNAVAILABLE);
  }
  chmodSync(path, 0o600);
}

export function secureSidecars(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) secureFile(path + suffix);
}

function connect(path: string): DatabaseSync {
  secureFile(path, true);
  secureSidecars(path);
  const database = new DatabaseSync(path, { enableDoubleQuotedStringLiterals: false });
  try { database.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;"); }
  catch (error) { database.close(); throw error; }
  return database;
}

function sqliteBusy(error: unknown): boolean {
  const code = (error as { errcode?: number })?.errcode;
  return code !== undefined && [5, 6].includes(code & 0xff);
}

function quarantine(path: string): void {
  const suffix = `.rebuild-${Date.now()}-${randomBytes(4).toString("hex")}`;
  for (const ending of ["", "-wal", "-shm", "-journal"]) {
    secureFile(path + ending);
    if (existsSync(path + ending)) renameSync(path + ending, path + suffix + ending);
  }
}

/** A filesystem gate also protects repair of the SQLite lease, which still coordinates older writers. */
export function acquireWriter(options: Pick<AnalyzeOptions, "dataDir"> = {}, repair = false): { release: () => void; directory: string } {
  const directory = dataDirectory(options);
  secureDirectory(directory);
  const path = join(directory, "writer.sqlite");
  const releaseGate = acquireWriterGate(directory);
  let lease: DatabaseSync | undefined;
  try {
    try { lease = connect(path); lease.exec("BEGIN IMMEDIATE"); }
    catch (error) {
      lease?.close(); lease = undefined;
      if (sqliteBusy(error)) throw new Error(INDEX_BUSY);
      if (error instanceof Error && error.message === INDEX_UNAVAILABLE) throw error;
      if (!repair) throw new Error(COORDINATION_ERROR);
      quarantine(path);
      lease = connect(path); lease.exec("BEGIN IMMEDIATE");
    }
    secureSidecars(path);
    const opened = lease;
    return { directory, release: () => {
      try { opened.exec("ROLLBACK"); } finally { opened.close(); releaseGate(); }
    } };
  } catch (error) {
    lease?.close(); releaseGate();
    if (error instanceof Error && error.message.startsWith("The local index")) throw error;
    throw new Error(COORDINATION_ERROR);
  }
}

/** Ordered migrations, committed with the schema version, never downgrade a future schema. */
export function migrate(database: DatabaseSync): void {
  const version = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version > SCHEMA_VERSION) throw new Error("The local index was created by a newer version; upgrade or use --no-index.");
  if (version === SCHEMA_VERSION) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (version < 1) database.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE evidence (
        scope TEXT NOT NULL, source_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        ledger TEXT, ledger_mac TEXT, PRIMARY KEY (scope, source_key)
      ) STRICT;
      CREATE TABLE sessions (
        scope TEXT NOT NULL, identity_key TEXT NOT NULL, signature TEXT NOT NULL,
        payload TEXT NOT NULL, payload_mac TEXT NOT NULL, source_keys TEXT NOT NULL,
        root_key TEXT NOT NULL, remote_key TEXT NOT NULL, owned_counters TEXT NOT NULL,
        last_event_at TEXT NOT NULL, PRIMARY KEY (scope, identity_key)
      ) STRICT;
    `);
    if (version < 2) database.exec(`
      ALTER TABLE sessions ADD COLUMN source_deleted INTEGER NOT NULL DEFAULT 0 CHECK(source_deleted IN (0,1));
      CREATE INDEX sessions_retention ON sessions(last_event_at);
      CREATE TABLE scans (scope TEXT PRIMARY KEY, completed_at TEXT NOT NULL, stats TEXT NOT NULL) STRICT;
      CREATE TABLE retired_counters (scope TEXT NOT NULL, counter_key TEXT NOT NULL, PRIMARY KEY(scope,counter_key)) STRICT;
    `);
    if (version < 3) database.exec(`
      ALTER TABLE sessions ADD COLUMN retention_verified INTEGER NOT NULL DEFAULT 0 CHECK(retention_verified IN (0,1));
      CREATE TABLE exclusions (
        scope TEXT NOT NULL, identity_key TEXT NOT NULL, signature TEXT NOT NULL,
        source_keys TEXT NOT NULL, PRIMARY KEY(scope,identity_key)
      ) STRICT;
    `);
    // Derived pre-pass evidence: keyed hashes and counters only, each payload authenticated.
    if (version < 4) database.exec(`
      CREATE TABLE claude_ownership (
        scope TEXT NOT NULL, source_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        observations BLOB NOT NULL, observations_mac TEXT NOT NULL, PRIMARY KEY(scope,source_key)
      ) STRICT;
      CREATE TABLE conductor_records (
        scope TEXT NOT NULL, session_key TEXT NOT NULL, signature TEXT NOT NULL,
        payload BLOB NOT NULL, payload_mac TEXT NOT NULL, PRIMARY KEY(scope,session_key)
      ) STRICT;
    `);
    database.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export interface IndexConnection {
  database: DatabaseSync;
  secret: Buffer;
  close: () => void;
}

/** Bind all scopes and reservations to one key before choosing a scope. Legacy stores need authenticated evidence. */
function verifyKey(database: DatabaseSync, secret: Buffer, bootstrap = false): void {
  if (secret.length !== 32) throw new Error(INDEX_INTEGRITY);
  const expected = keyedHash(secret, "session-analytics:index-key-verifier:v1");
  const verifier = database.prepare("SELECT value FROM metadata WHERE key='key_verifier'").get()?.["value"];
  if (verifier !== undefined) {
    if (verifier !== expected) throw new Error(INDEX_INTEGRITY);
    return;
  }
  let authenticated = false;
  for (const { payload, mac } of database.prepare(`SELECT payload,payload_mac AS mac FROM sessions
    UNION ALL SELECT ledger,ledger_mac FROM evidence WHERE ledger IS NOT NULL`).iterate()) {
    if (typeof payload !== "string" || keyedHash(secret, payload) !== mac) throw new Error(INDEX_INTEGRITY);
    authenticated = true;
  }
  // A pruned legacy store with only keyed membership cannot prove which key created it.
  const tables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row["name"]));
  if (!authenticated && ["sessions", "evidence", "retired_counters", "exclusions", "metadata", "claude_ownership", "conductor_records"].filter((table) => tables.has(table)).some((table) =>
    Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]) > 0)) throw new Error(INDEX_INTEGRITY);
  if (bootstrap) database.prepare("INSERT INTO metadata(key,value) VALUES ('key_verifier',?)").run(expected);
}

export function openIndexDatabase(options: Pick<AnalyzeOptions, "dataDir"> = {}): IndexConnection {
  const writer = acquireWriter(options);
  let database: DatabaseSync | undefined;
  const path = join(writer.directory, "index.sqlite");
  try {
    const secretPath = join(writer.directory, "index.key");
    secureFile(secretPath);
    if (!existsSync(secretPath)) {
      // Losing the secret makes existing keyed entries unusable; never silently rotate it.
      if (existsSync(path) && statSync(path).size > 0) throw new Error(INDEX_UNAVAILABLE);
      writeFileSync(secretPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    }
    const secret = readFileSync(secretPath);
    if (secret.length !== 32) throw new Error(INDEX_UNAVAILABLE);
    database = connect(path);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const version = Number(database.prepare("PRAGMA user_version").get()?.["user_version"]);
    // Authenticate legacy stores before any migration creates new state.
    if (version > 0 && version <= SCHEMA_VERSION) verifyKey(database, secret, true);
    migrate(database);
    const check = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(INDEX_UNAVAILABLE);
    verifyKey(database, secret, true);
    secureSidecars(path);
    const opened = database;
    return { database: opened, secret, close: () => { opened.close(); secureSidecars(path); writer.release(); } };
  } catch (error) {
    database?.close(); writer.release();
    if (error instanceof Error && error.message.startsWith("The local index")) throw error;
    throw new Error(INDEX_UNAVAILABLE);
  }
}

export interface IndexScanStats {
  fingerprintedFiles: number;
  parsedSessions: number;
  reusedSessions: number;
  retainedSessions: number;
  deferredSessions: number;
  ledgerReads: number;
  ledgerHits: number;
  ledgerAppends: number;
  auditedSessions: number;
  auditedLedgers: number;
  /** Optional in scans recorded before schema 4. */
  ownershipHits?: number;
  ownershipReads?: number;
  conductorHits?: number;
  conductorReads?: number;
  auditedOwnership?: number;
  auditedConductor?: number;
  elapsedMilliseconds: number;
}

export interface IndexStatus {
  state: "ready" | "missing" | "corrupt" | "incompatible";
  schemaVersion: number | null;
  sessions: number;
  sourceDeletedSessions: number;
  evidenceFiles: number;
  scopes: number;
  databaseBytes: number;
  lastScan: ({ completedAt: string } & IndexScanStats) | null;
}

/** Status does not create a data directory, migrate, acquire the writer, or expose local paths. */
export function indexStatus(options: Pick<AnalyzeOptions, "dataDir"> = {}): IndexStatus {
  const path = indexPath(options);
  const result: IndexStatus = { state: "missing", schemaVersion: null, sessions: 0, sourceDeletedSessions: 0, evidenceFiles: 0, scopes: 0, databaseBytes: 0, lastScan: null };
  if (!existsSync(path)) return result;
  let database: DatabaseSync | undefined;
  try {
    const writerPath = join(dataDirectory(options), "writer.sqlite");
    if (existsSync(writerPath)) {
      const writerInfo = lstatSync(writerPath);
      if (!writerInfo.isFile() || writerInfo.isSymbolicLink()) throw new Error(COORDINATION_ERROR);
      const writer = new DatabaseSync(writerPath, { readOnly: true });
      try { if (writer.prepare("PRAGMA quick_check").get()?.["quick_check"] !== "ok") throw new Error(COORDINATION_ERROR); }
      finally { writer.close(); }
    }
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(INDEX_UNAVAILABLE);
    result.databaseBytes = info.size;
    database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;");
    result.schemaVersion = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (result.schemaVersion !== SCHEMA_VERSION) return { ...result, state: "incompatible" };
    if ((database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") throw new Error(INDEX_UNAVAILABLE);
    verifyKey(database, readFileSync(join(dataDirectory(options), "index.key")));
    const counts = database.prepare("SELECT count(*) AS sessions, coalesce(sum(source_deleted),0) AS deleted, count(DISTINCT scope) AS scopes FROM sessions").get() as { sessions: number; deleted: number; scopes: number };
    result.sessions = counts.sessions; result.sourceDeletedSessions = counts.deleted; result.scopes = counts.scopes;
    result.evidenceFiles = Number(database.prepare("SELECT count(*) AS count FROM evidence").get()?.["count"]);
    const scan = database.prepare("SELECT completed_at, stats FROM scans ORDER BY completed_at DESC LIMIT 1").get() as { completed_at: string; stats: string } | undefined;
    if (scan) {
      const stats = JSON.parse(scan.stats) as IndexScanStats;
      result.lastScan = {
        completedAt: scan.completed_at, fingerprintedFiles: stats.fingerprintedFiles, parsedSessions: stats.parsedSessions,
        reusedSessions: stats.reusedSessions, retainedSessions: stats.retainedSessions, ledgerReads: stats.ledgerReads,
        deferredSessions: stats.deferredSessions,
        auditedSessions: stats.auditedSessions ?? 0, auditedLedgers: stats.auditedLedgers ?? 0,
        ledgerHits: stats.ledgerHits, ledgerAppends: stats.ledgerAppends, elapsedMilliseconds: stats.elapsedMilliseconds,
      };
    }
    result.state = "ready";
  } catch { result.state = "corrupt"; }
  finally { database?.close(); }
  return result;
}

export function validatePruneDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Prune requires a valid date in YYYY-MM-DD form.");
  }
  return `${value}T00:00:00.000Z`;
}

export function pruneIndex(before: string, options: Pick<AnalyzeOptions, "dataDir"> = {}): number {
  const cutoff = validatePruneDate(before);
  const connection = openIndexDatabase(options);
  try {
    const db = connection.database;
    db.exec("BEGIN IMMEDIATE");
    // Keep only keyed membership, not old usage values, to prevent surviving broadcasts from rebilling pruned requests.
    const reserve = db.prepare("INSERT OR IGNORE INTO retired_counters(scope,counter_key) VALUES (?,?)");
    for (const row of db.prepare("SELECT scope,owned_counters FROM sessions WHERE retention_verified=1 AND last_event_at <> '' AND last_event_at < ?").all(cutoff) as Array<{ scope: string; owned_counters: string }>) {
      for (const [counter] of JSON.parse(row.owned_counters) as Array<[string, string, string | null]>) reserve.run(row.scope, keyedHash(connection.secret, counter));
    }
    db.prepare(`INSERT OR REPLACE INTO exclusions(scope,identity_key,signature,source_keys)
      SELECT scope,identity_key,signature,source_keys FROM sessions WHERE retention_verified=1 AND last_event_at <> '' AND last_event_at < ?`).run(cutoff);
    const result = db.prepare("DELETE FROM sessions WHERE retention_verified=1 AND last_event_at <> '' AND last_event_at < ?").run(cutoff);
    // Persist a monotonic retention floor so surviving provider files cannot resurrect pruned history.
    db.prepare("INSERT INTO metadata(key,value) VALUES ('prune_before',?) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value)").run(cutoff);
    db.exec("DELETE FROM evidence; DELETE FROM claude_ownership; DELETE FROM conductor_records; DELETE FROM scans; COMMIT; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
    return Number(result.changes);
  } finally { connection.close(); }
}

/** Explicit rebuild discards caches and retained history; preserve corrupt files for diagnosis. */
export function resetIndex(options: Pick<AnalyzeOptions, "dataDir"> = {}): void {
  const writer = acquireWriter(options, true);
  try {
    const path = join(writer.directory, "index.sqlite");
    secureFile(path);
    let healthy: DatabaseSync | undefined;
    try {
      if (existsSync(path)) {
        healthy = connect(path);
        const version = Number(healthy.prepare("PRAGMA user_version").get()?.["user_version"]);
        if (version > SCHEMA_VERSION) throw new Error("The local index was created by a newer version; upgrade or use --no-index.");
        migrate(healthy);
        if (healthy.prepare("PRAGMA quick_check").get()?.["quick_check"] === "ok") {
          healthy.exec("BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM evidence; DELETE FROM exclusions; DELETE FROM scans; DELETE FROM metadata; DELETE FROM retired_counters; DELETE FROM claude_ownership; DELETE FROM conductor_records; COMMIT; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
          const key = join(writer.directory, "index.key");
          secureFile(key);
          if (!existsSync(key) || readFileSync(key).length !== 32) writeFileSync(key, randomBytes(32), { mode: 0o600 });
          verifyKey(healthy, readFileSync(key), true);
          return;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The local index was created")) throw error;
      // An unreadable schema is recovered below, under the same writer lease.
    } finally { healthy?.close(); }
    const suffix = `.rebuild-${Date.now()}-${randomBytes(4).toString("hex")}`;
    for (const ending of ["", "-wal", "-shm"]) {
      secureFile(path + ending);
      if (existsSync(path + ending)) renameSync(path + ending, path + suffix + ending);
    }
    // Keep the machine secret stable across rebuilds unless it is unusable.
    const keyPath = join(writer.directory, "index.key");
    secureFile(keyPath);
    if (existsSync(keyPath) && readFileSync(keyPath).length !== 32) renameSync(keyPath, keyPath + suffix);
  } finally { writer.release(); }
}
