/** Synthetic schema-v1 Antigravity evidence. Numeric protobuf tags follow the
 * descriptor references in docs/providers.md; no local sessions are consulted. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export function proto(...entries: Array<[number, number | bigint | string | Uint8Array]>): Buffer {
  const varint = (input: number | bigint): Buffer => {
    let value = BigInt(input);
    const bytes: number[] = [];
    do { const byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value);
    return Buffer.from(bytes);
  };
  return Buffer.concat(entries.flatMap(([field, value]) => {
    if (typeof value === "number" || typeof value === "bigint") return [varint(field * 8), varint(value)];
    const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    return [varint(field * 8 + 2), varint(bytes.length), bytes];
  }));
}
export const protoTime = (at: string): Buffer => proto([1, Math.floor(Date.parse(at) / 1000)], [2, Date.parse(at) % 1000 * 1_000_000]);

export function createAntigravityDemoDatabase(path: string, id: string, cwd: string, at: string, later: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA user_version=1; CREATE TABLE trajectory_meta(trajectory_id TEXT PRIMARY KEY,cascade_id TEXT,trajectory_type INTEGER,source INTEGER); CREATE TABLE trajectory_metadata_blob(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB,step_payload BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB,size INTEGER); CREATE TABLE parent_references(idx INTEGER PRIMARY KEY,data BLOB)");
    const sentinel = "PRIVATE_DEMO_CONTENT_SENTINEL";
    db.prepare("INSERT INTO trajectory_meta VALUES (?,?,1,1)").run(`trajectory-${id}`, id);
    db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main',?)").run(proto([1, proto([1, pathToFileURL(cwd).href], [4, sentinel])], [2, protoTime(at)], [6, id]));
    const usage = proto([1, 101], [2, 1000], [3, 400], [4, 100], [5, 2000], [7, `message-${id}`], [9, 150], [10, 250], [11, `response-${id}`]);
    const insert = db.prepare("INSERT INTO steps VALUES (?,?,?,?,?)");
    insert.run(0, 14, 3, proto([1, protoTime(at)], [3, 4]), Buffer.from(sentinel));
    insert.run(1, 15, 3, proto([1, protoTime(later)], [9, usage], [12, `execution-${id}`]), Buffer.from(sentinel));
    insert.run(2, 21, 3, proto([1, protoTime(later)], [4, proto([1, `tool-${id}`], [2, "run_command"], [3, sentinel])]), Buffer.from(sentinel));
    const generation = proto([1, proto([4, usage], [9, proto([4, protoTime(later)])], [19, "claude-sonnet-5"], [21, "auto"])], [4, `execution-${id}`], [100, sentinel]);
    db.prepare("INSERT INTO gen_metadata VALUES (0,?,?)").run(generation, generation.length);
  } finally { db.close(); }
}
