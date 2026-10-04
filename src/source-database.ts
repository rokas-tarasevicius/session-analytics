/** Read external SQLite sources whose directories may be read-only. */
import { statSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const changed = "Local database changed during a guarded read.";
const generation = (path: string): string => {
  const info = statSync(path, { bigint: true });
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
};
const absent = (path: string): boolean => {
  try { statSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
};

/** Normal WAL readers stay live. Immutable fallback is limited to a proven stable,
 * sidecar-free file and checks that condition before and after every read. */
export function openSourceDatabase(path: string): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    // Opening is lazy: missing WAL sidecars can fail on the first schema read.
    database.prepare("SELECT rootpage FROM sqlite_schema LIMIT 1").get();
    return database;
  } catch (error) {
    database?.close();
    const code = (error as { errcode?: number }).errcode;
    if (code === undefined || ![8, 14].includes(code & 255)) throw error;
  }
  const before = generation(path);
  const validate = (): void => {
    try {
      if (!absent(`${path}-wal`) || !absent(`${path}-journal`) || generation(path) !== before) throw new Error(changed);
    } catch { throw new Error(changed); }
  };
  validate();
  const uri = pathToFileURL(path); uri.search = "mode=ro&immutable=1";
  const immutable = new DatabaseSync(uri.href, { readOnly: true });
  try { immutable.prepare("SELECT rootpage FROM sqlite_schema LIMIT 1").get(); validate(); }
  catch (error) { immutable.close(); throw error; }
  const statement = (prepared: StatementSync): StatementSync => new Proxy(prepared, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "iterate") return function* (...args: Parameters<StatementSync["iterate"]>) {
        validate();
        try { yield* target.iterate(...args); } finally { validate(); }
      };
      if (["all", "get", "run"].includes(String(property))) return (...args: unknown[]) => {
        validate();
        try { return Reflect.apply(value, target, args); } finally { validate(); }
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(immutable, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => { validate(); return statement(target.prepare(sql)); };
      if (property === "close" || property === Symbol.dispose) return () => { try { target.close(); } finally { validate(); } };
      const value = Reflect.get(target, property, target);
      if (property === "exec") return (sql: string) => { validate(); try { target.exec(sql); } finally { validate(); } };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
