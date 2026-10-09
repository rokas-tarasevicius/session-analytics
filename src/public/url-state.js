// Dashboard state carried in the address bar: view, time window and repository focus. Pure functions only, so
// test/dashboard-url-state.test.ts can round-trip them under node:test.
//
// `view`, `window`, `start`, `end` and `repo` describe what is on screen and are rewritten as it changes.
// `open`, `theme` and `density` are one-shot instructions: they are applied once on load and then removed.
// `repo` carries the opaque repository ID, never a path; a repository name is still accepted when reading.

import { validDay } from "./view-model.js";

export const stateKeys = ["view", "window", "start", "end", "repo"];
export const oneShotKeys = ["open", "theme", "density"];
/** The window a URL without `window=` means. It is not stored anywhere else, so it is left out of the URL. */
export const defaultWindow = "30";

/**
 * Reads dashboard state from a query string. Unknown or invalid values become null so the caller's defaults apply.
 * A valid `start`/`end` pair without `window=` means a custom range.
 */
export function parseUrlState(search, { views = [], presets = [], aliases = {} } = {}) {
  const parameters = new URLSearchParams(search);
  const rawView = parameters.get("view");
  const view = rawView === null ? null : aliases[rawView] ?? rawView;
  const start = validDay(parameters.get("start")), end = validDay(parameters.get("end"));
  const rawWindow = parameters.get("window");
  const window = presets.includes(rawWindow) ? rawWindow : rawWindow === null && start && end ? "custom" : null;
  const oneOf = (value, allowed) => (allowed.includes(value) ? value : null);
  return {
    view: views.includes(view) ? view : null,
    window,
    start: window === "custom" ? start : null,
    end: window === "custom" ? end : null,
    repo: parameters.get("repo") || null,
    open: oneOf(parameters.get("open"), ["palette", "help"]),
    theme: oneOf(parameters.get("theme"), ["dark", "light"]),
    density: oneOf(parameters.get("density"), ["compact", "comfortable"]),
  };
}

/**
 * Writes dashboard state into a query string ("" or "?…"). Parameters the dashboard does not own are kept;
 * one-shot parameters are dropped. The default window is omitted; the view is always written because a stored
 * view preference would otherwise decide what a bare URL opens.
 */
export function serializeUrlState({ view = null, window = null, start = null, end = null, repo = null }, search = "") {
  const next = new URLSearchParams();
  if (view) next.set("view", view);
  if (window && window !== defaultWindow) next.set("window", window);
  if (window === "custom" && validDay(start) && validDay(end)) { next.set("start", start); next.set("end", end); }
  if (repo) next.set("repo", repo);
  for (const [key, value] of new URLSearchParams(search)) {
    if (!stateKeys.includes(key) && !oneShotKeys.includes(key)) next.append(key, value);
  }
  const text = next.toString();
  return text ? `?${text}` : "";
}
