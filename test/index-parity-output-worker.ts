/** The old one-shot serialization alone exceeded a small worker heap on large histories. */
import { Writable } from "node:stream";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { writeAnalysisSnapshot } from "../src/analysis-output.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const snapshot = await analyzeMachineSessions({ ...await createSessionAnalyticsFixture(process.argv[2]!), offline: true });
const session = snapshot.sessions[0]!;
const bytesPerSession = Buffer.byteLength(JSON.stringify(session));
const count = Math.ceil(128 * 1024 * 1024 / bytesPerSession);
snapshot.sessions = [];
const expected = Buffer.byteLength(JSON.stringify(snapshot)) + count * bytesPerSession + count - 1;
snapshot.sessions = Array.from({ length: count }, () => session);
let bytes = 0;
const output = new Writable({ write(chunk, _encoding, callback) { bytes += chunk.length; callback(); } });
if (process.argv.includes("--reproduce-retention")) output.write(JSON.stringify(snapshot));
else await writeAnalysisSnapshot(snapshot, output);
if (bytes !== expected) throw new Error("Synthetic output length changed.");
process.stdout.write(JSON.stringify({ complete: true, over128MiB: bytes > 128 * 1024 * 1024 }));
