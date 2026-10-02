import { InteropError } from "./error.ts";
import type { MachineAnalytics, SharedSnapshot } from "../types.ts";
import { readJsonFile } from "./files.ts";
import { matchesSchema, snapshotSchema } from "./schema.ts";
import { validateSharedSnapshot } from "./sharing.ts";
import { filterSnapshot } from "../public/export-data.js";

export function validateSnapshot(value: unknown): MachineAnalytics {
  const fail = (): never => { throw new InteropError("Snapshot is invalid, inconsistent, or unsupported."); };
  if (!matchesSchema(value, snapshotSchema)) fail();
  const snapshot = value as MachineAnalytics;
  const date = (value: string) => /^\d{4}-\d\d-\d\d[T ]/.test(value) && Number.isFinite(Date.parse(value));
  if (!date(snapshot.generatedAt)) fail();
  const repositories = new Map(snapshot.repositories.map(({ repository }) => [repository.id, repository.name]));
  if (repositories.size !== snapshot.repositories.length) fail();
  const sessions = new Set<string>();
  for (const session of snapshot.sessions) {
    const key = `${session.provider}:${session.sessionKey}`;
    if (sessions.has(key) || !/^[a-f0-9]{12}$/.test(session.sessionKey) || repositories.get(session.repositoryId) !== session.repositoryName) fail();
    if (![session.createdAt, session.updatedAt, session.firstEventAt, session.lastEventAt].every((value) => value === null || date(value))) fail();
    if (session.pricedTokenCoverage !== null && session.pricedTokenCoverage > 1) fail();
    if (new Set(session.models.map(({ model }) => model)).size !== session.models.length) fail();
    if (Object.keys(session.spendByDay).some((day) => !/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(Date.parse(day)))) fail();
    sessions.add(key);
  }
  const recomputed = filterSnapshot(snapshot);
  const consistent = (actual: object, expected: object): boolean => Object.entries(expected).every(([key, value]) => {
    const got = (actual as Record<string, unknown>)[key];
    return typeof value === "number" && typeof got === "number" ? Math.abs(value - got) <= 1e-8 * Math.max(1, value) : value === got;
  });
  if (!consistent(snapshot.summary, recomputed.summary)) fail();
  for (let index = 0; index < snapshot.repositories.length; index++) {
    if (!consistent(snapshot.repositories[index]!.summary, recomputed.repositories[index]!.summary)) fail();
  }
  return snapshot;
}

export async function loadSnapshot(path: string): Promise<MachineAnalytics | SharedSnapshot> {
  try {
    const value = await readJsonFile(path);
    return value && typeof value === "object" && "kind" in value ? validateSharedSnapshot(value) : validateSnapshot(value);
  } catch { throw new InteropError("Snapshot file is invalid, unsupported, or unavailable."); }
}

export async function loadMachineSnapshot(path: string): Promise<MachineAnalytics> {
  const snapshot = await loadSnapshot(path);
  if ("kind" in snapshot) throw new InteropError("This command requires a full snapshot, not a shared aggregate.");
  return snapshot;
}
