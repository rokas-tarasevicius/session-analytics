/** JSONL is LF-framed. Legal Unicode separators inside strings are not records. */
export async function* lfLines(input) {
  input.setEncoding('utf8');
  let pending = '';
  for await (const chunk of input) {
    pending += chunk;
    let start = 0, end;
    while ((end = pending.indexOf('\n', start)) !== -1) {
      yield pending.slice(start, end);
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  if (pending) yield pending;
}
