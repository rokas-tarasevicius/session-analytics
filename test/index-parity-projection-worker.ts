/** A large synthetic population must fit without changing the public projection. */
import assert from "node:assert/strict";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { projectSession } from "../src/store/projection.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const fixture = await createSessionAnalyticsFixture(process.argv[2]!);
const session = (await analyzeMachineSessions({ ...fixture, offline: true })).sessions.find((s) => s.provider === "codex")!;
const sessions = Array.from({ length: 5000 }, () => projectSession(session));
assert.deepEqual(sessions.at(-1), JSON.parse(JSON.stringify(session)));
process.stdout.write(JSON.stringify({ sessions: sessions.length }));
