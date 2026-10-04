/** Synthetic broadcast fan-out. The normal test never retains the returned per-file objects. */
import { link, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IndexScan } from "../src/store/index.ts";
import type { CodexLedgerEvidence } from "../src/store/codex-ledger.ts";

const root = process.argv[2]!;
await mkdir(join(root, "sources"), { recursive: true });
const source = join(root, "sources", "original.jsonl");
const records = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ type: "event_msg", timestamp: "2026-07-20T10:00:00Z", payload: {
  type: "token_count", info: { total_token_usage: { input_tokens: (i + 1) * 100 }, last_token_usage: { input_tokens: 100 } },
} }));
await writeFile(source, records.join("\n") + "\n");
const paths = Array.from({ length: 600 }, (_, i) => join(root, "sources", `${i}.jsonl`));
for (const path of paths) await link(source, path);
const index = await IndexScan.open({ dataDir: join(root, "index"), noIndex: false }, { currency: "USD", effectiveDate: "2026-07-20", models: {} }, true);
if (!index) throw new Error("Synthetic index was not opened.");
// Used only to reproduce the old memory lifetime without changing a running real-data worker.
const retained: CodexLedgerEvidence[] = [];
try {
  for (const path of paths) {
    const evidence = await index.codexLedger(path);
    if (process.argv.includes("--reproduce-retention")) retained.push(evidence);
    if (evidence.observations.length !== 1000) throw new Error("Incomplete synthetic ledger.");
  }
  index.setCounterDependencies(new Map());
  process.stdout.write(JSON.stringify({ files: paths.length, ledgerReads: index.stats.ledgerReads }));
} finally { index.close(); }
