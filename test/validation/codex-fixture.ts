import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeMachineSessions } from '../../src/analyzer.ts';
export const timestamp = (second: number) => new Date(Date.UTC(2026, 6, 1, 0, 0, second)).toISOString();
export const usage = (input: number, output: number, cached = 0, reasoning = 0) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
export const counter = (second: number, total: ReturnType<typeof usage>, last?: ReturnType<typeof usage>) => ({ type: 'event_msg', timestamp: timestamp(second), payload: { type: 'token_count', info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}) } } });
export const context = (second: number, model = 'gpt-5.6-sol') => ({ type: 'turn_context', timestamp: timestamp(second), payload: { model } });
export const response = (second: number, id = 'synthetic-response') => ({ type: 'response_item', timestamp: timestamp(second), payload: { type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text: 'SYNTHETIC-CONTENT-SENTINEL' }] } });
export async function fixture(run: (f: { root: string; write: (id: string, records: unknown[], metadata?: Record<string, unknown>) => Promise<void>; analyze: () => ReturnType<typeof analyzeMachineSessions> }) => Promise<void>): Promise<void> {
 const root = await mkdtemp(join(tmpdir(), 'codex-validation-'));
 const sessions = join(root, 'sessions');
 await mkdir(sessions);
 try {
  await run({root, write: async(id, records, metadata = {}) => {
   await writeFile(join(sessions, `rollout-${id}.jsonl`), [{type:'session_meta', timestamp:typeof metadata.timestamp==='string'?metadata.timestamp:timestamp(0), payload:{id, cwd:root, source:'cli', ...metadata}}, ...records].map(r=>JSON.stringify(r)).join('\n')+'\n');
  }, analyze: () => analyzeMachineSessions({ noIndex:true, additionalProviders:false, pricingPolicy:'reviewed-only', dataDir:join(root,'data'), codexRoot:sessions, codexArchiveRoot:join(root,'absent-archive'), claudeRoot:join(root,'absent-claude'), cursorDatabasePath:join(root,'absent-cursor'), databasePath:join(root,'absent-conductor') })});
 } finally { await rm(root, {recursive:true, force:true}); }
}
