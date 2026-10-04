/** Preserve independence and derive content-free candidates for narrow raw rereads. */
import fs from 'node:fs';
import { createInterface } from 'node:readline';

if (process.argv.includes('--preserve-first')) {
  let created = false;
  try {
    fs.copyFileSync('.lane/codex-raw-oracle.json', '.lane/codex-independent-first.json', fs.constants.COPYFILE_EXCL);
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new Error('The independent result could not be preserved.');
  }
  console.log(JSON.stringify({ firstIndependentResultCreated: created, existingFirstResultPreserved: !created }));
} else {
  const usageKey = r => r.usage.slice(0, 4).join(',');
  const observationKey = r => r.sessionKey + '|' + r.time + '|' + usageKey(r);
  const independentCounts = new Map(), independentObservations = new Set();
  for await (const line of createInterface({ input: fs.createReadStream('.lane/codex-owned-requests.jsonl'), crlfDelay: Infinity })) {
    const r = JSON.parse(line), key = usageKey(r);
    independentCounts.set(key, (independentCounts.get(key) ?? 0) + 1);
    independentObservations.add(observationKey(r));
  }
  const explicit = [], legacyDifference = [];
  let requestSizeFlagsPresent = false;
  for await (const line of createInterface({ input: fs.createReadStream('.lane/codex-source-owned-requests.jsonl'), crlfDelay: Infinity })) {
    const r = JSON.parse(line), key = usageKey(r), remaining = independentCounts.get(key) ?? 0;
    const candidate = { ...r, independentPresent: independentObservations.has(observationKey(r)) };
    if (typeof r.requestSizeKnown === 'boolean') requestSizeFlagsPresent = true;
    if (r.requestSizeKnown === false) explicit.push(candidate);
    if (remaining) independentCounts.set(key, remaining - 1); else legacyDifference.push(candidate);
  }
  // The preserved audit projection predates requestSizeKnown. Its seven extras
  // are only candidates until codex-targeted-evidence.mjs verifies raw fields.
  const candidates = requestSizeFlagsPresent ? explicit : legacyDifference;
  fs.writeFileSync('.lane/codex-fallback-candidates.json', JSON.stringify(candidates, null, 2) + '\n');
  console.log(JSON.stringify({ candidates: candidates.length,
    method: requestSizeFlagsPresent ? 'explicit-request-size-coverage' : 'legacy-projection-multiset-difference' }));
}
