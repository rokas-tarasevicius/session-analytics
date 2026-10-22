const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Terminal cells, keeping combining marks and emoji sequences together. */
function cells(grapheme: string): number {
  if (/\uFE0F|\u20E3|\p{Regional_Indicator}/u.test(grapheme) ||
    (!grapheme.includes("\uFE0E") && /\p{Emoji_Presentation}/u.test(grapheme))) return 2;
  const point = grapheme.codePointAt(0) ?? 0;
  if (/^[\p{Mark}\p{Cf}]+$/u.test(grapheme)) return 0;
  return point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a ||
    (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
    (point >= 0xa960 && point <= 0xa97f) ||
    (point >= 0xac00 && point <= 0xd7a3) || (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe19) || (point >= 0xfe30 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) || (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x16fe0 && point <= 0x16fe3) || (point >= 0x17000 && point <= 0x18dff) ||
    (point >= 0x1aff0 && point <= 0x1afff) || (point >= 0x1b000 && point <= 0x1b2ff) ||
    (point >= 0x1f200 && point <= 0x1f251) ||
    (point >= 0x20000 && point <= 0x3fffd)) ? 2 : 1;
}

export function textWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) width += cells(segment);
  return width;
}

/** COLUMNS also works for pipes; a plain redirected report defaults to 80. */
export function reportWidth(environment: NodeJS.ProcessEnv, columns?: number): number {
  const configured = environment.COLUMNS;
  const valid = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 20 && value <= 1000;
  const width = configured && /^\d+$/.test(configured) ? Number(configured) : undefined;
  return valid(width) ? width : valid(columns) ? columns : 80;
}

export function ellipsize(text: string, width: number): string {
  if (textWidth(text) <= width) return text;
  let result = "", used = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (used + cells(segment) > width - 1) break;
    result += segment;
    used += cells(segment);
  }
  return `${result}…`;
}

/** Wrap prose without losing words, blank lines, indentation or the final newline. */
export function wrapReport(text: string, width: number): string {
  return text.split("\n").map((line) => {
    if (textWidth(line) <= width) return line;
    const indent = " ".repeat(Math.min(line.match(/^ */)?.[0].length ?? 0, width - 2));
    const continuation = line.trimStart().startsWith("- ") ? " ".repeat(Math.min(indent.length + 2, width - 2)) : indent;
    const lines: string[] = [];
    let current = indent;
    for (const word of line.trim().split(/\s+/u)) {
      if (current.trim() && textWidth(`${current} ${word}`) <= width) { current += ` ${word}`; continue; }
      if (current.trim()) { lines.push(current); current = continuation; }
      for (const { segment } of graphemes.segment(word)) {
        if (textWidth(current) + cells(segment) > width) { lines.push(current); current = continuation; }
        current += segment;
      }
    }
    if (current.trim()) lines.push(current);
    return lines.join("\n");
  }).join("\n");
}

/** Align complete cells when they fit; otherwise label each value under its row name. */
export function reportTable(headers: string[], rows: string[][], width: number, right: number[] = []): string {
  if (!rows.length) return "";
  const widths = headers.map((header, index) => rows.reduce((max, row) => Math.max(max, textWidth(row[index] ?? "")), textWidth(header)));
  if (widths.reduce((sum, value) => sum + value, 0) + (headers.length - 1) * 2 > width) {
    return wrapReport(rows.map((row) => [row[0], ...headers.slice(1).map((header, index) => `  ${header}: ${row[index + 1]}`)].join("\n")).join("\n\n") + "\n", width);
  }
  const format = (row: string[]): string => row.map((value, index) => {
    const padding = " ".repeat(widths[index]! - textWidth(value));
    return right.includes(index) ? padding + value : value + padding;
  }).join("  ").trimEnd();
  return [headers, ...rows].map(format).join("\n") + "\n";
}
