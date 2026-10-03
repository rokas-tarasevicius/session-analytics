import type { SessionAnalytics } from "../types.ts";
import { matchesSchema, snapshotSchema, type Schema } from "../interop/schema.ts";

const fail = (): never => { throw new Error("The local index contains an invalid public projection; run index rebuild."); };
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
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (blocked.has(key) || item === undefined) continue;
      if (schema.propertyNames && !matchesSchema(key, schema.propertyNames)) continue;
      const child = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key]
        : typeof schema.additionalProperties === "object" ? schema.additionalProperties : null;
      if (child) result[key] = project(item, child);
    }
    return result;
  }
  return value;
}

export function projectSession(value: SessionAnalytics): SessionAnalytics {
  const schema = snapshotSchema.$defs?.["SessionAnalytics"] ?? fail();
  const result = project(value, schema);
  if (!matchesSchema(result, { ...schema, $defs: snapshotSchema.$defs })) fail();
  return result as SessionAnalytics;
}
