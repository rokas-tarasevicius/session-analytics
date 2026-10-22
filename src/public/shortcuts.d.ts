export interface ShortcutBinding { keys: string[]; value: string | null; always: boolean }
export interface Shortcut { id: string; group: string; label: string; action: string; bindings: ShortcutBinding[] }
export interface ShortcutEvent {
  key: string; target?: unknown; defaultPrevented?: boolean; isComposing?: boolean; keyCode?: number; repeat?: boolean;
  metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
}
export const shortcutRegistry: Shortcut[];
export function shortcutHint(id: string, value?: string | null): string;
export function matchShortcut(event: ShortcutEvent, options?: { enabled?: boolean; pending?: string | null }): { action: string; value: string | null; prefix?: never } | { prefix: string; action?: never; value?: never } | null;
