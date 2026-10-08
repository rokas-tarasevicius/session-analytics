/** JSON Lines uses LF record boundaries. U+2028/U+2029 are valid JSON string text. */
export async function* readJsonLines(input: AsyncIterable<string>): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of input) {
    // Scan by offset: re-slicing the remainder after every line is quadratic in lines per chunk.
    const text = pending + chunk;
    let start = 0, end: number;
    while ((end = text.indexOf("\n", start)) >= 0) {
      yield text.slice(start, end);
      start = end + 1;
    }
    pending = text.slice(start);
  }
  if (pending) yield pending;
}
