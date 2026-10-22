// One source for global keyboard dispatch, palette hints and the shortcuts dialog.
// Chart-local arrow keys stay with their chart so focused controls own those events.
import { isTextEntryTarget } from "./view-model.js";
import { providerIds } from "./providers.js";

const binding = (keys, value = null, always = false) => ({ keys, value, always });
const view = (label, key, value) => ({ id: `view-${value}`, group: "Navigate", label, action: "view", bindings: [binding(["g", key], value)] });
export const shortcutRegistry = [
  view("Summary", "s", "summary"), view("Velocity", "v", "velocity"), view("Costs", "c", "costs"),
  view("Pricing", "p", "pricing"), view("Subscription", "u", "subscription"), view("Tools", "t", "tools"), view("Activity", "a", "activity"),
  { id: "step", group: "Navigate", label: "Previous / next view", action: "step", bindings: [binding(["["], "-1"), binding(["]"], "1")] },
  { id: "palette", group: "Control", label: "Command palette", action: "palette", bindings: [binding(["Mod+k"], null, true), binding(["/"])] },
  { id: "window", group: "Control", label: "Last 7 · 30 · 90 days · all", action: "window", bindings: ["7", "30", "90", "all"].map((value, index) => binding([String(index + 1)], value)) },
  { id: "provider", group: "Control", label: "Toggle provider chips in order (Summary chart, Velocity, Tools, Activity)", action: "provider", bindings: providerIds.slice(0, 9).map((_, index) => binding(["p", String(index + 1)], String(index + 1))) },
  { id: "coverage", group: "Control", label: "Data coverage", action: "coverage", bindings: [binding(["e"])] },
  { id: "clear", group: "Control", label: "Clear repository focus / close dialog", action: "clear", bindings: [binding(["Escape"], null, true)] },
  { id: "theme", group: "Control", label: "Switch theme", action: "theme", bindings: [binding(["t"])] },
  { id: "density", group: "Control", label: "Switch density", action: "density", bindings: [binding(["d"])] },
  { id: "refresh", group: "Control", label: "Refresh snapshot", action: "refresh", bindings: [binding(["r"])] },
  { id: "help", group: "Control", label: "Keyboard shortcuts", action: "help", bindings: [binding(["?"])] },
];

export function shortcutHint(id, value = null) {
  const item = shortcutRegistry.find((item) => item.id === id);
  return item?.bindings.filter((binding) => value === null || binding.value === value)
    .map((binding) => binding.keys.join(" ")).join(" / ") ?? "";
}

/** Resolves an eligible global shortcut or chord prefix, without touching the DOM or app state. */
export function matchShortcut(event, { enabled = true, pending = null } = {}) {
  if (event.defaultPrevented || event.isComposing || event.repeat) return null;
  const modified = event.metaKey || event.ctrlKey;
  if (event.altKey || (modified && (event.shiftKey || event.key.toLowerCase() !== "k"))) return null;
  const key = modified ? "Mod+k" : event.key;
  // The explicit modifier palette shortcut remains available while editing; character shortcuts never do.
  if (!modified && isTextEntryTarget(event.target)) return null;
  const keys = pending && key !== "Escape" && !modified ? [pending, key] : [key];
  for (const item of shortcutRegistry) {
    for (const binding of item.bindings) {
      if (!enabled && !binding.always) continue;
      if (binding.keys.length === keys.length && binding.keys.every((part, index) => part === keys[index])) return { action: item.action, value: binding.value };
      if (keys.length === 1 && binding.keys.length > 1 && binding.keys[0] === key) return { prefix: key };
    }
  }
  return null;
}
