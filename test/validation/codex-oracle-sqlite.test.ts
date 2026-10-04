import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync as NativeDatabase } from 'node:sqlite';
import test from 'node:test';
import { DatabaseSync as OracleDatabase } from '../../verify/shared/sqlite.ts';

test('Codex correlation oracle reads committed WAL rows instead of silently using the older base file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-oracle-wal-'));
  const path = join(root, 'synthetic.db'), writer = new NativeDatabase(path);
  try {
    writer.exec('CREATE TABLE counts(n INTEGER); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO counts VALUES (11),(17)');
    const uri = pathToFileURL(path); uri.search = 'mode=ro&immutable=1';
    const stale = new NativeDatabase(uri.href, { readOnly: true });
    try { assert.equal(stale.prepare('SELECT count(*) AS n FROM counts').get()!['n'], 0, 'old immutable transport omits committed WAL changes'); }
    finally { stale.close(); }
    const current = new OracleDatabase(path, { readOnly: true });
    try {
      assert.equal(current.prepare('SELECT count(*) AS n FROM counts').get()!['n'], 2);
      assert.equal(current.prepare('SELECT sum(n) AS n FROM counts').get()!['n'], 28);
    } finally { current.close(); }
  } finally { writer.close(); await rm(root, { recursive: true, force: true }); }
});
