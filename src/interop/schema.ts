import { readFileSync } from "node:fs";

interface Schema {
  $ref?: string;
  $defs?: Record<string, Schema>;
  const?: unknown;
  type?: string;
  anyOf?: Schema[];
  minimum?: number;
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
}

export const snapshotSchema: Schema = JSON.parse(readFileSync(new URL("../../schemas/snapshot.v1.schema.json", import.meta.url), "utf8"));
export const sharedSchema: Schema = JSON.parse(readFileSync(new URL("../../schemas/shared.v1.schema.json", import.meta.url), "utf8"));

/** Implements only the vocabulary emitted by our generator; not a general JSON Schema engine. */
export function matchesSchema(value: unknown, root: Schema): boolean {
  let remaining = 5_000_000;
  function matches(value: unknown, schema: Schema, depth = 0): boolean {
    if (--remaining < 0 || depth > 40) return false;
    if (schema.$ref) {
      const definition = root.$defs?.[schema.$ref.slice("#/$defs/".length)];
      return schema.$ref.startsWith("#/$defs/") && !!definition && matches(value, definition, depth + 1);
    }
    if ("const" in schema) return value === schema.const;
    if (schema.anyOf) return schema.anyOf.some((item) => matches(value, item, depth + 1));
    switch (schema.type) {
      case "null": return value === null;
      case "boolean": return typeof value === "boolean";
      case "number": return typeof value === "number" && Number.isFinite(value) && value >= (schema.minimum ?? -Infinity) && value <= Number.MAX_SAFE_INTEGER;
      case "string": return typeof value === "string" && value.length <= 4096 && (!schema.pattern || new RegExp(schema.pattern).test(value));
      case "array": return Array.isArray(value) && value.length <= 100_000 && !!schema.items && value.every((item) => matches(item, schema.items!, depth + 1));
      case "object": {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const record = value as Record<string, unknown>;
        if (schema.required?.some((key) => !Object.hasOwn(record, key))) return false;
        return Object.entries(record).every(([key, item]) => {
          if (key.length > 4096 || ["__proto__", "prototype", "constructor"].includes(key)) return false;
          const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key] : undefined;
          if (property) return matches(item, property, depth + 1);
          return typeof schema.additionalProperties === "object" && matches(item, schema.additionalProperties, depth + 1);
        });
      }
      default: return false;
    }
  }
  return matches(value, root);
}
