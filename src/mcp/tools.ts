import type { McpArguments, McpToolName } from "./types.ts";
import { record } from "./names.ts";

export class InputError extends Error {
  constructor() { super("Invalid tool arguments. Use the published input schema; paths are not accepted."); }
}

const scope = { type: "string", enum: ["repository", "machine"], description: "Defaults to the launch repository when known, otherwise machine. Machine stays within startup repository filters." };
const repositoryId = { type: "string", pattern: "^(discovered|conductor)-[a-f0-9]{20}$", description: "A pseudonymous repository key returned by this server. Never a path or raw ID." };
const window = { type: "string", enum: ["today", "week", "7d", "30d", "90d", "all"], default: "30d", description: "UTC calendar days; week starts Monday. Whole-session metrics use the session-start cohort." };
const provider = { type: "string", enum: ["claude", "codex", "cursor", "copilot", "opencode", "gemini", "unsupported"] };
const limit = { type: "integer", minimum: 1, maximum: 50, default: 10 };
const offset = { type: "integer", minimum: 0, maximum: 100000, default: 0 };
const common = { scope, repositoryId, window, provider };
const repository = { scope: { ...scope, enum: ["repository"] }, repositoryId, window };

const definitions = [
  { name: "usage_summary", description: "Content-free totals and integrated pricing, velocity, reliability, cache, outcomes, workflow and insight evidence, grouped by repository, provider, model, or agent execution kind. API-equivalent value is not an invoice. Model groups cannot attribute turns or tools.", properties: { ...common, groupBy: { type: "string", enum: ["repository", "provider", "model", "agent"], default: "provider" }, limit, offset } },
  { name: "budget_status", description: "Today's and this UTC week's dated API-equivalent usage and elapsed-time burn rate, plus fresh recorded quota headroom when evidenced. No invoice, configured budget, or live quota lookup.", properties: { scope, repositoryId, provider } },
  { name: "repo_profile", description: "Typical value, turns and duration for this repository, tool mix, skills, cache hit rate and compactions. Medians require five eligible sessions. Repository required; duration is not a quality score.", properties: { ...repository, provider } },
  { name: "tool_stats", description: "Calls by tool and observed structured error flags, with result coverage and minimum sample guards. Missing results are unavailable, never successful calls.", properties: { ...common, limit, offset } },
  { name: "recent_sessions", description: "Recent session hashes, provider, model IDs, duration and usage value. No titles, paths, raw IDs or transcript content. Sorted by most recent evidenced activity.", properties: { ...common, limit, offset } },
  { name: "unused_extensions", description: "Installed skill and configured MCP server names without observed use in this scope and window. Partial inventory of launch context; no claim that an extension is never used or safe to remove.", properties: { ...common, limit } },
  { name: "compare_agents", description: "All observed provider metrics on one repository with the same window and explicit sample sizes. Task mix is uncontrolled; counts cannot establish quality or a winning agent.", properties: repository },
] as const;

export const toolDefinitions = definitions.map(({ name, description, properties }) => ({
  name,
  description,
  inputSchema: { type: "object", properties, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));

export function toolName(value: unknown): McpToolName | null {
  return typeof value === "string" && definitions.some(({ name }) => name === value) ? value as McpToolName : null;
}

/** This validator consumes the same descriptors published by tools/list. No schema/handler drift. */
export function validateArguments(name: McpToolName, input: unknown): McpArguments {
  const args = input === undefined ? {} : record(input);
  const definition = toolDefinitions.find((tool) => tool.name === name)!;
  if (!args) throw new InputError();
  const properties = definition.inputSchema.properties as Record<string, { type: string; enum?: readonly string[]; pattern?: string; minimum?: number; maximum?: number }>;
  for (const [key, value] of Object.entries(args)) {
    const spec = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!spec) throw new InputError();
    if (spec.type === "string") {
      if (typeof value !== "string" || (spec.enum && !spec.enum.includes(value)) || (spec.pattern && !new RegExp(spec.pattern).test(value))) throw new InputError();
    } else if (typeof value !== "number" || !Number.isSafeInteger(value) || value < spec.minimum! || value > spec.maximum!) throw new InputError();
  }
  if (args["scope"] === "machine" && args["repositoryId"] !== undefined) throw new InputError();
  return args as McpArguments;
}
