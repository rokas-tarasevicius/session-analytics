/** Durable, content-free source generations spanning scans AND oracle execution. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { changedEvidence, evidenceGenerations } from './parity-evidence.ts';
import type { AnalyzeOptions } from '../src/types.ts';

export interface SourceGeneration {
  phase: string;
  capturedAt: string;
  sessions: [string, string][];
}
export async function captureSourceGeneration(directory: string, phase: string, options: AnalyzeOptions): Promise<SourceGeneration> {
  const generation = { phase, capturedAt: new Date().toISOString(), sessions: [...await evidenceGenerations(options)].sort(([a], [b]) => a.localeCompare(b)) };
  await writeFile(join(directory, `sources-${phase}.json`), JSON.stringify(generation), { mode: 0o600 });
  return generation;
}
export function changedSourceSessions(generations: SourceGeneration[]): Set<string> {
  if (generations.length < 2) throw new Error('Complete source generations unavailable.');
  for (const generation of generations) {
    if (!Number.isFinite(Date.parse(generation.capturedAt)) || !Array.isArray(generation.sessions) ||
        new Set(generation.sessions.map(row => row[0])).size !== generation.sessions.length ||
        generation.sessions.some(row => !Array.isArray(row) || row.length !== 2 || !/^[a-f0-9]{12}$/.test(row[0]) || !/^[a-f0-9]{64}$/.test(row[1]))) {
      throw new Error('Valid source generations unavailable.');
    }
  }
  return changedEvidence(...generations.map(g => new Map(g.sessions)));
}
export async function readSourceGenerations(directory: string): Promise<SourceGeneration[]> {
  const phases = ['full-before', 'full-after', 'cold-before', 'cold-after', 'warm-before', 'warm-after', 'oracles-after'];
  return Promise.all(phases.map(async phase => {
    const value = JSON.parse(await readFile(join(directory, `sources-${phase}.json`), 'utf8')) as SourceGeneration;
    if (value.phase !== phase) throw new Error('Source generation phase mismatch.');
    return value;
  }));
}
