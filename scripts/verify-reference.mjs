/** Oracle plumbing only: redirect the old reference read, preserving independent arithmetic. */
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
const replacement = process.env.SESSION_ANALYTICS_VERIFY_REFERENCE;
if (!replacement) throw new Error('An explicit verification snapshot is required.');
const redirect = value => {
  const name = value instanceof URL ? fileURLToPath(value) : typeof value === 'string' ? value : null;
  return name && /(?:^|[/\\])snapshot-noindex-51ea561\.json$/.test(name) ? replacement : value;
};
const readSync = fs.readFileSync.bind(fs), read = fs.readFile.bind(fs), readPromise = promises.readFile.bind(promises);
fs.readFileSync = (file, ...args) => readSync(redirect(file), ...args);
fs.readFile = (file, ...args) => read(redirect(file), ...args);
promises.readFile = (file, ...args) => readPromise(redirect(file), ...args);
syncBuiltinESMExports();
// The imported scripts deliberately suppress private exceptions. A failure in an
// auxiliary historical script must have the same privacy boundary.
process.on('uncaughtException', () => { process.stderr.write('Oracle failed; private local details withheld.\n'); process.exit(1); });
process.on('unhandledRejection', () => { process.stderr.write('Oracle failed; private local details withheld.\n'); process.exit(1); });
