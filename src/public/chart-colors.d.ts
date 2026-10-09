export type ProviderKey = "codex" | "claude" | "cursor" | "copilot" | "opencode" | "gemini" | "unknown";
export interface SlotAssignment { provider: string; slot: number; overflow: boolean }
export const brandPalette: { light: Record<string, string>; dark: Record<string, string> };
export const categorySlotCount: 4;
export const modelSlotCount: 4;
export function categoryColor(slot: number): string;
export function providerKey(provider?: string | null): ProviderKey;
export function providerColor(provider?: string | null): string;
export function modelProvider(model?: string | null, fallbackProvider?: string | null): ProviderKey;
export function modelTier(model?: string | null): 0 | 1 | 2 | 3;
export function modelFamily(provider?: string | null, model?: string | null): ProviderKey;
export function slotColor(provider: string | null | undefined, slot: number): string;
export function modelColor(provider?: string | null, model?: string | null): string;
export function allocateSlots(entries: Array<{ id: string; provider: string; preferred: number; order?: number }>): Map<string, SlotAssignment>;
export function modelSlots(models: Array<{ id: string; provider: string; model: string }>): Map<string, SlotAssignment>;
export function separateAdjacent<T extends { slot: number; overflow: boolean }>(items: T[]): T[];
export function componentColor(component: string, baseColor: string): string;
