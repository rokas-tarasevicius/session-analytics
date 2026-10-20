import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openSourceDatabase } from "../../src/source-database.ts";

const permissionSkip = process.platform === "win32" || process.getuid?.() === 0;
function fixture(run: (path: string, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "source-db-")), path = join(directory, "PRIVATE source.sqlite");
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(n INTEGER); INSERT INTO evidence VALUES(7),(9)");
  writer.close();
  assert.equal(existsSync(`${path}-wal`), false);
  chmodSync(directory, 0o555);
  try { run(path, directory); }
  finally { chmodSync(directory, 0o755); rmSync(directory, { recursive: true, force: true }); }
}

test("sidecar-free WAL source in a read-only directory is readable without modifying the source", { skip: permissionSkip }, () => fixture(path => {
  const plain = new DatabaseSync(path, { readOnly: true });
  try { assert.throws(() => plain.prepare("SELECT n FROM evidence").get()); }
  finally { plain.close(); }
  const reader = openSourceDatabase(path);
  try {
    assert.equal(reader.prepare("SELECT sum(n) total FROM evidence").get()?.["total"], 16);
    assert.deepEqual(reader.prepare("SELECT n FROM evidence ORDER BY n").all().map(row => row["n"]), [7, 9]);
    assert.deepEqual([...reader.prepare("SELECT n FROM evidence ORDER BY n").iterate()].map(row => row["n"]), [7, 9]);
  } finally { reader.close(); }
  assert.equal(existsSync(`${path}-wal`), false);
  assert.equal(existsSync(`${path}-shm`), false);
}));

test("immutable source fallback rejects a newly appeared WAL before returning stale counters", { skip: permissionSkip }, () => fixture((path, directory) => {
  const reader = openSourceDatabase(path), statement = reader.prepare("SELECT count(*) n FROM evidence");
  chmodSync(directory, 0o755);
  const writer = new DatabaseSync(path);
  try {
    writer.exec("INSERT INTO evidence VALUES(11)");
    assert.throws(() => statement.get(), { message: "Local database changed during a guarded read." });
    assert.throws(() => reader.close(), { message: "Local database changed during a guarded read." });
  } finally { writer.close(); }
}));

test("immutable source fallback checks generation after an interrupted iterator", { skip: permissionSkip }, () => fixture((path, directory) => {
  const reader = openSourceDatabase(path), iterator = reader.prepare("SELECT n FROM evidence ORDER BY n").iterate();
  assert.equal(iterator.next().value?.["n"], 7);
  chmodSync(directory, 0o755);
  const replacement = join(directory, "replacement.sqlite"), writer = new DatabaseSync(replacement);
  writer.exec("CREATE TABLE evidence(n INTEGER);INSERT INTO evidence VALUES(13)"); writer.close();
  copyFileSync(replacement, path);
  assert.throws(() => iterator.return?.(), { message: "Local database changed during a guarded read." });
  assert.throws(() => reader.close(), { message: "Local database changed during a guarded read." });
}));

test("immutable source fallback checks each iterator read before yielding counters", { skip: permissionSkip }, () => fixture((path, directory) => {
  const reader = openSourceDatabase(path), iterator = reader.prepare("SELECT n FROM evidence ORDER BY n").iterate();
  assert.equal(iterator.next().value?.["n"], 7);
  chmodSync(directory, 0o755);
  const writer = new DatabaseSync(path);
  try {
    writer.exec("INSERT INTO evidence VALUES(11)");
    assert.throws(() => iterator.next(), { message: "Local database changed during a guarded read." });
  } finally {
    try { iterator.return?.(); } catch { /* A changed source also invalidates early iterator cleanup. */ }
    assert.throws(() => reader.close(), { message: "Local database changed during a guarded read." });
    writer.close();
  }
}));

test("ordinary live WAL sources keep committed WAL counters visible", () => {
  const directory = mkdtempSync(join(tmpdir(), "source-live-db-")), path = join(directory, "source.sqlite");
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode=WAL;CREATE TABLE evidence(n);INSERT INTO evidence VALUES(1)");
  const reader = openSourceDatabase(path);
  try {
    assert.equal(reader.prepare("SELECT count(*) n FROM evidence").get()?.["n"], 1);
    writer.exec("INSERT INTO evidence VALUES(2)");
    assert.equal(reader.prepare("SELECT count(*) n FROM evidence").get()?.["n"], 2);
  } finally { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); }
});
