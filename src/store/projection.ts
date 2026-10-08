import type { SessionAnalytics } from "../types.ts";
import { matchesSchema, snapshotSchema, type Schema } from "../interop/schema.ts";
import { IndexParityError } from "./parity.ts";

const fail = (): never => { throw new IndexParityError(); };
const blocked = new Set(["__proto__", "prototype", "constructor"]);

/** Use the exhaustive public field map at every depth; unknown parser fields never reach disk. */
function project(value: unknown, schema: Schema): unknown {
  if (schema.$ref) return project(value, snapshotSchema.$defs?.[schema.$ref.slice(8)] ?? fail());
  if (schema.anyOf) {
    const selected = schema.anyOf.find((candidate) => matchesSchema(value, { ...candidate, $defs: snapshotSchema.$defs }));
    return selected ? project(value, selected) : fail();
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return fail();
    return value.map((item, index) => project(item, schema.prefixItems?.[index] ?? schema.items ?? fail()));
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const entries: Array<[string, unknown]> = [];
    for (const [key, item] of Object.entries(value)) {
      if (blocked.has(key) || item === undefined) continue;
      if (schema.propertyNames && !matchesSchema(key, schema.propertyNames)) continue;
      const child = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key]
        : typeof schema.additionalProperties === "object" ? schema.additionalProperties : null;
      if (child) entries.push([key, project(item, child)]);
    }
    // Defining a wide record one property at a time makes V8 retain a hash table
    // per object. Public sessions have many fields; construct their compact shape
    // together so indexed populations fit the same heap as full-scan populations.
    return Object.fromEntries(entries);
  }
  return value;
}

/** Index payloads written before 0.7 carried history-coverage inputs inside the removed
 * `limitsCache` projection. Carry the Claude profile and dated request tokens forward so
 * retained, source-deleted sessions keep their history attribution; everything else is dropped. */
function migrateLegacySession(value: SessionAnalytics): SessionAnalytics {
  const legacy = (value as { limitsCache?: { profileKey?: unknown; buckets?: unknown } }).limitsCache;
  if (value.provider !== "claude" || value.historyProfile || !legacy || typeof legacy.profileKey !== "string" || !Array.isArray(legacy.buckets)) return value;
  const days = new Map<string, { day: string; model: string; tokens: number }>();
  for (const bucket of legacy.buckets as Array<{ day?: unknown; model?: unknown; observedTokens?: unknown }>) {
    if (typeof bucket?.day !== "string" || typeof bucket.model !== "string" || typeof bucket.observedTokens !== "number") continue;
    const key = `${bucket.day}:${bucket.model}`, row = days.get(key) ?? { day: bucket.day, model: bucket.model, tokens: 0 };
    row.tokens += bucket.observedTokens; days.set(key, row);
  }
  return { ...value, historyProfile: { profileKey: legacy.profileKey, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model)) } };
}

export function projectSession(value: SessionAnalytics): SessionAnalytics {
  value = migrateLegacySession(value);
  const schema = snapshotSchema.$defs?.["SessionAnalytics"] ?? fail();
  const result = project(value, schema);
  if (!matchesSchema(result, { ...schema, $defs: snapshotSchema.$defs })) fail();
  return result as SessionAnalytics;
}

/** A validated parser result is already the public projection. Keep its compact
 * object graph instead of rebuilding every occupied metric cell twice on ingest.
 * Custom prototypes, accessors and serialization hooks still take the copying
 * allowlist path, as do parser objects containing any additional private field. */
export function sessionForIndex(value: SessionAnalytics): SessionAnalytics {
  let remaining = 20_000_000;
  const visiting = new Set<object>();
  const checked = new WeakSet<object>();
  const plainJson = (item: unknown, depth = 0): boolean => {
    if (--remaining < 0 || depth > 40) return false;
    if (item === null || typeof item !== "object") return typeof item !== "function" && typeof item !== "symbol" && typeof item !== "bigint";
    if (visiting.has(item)) return false;
    if (checked.has(item)) return true;
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    visiting.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || blocked.has(key) || key === "toJSON" || (array && !/^(?:0|[1-9]\d*)$/.test(key))) return false;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") || !plainJson(descriptor.value, depth + 1)) return false;
    }
    visiting.delete(item); checked.add(item);
    return true;
  };
  const schema = snapshotSchema.$defs?.["SessionAnalytics"] ?? fail();
  return plainJson(value) && matchesSchema(value, { ...schema, $defs: snapshotSchema.$defs }) ? value : projectSession(value);
}
