/** JSON Lines uses LF record boundaries. U+2028/U+2029 are valid JSON string text. */
export async function* readJsonLines(input: AsyncIterable<string>): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of input) {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
    }
  }
  if (pending) yield pending;
}
