/**
 * A sibling module by its source name. Source runs name `.ts` files; the compiled package names the emitted `.js`,
 * which the import rewrite never reaches inside a string. The caller's own extension decides, so a worker entry or
 * fingerprint input always matches how this process was started.
 */
export function moduleUrl(specifier: string, parent: string): URL {
  return new URL(parent.endsWith(".js") && specifier.endsWith(".ts") ? `${specifier.slice(0, -3)}.js` : specifier, parent);
}
