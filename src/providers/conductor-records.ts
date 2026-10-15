import type { DatabaseSync, StatementSync } from "node:sqlite";

// SQLite performs the content boundary: prose, reasoning, arguments and results
// are never returned in JavaScript row objects. Every JSON path here is static.
const pick = (source: string, path: string, keys: string[]) =>
  keys.flatMap((key) => [`'${key}'`, `json_extract(${source}, '${path}.${key}')`]).join(", ");
const usage = (source: string, path: string) => `json_object(${pick(source, path,
  ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])},
  'cache_creation', json_object(${pick(source, `${path}.cache_creation`, ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"])}),
  'output_tokens_details', json_object(${pick(source, `${path}.output_tokens_details`, ["thinking_tokens"])}))`;

/**
 * One Conductor session's records, bound as `{ session }`. A named parameter, because Node.js before 24.7 binds
 * positional arguments to `?` only and fails on the `?1` both representations would share.
 */
export function conductorRecords(database: DatabaseSync): StatementSync | null {
  const columns = new Set((database.prepare("PRAGMA table_info(session_messages)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!["session_id", "id", "content"].every((key) => columns.has(key))) return null;
  const column = (key: string) => columns.has(key) ? key : `NULL AS ${key}`;
  const sources = ["content", ...(columns.has("full_message") ? ["full_message"] : [])];
  const sql = sources.map((source, representation) => `SELECT id, ${column("created_at")}, ${column("sdk_message_id")},
    ${representation} representation, CASE WHEN json_valid(${source}) THEN ${source} ELSE '{}' END d
    FROM session_messages WHERE session_id = :session`).join(" UNION ALL ");
  return database.prepare(`WITH records AS (${sql})
    SELECT id, created_at, sdk_message_id, json_object(
      ${pick("d", "$", ["type", "subtype", "uuid", "session_id", "new_conversation_id", "claude_code_version", "timestamp", "parent_tool_use_id", "isSidechain", "agentId", "requestId", "effort"])},
      'message', json_object(${pick("d", "$.message", ["id", "model"])}, 'usage', CASE WHEN json_type(d, '$.message.usage') = 'object' THEN ${usage("d", "$.message.usage")} END),
      'tools', json((SELECT json_group_array(json_object(${pick("CASE WHEN t.type = 'object' THEN t.value ELSE '{}' END", "$", ["id", "name"])}))
        FROM json_each(CASE WHEN json_type(d, '$.message.content') = 'array' THEN json_extract(d, '$.message.content') ELSE '[]' END) t
        WHERE json_extract(CASE WHEN t.type = 'object' THEN t.value ELSE '{}' END, '$.type') = 'tool_use')),
      ${pick("d", "$", ["total_cost_usd", "num_turns", "duration_ms", "duration_api_ms", "is_error", "terminal_reason"])},
      'conductor_sdk_metadata', json_object('marginalCostUsd', json_extract(d, '$.conductor_sdk_metadata.marginalCostUsd')),
      'permission_denials_count', CASE WHEN json_type(d, '$.permission_denials') = 'array' THEN json_array_length(d, '$.permission_denials') END,
      'usage', CASE WHEN json_type(d, '$.usage') = 'object' THEN ${usage("d", "$.usage")} END,
      'modelUsage', CASE WHEN json_type(d, '$.modelUsage') = 'object' THEN json((SELECT json_group_object(m.key, json_object(${pick("CASE WHEN m.type = 'object' THEN m.value ELSE '{}' END", "$",
        ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "costUSD"])}))
        FROM json_each(CASE WHEN json_type(d, '$.modelUsage') = 'object' THEN json_extract(d, '$.modelUsage') ELSE '{}' END) m)) END
    ) data FROM records
    WHERE json_extract(d, '$.type') IN ('assistant', 'result', 'system', 'conversation_reset')
    ORDER BY created_at, id, representation`);
}

/** Change evidence for one session's cached projection, without parsing message JSON.
 * Conductor inserts one row per SDK message and later updates rows in place: it fills
 * `full_message` and `sdk_message_id`, and sets `sent_at`/`cancelled_at`, which the
 * projection never reads. Membership (count, rowid sum and maximum) catches inserts and
 * deletes; rowid-weighted byte lengths of every projected column catch in-place fills and
 * edits that change a value's size. Lengths come from SQLite record headers, so message
 * content is never parsed. Returns null when the table cannot be signed (no rowid). */
export function conductorSignature(database: DatabaseSync): ((sessionId: string) => unknown) | null {
  const columns = new Set((database.prepare("PRAGMA table_info(session_messages)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!["session_id", "id", "content"].every((key) => columns.has(key))) return null;
  const lengths = ["id", "content", "full_message", "created_at", "sdk_message_id"].filter((key) => columns.has(key))
    .map((key) => `count(${key}), sum(octet_length(${key})), total(rowid * octet_length(${key}))`);
  const times = columns.has("created_at") ? ", min(created_at), max(created_at)" : "";
  let statement: StatementSync;
  try { statement = database.prepare(`SELECT count(*), max(rowid), sum(rowid), ${lengths.join(", ")}${times} FROM session_messages WHERE session_id = ?`); }
  catch { return null; }
  const shape = [...columns].sort();
  return (sessionId) => [shape, Object.values(statement.get(sessionId) ?? {})];
}
