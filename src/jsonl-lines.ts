/** JSON Lines uses LF boundaries; tolerate one UTF-8 BOM at stream start.
 * U+2028/U+2029 and BOMs inside JSON strings are valid text.
 * Resumed readers must pass false when their stream starts after byte zero. */
export async function* readJsonLines(input: AsyncIterable<string>, atFileStart = true): AsyncGenerator<string> {
  let pending = "";
  let atStart = atFileStart;
  for await (const chunk of input) {
    if (!chunk.length) continue;
    const content = atStart && chunk.startsWith("\uFEFF") ? chunk.slice(1) : chunk;
    atStart = false;
    // Scan by offset: re-slicing the remainder after every line is quadratic in lines per chunk.
    const text = pending + content;
    let start = 0, end: number;
    while ((end = text.indexOf("\n", start)) >= 0) {
      yield text.slice(start, end);
      start = end + 1;
    }
    pending = text.slice(start);
  }
  if (pending) yield pending;
}
