/** Synthetic dense public sessions exercise warm-cache loading without source content. */
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { openIndexDatabase } from "../src/store/database.ts";
import { keyedHash } from "../src/store/fingerprint.ts";
import { IndexScan } from "../src/store/index.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const root = process.argv[2]!;
const fixture = await createSessionAnalyticsFixture(root);
const session = (await analyzeMachineSessions({ ...fixture, offline: true })).sessions.find((s) => s.provider === "codex")!;
session.tools = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`synthetic_tool_${i}`, 1]));
session.transportTools = { ...session.tools };
const options = { ...fixture, noIndex: false };
const rates = { currency: "USD" as const, effectiveDate: "2026-07-20", models: {} };
const seed = (await IndexScan.open(options, rates, true))!;
await seed.commit(); seed.close();
const connection = openIndexDatabase(options);
let previousRows: unknown[] = [];
try {
  const scope = String(connection.database.prepare("SELECT scope FROM scans").get()!["scope"]);
  const insert = connection.database.prepare(`INSERT INTO sessions(scope,identity_key,signature,payload,payload_mac,source_keys,root_key,remote_key,owned_counters,last_event_at,retention_verified)
    VALUES (?,?,?,?,?,'[]','','','[]','2026-07-20T00:00:00Z',1)`);
  connection.database.exec("BEGIN");
  for (let i = 0; i < 400; i++) {
    session.sessionKey = i.toString(16).padStart(12, "0");
    const payload = JSON.stringify(session);
    insert.run(scope, i.toString(16).padStart(64, "0"), "", payload, keyedHash(connection.secret, payload));
  }
  connection.database.exec("COMMIT");
  if (process.argv.includes("--reproduce-retention")) previousRows = connection.database.prepare("SELECT * FROM sessions").all();
} finally { connection.close(); }
const index = (await IndexScan.open(options, rates, true))!;
index.close();
process.stdout.write(JSON.stringify({ sessions: 400, previousRows: previousRows.length }));
