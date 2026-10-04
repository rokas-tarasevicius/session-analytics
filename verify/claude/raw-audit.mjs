/** Independent content-free census. No analyzer imports; never emits raw IDs or paths. */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { lfLines } from '../shared/lf-lines.mjs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Provider I/O failures can carry private filenames. Never let a raw exception
// escape this standalone audit process.
process.setUncaughtExceptionCaptureCallback(() => { console.error('Claude raw audit failed; private error details suppressed.'); process.exit(1); });

const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
const number = x => typeof x === 'number' && Number.isFinite(x) ? x : 0;
const dimensions = ['input', 'cacheRead', 'cacheWrite', 'output', 'thinking', 'cache5m', 'cache1h'];
const zero = () => Object.fromEntries(dimensions.map(k => [k, 0]));
function usage(u) {
  return { input: number(u.input_tokens), cacheRead: number(u.cache_read_input_tokens),
    cacheWrite: number(u.cache_creation_input_tokens), output: number(u.output_tokens),
    thinking: number(u.output_tokens_details?.thinking_tokens),
    cache5m: number(u.cache_creation?.ephemeral_5m_input_tokens),
    cache1h: number(u.cache_creation?.ephemeral_1h_input_tokens) };
}
function add(a, b, factor = 1) { for (const k of dimensions) a[k] += b[k] * factor; return a; }
const count = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };
const latest = (a, b) => (b.output > a.output ? b : a);

const home = os.homedir();
const candidates = (await fs.readdir(home, { withFileTypes: true }))
  .filter(x => (x.isDirectory() || x.isSymbolicLink()) && x.name.startsWith('.claude'))
  .map(x => ({ location: path.join(home, x.name, 'projects'), kind: 'profile' }));
candidates.push({ location: path.join(home, '.config/claude/projects'), kind: 'config' });
candidates.push({ location: path.join(home, 'Library/Application Support/Claude/local-agent-mode-sessions'), kind: 'desktop' });
if (process.env.CLAUDE_CONFIG_DIR) candidates.push({ location: path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), kind: 'env' });
const roots = []; const realRoots = new Set();
for (const candidate of candidates) {
  try { const p = await fs.realpath(candidate.location); if (!realRoots.has(p)) { roots.push({ ...candidate, location: p }); realRoots.add(p); } } catch {}
}
const cutoff = process.env.ORACLE_CUTOFF ?? '2026-10-03T12:17:26.745Z';
const summary = { format: 1, cutoff, roots: [], files: 0, bytes: 0, lines: 0, malformed: 0,
  recordTypes: {}, assistantRecords: 0, usageRecords: 0, usageFields: {}, sidechainUsageRecords: 0,
  syntheticUsageRecords: 0, syntheticNonzeroUsageRecords: 0, apiErrorUsageRecords: 0, apiErrorNonzeroUsageRecords: 0,
  thinkingUsageRecords: 0, cacheSplitRecords: 0, cacheSplitMismatchRecords: 0,
  syntheticUsage: zero(), apiErrorUsage: zero(), fileKinds: {}, liveFiles: 0,
  duplicateMessageGroups: [], requestGroupsWithMultipleMessages: [], differingSnapshotGroups: [],
  iterationGroups: [], iterationLengthRecords: {}, fallbackCreditKinds: {},
  iterationRetainedCounts: {}, singleIterationMatches: 0, singleIterationModelPresent: 0,
  missingThinking: { messages: 0, output: 0 }, missingThinkingByParent: {},
  fileSummaries: [], usageByFile: zero(), usageGloballyUnique: zero(), duplicateUsage: zero() };
const allMessages = new Map(); const requests = new Map(); const physicalFiles = new Set();
let anonymous = 0;

