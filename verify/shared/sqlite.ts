/** Independent read-only SQLite transport; no analyzer implementation imports. */
import { DatabaseSync as NativeDatabase } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
type ReadProof = { path: string; before: string; closed?: boolean; unchanged?: boolean };
const immutableReads: ReadProof[] = [];
const generation = (path: string): string => { const s = statSync(path, { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':'); };
const absent = (path: string): boolean => { try { statSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; } };
const noPendingWrites = (path: string): boolean => absent(path + '-wal') && absent(path + '-journal');
/** Immutable mode may bypass unavailable sidecar creation only for a stable base file. */
export class DatabaseSync extends NativeDatabase {
  private readonly proof?: ReadProof;
  constructor(input: ConstructorParameters<typeof NativeDatabase>[0], options?: ConstructorParameters<typeof NativeDatabase>[1]) {
    const path = input instanceof URL ? fileURLToPath(input) : typeof input === 'string' && !input.startsWith('file:') ? input : null;
    if (path && options?.readOnly === true && noPendingWrites(path)) {
      const before = generation(path), uri = pathToFileURL(path); uri.search = 'mode=ro&immutable=1';
      super(uri.href, options);
      this.proof = { path, before }; immutableReads.push(this.proof);
    } else super(input, options);
  }
  override close(): void {
    const proof=this.proof;
    if(!proof){super.close();return;}
    let unchanged=false;try{unchanged=proof.before===generation(proof.path)&&noPendingWrites(proof.path);}catch{/* Proof remains false. */}
    super.close();
    try{unchanged&&=proof.before===generation(proof.path)&&noPendingWrites(proof.path);}catch{unchanged=false;}
    proof.closed=true;proof.unchanged=unchanged;
    if(!unchanged){process.exitCode=3;throw new Error('Oracle database changed during read.');}
  }
}
process.on('exit', () => {
  const proofs = immutableReads.map(({ path, before, closed, unchanged: closedProof }) => {
    let unchanged = closed ? closedProof === true : false; try { if(!closed) unchanged = before === generation(path) && noPendingWrites(path); } catch { /* Unavailable source fails the proof. */ }
    return { databaseKey: createHash('sha256').update(path).digest('hex').slice(0, 12), mode: 'readonly-immutable-without-wal-or-journal', unchanged };
  });
  if (proofs.some(p => !p.unchanged)) process.exitCode = 3;
  if (proofs.length && process.env['SESSION_ANALYTICS_VERIFY_REFERENCE']) {
    const file = basename(process.argv[1] ?? 'oracle').replace(/[^A-Za-z0-9_.-]/g, '_');
    try { writeFileSync(join('.lane', `sqlite-proof-${file}.json`), JSON.stringify({ proofs }), { mode: 0o600 }); } catch { process.exitCode = 3; }
  }
});
