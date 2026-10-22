/** Wrap saved synthetic stdout without changing terminal line boundaries.
 * Usage: node scripts/terminal-report-capture.ts COLUMNS INPUT.txt OUTPUT.html
 * Capture at COLUMNS * 9 CSS pixels: Geist Mono's 15px characters occupy 9px.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [columns, input, output] = process.argv.slice(2);
if (!columns || !/^\d+$/u.test(columns) || Number(columns) < 20 || Number(columns) > 1000 || !input || !output) {
  process.stderr.write("Usage: node scripts/terminal-report-capture.ts COLUMNS INPUT.txt OUTPUT.html\n");
  process.exit(2);
}
const font = readFileSync(new URL("../src/public/fonts/geist-mono-latin.woff2", import.meta.url)).toString("base64");
const text = readFileSync(input, "utf8").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
writeFileSync(output, `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Synthetic terminal report: ${columns} columns</title>
<style>
@font-face{font-family:Terminal;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:400}
html,body{margin:0;padding:0;background:#11151c;color:#e7edf5}
pre{margin:0;font:400 15px/1.5 Terminal,monospace;font-variant-ligatures:none;white-space:pre;overflow:visible}
</style><pre>${text}</pre></html>\n`);