async function walk(root, result = []) {
  let entries; try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return result; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) await walk(full, result);
    else if (e.isFile() && e.name.endsWith('.jsonl')) result.push(full);
  }
  return result;
}
for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
  const root = roots[rootIndex]; const locations = await walk(root.location);
  summary.roots.push({ rootIndex, kind: root.kind, files: locations.length });
  for (const location of locations) {
    const physical = await fs.realpath(location); if (physicalFiles.has(physical)) continue; physicalFiles.add(physical);
    const fileKey = hash(physical);
    const relativeParts = path.relative(root.location, location).split(path.sep);
    const subagentAncestor = relativeParts.indexOf('subagents');
    const isSubagent = subagentAncestor >= 0;
    const stat = await fs.stat(location); summary.bytes += stat.size; summary.files++;
    const file = { fileKey, rootIndex, isSubagent, desktop: root.kind === 'desktop', bytes: stat.size,
      providerSessionKey: hash(`claude:${path.basename(location, '.jsonl')}`), recordTypes: {},
      parentProviderSessionKey: hash(`claude:${isSubagent ? relativeParts[subagentAncestor - 1] : path.basename(location, '.jsonl')}`),
      firstTimestamp: null, lastTimestamp: null, usageMessages: 0, usage: zero(), maxComponentUsage: zero(),
      sidechainRecords: 0, sessionIdCount: 0, compactions: 0 };
    const sessionIds = new Set(); const localMessages = new Map();
    for await (const line of lfLines(createReadStream(location))) {
      summary.lines++; if (!line.trim()) continue;
      let rec; try { rec = JSON.parse(line); } catch { summary.malformed++; continue; }
      const type = typeof rec.type === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(rec.type) ? rec.type : 'unknown';
      count(summary.recordTypes, type); count(file.recordTypes, type);
      if (typeof rec.sessionId === 'string') sessionIds.add(rec.sessionId);
      const stamp = typeof rec.timestamp === 'string' && Number.isFinite(Date.parse(rec.timestamp)) ? new Date(rec.timestamp).toISOString() : null;
      if (stamp && (!file.firstTimestamp || stamp < file.firstTimestamp)) file.firstTimestamp = stamp;
      if (stamp && (!file.lastTimestamp || stamp > file.lastTimestamp)) file.lastTimestamp = stamp;
      if (rec.isSidechain) file.sidechainRecords++;
      if (rec.type === 'system' && rec.subtype === 'compact_boundary') file.compactions++;
      if (rec.type !== 'assistant') continue;
      summary.assistantRecords++;
      const msg = rec.message; if (!msg?.usage || typeof msg.usage !== 'object') continue;
      summary.usageRecords++;
      for (const k of Object.keys(msg.usage)) if (/^[a-zA-Z0-9_-]{1,100}$/.test(k)) count(summary.usageFields, k);
      const u = usage(msg.usage); const nonzero = Object.values(u).some(v => v !== 0);
      const iterations = Array.isArray(msg.usage.iterations) ? msg.usage.iterations.map(value => ({
        type: ['message', 'fallback_message'].includes(value?.type) ? value.type : 'other',
        model: typeof value?.model === 'string' && /^[a-zA-Z0-9_<>:.+/-]{1,100}$/.test(value.model) ? value.model : '<unknown>',
        usage: usage(value ?? {}), reasoningExposed: typeof value?.output_tokens_details?.thinking_tokens === 'number',
      })) : [];
      count(summary.iterationLengthRecords, iterations.length);
      count(summary.fallbackCreditKinds, !Object.hasOwn(msg.usage, 'fallback_credit') ? 'absent' : msg.usage.fallback_credit === null ? 'null' : typeof msg.usage.fallback_credit);
      if (rec.isSidechain) summary.sidechainUsageRecords++;
      if (msg.model === '<synthetic>') { summary.syntheticUsageRecords++; add(summary.syntheticUsage, u); if (nonzero) summary.syntheticNonzeroUsageRecords++; }
      if (rec.isApiErrorMessage) { summary.apiErrorUsageRecords++; add(summary.apiErrorUsage, u); if (nonzero) summary.apiErrorNonzeroUsageRecords++; }
      if (u.thinking) summary.thinkingUsageRecords++;
      if (msg.usage.cache_creation) { summary.cacheSplitRecords++; if (u.cacheWrite !== u.cache5m + u.cache1h) summary.cacheSplitMismatchRecords++; }
      const id = typeof msg.id === 'string' && msg.id ? msg.id : `anonymous-${anonymous++}`;
      let local = localMessages.get(id);
      if (!local) {
        local = { fileKey, rootIndex, isSubagent, desktop: root.kind === 'desktop',
          providerSessionKey: file.providerSessionKey, recordCount: 0, sidechainRecords: 0,
          parentProviderSessionKey: file.parentProviderSessionKey,
          usage: u, minUsage: { ...u }, maxUsage: { ...u }, signatures: new Set(), models: new Set(),
          iterations, reasoningExposed: typeof msg.usage.output_tokens_details?.thinking_tokens === 'number',
          fallbackCredit: typeof msg.usage.fallback_credit === 'number' ? msg.usage.fallback_credit : null,
          timestamp: stamp, minTimestamp: stamp, maxTimestamp: stamp, apiError: false, synthetic: false };
        localMessages.set(id, local);
      }
      local.recordCount++; if (rec.isSidechain) local.sidechainRecords++;
      if (typeof msg.model === 'string' && /^[a-zA-Z0-9_<>:.+/-]{1,100}$/.test(msg.model)) local.models.add(msg.model);
      local.apiError ||= !!rec.isApiErrorMessage; local.synthetic ||= msg.model === '<synthetic>';
      local.signatures.add(JSON.stringify(u));
      if (u.output > local.usage.output) {
        local.usage = u; local.timestamp = stamp; local.iterations = iterations;
        local.reasoningExposed = typeof msg.usage.output_tokens_details?.thinking_tokens === 'number';
        local.fallbackCredit = typeof msg.usage.fallback_credit === 'number' ? msg.usage.fallback_credit : null;
      }
      for (const k of dimensions) { local.minUsage[k] = Math.min(local.minUsage[k], u[k]); local.maxUsage[k] = Math.max(local.maxUsage[k], u[k]); }
      if (stamp && (!local.minTimestamp || stamp < local.minTimestamp)) local.minTimestamp = stamp;
      if (stamp && (!local.maxTimestamp || stamp > local.maxTimestamp)) local.maxTimestamp = stamp;
      if (typeof rec.requestId === 'string' && rec.requestId) {
        let set = requests.get(rec.requestId); if (!set) { set = new Set(); requests.set(rec.requestId, set); } set.add(id);
      }
    }
    file.sessionIdCount = sessionIds.size;
    file.sessionIdKeys = [...sessionIds].map(x => hash(`claude:${x}`));
    file.live = !!file.lastTimestamp && file.lastTimestamp > cutoff;
    if (file.live) summary.liveFiles++;
    if (!localMessages.size) count(summary.fileKinds, Object.keys(file.recordTypes).sort().join('+') || 'empty');
    file.usageMessages = localMessages.size;
    for (const [id, local] of localMessages) {
      local.live = file.live;
      add(file.usage, local.usage); add(file.maxComponentUsage, local.maxUsage);
      let group = allMessages.get(id); if (!group) { group = []; allMessages.set(id, group); } group.push(local);
    }
    summary.fileSummaries.push(file);
  }
  process.stderr.write(`raw audit completed root ${rootIndex}: ${locations.length} files\n`);
}
for (const [id, occurrences] of allMessages) {
  const stable = occurrences.filter(o => !o.live);
  if (!stable.length) continue;
  const globallyLatest = stable.map(o => o.usage).reduce(latest);
  add(summary.usageGloballyUnique, globallyLatest);
  for (const o of stable) add(summary.usageByFile, o.usage);
  const publicOccurrence = o => ({ ...o, signatures: o.signatures.size, models: [...o.models] });
  for (const o of stable) {
    if (o.usage.output > 0 && !o.reasoningExposed) {
      summary.missingThinking.messages++; summary.missingThinking.output += o.usage.output;
      const p = summary.missingThinkingByParent[o.parentProviderSessionKey] ??= { messages: 0, output: 0 };
      p.messages++; p.output += o.usage.output;
    }
    count(summary.iterationRetainedCounts, o.iterations.length);
    if (o.iterations.length === 1) {
      if (dimensions.filter(k => k !== 'thinking').every(k => o.usage[k] === o.iterations[0].usage[k])) summary.singleIterationMatches++;
      if (o.iterations[0].model !== '<unknown>') summary.singleIterationModelPresent++;
    }
  }
  const withIterations = stable.filter(o => o.iterations.length > 1 || (o.iterations.length === 1 && dimensions.filter(k => k !== 'thinking').some(k => o.usage[k] !== o.iterations[0].usage[k])));
  if (withIterations.length) summary.iterationGroups.push({ messageKey: hash(id), occurrences: withIterations.map(publicOccurrence) });
  if (stable.length > 1) {
    const duplicate = zero(); for (const o of stable) add(duplicate, o.usage); add(duplicate, globallyLatest, -1);
    summary.duplicateMessageGroups.push({ messageKey: hash(id), files: stable.length,
      acrossRoots: new Set(stable.map(o => o.rootIndex)).size > 1,
      mainAndSubagent: stable.some(o => o.isSubagent) && stable.some(o => !o.isSubagent),
      usageDiffers: new Set(stable.map(o => JSON.stringify(o.usage))).size > 1,
      duplicateUsage: duplicate, occurrences: stable.map(publicOccurrence) });
  }
  const differs = stable.filter(o => dimensions.some(k => k !== 'output' && k !== 'thinking' && o.minUsage[k] !== o.maxUsage[k]));
  if (differs.length) summary.differingSnapshotGroups.push({ messageKey: hash(id), occurrences: differs.map(publicOccurrence) });
}
for (const [request, ids] of requests) {
  if (ids.size > 1) summary.requestGroupsWithMultipleMessages.push({ requestKey: hash(request), messages: [...ids].map(hash), messageCount: ids.size });
}
add(summary.duplicateUsage, summary.usageByFile); add(summary.duplicateUsage, summary.usageGloballyUnique, -1);
summary.uniqueMessageCount = allMessages.size; summary.uniqueRequestCount = requests.size;
summary.duplicateGroupCount = summary.duplicateMessageGroups.length;
summary.differingSnapshotGroupCount = summary.differingSnapshotGroups.length;
summary.requestMultiMessageCount = summary.requestGroupsWithMultipleMessages.length;
await fs.mkdir('.lane', { recursive: true });
await fs.writeFile('.lane/claude-raw-audit.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).filter(([k]) => !['duplicateMessageGroups', 'differingSnapshotGroups', 'requestGroupsWithMultipleMessages', 'fileSummaries', 'iterationGroups'].includes(k))), null, 2));
